Run code in a persistent kernel, using a series of codeblocks acting as cells.

<instruction>
Each cell is a markdown fenced code block. The opening fence's info string carries metadata:

```
<lang>? <duration>? (title-fragment | key=value)*
```
- **Language**: {{#if py}}`py`/`python` for Python{{/if}}{{#ifAll py js}}, {{/ifAll}}{{#if js}}`js`/`javascript`/`ts`/`typescript` for JavaScript{{/if}}.{{#ifAll py js}} Omitted → inherit the previous cell's language (the first cell defaults to Python, falling back to JavaScript when Python is unavailable).{{else}} Omitted → inherit the previous cell's language.{{/ifAll}}
- **Positional duration**: `15s`, `500ms`, `2m`, or a bare integer (seconds). Default 30s.
- **Attributes**:
  - `id="…"` — cell id (shown as the title in the transcript).
  - `t=<duration>` — overrides the positional duration.
  - `rst=true` — wipe **this cell's own language kernel** before running.{{#ifAll py js}} Other languages are untouched.{{/ifAll}}

**Work incrementally:** one logical step per cell (imports, define, test, use). Pass multiple small cells in one call. Define small reusable functions you can debug individually. You **MUST** put workflow explanations in the assistant message or cell title — never inside cell code.

**On failure:** errors identify the failing cell (e.g., "Cell 3 failed"). Resubmit only the fixed cell (or fixed cell + remaining cells).
</instruction>

<prelude>
{{#ifAll py js}}The same helpers are available in both runtimes with the same positional argument order. Python takes the trailing options as keyword args; JavaScript takes the same options as a trailing object literal. JavaScript helpers are async and `await`able; Python helpers run synchronously.{{else}}{{#if py}}Helpers run synchronously. Trailing options are passed as keyword arguments.{{/if}}{{#if js}}Helpers are async and `await`able. Trailing options are passed as a final object literal.{{/if}}{{/ifAll}}
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
run(cmd, cwd?=None, timeout?=None) → {stdout, stderr, exit_code}
    Run a shell command.
env(key?=None, value?=None) → str | None | dict
    No args → full environment as dict. One arg → value of `key`. Two args → set `key=value` and return value.
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
    Read task/agent output by ID. Single id returns text/dict; multiple ids return a list.
```

{{#if js}}**JavaScript only:** `tool.<name>(args)` invokes any session tool directly (e.g. `await tool.read({ path: "src/foo.ts" })`).
{{/if}}</prelude>

<output>
Cells render like a Jupyter notebook. Pass any value to `display(value)`; non-presentable data is rendered as an interactive JSON tree, and presentable values (figures, images, dataframes, etc.) render with their native representation.
</output>

<caution>
- In session mode, use `rst=true` on a cell to wipe its language's kernel before running.{{#ifAll py js}} Reset is per-language: a python cell's `rst=true` does not touch the JavaScript kernel and vice versa.{{/ifAll}}
{{#if js}}- **js**: the VM exposes a selective `process` subset, Web APIs, `Buffer`, `fs/promises`.
{{/if}}</caution>

<example>
{{#if py}}```py id="imports" t="10s"
import json
from pathlib import Path
```

```py id="load config"
data = json.loads(read('package.json'))
display(data)
```
{{/if}}{{#ifAll py js}}

{{/ifAll}}{{#if js}}```js id="js summary" rst=true
const data = JSON.parse(await read('package.json'));
display(data);
return data.name;
```

```
return 'still JavaScript';
```
{{/if}}
</example>
