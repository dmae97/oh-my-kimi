Applies precise file edits using `LINEID` anchors from `read` output.

Most ops reference **exactly one** anchor. The exception is `set: [openAnchor, closeAnchor]` (a 2-tuple), which addresses the lines **strictly between** two anchors that both **survive** the edit — use it for block-body replacement (e.g. "replace the body of this function, keep the braces").

Read the file first. Copy anchors exactly from the latest `read` output. After any successful edit, re-read before editing that file again.

<operations>
**Top level**: `{ path, edits: […] }` — `path` is shared by all entries. Per-entry `path` is also allowed and overrides the top-level value (use this for cross-file edits).

Each entry is exactly one op:
- `set:  "5th", lines: …` — replace one anchored line
- `set:  ["5aa", "9bb"], lines: …` — replace lines **strictly between** two anchors. Both anchor lines survive untouched. Use this for block bodies: first anchor is the opening line (e.g. `function foo() {`), second is the closing line (e.g. `}`). The braces stay; only the body is rewritten. **Never include the anchor lines in `lines`.**
- `pre:  "5th", lines: …` — insert lines above the anchored line. `pre: ""` inserts at **beginning of file**.
- `post: "5th", lines: …` — insert lines below the anchored line. `post: ""` inserts at **end of file**.
- `del:  "5th"` — delete one anchored line
- `sub:  "5th", find: "…", lines: "…"` — replace a unique substring on the anchored line. The line tail is **preserved** (trailing `;`, `,`, `) {`, etc. survive automatically). Use this for surgical edits like operator swaps, literal flips, identifier renames.

**`sub` rules of thumb**:
- `find` matches inside a **single line**. It can never contain a newline; `\n` will not match anything.
- Both `find` and `lines` should be the **smallest fragment that does the job** — ideally 1–4 chars (operator, literal, identifier). Long `find` is a code smell.
- If `find` would be longer than ~half the line, or you are restating most of the line in `lines`, **switch to `set`** and rewrite the whole line. `set` is cheaper than a long `sub` and never has uniqueness issues.
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

Hoist `path` to the top level whenever every entry targets the same file:

# Swap an operator with `sub` (cheapest edit, tail preserved)
Original line 4: `const fallback = group.targetFramework || 'All Frameworks';`. Change `||` to `??`. The trailing `'All Frameworks';` survives untouched:
`{path:"a.ts",edits:[{sub:{{href 4 "const fallback = group.targetFramework || 'All Frameworks';"}},find:"||",lines:"??"}]}`

# Flip a literal with `sub`
Original line 2: `const timeout = 5000;`. The trailing `;` survives:
`{path:"a.ts",edits:[{sub:{{href 2 "const timeout = 5000;"}},find:"5000",lines:"30_000"}]}`

# Negate a condition with `sub`
Original line 10: `\tif (x) {`. Inject the `!`:
`{path:"a.ts",edits:[{sub:{{href 10 "\tif (x) {"}},find:"(x)",lines:"(!x)"}]}`

# Replace one whole line with `set`
Use `set` when you're rewriting most of the line, or when `find` would not be unique. Restate the full line content:
`{path:"a.ts",edits:[{set:{{href 3 "const tag = \"DO NOT SHIP\";"}},lines:"const tag = \"OK\";"}]}`

# Replace a block body, keep the surrounding braces (preferred multi-line edit)
Anchors mark *survivors*. With `set: [open, close]` the two named lines are kept; lines strictly between them are replaced.
Replace the body of `alpha` (line 6) while keeping `function alpha() {` (5) and `}` (7):
`{path:"a.ts",edits:[{set:[{{href 5 "function alpha() {"}},{{href 7 "}"}}],lines:["\tvalidate();","\tlog();","\tcleanup();"]}]}`

# Replace multiple non-adjacent lines (one `set` per line)
`{path:"a.ts",edits:[{set:{{href 11 "\t\treturn parse(data);"}},lines:"\t\treturn parse(data) ?? fallback;"},{set:{{href 13 "\treturn null;"}},lines:"\treturn fallback;"}]}`

# Delete adjacent lines (one `del` per line)
`{path:"a.ts",edits:[{del:{{href 11 "\t\treturn parse(data);"}}},{del:{{href 12 "\t}"}}]}`

# Insert before / after a line
`{path:"a.ts",edits:[{pre:{{href 9 "function beta(x) {"}},lines:["function gamma() {","\tvalidate();","}",""]}]}`
`{path:"a.ts",edits:[{post:{{href 6 "\tlog();"}},lines:["\tvalidate();"]}]}`

# Append / prepend at file edges (`post: ""` / `pre: ""`)
`{path:"a.ts",edits:[{post:"",lines:["","export const VERSION = \"1.0.0\";"]}]}`
`{path:"a.ts",edits:[{pre:"",lines:["// Copyright (c) 2026",""]}]}`

# Cross-file edits (use per-entry `path` instead of hoisting)
`{edits:[{path:"a.ts",sub:{{href 2 "const timeout = 5000;"}},find:"5000",lines:"30_000"},{path:"b.ts",pre:"",lines:["// generated"]}]}`
</examples>

<critical>
- Make the minimum exact edit.
- Each entry in `edits` is exactly one op. Never combine multiple ops in a single entry.
- Copy anchors exactly from `read/grep`.
- Within a single request you may submit edits in any order — the runtime applies them bottom-up so they don't shift each other. After **any** request that mutates a file, anchors below the mutation are stale on disk; re-read before issuing more edits to that file.
- For `sub`, `find` must occur **exactly once on the anchored line**. The runtime rejects the edit if `find` is missing or non-unique.
- **Switch to `set` when `find` gets long.** If `find` would be more than ~half the line, or `lines` would restate most of the line, you are no longer making a surgical substring edit — use `set` to rewrite the whole line in one shot. This avoids both uniqueness ambiguity and wasted output tokens.
- At most one of `set`/`del`/`sub` may target any single anchor line. `pre`/`post` may coexist with them.
- For 2-tuple `set: [open, close]`: open's line < close's line, and **no other op in the same request may target a line strictly inside the region**. The two anchor lines themselves can still receive other ops (e.g. a `set` on the closing-brace line is fine — it is preserved by the tuple-form `set`).
- `lines` content must be literal file content with matching indentation. If the file uses tabs, use real tabs.
- You **MUST NOT** use this tool to reformat or clean up unrelated code — use project-specific linters or code formatters instead.
</critical>
