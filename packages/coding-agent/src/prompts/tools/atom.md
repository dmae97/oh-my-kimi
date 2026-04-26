Applies precise file edits using full anchors from `read` output (for example `160sr`).

Read the file first. Copy the full anchors exactly as shown by `read`.

<operations>
**Top level**: `{ path, edits: […] }` — `path` is shared by all entries. You may still override the file inside `loc` with forms like `other.ts:160sr`.

Each entry has one shared locator plus one or more verbs:
- `loc: "160sr"` — single anchored line
- `loc: "$"` — whole file: `pre` prepends, `post` appends, `sed` substitutes across every line
- `loc: "a.ts:160sr"` — cross-file override inside the locator

Verbs:
- `splice: […]`: lines are spliced in at the anchor.
- `pre: […]`: prepend before the anchor (or at BOF if `loc=$`)
- `post: […]`: append after the anchor (or at EOF if `loc=$`)
- `sed: { pat, rep, g?, F?, i? }` — structured find/replace on the anchor line. **Prefer this over `splice` for token-level changes**
  - `pat`: pattern to find (regex by default)
  - `rep`: replacement (regex back-refs like `$1`, `$&` available)
  - `g`: global — replace every occurrence (default `true`; pass `false` for first-only)
  - `F`: literal — treat `pat` as a literal substring (no regex). Use this whenever `pat` contains `||`, `.`, `(`, `?`, `\`, etc. you mean literally.
  - `i`: ignore case
You **MUST** keep `pat` as short as possible.

Combination rules:
- On a single-anchor `loc`, you may combine `pre`, `splice`, and `post` in the same entry.
- `splice: []` on a single-anchor `loc` deletes that line.
- `splice:[""]` is **not** delete — it replaces the line with a blank line.
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

# Replace a line with `splice`
`{path:"a.ts",edits:[{loc:{{href 1 "const tag = \"BAD\";"}},splice:["const tag = \"OK\";"]}]}`

# Combine `pre` + `splice` + `post` in one entry
`{path:"a.ts",edits:[{loc:{{href 4 "\tif (x) {"}},pre:["\tvalidate();"],splice:["\tif (!x) {"],post:["\t\tlog();"]}]}`

# Delete a line with `splice: []`
`{path:"a.ts",edits:[{loc:{{href 7 "\treturn null;"}},splice:[]}]}`

# Preserve a blank line with `splice:[""]`
`{path:"a.ts",edits:[{loc:{{href 2 ""}},splice:[""]}]}`

# Insert before / after a line
`{path:"a.ts",edits:[{loc:{{href 3 "function beta(x) {"}},pre:["function gamma() {","\tvalidate();","}",""]}]}`

# Substitute one token with `sed` (regex) — preferred for token-level edits
Use the smallest `pat` that uniquely identifies the change.
`{path:"a.ts",edits:[{loc:{{href 5 "\t\treturn parse(data) || fallback;"}},sed:{pat:"\\|\\|",rep:"??"}}]}`

# Substitute literal text — set `F:true` so `pat` is not parsed as regex
`{path:"a.ts",edits:[{loc:{{href 5 "\t\treturn parse(data) || fallback;"}},sed:{pat:"data",rep:"input",F:true}}]}`

# Comment out a line by capturing the whole content with a regex
Use `$&` (the entire match) inside `rep` to keep the original text and prepend `// `.
`{path:"a.ts",edits:[{loc:{{href 7 "\treturn null;"}},sed:{pat:".+",rep:"// $&"}}]}`

# Prepend / append at file edges
`{path:"a.ts",edits:[{loc:"$",pre:["// Copyright (c) 2026",""]}]}`
`{path:"a.ts",edits:[{loc:"$",post:["","export const VERSION = \"1.0.0\";"]}]}`

# Cross-file override inside `loc`
`{path:"a.ts",edits:[{loc:"b.ts:{{href 1 "const tag = \"BAD\";"}}",splice:["const tag = \"OK\";"]}]}`

# WRONG: retyping unchanged neighbors inside `splice` duplicates them
`{path:"a.ts",edits:[{loc:{{href 4 "\tif (x) {"}},splice:["\tif (x && ready) {","\t\treturn parse(data) ?? fallback;","\t\t//unreachable"]}]}`
The 2nd array element matches existing line 5, which is **not** overwritten, it shifts, so return statement ends up duplicated.

# RIGHT: split into separate edits
- `{path:"a.ts",edits:[{loc:{{href 4 "\tif (x) {"}},sed:{pat:"x",rep:"x && ready",g:false}},{loc:{{href 5 "\t\treturn parse(data) ?? fallback;"}},post:["\t\t//unreachable"]}]}`
OR
- `{path:"a.ts",edits:[{loc:{{href 4 "\tif (x) {"}},splice:["\tif (x && ready) {"]},{loc:{{href 5 "\t\treturn parse(data) ?? fallback;"}},splice:["\t\treturn parse(data) ?? fallback;","\t\t//unreachable"]}]}`
</examples>

<critical>
- Make the minimum exact edit.
- Copy the full anchors exactly as shown by `read/grep` (for example `160sr`, not just `sr`).
- `loc` chooses the target. Verbs describe what to do there.
- On a single-anchor `loc`, you may combine `pre`, `splice`, and `post`.
- `loc:"$"` operates on the whole file: `pre` prepends, `post` appends, `sed` runs across every line.
- `splice: []` deletes the anchored line. `splice:[""]` preserves a blank line.
- Within a single request you may submit edits in any order — the runtime applies them bottom-up so they don't shift each other. After any request that mutates a file, anchors below the mutation are stale on disk; re-read before issuing more edits to that file.
- `splice` operations target the current file content only. Do not try to reference old line text after the file has changed.
- For **small** in-line edits (renaming a token, flipping an operator, tweaking a literal), prefer `sed` over `splice`. The `loc` anchor already pins the line — repeating the entire line in a `splice` array invites hallucinated content. Use the smallest `pat` that uniquely identifies the change on that line; do not pad it with surrounding text just to feel safe. When `pat` contains regex metacharacters you mean literally (e.g. `||`, `.`, `(`, `?`, `\`), set `F:true` to disable regex. `g` is `true` by default — pass `g:false` for first-occurrence-only. For multi-line restructuring (wrapping logic, adding new branches, inserting blocks), use `splice`/`pre`/`post` — do **not** stretch `sed` into a rewrite tool.
- When you do use `splice`, re-read the anchored line first and copy it verbatim, changing only the required token(s). Anchor identity does not verify line content, so a hallucinated replacement will silently corrupt the file.
- Anchors are pin points, not region markers. One anchor pins exactly one line. If your change touches N distinct source lines, that is N edits with N anchors — not one big `splice` array intended to cover the whole region. `splice` cannot "replace lines 4 through 7"; it can only splice content in at one anchor.
- You **MUST NOT** include lines in `splice`/`pre`/`post` that already exist immediately adjacent to the anchor in the current file. `splice` does not overwrite the lines below — they shift down — so any neighbor you re-type in your array becomes a duplicate. If your intended replacement contains content that is already on neighboring source lines, split into multiple edits at each real change site instead of one fat `splice`.
- Before issuing a multi-line `splice`, mentally diff each array element against the current file lines at and just below the anchor. Any element that matches a line within ~5 lines of the anchor will become a duplicate after the splice. If you find a match, drop that element and use a separate edit (or `pre`/`post`) at the real change point.
- Text content must be literal file content with matching indentation. If the file uses tabs, use real tabs.
- You **MUST NOT** use this tool to reformat or clean up unrelated code.
</critical>
