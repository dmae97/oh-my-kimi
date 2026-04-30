# Natives Shell, PTY, Process, and Key Internals

This document covers the **execution/process/terminal primitives** in `@oh-my-pi/pi-natives`: `shell`, `pty`, `ps`, and `keys`, using the architecture terms from `docs/natives-architecture.md`.

## Implementation files

- `crates/pi-natives/src/shell.rs`
- `crates/pi-natives/src/shell/windows.rs` (Windows only)
- `crates/pi-natives/src/pty.rs`
- `crates/pi-natives/src/ps.rs`
- `crates/pi-natives/src/keys.rs`
- `crates/pi-natives/src/task.rs` (shared cancellation behavior used by shell/pty)
- `packages/natives/src/shell/index.ts`
- `packages/natives/src/shell/types.ts`
- `packages/natives/src/pty/index.ts`
- `packages/natives/src/pty/types.ts`
- `packages/natives/src/ps/index.ts`
- `packages/natives/src/ps/types.ts`
- `packages/natives/src/keys/index.ts`
- `packages/natives/src/keys/types.ts`
- `packages/natives/src/bindings.ts`

## Layer ownership

- **TS wrapper/API layer** (`packages/natives/src/*`): typed entrypoints, cancellation surface (`timeoutMs`, `AbortSignal`), and JS ergonomics.
- **Rust N-API module layer** (`crates/pi-natives/src/*`): shell/PTY process execution, process-tree traversal/termination, and key-sequence parsing.
- **Validation gate** (`native.ts`, architecture-level): ensures required exports (`Shell`, `executeShell`, `PtySession`, `killTree`, `listDescendants`, key helpers) exist before wrappers are used.

## Shell subsystem (`shell`)

### API model

Two execution modes are exposed:

1. **One-shot** via `executeShell(options, onChunk?)`.
2. **Persistent session** via `new Shell(options?)` then `shell.run(...)` repeatedly.

Both stream output through a threadsafe callback and return `{ exitCode?, cancelled, timedOut }`.

### Session creation and environment model

Rust creates `brush_core::Shell` with:

- non-interactive mode,
- `do_not_inherit_env: true`,
- explicit environment reconstruction from host env,
- skip-list for shell-sensitive vars (`PS1`, `PWD`, `SHLVL`, bash function exports, etc.).

Session env behavior:

- `ShellOptions.sessionEnv` is applied once at session creation.
- `ShellRunOptions.env` is command-scoped (`EnvironmentScope::Command`) and popped after each run.
- `PATH` is merged specially on Windows with case-insensitive dedupe.

Windows-only path enrichment (`shell/windows.rs`): discovered Git-for-Windows paths (`cmd`, `bin`, `usr/bin`) are appended if present and not already included.

### Runtime lifecycle and state transitions

Persistent shell (`Shell.run`) uses this state machine:

- **Idle/Uninitialized**: `session: None`.
- **Running**: first `run()` lazily creates session, stores `current_abort` token, executes command.
- **Completed + keepalive**: if execution control flow is `Normal`, `current_abort` is cleared and session is reused.
- **Completed + teardown**: if control flow is loop/script/shell-exit related (`BreakLoop`, `ContinueLoop`, `ReturnFromFunctionOrScript`, `ExitShell`), session is dropped (`session: None`).
- **Cancelled/Timed out**: run task is cancelled, grace wait (2s), then force-abort; session is dropped.
- **Error**: session is dropped.

One-shot shell (`executeShell`) always creates and drops a fresh session per call.

### Streaming/output behavior

- Stdout/stderr are routed into a shared pipe and read concurrently.
- Reader decodes UTF-8 incrementally; invalid byte sequences emit `U+FFFD` replacement chunks.
- After process completion, output drain has idle/max guards (`250ms` idle, `2s` max) to avoid hanging on background jobs keeping descriptors open.

### Cancellation, timeout, and background jobs

