# parse-mcp

MCP server with scoped, read-only parsing tools (JSON, regex, HTML) plus text utilities.

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

### regex_extract

Extract regex matches from a file or inline text.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `file_path` | string? | | Absolute path to the file |
| `text` | string? | | Inline text (alternative to file_path) |
| `pattern` | string | | Regular expression pattern |
| `flags` | string? | `"g"` | Regex flags |
| `group` | number? | | Capture group index to return (0 = full match) |
| `limit` | number? | `50` | Max matches to return |

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

When you need to parse, query, or transform JSON, HTML, or text files, use the
parse-mcp tools (json_query, json_transform, regex_extract, html_select,
text_count) instead of writing custom scripts, shell pipelines, or inline code.

- **JSON**: Use `json_query` with JMESPath for reads, `json_transform` for bulk
  find/replace, field set/delete, or migration rewrites.
- **HTML**: Use `html_select` with CSS selectors instead of regex or custom DOM
  parsing.
- **Regex**: Use `regex_extract` instead of grep pipelines or throwaway scripts.
- **Counting**: Use `text_count` instead of `wc` or manual counting.

All tools accept a `file_path` or inline `text` — no temp scripts needed.
```
