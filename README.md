# parse-mcp

MCP server with scoped, read-only parsing tools (JSON, JSONL, CSV/TSV, regex, HTML) plus file-listing and text utilities.

## Tools

### json_query

Query JSON data using a [JMESPath](https://jmespath.org/) expression.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `file_path` | string? | | Absolute path to a JSON file |
| `text` | string? | | Inline JSON string (alternative to file_path) |
| `expression` | string | | JMESPath expression to evaluate |
| `parse_nested` | boolean? | `false` | Recursively parse string values that contain JSON |
| `limit` | number? | `50` | Max array items to return |

### json_transform

Transform JSON data: apply string replacements across all values, set or delete fields by path, and optionally write the result to a file. Designed for content migration (URL rewrites, ID swaps) and bulk JSON manipulation without ad-hoc scripts.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `file_path` | string? | | Absolute path to a JSON file |
| `text` | string? | | Inline JSON string (alternative to file_path) |
| `parse_nested` | boolean? | `false` | Recursively parse string values that contain JSON before transforming |
| `replacements` | array? | `[]` | Find/replace pairs applied to every string value in the tree. Each entry: `{from, to, regex?}` |
| `set` | array? | `[]` | Set values at dot-separated paths. Each entry: `{path, value}` |
| `delete` | string[]? | `[]` | Dot-separated paths to delete |
| `output_file` | string? | | Write the result to this file instead of returning it |

#### Examples

Replace URLs in all string values:

```json
{
  "file_path": "/tmp/page.json",
  "replacements": [
    { "from": "http://staging.localhost", "to": "https://production.com" },
    { "from": "wp-content/uploads/2024/", "to": "wp-content/uploads/2025/", "regex": false }
  ]
}
```

Set and delete fields:

```json
{
  "text": "{\"title\":\"Hello\",\"draft\":true,\"meta\":{\"author\":\"old\"}}",
  "set": [{ "path": "meta.author", "value": "new" }],
  "delete": ["draft"]
}
```

Write large results to a file to avoid blowing context:

```json
{
  "file_path": "/tmp/large-export.json",
  "replacements": [{ "from": "media-id-100", "to": "media-id-200" }],
  "output_file": "/tmp/large-export-transformed.json"
}
```

### text_replace

Find/replace on **plain text** or a file — literal or regex, applied in order, with optional write-to-file. The plain-text counterpart to `json_transform` (which only operates on JSON trees); replaces `sed s/.../.../`. Regex replacements support capture-group references (`$1`, `$2`) in the replacement.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `file_path` | string? | | Absolute path to the file |
| `text` | string? | | Inline text (alternative to file_path) |
| `replacements` | array | | Find/replace pairs applied in order. Each entry: `{from, to, regex?, flags?}` |
| `output_file` | string? | | Write the result here and return a summary instead of the text |

Returns the transformed text, or `Made N replacement(s), wrote B bytes to …` when `output_file` is set.

#### Example

Regex replace with a capture group, written back to the file:

```json
{
  "file_path": "/tmp/config.env",
  "replacements": [{ "from": "PORT=(\\d+)", "to": "PORT=8080", "regex": true }],
  "output_file": "/tmp/config.env"
}
```

### jsonl_query

Query newline-delimited JSON (JSONL/NDJSON) — transcripts, logs, exports — one JSON object per line. Applies a [JMESPath](https://jmespath.org/) expression per record, with optional filtering, group-by aggregation, and multi-file fan-out. Unparseable lines are skipped. This is what `json_query` cannot do: it parses a single document; JSONL is many.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `file_path` | string? | | Absolute path to a `.jsonl` file |
| `text` | string? | | Inline JSONL string (alternative to file_path) |
| `paths` | string[]? | | Multiple `.jsonl` file paths read as one stream of records |
| `glob` | string? | | Glob (e.g. `**/*.jsonl`) to read many files as one stream |
| `cwd` | string? | | Base directory for a relative glob |
| `expression` | string? | | JMESPath applied to each record (default: the whole record) |
| `filter` | string? | | JMESPath boolean; records kept only when it evaluates truthy |
| `group_by` | string? | | JMESPath key expression; returns `{scanned, matched, groups: [{key, count}]}` sorted by count desc (like `GROUP BY`) |
| `parse_nested` | boolean? | `false` | Recursively parse JSON strings embedded inside record values |
| `include_source` | boolean? | `false` | Tag each per-record result with its source file as `{source, value}` |
| `limit` | number? | `100` | Max results (records or groups) to return |

#### Examples

Aggregate message roles across every transcript in a directory:

```json
{
  "glob": "/path/to/transcripts/*.jsonl",
  "group_by": "message.role"
}
```

Filter then project — pull user prompts out of one transcript:

```json
{
  "file_path": "/path/to/session.jsonl",
  "filter": "type == 'user'",
  "expression": "message.content"
}
```

### csv_query

Query delimited text (CSV / TSV / whitespace columns) — select columns, filter rows, and group-by with count/sum/avg/min/max aggregation. Each row becomes a record object addressable by header name (or `c0`, `c1`, … when `header` is false), so `filter`, `expression`, and `group_by` all take [JMESPath](https://jmespath.org/). Replaces `awk`/`cut` for column work; supports multi-file `paths`/`glob`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `file_path` | string? | | Absolute path to a delimited file |
| `text` | string? | | Inline delimited text (alternative to file_path) |
| `paths` | string[]? | | Multiple delimited files read as one set of rows |
| `glob` | string? | | Glob to read many delimited files as one set |
| `cwd` | string? | | Base directory for a relative glob |
| `delimiter` | string? | `","` | `","`, `"\t"` (TSV), `"\|"`, `";"`, or `"whitespace"` |
| `header` | boolean? | `true` | First row is column names; if false, columns are `c0`, `c1`, … |
| `columns` | string[]? | | Column names/keys to keep in the output (default: all) |
| `filter` | string? | | JMESPath boolean over the row object; rows kept only when truthy |
| `expression` | string? | | JMESPath applied to each row object (overrides `columns`) |
| `group_by` | string? | | JMESPath key expression; returns aggregated groups instead of rows |
| `agg` | string? | `"count"` | `count`, `sum`, `avg`, `min`, `max` (the last four need `agg_field`) |
| `agg_field` | string? | | Column to aggregate numerically when `agg` is sum/avg/min/max |
| `limit` | number? | `100` | Max rows or groups to return |

#### Example

Total quantity per region across a CSV:

```json
{
  "file_path": "/tmp/sales.csv",
  "group_by": "region",
  "agg": "sum",
  "agg_field": "qty"
}
```

### regex_extract

Extract regex matches from a file, inline text, or many files at once (`paths`/`glob`).

With a single `file_path`/`text`, returns the matches directly. With a glob or paths array, returns `{scanned, matched, results}`, where `results` holds one `{file, result}` per file **that matched** — files with no matches are omitted, so `scanned` is the total examined and `matched` is `results.length`. A file whose regex overruns the per-file timeout is reported as `{file, error}` and the scan continues past it. If the whole call exceeds its budget, a `note` field says so and the results are partial.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `file_path` | string? | | Absolute path to the file |
| `text` | string? | | Inline text (alternative to file_path) |
| `paths` | string[]? | | Multiple file paths to scan; returns one result per matching file |
| `glob` | string? | | Glob (e.g. `**/*.ts`) to scan many files; returns one result per matching file |
| `cwd` | string? | | Base directory for a relative glob |
| `pattern` | string | | Regular expression pattern |
| `flags` | string? | `"g"` | Regex flags |
| `group` | number? | | Capture group index to return (0 = full match) |
| `limit` | number? | `50` | Max matches to return |
| `count_only` | boolean? | `false` | Return `{count}` instead of matches (like `grep -c`) |
| `unique` | boolean? | `false` | Deduplicate matches, return `[{match, count}]` sorted by frequency (like `sort \| uniq -c`) |

### html_select

Extract elements from HTML using CSS selectors (via [Cheerio](https://cheerio.js.org/)).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `file_path` | string? | | Absolute path to an HTML file |
| `text` | string? | | Inline HTML string (alternative to file_path) |
| `selector` | string | | CSS selector |
| `attribute` | string? | | Return a specific attribute value instead of text |
| `output` | string? | `"text"` | `"text"`, `"html"`, or `"outer"` |
| `limit` | number? | `50` | Max elements to return |

### text_count

Count lines, words, characters, and bytes in a file or inline text (like `wc`).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `file_path` | string? | | Absolute path to the file |
| `text` | string? | | Inline text (alternative to file_path) |

Returns `{ lines, words, characters, bytes }`.

### file_list

List files matching a glob, with optional mtime / size / type filters and sorting — a structured replacement for `find`/`ls`. The natural front half of a parse workflow: list the files, then query their contents. Supports `**`, `*`, `?`, and `{a,b}` alternation. Does not follow symlinks.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `glob` | string | | Glob pattern. Absolute (e.g. `/var/log/**/*.log`) or relative to `cwd` |
| `cwd` | string? | | Base directory for a relative glob |
| `since` | string? | | Only files modified at/after this time. Relative duration (`2d`, `30m`, `1w`), epoch ms, or ISO date |
| `until` | string? | | Only files modified at/before this time (same formats) |
| `min_size` | number? | | Minimum size in bytes |
| `max_size` | number? | | Maximum size in bytes |
| `type` | string? | `"file"` | `"file"`, `"dir"`, or `"any"` |
| `stat` | boolean? | `false` | Return `{path, size, mtime, type}` objects instead of bare paths |
| `sort` | string? | `"path"` | Sort key: `"path"`, `"mtime"`, or `"size"` |
| `desc` | boolean? | `false` | Sort descending |
| `limit` | number? | `1000` | Max entries to return |

Returns `{ count, returned, files }`.

#### Example

Newest log files touched in the last two days:

```json
{
  "glob": "/var/log/**/*.log",
  "since": "2d",
  "stat": true,
  "sort": "mtime",
  "desc": true
}
```

## Setup

### Option 1: Download a prebuilt binary

Grab the latest binary for your platform from [Releases](../../releases):

| Platform | File |
|---|---|
| Linux x64 | `parse-mcp-linux-x64` |
| macOS x64 | `parse-mcp-darwin-x64` |
| macOS ARM | `parse-mcp-darwin-arm64` |
| Windows x64 | `parse-mcp-win-x64.exe` |

Make it executable (Linux/macOS):

```bash
chmod +x parse-mcp-*
```

MCP client config using the binary:

```json
{
  "mcpServers": {
    "parse-mcp": {
      "command": "/path/to/parse-mcp-linux-x64"
    }
  }
}
```

### Option 2: Build from source

Requires Node.js >= 18.0.0.

```bash
git clone <repo-url>
cd parse-mcp
npm install
npm run build
```

This compiles TypeScript from `src/` into `dist/`.

MCP client config using Node:

```json
{
  "mcpServers": {
    "parse-mcp": {
      "command": "node",
      "args": ["/path/to/parse-mcp/dist/index.js"]
    }
  }
}
```

Add the config to your MCP client settings (e.g. Claude Desktop `claude_desktop_config.json`, Claude Code `settings.json`, or VS Code MCP config).

No environment variables are required. All tools accept input via `file_path` or inline `text` parameters.

## CLAUDE.md rule

Add the following to your project's `CLAUDE.md` so the agent prefers parse-mcp tools over writing one-off scripts:

```markdown
## Parsing & data extraction

When you need to parse, query, or transform JSON, JSONL, CSV/TSV, HTML, or text
files, or to list files, use the parse-mcp tools (json_query, jsonl_query,
csv_query, json_transform, text_replace, regex_extract, html_select, text_count,
file_list) instead of writing custom scripts, shell pipelines, or inline code.

- **JSON**: Use `json_query` with JMESPath for reads, `json_transform` for bulk
  find/replace, field set/delete, or migration rewrites.
- **JSONL/NDJSON** (transcripts, logs, exports — one JSON object per line): Use
  `jsonl_query` instead of a `cat | jq` / per-line Node loop. It applies a
  JMESPath per record and supports `filter`, `group_by` aggregation, and
  multi-file `glob`/`paths` fan-out.
- **CSV/TSV/columns**: Use `csv_query` instead of `awk`/`cut` for column select,
  row filter, and group-by `sum`/`avg`/`min`/`max`/`count`.
- **HTML**: Use `html_select` with CSS selectors instead of regex or custom DOM
  parsing.
- **Regex**: Use `regex_extract` instead of grep pipelines or throwaway scripts.
  Use `count_only` instead of `grep -c`, and `unique` instead of
  `sort | uniq -c`. Pass `glob`/`paths` to scan many files at once.
- **Text find/replace**: Use `text_replace` instead of `sed s/.../.../` for
  literal or regex substitution on plain text (the non-JSON counterpart to
  `json_transform`).
- **Counting**: Use `text_count` instead of `wc` or manual counting.
- **Listing/finding files**: Use `file_list` with a glob (plus `since`/`until`,
  size, and type filters) instead of `find`/`ls`.

All tools accept a `file_path` or inline `text` — no temp scripts needed.
```

## Hook: parse-guard.sh

An optional [Claude Code hook](https://docs.anthropic.com/en/docs/claude-code/hooks) that **blocks** Bash commands which duplicate parse-mcp capabilities. When the agent tries to use `jq`, `wc`, `grep -o`, etc., the hook denies the command with an explanation of which parse-mcp tool to use instead.

### What it catches

| Pattern | Example | Suggested tool |
|---|---|---|
| Python JSON parsing | `python3 -c "import json; json.load(...)"` | `json_query` / `jsonl_query` |
| jq | `jq '.field' data.json` | `json_query` / `jsonl_query` |
| JSON.parse | `node -e "JSON.parse(...)"` | `json_query` / `jsonl_query` |
| json_pp | `json_pp < file.json` | `json_query` |
| wc | `wc -l file.txt`, `... \| wc -l` | `text_count` |
| grep -o | `grep -oE "pattern" file` | `regex_extract` |
| grep -c | `grep -c "pattern" file` | `regex_extract` with `count_only` |
| standalone grep | `grep "pattern" file` (not piped) | Grep tool / `regex_extract` |
| ls / find (listing) | `find . -name "*.ts"`, `ls -la` | `file_list` |
| awk print / sed -n p | `awk '/re/{print}'`, `sed -n '/re/p'` | Grep tool / `regex_extract` |
| cut | `cut -d, -f2 data.csv` | `csv_query` |
| sed s/// | `sed 's/foo/bar/g' file` | `text_replace` |

Piped/streaming forms, `find -exec`/`-delete`, processing `awk` (`-F`, `BEGIN`/`END`, field math), `cut -c`/`-b`, and line-range `sed -n '5,20p'` are deliberately **not** blocked — they have no single parse-mcp equivalent.

### Installation

1. Copy the hook script to your Claude hooks directory:

```bash
mkdir -p ~/.claude/hooks
cp hooks/parse-guard.sh ~/.claude/hooks/parse-guard.sh
```

2. Add the hook to your **global** `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/parse-guard.sh"
          }
        ]
      }
    ]
  }
}
```

If you already have a `hooks` section, merge the `PreToolUse` entry into your existing array.

The hook requires `jq` to be installed (used to read the tool input from stdin).

### Customization

The script is a plain Bash file. Each check follows the same pattern:

```bash
printf '%s' "$cmd" | grep -qE 'PATTERN' \
  && deny "REASON"
```

Add new blocks to catch additional patterns, or remove checks you don't want enforced.
