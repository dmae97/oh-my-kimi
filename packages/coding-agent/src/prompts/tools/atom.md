Applies precise file edits using anchors (line+hash).

<ops>
Each call **MUST** have shape `{path:"a.ts",edits:[…]}`. `path` is the default file; you **MAY** override it per edit with `loc:"b.ts:160sr"`.
Each edit **MUST** have exactly one `loc` and **MUST** include one or more verbs.

# Locators
- `"A"` targets one anchored line (line number + 2-letter suffix, e.g. `160sr`).
- `"$"` targets the whole file: `pre` = BOF, `post` = EOF, `replace` = every line.
-
# Verbs
- `splice:[…]` replaces the anchored line. `[]` deletes; `[""]` makes a blank line. To replace N lines, anchor the first line and list all replacement lines.
- `pre:[…]` inserts before the anchor, or BOF with `loc:"$"`.
- `post:[…]` inserts after the anchor, or EOF with `loc:"$"`.
- `replace:{find,with,all?}` is a literal substring substitution on the anchored line (or every line with `loc:"$"`). No regex — `find` matches as a literal string. `all:true` replaces every occurrence on the line; default replaces only the first.
</ops>

<replace>
Use for tiny inline edits: names, operators, literals.
- `find` is a literal substring; do **NOT** escape regex metacharacters — `(`, `)`, `.`, `?`, `[`, `]`, `*`, `+` all match themselves.
- Keep `find` as short as possible while still being unique on the line; it does **NOT** have to be unique across the file.
- `all:false` by default; set `all:true` to replace every occurrence on the line instead of only the first.
</replace>

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
# Small token edit: prefer `replace`:
`{path:"a.ts",edits:[{loc:{{href 5 "\treturn clean.trim().toLowerCase();"}},replace:{find:"toLowerCase",with:"toUpperCase"}}]}`
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
# Replace several consecutive lines: anchor the first line and list all replacement lines in `splice`.
`{path:"a.ts",edits:[{loc:{{href 4 "\tconst clean = name || FALLBACK;"}},splice:["\tconst clean = String(name ?? FALLBACK).trim();","\treturn clean.toLowerCase();","}"]}]}`
This anchors line 4 and replaces lines 4-6 of the original function body in one splice. The anchor's hash protects against the file having shifted under you.
# WRONG: bare-anchor `splice` only owns the anchored line. If you list 2 replacement lines, you replace 1 line with 2 — the original line 5 still shifts down.
`{path:"a.ts",edits:[{loc:{{href 4 "\tconst clean = name || FALLBACK;"}},splice:["\tconst clean = String(name ?? FALLBACK).trim();","\treturn clean.toLowerCase();"]}]}`
This produces a function with two `return` statements. To replace lines 4 and 5 together, include the original line 6 (`}`) so the splice covers all the lines you intend to replace.
</examples>

<critical>
- You **MUST** copy full anchors exactly from a read op (e.g. `160sr`); you **MUST NOT** send only the 2-letter suffix.
- You **MUST** make the minimum exact edit; you **MUST NOT** reformat unrelated code.
- A bare anchor owns exactly one line. To replace N lines, anchor the first one and list all N replacement lines in `splice`.
- You **MUST NOT** include unchanged adjacent lines in `splice`/`pre`/`post`; they shift and duplicate.
</critical>
