#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile, readdir, stat } from "fs/promises";
import * as path from "path";
import { Worker } from "worker_threads";
import jmespath from "jmespath";
import * as cheerio from "cheerio";

const server = new McpServer({
  name: "parse-mcp",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Safety limits
//
// This server does all of its work synchronously on Node's single event-loop
// thread and talks JSON-RPC over stdio. If a tool call hangs (catastrophic
// regex backtracking), exhausts memory (an unbounded result), or throws
// asynchronously, the process stops answering the client and the transport is
// torn down — what shows up as a "disconnect". The guards below keep any one
// tool call from taking down the whole session.
// ---------------------------------------------------------------------------

/** Max bytes read from any single input file. Keeps in-memory structures (and
 *  the transient cost of JSON.stringify) safely under the default V8 heap. */
const MAX_INPUT_BYTES = 100 * 1024 * 1024; // 100 MB

/** Max bytes of a single tool response. Larger payloads are truncated rather
 *  than serialized unbounded. */
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5 MB

/** Wall-clock budget for a single user-supplied regex operation. */
const REGEX_TIMEOUT_MS = 5000;

/** Recursion-depth ceiling for the deep-* JSON walkers. */
const MAX_DEPTH = 2000;

/** Read a file as UTF-8, rejecting anything over MAX_INPUT_BYTES with a clean
 *  error (which the SDK returns to the client instead of risking an OOM). */
async function readFileCapped(p: string): Promise<string> {
  const st = await stat(p);
  if (st.size > MAX_INPUT_BYTES) {
    throw new Error(
      `File too large: ${st.size} bytes (max ${MAX_INPUT_BYTES}). ` +
        `Narrow the input or split the file.`
    );
  }
  return readFile(p, "utf-8");
}

/** Wrap a text payload as a tool result, truncating past MAX_OUTPUT_BYTES so a
 *  huge result degrades gracefully instead of blowing up serialization. */
function textResult(payload: string) {
  let text = payload;
  if (Buffer.byteLength(text, "utf-8") > MAX_OUTPUT_BYTES) {
    // slice is by UTF-16 code units; a hair under the byte budget is fine.
    text =
      text.slice(0, MAX_OUTPUT_BYTES) +
      `\n\n...[truncated: output exceeded ${MAX_OUTPUT_BYTES} bytes — ` +
      `use limit / a narrower expression to reduce it]`;
  }
  return { content: [{ type: "text" as const, text }] };
}

// The CPU-bound regex primitives run in a worker thread so a catastrophic
// backtracking pattern can be killed with worker.terminate() (a stuck
// synchronous regex is otherwise uninterruptible and hangs the whole server).
const REGEX_WORKER = `
const { parentPort, workerData } = require('worker_threads');
try {
  const { content, pattern, flags, group, count_only, collectLimit } = workerData;
  const regex = new RegExp(pattern, flags);
  const isGlobal = flags.includes('g');
  if (count_only) {
    let count = 0, m;
    while ((m = regex.exec(content)) !== null) {
      count++;
      if (m[0] === '' && isGlobal) regex.lastIndex++;
      if (!isGlobal) break;
      if (count >= 1000000) break;
    }
    parentPort.postMessage({ result: { count } });
  } else {
    const matches = [];
    let m;
    while ((m = regex.exec(content)) !== null && matches.length < collectLimit) {
      if (group !== undefined && group !== null && m[group] !== undefined) matches.push(m[group]);
      else matches.push(m[0]);
      if (m[0] === '' && isGlobal) regex.lastIndex++;
      if (!isGlobal) break;
    }
    parentPort.postMessage({ result: { matches } });
  }
} catch (e) {
  parentPort.postMessage({ error: e.message });
}
`;

const REPLACE_WORKER = `
const { parentPort, workerData } = require('worker_threads');
try {
  const { text, from, to, flags } = workerData;
  const counter = new RegExp(from, flags);
  const matches = text.match(counter);
  const count = matches ? matches.length : 0;
  const result = text.replace(new RegExp(from, flags), to);
  parentPort.postMessage({ result: { result, count } });
} catch (e) {
  parentPort.postMessage({ error: e.message });
}
`;

/** Run one of the worker scripts above with a hard wall-clock timeout,
 *  terminating the worker (and its stuck regex, if any) if it overruns. */
function runInWorker<T>(
  code: string,
  workerData: unknown,
  timeoutMs: number
): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData });
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `Operation timed out after ${timeoutMs}ms — likely catastrophic ` +
              `regex backtracking. Simplify the pattern (avoid nested quantifiers ` +
              `like (a+)+) or anchor it more tightly.`
          )
        )
      );
    }, timeoutMs);
    worker.on("message", (msg: { result?: T; error?: string }) => {
      finish(() =>
        msg.error ? reject(new Error(msg.error)) : resolve(msg.result as T)
      );
    });
    worker.on("error", (err) => finish(() => reject(err)));
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveContent(
  filePath?: string,
  text?: string
): Promise<string> {
  if (filePath) return readFileCapped(filePath);
  if (text) return text;
  throw new Error("Provide either file_path or text");
}

