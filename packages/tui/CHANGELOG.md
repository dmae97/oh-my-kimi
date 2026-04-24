# Changelog

## [Unreleased]

## [14.1.1] - 2026-04-14

### Breaking Changes

- Removed the `searchDb` constructor argument from `CombinedAutocompleteProvider`, requiring callers to use the built-in search behavior

### Changed

- Changed truncation debug logging to run only when `debugRedraw` is enabled

### Fixed

- Fixed viewport jumping during streaming and session swap by tracking actual content height instead of high-water mark

## [14.0.5] - 2026-04-11

### Changed

- Updated hash computation to use `Bun.hash()` instead of `Bun.hash.xxHash64()`, which may return `number` in addition to `bigint`
- Simplified cache key computation in Box component by removing intermediate hash updates and consolidating hash operations
- Wrapped native text utility functions (`sliceWithWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `extractSegments`) to automatically pass the current default tab width, simplifying the API for consumers
- Added `getIndentationNoescape` wrapper that uses `process.cwd()` as the project root for relative file paths
- Re-export `getDefaultTabWidth`, `getIndentation`, and `setDefaultTabWidth` from `@oh-my-pi/pi-utils`; native text helpers still receive tab width via wrappers that read the JS default

## [13.16.1] - 2026-03-27

### Added

- Support for optional SearchDb parameter in CombinedAutocompleteProvider constructor for improved fuzzy search performance
- Fuzzy matching filter for autocomplete suggestions to improve relevance of results

### Changed

- Fuzzy discovery now applies fuzzy matching filter to results for improved relevance of autocomplete suggestions
- Autocomplete fuzzy discovery now accepts optional SearchDb instance for faster searches

## [13.16.0] - 2026-03-27
### Changed

- Updated tab replacement in editor text sanitization to respect configured tab width setting

## [13.15.0] - 2026-03-23

### Added

- Added `renderInlineMarkdown()` function to render inline markdown (bold, italic, code, links, strikethrough) to styled strings

### Fixed

- Fixed editor consuming user-rebound copy keys, preventing custom keybindings from working in the editor

## [13.14.1] - 2026-03-21
### Added

- Added Ctrl+_ as an additional default shortcut for undo

### Fixed

- Ensured undo functionality respects user-configured keybindings

## [13.12.0] - 2026-03-14

### Added

- Added `moveToMessageStart()` and `moveToMessageEnd()` methods to move cursor to the beginning and end of the entire message

### Fixed

- Fixed autocomplete to preserve `./` prefix when completing relative file and directory paths
- Fixed paste marker expansion to handle special regex replacement tokens ($1, $2, $&, $$, $`, $') literally in pasted content

## [13.11.0] - 2026-03-12
### Fixed

- Fixed OSC 11 background color detection to correctly handle partial escape sequences that arrive mid-buffer, preventing user input from being swallowed
- Fixed race condition where overlapping OSC 11 queries would be incorrectly cancelled by DA1 sentinels from previous queries

## [13.7.5] - 2026-03-04
### Changed

- Extracted word navigation logic into reusable `moveWordLeft` and `moveWordRight` utility functions for consistent cursor movement across components

## [13.6.2] - 2026-03-03
### Fixed

- Fixed cursor positioning when content shrinks to empty without clearOnShrink enabled

## [13.5.4] - 2026-03-01

### Fixed

- Fixed viewport repaint scrollback accounting during resize oscillation to avoid double-scrolling on height shrink and added exact-row scrollback assertions in overlay regression coverage ([#228](https://github.com/can1357/oh-my-pi/issues/228), [#234](https://github.com/can1357/oh-my-pi/issues/234))
## [13.5.3] - 2026-03-01

### Fixed

- Fixed append rendering logic to correctly handle offscreen header changes during content overflow growth, preserving scroll history integrity
- Fixed visible tail line updates when appending new content during viewport overflow conditions
- Fixed cursor positioning instability when appending content under external cursor relocation by using absolute screen addressing instead of relative cursor movement

## [13.5.2] - 2026-03-01
### Breaking Changes

- Removed `getMermaidImage` callback from MarkdownTheme; replaced with `getMermaidAscii` that accepts ASCII string instead of image data
- Removed mermaid module exports (`renderMermaidToPng`, `extractMermaidBlocks`, `prerenderMermaidBlocks`, `MermaidImage` interface)

### Changed

- Mermaid diagrams now render as ASCII text instead of terminal graphics protocol images

## [13.5.1] - 2026-03-01
### Fixed

- Fixed viewport shift handling to prevent stale content when mixed updates remap screen rows

## [13.5.0] - 2026-03-01

### Breaking Changes

- Removed `PI_TUI_RESIZE_CLEAR_STRATEGY`; resize behavior is no longer configurable between viewport/scrollback modes. The renderer now uses fixed semantics: width changes perform a hard reset (`3J` + full content rewrite), while height changes and diff fallbacks use viewport-scoped repainting.

### Added

- Added a new terminal regression suite in `packages/tui/test/render-regressions.test.ts` covering no-op render stability, targeted middle-line diffs, shrink cleanup, width-resize truncation without ghost rows, shrink/grow viewport tail anchoring, scrollback deduplication across forced redraws, overlay restore behavior, and rapid mutation convergence.
- Expanded `packages/tui/test/overlay-scroll.test.ts` with stress coverage for overflow shrink/regrow cycles, resize oscillation, overlay toggle churn, no-op render loops, and hardware-cursor-only updates while bounding scrollback growth and blank-run artifacts.

### Changed

- Refactored render orchestration to explicit `hardReset` and `viewportRepaint` paths, with targeted fallbacks for offscreen diff ranges and unsafe row deltas.
- Switched startup to `requestRender(true)` so the first frame always initializes renderer state with a forced full path.
- Replaced legacy viewport bookkeeping (`previousViewportTop`) with `viewportTopRow` tracking and consistent screen-relative cursor calculations.
- Updated stop-sequence cursor placement to target the visible working area and clamp to terminal bounds before final newline emission.
- Documented the intentional performance policy of not forcing full repaint on every viewport-top shift, relying on narrower safety guards instead.

### Fixed

- Fixed stale/duplicated terminal cursor dedup state by synchronizing `#lastCursorSequence` in all render write paths (hard reset, viewport repaint, deleted-lines clear path, append fast path, and differential path).
- Fixed scroll overshoot on `stop()` when content fills the viewport by clamping target row movement to valid screen rows.
## [13.4.0] - 2026-03-01

### Added

- Added `PI_TUI_RESIZE_CLEAR_STRATEGY` environment variable to control terminal behavior on resize: `viewport` (default) clears/redraws the viewport while preserving scrollback, or `scrollback` clears all history

### Changed

- Changed resize redraw behavior to use configurable clear semantics (`viewport` vs `scrollback`) while keeping full content rendering for scrollback navigation

### Fixed

- Fixed loader component rendering lines wider than terminal width, preventing text overflow and display artifacts

## [13.3.11] - 2026-02-28

### Fixed

- Restored terminal image protocol override and fallback detection for image rendering, including `PI_FORCE_IMAGE_PROTOCOL` support and Kitty fallback for screen/tmux/ghostty-style TERM environments.

## [13.3.8] - 2026-02-28
### Breaking Changes

- Changed mermaid hash type from string to bigint in `getMermaidImage` callback and `extractMermaidBlocks` return type
- Removed `mime-types` and `@types/mime-types` from dependencies
- Removed `@xterm/xterm` from dependencies

### Changed

- Updated mermaid hash computation to use `Bun.hash.xxHash64()` instead of `Bun.hash().toString(16)`

## [12.19.0] - 2026-02-22

### Added

- Added `getTopBorderAvailableWidth()` method to calculate available width for top border content accounting for border characters and padding

### Fixed

- Fixed stale viewport rows appearing when terminal height increases by triggering full re-render on height changes

## [12.18.0] - 2026-02-21
### Fixed

- Fixed viewport synchronization issue by clearing scrollback when terminal state becomes desynced during full re-renders

## [12.12.2] - 2026-02-19

### Fixed

- Fixed non-forced full re-renders clearing terminal scrollback history during streaming updates by limiting scrollback clears to explicit forced re-renders.

## [12.12.0] - 2026-02-19

### Added

- Added PageUp/PageDown navigation for editor content and autocomplete selection to jump across long wrapped inputs faster.

### Fixed

- Fixed history-entry navigation anchoring (Up opens at top, Down opens at bottom) and preserved editor scroll context when max-height changes to keep cursor movement visible in long prompts ([#99](https://github.com/can1357/oh-my-pi/issues/99)).

## [12.11.3] - 2026-02-19

### Fixed

- Fixed differential deleted-line rendering when content shrinks to empty so stale first-row content is cleared reliably.
- Fixed incremental stale-row clearing to use erase-below semantics in synchronized output, reducing leftover-line artifacts after shrink operations.

## [12.9.0] - 2026-02-17
### Added

- Exported `getTerminalId()` function to get a stable identifier for the current terminal, with support for TTY device paths and terminal multiplexers
- Exported `getTtyPath()` function to resolve the TTY device path for stdin via POSIX `ttyname(3)`

## [12.5.0] - 2026-02-15
### Added

- Added `cursorOverride` and `cursorOverrideWidth` properties to customize the end-of-text cursor glyph with ANSI-styled strings
- Added `getUseTerminalCursor()` method to query the terminal cursor mode setting

## [11.10.0] - 2026-02-10
### Added

- Added `hint` property to autocomplete items to display dim ghost text after cursor when item is selected
- Added `getInlineHint()` method to `SlashCommand` interface for providing inline hint text based on argument state
- Added `getInlineHint()` method to `AutocompleteProvider` interface for displaying dim ghost text after cursor
- Added `hintStyle` theme option to customize styling of inline hint/ghost text in editor

### Changed

- Updated editor to render inline hint text as dim ghost text after cursor when autocomplete suggestions are active or provider supplies hints

## [11.8.0] - 2026-02-10
### Added

- Added Alt+Y keybinding to cycle through kill ring entries (yank-pop)
- Added undo support to Input component with Ctrl+Z keybinding
- Added kill ring support to Input component for Emacs-style kill/yank operations
- Added yank (Ctrl+Y) and yank-pop (Alt+Y) support to Input component

### Changed

- Changed Editor kill ring implementation to use dedicated KillRing class for better state management
- Changed Editor undo stack to use generic UndoStack class with automatic state cloning
- Changed kill/yank behavior to properly accumulate consecutive kill operations
- Changed Input component deletion methods to record killed text in kill ring
- Changed undo coalescing in Input component to group consecutive word typing into single undo units

## [11.4.1] - 2026-02-06
### Fixed

- Fixed terminal scrolling when displaying overlays after rendering large content, preventing hundreds of blank lines from being output

## [11.3.0] - 2026-02-06

### Breaking Changes

- Removed `getCursorPosition()` method from Component interface and implementations, eliminating hardware cursor positioning support

### Added

- Added sticky column behavior for vertical cursor movement, preserving target column when navigating through lines of varying lengths
- Added `drainInput()` method to Terminal interface to prevent Kitty key release events from leaking to parent shell over slow SSH connections
- Added `setClearOnShrink()` method to control whether full re-render occurs when content shrinks below working area
- Added support for hidden paths (e.g., `.pi`, `.github`) in autocomplete while excluding `.git` directories

### Changed

- Changed default value of `PI_HARDWARE_CURSOR` environment variable from implicit true to explicit `"1"` for clarity
- Changed default value of `PI_CLEAR_ON_SHRINK` environment variable from implicit false to explicit `"0"` for clarity
- Changed TUI to clear screen on startup to prevent shell prompts and status messages from bleeding into the first rendered frame
- Refactored full-render logic into reusable helper function to reduce code duplication across multiple render paths
- Changed autocomplete to include hidden paths but filter out `.git` and its contents
- Changed Input component to properly handle surrogate pairs in Unicode text, preventing cursor display corruption with emoji and multi-byte characters
- Changed Editor to use `setCursorCol()` for all cursor column updates, enabling sticky column tracking
- Changed Editor's vertical navigation to implement sticky column logic via `moveToVisualLine()` and `computeVerticalMoveColumn()`
- Changed Editor's Enter key handling to extract submit logic into `submitValue()` method for better code organization
- Changed SettingsList to truncate long lines to viewport width, preventing text overflow
- Changed Terminal's `stop()` method to drain stdin before restoring raw mode, fixing race condition where Ctrl+D could close parent shell over SSH
- Changed TUI rendering to add `clearOnShrink` option (controlled by `PI_CLEAR_ON_SHRINK` env var) for reducing redraws on slower terminals
- Changed TUI rendering to detect when extra lines exceed viewport height and trigger full re-render instead of incremental updates

### Fixed

- Fixed rendering of extra blank lines when content shrinks by improving cursor positioning logic during line deletion
- Fixed cursor display position in Input component when scrolling horizontally through long text
- Fixed Kitty keyboard protocol disable sequence to use safe write method, preventing potential output buffering issues
- Fixed unnecessary full-screen redraws when changes occur in out-of-view components (e.g., spinners), reducing terminal scroll events and improving performance on slower connections
- Fixed scrollback clearing behavior to only clear screen instead of scrollback when resizing or shrinking content, preventing loss of terminal history
- Fixed `.git` directory appearing in autocomplete suggestions when filtering by prefix
- Fixed cursor position corruption in Input component when displaying text with emoji and combining characters
- Fixed `.git` directory appearing in autocomplete suggestions
- Fixed race condition where Kitty key release events could leak to parent shell after TUI exit over slow SSH connections
- Fixed Editor's word movement (Ctrl+Left/Right) to properly reset sticky column for subsequent vertical navigation
- Fixed Editor's undo operation to reset sticky column state when restoring cursor position
- Fixed Editor's right arrow key at end of last line to set sticky column for subsequent up/down navigation
- Fixed TUI rendering to correctly detect viewport changes and avoid false full-redraws after content shrinks
- Fixed Kitty protocol key parsing to prefer codepoint over base layout for Latin letters and symbols, fixing keyboard layout issues (e.g., Dvorak)

## [11.0.0] - 2026-02-05

### Added

- Introduced `terminal-capabilities.ts` module consolidating terminal detection and image protocol support
- Added `TerminalInfo` class with methods for detecting image lines and formatting notifications
- Added `NotifyProtocol` enum supporting Bell, OSC 99, and OSC 9 notification protocols
- Added `isNotificationSuppressed()` function to check `OMP_NOTIFICATIONS` environment variable
- Added `TERMINAL` constant providing detected terminal capabilities at runtime

### Changed

- Changed notification suppression environment variable from `OMP_NOTIFICATIONS` to `PI_NOTIFICATIONS`
- Changed TUI write log environment variable from `OMP_TUI_WRITE_LOG` to `PI_TUI_WRITE_LOG`
- Changed hardware cursor environment variable from `OMP_HARDWARE_CURSOR` to `PI_HARDWARE_CURSOR`
- Updated environment variable access to use `getEnv()` utility function from `@oh-my-pi/pi-utils` for consistent handling
- Renamed `TERMINAL_INFO` export to `TERMINAL` for clearer API semantics
- Reorganized terminal image exports from `terminal-image` to `terminal-capabilities` module
- Updated all internal references to use `TERMINAL` instead of `TERMINAL_INFO`

### Removed

- Removed `terminal-image` module exports from public API (functionality migrated to `terminal-capabilities`)

## [10.5.0] - 2026-02-04

### Fixed

- Treated inline image lines with cursor-move prefixes as image sequences to prevent width overflow crashes

## [9.8.0] - 2026-02-01

### Changed

- Moved `wrapTextWithAnsi` export to `@oh-my-pi/pi-natives` package

### Fixed

- Improved Kitty terminal key sequence parsing to correctly handle text field codepoints in CSI-u sequences
- Fixed handling of private use Unicode codepoints (U+E000 to U+F8FF) in Kitty key decoding to prevent invalid character interpretation

## [9.7.0] - 2026-02-01
### Breaking Changes

- Removed `Key` helper object from public API; use string literals like `"ctrl+c"` instead of `Key.ctrl("c")`
- Removed `KeyEventType` export from public API

### Changed

- Migrated key parsing and matching logic to native implementation for improved performance
- Simplified `isKeyRelease()` and `isKeyRepeat()` to use regex pattern matching instead of string inclusion checks

## [9.6.2] - 2026-02-01
### Changed

- Renamed `EllipsisKind` enum to `Ellipsis` for clearer API naming
- Changed hardcoded ellipsis character from theme-configurable to literal "…" in editor truncation
- Refactored `visibleWidth` function to use caching wrapper around new `visibleWidthRaw` implementation for improved performance

### Removed

- Removed `truncateToWidth`, `sliceWithWidth`, and `extractSegments` functions from public API (now re-exported directly from @oh-my-pi/pi-natives)
- Removed `ellipsis` property from `SymbolTheme` interface
- Removed `extractAnsiCode` function from public API

## [9.6.1] - 2026-02-01
### Changed

- Improved performance of key ID parsing with optimized cache lookup strategy
- Simplified `visibleWidth` calculation to use consistent Bun.stringWidth approach for all string lengths

### Removed

- Removed `visibleWidth` benchmark file in favor of Kitty sequence benchmarking

## [9.5.0] - 2026-02-01
### Changed

- Improved fuzzy file search performance by using native implementation instead of spawning external process
- Replaced external `fd` binary with native fuzzy path search for `@`-prefixed autocomplete

## [9.4.0] - 2026-01-31
### Added

- Exported `padding` utility function for creating space-padded strings efficiently

### Changed

- Optimized padding operations across all components to use pre-allocated space buffer for better performance

## [9.2.2] - 2026-01-31

### Added
- Added setAutocompleteMaxVisible() configuration (3-20 items)
- Added image detection to terminal capabilities (containsImage method)
- Added stdin monitoring to detect stalled input events and log warnings

### Changed
- Improved blockquote rendering with text wrapping in Markdown component
- Restructured terminal capabilities from interface-based to class-based model
- Improved table column width calculation with word-aware wrapping
- Refactored text utilities to use native WASM implementations for strings >256 chars with JS fast path

### Fixed
- Simplified terminal write error handling to mark terminal as dead on any write failure
- Fixed multi-line strings in renderOutputBlock causing width overflow
- Fixed slash command autocomplete applying stale completion when typing quickly

### Removed
- Removed TUI layout engine exports from public API (BoxNode, ColumnNode, LayoutNode, etc.)

## [8.12.7] - 2026-01-29

### Fixed
- Fixed slash command autocomplete applying stale completion when typing quickly

## [8.4.1] - 2026-01-25

### Added
- Added fuzzy match function for autocomplete suggestions
## [8.4.0] - 2026-01-25

### Changed
- Added Ctrl+Backspace as a delete-word-backward keybinding and improved modified backspace matching

### Fixed
- Terminal gracefully handles write failures by marking dead instead of exiting the process
- Reserved cursor space for zero padding and corrected end-of-line cursor rendering to prevent wrap glitches
- Corrected editor end-of-line cursor rendering assertion to use includes() instead of endsWith()
## [8.2.0] - 2026-01-24

### Added
- Added mermaid diagram rendering engine (renderMermaidToPng) with mmdc CLI integration
- Added terminal graphics encoding (iTerm2/Kitty) for mermaid diagrams with automatic width scaling
- Added mermaid block extraction and deduplication utilities (extractMermaidBlocks)

### Changed
- Updated TypeScript configuration for better publish-time configuration handling with tsconfig.publish.json
- Migrated file system operations from synchronous to asynchronous APIs in autocomplete provider for non-blocking I/O
- Migrated node module imports from named to namespace imports across all packages for consistency with project guidelines

### Fixed
- Fixed crash when terminal becomes unavailable (EIO errors) by exiting gracefully instead of throwing
- Fixed potential errors during emergency terminal restore when terminal is already dead
- Fixed autocomplete race condition by tracking request ID to prevent stale suggestion results
## [6.8.3] - 2026-01-21
### Added

- Added undo support in the editor via `Ctrl+-`
- Added `Alt+Delete` as a delete-word-forward shortcut
- Added configurable code block indentation for Markdown rendering
- Added undo support in the editor via `Ctrl+-`.
- Added configurable code block indentation for Markdown rendering.
- Added `Alt+Delete` as a delete-word-forward shortcut.

### Changed

- Improved fuzzy matching to handle alphanumeric swaps
- Normalized keybinding definitions to lowercase internally
- Improved fuzzy matching to handle alphanumeric swaps.
- Normalized keybinding definitions to lowercase internally.

### Fixed

- Added legacy terminal support for `Ctrl+` symbol key combinations
- Added legacy terminal support for `Ctrl+` symbol key combinations.

## [6.8.1] - 2026-01-20

### Fixed

- Fixed viewport tracking after partial renders to prevent autocomplete list artifacts

## [5.6.7] - 2026-01-18

### Added

- Added configurable editor padding via `editorPaddingX` theme option
- Added `setMaxHeight()` method to limit editor height with scrolling
- Added Emacs-style kill ring for text deletion operations
- Added `Alt+D` keybinding to delete words forward
- Added `Ctrl+Y` keybinding to yank from kill ring
- Added `waitForRender()` method to await pending renders
- Added Focusable interface and hardware cursor marker support for IME positioning
- Added support for shifted symbol keys in keybindings

### Changed

- Updated tab bar rendering to wrap text across multiple lines when content exceeds available width
- Expanded Kitty keyboard protocol coverage for non-Latin layouts and legacy Alt sequences
- Improved cursor positioning with safer bounds checking
- Updated editor layout to respect configurable padding
- Refactored scrolling logic for better viewport management

### Fixed

- Fixed key detection for shifted symbol characters
- Fixed backspace handling with additional codepoint support
- Fixed Alt+letter key combinations for better recognition

## [5.3.1] - 2026-01-15
### Fixed

- Fixed rendering issues on Windows by preventing re-entrant renders

## [5.1.0] - 2026-01-14

### Added

- Added `pageUp` and `pageDown` key support with `selectPageUp`/`selectPageDown` editor actions
- Added `isPageUp()` and `isPageDown()` helper functions
- Added `SizeValue` type for CSS-like overlay sizing (absolute or percentage strings like `"50%"`)
- Added `OverlayHandle` interface with `hide()`, `setHidden()`, `isHidden()` methods for overlay visibility control
- Added `visible` callback to `OverlayOptions` for dynamic visibility based on terminal dimensions
- Added `pad` parameter to `truncateToWidth()` for padding result with spaces to exact width

### Changed

- Changed `OverlayOptions` to use `SizeValue` type for `width`, `maxHeight`, `row`, and `col` properties
- Changed `showOverlay()` to return `OverlayHandle` for controlling overlay visibility
- Removed `widthPercent`, `maxHeightPercent`, `rowPercent`, `colPercent` from `OverlayOptions` (use percentage strings instead)

### Fixed

- Fixed numbered list items showing "1." for all items when code blocks break list continuity
- Fixed width overflow protection in overlay compositing to prevent TUI crashes

## [4.7.0] - 2026-01-12

### Fixed
- Remove trailing space padding from Text, Markdown, and TruncatedText components when no background color is set (fixes copied text including unwanted whitespace)

## [4.6.0] - 2026-01-12

### Added
- Add fuzzy matching module (`fuzzyMatch`, `fuzzyFilter`) for command autocomplete
- Add `getExpandedText()` to editor for expanding paste markers
- Add backslash+enter newline fallback for terminals without Kitty protocol

### Fixed
- Remove Kitty protocol query timeout that caused shift+enter delays
- Add bracketed paste check to prevent false key release/repeat detection
- Rendering optimizations: only re-render changed lines
- Refactor input component to use keybindings manager

## [4.4.4] - 2026-01-11
### Fixed

- Fixed Ctrl+Enter sequences to insert new lines in the editor

## [4.2.1] - 2026-01-11
### Changed

- Improved file autocomplete to show directory listing when typing `@` with no query, and fall back to prefix matching when fuzzy search returns no results

### Fixed

- Fixed editor redraw glitch when canceling autocomplete suggestions
- Fixed `fd` tool detection to automatically find `fd` or `fdfind` in PATH when not explicitly configured

## [4.1.0] - 2026-01-10
### Added

- Added persistent prompt history storage support via `setHistoryStorage()` method, allowing history to be saved and restored across sessions

## [4.0.0] - 2026-01-10
### Added

- `EditorComponent` interface for custom editor implementations
- `StdinBuffer` class to split batched stdin into individual sequences
- Overlay compositing via `TUI.showOverlay()` and `TUI.hideOverlay()` for `ctx.ui.custom()` with `{ overlay: true }`
- Kitty keyboard protocol flag 2 support for key release events (`isKeyRelease()`, `isKeyRepeat()`, `KeyEventType`)
- `setKittyProtocolActive()`, `isKittyProtocolActive()` for Kitty protocol state management
- `kittyProtocolActive` property on Terminal interface to query Kitty protocol state
- `Component.wantsKeyRelease` property to opt-in to key release events (default false)
- Input component `onEscape` callback for handling escape key presses

### Changed

- Terminal startup now queries Kitty protocol support before enabling event reporting
- Default editor `newLine` binding now uses `shift+enter` only

### Fixed

- Key presses no longer dropped when batched with other events over SSH
- TUI now filters out key release events by default, preventing double-processing of keys
- `matchesKey()` now correctly matches Kitty protocol sequences for unmodified letter keys
- Crash when pasting text with trailing whitespace exceeding terminal width through Markdown rendering

## [3.32.0] - 2026-01-08

### Fixed

- Fixed text wrapping allowing long whitespace tokens to exceed line width

## [3.20.0] - 2026-01-06
### Added

- Added `isCapsLock` helper function for detecting Caps Lock key press via Kitty protocol
- Added `isCtrlY` helper function for detecting Ctrl+Y keyboard input
- Added configurable editor keybindings with typed key identifiers and action matching
- Added word-wrapped editor rendering for long lines

### Changed

- Settings list descriptions now wrap to the available width instead of truncating

### Fixed

- Fixed Shift+Enter detection in legacy terminals that send ESC+CR sequence

## [3.15.1] - 2026-01-05

### Fixed

- Fixed editor cursor blinking by allowing terminal cursor positioning when enabled.

## [3.15.0] - 2026-01-05

### Added

- Added `inputCursor` symbol for customizing the text input cursor character
- Added `symbols` property to `EditorTheme`, `MarkdownTheme`, and `SelectListTheme` interfaces for component-level symbol customization
- Added `SymbolTheme` interface for customizing UI symbols including cursors, borders, spinners, and box-drawing characters
- Added support for custom spinner frames in the Loader component

## [3.9.1337] - 2026-01-04
### Added

- Added `setTopBorder()` method to Editor component for displaying custom status content in the top border
- Added `getWidth()` method to TUI class for retrieving terminal width
- Added rounded corner box-drawing characters to Editor component borders

### Changed

- Changed Editor component to use proper box borders with vertical side borders instead of horizontal-only borders
- Changed cursor style from block to thin blinking bar (▏) at end of line

## [1.500.0] - 2026-01-03
### Added

- Added `getText()` method to Text component for retrieving current text content

## [1.337.1] - 2026-01-02

### Added

- TabBar component for horizontal tab navigation
- Emergency terminal restore to prevent corrupted state on crashes
- Overhauled UI with welcome screen and powerline footer
- Theme-configurable HTML export colors
- `ctx.ui.theme` getter for styling status text with theme colors

### Changed

- Forked to @oh-my-pi scope with unified versioning across all packages

### Fixed

- Strip OSC 8 hyperlink sequences in `visibleWidth()`
- Crash on Unicode format characters in `visibleWidth()`
- Markdown code block syntax highlighting

## [1.337.0] - 2026-01-02

Initial release under @oh-my-pi scope. See previous releases at [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

## [0.31.1] - 2026-01-02

### Fixed

- `visibleWidth()` now strips OSC 8 hyperlink sequences, fixing text wrapping for clickable links ([#396](https://github.com/badlogic/pi-mono/pull/396) by [@Cursivez](https://github.com/Cursivez))

## [0.31.0] - 2026-01-02

### Added

- `isShiftCtrlO()` key detection function for Shift+Ctrl+O (Kitty protocol)
- `isShiftCtrlD()` key detection function for Shift+Ctrl+D (Kitty protocol)
- `TUI.onDebug` callback for global debug key handling (Shift+Ctrl+D)
- `wrapTextWithAnsi()` utility now exported (wraps text to width, preserving ANSI codes)

### Changed

- README.md completely rewritten with accurate component documentation, theme interfaces, and examples
- `visibleWidth()` reimplemented with grapheme-based width calculation, 10x faster on Bun and ~15% faster on Node ([#369](https://github.com/badlogic/pi-mono/pull/369) by [@nathyong](https://github.com/nathyong))

### Fixed

- Markdown component now renders HTML tags as plain text instead of silently dropping them ([#359](https://github.com/badlogic/pi-mono/issues/359))
- Crash in `visibleWidth()` and grapheme iteration when encountering undefined code points ([#372](https://github.com/badlogic/pi-mono/pull/372) by [@HACKE-RC](https://github.com/HACKE-RC))
- ZWJ emoji sequences (rainbow flag, family, etc.) now render with correct width instead of being split into multiple characters ([#369](https://github.com/badlogic/pi-mono/pull/369) by [@nathyong](https://github.com/nathyong))

## [0.29.0] - 2025-12-25

### Added

- **Auto-space before pasted file paths**: When pasting a file path (starting with `/`, `~`, or `.`) and the cursor is after a word character, a space is automatically prepended for better readability. Useful when dragging screenshots from macOS. ([#307](https://github.com/badlogic/pi-mono/pull/307) by [@mitsuhiko](https://github.com/mitsuhiko))
- **Word navigation for Input component**: Added Ctrl+Left/Right and Alt+Left/Right support for word-by-word cursor movement. ([#306](https://github.com/badlogic/pi-mono/pull/306) by [@kim0](https://github.com/kim0))
- **Full Unicode input**: Input component now accepts Unicode characters beyond ASCII. ([#306](https://github.com/badlogic/pi-mono/pull/306) by [@kim0](https://github.com/kim0))

### Fixed

- **Readline-style Ctrl+W**: Now skips trailing whitespace before deleting the preceding word, matching standard readline behavior. ([#306](https://github.com/badlogic/pi-mono/pull/306) by [@kim0](https://github.com/kim0))