- `CancelToken` is constructed from `timeoutMs` and optional `AbortSignal`.
- On cancellation/timeout, shell cancellation token is triggered, then task gets a 2s graceful window before forced abort.
- If cancellation occurs, background jobs are terminated (`TERM`, then delayed `KILL`) using brush job metadata.

`Shell.abort()` behavior:

- aborts only current running command for that `Shell` instance,
- no-op success when nothing is running.

### Failure behavior

Common surfaced errors include:

- session init failures (`Failed to initialize shell`),
- cwd errors (`Failed to set cwd`),
- env set/pop failures,
- snapshot source failures,
- pipe creation/clone failures,
- execution failure (`Shell execution failed: ...`),
- task wrapper failures (`Shell execution task failed: ...`).

Result-level cancellation flags:

- timeout -> `exitCode: undefined`, `timedOut: true`.
- abort signal -> `exitCode: undefined`, `cancelled: true`.

## PTY subsystem (`pty`)

### API model

`new PtySession()` exposes:

- `start(options, onChunk?) -> Promise<{ exitCode?, cancelled, timedOut }>`
- `write(data)`
- `resize(cols, rows)`
- `kill()`

### Runtime lifecycle and state transitions

`PtySession` state machine:

- **Idle**: `core: None`.
- **Reserved**: `start()` installs control channel synchronously (`core: Some`) before async work begins, so `write/resize/kill` become immediately valid.
- **Running**: blocking PTY loop handles child state, reader events, cancellation heartbeat, and control messages.
- **Terminal closed**: child exit + reader completion.
- **Finalized**: `core` is always reset to `None` after start task completion (success or error).

Concurrency guard:

- starting while already running returns `PTY session already running`.

### Spawn/attach/write/read/terminate patterns

- PTY opened via `portable_pty::native_pty_system().openpty(...)`.
- Command currently runs as `sh -lc <command>` with optional `cwd` and env overrides.
- `write()` sends raw bytes to PTY stdin.
- `resize()` clamps dimensions (`cols 20..400`, `rows 5..200`) and calls master resize.
- `kill()` marks run as cancelled and kills child process.

Output path:

- dedicated reader thread reads master stream,
- incremental UTF-8 decode with `U+FFFD` replacement on invalid bytes,
- chunks forwarded through N-API threadsafe callback.

### Cancellation and timeout semantics

- `timeoutMs` and `AbortSignal` feed a `CancelToken`.
- loop calls `ct.heartbeat()` periodically; abort triggers child kill.
- timeout classification is string-based (`"Timeout"` substring in heartbeat error).

### Failure behavior

Error surfaces include:

- PTY allocation/open failure,
- PTY spawn failure,
- writer/reader acquisition failure,
- child status/wait failures,
- lock poisoning,
- control-channel disconnection (`PTY session is no longer available`).

Control call failures when not running:

- `write/resize/kill` return `PTY session is not running`.

## Process-tree subsystem (`ps`)

### API model

- `killTree(pid, signal) -> number`
- `listDescendants(pid) -> number[]`

TS wrapper also registers native kill-tree integration into shared utils via `setNativeKillTree(native.killTree)`.

### Platform-specific implementation

- **Linux**: recursively reads `/proc/<pid>/task/<pid>/children`.
- **macOS**: uses `libproc` `proc_listchildpids`.
- **Windows**: snapshots process table with `CreateToolhelp32Snapshot`, builds parent->children map, terminates with `OpenProcess(PROCESS_TERMINATE)` + `TerminateProcess`.

### Kill-tree behavior

- Descendants are collected recursively.
- Kill order is bottom-up (deepest descendants first) to reduce orphan re-parenting.
- Root pid is killed last.
- Return value is count of successful terminations.

Signal behavior:

- POSIX: provided `signal` is passed to `kill`.
- Windows: `signal` is ignored; termination is unconditional process terminate.

### Failure behavior

This module is intentionally non-throwing at API surface:

