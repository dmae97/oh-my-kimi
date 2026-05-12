# eval

> Execute Python or JavaScript code in persistent cell-based runtimes.

## Source
- Entry: `packages/coding-agent/src/tools/eval.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/eval.md`
- Key collaborators:
  - `packages/coding-agent/src/eval/parse.ts` — lenient cell parser
  - `packages/coding-agent/src/eval/sniff.ts` — language sniffing heuristics
  - `packages/coding-agent/src/eval/backend.ts` — backend execution contract
  - `packages/coding-agent/src/eval/js/index.ts` — JS backend adapter
  - `packages/coding-agent/src/eval/js/executor.ts` — JS execution + output sink
  - `packages/coding-agent/src/eval/js/context-manager.ts` — persistent VM contexts, prelude, tool bridge
  - `packages/coding-agent/src/eval/js/prelude.txt` — JS global helpers
  - `packages/coding-agent/src/eval/py/index.ts` — Python backend adapter
  - `packages/coding-agent/src/eval/py/executor.ts` — kernel session retention, reset, cleanup
  - `packages/coding-agent/src/eval/py/kernel.ts` — Jupyter gateway/kernel protocol, display capture
  - `packages/coding-agent/src/eval/py/prelude.py` — Python helper functions and status events
  - `packages/coding-agent/src/session/streaming-output.ts` — truncation, artifacts, streamed chunks
  - `docs/python-repl.md` — Python kernel/gateway internals

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | Cell program text. Parsed by `parseEvalInput()` in `packages/coding-agent/src/eval/parse.ts`, not by JSON subfields. |

`input` syntax accepted at runtime:

- Cell header: `*** Cell <attrs...>`. Attributes are space-separated tokens with quoted titles (`"..."` or `'...'`).
- Canonical tokens (advertised in the prompt):
  - `<lang>:"<title>"` — language + title shorthand. `lang` is `py` or `js` (lenient: also `ts`, plus the long-form aliases `python`, `javascript`, `typescript`, `ipy`, `ipython`).
  - `t:<n>[ms|s|m]` — per-cell timeout (default 30s).
  - `rst` — wipe this cell's language kernel before running.
- Lenient additional tokens (accepted by the parser, not advertised):
  - bare language token (`py`, `js`)
  - `id:"..."` / `title:"..."` / `name:"..."` / `cell:"..."` / `file:"..."` / `label:"..."` — title aliases
  - `timeout:` / `duration:` / `time:` — `t:` aliases
  - `reset` — `rst` alias
  - `rst:true|false|1|0|yes|no|on|off` — explicit boolean form
  - a bare positional duration token (`30s`, `2m`, `500ms`)
  - any unclassified bare token folds into a positional title fragment
- Cell body: every following line until the next `*** Cell ...`, the optional `*** End`, or `*** Abort`. `*** End` is a quirk fix for GPT-trained models that emit terminators and is not documented in the prompt.

Leniencies in `packages/coding-agent/src/eval/parse.ts`:

- Markers accept two or more leading `*` and flexible whitespace.
- `*** End` is optional everywhere; the parser silently consumes trailing tokens (e.g. `*** End py`).
- Missing terminators between adjacent cells are tolerated; the next `*** Cell` closes the prior cell, and stray non-marker lines between cells fold into the prior cell's body without crashing.
- Bare code or a single markdown fence such as ```` ```py ```` is treated as one implicit cell.
- If `*** Abort` appears, the in-progress cell is dropped and the result carries an abort warning. To preserve a completed cell before `*** Abort`, emit `*** End` first.

The tool also exposes a custom Lark grammar from `packages/coding-agent/src/eval/eval.lark` for constrained sampling. That grammar is stricter than the runtime parser: it requires the canonical `*** Cell <lang>:"title"` header form with a fixed attribute order, advertises only `py` / `js`, and pins the trailing `*** End` so GPT-trained models' natural terminator habit aligns with the constrained output.

## Outputs

Final result from `EvalTool.execute()` is single-shot, but `onUpdate` streams partial text and `details` while cells run.

Returned shape:

- `content`: one text block containing combined cell output, or `(no text output)` / `(no output)` when only rich outputs exist.
- `details` (`EvalToolDetails` from `packages/coding-agent/src/eval/types.ts`):
  - `cells`: per-cell code, status (`pending`/`running`/`complete`/`error`), output, duration, exit code, status events, markdown flag
  - `language`: first backend used
  - `languages`: distinct backends used, in first-use order
  - `jsonOutputs`: structured values emitted via `display(...)`
  - `images`: image payloads emitted by Python rich display or JS `display({ type: "image", ... })`
  - `statusEvents`: aggregated helper/tool status events
  - `notice`: backend fallback notice
  - `meta`: truncation metadata
  - `isError`: set on cell failure or cancellation

Renderer behavior in `packages/coding-agent/src/tools/eval.ts`:

- call preview renders parsed code cells with syntax highlighting
- result view renders each cell separately, including status, duration, and output
- markdown outputs are rendered with the Markdown component instead of plain text
- `jsonOutputs` render as a tree, collapsed or expanded depending on UI state
- timeout / fallback / truncation notices render as dim metadata lines
- images are carried in `details.images`; generic tool UI image handling renders them outside the text block

Side-channel artifacts:

- `session.allocateOutputArtifact?.("eval")` may allocate an `artifact://...` backing store for spilled output.
- Truncated output metadata points at that artifact when available.

