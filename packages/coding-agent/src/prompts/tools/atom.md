Applies precise file edits using anchors (line+hash).

<ops>
Each call **MUST** have shape `{path:"a.ts",edits:[…]}`. `path` is the default file; you **MAY** override it per edit with `loc:"b.ts:160sr"`.
Each edit **MUST** have exactly one `loc` and **MUST** include one or more verbs.

# Locators
- `"A"` targets one anchored line. `"$"` targets the whole file: `pre` = BOF, `post` = EOF, `sed` = every line.
- Bracketed locators are **`splice` only** and select a balanced region around anchor `A`.
- `"(A)"` = block body. `"[A]"` = whole block/node.
- `"[A"` / `"(A"` = tail after/including anchor, closer excluded.
- `"A]"` / `"A)"` = head through/before anchor, opener excluded.
- Anchor bracketed forms on a body line of the intended block, not the opener line.
- Do not use bracketed locators on files that do not currently parse.

# Verbs
- `splice:[…]` replaces the anchored line, or the bracketed region. `[]` deletes; `[""]` makes a blank line.
- `pre:[…]` inserts before the anchor, or BOF with `loc:"$"`.
- `post:[…]` inserts after the anchor, or EOF with `loc:"$"`.
</ops>

<splice>
Replaces the anchored line, or the bracketed region.
- `[]` deletes. `[""]` leaves a blank line.
- For bracketed `splice`, write body at column 0, it will be re-indented.
- Do not use bracketed `splice` on broken files, or for single line edits.
</splice>

<sed>
Use for tiny inline edits: names, operators, literals.
- Keep `pat` as short as possible, it does not have to be unique.
- `g:false` by default; set to replace all instead of first.
</sed>

<examples>
```ts title="a.ts"
{{hline 1 "const FALLBACK = \"guest\";"}}
{{hline 2 ""}}
{{hline 3 "export function label(name) {"}}
{{hline 4 "\tconst clean = name || FALLBACK;"}}
{{hline 5 "\treturn clean.trim().toLowerCase();"}}
{{hline 6 "}"}}
```

# Single-line replacement:
`{path:"a.ts",edits:[{loc:{{href 1 "const FALLBACK = \"guest\";"}},splice:["const FALLBACK = \"anonymous\";"]}]}`
# Small token edit: prefer `sed`:
`{path:"a.ts",edits:[{loc:{{href 5 "\treturn clean.trim().toLowerCase();"}},sed:{pat:"toLowerCase",rep:"toUpperCase"}}]}`
# Insert before / after an anchor:
`{path:"a.ts",edits:[{loc:{{href 5 "\treturn clean.trim().toLowerCase();"}},pre:["\tif (!clean) return FALLBACK;"],post:["\t// normalized label"]}]}`
# Delete a line vs make it blank:
`{path:"a.ts",edits:[{loc:{{href 2 ""}},splice:[]}]}`
`{path:"a.ts",edits:[{loc:{{href 2 ""}},splice:[""]}]}`
# File edges:
`{path:"a.ts",edits:[{loc:"$",pre:["// Copyright (c) 2026",""]}]}`
`{path:"a.ts",edits:[{loc:"$",post:["","export { FALLBACK };"]}]}`
# Cross-file override:
`{path:"a.ts",edits:[{loc:{{href 1 "const FALLBACK = \"guest\";" "config.ts:" ""}},splice:["const FALLBACK = \"anonymous\";"]}]}`
# Body replacement: use bracketed `splice`, write body at column 0:
`{path:"a.ts",edits:[{loc:{{href 4 "\tconst clean = name || FALLBACK;" "(" ")"}},splice:["if (name == null) return FALLBACK;","const clean = String(name).trim();","return clean || FALLBACK;"]}]}`
# Whole function replacement: anchor on a body line:
`{path:"a.ts",edits:[{loc:{{href 5 "\treturn clean.trim().toLowerCase();" "[" "]"}},splice:["export function label(name) {","\treturn String(name ?? FALLBACK).trim().toLowerCase();","}"]}]}`
# WRONG: bare-anchor `splice` does not own neighboring lines:
`{path:"a.ts",edits:[{loc:{{href 4 "\tconst clean = name || FALLBACK;"}},splice:["\tconst clean = String(name ?? FALLBACK).trim();","\treturn clean.toLowerCase();"]}]}`
This replaces only line 4. Original line 5 still shifts down, so the function now has two returns.
# RIGHT: use a body edit for that rewrite:
`{path:"a.ts",edits:[{loc:{{href 4 "\tconst clean = name || FALLBACK;" "(" ")"}},splice:["const clean = String(name ?? FALLBACK).trim();","return clean.toLowerCase();"]}]}`
</examples>

<critical>
- You **MUST** copy full anchors exactly from a read op (e.g. `160sr`); you **MUST NOT** send only the 2-letter suffix.
- You **MUST** make the minimum exact edit; you **MUST NOT** reformat unrelated code.
- A bare anchor **MUST** target one line only; you **MUST** use bracketed `splice` for balanced block rewrites.
- You **MUST NOT** include unchanged adjacent lines in `splice`/`pre`/`post`; they shift and duplicate.
- For bracketed `splice`, replacement braces **MUST** be balanced for the selected region.
</critical>
