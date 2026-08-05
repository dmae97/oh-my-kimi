# Exit With Session Log Only

**Date:** 2026-08-05  
**Status:** Approved

## Goal

After a normal interactive OMK exit, remove the control-panel frame and leave only the readable session conversation in the terminal.

The final terminal output contains persisted user messages, assistant messages, and tool executions. It excludes the startup header, sidebar, footer, loaders, transient notices, prompt editor, and resume-command hint.

## Scope

Apply the final log frame to normal interactive exits:

- `Ctrl+D` with an empty editor
- the normal `Ctrl+C` exit path
- `/quit`
- extension-requested interactive shutdown

Keep the current fail-safe path for `SIGTERM`, `SIGHUP`, dead terminals, and emergency exits. Those paths prioritize extension cleanup and terminal restoration and do not attempt a transcript redraw.

The feature clears only the visible OMK viewport. It does not clear the terminal's scrollback, so shell history from before OMK remains available.

## Design

### Session-log source

Immediately before a normal shutdown, rebuild the chat container from `SessionManager.buildSessionContext()`. Reusing the persisted session context removes transient startup and status components while preserving the same message and tool rendering used when a session is resumed.

Render the rebuilt chat container at the terminal's full current width. The status-sidebar gutter is not reserved because the sidebar is absent from the final frame.

If rebuilding or rendering the final log throws, continue shutdown with the existing `ui.stop()` behavior. A presentation failure must not leave raw mode, keyboard protocols, or extension resources active.

### TUI final frame

Extend `TUI.stop()` with an optional final-lines argument. When final lines are supplied, it will:

1. mark the TUI stopped and cancel any queued render;
2. delete previously rendered Kitty images;
3. clear the visible screen and move the cursor home without clearing scrollback;
4. write the supplied lines once with line-style resets;
5. place the shell cursor on a fresh line;
6. restore cursor visibility, bracketed paste, keyboard protocols, stdin state, and raw mode through the existing terminal stop path.

When final lines are absent, `TUI.stop()` retains its current behavior. This keeps the TUI package backwards compatible and leaves signal/emergency shutdown unchanged.

### Interactive shutdown

`InteractiveMode.stop()` accepts whether a final session frame should be rendered. Normal interactive shutdown requests the final frame. Signal-triggered shutdown does not.

The existing `To resume this session:` output is removed from normal exit because the approved terminal contract is conversation-only.

## Error Handling

- Final-log rebuild/render failure: fall back to ordinary `ui.stop()` and continue runtime disposal.
- Terminal write failure: preserve the existing dead-terminal and emergency-exit handling.
- Empty session: clear the visible OMK frame, restore the terminal, and return the shell cursor at the top on a usable line.
- Long session: write the complete rendered conversation; terminal scrolling naturally retains it as scrollback.

## Tests

### TUI regression

Render a frame containing control-panel text, then stop with final lines containing only conversation text. Assert that:

- the final viewport contains the conversation;
- header/editor markers are absent;
- the cursor and terminal input mode are restored;
- ordinary `stop()` without final lines keeps existing behavior.

### Interactive-mode regression

Build a session with user, assistant, and tool messages plus transient chat/status components. Assert that normal stop:

- rebuilds from the persisted session context;
- passes only the rebuilt conversation lines to `TUI.stop()`;
- excludes transient UI text;
- does not print the resume hint.

Assert that signal shutdown calls the existing stop path without a final transcript redraw.

## Acceptance Criteria

1. A normal OMK exit leaves only the rendered conversation and tool results visible.
2. Header, sidebar, footer, loader, editor, status notices, and resume hint are absent.
3. Shell scrollback is not cleared.
4. Signal and emergency shutdown safety behavior is unchanged.
5. TUI and coding-agent regression tests, type checks, and builds pass.
