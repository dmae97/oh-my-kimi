# Python Tool and IPython Runtime

This document describes the current Python execution stack in `packages/coding-agent`.
It covers tool behavior, kernel/gateway lifecycle, environment handling, execution semantics, output rendering, and operational failure modes.

## Scope and Key Files

- Tool surface: `src/tools/python.ts`
- Session/per-call kernel orchestration: `src/ipy/executor.ts`
- Kernel protocol + gateway integration: `src/ipy/kernel.ts`
- Shared local gateway coordinator: `src/ipy/gateway-coordinator.ts`
- Interactive-mode renderer for user-triggered Python runs: `src/modes/components/python-execution.ts`
- Runtime/env filtering and Python resolution: `src/ipy/runtime.ts`

## What the Python tool is

The `python` tool executes one or more Python cells through a Jupyter Kernel Gateway-backed kernel (not by spawning `python -c` directly per cell).

Tool params:

```ts
{
  cells: Array<{ code: string; title?: string }>;
  timeout?: number; // seconds, clamped to 1..600, default 30
  reset?: boolean; // reset kernel before first cell only
}
```

The tool is `concurrency = "exclusive"` for a session, so calls do not overlap.

## Gateway lifecycle

### Modes

There are two gateway paths:

1. **External gateway** (`PI_PYTHON_GATEWAY_URL` set)
   - Uses the configured URL directly.
   - Optional auth with `PI_PYTHON_GATEWAY_TOKEN`.
   - No local gateway process is spawned or managed.

2. **Local shared gateway** (default path)
   - Uses a single shared process coordinated under `~/.omp/agent/python-gateway`.
   - Metadata file: `gateway.json`
   - Lock file: `gateway.lock`
   - Spawn command:
     - `python -m kernel_gateway`
     - bound to `127.0.0.1:<allocated-port>`
     - startup health check: `GET /api/kernelspecs`

### Local shared gateway coordination

`acquireSharedGateway()`:

- Takes a file lock (`gateway.lock`) with heartbeat.
- Reuses `gateway.json` if PID is alive and health check passes.
- Cleans stale info/PIDs when needed.
- Starts a new gateway when no healthy one exists.

`releaseSharedGateway()` is currently a no-op (kernel shutdown does not tear down shared gateway).

`shutdownSharedGateway()` explicitly terminates the shared process and clears gateway metadata.

### Important constraint

`python.sharedGateway=false` is rejected at kernel start:

- Error: `Shared Python gateway required; local gateways are disabled`
- There is no per-process non-shared local gateway mode.

## Kernel lifecycle

Kernels are created via `POST /api/kernels` on the selected gateway when a retained session needs a kernel or when `per-call` mode starts a request.

Kernel startup sequence:

1. Availability check (`checkPythonKernelAvailability`)
2. Create kernel (`/api/kernels`)
3. Open websocket (`/api/kernels/:id/channels`)
4. Initialize kernel env (`cwd`, env vars, `sys.path`)
5. Execute `PYTHON_PRELUDE`
6. Load extension modules from:
   - user: `~/.omp/agent/modules/*.py`
   - project: `<cwd>/.omp/modules/*.py` (overrides same-name user module)

Kernel shutdown:

- Deletes remote kernel via `DELETE /api/kernels/:id`
- Closes websocket
- Calls shared gateway release hook (no-op today)

## Session persistence semantics

`python.kernelMode` controls retained kernel reuse:

- `session` (default)
  - Reuses kernel sessions keyed by session file plus cwd when a session file exists; otherwise by cwd.
  - Execution is serialized per session via a queue.
  - Idle sessions are evicted after 5 minutes.
  - At most 4 sessions; oldest is evicted on overflow.
  - Heartbeat checks detect dead kernels.
  - Auto-restart allowed once; repeated crash => hard failure.

- `per-call`
  - Creates a fresh kernel for each execute request.
  - Shuts kernel down after the request.
  - No cross-call state persistence.

### Multi-cell behavior in a single tool call

Cells run sequentially in the same kernel instance for that tool call.

If an intermediate cell fails:

- Earlier cell state remains in memory.
- Tool returns a targeted error indicating which cell failed.
- Later cells are not executed.

`reset=true` only applies to the first cell execution in that call.

## Environment filtering and runtime resolution

Environment is filtered before launching gateway/kernel runtime:

- Allowlist includes core vars like `PATH`, `HOME`, locale vars, `VIRTUAL_ENV`, `PYTHONPATH`, etc.
- Allow-prefixes: `LC_`, `XDG_`, `PI_`
- Denylist strips common API keys (OpenAI/Anthropic/Gemini/etc.)

Runtime selection order:

1. Active/located venv (`VIRTUAL_ENV`, then `<cwd>/.venv`, `<cwd>/venv`)
2. Managed venv at `~/.omp/python-env`
3. `python` or `python3` on PATH