/** Recursively parse any string values that look like JSON. */
function deepParseJson(data: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    throw new Error(`Maximum nesting depth (${MAX_DEPTH}) exceeded`);
  }
  if (typeof data === "string") {
    try {
      return deepParseJson(JSON.parse(data), depth + 1);
    } catch {
      return data;
    }
  }
  if (Array.isArray(data)) {
    return data.map((item) => deepParseJson(item, depth + 1));
  }
  if (data && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = deepParseJson(value, depth + 1);
    }
    return result;
  }
  return data;
}

/** Apply find/replace pairs to every string value in a JSON tree. */
function deepReplace(
  data: unknown,
  replacements: Array<{ from: string; to: string; regex?: boolean }>,
  depth = 0
): unknown {
  if (depth > MAX_DEPTH) {
    throw new Error(`Maximum nesting depth (${MAX_DEPTH}) exceeded`);
  }
  if (typeof data === "string") {
    let result = data;
    for (const { from, to, regex } of replacements) {
      if (regex) {
        result = result.replace(new RegExp(from, "g"), to);
      } else {
        result = result.split(from).join(to);
      }
    }
    return result;
  }
  if (Array.isArray(data)) {
    return data.map((item) => deepReplace(item, replacements, depth + 1));
  }
  if (data && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = deepReplace(value, replacements, depth + 1);
    }
    return result;
  }
  return data;
}

/** Get a value at a dot-separated path (supports array indices). */
function getAtPath(data: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (Number.isNaN(idx)) return undefined;
      current = current[idx];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Set a value at a dot-separated path (mutates in place). */
function setAtPath(data: unknown, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: unknown = data;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (Array.isArray(current)) {
      current = current[Number(part)];
    } else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return;
    }
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(current)) {
    current[Number(last)] = value;
  } else if (current && typeof current === "object") {
    (current as Record<string, unknown>)[last] = value;
  }
}

/** Delete a key at a dot-separated path (mutates in place). */
function deleteAtPath(data: unknown, path: string): void {
  const parts = path.split(".");
  let current: unknown = data;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (Array.isArray(current)) {
      current = current[Number(part)];
    } else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return;
    }
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(current)) {
    current.splice(Number(last), 1);
  } else if (current && typeof current === "object") {
    delete (current as Record<string, unknown>)[last];
  }
}

// ---------------------------------------------------------------------------
// Glob / listing helpers
// ---------------------------------------------------------------------------

interface FileEntry {
  path: string;
  size: number;
  mtime: string;
  mtimeMs: number;
  type: "file" | "dir";
}

/** Translate a single glob pattern segment-string into an anchored RegExp.
 *  Supports **\/ (any depth incl. zero), ** (greedy), * (within segment),
 *  ? (single non-slash char), and {a,b,c} alternation. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      let j = i + 1;
      let body = "";
      while (j < glob.length && glob[j] !== "}") {
        body += glob[j];
        j++;
      }
      const alts = body
        .split(",")
        .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|");
      re += "(?:" + alts + ")";
      i = j;
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}

/** Split a glob into its literal base directory and the wildcard pattern. */
function splitGlobBase(
  glob: string,
  cwd: string
): { base: string; pattern: string } {
  const isAbs = path.isAbsolute(glob);
  const segs = glob.split("/");
  const baseSegs: string[] = [];
  let i = 0;
  for (; i < segs.length; i++) {
    if (/[*?{}]/.test(segs[i])) break;
    baseSegs.push(segs[i]);
  }
  const pattern = segs.slice(i).join("/");
  const baseJoined = baseSegs.join("/");
  const base = isAbs ? baseJoined || "/" : path.resolve(cwd, baseJoined);
  return { base, pattern };
}

