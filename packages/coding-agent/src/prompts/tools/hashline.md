Applies precise file edits using anchor-prefixed line references (e.g. `123th`) from `read` output.

Read the file first. Copy anchors exactly from the latest `read` output. After any successful edit, re-read before editing that file again.

<operations>
**Top level**
- `edits` — array of edit entries
- `path` (optional) — default file path used when an entry omits its own `path`. Lets you share the path across many edits in one request.

**Edit entry**: `{ path?, loc, content }`
- `path` — file path (omit to fall back to the request-level `path`)
- `loc` — where to apply the edit (see below)
- `content` — replacement/inserted lines (array of strings preferred, `null` to delete)

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
`{edits:[{path:"a.ts",loc:{range:{pos:{{href 15 "\t\tconsole.error(err);"}},end:{{href 16 "\t\treturn null;"}}}},content:["\t\tif (isEnoent(err)) return null;","\t\tthrow err;"]}]}`
# Replace whole block including closing brace
Replace `alpha`'s entire body including the closing `}`. `end` **MUST** be {{href 7 "}"}} because `content` includes `}`.
`{edits:[{path:"a.ts",loc:{range:{pos:{{href 6 "\tlog();"}},end:{{href 7 "}"}}}},content:["\tvalidate();","\tlog();","}"]}]}`
**Wrong**: `end: {{href 6 "\tlog();"}}` — line 7 (`}`) survives AND content emits `}`, producing two closing braces.
# Replace one line
Single-line replace uses `pos == end`.
`{edits:[{path:"a.ts",loc:{range:{pos:{{href 2 "const timeout = 5000;"}},end:{{href 2 "const timeout = 5000;"}}}},content:["const timeout = 30_000;"]}]}`
# Delete a range
`{edits:[{path:"a.ts",loc:{range:{pos:{{href 10 "\t// TODO: remove after migration"}},end:{{href 11 "\tlegacy();"}}}},content:null}]}`
# Insert before a sibling
When adding a sibling declaration, prefer `prepend` on the next declaration.
`{edits:[{path:"a.ts",loc:{prepend:{{href 9 "function beta() {"}}},content:["function gamma() {","\tvalidate();","}",""]}]}`
</examples>

<critical>
- Make the minimum exact edit.
- Copy anchors exactly from `read/grep`.
- `range` requires both `pos` and `end`.
- **Closing-delimiter check**: when your replacement `content` ends with a closing delimiter (`}`, `*/`, `)`, `]`), compare it against the line immediately after `end` in the file. If they match, extend `end` to include that line — otherwise the original delimiter survives and `content` adds a second copy.
- For a range, replace only the body or the whole range — don't split range boundaries.
- `content` must be literal file content with matching indentation. If the file uses tabs, use real tabs.
- You **MUST NOT** use this tool to reformat or clean up unrelated code — use project-specific linters or code formatters instead.
</critical>
