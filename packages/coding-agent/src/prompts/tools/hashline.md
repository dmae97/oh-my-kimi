Applies precise file edits using full anchors from `read` output (for example `160sr`).

Read the file first. Copy the full anchors exactly as shown by `read`.

<operations>
**Top level**
- `edits` — array of edit entries
- `path` (required) — file path for all edits in this request

**Edit entry**: `{ loc, content }`
- `loc` — where to apply the edit (see below)
- `content` — replacement/inserted lines (`string[]`, one element per line; `null` to delete)

**`loc` values**
- `"append"` / `"prepend"` — insert at end/start of file
- `{ append: "123th" }` / `{ prepend: "123th" }` — insert after/before anchored line
- `{ range: { pos: "123th", end: "123th" } }` — replace inclusive range `pos..end` with new content (set `pos == end` for single-line replace)
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

# Replace a block body
Replace only the catch body. Do not target the shared boundary line `} catch (err) {`.
`{path:"a.ts",edits:[{loc:{range:{pos:{{href 15}},end:{{href 16}}}},content:["\t\tif (isEnoent(err)) return null;","\t\tthrow err;"]}]}`
# Replace whole block including closing brace
Replace `alpha`'s entire body including the closing `}`. `end` **MUST** be {{href 7}} because `content` includes `}`.
`{path:"a.ts",edits:[{loc:{range:{pos:{{href 6}},end:{{href 7}}}},content:["\tvalidate();","\tlog();","}"]}]}`
**Wrong**: `end: {{href 6}}` — line 7 (`}`) survives AND content emits `}`, producing two closing braces.
# Replace one line
Single-line replace uses `pos == end`.
`{path:"a.ts",edits:[{loc:{range:{pos:{{href 2}},end:{{href 2}}}},content:["const timeout = 30_000;"]}]}`
# Delete a range
`{path:"a.ts",edits:[{loc:{range:{pos:{{href 10}},end:{{href 11}}}},content:null}]}`
# Insert before a sibling
When adding a sibling declaration, prefer `prepend` on the next declaration.
`{path:"a.ts",edits:[{loc:{prepend:{{href 9}}},content:["function gamma() {","\tvalidate();","}",""]}]}`
</examples>

<critical>
- Make the minimum exact edit.
- Copy the full anchors exactly as shown by `read/search` (for example `160sr`, not just `sr`).
- `range` requires both `pos` and `end`.
- **Closing-delimiter check**: when your replacement `content` ends with a closing delimiter (`}`, `*/`, `)`, `]`), compare it against the line immediately after `end` in the file. If they match, extend `end` to include that line — otherwise the original delimiter survives and `content` adds a second copy.
- For a range, replace only the body or the whole range — don't split range boundaries.
- `content` must be literal file content with matching indentation. If the file uses tabs, use real tabs.
- You **MUST NOT** use this tool to reformat or clean up unrelated code — use project-specific linters or code formatters instead.
</critical>
