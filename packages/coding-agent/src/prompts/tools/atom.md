Applies precise file edits using full anchors from `read` output (for example `160sr`).

Read the file first. Copy the full anchors exactly as shown by `read`.

<operations>
**Top level**: `{ path, edits: […] }` — `path` is shared by all entries. You may still override the file inside `loc` with forms like `other.ts:160sr`.

Each entry has one shared locator plus one or more verbs:
- `loc: "160sr"` — single anchored line
- `loc: "$"` — whole file: `pre` prepends, `post` appends, `sed` substitutes across every line
- `loc: "a.ts:160sr"` — cross-file override inside the locator

Locator brackets (extend `splice` to a region instead of one line):

|`loc`|Replaces|
|---|---|
|`"5fy"`|line 5 only (verb runs on that line)|
|`"(5fy)"`|the enclosing block's body (between delimiters)|
|`"[5fy]"`|the enclosing block's whole node (delimiters included)|
|`"[5fy"`|from the anchor (incl.) through the closer-1|
|`"(5fy"`|from after the anchor through the closer-1|
|`"5fy]"`|from opener+1 through the anchor (incl.)|
|`"5fy)"`|from opener+1 through line before the anchor|

Bracket forms are **`splice` only**. `pre`, `post`, and `sed` are line-only and reject bracketed locators. The block delimiter (`{`, `(`, `[`) is auto-detected from the file extension.

