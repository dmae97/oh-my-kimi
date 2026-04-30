# Notebook tool runtime internals

This document describes the current `notebook` tool implementation and its relationship to the kernel-backed Python runtime.

The critical distinction: **`notebook` is a JSON notebook editor, not a notebook executor**. It edits `.ipynb` cell sources directly; it does not start or talk to a Python kernel.

## Implementation files

- [`src/tools/notebook.ts`](../packages/coding-agent/src/tools/notebook.ts)
- [`src/ipy/executor.ts`](../packages/coding-agent/src/ipy/executor.ts)
- [`src/ipy/kernel.ts`](../packages/coding-agent/src/ipy/kernel.ts)
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts)
- [`src/tools/python.ts`](../packages/coding-agent/src/tools/python.ts)

## 1) Runtime boundary: editing vs executing

## `notebook` tool (`src/tools/notebook.ts`)

- Supports `action: edit | insert | delete` on a `.ipynb` file.
- Resolves path relative to session CWD (`resolveToCwd`).
- Loads notebook JSON, validates `cells` array, validates `cell_index` bounds.
- Applies source edits in-memory and writes full notebook JSON back with `JSON.stringify(notebook, null, 1)`.
- Returns textual summary + structured `details` (`action`, `cellIndex`, `cellType`, `totalCells`, `cellSource`).

No kernel lifecycle exists in this tool:

- no gateway acquisition
- no kernel session ID
- no `execute_request`
- no stream chunks from kernel channels
- no rich display capture (`image/png`, JSON display, status MIME)

## Notebook-like execution path (`src/tools/python.ts` + `src/ipy/*`)

When the agent needs to run cell-style Python code (sequential cells, persistent state, rich displays), that goes through the **`python` tool**, not `notebook`.

That path is where kernel modes, restart/cancel behavior, chunk streaming, and output artifact truncation live.

## 2) Notebook cell handling semantics (`notebook` tool)

## Source normalization

`content` is split into `source: string[]` with newline preservation:

- each non-final line keeps trailing `\n`
- final line has no forced trailing newline

This mirrors notebook JSON conventions and avoids accidental line concatenation on later edits.

## Action behavior

- `edit`
  - replaces `cells[cell_index].source`
  - preserves existing `cell_type`
- `insert`
  - inserts at `[0..cellCount]`
  - `cell_type` defaults to `code`
  - code cells initialize `execution_count: null` and `outputs: []`
  - markdown cells initialize only `metadata` + `source`
- `delete`
  - removes `cells[cell_index]`
  - returns removed `source` in details for renderer preview

## Error surfaces

Hard failures are thrown for:

- missing notebook file
- invalid JSON
- missing/non-array `cells`
- out-of-range index (insert and non-insert have different valid ranges)
- missing `content` for `edit`/`insert`

These become `Error:` tool responses upstream; renderer uses notebook path + formatted error text.

## 3) Kernel session semantics (where they actually exist)

Kernel semantics are implemented in `executePython` / `PythonKernel` and apply to the `python` tool.

## Modes

`PythonKernelMode`:

- `session` (default)
  - kernels cached in `kernelSessions` map
  - max 4 sessions; oldest evicted on overflow
  - idle/dead cleanup every 30s, timeout after 5 minutes
  - per-session queue serializes execution (`session.queue`)
- `per-call`
  - creates kernel for request
  - executes
  - always shuts down kernel in `finally`

## Reset behavior

`python` tool passes `reset` only for the first cell in a multi-cell call; later cells always run with `reset: false`.

## Kernel death / restart / retry

In session mode (`withKernelSession`):

- dead kernel detected by heartbeat (`kernel.isAlive()` check every 5s) or execute failure.
- pre-run dead state triggers `restartKernelSession`.
- execute-time crash path retries once: restart kernel, rerun handler.
- `restartCount > 1` in same session throws `Python kernel restarted too many times in this session`.

Startup retry behavior:

- shared gateway kernel creation retries once on `SharedGatewayCreateError` with HTTP 5xx.

