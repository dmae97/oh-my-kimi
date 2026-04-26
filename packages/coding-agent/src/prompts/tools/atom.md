Applies precise file edits using full anchors from `read` output (for example `160sr`).

Read the file first. Copy the full anchors exactly as shown by `read`.

<operations>
**Top level**: `{ path, edits: […] }` — `path` is shared by all entries. You may still override the file inside `loc` with forms like `other.ts:160sr`.

Each entry has one shared locator plus one or more verbs:
- `loc: "160sr"` — single anchored line
- `loc: "^"` — beginning of file (only valid with `pre`)
- `loc: "$"` — end of file (only valid with `post`)
- `loc: "a.ts:160sr"` — cross-file override inside the locator

Verbs:
- `set: ["…"]` — replace the anchor line
- `pre: ["…"]` — insert before the anchor line (or at BOF when `loc:"^"`)
- `post: ["…"]` — insert after the anchor line (or at EOF when `loc:"$"`)
- `sed: "s/foo/bar/"` — sed-style substitution applied to the anchor line. **Prefer this over `set` for token-level changes**
Flags: `g` (all occurrences), `i` (case-insensitive), `F` (literal/fixed-string, no regex).
Delimiter is whatever character follows `s`.
You **MUST** keep the pattern as short as possible.

Combination rules:
- On a single-anchor `loc`, you may combine `pre`, `set`, and `post` in the same entry.
- `set: []` on a single-anchor `loc` deletes that line.
- `set:[""]` is **not** delete — it replaces the line with a blank line.
</operations>

<examples>
All examples below reference the same file:

```ts title="a.ts"
{{hline 1 "const tag = \"BAD\";"}}
{{hline 2 ""}}
{{hline 3 "function beta(x) {"}}
{{hline 4 "\tif (x) {"}}
{{hline 5 "\t\treturn parse(data) || fallback;"}}
{{hline 6 "\t}"}}
{{hline 7 "\treturn null;"}}
{{hline 8 "}"}}
```

# Replace a line with `set`
`{path:"a.ts",edits:[{loc:{{href 1 "const tag = \"BAD\";"}},set:["const tag = \"OK\";"]}]}`

# Combine `pre` + `set` + `post` in one entry
`{path:"a.ts",edits:[{loc:{{href 4 "\tif (x) {"}},pre:["\tvalidate();"],set:["\tif (!x) {"],post:["\t\tlog();"]}]}`

# Delete a line with `set: []`
`{path:"a.ts",edits:[{loc:{{href 7 "\treturn null;"}},set:[]}]}`

# Preserve a blank line with `set:[""]`
`{path:"a.ts",edits:[{loc:{{href 2 ""}},set:[""]}]}`

# Insert before / after a line
`{path:"a.ts",edits:[{loc:{{href 3 "function beta(x) {"}},pre:["function gamma() {","\tvalidate();","}",""]}]}`

# Substitute one token with `sed` (regex) — preferred for token-level edits
Use the smallest pattern that uniquely identifies the change.
`{path:"a.ts",edits:[{loc:{{href 5 "\t\treturn parse(data) || fallback;"}},sed:"s/\\|\\|/??/"}]}`

# Substitute every occurrence with `sed` (literal/fixed-string)
Use the `F` flag to disable regex; the delimiter can be any non-alphanumeric char.
`{path:"a.ts",edits:[{loc:{{href 5 "\t\treturn parse(data) || fallback;"}},sed:"s|data|input|gF"}]}`

# Prepend / append at file edges
`{path:"a.ts",edits:[{loc:"^",pre:["// Copyright (c) 2026",""]}]}`
`{path:"a.ts",edits:[{loc:"$",post:["","export const VERSION = \"1.0.0\";"]}]}`

# Cross-file override inside `loc`
`{path:"a.ts",edits:[{loc:"b.ts:{{href 1 "const tag = \"BAD\";"}}",set:["const tag = \"OK\";"]}]}`
</examples>

<critical>
- Make the minimum exact edit.
- Copy the full anchors exactly as shown by `read/grep` (for example `160sr`, not just `sr`).
- `loc` chooses the target. Verbs describe what to do there.
- On a single-anchor `loc`, you may combine `pre`, `set`, and `post`.
- `loc:"^"` only supports `pre`. `loc:"$"` only supports `post`.
- `set: []` deletes the anchored line. `set:[""]` preserves a blank line.
- Within a single request you may submit edits in any order — the runtime applies them bottom-up so they don't shift each other. After any request that mutates a file, anchors below the mutation are stale on disk; re-read before issuing more edits to that file.
- `set` operations target the current file content only. Do not try to reference old line text after the file has changed.
- For token-level edits, prefer `sed` over `set`. The `loc` anchor already pins the line — repeating the entire line in a `set` array invites hallucinated content. Use the smallest `sed` pattern that uniquely identifies the change on that line; do not pad it with surrounding text just to feel safe.
- When you do use `set`, re-read the anchored line first and copy it verbatim, changing only the required token(s). Anchor identity does not verify line content, so a hallucinated replacement will silently corrupt the file.
- Text content must be literal file content with matching indentation. If the file uses tabs, use real tabs.
- You **MUST NOT** use this tool to reformat or clean up unrelated code.
</critical>