Verbs:
- `splice: […]` — with a bare anchor: replace that line. With a bracketed locator: replace the addressed region. **Region body lines: write at column 0; the tool re-indents to match the destination.**
- `pre: […]` — prepend before the anchor (or at BOF if `loc="$"`). Line-only — reject on bracketed `loc`.
- `post: […]` — append after the anchor (or at EOF if `loc="$"`). Line-only — reject on bracketed `loc`.
- `sed: { pat, rep, g?, F? }` — structured find/replace on the anchor line. **Prefer this over `splice` for token-level changes**
  - `pat`: pattern to find (regex by default)
  - `rep`: replacement (regex back-refs like `$1`, `$&` available)
  - `g`: global — replace every occurrence (default `false`; pass `true` to replace all)
  - `F`: literal — treat `pat` as a literal substring (no regex). Use this whenever `pat` contains `||`, `.`, `(`, `?`, `\`, etc. you mean literally.
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

# Replace the body of the enclosing block (anchor on a body line)
`{path:"a.ts",edits:[{loc:{{href 5 "\t\treturn parse(data) || fallback;" "(" ")"}},splice:["return parse(data) ?? fallback;"]}]}`

# Replace the whole block including its signature
`{path:"a.ts",edits:[{loc:{{href 3 "function beta(x) {" "[" "]"}},splice:["function beta(x) {","\treturn x;","}"]}]}`

# Replace the tail of a body (from anchor through closer)
`{path:"a.ts",edits:[{loc:{{href 5 "\t\treturn parse(data) || fallback;" "[" ""}},splice:["return fallback;"]}]}`

# Replace the head of a body (from opener through anchor)
`{path:"a.ts",edits:[{loc:{{href 5 "\t\treturn parse(data) || fallback;" "" "]"}},splice:["validate();","prepare();"]}]}`
</examples>

# Counter-example: this is the failure a bracketed locator prevents
An agent uses `splice` to overwrite a region:
`{path:"a.ts",edits:[{loc:{{href 4 "\tif (x) {"}},splice:["\tif (!ready(x)) {","\t\treturn null;","\t}","\treturn parse(data) ?? fallback;","}"]}]}`
The trailing `}` in the array becomes a duplicate of the original line 8 closer, leaving a stray `}}` mid-function. Use a bracketed locator instead so the tool owns the exact block region: `loc:{{href 4 "\tif (x) {" "(" ")"}}` (body) or `loc:{{href 4 "\tif (x) {" "[" "]"}}` (whole block).

<critical>
- Make the minimum exact edit.
- Copy the full anchors exactly as shown by `read/grep` (for example `160sr`, not just `sr`).
- `loc` chooses the target. Verbs describe what to do there.
- Brackets in `loc` are **`splice` only** — they extend the verb to a region. `"(A)"` = body, `"[A]"` = whole node, `"[A"` / `"A]"` / `"(A"` / `"A)"` = half-region with anchor inclusivity per the bracket. `pre`/`post`/`sed` reject bracketed locators.
- On a single-anchor `loc`, you may combine `pre`, `splice`, and `post`.
- `loc:"$"` operates on the whole file: `pre` prepends, `post` appends, `sed` runs across every line.
- `splice: []` deletes the anchored line. `splice:[""]` preserves a blank line.
- Within a single request you may submit edits in any order — the runtime applies them bottom-up so they don't shift each other. After any request that mutates a file, anchors below the mutation are stale on disk; re-read before issuing more edits to that file.
- `splice` operations target the current file content only. Do not try to reference old line text after the file has changed.
- For **small** in-line edits (renaming a token, flipping an operator, tweaking a literal), prefer `sed` over `splice`. The `loc` anchor already pins the line — repeating the entire line in a `splice` array invites hallucinated content. Use the smallest `pat` that uniquely identifies the change on that line; do not pad it with surrounding text just to feel safe. When `pat` contains regex metacharacters you mean literally (e.g. `||`, `.`, `(`, `?`, `\`), set `F:true` to disable regex. `g` is `false` by default — pass `g:true` to replace every occurrence. For multi-line restructuring (wrapping logic, adding new branches, inserting blocks), use `splice`/`pre`/`post` — do **not** stretch `sed` into a rewrite tool.
- When you do use `splice`, re-read the anchored line first and copy it verbatim, changing only the required token(s). Anchor identity does not verify line content, so a hallucinated replacement will silently corrupt the file.
- Anchors are pin points, not region markers. One anchor pins exactly one line. If your change touches N distinct source lines, that is N edits with N anchors — not one big `splice` array intended to cover the whole region. `splice` cannot "replace lines 4 through 7"; it can only splice content in at one anchor.
- For replacing an entire balanced block (e.g. an `if`/`for`/function body), prefer a bracketed `splice` locator (`"(A)"` body, `"[A]"` whole node) over a multi-line `splice` on a bare anchor. The bracketed form owns the exact region so you cannot accidentally duplicate the closing brace, and you write the body at column 0 (the tool re-indents to match the destination).
- `[A]` (whole node) replaces the **whole opener line** through the **whole closer line**, including trailing tokens after `}` like `));` from chained `Arc::new(…)` calls. Write your body to include the equivalent closing pattern. Do **not** leave trailing chained-call closers in your body expecting them to survive — they get duplicated against whatever your body ends with.
- Do **not** use bracketed `splice` on a file that does not currently parse. The brace matcher pairs whatever balances in the byte stream; on a corrupted file the chosen region is rarely the one you intended. Fix structural breaks with line-level `splice` first; switch to bracket forms only after the file parses.
- Anchor bracket forms on a **body line** of the block, not on the line containing the opener `{`. Anchoring on the opener line works (line containment) but the chosen block is often not the one you meant — the inner-most `{` block whose opener is on or after that line might be a tiny same-line literal you didn't intend.
- After a bracketed `splice` that touched more than ~5 lines, re-read the file before issuing the next edit on it. Line numbers shifted; downstream anchors are stale and `sed`/`splice` cascading on stale anchors compounds corruption.
- Bracketed `splice` re-indents your body to the destination. **Write the body at column 0 (or with a single consistent indent step). Never mix three-space hybrids with the file's tabs/four-space style** — the re-indenter assumes one consistent step and will silently produce broken indentation otherwise.
- You **MUST NOT** include lines in `splice`/`pre`/`post` that already exist immediately adjacent to the anchor in the current file. `splice` does not overwrite the lines below — they shift down — so any neighbor you re-type in your array becomes a duplicate. If your intended replacement contains content that is already on neighboring source lines, split into multiple edits at each real change site instead of one fat `splice`.
- Before issuing a multi-line `splice`, mentally diff each array element against the current file lines at and just below the anchor. Any element that matches a line within ~5 lines of the anchor will become a duplicate after the splice. If you find a match, drop that element and use a separate edit (or `pre`/`post`) at the real change point.
- Text content must be literal file content with matching indentation. If the file uses tabs, use real tabs.
- You **MUST NOT** use this tool to reformat or clean up unrelated code.
</critical>
