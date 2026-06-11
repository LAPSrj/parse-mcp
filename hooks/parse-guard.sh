#!/usr/bin/env bash
# parse-guard.sh — Claude Code PreToolUse hook for Bash commands
# Blocks shell commands that should use parse-mcp tools instead.
#
# Catches:
#   python json / JSON.parse / jq  →  json_query / jsonl_query / json_transform
#   wc                              →  text_count
#   grep -o                         →  regex_extract
#   grep -c                         →  regex_extract (count_only)
#   standalone grep (reads files)   →  Grep tool / regex_extract  (piped grep allowed)
#   ls / find (listing)             →  file_list  (piped / -exec / -delete allowed)
#   awk '/re/{print}' / sed -n /re/p →  Grep tool / regex_extract  (real processing allowed)
#   cut (column extraction)         →  csv_query  (piped / -c/-b char mode allowed)
#   sed 's/.../.../' (substitution) →  text_replace  (piped sed allowed)
#
# See the parse-mcp README for installation instructions.

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$1"
  exit 0
}

# JSON parsing → json_query / jsonl_query / json_transform
printf '%s' "$cmd" | grep -qE 'json\.loads?\(|JSON\.parse\(|\bjq\b|\bjson_pp\b' \
  && deny "Inline JSON parsing detected (python json, JSON.parse, jq, json_pp). Use parse-mcp json_query (JMESPath reads) or json_transform (bulk edits) for a single JSON document, or jsonl_query for newline-delimited JSON (transcripts, logs, NDJSON) with per-record filter/group_by. All accept file_path, text, or a glob."

# Counting → text_count
printf '%s' "$cmd" | grep -qE '\bwc\s+-[lwcm]|\|\s*wc\b' \
  && deny "Use parse-mcp text_count instead of wc. It returns {lines, words, characters, bytes} and accepts file_path or text."

# grep extraction mode → regex_extract
printf '%s' "$cmd" | grep -qE '\bgrep\s+-[a-zA-Z]*o' \
  && deny "Use parse-mcp regex_extract instead of grep -o. Supports capture groups, unique:true for deduplication with frequency counts, count_only:true for match counting, and paths/glob to scan many files at once."

# grep count mode → regex_extract (count_only)
printf '%s' "$cmd" | grep -qE '\bgrep\s+-[a-zA-Z]*c' \
  && deny "Use parse-mcp regex_extract with count_only:true instead of grep -c. Pass a glob to count across many files at once."

# standalone grep (reads files directly) → Grep tool / regex_extract.
# Matches grep/egrep/fgrep at the START of a command (line start, or after ; & ( or ||),
# allowing optional leading VAR=val env-prefixes. Grep that follows a single pipe is
# NOT matched, so piped/streaming grep (tail -f log | grep ...) is still allowed.
printf '%s' "$cmd" | grep -qE '(^|[;&(]|\|\|)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*(grep|egrep|fgrep)([[:space:]]|$)' \
  && deny "Use the built-in Grep tool to search file contents (or parse-mcp regex_extract for capture groups / structured output). Standalone grep sits in the approval list and STALLS the session on a Yes/No prompt — the Grep tool and parse-mcp don't. Piped grep for live streams (e.g. 'tail -f log | grep --line-buffered ERROR') is still allowed."

# File listing → file_list.
# Matches ls/find at the START of a command (line start, or after ; & ( or ||),
# allowing optional leading VAR=val env-prefixes. Allowed (NOT matched) when the
# command pipes (|) or uses find action flags (-exec/-execdir/-ok/-okdir/-delete) —
# those forms file_list can't replace, so they fall through to normal handling.
printf '%s' "$cmd" | grep -qE '(^|[;&(]|\|\|)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*(ls|find)([[:space:]]|$)' \
  && ! printf '%s' "$cmd" | grep -qE '\||-(exec|execdir|ok|okdir|delete)\b' \
  && deny "Use parse-mcp file_list instead of ls/find for listing files. It takes a glob (with since/until, min_size/max_size, and type filters), sorts by path/mtime/size, and returns {count, returned, files}. Piped forms (ls | ...) and find with -exec/-delete are NOT blocked — file_list doesn't replace those."

# Pattern-match-and-print awk (grep substitute) → Grep tool / regex_extract.
# Matches awk whose program begins with a /regex/ address. Allowed (NOT matched)
# when it does real processing — field separators (-F), gsub/sub, BEGIN/END,
# arithmetic-assignment, printf, or access to a specific field ($1-$9) — or when
# piped. So '/re/{print $0}' / '/re/{print NR}' is caught; field/aggregate awk isn't.
# (Greedy class may rarely false-positive on a literal '/' inside a printed string.)
printf '%s' "$cmd" | grep -qE '(^|[;&(]|\|\|)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*awk[[:space:]]+(-[A-Za-z][^[:space:]]*[[:space:]]+)*[^[:space:]{;]*/' \
  && ! printf '%s' "$cmd" | grep -qE '\||-F|sub\(|BEGIN|END|[-+*/]=|printf|\$[1-9]' \
  && deny "Use the Grep tool (line matches) or parse-mcp regex_extract (capture groups, unique, count_only, multi-file glob) instead of awk for pattern-match-and-print. awk doing real processing (field math, -F, gsub/sub, BEGIN/END, specific fields \$1-\$9) or piped awk is not blocked."

# Print-only sed extraction (sed -n '/re/p') → Grep tool / regex_extract.
# Only the -n …/re/p form is caught; substituting/transforming sed (s/.../.../),
# line-range prints (no parse-mcp equivalent), and piped sed are allowed.
printf '%s' "$cmd" | grep -qE '(^|[;&(]|\|\|)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*sed[[:space:]]+-n([[:space:]]|$)' \
  && printf '%s' "$cmd" | grep -qE '/[^/]*/p' \
  && ! printf '%s' "$cmd" | grep -qE '\||s/' \
  && deny "Use the Grep tool or parse-mcp regex_extract instead of sed -n '/re/p' to print lines matching a pattern."

# Column extraction (cut) → csv_query.
# Allowed (NOT matched) when piped (streaming/composition) or in -c/-b char/byte
# mode (csv_query does columns, not character ranges).
printf '%s' "$cmd" | grep -qE '(^|[;&(]|\|\|)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*cut([[:space:]]|$)' \
  && ! printf '%s' "$cmd" | grep -qE '\||-c|-b' \
  && deny "Use parse-mcp csv_query (delimiter + columns to select, plus filter and group_by aggregation) instead of cut for column extraction. Piped cut and -c/-b character mode are not blocked."

# Substitution sed (sed 's/.../.../') → text_replace.
# Matches a sed s/// (or s###) command at lead; allowed when piped (streaming
# transform). The print-only sed -n form is handled by the rule above.
printf '%s' "$cmd" | grep -qE '(^|[;&(]|\|\|)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*sed[[:space:]]' \
  && printf '%s' "$cmd" | grep -qE 's/[^/]*/[^/]*/|s#[^#]*#[^#]*#' \
  && ! printf '%s' "$cmd" | grep -qE '\|' \
  && deny "Use parse-mcp text_replace (literal or regex find/replace, applied in order, optional write-to-file) instead of sed s/.../.../ for substitution. Piped sed is not blocked."

exit 0
