# TUI runtime internals

This document maps the non-theme runtime path from terminal input to rendered output in interactive mode. It focuses on behavior in `packages/tui` and its integration from `packages/coding-agent` controllers.

> **Editing the rendering engine itself?** Read
> [`tui-core-renderer.md`](./tui-core-renderer.md) first — it documents the
> failure modes (yank / corruption / flash / width crashes) and the invariants
> the render planner, native-scrollback bookkeeping, and capability detection
> must not violate.

## Runtime layers and ownership

- **`packages/tui` engine**: terminal lifecycle, stdin normalization, focus routing, render scheduling, differential painting, overlay composition, hardware cursor placement.
- **`packages/coding-agent` interactive mode**: builds component tree, binds editor callbacks and keymaps, reacts to agent/session events, and translates domain state (streaming, tool execution, retries, plan mode) into UI components.

Boundary rule: the TUI engine is message-agnostic. It only knows `Component.render(width)`, `handleInput(data)`, focus, and overlays. Agent semantics stay in interactive controllers.

## Implementation files

- [`packages/coding-agent/src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`packages/coding-agent/src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)
- [`packages/coding-agent/src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`packages/coding-agent/src/modes/components/custom-editor.ts`](../packages/coding-agent/src/modes/components/custom-editor.ts)
- [`packages/tui/src/tui.ts`](../packages/tui/src/tui.ts)
- [`packages/tui/src/terminal.ts`](../packages/tui/src/terminal.ts)
- [`packages/tui/src/editor-component.ts`](../packages/tui/src/editor-component.ts)
- [`packages/tui/src/stdin-buffer.ts`](../packages/tui/src/stdin-buffer.ts)
- [`packages/tui/src/components/loader.ts`](../packages/tui/src/components/loader.ts)

## Boot and component tree assembly

`InteractiveMode` constructs `TUI(new ProcessTerminal(), settings.get("showHardwareCursor"))`, applies `tui.maxInlineImages` and Kitty text-sizing settings, then creates persistent containers:

- `chatContainer`
- `pendingMessagesContainer`
- `statusContainer`
- `todoContainer`
- `btwContainer`
- `omfgContainer`
- `errorBannerContainer`
- `statusLine`
- `hookWidgetContainerAbove`
- `editorContainer` (holds `CustomEditor`)
- `hookWidgetContainerBelow`

`init()` wires the tree in that order after any startup warnings/welcome/changelog, focuses the editor, registers input handlers via `InputController`, starts TUI, pushes terminal title state, updates the editor border, and requests a forced render.
A forced render (`requestRender(true)`) queues a viewport repaint or explicit session replacement; it does **not** throw away previous-line history by default.

## Terminal lifecycle and stdin normalization

`ProcessTerminal.start()`:

1. Enables raw mode and bracketed paste.
2. Attaches resize handler and refreshes dimensions.
3. Enables Windows VT input mode when running on win32.
4. Creates a `StdinBuffer` to split partial escape chunks into complete sequences.
5. Queries Kitty keyboard protocol support (`CSI ? u`), then enables protocol flags if supported; otherwise enables modifyOtherKeys fallback after a short timeout.
6. Queries OSC 11 background color and Mode 2031 appearance notifications for dark/light theme detection.
7. Queries OSC 99 notification capabilities.
8. Starts periodic OSC 11 polling only where safe, then probes DEC private modes 2026/2048/2031 via DECRQM.

`StdinBuffer` behavior:

- Buffers fragmented escape sequences (CSI/OSC/DCS/APC/SS3).
- Emits `data` only when a sequence is complete or timeout-flushed.
- Detects bracketed paste and emits a `paste` event with raw pasted text.

This prevents partial escape chunks from being misinterpreted as normal keypresses.

## Input routing and focus model

Input path:

`stdin -> ProcessTerminal -> StdinBuffer -> TUI.#handleInput -> focusedComponent.handleInput`

Routing details:

1. TUI runs registered input listeners first (`addInputListener`), allowing consume/transform behavior.
2. TUI handles global debug shortcut (`shift+ctrl+d`) before component dispatch.
3. If focused component belongs to an overlay that is now hidden/invisible, TUI reassigns focus to next visible overlay or saved pre-overlay focus.
4. Key release events are filtered unless focused component sets `wantsKeyRelease = true`.
5. After dispatch, TUI schedules render.

`setFocus()` also toggles `Focusable.focused`, which controls whether components emit `CURSOR_MARKER` for hardware cursor placement.

## Key handling split: editor vs controller

`CustomEditor` intercepts high-priority combos first (escape, ctrl-c/d/z, ctrl-v, ctrl-p variants, ctrl-t, alt-up, extension custom keys) and delegates the rest to base `Editor` behavior (text editing, history, autocomplete, cursor movement).

`InputController.setupKeyHandlers()` then binds editor callbacks to mode actions:

- cancellation / mode exits on `Escape`
- shutdown on double `Ctrl+C` or empty-editor `Ctrl+D`
- suspend/resume on `Ctrl+Z`
- slash-command and selector hotkeys
- follow-up/dequeue toggles and expansion toggles

This keeps key parsing/editor mechanics in `packages/tui` and mode semantics in coding-agent controllers.

## Render loop and the append-only contract

`TUI.requestRender()` coalesces render requests and rate-limits ordinary frames:

- forced renders (`requestRender(true, ...)`) schedule an immediate frame and force a full window rewrite; with `clearScrollback`, they trigger a destructive full paint (ED3 outside multiplexers)
- ordinary renders schedule through `#scheduleRender()` and respect `TUI.#MIN_RENDER_INTERVAL_MS`
- repeated requests while a render is pending collapse into the same scheduled frame

`#doRender()` pipeline:

1. Render root component tree, collecting the commit-boundary seam (`NativeScrollbackLiveRegion`) from the children.
2. Advance the append-only ledger: `windowTop = max(committedRows, frame.length - height)`, commit chunk = settled rows crossing the window top (never past the seam).
3. Extract and strip `CURSOR_MARKER`, normalize lines, slice the visible window, composite overlays into the window slice (screen coordinates; overlays freeze commits).
4. Emit one of: gesture-driven full paint (initial / session replace / resize), scroll-append (chunk rows only), in-window row diff, or seam rewrite (chunk + full window).

Native scrollback always equals the committed frame prefix — rows enter history exactly once, in order, when the seam says they are final. There are no viewport probes and no deferred reconciliation; see [`tui-core-renderer.md`](./tui-core-renderer.md).

Render writes use synchronized output mode (`CSI ? 2026 h/l`) when enabled; capability detection, DECRQM, or `PI_NO_SYNC_OUTPUT` can disable the wrappers while leaving autowrap discipline on.

## Render safety constraints

Critical safety checks in `TUI`:

- Non-image rendered lines are expected to fit terminal width; the differential path truncates overwide lines as a last-resort guard and can write debug diagnostics when redraw debugging is enabled.
- Overlay compositing includes defensive truncation and post-composite width guarding.
- Width changes force repaint/rebuild planning because wrapping semantics change.
- Cursor position is clamped before movement.

These constraints are runtime guards plus component conventions; renderers should still return width-safe lines rather than rely on truncation.

The deeper reasons these guards exist — why the renderer cannot observe scroll
position, why ED3 (`CSI 3 J`) is confined to one path, and why the hot path
clamps instead of throwing — are documented in
[`tui-core-renderer.md`](./tui-core-renderer.md).

## Resize handling

Resize events are event-driven from `ProcessTerminal` to `TUI.requestRender()`.

Effects:

- A resize is an explicit user gesture: outside multiplexers the engine erases and replays (`ED3` + full paint) so history rewraps at the new geometry; the commit ledger restarts from the replayed frame.
- Inside terminal multiplexers, resize repaints the visible window in place after a settle debounce (issue #2088); pane history keeps its old wrap, like any shell output, because pane scrollback cannot be erased safely.
- Overlay visibility can depend on terminal dimensions (`OverlayOptions.visible`); focus is corrected when overlays become non-visible after resize.

## Streaming and incremental UI updates

`EventController` subscribes to `AgentSessionEvent` and updates UI incrementally:

- `agent_start`: starts loader in `statusContainer`.
- `message_start` assistant: creates `streamingComponent` and mounts it.
- `message_update`: updates streaming assistant content; creates/updates tool execution components as tool calls appear.
- `tool_execution_update/end`: updates tool result components and completion state.
- `message_end`: finalizes assistant stream, handles aborted/error annotations, marks pending tool args complete on normal stop.
- `agent_end`: stops loaders, clears transient stream state, flushes deferred model switch, issues completion notification if backgrounded.

Read-tool grouping is intentionally stateful (`#lastReadGroup`) to coalesce consecutive read tool calls into one visual block until a non-read break occurs.

## Status and loader orchestration

Status lane ownership:

- `statusContainer` holds transient loaders (`loadingAnimation`, `autoCompactionLoader`, `retryLoader`).
- `statusLine` renders persistent status/hooks/plan indicators and drives editor top border updates.

Loader behavior:

- `Loader` updates every 80ms via interval and requests render each frame.
- Escape handlers are temporarily overridden during auto-compaction and auto-retry to cancel those operations.
- On end/cancel paths, controllers restore prior escape handlers and stop/clear loader components.

## Mode transitions and backgrounding

### Bash/Python input modes

Input text prefixes toggle editor border mode flags:

- `!` -> bash mode
- `$` (non-template literal prefix) -> python mode

Escape exits inactive mode by clearing editor text and restoring border color; when execution is active, escape aborts the running task instead.

### Plan mode

`InteractiveMode` tracks plan mode flags, status-line state, active tools, and model switching. Enter/exit updates session mode entries and status/UI state, including deferred model switch if streaming is active.

### Suspend/resume (`Ctrl+Z`)

`InputController.handleCtrlZ()`:

1. Registers one-shot `SIGCONT` handler to restart TUI and force render.
2. Stops TUI before suspend.
3. Sends `SIGTSTP` to process group.

## Cancellation paths

Primary cancellation inputs:

- `Escape` during active stream loader: restores queued messages to editor and aborts agent.
- `Escape` during bash/python execution: aborts running command.
- `Escape` during auto-compaction/retry: invokes dedicated abort methods through temporary escape handlers.
- `Ctrl+C` single press: clear editor; double press within 500ms: shutdown.

Cancellation is state-conditional; same key can mean abort, mode-exit, selector trigger, or no-op depending on runtime state.

## Event-driven vs throttled behavior

Event-driven updates:

- Agent session events (`EventController`)
- Key input callbacks (`InputController`)
- terminal resize callback
- terminal appearance callbacks, SIGWINCH theme reevaluation, and git branch watchers in `InteractiveMode`

Throttled/debounced paths:

- TUI rendering is tick-debounced (`requestRender` coalescing).
- Loader animation is fixed-interval (80ms), each frame requesting render.
- Editor autocomplete updates (inside `Editor`) use debounce timers, reducing recompute churn during typing.

The runtime therefore mixes event-driven state transitions with bounded render cadence to keep interactivity responsive without repaint storms.