## Flow

1. `EvalTool.execute()` in `packages/coding-agent/src/tools/eval.ts` parses `params.input` with `parseEvalInput()`.
2. `parseEvalInput()` normalizes newlines, collects cells, parses attributes, and assigns each cell a language from the header, language sniffing, or the default `python`.
3. Back in `execute()`, each parsed cell is resolved to a backend with `resolveBackend()`:
   - explicit `python`/`js` requests are validated against session settings and backend availability
   - otherwise `sniffEvalLanguage()` in `packages/coding-agent/src/eval/sniff.ts` tries shebangs and language markers
   - if no explicit language was present, later cells prefer the previous runtime language before re-sniffing
   - Python is preferred when available; JS is the fallback when Python is unavailable or disabled
4. The tool allocates an `OutputSink`, a `TailBuffer`, per-cell result objects, and a `sessionAbortController`. `session.trackEvalExecution?.(...)` can wrap the whole run for external cancellation tracking.
5. Cells execute sequentially. For each cell, `execute()`:
   - clamps the cell timeout through `clampTimeout("eval", ...)`
   - builds a combined abort signal from the tool signal, the timeout, and the session abort controller
   - marks the cell `running` and emits an update
   - calls the backend’s `execute()` with `cwd`, `sessionId`, `sessionFile`, `kernelOwnerId`, `deadlineMs`, `reset`, artifact info, and chunk callback
6. JS cells dispatch through `packages/coding-agent/src/eval/js/index.ts` into `executeJs()`; Python cells dispatch through `packages/coding-agent/src/eval/py/index.ts` into `executePython()`.
7. Backend text chunks stream into the shared `OutputSink`; rich outputs are accumulated separately as JSON, images, markdown markers, and status events.
8. After each cell:
   - text output is trimmed and stored on that cell result
   - multi-cell runs prefix text with `[i/n]` and the optional title
   - cancellations return early with `isError: true` and a cell-specific abort message
   - non-zero exit codes return early with `isError: true` and a message naming the failed cell
   - later cells are skipped after the first error, but earlier cell state persists in the underlying runtime
9. On success, the tool joins all cell outputs, synthesizes `(no text output)` or `(no output)` when needed, and attaches truncation metadata from `summarizeFinal()`.
10. The renderer uses `details.cells`, `details.jsonOutputs`, and `details.statusEvents` to build notebook-style output. `mergeCallAndResult = true` and `inline = true`, so call and result render together in the transcript.

## Modes / Variants

### Parsing modes

- Explicit multi-cell format with `*** Cell ...` headers
- Implicit single-cell fallback for bare code or a single fenced block
- Abort-recovery parse path when `*** Abort` is present

### Backend selection

- Explicit Python backend
- Explicit JavaScript backend
- Auto-detected backend via `sniffEvalLanguage()`
- Fallback from requested/inferred Python to JS when Python is unavailable
- Fallback notice when JS markers are seen but `eval.js` is disabled and Python is used instead

### JavaScript runtime

Implemented in `packages/coding-agent/src/eval/js/context-manager.ts` and `packages/coding-agent/src/eval/js/prelude.txt`.

