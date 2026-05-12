Run code in a persistent kernel using codeblock cells.

<instruction>
Each cell is wrapped between `*** Begin <LANG>` and `*** End <LANG>`:

```
*** Begin PY
*** Title: optional title
*** Timeout: 10s
*** Reset
print("hi")
*** End PY
```

- **Language**: {{#if py}}`PY` for Python{{/if}}{{#ifAll py js}}, {{/ifAll}}{{#if js}}`JS` / `TS` for JavaScript{{/if}}. The opening `<LANG>` and closing `<LANG>` **MUST** match.
- **Attributes** (optional, in any order, immediately after `*** Begin`):
  - `*** Title: …` — cell title shown in the UI.
  - `*** Timeout: <duration>` — per-cell timeout. Digits with optional `ms` / `s` / `m` units (e.g. `500ms`, `15s`, `2m`). Default 30s.
  - `*** Reset` — wipe this cell's own language kernel before running.{{#ifAll py js}} Other languages are untouched.{{/ifAll}}
- Anything between the last attribute and `*** End <LANG>` is the cell's code, verbatim.
- Stack multiple cells back-to-back; blank lines between cells are ignored.

**Work incrementally:**
- One logical step per cell (imports, define, test, use).
- Pass multiple small cells in one call.
- Define small reusable functions for individual debugging.
- Put workflow explanations in the assistant message or cell title — never inside cell code.
{{#if py}}- Python cells run inside an IPython kernel with a live event loop. Use top-level `await` directly (e.g. `await main()`); `asyncio.run(…)` raises "cannot be called from a running event loop".{{/if}}
**On failure:** errors identify the failing cell (e.g., "Cell 3 failed"). Resubmit only the fixed cell (or fixed cell + remaining cells).
</instruction>

<prelude>
{{#ifAll py js}}Same helpers in both runtimes with the same positional argument order. Python: trailing options as keyword args. JavaScript: trailing options as a trailing object literal. JavaScript helpers are async and `await`able; Python helpers run synchronously.{{else}}{{#if py}}Helpers run synchronously. Trailing options are keyword arguments.{{/if}}{{#if js}}Helpers are async and `await`able. Trailing options are a final object literal.{{/if}}{{/ifAll}}
```
display(value) → None
    Render a value in the current cell output.
print(value, ...) → None
    Print to the cell's text output.
read(path, offset?=1, limit?=None) → str
    Read file contents as text. offset/limit are 1-indexed line bounds.
write(path, content) → str
    Write content to a file (creates parent directories). Returns the resolved path.
append(path, content) → str
    Append content to a file. Returns the resolved path.
tree(path?=".", max_depth?=3, show_hidden?=False) → str
    Render a directory tree.
diff(a, b) → str
    Unified diff between two files.
env(key?=None, value?=None) → str | None | dict
    No args → full environment as dict. One arg → value of `key`. Two args → set `key=value` and return value.
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
    Read task/agent output by ID. Single id returns text/dict; multiple ids return a list.
```

{{#if js}}**JavaScript only:** `tool.<name>(args)` invokes any session tool directly (e.g. `await tool.read({ path: "src/foo.ts" })`).
{{/if}}</prelude>

<output>
Cells render like a Jupyter notebook. `display(value)` renders non-presentable data as an interactive JSON tree. Presentable values (figures, images, dataframes, etc.) use their native representation.
</output>

<caution>
- In session mode, use `*** Reset` on a cell to wipe its language's kernel before running.{{#ifAll py js}} Reset is per-language: a python cell's `*** Reset` does not touch the JavaScript kernel and vice versa.{{/ifAll}}
{{#if js}}- **js**: the VM exposes a selective `process` subset, Web APIs, `Buffer`, `fs/promises`, and the `Bun` global.
{{/if}}</caution>

<example>
{{#if py}}*** Begin PY
*** Title: imports
*** Timeout: 10s
import json
from pathlib import Path
*** End PY

*** Begin PY
*** Title: load config
data = json.loads(read('package.json'))
display(data)
*** End PY
{{/if}}{{#ifAll py js}}
{{/ifAll}}{{#if js}}*** Begin JS
*** Title: js summary
*** Reset
const data = JSON.parse(await read('package.json'));
display(data);
return data.name;
*** End JS
{{/if}}
</example>
