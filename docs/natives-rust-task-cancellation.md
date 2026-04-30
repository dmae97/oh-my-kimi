# Native Rust task execution and cancellation (`pi-natives`)

This document describes how `crates/pi-natives` schedules native work and how cancellation flows from JS options (`timeoutMs`, `AbortSignal`) to Rust execution.

## Implementation files

- `crates/pi-natives/src/task.rs`
- `crates/pi-natives/src/grep.rs`
- `crates/pi-natives/src/glob.rs`
- `crates/pi-natives/src/fd.rs`
- `crates/pi-natives/src/shell.rs`
- `crates/pi-natives/src/pty.rs`
- `crates/pi-natives/src/html.rs`
- `crates/pi-natives/src/image.rs`
- `crates/pi-natives/src/clipboard.rs`
- `crates/pi-natives/src/text.rs`
- `crates/pi-natives/src/ps.rs`

## Core primitives (`task.rs`)

`task.rs` defines three core pieces:

1. `task::blocking(tag, cancel_token, work)`
   - Wraps `napi::AsyncTask` / `Task`.
   - `compute()` runs on libuv worker threads (for CPU-bound or blocking/sync system calls).
   - Returns a JS `Promise<T>`.

2. `task::future(env, tag, work)`
   - Wraps `env.spawn_future(...)`.
   - Runs async work on Tokio runtime.
   - Returns `PromiseRaw<'env, T>`.

3. `CancelToken` / `AbortToken` / `AbortReason`
   - `CancelToken::new(timeout_ms, signal)` combines deadline + optional `AbortSignal`.
   - `CancelToken::heartbeat()` is cooperative cancellation for blocking loops.
   - `CancelToken::wait()` is async cancellation wait (`Signal` / `Timeout` / `User` Ctrl-C).
   - `AbortToken` lets external code request abort (`abort(reason)`).

## `blocking` vs `future`: execution model and selection

### Use `task::blocking`

Use when work is CPU-heavy or fundamentally synchronous/blocking:

- regex/file scanning (`grep`, `glob`, `fuzzy_find`)
- synchronous PTY loop internals (`run_pty_sync` via `spawn_blocking`)
- clipboard/image/html conversions

Behavior:

- Work closure receives a cloned `CancelToken`.
- Cancellation is only observed where code checks `ct.heartbeat()?`.
- Closure `Err(...)` rejects JS promise.

### Use `task::future`

Use when work must `await` async operations:

- shell session orchestration (`shell.run`, `executeShell`)
- task racing (`tokio::select!`) between completion and cancellation

Behavior:

- Future can race normal completion against `ct.wait()`.
- On cancel path, async implementations typically propagate cancellation to inner subsystems (e.g., `tokio_util::CancellationToken`) and optionally force abort on grace timeout.

## JS API ↔ Rust export mapping (task/cancel relevant)

| JS-facing API | Rust export (`#[napi]`) | Scheduler | Cancellation hookup |
|---|---|---|---|
| `grep(options, onMatch?)` | `grep` | `task::blocking("grep", ct, ...)` | `CancelToken::new(options.timeoutMs, options.signal)` + `ct.heartbeat()` |
| `glob(options, onMatch?)` | `glob` | `task::blocking("glob", ct, ...)` | `CancelToken::new(...)` + `ct.heartbeat()` in filter loop |
| `fuzzyFind(options)` | `fuzzy_find` | `task::blocking("fuzzy_find", ct, ...)` | `CancelToken::new(...)` + `ct.heartbeat()` in scoring loop |
| `shell.run(options, onChunk?)` | `Shell::run` | `task::future(env, "shell.run", ...)` | `ct.wait()` raced against run task; bridges to Tokio `CancellationToken` |
| `executeShell(options, onChunk?)` | `execute_shell` | `task::future(env, "shell.execute", ...)` | same as above |
| `pty.start(options, onChunk?)` | `PtySession::start` | `task::future(env, "pty.start", ...)` + inner `spawn_blocking` | `CancelToken` checked in sync PTY loop via `heartbeat()` |
| `htmlToMarkdown(html, options?)` | `html_to_markdown` | `task::blocking("html_to_markdown", (), ...)` | none (`()` token) |
| `PhotonImage.parse/encode/resize` | `PhotonImage::{parse,encode,resize}` | `task::blocking(...)` | none (`()` token) |
| `copyToClipboard/readImageFromClipboard` | `copy_to_clipboard` / `read_image_from_clipboard` | `task::blocking(...)` | none (`()` token) |

`text.rs` and `ps.rs` currently do not use `task::blocking`/`task::future` and therefore do not participate in this cancellation path.

## Cancellation lifecycle and state transitions

### `CancelToken` lifecycle

`CancelToken` is cooperative and stateful:

