Applies precise file edits using single-point `LINE#ID` anchors from `read` output.

Each op references **exactly one** anchor — there are no ranges, no two-endpoint addresses. To replace many lines, issue many ops.

Read the file first. Copy anchors exactly from the latest `read` output. After any successful edit, re-read before editing that file again.

<operations>
**Top level**
- `edits` — array of edit entries. Each entry is exactly one op.
- `path` (optional) — default file path used when an edit omits its own `path`. Lets you share the path across many edits in one request.

`{ path?, … }` — one of the following ops:
- `set: "55#th", lines: […]` — replace one anchored line with one or more lines
- `before: "55#th", lines: […]` — insert lines above the anchored line
- `after:  "55#th", lines: […]` — insert lines below the anchored line
- `del: "55#th"` — delete one anchored line
- `sub: "55#th", find: "…", lines: …` — replace a unique substring on the anchored line
- `ins: "55#th", find: "…", lines: "…"` — overwrite from the start of `find` to **end-of-line** with `lines`. Everything on the anchored line after (and including) `find` is **discarded**. If you want to preserve trailing content, use `sub` instead.
- `append: […]` — append at end of file
- `prepend: …` — prepend at start of file

**Minimum content rule for `sub` and `ins`**: `find` must occur exactly once on the anchored line. Use the **shortest** unique fragment — not the whole line. The replacement `lines` should also be the smallest change that does the job. Restating large amounts of unchanged text is wasted output and increases the chance of stale-line conflicts.

**File-scoped ops**

**Path resolution**: each entry uses its own `path` if present, otherwise falls back to the request-level `path`. Provide one or the other; if neither is set, the edit is rejected.
</operations>

<examples>
All examples below reference the same file:

```ts title="a.ts"
{{hline  1 "// @ts-ignore"}}
{{hline  2 "const timeout = 5000;"}}
{{hline  3 "const tag = \"DO NOT SHIP\";"}}
{{hline  4 ""}}
{{hline  5 "function alpha() {"}}
{{hline  6 "\tlog();"}}
{{hline  7 "}"}}
{{hline  8 ""}}
{{hline  9 "function beta() {"}}
{{hline 10 "\t// TODO: remove after migration"}}
{{hline 11 "\tlegacy();"}}
{{hline 12 "\ttry {"}}
{{hline 13 "\t\treturn parse(data);"}}
{{hline 14 "\t} catch (err) {"}}
{{hline 15 "\t\tconsole.error(err);"}}
{{hline 16 "\t\treturn null;"}}
{{hline 17 "\t}"}}
{{hline 18 "}"}}
```

# Replace one line
`{edits:[{path:"a.ts",set:{{href 2 "const timeout = 5000;"}},lines:"const timeout = 30_000;"}]}`
# Rewrite a single token (cheaper than `set`)
`sub` rewrites a substring without repeating the rest of the line.
`{edits:[{path:"a.ts",sub:{{href 2 "const timeout = 5000;"}},find:"5000",lines:"30_000"}]}`
# Truncate a line tail with `ins` (vim-insert)
Use `ins` when the change is “replace from this point onward.” Pick the shortest unique anchor.
Original line 3: `const tag = "DO NOT SHIP";`
`{edits:[{path:"a.ts",ins:{{href 3 "const tag = \"DO NOT SHIP\";"}},find:"DO",lines:"OK\";"}]}`
Result: `const tag = "OK";`. `find:"DO"` positions the cursor at `D`; everything from there to end-of-line is replaced by `lines`.
# Replace a multi-line block (issue one op per line)
Replace the catch body. One `set` per line — no range, no boundary confusion. Lift `path` to the top level when all entries target the same file:
`{path:"a.ts",edits:[{set:{{href 15 "\t\tconsole.error(err);"}},lines:"\t\tif (isEnoent(err)) return null;"},{set:{{href 16 "\t\treturn null;"}},lines:"\t\tthrow err;"}]}`
Or per-entry `path` (use when edits span multiple files):
`{edits:[{path:"a.ts",set:{{href 15 "\t\tconsole.error(err);"}},lines:"\t\tif (isEnoent(err)) return null;"},{path:"b.ts",set:{{href 16 "\t\treturn null;"}},lines:"\t\tthrow err;"}]}`
# Delete adjacent lines (issue one `del` per line)
`{path:"a.ts",edits:[{del:{{href 10 "\t// TODO: remove after migration"}}},{del:{{href 11 "\tlegacy();"}}}]}`
# Insert before a sibling
`{edits:[{path:"a.ts",before:{{href 9 "function beta() {"}},lines:["function gamma() {","\tvalidate();","}",""]}]}`
# Insert after a line
`{edits:[{path:"a.ts",after:{{href 6 "\tlog();"}},lines:["\tvalidate();"]}]}`
# Expand one line into many
`set` accepts an array.
`{edits:[{path:"a.ts",set:{{href 6 "\tlog();"}},lines:["\tvalidate();","\tlog();","\tcleanup();"]}]}`
</examples>

<critical>
- Make the minimum exact edit. Do not rewrite nearby code unless the op requires it.
- Each entry in `edits` is exactly one op. Never combine multiple ops in a single entry.
- Copy anchors exactly as `N#ID` from the latest `read` output. Anchors validate the file hasn't changed since you read it; mismatches reject all ops in the request.
- After **any** edit that changes line count (insert, multi-line `set`, `del`), all anchors below the change are stale. Re-read the file before issuing more edits to the same file. To reduce re-reads, batch edits in a single request and order them **bottom-up** so earlier edits don't shift later anchors.
- For `sub`, the `find` substring must occur **exactly once** on the anchored line. If it could match more than once, use a longer substring or use `set` instead.
- At most one of `set`/`del`/`sub` may target any single anchor line. `before`/`after` may coexist with them.
- `lines` content must be literal file content with matching indentation. If the file uses tabs, use real tabs.
- You **MUST NOT** use this tool to reformat or clean up unrelated code — use project-specific linters or code formatters instead.
</critical>
