Run code persistent kernel; list of cells.

<instruction>
Each call submits one or more cells. Cells run array order. State persists within each language across cells, tool calls, subagents spawned with `task`; variables parent or subagent declares visible to other on same shared executor. Lean on this: stage helpers, loaded datasets, live clients once, then fan out `task` subagents that call them directly — no re-importing, re-fetching, serializing across boundary.

Cell fields:

- `language` — {{#if py}}`"py"` for IPython kernel{{/if}}{{#ifAll py js}}, {{/ifAll}}{{#if js}}`"js"` for persistent JavaScript VM{{/if}}.
- `code` — cell body, verbatim. Newlines, quotes, indentation JSON-encoded; no fences, no headers.
- `title` optional — short label shown in transcript (e.g. `"imports"`, `"load config"`).
- `timeout` optional — per-cell wall-clock budget seconds (1-600). Default 30. Bounds cell's **own** work, but paused while `agent()`/`parallel()`/`llm()` call in flight — so long fanout or slow completion runs to completion, while cell itself still bounded. Compute, `print`/stdout, `log()`/`phase()`, ordinary tool calls all count against budget; raise `timeout` for cell doing heavy local work or long non-agent tool calls.
- `reset` (optional) — wipe cell's language kernel before running.{{#ifAll py js}} Reset per-language: `py` cell's reset does not touch JavaScript VM and vice versa.{{/ifAll}}

**Work incrementally:**

- One logical step per cell (imports, define, test, use).
- Pass multiple small cells one call.
- Need small reusable functions for individual debugging.
- Put workflow explanations in assistant message or `title` — NEVER inside cell code.
{{#if py}}- Python cells run inside IPython kernel with live event loop. Use top-level `await` directly (e.g. `await main()`); `asyncio.run(…)` raises "cannot be called from a running event loop".{{/if}}
**On failure:** errors identify failing cell (e.g., "Cell 3 failed"). Resubmit only fixed cell (or fixed cell + remaining cells).
</instruction>

<prelude>
{{#ifAll py js}}Same helpers both runtimes, same positional argument order. Python: trailing options as keyword args. JavaScript: trailing options as trailing object literal. JavaScript helpers async and `await`able; Python helpers run synchronously.{{else}}{{#if py}}Helpers run synchronously. Trailing options keyword arguments.{{/if}}{{#if js}}Helpers async and `await`able. Trailing options final object literal.{{/if}}{{/ifAll}}
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
tool.<name>(args) → unknown
    Invoke any session tool by name. `args` is the tool's parameter object.
llm(prompt, model?="default", system?=None, schema?=None) → str | dict
    Oneshot, stateless LLM call (no history, no tools). `model` picks a tier: "smol" (fast), "default" (this session's model), "slow" (most capable). Pass `system` for a system prompt. Pass a JSON-Schema `schema` to force structured output and get the parsed object back; otherwise returns the completion text.
agent(prompt, agent_type?="task", model?=None, context?=None, label?=None, schema?=None) → str | dict
    Run a subagent and return its final output. Defaults to the bundled "task" agent; pass `agent_type`/`agentType` for another discovered agent. Pass a JSON-Schema `schema` to force structured output and get the parsed object back.
parallel(thunks) → list
    Run thunks (callables) through a bounded pool, preserving input order. The pool is as wide as a `task` tool batch (tracks the `task.maxConcurrency` setting), so fan out as wide as the work divides — don't pre-shrink it. Barrier: returns once all finish; a thunk that throws propagates.
pipeline(items, ...stages) → list
    Map each item through stages left-to-right; a barrier runs between stages (every item clears stage N before stage N+1). Each stage is a one-arg callable: stage 1 gets the original item, later stages get the previous result. Same pool width as parallel().
log(message) → None
    Emit a progress line above the status tree.
phase(title) → None
    Start a phase; the status lines that follow group under it.
budget → per-turn token budget
    {{#if py}}`budget.total` (ceiling or None), `budget.spent()` (output tokens this turn), `budget.remaining()` (math.inf when no ceiling), `budget.hard` (bool).{{/if}}{{#if js}}`await budget.total()` (ceiling or null), `await budget.spent()`, `await budget.remaining()` (Infinity when no ceiling), `await budget.hard()`.{{/if}} A ceiling is set by a `+Nk` message directive (advisory) or `+Nk!`/Goal Mode (hard — `agent()` refuses to spawn past it); otherwise total is None/null and spend is still tracked across the turn (main loop + eval subagents).
```
</prelude>

<output>
Cells render like Jupyter notebook. `display(value)` renders non-presentable data as interactive JSON tree. Presentable values (figures, images, dataframes, etc.) use native representation.
</output>

<caution>
{{#if js}}- **js**: VM exposes selective `process` subset, Web APIs, `Buffer`, `fs/promises`, `Bun` global.
{{/if}}</caution>

<example>
{{#if py}}```json
{
  "cells": [
    { "language": "py", "title": "imports", "timeout": 10, "code": "import json\nfrom pathlib import Path" },
    { "language": "py", "title": "load config", "code": "data = json.loads(read('package.json'))\ndisplay(data)" }
  ]
}
```{{/if}}{{#ifAll py js}}

{{/ifAll}}{{#if js}}```json
{
  "cells": [
    { "language": "js", "title": "summary", "reset": true, "code": "const data = JSON.parse(await read('package.json'));\ndisplay(data);\nreturn data.name;" }
  ]
}
```{{/if}}
</example>