When a venv is selected, its bin/Scripts path is prepended to `PATH`.

Kernel startup receives the optional session file path from the executor:

- `PI_SESSION_FILE` (session state file path)

`PythonKernel.#initializeKernelEnvironment(...)` then runs init script inside kernel to:

- `os.chdir(cwd)`
- injects provided env entries into `os.environ`
- ensures cwd is in `sys.path`

## Tool availability and mode selection

`python.toolMode` (default `both`) + optional `PI_PY` override controls exposure:

- `ipy-only`
- `bash-only`
- `both`

`PI_PY` accepted values:

- `0` / `bash` -> `bash-only`
- `1` / `py` -> `ipy-only`
- `mix` / `both` -> `both`

If Python preflight fails, tool creation degrades to bash-only for that session.

## Execution flow and cancellation/timeout

### Tool-level timeout

`python` tool timeout is in seconds, default 30, clamped to `1..600`.

The tool combines:

- caller abort signal
- timeout abort signal

with `AbortSignal.any(...)`.

### Kernel execution cancellation

On abort/timeout:

- Execution is marked cancelled.
- Kernel interrupt is attempted via REST (`POST /interrupt`) and control-channel `interrupt_request`.
- Result includes `cancelled=true`.
- Timeout path annotates output as `Command timed out after <n> seconds`.

### stdin behavior

Interactive stdin is not supported.

If kernel emits `input_request`:

- Tool records `stdinRequested=true`
- Emits explanatory text
- Sends empty `input_reply`
- Execution is treated as failure at executor layer

## Output capture and rendering

### Captured output classes

From kernel messages:

- `stream` -> plain text chunks
- `display_data`/`execute_result` -> rich display handling
- `error` -> traceback text
- custom MIME `application/x-omp-status` -> structured status events

Display MIME precedence:

1. `text/markdown`
2. `text/plain`
3. `text/html` (converted to basic markdown)

Additionally captured as structured outputs:

- `application/json` -> JSON tree data
- `image/png` -> image payloads
- `application/x-omp-status` -> status events

### Storage and truncation

Output is streamed through `OutputSink` and may be persisted to artifact storage.

Tool results can include truncation metadata and `artifact://<id>` for full output recovery.

### Renderer behavior

- Tool renderer (`python.ts`):
  - shows code-cell blocks with per-cell status
  - collapsed preview defaults to 10 lines
  - supports expanded mode for full output and richer status detail
- Interactive renderer (`python-execution.ts`):
  - used for user-triggered Python execution in TUI
  - collapsed preview defaults to 20 lines
  - clamps very long individual lines to 4000 chars for display safety
  - shows cancellation/error/truncation notices

## External gateway support

Set:

```bash
export PI_PYTHON_GATEWAY_URL="http://127.0.0.1:8888"
# Optional:
export PI_PYTHON_GATEWAY_TOKEN="..."
```

Behavior differences from local shared gateway:

- No local gateway lock/info files
- No local process spawn/termination
- Health checks and kernel CRUD run against external endpoint
- Auth failures are surfaced with explicit token guidance

## Operational troubleshooting (current failure modes)

- **Python tool not available**
  - Check `python.toolMode` / `PI_PY`.
  - If preflight fails, runtime falls back to bash-only.

- **Kernel availability errors**
  - Local mode requires both `kernel_gateway` and `ipykernel` importable in resolved Python runtime.
  - Install with:
    ```bash
    python -m pip install jupyter_kernel_gateway ipykernel
    ```

- **`python.sharedGateway=false` causes startup failure**
  - This is expected with current implementation.

- **External gateway auth/reachability failures**
  - 401/403 -> set `PI_PYTHON_GATEWAY_TOKEN`.
  - timeout/unreachable -> verify URL/network and gateway health.

- **Execution hangs then times out**
  - Increase tool `timeout` (max 600s) if workload is legitimate.
  - For stuck code, cancellation triggers kernel interrupt but user code may still need refactor.

- **stdin/input prompts in Python code**
  - `input()` is not supported interactively in this runtime path; pass data programmatically.

- **Resource exhaustion (`EMFILE` / too many open files)**
  - Session manager triggers shared-gateway recovery (session teardown + shared gateway restart).

- **Working directory errors**
  - Tool validates `cwd` exists and is a directory before execution.

## Relevant environment variables

- `PI_PY` — tool exposure override (`bash-only`/`ipy-only`/`both` mapping above)
- `PI_PYTHON_GATEWAY_URL` — use external gateway
- `PI_PYTHON_GATEWAY_TOKEN` — optional external gateway auth token
- `PI_PYTHON_SKIP_CHECK=1` — bypass Python preflight/warm checks
- `PI_PYTHON_IPC_TRACE=1` — log kernel IPC send/receive traces
- `PI_DEBUG_STARTUP=1` — emit startup-stage debug markers