- Persistent `vm.Context` instances keyed by `js:${sessionId}` in `vmContexts`
- `rst` calls `resetVmContext(sessionKey)` before the cell executes
- Top-level `await` and bare `return` are supported by wrapping code in an async IIFE when `wrapCode()` sees `await` or `return`
- Top-level static `import ... from ...` is rewritten to `await import(...)` by `rewriteStaticImports()`
- The prelude installs globals:
  - `display`, `print`
  - `read`, `write`, `append`, `sort`, `uniq`, `counter`, `diff`, `tree`, `env`, `output`
  - `tool.<name>(args)` proxy for arbitrary session tool calls
- JS helpers are async because they cross the VM/tool boundary
- `display(value)` behavior:
  - plain objects/arrays become JSON outputs
  - `{ type: "image", data, mimeType }` becomes an image output
  - scalars become text
- The VM exposes a restricted `process` subset plus `Buffer`, `fetch`, `Blob`, `File`, `Headers`, `Request`, `Response`, `fs`, `require`, and browser-style globals
- Per-session VM runs are serialized with `runQueued()`

### Python runtime

Implemented in `packages/coding-agent/src/eval/py/executor.ts`, `packages/coding-agent/src/eval/py/kernel.ts`, and `packages/coding-agent/src/eval/py/prelude.py`. See `docs/python-repl.md` for gateway and kernel details.

- Default mode is retained `session` kernels keyed by `python:${sessionId}`
- Optional `python.kernelMode = "per-call"` creates a fresh kernel for each cell and shuts it down afterward
- `rst` disposes the retained kernel for that session before the cell runs; later Python cells in the same tool call reuse the fresh kernel
- Startup path:
  - availability check
  - create/connect kernel
  - initialize cwd / env / `sys.path`
  - execute `PYTHON_PRELUDE`
- Python cells run inside IPython/Jupyter, so top-level `await` works; the prompt warns not to use `asyncio.run(...)`
- The Python prelude defines synchronous helpers with the same surface as JS (except `tool.<name>` exists only in JS)
- `display(value)` wraps dict/list/tuple values in `IPython.display.JSON`; rich display MIME bundles are preserved
- Kernel `display_data` / `execute_result` messages map to:
  - `application/x-omp-status` → status event
  - `image/png` → image output
  - `application/json` → JSON output
  - `text/markdown` → markdown output
  - `text/plain` → text output
  - `text/html` → HTML converted to markdown with `htmlToBasicMarkdown()`
- Interactive stdin is rejected: `input_request` sends an empty reply, marks `stdinRequested`, and the executor returns exit code `1`

### Multi-language call behavior

A single tool call can mix Python and JS cells. Persistence is per language runtime:

- resetting Python does not touch JS state
- resetting JS does not touch Python state
- each backend keeps its own retained session keyed from the same session-derived ID

## Side Effects

- Filesystem
  - JS/Python prelude helpers can read, write, append, diff, and traverse files under the session cwd or absolute paths.
  - Output may spill to an artifact file via `OutputSink`.
- Network
  - Python backend speaks NDJSON to a local `python3` subprocess over stdin/stdout (no network).
  - JS runtime exposes `fetch` and `tool.<name>()`; those tools may perform additional network I/O.
- Subprocesses / native bindings
  - Python availability check runs `<python> -c ...`.
  - Python backend spawns one `python -u runner.py` subprocess per kernel; cancellation sends `SIGINT`. Details in `docs/python-repl.md`.
- Session state
  - `session.assertEvalExecutionAllowed?.()` can block execution.
  - `session.trackEvalExecution?.(...)` can register cancellable eval work.
  - `session.getSessionFile?.()` and `session.getEvalKernelOwnerId?.()` influence kernel reuse and artifact lookup.
  - JS VM contexts persist in `vmContexts` across eval calls until reset/disposal.
  - Python retained kernels persist in `kernelSessions` until reset, eviction, idle cleanup, or owner cleanup.
- User-visible prompts / interactive UI
  - none; stdin requests are rejected programmatically
- Background work / cancellation
  - Python retained kernels have heartbeat and idle cleanup timers.
  - Cancellation interrupts a running Python kernel and aborts JS promise waits.

## Limits & Caps