/** Parse a time spec: epoch-ms number, "2d"/"30m" relative duration, all-digit
 *  string, or any Date.parse-able string. Returns epoch ms or undefined. */
function parseTimeSpec(spec?: string | number): number | undefined {
  if (spec === undefined || spec === null) return undefined;
  if (typeof spec === "number") return spec;
  const s = spec.trim();
  const rel = /^(\d+)([smhdw])$/.exec(s);
  if (rel) {
    const units: Record<string, number> = {
      s: 1e3,
      m: 6e4,
      h: 36e5,
      d: 864e5,
      w: 6048e5,
    };
    return Date.now() - Number(rel[1]) * units[rel[2]];
  }
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

interface GlobOpts {
  cwd?: string;
  since?: string | number;
  until?: string | number;
  minSize?: number;
  maxSize?: number;
  type?: "file" | "dir" | "any";
}

/** Walk the filesystem and return entries matching a glob pattern with
 *  optional mtime/size/type filters. Does not follow symlinks. */
async function globFiles(glob: string, opts: GlobOpts = {}): Promise<FileEntry[]> {
  const cwd = opts.cwd ?? process.cwd();
  const isAbs = path.isAbsolute(glob);
  const { base, pattern } = splitGlobBase(glob, cwd);
  const re = pattern ? globToRegExp(pattern) : null;
  const since = parseTimeSpec(opts.since);
  const until = parseTimeSpec(opts.until);
  const type = opts.type ?? "file";
  const out: FileEntry[] = [];
  let visited = 0;
  const VISIT_CAP = 500_000;

  const display = (full: string) =>
    isAbs ? full : path.relative(cwd, full);

  const consider = async (full: string, isDir: boolean) => {
    if ((type === "file" && isDir) || (type === "dir" && !isDir)) return;
    let st;
    try {
      st = await stat(full);
    } catch {
      return;
    }
    if (since !== undefined && st.mtimeMs < since) return;
    if (until !== undefined && st.mtimeMs > until) return;
    if (opts.minSize !== undefined && st.size < opts.minSize) return;
    if (opts.maxSize !== undefined && st.size > opts.maxSize) return;
    out.push({
      path: display(full),
      size: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      mtimeMs: st.mtimeMs,
      type: isDir ? "dir" : "file",
    });
  };

  // No wildcard: glob is a literal path — stat it directly.
  if (!pattern) {
    try {
      const st = await stat(base);
      await consider(base, st.isDirectory());
    } catch {
      /* missing path → no matches */
    }
    return out;
  }

  const recurse = async (dir: string) => {
    if (visited > VISIT_CAP) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      visited++;
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(base, full);
      const isDir = e.isDirectory();
      if (re!.test(rel)) await consider(full, isDir);
      if (isDir) await recurse(full);
    }
  };
  await recurse(base);
  return out;
}

/** Resolve a multi-source input into a list of file paths. */
async function resolvePaths(args: {
  file_path?: string;
  paths?: string[];
  glob?: string;
  cwd?: string;
}): Promise<string[]> {
  if (args.paths && args.paths.length) return args.paths;
  if (args.glob) {
    const entries = await globFiles(args.glob, { cwd: args.cwd, type: "file" });
    return entries.map((e) => e.path);
  }
  if (args.file_path) return [args.file_path];
  return [];
}

/** Iterate the parseable JSON records of NDJSON/JSONL content; bad lines skipped. */
function* iterJsonl(content: string): Generator<unknown> {
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      yield JSON.parse(t);
    } catch {
      /* skip non-JSON lines */
    }
  }
}

/** Parse delimited text into rows of fields. Handles RFC4180-style quoting for
 *  single-char delimiters (",", "\t", "|", ";", …); "whitespace" splits on runs
 *  of whitespace with no quote handling. */
function parseDelimited(content: string, delimiter: string): string[][] {
  if (delimiter === "whitespace") {
    return content
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((l) => l.trim().split(/\s+/));
  }
  const d = delimiter === "\\t" || delimiter === "\t" ? "\t" : delimiter;
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === d) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Convert parsed rows into record objects keyed by header names (or c0,c1,… when
 *  header is false). Blank lines are dropped. */