Resource exhaustion recovery:

- detects `EMFILE`/`ENFILE`/"Too many open files" style failures
- clears tracked sessions
- calls `shutdownSharedGateway()`
- retries kernel session creation once

## 4) Environment/session variable injection

Kernel startup receives the optional session file path from executor:

- `PI_SESSION_FILE` (session state file path)

`PythonKernel.#initializeKernelEnvironment(...)` then runs init script inside kernel to:

- `os.chdir(cwd)`
- inject env entries into `os.environ`
- prepend cwd to `sys.path` if missing

Implication:

- prelude helpers that read session context rely on this env var in Python process state.

## 5) Streaming/chunk and display handling (kernel-backed path)

The kernel client processes Jupyter protocol messages per execution:

- `stream` -> text chunk to `onChunk`
- `execute_result` / `display_data` ->
  - display text chosen by MIME precedence: `text/markdown` > `text/plain` > converted `text/html`
  - structured outputs captured separately:
    - `application/json` -> `{ type: "json" }`
    - `image/png` -> `{ type: "image" }`
    - `application/x-omp-status` -> `{ type: "status" }` (no text emission)
- `error` -> traceback text pushed to chunk stream + structured error metadata
- `input_request` -> emits stdin warning text, sends empty `input_reply`, marks stdin requested
- completion waits for both `execute_reply` and kernel `status=idle`

Cancellation/timeout:

- abort signal triggers `interrupt()` (REST `/interrupt` + control-channel `interrupt_request`)
- result marks `cancelled=true`
- timeout path annotates output with `Command timed out after <n> seconds`

## 6) Truncation and artifact behavior

`OutputSink` in `src/session/streaming-output.ts` is used by kernel execution paths (`executeWithKernel`):

- sanitizes every chunk (`sanitizeText`)
- tracks total/output lines and bytes
- optional artifact spill file (`artifactPath`, `artifactId`)
- when in-memory buffer exceeds threshold (`DEFAULT_MAX_BYTES` unless overridden):
  - marks truncated
  - keeps tail bytes in memory (UTF-8 safe boundary)
  - can spill full stream to artifact sink

`dump()` returns:

- visible output text (possibly tail-truncated)
- truncation flag + counts
- artifact ID (for `artifact://<id>` references)

`python` tool converts this metadata into result truncation notices and TUI warnings.

`notebook` tool does **not** use `OutputSink`; it has no stream/artifact truncation pipeline because it does not execute code.

## 7) Renderer assumptions and formatting

## Notebook renderer (`notebookToolRenderer`)

- call view: status line with action + notebook path + cell/type metadata
- result view:
  - success summary derived from `details`
  - `cellSource` rendered via `renderCodeCell`
  - markdown cells set language hint `markdown`; other cells have no explicit language override
  - collapsed code preview limit is `PREVIEW_LIMITS.COLLAPSED_LINES * 2`
  - supports expanded mode via shared render options
  - uses render cache keyed by width + expanded state

Error rendering assumption:

- if first text content starts with `Error:`, renderer formats as notebook error block.

## Python renderer (for actual execution output)

Kernel-backed execution rendering expects:

- per-cell status transitions (`pending/running/complete/error`)
- optional structured status event section
- optional JSON output trees
- truncation warnings + optional `artifact://<id>` pointer

This renderer behavior is unrelated to `notebook` JSON editing results except that both reuse shared TUI primitives.

## 8) Divergence from plain Python tool behavior

If "plain Python tool" means `python` execution path:

- `python` executes code in a kernel, persists state by mode, streams chunks, captures rich displays, handles interrupts/timeouts, and supports output truncation/artifacts.
- `notebook` performs deterministic notebook JSON mutations only; no execution, no kernel state, no chunk stream, no display outputs, no artifact pipeline.

If a workflow needs both:

1. edit notebook source with `notebook`
2. execute code cells via `python` (manually passing code), not through `notebook`

Current implementation does not provide a single tool that both mutates `.ipynb` and executes notebook cells through kernel context.
