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
- `sub: [find, replace]` — replace a unique substring on the anchored line; the line tail is preserved automatically

Combination rules:
- On a single-anchor `loc`, you may combine `pre`, **one of** `set` or `sub`, and `post` in the same entry.
- `set: []` on a single-anchor `loc` deletes that line.
- `set:[""]` is **not** delete — it replaces the line with a blank line.

`sub` is the cheapest op when only part of a line changes. `find` and `replace` should both be the smallest fragment that does the job.
</operations>

<examples>
All examples below reference the same file:

```ts title="a.ts"
{{hline  1 "// @ts-ignore"}}
{{hline  2 "const timeout = 5000;"}}
{{hline  3 "const tag = \"DO NOT SHIP\";"}}
{{hline  4 "const fallback = group.targetFramework || 'All Frameworks';"}}
{{hline  5 "function alpha() {"}}
{{hline  6 "\tlog();"}}
{{hline  7 "}"}}
{{hline  8 ""}}
{{hline  9 "function beta(x) {"}}
{{hline 10 "\tif (x) {"}}
{{hline 11 "\t\treturn parse(data);"}}
{{hline 12 "\t}"}}
{{hline 13 "\treturn null;"}}
{{hline 14 "}"}}
```

# Swap an operator with `sub`
Original line 4: `const fallback = group.targetFramework || 'All Frameworks';`
`{path:"a.ts",edits:[{loc:{{href 4 "const fallback = group.targetFramework || 'All Frameworks';"}},sub:["||","??"]}]}`

# Flip a literal with `sub`
Original line 2: `const timeout = 5000;`
`{path:"a.ts",edits:[{loc:{{href 2 "const timeout = 5000;"}},sub:["5000","30_000"]}]}`

# Negate a condition with `sub`
Original line 10: `\tif (x) {`
`{path:"a.ts",edits:[{loc:{{href 10 "\tif (x) {"}},sub:["(x)","(!x)"]}]}`

# Off-by-one with `sub`
For a single-digit/operator nudge, `sub` is the cheapest op. Do **not** rewrite the whole line with `set`.
Original line 2: `const timeout = 5000;`
`{path:"a.ts",edits:[{loc:{{href 2 "const timeout = 5000;"}},sub:["5000","5001"]}]}`

# Combine `pre` + `set` + `post` in one entry
`{path:"a.ts",edits:[{loc:{{href 6 "\tlog();"}},pre:["\tvalidate();"],set:["\tlog();"],post:["\tcleanup();"]}]}`

# Replace one whole line with `set`
Use `set` when you're rewriting most of the line, or when `sub` would need a long `find`.
`{path:"a.ts",edits:[{loc:{{href 3 "const tag = \"DO NOT SHIP\";"}},set:["const tag = \"OK\";"]}]}`

# Replace multiple non-adjacent lines
`{path:"a.ts",edits:[{loc:{{href 11 "\t\treturn parse(data);"}},set:["\t\treturn parse(data) ?? fallback;"]},{loc:{{href 13 "\treturn null;"}},set:["\treturn fallback;"]}]}`

# Delete a line with `set: []`
`{path:"a.ts",edits:[{loc:{{href 11 "\t\treturn parse(data);"}},set:[]}]}`

# Preserve a blank line with `set:[""]`
`{path:"a.ts",edits:[{loc:{{href 8 ""}},set:[""]}]}`

# Insert before / after a line
`{path:"a.ts",edits:[{loc:{{href 9 "function beta(x) {"}},pre:["function gamma() {","\tvalidate();","}",""]}]}`
`{path:"a.ts",edits:[{loc:{{href 6 "\tlog();"}},post:["\tvalidate();"]}]}`

# Prepend / append at file edges
`{path:"a.ts",edits:[{loc:"^",pre:["// Copyright (c) 2026",""]}]}`
`{path:"a.ts",edits:[{loc:"$",post:["","export const VERSION = \"1.0.0\";"]}]}`

# Cross-file override inside `loc`
`{path:"a.ts",edits:[{loc:"b.ts:{{href 2 "const timeout = 5000;"}}",sub:["5000","30_000"]}]}`
</examples>

<critical>
- Make the minimum exact edit.
- Copy the full anchors exactly as shown by `read/grep` (for example `160sr`, not just `sr`).
- `loc` chooses the target. Verbs describe what to do there.
- On a single-anchor `loc`, you may combine `pre`, **one of** `set` or `sub`, and `post`.
- `set` and `sub` cannot appear together in the same entry.
- On a range `loc`, only `set` is allowed.
- `loc:"^"` only supports `pre`. `loc:"$"` only supports `post`.
- For `sub`, the first tuple element (`find`) must occur **exactly once on the anchored line**. It never spans newlines.
- Prefer the **smallest** `sub` fragments. On a single line of code, 1–4 chars is usually enough (`"||"`, `"true"`, `"i--"`).
- **Switch to `set` when `sub` gets long.** If `find` would be more than ~half the line, or the replacement would restate most of the line, use `set` instead.
- `set: []` deletes the anchored line. `set:[""]` preserves a blank line.
- Within a single request you may submit edits in any order — the runtime applies them bottom-up so they don't shift each other. After any request that mutates a file, anchors below the mutation are stale on disk; re-read before issuing more edits to that file.
- `set`/`sub`/delete target the current file content only. Do not try to reference old line text after the file has changed.
- Text content must be literal file content with matching indentation. If the file uses tabs, use real tabs.
- You **MUST NOT** use this tool to reformat or clean up unrelated code.
</critical>