function rowsToObjects(
  rows: string[][],
  header: boolean
): Array<Record<string, string>> {
  let headers: string[];
  let dataRows: string[][];
  if (header) {
    headers = rows[0] ?? [];
    dataRows = rows.slice(1);
  } else {
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    headers = Array.from({ length: width }, (_, i) => "c" + i);
    dataRows = rows;
  }
  return dataRows
    .filter((r) => !(r.length === 1 && r[0] === ""))
    .map((r) => {
      const o: Record<string, string> = {};
      headers.forEach((h, i) => {
        o[h] = r[i] ?? "";
      });
      return o;
    });
}

/** Aggregate a numeric column. */
function aggregateValues(values: number[], op: string): number {
  switch (op) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    case "min":
      return values.length ? Math.min(...values) : 0;
    case "max":
      return values.length ? Math.max(...values) : 0;
    default:
      return values.length;
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.tool(
  "json_query",
  "Query JSON data using a JMESPath expression. Can read from a file or inline text. " +
    "Use parse_nested to automatically parse JSON strings embedded inside values.",
  {
    file_path: z
      .string()
      .optional()
      .describe("Absolute path to a JSON file"),
    text: z
      .string()
      .optional()
      .describe("Inline JSON string (alternative to file_path)"),
    expression: z.string().describe("JMESPath expression to evaluate"),
    parse_nested: z
      .boolean()
      .optional()
      .default(false)
      .describe("Recursively parse string values that contain JSON"),
    limit: z
      .number()
      .optional()
      .default(50)
      .describe("Max array items to return"),
  },
  async ({ file_path, text, expression, parse_nested, limit }) => {
    const raw = await resolveContent(file_path, text);
    let data: unknown = JSON.parse(raw);

    if (parse_nested) {
      data = deepParseJson(data);
    }

    let result = jmespath.search(data, expression);

    if (Array.isArray(result) && result.length > limit) {
      result = result.slice(0, limit);
    }

    return textResult(JSON.stringify(result, null, 2));
  }
);

/** Core regex extraction over one string. Returns the count, the deduped
 *  frequency list, or the raw match list depending on the flags. The regex
 *  itself runs in a worker thread with REGEX_TIMEOUT_MS so a catastrophic
 *  backtracking pattern is killed instead of hanging the server. */
async function runRegex(
  content: string,
  opts: {
    pattern: string;
    flags: string;
    group?: number;
    limit: number;
    count_only: boolean;
    unique: boolean;
  }
): Promise<unknown> {
  const { pattern, flags, group, limit, count_only, unique } = opts;
  const collectLimit = unique ? 10_000 : limit;

  const out = await runInWorker<{ count?: number; matches?: string[] }>(
    REGEX_WORKER,
    { content, pattern, flags, group, count_only, collectLimit },
    REGEX_TIMEOUT_MS
  );

  if (count_only) {
    return { count: out.count ?? 0 };
  }

  const matches = out.matches ?? [];

  if (unique) {
    const freq = new Map<string, number>();
    for (const m of matches) {
      freq.set(m, (freq.get(m) || 0) + 1);
    }
    return [...freq.entries()]
      .map(([m, count]) => ({ match: m, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  return matches;
}

server.tool(
  "regex_extract",
  "Extract regex matches from a file, inline text, or many files at once " +
    "(paths/glob). With a glob or paths array, returns per-file results.",
  {
    file_path: z.string().optional().describe("Absolute path to the file"),
    text: z
      .string()
      .optional()
      .describe("Inline text (alternative to file_path)"),
    paths: z
      .array(z.string())
      .optional()
      .describe("Multiple file paths to scan; returns one result per file"),
    glob: z
      .string()
      .optional()
      .describe(
        "Glob pattern (e.g. '**/*.ts') to scan many files; returns one result per file"
      ),
    cwd: z
      .string()
      .optional()
      .describe("Base directory for a relative glob (default: process cwd)"),
    pattern: z.string().describe("Regular expression pattern"),
    flags: z.string().optional().default("g").describe("Regex flags (default: 'g')"),
    group: z
      .number()
      .optional()
      .describe("Capture group index to return (0 = full match)"),
    limit: z.number().optional().default(50).describe("Max matches to return"),
    count_only: z
      .boolean()
      .optional()
      .default(false)
      .describe("Return only the match count (like grep -c) instead of the matches"),
    unique: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Deduplicate matches and return [{match, count}] sorted by frequency (like sort | uniq -c)"
      ),
  },
  async ({
    file_path,
    text,
    paths,
    glob,
    cwd,
    pattern,
    flags,
    group,
    limit,
    count_only,
    unique,
  }) => {
    const opts = { pattern, flags, group, limit, count_only, unique };
    const multi = (paths && paths.length) || glob;

    if (multi) {
      const files = await resolvePaths({ file_path, paths, glob, cwd });
      const results = [];
      for (const f of files) {
        try {
          const content = await readFileCapped(f);
          results.push({ file: f, result: await runRegex(content, opts) });
        } catch (err) {
          results.push({ file: f, error: (err as Error).message });
        }
      }
      return textResult(JSON.stringify(results, null, 2));
    }

    const content = await resolveContent(file_path, text);
    return textResult(JSON.stringify(await runRegex(content, opts), null, 2));
  }
);

server.tool(
  "html_select",
  "Extract elements from HTML using CSS selectors.",
  {
    file_path: z
      .string()
      .optional()
      .describe("Absolute path to an HTML file"),
    text: z
      .string()
      .optional()
      .describe("Inline HTML string (alternative to file_path)"),
    selector: z.string().describe("CSS selector"),
    attribute: z
      .string()
      .optional()
      .describe("Return a specific attribute value instead of text"),
    output: z
      .enum(["text", "html", "outer"])
      .optional()
      .default("text")
      .describe("Output format: inner text, inner html, or outer html"),
    limit: z
      .number()
      .optional()
      .default(50)
      .describe("Max elements to return"),
  },
  async ({ file_path, text, selector, attribute, output, limit }) => {
    const raw = await resolveContent(file_path, text);
    const $ = cheerio.load(raw);
    const results: string[] = [];

    $(selector).each((i, el) => {
      if (i >= limit) return false;
      if (attribute) {
        results.push($(el).attr(attribute) || "");
      } else if (output === "html") {
        results.push($(el).html() || "");
      } else if (output === "outer") {
        results.push($.html(el) || "");
      } else {
        results.push($(el).text());
      }
    });

    return textResult(JSON.stringify(results, null, 2));
  }
);

server.tool(
  "json_transform",
  "Transform JSON data: apply string replacements across all values, set or delete fields " +
    "by path, and optionally write the result to a file. Designed for content migration " +
    "(URL rewrites, ID swaps) and bulk JSON manipulation without ad-hoc scripts.",
  {
    file_path: z
      .string()
      .optional()
      .describe("Absolute path to a JSON file"),
    text: z
      .string()
      .optional()
      .describe("Inline JSON string (alternative to file_path)"),
    parse_nested: z
      .boolean()
      .optional()
      .default(false)
      .describe("Recursively parse string values that contain JSON before transforming"),
    replacements: z
      .array(
        z.object({
          from: z.string().describe("String or regex pattern to find"),
          to: z.string().describe("Replacement string"),
          regex: z
            .boolean()
            .optional()
            .default(false)
            .describe("Treat 'from' as a regex pattern"),
        })
      )
      .optional()
      .default([])
      .describe("Find/replace pairs applied to every string value in the JSON tree"),
    set: z
      .array(
        z.object({
          path: z
            .string()
            .describe("Dot-separated path (e.g. 'meta.url' or 'items.0.id')"),
          value: z.unknown().describe("Value to set at that path"),
        })
      )
      .optional()
      .default([])
      .describe("Set values at specific paths"),
    delete: z
      .array(z.string())
      .optional()
      .default([])
      .describe("Dot-separated paths to delete"),
    output_file: z
      .string()
      .optional()
      .describe("If provided, write the result to this file and return a confirmation instead of the full JSON"),
  },
  async ({
    file_path,
    text,
    parse_nested,
    replacements,
    set: sets,
    delete: deletes,
    output_file,
  }) => {
    const raw = await resolveContent(file_path, text);
    let data: unknown = JSON.parse(raw);

    if (parse_nested) {
      data = deepParseJson(data);
    }

    if (replacements.length > 0) {
      data = deepReplace(data, replacements);
    }

    for (const { path, value } of sets) {
      setAtPath(data, path, value);
    }

    for (const path of deletes) {
      deleteAtPath(data, path);
    }

    const output = JSON.stringify(data, null, 2);

    if (output_file) {
      await writeFile(output_file, output, "utf-8");
      return {
        content: [
          {
            type: "text" as const,
            text: `Wrote ${output.length} bytes to ${output_file}`,
          },
        ],
      };
    }

    return textResult(output);
  }
);

server.tool(
  "text_count",
  "Count lines, words, characters, and bytes in a file or inline text (like wc).",
  {
    file_path: z
      .string()
      .optional()
      .describe("Absolute path to the file"),
    text: z
      .string()
      .optional()
      .describe("Inline text (alternative to file_path)"),
  },
  async ({ file_path, text }) => {
    const content = await resolveContent(file_path, text);
    const lines = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    const words = content.split(/\s+/).filter(Boolean).length;
    const characters = content.length;
    const bytes = Buffer.byteLength(content, "utf-8");

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ lines, words, characters, bytes }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "jsonl_query",
  "Query newline-delimited JSON (JSONL/NDJSON) — transcripts, logs, exports — " +
    "one JSON object per line. Applies a JMESPath expression per record, with " +
    "optional filtering, group-by aggregation, and multi-file fan-out. " +
    "Unparseable lines are skipped. This is what json_query cannot do: it parses " +
    "a single document, JSONL is many.",
  {
    file_path: z.string().optional().describe("Absolute path to a .jsonl file"),
    text: z
      .string()
      .optional()
      .describe("Inline JSONL string (alternative to file_path)"),
    paths: z
      .array(z.string())
      .optional()
      .describe("Multiple .jsonl file paths to read as one stream of records"),
    glob: z
      .string()
      .optional()
      .describe("Glob (e.g. '**/*.jsonl') to read many files as one stream"),
    cwd: z
      .string()
      .optional()
      .describe("Base directory for a relative glob (default: process cwd)"),
    expression: z
      .string()
      .optional()
      .describe(
        "JMESPath expression applied to each record (default: the whole record)"
      ),
    filter: z
      .string()
      .optional()
      .describe(
        "JMESPath boolean expression; records are kept only when it evaluates truthy"
      ),
    group_by: z
      .string()
      .optional()
      .describe(
        "JMESPath key expression; when set, returns [{key, count}] sorted by " +
          "count desc (like awk/GROUP BY) instead of per-record results"
      ),
    parse_nested: z
      .boolean()
      .optional()
      .default(false)
      .describe("Recursively parse JSON strings embedded inside record values"),
    include_source: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Tag each per-record result with its source file as {source, value}"
      ),
    limit: z
      .number()
      .optional()
      .default(100)
      .describe("Max results (records or groups) to return"),
  },
  async ({
    file_path,
    text,
    paths,
    glob,
    cwd,
    expression,
    filter,
    group_by,
    parse_nested,
    include_source,
    limit,
  }) => {
    // Gather sources as [sourceLabel, content].
    const sources: Array<[string, string]> = [];
    if (text !== undefined && !file_path && !paths && !glob) {
      sources.push(["<text>", text]);
    } else {
      const files = await resolvePaths({ file_path, paths, glob, cwd });
      for (const f of files) {
        try {
          sources.push([f, await readFileCapped(f)]);
        } catch {
          /* unreadable file → skipped */
        }
      }
    }

    const groups = new Map<string, number>();
    const records: unknown[] = [];
    let scanned = 0;
    let matched = 0;

    for (const [label, content] of sources) {
      for (let rec of iterJsonl(content)) {
        scanned++;
        if (parse_nested) rec = deepParseJson(rec);
        if (filter) {
          const ok = jmespath.search(rec, filter);
          if (!ok) continue;
        }
        matched++;
        if (group_by) {
          const key = jmespath.search(rec, group_by);
          const keyStr =
            key === null || key === undefined
              ? "null"
              : typeof key === "object"
              ? JSON.stringify(key)
              : String(key);
          groups.set(keyStr, (groups.get(keyStr) || 0) + 1);
        } else if (records.length < limit) {
          const value = expression ? jmespath.search(rec, expression) : rec;
          records.push(include_source ? { source: label, value } : value);
        }
      }
    }

    if (group_by) {
      const sorted = [...groups.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
      return textResult(
        JSON.stringify({ scanned, matched, groups: sorted }, null, 2)
      );
    }

    return textResult(JSON.stringify(records, null, 2));
  }
);

server.tool(
  "file_list",
  "List files matching a glob, with optional mtime / size / type filters and " +
    "sorting — a structured replacement for `find`/`ls`. The natural front half " +
    "of a parse workflow: list the files, then query their contents.",
  {
    glob: z
      .string()
      .describe(
        "Glob pattern. Absolute (e.g. '/var/log/**/*.log') or relative to path " +
          "(e.g. '**/*.ts'). Supports **, *, ?, and {a,b} alternation."
      ),
    path: z
      .string()
      .optional()
      .describe("Base directory for a relative glob (default: process cwd)"),
    since: z
      .string()
      .optional()
      .describe(
        "Only files modified at/after this time. Accepts a relative duration " +
          "('2d', '30m', '1w'), epoch ms, or an ISO date."
      ),
    until: z
      .string()
      .optional()
      .describe("Only files modified at/before this time (same formats as since)"),
    min_size: z.number().optional().describe("Minimum size in bytes"),
    max_size: z.number().optional().describe("Maximum size in bytes"),
    type: z
      .enum(["file", "dir", "any"])
      .optional()
      .default("file")
      .describe("Match files, directories, or both"),
    stat: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Return {path, size, mtime, type} objects instead of bare path strings"
      ),
    sort: z
      .enum(["path", "mtime", "size"])
      .optional()
      .default("path")
      .describe("Sort key"),
    desc: z
      .boolean()
      .optional()
      .default(false)
      .describe("Sort descending"),
    limit: z.number().optional().default(1000).describe("Max entries to return"),
  },
  async ({ glob, path: cwd, since, until, min_size, max_size, type, stat: withStat, sort, desc, limit }) => {
    const entries = await globFiles(glob, {
      cwd,
      since,
      until,
      minSize: min_size,
      maxSize: max_size,
      type,
    });

    entries.sort((a, b) => {
      let cmp = 0;
      if (sort === "mtime") cmp = a.mtimeMs - b.mtimeMs;
      else if (sort === "size") cmp = a.size - b.size;
      else cmp = a.path.localeCompare(b.path);
      return desc ? -cmp : cmp;
    });

    const sliced = entries.slice(0, limit);
    const payload = withStat
      ? sliced.map(({ path, size, mtime, type }) => ({ path, size, mtime, type }))
      : sliced.map((e) => e.path);

    return textResult(
      JSON.stringify(
        { count: entries.length, returned: sliced.length, files: payload },
        null,
        2
      )
    );
  }
);

server.tool(
  "csv_query",
  "Query delimited text (CSV / TSV / whitespace columns) — select columns, " +
    "filter rows, and group-by with count/sum/avg/min/max aggregation. Each row " +
    "becomes a record object addressable by header name (or c0,c1,… when header " +
    "is false), so filter/expression/group_by all take JMESPath. Replaces " +
    "awk/cut for column work; supports multi-file paths/glob.",
  {
    file_path: z.string().optional().describe("Absolute path to a delimited file"),
    text: z.string().optional().describe("Inline delimited text (alternative to file_path)"),
    paths: z
      .array(z.string())
      .optional()
      .describe("Multiple delimited files read as one set of rows"),
    glob: z.string().optional().describe("Glob to read many delimited files as one set"),
    cwd: z.string().optional().describe("Base directory for a relative glob"),
    delimiter: z
      .string()
      .optional()
      .default(",")
      .describe("Field delimiter: ',' (default), '\\t' for TSV, '|', ';', or 'whitespace'"),
    header: z
      .boolean()
      .optional()
      .default(true)
      .describe("Treat the first row as column names. If false, columns are c0,c1,…"),
    columns: z
      .array(z.string())
      .optional()
      .describe("Column names/keys to keep in the output (default: all)"),
    filter: z
      .string()
      .optional()
      .describe("JMESPath boolean over the row object; rows kept only when truthy"),
    expression: z
      .string()
      .optional()
      .describe("JMESPath applied to each row object (overrides columns)"),
    group_by: z
      .string()
      .optional()
      .describe("JMESPath key expression; returns aggregated groups instead of rows"),
    agg: z
      .enum(["count", "sum", "avg", "min", "max"])
      .optional()
      .default("count")
      .describe("Aggregation for group_by (sum/avg/min/max need agg_field)"),
    agg_field: z
      .string()
      .optional()
      .describe("Column to aggregate numerically when agg is sum/avg/min/max"),
    limit: z.number().optional().default(100).describe("Max rows or groups to return"),
  },
  async ({
    file_path,
    text,
    paths,
    glob,
    cwd,
    delimiter,
    header,
    columns,
    filter,
    expression,
    group_by,
    agg,
    agg_field,
    limit,
  }) => {
    // Gather records across sources.
    const all: Array<Record<string, string>> = [];
    if (text !== undefined && !file_path && !paths && !glob) {
      all.push(...rowsToObjects(parseDelimited(text, delimiter), header));
    } else {
      const files = await resolvePaths({ file_path, paths, glob, cwd });
      for (const f of files) {
        try {
          all.push(
            ...rowsToObjects(parseDelimited(await readFileCapped(f), delimiter), header)
          );
        } catch {
          /* unreadable file → skipped */
        }
      }
    }

    const kept = filter ? all.filter((r) => jmespath.search(r, filter)) : all;

    if (group_by) {
      const counts = new Map<string, number>();
      const nums = new Map<string, number[]>();
      for (const r of kept) {
        const key = jmespath.search(r, group_by);
        const keyStr =
          key === null || key === undefined
            ? "null"
            : typeof key === "object"
            ? JSON.stringify(key)
            : String(key);
        counts.set(keyStr, (counts.get(keyStr) || 0) + 1);
        if (agg !== "count" && agg_field) {
          const n = Number(r[agg_field]);
          if (!Number.isNaN(n)) {
            if (!nums.has(keyStr)) nums.set(keyStr, []);
            nums.get(keyStr)!.push(n);
          }
        }
      }
      const groups = [...counts.entries()]
        .map(([key, count]) => {
          const out: Record<string, unknown> = { key, count };
          if (agg !== "count" && agg_field) {
            out[agg] = aggregateValues(nums.get(key) || [], agg);
          }
          return out;
        })
        .sort((a, b) => (b.count as number) - (a.count as number))
        .slice(0, limit);
      return textResult(
        JSON.stringify({ scanned: all.length, matched: kept.length, groups }, null, 2)
      );
    }

    const projected = kept.slice(0, limit).map((r) => {
      if (expression) return jmespath.search(r, expression);
      if (columns && columns.length) {
        const o: Record<string, string> = {};
        for (const c of columns) o[c] = r[c] ?? "";
        return o;
      }
      return r;
    });

    return textResult(JSON.stringify(projected, null, 2));
  }
);

server.tool(
  "text_replace",
  "Find/replace on plain text or a file — literal or regex, applied in order, " +
    "with optional write-to-file. The plain-text counterpart to json_transform " +
    "(which only operates on JSON trees); replaces `sed s/.../.../`. Regex " +
    "replacements support capture-group references ($1, $2) in the replacement.",
  {
    file_path: z.string().optional().describe("Absolute path to the file"),
    text: z.string().optional().describe("Inline text (alternative to file_path)"),
    replacements: z
      .array(
        z.object({
          from: z.string().describe("String or regex pattern to find"),
          to: z.string().describe("Replacement (supports $1, $2 when regex)"),
          regex: z
            .boolean()
            .optional()
            .default(false)
            .describe("Treat 'from' as a regex pattern"),
          flags: z
            .string()
            .optional()
            .default("g")
            .describe("Regex flags when regex is true (default 'g')"),
        })
      )
      .min(1)
      .describe("Find/replace pairs applied in order"),
    output_file: z
      .string()
      .optional()
      .describe("If provided, write the result here and return a summary instead of the text"),
  },
  async ({ file_path, text, replacements, output_file }) => {
    let result = await resolveContent(file_path, text);
    let total = 0;
    for (const { from, to, regex, flags } of replacements) {
      if (regex) {
        // Run the (user-supplied) regex in a worker with a timeout so a
        // catastrophic pattern is killed instead of hanging the server.
        const f = flags.includes("g") ? flags : flags + "g";
        const out = await runInWorker<{ result: string; count: number }>(
          REPLACE_WORKER,
          { text: result, from, to, flags: f },
          REGEX_TIMEOUT_MS
        );
        total += out.count;
        result = out.result;
      } else {
        const parts = result.split(from);
        total += parts.length - 1;
        result = parts.join(to);
      }
    }

    if (output_file) {
      await writeFile(output_file, result, "utf-8");
      return {
        content: [
          {
            type: "text" as const,
            text: `Made ${total} replacement(s), wrote ${Buffer.byteLength(
              result,
              "utf-8"
            )} bytes to ${output_file}`,
          },
        ],
      };
    }

    return textResult(result);
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Last-resort guards: a stray async throw or rejected promise would otherwise
// crash the process and drop the stdio transport (a "disconnect"). Log to
// stderr (stdout is the JSON-RPC channel) and keep the server alive. Note an
// out-of-memory abort is uncatchable by design — the input-size cap is what
// keeps us clear of that.
process.on("uncaughtException", (err) => {
  console.error("[parse-mcp] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[parse-mcp] unhandledRejection:", reason);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