```text
Created
  ├─ no signal + no timeout  -> passive token (never aborts unless externally emplaced)
  ├─ signal registered        -> waits for AbortSignal callback
  └─ deadline set             -> timeout check becomes active

Running
  ├─ heartbeat()/wait() sees signal   -> AbortReason::Signal
  ├─ heartbeat()/wait() sees deadline -> AbortReason::Timeout
  ├─ wait() sees Ctrl-C               -> AbortReason::User
  └─ no abort                         -> continue

Aborted (terminal)
  └─ first abort reason wins (atomic flag + notifier)
```

### Before-start vs mid-execution cancellation

- **Before start / before first cancellation check**:
  - `task::future` users that race on `ct.wait()` can resolve cancel immediately once they enter `select!`.
  - `task::blocking` users only observe cancellation when closure code reaches `heartbeat()`. If closure does not heartbeat early, cancellation is delayed.

- **Mid-execution**:
  - `blocking`: next `heartbeat()` returns `Err("Aborted: ...")`.
  - `future`: `ct.wait()` branch wins `select!`, then code cancels subordinate async machinery (for shell: cancels Tokio token, waits up to 2s, then aborts task).

## Heartbeat expectations for long-running loops

`heartbeat()` must run at predictable cadence in loops with unbounded or large work sets.

Observed patterns:

- `glob::filter_entries`: check each entry before filtering/matching.
- `fd::score_entries`: check each scanned candidate.
- `grep_sync`: explicit cancellation check before heavy search phase, plus fs-cache calls that also receive token.
- `run_pty_sync`: check every loop tick (~16ms sleep cadence) and kill child on cancellation.

Practical rule: no loop over external-size input should exceed a short bounded interval without a heartbeat.

## Failure behavior and error propagation to JS

### Blocking tasks

Error path:

1. Closure returns `Err(napi::Error)` (including `heartbeat()` abort).
2. `Task::compute()` returns `Err`.
3. `AsyncTask` rejects JS promise.

Typical error strings:

- `Aborted: Timeout`
- `Aborted: Signal`
- domain errors (`Failed to decode image: ...`, `Conversion error: ...`, etc.)

### Future tasks

Error path:

1. Async body returns `Err(napi::Error)` or join failure is mapped (`... task failed: {err}`).
2. `task::future`-spawned promise rejects.
3. Some APIs intentionally return structured cancellation results instead of rejection (`ShellRunResult`/`ShellExecuteResult` with `cancelled`/`timed_out` flags and `exit_code: None`).

### Cancellation reporting split

- **Abort as error**: most blocking exports using `heartbeat()?`.
- **Abort as typed result**: shell/pty style command APIs that model cancellation in result structs.

Choose one model per API and document it explicitly.

## Common pitfalls

1. **Missing heartbeat in blocking loops**
   - Symptom: timeout/signal appears ignored until loop ends.
   - Fix: add `ct.heartbeat()?` at loop top and before expensive per-item steps.

2. **Long uncancelable sections**
   - Symptom: cancellation latency spikes during single large call (decode, sort, compression, etc.).
   - Fix: split work into chunks with heartbeat boundaries; if impossible, document latency.

3. **Blocking async executor**
   - Symptom: async API stalls when sync-heavy code runs directly in future.
   - Fix: move CPU/sync blocks to `task::blocking` or `tokio::task::spawn_blocking`.

4. **Inconsistent cancel semantics**
   - Symptom: one API rejects on cancel, another resolves with flags, confusing callers.
   - Fix: standardize per domain and keep wrapper docs aligned.

5. **Forgetting cancellation bridge in nested async tasks**
   - Symptom: outer token is cancelled but inner readers/subprocess tasks keep running.
   - Fix: bridge cancellation to inner token/signal and enforce grace timeout + forced abort fallback.

## Checklist for new cancellable exports

1. Classify work correctly:
   - CPU-bound or sync blocking -> `task::blocking`
   - async I/O / `await` orchestration -> `task::future`

2. Expose cancel inputs when needed:
   - include `timeoutMs` and `signal` in `#[napi(object)]` options
   - create `let ct = task::CancelToken::new(timeout_ms, signal);`

3. Wire cancellation through all layers:
   - blocking loops: `ct.heartbeat()?` at stable intervals
   - async orchestration: race with `ct.wait()` and cancel sub-tasks/tokens

4. Decide cancellation contract:
   - reject promise with abort error, or
   - resolve typed `{ cancelled, timedOut, ... }`
   - keep this contract consistent for the API family

5. Propagate failures with context:
   - map errors via `Error::from_reason(format!("...: {err}"))`
   - include stage-specific prefixes (`spawn`, `decode`, `wait`, etc.)

6. Handle before-start and mid-flight cancellation:
   - cancellation check/await must happen before expensive body and during long execution

7. Validate no executor misuse:
   - no long sync work directly inside async futures without `spawn_blocking`/blocking task wrapper
