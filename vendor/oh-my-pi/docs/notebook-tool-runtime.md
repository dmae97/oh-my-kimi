# Notebook file runtime internals

This document describes current `.ipynb` handling in `coding-agent` and its relationship to the kernel-backed Python runtime.

The critical distinction: **notebook support is file conversion/editing, not notebook execution**. `.ipynb` files are exposed as editable cell-marked text through `read` and the edit pipeline; no notebook-specific tool starts or talks to a Python kernel.

## Implementation files

- [`src/edit/notebook.ts`](../packages/coding-agent/src/edit/notebook.ts)
- [`src/edit/read-file.ts`](../packages/coding-agent/src/edit/read-file.ts)
- [`src/tools/read.ts`](../packages/coding-agent/src/tools/read.ts)
- [`src/tools/eval.ts`](../packages/coding-agent/src/tools/eval.ts)
- [`src/eval/py/executor.ts`](../packages/coding-agent/src/eval/py/executor.ts)
- [`src/eval/py/kernel.ts`](../packages/coding-agent/src/eval/py/kernel.ts)
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts)

## 1) Runtime boundary: editing vs executing

## `.ipynb` file conversion (`src/edit/notebook.ts`)

- `read` treats `.ipynb` files as notebooks unless the selector is `:raw`.
- The default notebook view is editable text with markers:
  - `# %% [code] cell:N`
  - `# %% [markdown] cell:N`
  - `# %% [raw] cell:N`
- Line selectors and multi-range selectors operate on that virtual text.
- Edit/write paths round-trip virtual text back to notebook JSON through `serializeEditedNotebookText(...)`.
- Existing notebook metadata is preserved when a marker references an existing `cell:N`; new cells get fresh empty metadata.
- Missing notebooks edited through this path start from an empty nbformat 4.5 notebook.

No kernel lifecycle exists in this path:

- no kernel session ID
- no code execution
- no stream chunks from Python
- no rich display capture
- no output artifact pipeline from execution

## Kernel-backed execution path (`src/tools/eval.ts` + `src/eval/py/*`)

When the agent needs to run cell-style Python code (sequential cells, persistent state, rich displays), that goes through the **`eval` tool** with per-cell `language: "py"`, not through notebook file handling.

That path is where Python subprocess lifecycle, reset/cancel behavior, chunk streaming, rich displays, and output artifact truncation live.

## 2) Notebook cell handling semantics

## Source normalization

Notebook JSON `source` is converted to virtual text by joining source arrays. When virtual text is serialized back, cell source is split with newline preservation:

- each line ending in `\n` stays as a separate source entry with the newline
- a final non-newline-terminated line is stored without forcing a trailing newline
- empty content becomes an empty `source` array

This mirrors notebook JSON conventions and avoids accidental line concatenation on later edits.

## Marker parsing and cell preservation

- The first representation line must be a marker; text before the first marker, including a blank line, is rejected.
- Markers must match `# %% [code|markdown|raw]` with optional `cell:N`.
- If `cell:N` points at an unused existing cell, that cell is cloned, its `cell_type` and `source` are updated, and unrelated metadata is preserved.
- If no valid unused original index is present, a new cell is created.
- Code cells ensure `execution_count` exists and `outputs` exists.
- Markdown/raw cells remove `execution_count` and `outputs`.

## Error surfaces

Hard failures are thrown for:

- missing notebook on read
- invalid JSON
- missing/non-array `cells`
- invalid cell objects or cell types
- invalid editable representation (for example, text before the first cell marker)

These surface through the caller (`read`, edit, or `write`) as normal tool errors.

## 3) Kernel session semantics (where they actually exist)

Kernel semantics are implemented in `executePython` / `PythonKernel` and apply to the Python backend of the `eval` tool.

## Modes

`PythonKernelMode`:

- `session` (default)
  - kernels are cached by `(session id, cwd, interpreter)`
  - multiple owners can share a retained kernel for the same key
  - execution is serialized by the tool's exclusive concurrency and backend execution path
  - dead kernels are replaced before execution
- `per-call`
  - creates a subprocess for the request
  - executes
  - always shuts down the subprocess in `finally`

## Reset behavior

Each eval cell has its own optional `reset` flag. `reset: true` resets the selected Python session before that cell executes; it is not a top-level tool parameter.

## Kernel death / restart / retry

In session mode:

- if the retained subprocess is not alive before execution, it is replaced
- if execution fails because the subprocess died, the kernel is replaced and the code is retried once
- concurrent resets for the same session key coalesce: a reset already in flight is awaited instead of starting another, and runs queued behind it proceed on the freshly-restarted kernel

## 4) Environment/session variable injection

Kernel startup and per-execution environment patching can receive:

- `PI_SESSION_FILE`
- `PI_ARTIFACTS_DIR`
- `PI_TOOL_BRIDGE_URL`
- `PI_TOOL_BRIDGE_TOKEN`
- `PI_TOOL_BRIDGE_SESSION`
- `PI_EVAL_LOCAL_ROOTS`

The runner initializes process state so code executes in the requested cwd, managed env entries are reflected in `os.environ`, and cwd is available on `sys.path`.

## 5) Streaming/chunk and display handling (kernel-backed path)

The Python backend uses an NDJSON subprocess runner. The host processes frames per execution:

- `stdout` / `stderr` -> text chunks to `onChunk`
- `display` / `result` -> MIME bundle rendering
- `error` -> traceback text and structured error metadata
- `done` -> final status, execution count, cancellation state

Display text MIME precedence:

1. `text/markdown`
2. `text/plain`
3. converted `text/html`

Structured outputs captured separately include:

- `application/json` -> JSON display output
- `image/png` / `image/jpeg` -> image output
- `application/x-omp-status` -> status event

Cancellation/timeout:

- abort/timeout sends `SIGINT` to the runner
- if the runner does not settle after the interrupt grace window, shutdown escalates and the kernel is recreated on the next call
- timeout output is annotated with a timeout message

## 6) Truncation and artifact behavior

`OutputSink` in `src/session/streaming-output.ts` is used by kernel execution paths:

- sanitizes every chunk
- tracks total/output lines and bytes
- optionally spills full output to an artifact file
- keeps a UTF-8-safe in-memory tail buffer when output exceeds the configured threshold

`eval` converts this metadata into result truncation notices and TUI warnings.

Notebook file conversion does **not** use `OutputSink`; it has no stream/artifact truncation pipeline because it does not execute code.

## 7) Renderer assumptions and formatting

## Read/edit notebook representation

Notebook files are rendered to the model as text. The visible cell markers are part of the editable representation, not comments that are ignored during serialization.

## Python renderer (for actual execution output)

Kernel-backed execution rendering expects:

- per-cell status transitions (`pending` / `running` / `complete` / `error`)
- optional structured status events
- optional JSON output trees
- image outputs
- truncation warnings + optional `artifact://<id>` pointer

This renderer behavior is unrelated to notebook JSON editing except that both reuse shared TUI primitives.

## 8) Practical workflow

If a workflow needs both notebook mutation and execution:

1. read or edit the `.ipynb` file through the normal file tools
2. copy the desired cell source into `eval` cells with `language: "py"` to execute it
3. write resulting source changes back to the notebook if needed

Current implementation does not provide a single tool that both mutates `.ipynb` and executes notebook cells through kernel context.
