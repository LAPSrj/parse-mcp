#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile } from "fs/promises";
import jmespath from "jmespath";
import * as cheerio from "cheerio";

const server = new McpServer({
  name: "parse-mcp",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveContent(
  filePath?: string,
  text?: string
): Promise<string> {
  if (filePath) return readFile(filePath, "utf-8");
  if (text) return text;
  throw new Error("Provide either file_path or text");
}

/** Recursively parse any string values that look like JSON. */
function deepParseJson(data: unknown): unknown {
  if (typeof data === "string") {
    try {
      return deepParseJson(JSON.parse(data));
    } catch {
      return data;
    }
  }
  if (Array.isArray(data)) {
    return data.map(deepParseJson);
  }
  if (data && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = deepParseJson(value);
    }
    return result;
  }
  return data;
}

/** Apply find/replace pairs to every string value in a JSON tree. */
function deepReplace(
  data: unknown,
  replacements: Array<{ from: string; to: string; regex?: boolean }>
): unknown {
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
    return data.map((item) => deepReplace(item, replacements));
  }
  if (data && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = deepReplace(value, replacements);
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

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "regex_extract",
  "Extract regex matches from a file or inline text.",
  {
    file_path: z
      .string()
      .optional()
      .describe("Absolute path to the file"),
    text: z
      .string()
      .optional()
      .describe("Inline text (alternative to file_path)"),
    pattern: z.string().describe("Regular expression pattern"),
    flags: z
      .string()
      .optional()
      .default("g")
      .describe("Regex flags (default: 'g')"),
    group: z
      .number()
      .optional()
      .describe("Capture group index to return (0 = full match)"),
    limit: z
      .number()
      .optional()
      .default(50)
      .describe("Max matches to return"),
  },
  async ({ file_path, text, pattern, flags, group, limit }) => {
    const content = await resolveContent(file_path, text);
    const regex = new RegExp(pattern, flags);
    const matches: string[] = [];

    let match;
    while (
      (match = regex.exec(content)) !== null &&
      matches.length < limit
    ) {
      if (group !== undefined && match[group] !== undefined) {
        matches.push(match[group]);
      } else {
        matches.push(match[0]);
      }
      if (!flags.includes("g")) break;
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(matches, null, 2) }],
    };
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

    return {
      content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
    };
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

    return {
      content: [{ type: "text" as const, text: output }],
    };
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

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
