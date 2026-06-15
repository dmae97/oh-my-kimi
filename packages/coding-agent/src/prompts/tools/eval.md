Run code in a persistent kernel using a list of cells.

<instruction>
Cells run in array order. State persists per language — across cells, tool calls, and `task` subagents: variables either side defines are visible to the other. Stage helpers, datasets, or live clients once; subagents use them directly — no re-importing or serializing across the boundary.

Cell fields:

- `language` — {{#if py}}`"py"` for the IPython kernel{{/if}}{{#ifAll py js}}, {{/ifAll}}{{#if js}}`"js"` for the persistent JavaScript VM{{/if}}.
- `code` — cell body, verbatim. Newlines and quotes JSON-encoded; no fences, no headers.
- `title` (optional) — short transcript label (e.g. `"imports"`).
- `timeout` (optional) — per-cell seconds (1-3600, default 30). Bounds the cell's own work only; the clock pauses while `agent()`/`parallel()`/`completion()` calls are in flight, so fanouts never need a raise. Raise only for heavy local compute or long non-agent tool calls.
- `reset` (optional) — wipe this cell's language kernel first.{{#ifAll py js}} Per-language: a `py` reset never touches the JS VM.{{/ifAll}}

Work incrementally: one logical step per cell (imports, define, test, use); pass multiple small cells per call; define small reusable functions for individual debugging. Workflow explanations go in the assistant message or `title`, never inside cell code.
{{#if py}}Python runs in IPython with a live event loop: use top-level `await` directly; `asyncio.run(…)` raises "cannot be called from a running event loop".{{/if}}
On failure, errors name the failing cell ("Cell 3 failed") — resubmit only the fixed cell (plus any remaining).
</instruction>

<prelude>
{{#ifAll py js}}Same helpers in both runtimes, same positional order. Python: helpers run synchronously; trailing options are keyword args. JavaScript: helpers are async and `await`able; trailing options are ONE trailing object literal, never positional (extra positional args throw).{{else}}{{#if py}}Helpers run synchronously. Trailing options are keyword arguments.{{/if}}{{#if js}}Helpers are async and `await`able. Trailing options are ONE trailing object literal, never positional (extra positional args throw).{{/if}}{{/ifAll}}
```
display(value) → None
    Render value in cell output, shows presentable values natively (figures, images, dataframes)
print(value, ...) → None
    Print to text output.
read(path, offset?=1, limit?=None) → str
    Read file as text; offset/limit are 1-indexed lines. Accepts `local://…`.
write(path, content) → str
    Write file (creates parents); returns resolved path. `local://…` persists across turns / subagents.
append(path, content) → str
    Append to file; returns resolved path. Accepts `local://…`.
tree(path?=".", max_depth?=3, show_hidden?=False) → str
    Directory tree.
diff(a, b) → str
    Unified diff of two files.
env(key?=None, value?=None) → str | None | dict
    No args → full env dict; one → value of `key`; two → set `key=value`, return value.
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
    Read task/agent output by id; one id → text/dict, multiple → list.
tool.<name>(args) → unknown
    Invoke any session tool; `args` is its parameter object.
completion(prompt, model?="default", system?=None, schema?=None) → str | dict
    Oneshot stateless completion (no history, no tools). `model` tier: "smol" (fast) | "default" (session model) | "slow" (most capable). JSON-Schema `schema` forces structured output, returns parsed object.
{{#if spawns}}agent(prompt, agent_type?="task", model?=None, label?=None, schema?=None, return_handle?=False) → str | dict
    Run a subagent, return its final output. `agent_type`/`agentType` picks another discovered agent; `schema` as in completion(). Share background via `local://` files referenced in the prompt. `return_handle`/`returnHandle` → a DAG node dict { text, output, handle: "agent://<id>", id, agent } (parsed object under `data` when `schema` set) so a downstream stage references the transcript by handle instead of re-inlining it.
{{#if js}}    JS: options are ONE trailing object — agent(prompt, { agentType, schema, returnHandle }).
{{/if}}
{{/if}}
parallel(thunks) → list
    Run thunks through a bounded pool (as wide as a `task` batch — don't pre-shrink), preserving input order. Barrier: returns when all finish; a throwing thunk propagates.
pipeline(items, ...stages) → list
    Map items through one-arg stages left-to-right, barrier between stages; stage 1 gets the item, later stages the previous result. Same pool width as parallel().
log(message) → None
    Progress line above the status tree.
phase(title) → None
    Start a phase grouping subsequent status lines.
budget → per-turn token budget
    {{#if py}}`budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()` (math.inf when no ceiling), `budget.hard` (bool).{{/if}}{{#if js}}`await budget.total()` (ceiling or null), `await budget.spent()`, `await budget.remaining()` (Infinity when no ceiling), `await budget.hard()`.{{/if}} Ceiling comes from a `+Nk` directive (advisory) or `+Nk!`/Goal Mode (hard — `agent()` refuses to spawn past it); otherwise None/null, spend still tracked across the turn.
```
</prelude>
{{#if spawns}}
<dag>
Build a dependency graph by piping handles through the stage helpers — ephemeral, in-session, acyclic waves:
- **Name nodes.** Capture each `agent(…, {{#if py}}return_handle=True{{/if}}{{#if js}}{ returnHandle: true }{{/if}})` result; it carries `handle` (`agent://<id>`) + `output`.
- **Wire edges by reference.** Embed an upstream node's `handle` or `output` in the dependent stage's prompt so a large transcript flows by reference, never re-inlined. For bulk artifacts, `write("local://<name>.md", …)` and pass the URI.
- **`pipeline(items, *stages)` = staged waves** with a barrier between stages (every item clears stage N before any enters stage N+1) — the linear spine of a DAG. **`parallel(thunks)` = one wave** of independent nodes.
- **Isolate failure.** A raising node re-raises the lowest-index error and aborts its wave; wrap each risky node in try/except so a failed node degrades only its dependent subtree while independent branches still finish.
- **Acyclic only.** A node never waits on its own descendant; cycles are an authoring bug, not a supported pattern.
</dag>
{{/if}}