- Per-cell timeout default: 30s (`DEFAULT_TIMEOUT_MS` in `packages/coding-agent/src/eval/parse.ts`; `TOOL_TIMEOUTS.eval.default` in `packages/coding-agent/src/tools/tool-timeouts.ts`)
- Timeout clamp: 1s minimum, 600s maximum (`TOOL_TIMEOUTS.eval` in `packages/coding-agent/src/tools/tool-timeouts.ts`)
- Transcript code/output preview: 10 lines by default (`EVAL_DEFAULT_PREVIEW_LINES` in `packages/coding-agent/src/tools/eval.ts`)
- Output truncation window: 50KB default (`DEFAULT_MAX_BYTES` in `packages/coding-agent/src/session/streaming-output.ts`)
- Output line cap inside truncation helpers: 3000 lines (`DEFAULT_MAX_LINES` in `packages/coding-agent/src/session/streaming-output.ts`)
- Streaming tail buffer for live updates: `DEFAULT_MAX_BYTES * 2` = 100KB (`packages/coding-agent/src/tools/eval.ts`)
- Python retained kernel idle timeout: 5 minutes (`IDLE_TIMEOUT_MS` in `packages/coding-agent/src/eval/py/executor.ts`)
- Python retained kernel cap: 4 sessions (`MAX_KERNEL_SESSIONS` in `packages/coding-agent/src/eval/py/executor.ts`)
- Python retained kernel cleanup sweep: every 30s (`CLEANUP_INTERVAL_MS` in `packages/coding-agent/src/eval/py/executor.ts`)
- Python owner-cleanup shutdown wait: 2000ms (`OWNER_CLEANUP_KERNEL_SHUTDOWN_TIMEOUT_MS` in `packages/coding-agent/src/eval/py/executor.ts`)
- Python heartbeat interval: 5s (`ensureKernelHeartbeat()` in `packages/coding-agent/src/eval/py/executor.ts`)
- Python external gateway availability check timeout: 5s (`AbortSignal.timeout(5000)` in `packages/coding-agent/src/eval/py/kernel.ts`)
- Python auto-restart budget: one restart per retained session before hard failure (`restartCount > 1` in `packages/coding-agent/src/eval/py/executor.ts`)

## Errors

- Parse errors from `parseEvalInput()` throw immediately, for example invalid timeout strings.
- Missing session without proxy executor throws `ToolError("Eval tool requires a session when not using proxy executor")`.
- Disabled/unavailable backends throw `ToolError` from `resolveBackend()`:
  - `eval.py = false`
  - `eval.js = false`
  - Python kernel unavailable
  - no backend available
- JS runtime exceptions are converted into text output plus `exitCode: 1`; cancellations return `cancelled: true` and may append `Command timed out`.
- Python execution errors from the kernel become text output and `exitCode: 1`; later cells are skipped.
- Python stdin requests are treated as errors with the message `Kernel requested stdin; interactive input is not supported.`
- Cancellation is returned, not thrown, once backend execution has started. The tool formats it as a cell failure and sets `details.isError = true`.
- If parsing encountered `*** Abort`, the final text appends `ABORT_WARNING`, explicitly telling the model that earlier cells ran and state persists.
- If output truncates, the tool still succeeds; truncation is surfaced through `details.meta` and artifact-backed full output when available.

## Notes

- The runtime parser is intentionally more permissive than `packages/coding-agent/src/eval/eval.lark`; maintain both when changing syntax.
- Cell language in `ParsedEvalCell` is not the last word: `EvalTool.execute()` may override backend selection for cells without an explicit header by inheriting the previous runtime language.
- `tool.<name>()` exists only in JS. Python prelude helpers do not call back into the full tool registry.
- JS helper paths reject protocol URIs (`://`) in `resolvePath()`; the JS prelude is filesystem-only unless the code calls `tool.read(...)` or another tool explicitly.
- Python helper `output(...)` depends on `PI_SESSION_FILE`; it fails outside a session-backed run.
- `display()` can produce text and structured outputs from the same value; the renderer prefers markdown over `text/plain` when both exist.
- JS static imports are rewritten only at top level. Nested imports stay invalid and surface normal JS syntax/runtime errors.
- `EvalTool` is `concurrency = "exclusive"`, so eval calls do not overlap within a session.
- The tool description shown to the model is templated by backend availability (`getEvalToolDescription()`); if Python is unavailable, the prompt omits Python-specific instructions.