- missing/inaccessible process tree branches are skipped,
- per-pid kill failures are counted as unsuccessful (not errors),
- lookup miss typically yields `[]` from `listDescendants` and `0` from `killTree`.

## Key parsing subsystem (`keys`)

### API model

Exposed helpers:

- `parseKey(data, kittyProtocolActive)`
- `matchesKey(data, keyId, kittyProtocolActive)`
- `parseKittySequence(data)`
- `matchesKittySequence(data, expectedCodepoint, expectedModifier)`
- `matchesLegacySequence(data, keyName)`

### Parsing model

The parser combines:

- direct single-byte mappings (`enter`, `tab`, `ctrl+<letter>`, printable ASCII),
- O(1) legacy escape-sequence lookup (PHF map),
- xterm `modifyOtherKeys` parsing,
- Kitty protocol parsing (`CSI u`, `CSI ~`, `CSI 1;...<letter>`),
- normalization to key IDs (`ctrl+c`, `shift+tab`, `pageUp`, `f5`, etc.).

Modifier handling:

- only shift/alt/ctrl bits are compared for key matching,
- lock bits are masked out before comparisons.

Layout behavior:

- base-layout fallback is intentionally constrained so remapped layouts do not create false matches for ASCII letters/symbols.

### Failure behavior

- Unrecognized or invalid sequences produce `null` from parse functions.
- Match functions return `false` on parse failure or mismatch.
- No thrown error surface for malformed key input.

## JS wrapper API ↔ Rust export mapping

### Shell + PTY + Process

| TS wrapper API | Rust N-API export | Notes |
|---|---|---|
| `executeShell(options, onChunk?)` | `executeShell` (`execute_shell`) | One-shot shell execution |
| `new Shell(options?)` | `Shell` class | Persistent shell session |
| `shell.run(options, onChunk?)` | `Shell::run` | Reuses session on keepalive control flow |
| `shell.abort()` | `Shell::abort` | Aborts active run for that shell instance |
| `new PtySession()` | `PtySession` class | Stateful PTY session |
| `pty.start(options, onChunk?)` | `PtySession::start` | Interactive PTY run |
| `pty.write(data)` | `PtySession::write` | Raw stdin passthrough |
| `pty.resize(cols, rows)` | `PtySession::resize` | Clamped terminal dimensions |
| `pty.kill()` | `PtySession::kill` | Force-kills active PTY child |
| `killTree(pid, signal)` | `killTree` (`kill_tree`) | Children-first process tree termination |
| `listDescendants(pid)` | `listDescendants` (`list_descendants`) | Recursive descendants listing |

### Keys

| TS wrapper API | Rust N-API export | Notes |
|---|---|---|
| `matchesKittySequence(data, cp, mod)` | `matchesKittySequence` (`matches_kitty_sequence`) | Kitty codepoint+modifier match |
| `parseKey(data, kittyProtocolActive)` | `parseKey` (`parse_key`) | Normalized key-id parser |
| `matchesLegacySequence(data, keyName)` | `matchesLegacySequence` (`matches_legacy_sequence`) | Exact legacy sequence map check |
| `parseKittySequence(data)` | `parseKittySequence` (`parse_kitty_sequence`) | Structured Kitty parse result |
| `matchesKey(data, keyId, kittyProtocolActive)` | `matchesKey` (`matches_key`) | High-level key matcher |

## Abandoned session cleanup and finalization notes

- **Shell persistent session**: if a run is cancelled/timed out/errors/non-keepalive control flow, Rust explicitly drops the internal session state. Successful normal runs keep the session for reuse.
- **PTY session**: `core` is always cleared after `start()` finishes, including failure paths.
- **No explicit JS finalizer-driven kill contract** is exposed by wrappers; cleanup is primarily tied to run completion/cancellation paths. Callers should use `timeoutMs`, `AbortSignal`, `shell.abort()`, or `pty.kill()` for deterministic teardown.
