# Changelog

## [Unreleased]

### Added

- `PI_FORCE_HYPERLINKS=1` / `PI_NO_HYPERLINKS=1` env overrides for the OSC 8 hyperlink capability, mirroring the `PI_FORCE_SYNC_OUTPUT`/`PI_NO_SYNC_OUTPUT` shape (opt-out beats force-on).

### Changed

- Auto-enable OSC 8 hyperlinks inside tmux when tmux self-reports >= 3.4 via `TERM_PROGRAM_VERSION`; tmux 3.4 stores OSC 8 as a cell attribute and forwards it to outer terminals whose `terminal-features` include `hyperlinks`. Older tmux, GNU screen, and tmux without a reported version still default off. Resolution is factored into `hyperlinksUserOverride()` and `shouldEnableHyperlinksByDefault()` mirroring the sync-output helpers ([#2403](https://github.com/can1357/oh-my-pi/issues/2403)).

## [15.11.8] - 2026-06-12

### Changed

- Markdown rendering during streaming re-lexes only the grown tail instead of the whole buffer on every reveal tick. marked has no resumable lexer, but block tokenization is local across a blank-line boundary with balanced fences, so the largest blank-line-bounded prefix's block tokens are frozen and reused (`lex(prefix) ++ lex(tail)`), with a full-lex fallback for non-append edits, reference-link definitions, and CRLF input. The output is byte-identical to a full lex (covered by a contract test), turning the O(N²) cost of revealing a long single-block message into O(N): a 6,000-grapheme reveal dropped from ~575 ms to ~89 ms of CPU in benchmarks.

## [15.11.5] - 2026-06-12

### Added

- Added `fuzzyRank` to return sorted matches together with a fuzzy score
- Added a configurable `Input.prompt` field (defaults to `"> "`; set to `""` for chrome-less embedding inside custom banners)

### Changed

- Changed fuzzy matching to normalize queries and text into words, including camelCase and punctuation separators, before scoring
- Changed `Input.setValue` to place the cursor at the end of the new value instead of clamping it to its previous position, so typing after seeding a prefilled value appends rather than prepends

### Fixed

- Fixed multi-word searches so `fuzzyMatch` no longer matches when query letters are only scattered across unrelated words

## [15.11.4] - 2026-06-12

### Added

- Added `partialHoldTimeout` to `StdinBufferOptions` to control the maximum extra delay held for unambiguous incomplete escape sequences before they are flushed
- Added `SettingsList.sidebarWidth` option for a fixed split-layout sidebar width
- Added mouse pointer support APIs to `SettingsList` with `setHoverItem`, `hitTest`, `hoverTest`, and `routeSubmenuMouse` for row targeting and submenu routing
- Added `SettingsList.setMaxVisible(rows)` and `SettingsList.handleWheel(delta)` for dynamic viewport sizing and mouse-wheel step selection
- Added compact tab features with new `Tab.short` labels and `TabBar.selectTab(id)` for id-based activation of non-muted tabs
- Added pointer-hover and hit-testing APIs to `TabBar` with `setHoverTab`, `tabAt`, and `hoverTab` theme
- Added exported SGR mouse utilities `parseSgrMouse`, `SgrMouseEvent`, and `MouseRoutable`
- Added section support to `SettingsList`: `SettingItem.heading` rows split the list into sections, PgUp/PgDn (`tui.select.pageUp`/`pageDown`) jump between sections (or page when none exist), and wide renders use a split layout — section sidebar on the left, the active section's items on the right — falling back to inline heading rows when the width cannot fit both panes. Headings are skipped by navigation, excluded from search, and styled through the optional `SettingsListTheme.heading` (which receives a `dimmed` flag for headings outside the active section) and `section`.
- Added a host-integration surface to `SettingsList`: a `SettingsListOptions` constructor arg (`layout` to force the flat layout, `typeToSearch: false` to hand the query to a parent, `emptyText`, `hint`), `selectItem(id)`, `getSelectedItem()`, `onSelectionChange`, `hasOpenSubmenu()`, and the exported `getSettingItemFilterText` helper.
- Added keyboard section focus to `SettingsList`: `toggleSectionFocus()` / `sectionFocused` / `hasSectionFocusTargets()` flip Up/Down between row navigation and whole-section jumps — the cursor glyph parks on the active sidebar entry (or the active heading row in the flat layout) while the row cursor hides, Enter/Esc drop focus back to the rows, and any explicit row selection (`selectItem`, wheel, filtering) exits it.
- Added muted tabs to `TabBar` (`Tab.muted` + `TabBarTheme.mutedTab`, skipped by keyboard navigation), `setTabs(tabs, activeId?)`/`setActiveById(id)` for re-rendering the strip without firing `onTabChange`, an optional empty label (drops the `Label:` prefix), and a `showHint` switch for the trailing "(tab to cycle)" hint.

### Changed

- Changed `SettingsList` section-focused keyboard handling so `Up`/`Down` now jump between sections and `Enter`/`Escape` exit section focus before confirming or cancelling a setting
- Changed `SettingsList` split layout at wide widths to render the full list in the right pane and dim items outside the active section instead of showing only the active-section rows
- Changed `SettingsList` to omit the default hint row (and preceding blank line) when `options.hint` is set to an empty string
- Changed tab-bar overflow handling to collapse tabs to their `short` forms before wrapping to multiple lines

### Fixed

- Fixed `StdinBuffer` handling of split SGR mouse reports so fragmented sequences are reassembled instead of leaking their tail bytes as literal input
- Fixed Esc being unreliable (or seconds-slow) inside fullscreen overlays such as `/settings` on kitty-protocol terminals (Ghostty/kitty): the kitty keyboard mode stack is per-screen, so entering the alternate screen silently reverted keys to legacy encoding while the app still parsed them as kitty input. The TUI now re-pushes the active kitty flags right after `\x1b[?1049h` and pops them before `\x1b[?1049l`.
- Fixed `StdinBuffer` tearing a buffered bare `ESC` followed by another escape sequence: the `\x1b\x1b` candidate was consumed as alt+esc before the CSI/SS3 continuation byte was ever inspected, swallowing the Esc keypress and leaking the follower's tail (`[B`, `[<35;22;17M`) as typed text into focused components. Meta-CSI chords (`\x1b\x1b[A`) now stay whole, and `ESC` + SGR mouse report is split into a real Esc keypress plus a parseable report.
- Lowered `PARTIAL_HOLD_MAX_MS` from 500ms to 150ms so a dangling escape partial that never completes (e.g. a bare `ESC` arriving while the kitty-active flag is stale) is delivered after at most ~200ms instead of half a second.
- Fixed deferred partial-flush behavior so pending incomplete escapes are not split across timer boundaries and can still complete when the next chunk arrives
- Fixed kitty keyboard-mode handling of a dangling `ESC` so it can be joined with subsequent CSI mouse/kitty input instead of being emitted as a standalone sequence
- Fixed `SettingsList` to clear section-focus state when filtering items, changing data, scrolling with the mouse wheel, or selecting by ID so stale heading focus does not persist across interactions
- `SettingsList` now renders every state — list, open submenu, filtered results, empty — at one stable height, so interacting with a bottom-anchored settings panel no longer resizes the live terminal region on each keystroke (which forced re-anchoring and could strand stale scrollback rows).

## [15.11.3] - 2026-06-11

### Fixed

- Fixed the root compose letting a lower child's native-scrollback live seam overwrite a higher one: the topmost seam (and its commit-safe extension) now defines the commit boundary, so a status loader below a streaming transcript can no longer cause still-mutable transcript rows to be committed as stale history ([#2328](https://github.com/can1357/oh-my-pi/pull/2328)).

## [15.11.2] - 2026-06-11

### Fixed

- Fixed Ctrl+C/exit corrupting the parent shell on Windows: `emergencyTerminalRestore()` wrote `\x1b[?1049l` (leave alternate screen) unconditionally on every exit path, and conhost/Windows Terminal execute an unconditional cursor restore for it even when the alt buffer was never entered — with no prior save the cursor jumped to the viewport home, so the shell prompt landed on top of the dead frame. The leave sequence is now gated on tracked alt-screen state (set/cleared by the TUI's fullscreen-overlay enter/leave and stop paths).
- Skipped native syntax highlighting for transient markdown streaming renders, including nested list code blocks, leaving code blocks plain until their content stabilizes to avoid main-thread highlighter spikes.

## [15.11.1] - 2026-06-11

### Added

- Added `TUI.requestComponentRender(component)` to schedule component-scoped renders for self-contained updates

### Changed

- Changed the render pipeline to reuse only affected root subtrees for component-scoped updates, avoiding full-tree compose when animations or other isolated component changes occur

### Fixed

- Fixed component-scoped renders to preserve prior live scrollback seam data for skipped root children, preventing duplicate or missing rows during spinner-only updates
- Reported committed native scrollback row counts to interested child components so immutable history can be skipped without breaking live-region commit bookkeeping.
- Fixed `ProcessTerminal` treating asynchronous stdout `EIO` errors as uncaught exceptions: stdout `error` events now mark the terminal dead, disable future renders, and keep the active session process alive ([#2284](https://github.com/can1357/oh-my-pi/issues/2284)).

## [15.11.0] - 2026-06-10

### Added

- Added support for asynchronous `onSubmit` handlers by allowing the callback to return a `Promise<void>`

## [15.10.11] - 2026-06-10

### Added

- `SettingsList` now supports type-to-search filtering with Escape clearing an active query before canceling.

### Changed

- Preserved list selection by item ID when replacing settings so focus stays on the same setting
- Displayed a no matching settings message and search-editing hint when filtering returns no matches
- Expanded settings search matching to include IDs, current values, descriptions, and option values as well as labels
- Raised the stdin split-escape flush window from 10ms to 50ms: over laggy links (ssh, slow multiplexers) a CSI sequence split across reads was flushed as literal data, leaking `[` + `A` style fragments into the editor as typed text
- Lengthened the OSC 11 appearance poll on terminals without Mode 2031 from 2s to 30s — each poll's query write cleared the user's active text selection, breaking copy every two seconds on Alacritty/Warp/older WezTerm
- Rewrote `StdinBuffer.extractCompleteSequences` to index-based scanning: the previous per-iteration `slice` + `Array.from(remaining)[0]` made plain-text bursts O(n²), turning a 100KB non-bracketed paste into a multi-second freeze
- Capped the editor undo stack at 100 entries with word-level coalescing of consecutive single-character inserts (matching `Input`), capped the kill ring at 60 entries, cached word-wrap layout per (line, width) so each render and key handler shares one wrap pass, and batched ≤1000-char single-line pastes into one insert + one trigger-detection pass instead of per-character replay
- Virtualized the frame pipeline around a stable-prefix contract — the renderer no longer does O(total transcript) work per frame. `Component.render` now returns `readonly string[]`: results are component-owned, callers must not mutate them, and an unchanged component returns the same array reference (reference equality proves byte-identical rows). `Container.render` memoizes its concatenation on child references (children are still rendered every frame for their side effects); `Box` replaced its content-hashing cache with the same child-reference memo (no more per-frame `leftPad + line` rebuilds and full-content hashing); `Markdown`, `Spacer`, and `TruncatedText` return their cached arrays by reference instead of defensive copies. The TUI composes a persistent frame from per-child segments and an opt-in `RenderStablePrefix` report (consumable floor semantics for in-place mutators like the transcript), so marker extraction, line preparation (persistent prepared-frame replacing the per-frame rebuilt cache arrays), and the committed-prefix audit now run only over rows at/after the first changed row instead of every line of the transcript every frame
- Rewrote the render core around an append-only native-scrollback contract. Committed rows are immutable: rows enter terminal history exactly once, in order, when the component-reported commit boundary (`NativeScrollbackLiveRegion`) marks them final, and the visible window repaints in place with relative moves. The engine no longer probes the terminal's scroll position or guesses whether a destructive rebuild is safe — the entire ED3-risk/defer/checkpoint machinery (viewport probes, eager streaming mode, dirty-scrollback reconciliation, deferred shrink/mutation intents, streaming high-water rebuilds, ConPTY-specific defer paths) is deleted. ED3 (`CSI 3 J`) now fires only on explicit user gestures: session replace, resize outside multiplexers, and `resetDisplay()`. This structurally removes the yank / flash / duplicated-rows / invisible-until-resize failure families tracked across #1610, #1635, #1651, #1682, #1719, #1746, #1799, #1823, #1962, #1974, #2000, #2011, #2154.
- A frame that shrinks into its committed prefix re-anchors the visible window at the new tail and restarts commit bookkeeping; previously committed rows stay in history (history is never rewritten without a gesture).
- Overlays now composite into the visible window slice only and freeze commits while visible, so overlay pixels can never enter native scrollback and closing an overlay no longer triggers a destructive history rebuild.
- Inline-image budget demotion now deletes the demoted image's graphics by id and lets the window diff repaint the text fallback — no more mid-session destructive full replay when the image cap is exceeded.
- The render-stress harness now validates the contract with a shadow commit ledger (an independent reimplementation of the ledger math fed only by observed frames and bytes), asserting scrollback equals the committed prefix row-for-row and that tape growth matches physical scroll exactly, across randomized op sequences, resizes, overlays, and multiplexer scenarios. The ghostty-web virtual terminal additionally survives libghostty-vt 0.4's WASM allocator traps via an event-log replay/compaction recovery, and strips non-spacing combining marks on input (a margin-aligned combining cluster deterministically corrupts that engine; mark placement through it was already unverifiable).

### Fixed

- Fixed Windows rendering degrading into CP437 mojibake (`Γöé`/`ΓöÇ` instead of box-drawing borders and Nerd Font glyphs) after a console-sharing child process changed the console codepage (e.g. PHP CLI's implicit `chcp`, php.net request #73716): the breakage stayed latent until the next full repaint such as ctrl+o expand. The terminal now re-asserts the UTF-8 codepage (output and input) before each stdout write
- Fixed crash recovery leaving the shell unusable: `emergencyTerminalRestore` (and `terminal.stop()`) never left the alt screen nor disabled mouse tracking, so a crash during a fullscreen overlay stranded the user on the alternate buffer with any-motion mouse reporting spewing escape garbage until a manual `reset`
- Fixed bracketed paste with a lost `ESC[201~` end marker (ssh/tmux truncation) silently eating all subsequent input forever while growing memory unboundedly — paste mode now has an inactivity watchdog (1s) and a byte cap (64 MiB) that exit paste mode and deliver the accumulated bytes through the paste event
- Fixed vertical cursor movement using UTF-16 code units as visual columns: Up/Down over emoji/CJK lines could land the cursor mid-surrogate-pair, rendering a lone surrogate and permanently corrupting the buffer on the next insert; movement now walks graphemes and snaps the target offset to a cluster boundary, also fixing column drift across wide glyphs
- Fixed cursor positions inside whitespace trimmed at a word-wrap boundary mapping to no layout line — the cursor vanished and the viewport jumped to the buffer's last line; the preceding chunk now owns the skipped whitespace run
- Fixed word-delete and kill-to-line operations (Ctrl+W/Alt+D/Ctrl+U/Ctrl+K) cutting through atomic paste markers, leaving `[Paste #1, +30` junk that no longer expanded to the pasted content on submit — delete ranges now extend over any atomic token they intersect
- Fixed the kitty CSI-u printable dedup swallowing a real keystroke arbitrarily long after the duplicated event; the pending codepoint now expires after 25ms
- Fixed `resetDisplay()` being a no-op on the alt screen: the redraw gesture could not repair a corrupted fullscreen modal because `#emitAltFrame` skipped identical-string repaints without consulting the force-repaint flag
- Fixed the ghostty initial-image paint deferral consuming resize/cursor state before abandoning the frame, which could misclassify the deferred render's reflow and corrupt the paint — the deferral check now runs before any frame state is touched
- Fixed the terminal-cursor inline-hint branch adding the full hint width to the line accounting even though the rendered hint was truncated, misaligning right padding whenever the hint overflowed
- Fixed nested markdown list detection sniffing for hardcoded `\x1b[36m` (chalk cyan): every shipped theme emits truecolor/256-color SGR for bullets, so nested items doubled their indentation per level on all real themes; nesting is now tagged structurally by the list renderer. Ordered-list continuation lines also hang by the actual bullet width, so wrapped text under `10.`+ items aligns
- Fixed committed transcript rows silently vanishing when a component re-laid-out content the engine had already scrolled into native history — a TTSR stream rewind truncating a streamed block, or the image budget demoting a committed inline image to its one-line fallback, shifted every row below by the height delta and the engine kept committing from the stale index, skipping that many rows of everything after (missing interruption banners, half-cut images in scrollback). The engine now audits its committed prefix every ordinary frame: an in-place edit or restyle keeps its alignment (stale styling in history remains the accepted artifact), while any shift re-anchors the commit index at the first moved row and recommits from there — history keeps the stale copy and gains a fresh one. Duplication, never loss. The detector (`findCommittedPrefixResync`, exported for the stress harness's shadow ledger) samples the prefix tail SGR-stripped so theme restyles and single-row edits never trigger spurious recommits.
- Fixed budget-demoted inline images shrinking their transcript block: the text fallback is now height-preserving once a graphic has rendered (reserved rows plus the fallback line), so demotion never shifts content below a committed image.
- Fixed stale trailing cells bleeding into committed history on combining-heavy rows: the native width model can over-count Arabic/combining clusters, classifying a short-rendering row as full-width and skipping the trailing erase — the previous occupant's cells then scrolled into scrollback baked into the committed row. Non-ASCII row rewrites now erase the line before writing.

### Removed

- Removed the probe/defer API surface: `TUI.setEagerNativeScrollbackRebuild()`, `TUI.refreshNativeScrollbackIfDirty()`, `TUI.setClearOnShrink()`/`getClearOnShrink()`, `RenderRequestOptions.allowUnknownViewportMutation`, `NativeScrollbackRefreshOptions`, `Terminal.isNativeViewportAtBottom()`, `Terminal.hasEagerEraseScrollbackRisk()`, and the `eagerEraseScrollbackRisk`/`submitPinsViewportToTail` capability fields with their detectors.
- Removed the `PI_TUI_ED3_SAFE`, `PI_CLEAR_ON_SHRINK`, and `PI_TUI_DEBUG` environment variables (the levers they tuned no longer exist; `PI_DEBUG_REDRAW` now logs the commit-ledger state per frame).

## [15.10.9] - 2026-06-09

### Added

- Added a `wrapDescription` option to `SelectListLayoutOptions`. When enabled, long descriptions wrap onto continuation rows indented under the description column instead of being silently truncated. The slash-command/skill autocomplete picker now opts in so descriptions like the bundled skills' remain fully readable at normal terminal widths. `maxVisible` becomes the picker's visual row budget so the popup height stays bounded even when items wrap (a single 5-row description with `maxVisible=3` clips with the scrollbar carrying the offscreen tail). Navigation stays item-to-item, the narrow-width fallback (`width <= 40`) is unchanged, and the `ScrollView` scrollbar tracks visual rows so the thumb stays correct when items wrap unevenly. ([#2169](https://github.com/can1357/oh-my-pi/issues/2169))

### Fixed

- Fixed Ghostty's first inline image in a fresh TUI session sometimes rendering as an empty placeholder block by holding the initial Kitty graphics paint until the terminal startup settle window has passed. Direct Kitty placements also keep their zero-width reservation rows non-plain so image-only transcript blocks do not collapse when blank-edge trimming runs.

## [15.10.8] - 2026-06-09

### Fixed

- Fixed TUI renders repeatedly clearing terminal scrollback after content filled the viewport. Unknown viewport probes no longer let foreground-streaming offscreen growth take the destructive `historyRebuild` path on every frame; newly appended tail rows stay reachable while stale history waits for a safe checkpoint. ([#2154](https://github.com/can1357/oh-my-pi/issues/2154))

## [15.10.6] - 2026-06-08

### Added

- Added `TUI.getFocused()` accessor and `Input.pasteText(text)` method so callers consuming non-bracketed paste transports (e.g. kitty's OSC 5522 enhanced clipboard) can route a paste payload to the currently focused modal Input rather than always to the primary editor. Mirrors the existing `Editor.pasteText` semantics: newlines stripped, tabs normalized, NFC normalization applied. ([#2127](https://github.com/can1357/oh-my-pi/issues/2127))

### Fixed

- Fixed tmux/screen/zellij rewind/branch (`requestRender(true, { clearScrollback: true })`) permanently anchoring the input box to the pane top and overlaying scrollback after a streamed reply had grown past the viewport. `#emitFullPaint` only reset `#scrollbackHighWater` inside the `clearScrollback` branch and otherwise raised it monotonically, so inside multiplexers (where `\x1b[3J` is a no-op and `clearScrollback` is forced off) the streaming peak survived the rewind; on the next frame `#planLiveRegionPinnedRender` saw the stale high-water and anchored `renderViewportTop` past the actual content, repainting every visible row blank and parking the cursor at screen row 0 for the rest of the session. A full repaint with `clearViewport: true` re-emits the entire transcript from row 0, so `#scrollbackHighWater` is now assigned (not max-clamped) to the natural push count regardless of whether ED 3 was issued ([#2130](https://github.com/can1357/oh-my-pi/issues/2130)).

## [15.10.5] - 2026-06-08

### Added

- Added `atomicTokenPattern` to `Editor`: when set to a global regex matching placeholder tokens such as `[Image #1, 800x600]` or `[Paste #2, +30 lines]`, a single backspace or forward-delete landing anywhere on a token removes the whole token instead of corrupting it into stray text.

### Changed

- Changed the large-paste placeholder label from `[paste #N +X lines]`/`[paste #N Y chars]` to `[Paste #N, +X lines]`/`[Paste #N, Y chars]`.

### Fixed

- Fixed pasting large text lagging the prompt for hundreds of milliseconds before the `[paste #N …]` placeholder appeared. `StdinBuffer` assembled bracketed pastes by re-concatenating and re-scanning the entire accumulated buffer on every incoming stdin chunk (`#pasteBuffer += chunk; indexOf(END)`), which is O(n²) in the paste size and dominates when the terminal/PTY delivers the paste in many small reads (SSH, tmux, slow hosts) — a 1 MB paste at 1 KB chunks cost ~33 ms and 5 MB ~740 ms. Chunks are now collected in an array and joined once when the end marker arrives, with a short overlap tail carried across chunk boundaries so a marker split between two reads is still detected without rescanning, making assembly O(n) (~1 ms for 5 MB). The `Editor` paste cleaner also dropped its `split("").filter().join("")` per-code-unit array allocation in favor of a single control-character regex pass (~20× faster on large pastes).

## [15.10.4] - 2026-06-08

### Fixed

- Fixed Windows ConPTY session-resume painting the transcript with the last several rows truncated below the viewport until Alt+Tab forced a host repaint. After `sessionReplace`/`historyRebuild`/`overlayRebuild` paints that scroll-push content into native scrollback, the renderer now arms a 150 ms ConPTY settle window that coalesces spinner/blink-driven `requestRender(false)` calls into a single trailing render — Windows Terminal's viewport-follow logic no longer falls further behind the cursor on every tick of the post-paint storm. The arm also reclaims any render request queued *during* the in-flight composition (notably `ImageBudget.endPass()` calling `requestRender()` synchronously when a frame trips the live-graphics cap): without that, the queued request sat on the standard 30 Hz throttle and fired at ~33 ms — well inside the 150 ms quiet window — defeating the coalescing. Bumped the ConPTY per-`WriteFile` chunk cap from 8 KiB to 16 KiB so a multi-megabyte resume paint emits half as many writes (still well under the ~32 KiB threshold from #2034 that the original cap defends against), and made the cap measure encoded UTF-8 bytes instead of JS code units so a CJK-heavy transcript can't silently inflate a 16-KiB-of-code-units chunk into ~48 KiB of `WriteFile` traffic and reintroduce the #2034 viewport bug ([#2095](https://github.com/can1357/oh-my-pi/issues/2095)).

## [15.10.3] - 2026-06-08

### Fixed

- Fixed DEC 2048 in-band resize reports (`CSI 48;rows;cols;hpx;wpx t`) leaking into the focused editor as literal text during a rapid resize. When the window is resized quickly the event loop stays busy long enough for the `StdinBuffer` flush timeout to fire mid-report; the `\x1b[48;…` prefix was emitted as one event and the tail (e.g. `8;125;1156;1125t`) arrived as bare printable characters that the editor inserted. `ProcessTerminal` now reassembles a split in-band report (including a split at the bare `\x1b[4` type field) until its terminator and then drives the resize. A reassembled sequence that turns out not to be a resize report — such as a split kitty key like `\x1b[48;5u` (codepoint 48 = `0`) — is forwarded to the input handler as a single escape sequence rather than dropped or leaked.
- Coalesced terminal-multiplexer SIGWINCH events into a single forced render once the pane stops resizing so closing/dragging a tmux/screen/zellij split no longer flashes the viewport blank before the new geometry repaints ([#2088](https://github.com/can1357/oh-my-pi/issues/2088)).

## [15.10.2] - 2026-06-08

### Added

- Added exported `canonicalKeyId` and `addKeyAliases` keybinding helpers so consumers can share the same canonical shortcut matching semantics as `KeybindingsManager`.
- Added `super` modifier support to native key parsing/matching and bound `super+alt+backspace` / `super+alt+delete` (and `super+alt+d`) into the word-delete defaults so Ghostty's default macOS Option+Backspace wire (`ESC [127;11u` — kitty modifier 11 = super|alt) deletes a word instead of falling through to single-char delete ([#2064](https://github.com/can1357/oh-my-pi/issues/2064)).

### Fixed

- Fixed focus-changing in-place menus leaving stale Working/menu rows and parking the hardware cursor in the old menu viewport on terminals without a scroll-position oracle.
- Fixed redundant terminal cursor updates so repeated renders that do not change the cursor row, column, or visibility no longer emit ANSI move/hide sequences
- Fixed repeated cursor updates during no-op re-renders by reusing the last known cursor state, preventing unnecessary cursor position changes and hide/show sequences
- Fixed the kitty keyboard progressive-enhancement probe to honor the `CSI ? <flags> u` reply even when the terminal answers the DA1 sentinel first. Previously the kitty reply was discarded once the DA1-driven `modifyOtherKeys` fallback engaged, so terminals like Superset/xterm-on-Electron stayed on the fallback and delivered Shift+Enter as a bare `\r` ([#2042](https://github.com/can1357/oh-my-pi/issues/2042)).
- Bounded TUI line fitting for oversized raw rows so ANSI-heavy subagent output and zero-width-heavy text cannot grow render buffers independently of the viewport or hide visible suffix text ([#2045](https://github.com/can1357/oh-my-pi/issues/2045)).
- Fixed tmux offscreen-shrink frames to skip repainting when the visible tail is unchanged, avoiding intermittent blank/refresh flashes in pane terminals ([#2046](https://github.com/can1357/oh-my-pi/issues/2046)).
- Fixed Windows ConPTY hosts (Windows Terminal, Tabby, Hyper, VS Code) parking the viewport at the top of a full paint after a `/resume` or any long-session repaint. `ProcessTerminal#safeWrite` now splits oversized writes into ≤ 8 KiB pieces at line boundaries on `win32` and inside WSL (where stdout still crosses ConPTY at the `wslhost` boundary) so each underlying `WriteFile` stays below the ~32 KiB threshold where ConPTY stops tracking the cursor; the data was always delivered, but the host UI's scroll position would not follow until any focus event forced a re-query. ([#2034](https://github.com/can1357/oh-my-pi/issues/2034))

## [15.10.1] - 2026-06-07

### Breaking Changes

- Removed Kitty temp-file image transmission, its startup support probe, the `PI_KITTY_IMAGE_TRANSMISSION` override, and the temp-file helper exports. Kitty/Ghostty image payloads now stay on in-band base64 before placeholder/direct placement, avoiding blank first renders from temp-file load races.
- Renamed `RenderRequestOptions.allowUnknownViewportMutation` → `allowUnknownViewportTransientRepaint`. The option only permits a transient live-viewport repaint (autocomplete/IME/focused-editor chrome) on hosts that cannot report viewport position; it never authorizes a settled transcript commit. The old name implied any offscreen mutation was safe to push into native scrollback, which led callers to emit duplicate transcript copies.

### Added

- Added `TUI.addStartListener()` so feature hooks can re-enable terminal modes after temporary stop/start cycles such as external-editor handoffs.
- Added `Editor.pasteText()` to apply terminal-style paste handling for text inserted from non-bracketed paste transports
- Added an optional `dispose()` lifecycle method to `Component` so components can release timers and subscriptions during permanent teardown
- Added `Container.dispose()` to propagate teardown to child components when a component tree is permanently discarded
- Added `Loader.dispose()` to stop the loader animation timer when the component is disposed
- Added a `ScrollView` `ellipsis` option (defaults to `Ellipsis.Unicode`) so callers that pre-wrap content to width can pass `Ellipsis.Omit` and suppress the stray per-line `…` that lands on trailing padding.
- Added `ScrollView.handleScrollKey()` plus a `fastScrollLines` option so every scroll view gets shared navigation keys, including Shift+Arrow to scroll faster.
- Added `OverlayOptions.fullscreen`: while the topmost visible overlay sets it, the engine borrows the terminal's alternate screen buffer for the overlay's lifetime and paints only the modal there — no ED3, no transcript re-commit — so the transcript stays untouched on the normal screen and is not scrollable behind the modal. Mouse tracking (`?1000h`/`?1006h`) is enabled for the modal's lifetime and disabled on exit, so the rest of the app keeps the terminal's native text selection.
- Added the `submitPinsViewportToTail` terminal capability and `detectSubmitPinsViewportToTail()`: genuine local terminals where a submit keystroke scrolls the host to its tail reconcile deferred native scrollback at the prompt-submit checkpoint even when the viewport position is unprobeable (Ghostty/kitty/iTerm/WezTerm/Alacritty). Restores the pre-regression submit reconciliation without re-enabling it for Windows Terminal/ConPTY, SSH, or multiplexers, where a submit is not proof the host is at the tail.

### Changed

- Changed static `Loader` messages to repaint only at the spinner's 80 ms cadence; time-dependent message colorizers can opt into 16 ms redraws with `animated: true`.
- Changed keybinding matching to precompute canonical key sets so each input sequence is parsed once per binding check instead of once per candidate key.
- Made `Component.invalidate()` optional so leaf components without render caches no longer need no-op invalidation hooks.
- `TERMINAL` is now a `RuntimeTerminal` whose post-construction capabilities (image protocol and the probe-driven flags) are writable, replacing the `as unknown as MutableTerminalInfo` cast pattern and the positional `withTerminalOverrides` rebuild with a prototype-preserving `clone()`.

### Fixed

- Fixed `Loader` text updates to skip identical messages and preserve the rendered `Text` cache instead of invalidating it every timer tick.

- Fixed fullscreen overlay alt-frame rendering to reuse the current line-preparation path instead of calling removed fitting helpers.
- Reduced TUI render-path line fitting by deferring overlay base-frame fitting until an overlay rebuild and by reusing already-fitted lines in emitters.
- Reduced live-region pinned repaint output by diffing unchanged viewport rows when no sealed rows are being committed to native scrollback.
- Fixed no-append live-region pinned repaints to re-anchor the hardware cursor when the logical viewport shifts.
- Fixed keybinding matching so printable uppercase input preserves `Shift` for bindings such as `shift+a`.
- Optimized terminal image-line detection and Thai/Lao AM normalization checks to avoid hot-path regex scans and substring allocations.
- Fixed `Markdown.render()` cache hits returning the cache's mutable backing array, which let callers that append extra rows corrupt cached Markdown and duplicate those rows on every redraw.
- Fixed first-paint full replays for callers that intentionally replace terminal history by allowing `TUI.start({ clearScrollback: true })`, so they do not briefly append an entire initial frame before the first clean replay.
- Fixed ED3-risk streaming cap accounting to preserve the native scrollback high-water mark for rows that were already physically committed before transient frames were viewport-capped.
- Fixed terminal stop and restore cleanup to disable enhanced paste mode so it does not remain enabled after shutdown
- Removed the per-frame line-fit `Map` cache from the render timer path to avoid forcing JSC rope-string hashing during scheduled viewport repaints.
- Fixed `visibleWidth()` so terminal column measurements for ANSI and OSC text now match the native truncation/wrapping helpers, including OSC 66 text-sizing spans being counted at their scaled payload width
- Fixed cursor, padding, and line-fit behavior when strings contain tabs or OSC escapes by aligning `visibleWidth()` with the native text-width model
- Fixed the transcript — or a re-appearing prior view such as the welcome screen — duplicating itself on terminals without a scroll-position oracle (Ghostty/kitty/iTerm/WezTerm) when a foreground tool completes by rewriting a partly-committed block, or when the transcript is reset. A non-destructive viewport repaint no longer re-paints rows that are byte-identical to what is already committed to native scrollback into the active grid; the repaint anchor is clamped to the committed-and-unchanged prefix (`min(firstChanged, scrollbackHighWater)`).

## [15.10.0] - 2026-06-06

### Changed

- Reworked the DEC 2026 synchronized-output default policy: a positive DECRQM mode-2026 report now **enables** sync (previously a report could only disable it), so conservatively defaulted-off hosts that actually support it — current Zellij, tmux master, foot, contour, mintty — are upgraded at runtime. The static allowlist also covers Alacritty and the VS Code terminal, honors a `TERM_FEATURES` `Sy` advertisement and `WT_SESSION` (Windows Terminal / WSL), and no longer blanket-disables SSH (DEC 2026 passes through to the outer terminal). Risky multiplexers still start off and rely on the probe. Added `synchronizedOutputUserOverride()` as the shared opt-out/force resolver.

### Fixed

- Fixed WSL/Windows Terminal row flicker while typing by repainting changed text rows before clearing only their stale suffix ([#2011](https://github.com/can1357/oh-my-pi/issues/2011)).
- Fixed terminals that support DEC 2026 still tearing/flickering because the renderer ignored a positive DECRQM capability report and kept synchronized output off — most visibly WSL + Windows Terminal, Alacritty (≥0.13), and the VS Code terminal (≥1.108), which were detected yet refused sync.

## [15.9.69] - 2026-06-06

### Added

- Added `TUI.resetDisplay()` to force an immediate full-frame replay, including native scrollback when the host can safely clear it.
- Added `setPaddingY` to `Box` so vertical padding can be updated programmatically after creation.

### Fixed

- Fixed DECCARA background-fill optimization running when synchronized output is disabled, which could expose default-background gaps during rapidly updating tool-use panels ([#2000](https://github.com/can1357/oh-my-pi/issues/2000)).

## [15.9.67] - 2026-06-06

### Added

- Added `setPaddingX` to `Box` so horizontal padding can be updated programmatically after creation
- Added `ScrollView`, a fixed-height viewport component for pre-rendered lines with optional right-edge scrollbars and imperative scroll/page controls.
- Added optional `Terminal.hasEagerEraseScrollbackRisk()` so custom/test terminal implementations can override the global ED3-risk profile without mutating the shared `TERMINAL` object.

### Changed

- Changed `SelectList` to render its visible window through `ScrollView`, replacing the `(N/M)` text scroll indicator with a uniform right-edge scrollbar (the type-to-search hint line is preserved).

### Fixed

- Fixed unknown-viewport deferred renders freezing bottom-anchored live chrome; deferred history mutations can now repaint only the active-grid bottom row with relative cursor movement, so spinner/status tails keep advancing without rewriting rows a scrolled reader can still see.
- Fixed autocomplete popups freezing live repaint on ED3-risk macOS/POSIX terminals with unknown native viewport position; direct autocomplete shrink frames now repaint the live viewport without zero-byte deferral and preserve the old bottom anchor when padding can clear stale popup rows without duplicating committed scrollback.
- Fixed focused Up/Down navigation on ED3-risk macOS/POSIX terminals replaying the whole transcript after dirty foreground-stream renders; selector/editor frames now repaint non-destructively instead of emitting `CSI 3 J` on every arrow-key move ([#1962](https://github.com/can1357/oh-my-pi/issues/1962)).
- Fixed tmux (and screen/zellij) pane scrollback losing the head of a long streamed assistant reply once it grew past the visible pane, and stranding the chrome/footer in pane history after a later collapse — producing the "repeating chunks and missing sections" reporters saw when scrolling back through tmux pane history ([#1974](https://github.com/can1357/oh-my-pi/issues/1974)). The renderer's foreground-streaming cap-to-viewport branch (introduced in 15.9.2 for ED3-risk hosts that can checkpoint-rebuild later) also activated inside multiplexers, where checkpoint reconcile is a no-op (`refreshNativeScrollbackIfDirty` short-circuits because `\x1b[3J` cannot erase pane history). Every streaming frame clipped `lines` to the visible tail and reset `#scrollbackHighWater` to 0, so any row that scrolled above the viewport top was committed nowhere — pane history stayed empty until streaming ended. Meanwhile `#planLiveRegionPinnedRender` was explicitly disabled for multiplexers, but its `#emitLiveRegionPinnedRepaint` is built from the exact primitives tmux accepts (relative cursor moves, per-line `\x1b[2K`, `\r\n` to scroll the sealed prefix past the viewport bottom) and never emits `\x1b[2J`/`\x1b[3J`. The pinned planner now runs in multiplexers too, the cap branch skips them, and the diff/append path commits incrementally into pane history; the actively-mutating live tail stays in the visible viewport only.

## [15.9.5] - 2026-06-05

### Changed

- Changed terminal resize handling so any width or height change always performs a clean reset + redraw: the renderer now unconditionally clears the viewport and native scrollback (`CSI 2 J` / `CSI 3 J`) and replays the full transcript at the new geometry, replacing the previous matrix of conditional viewport-repaint / history-rebuild / deferred-mutation branches. Multiplexer panes still repaint the visible window in place (pane scrollback cannot be erased), but a resize during active ED3-risk foreground streaming now performs the same clean rebuild rather than downgrading to a non-destructive viewport repaint: the terminal already re-wrapped its saved lines at the old width, so the rebuild must erase them (ED 3) instead of leaving the mis-wrapped history on screen. As a deliberate tradeoff this drops the prior no-overflow and confirmed-scrolled guards on resize: a reader scrolled into history snaps back to the bottom and preexisting shell scrollback above the UI is cleared.

### Fixed

- Fixed ED3-risk foreground streaming dropping the scrolled-off head of an append-only live block that alone overflows the viewport (a long streamed assistant reply). The live-region pin again committed native scrollback only up to the live-region start, so once the live block grew past the viewport its earlier rows scrolled above the viewport top but were committed nowhere and repainted nowhere — they vanished, leaving the reply looking like a ~viewport-tall circular buffer. The `NativeScrollbackLiveRegion` seam now also reports an optional append-only `getNativeScrollbackCommitSafeEnd`, and the pinned commit boundary is the deeper of the sealed start and that append-only end: rows in `[liveRegionStart, commitSafeEnd)` above the viewport top commit to scrollback, while volatile live blocks (tool previews that collapse) omit the boundary and keep their mutable rows deferred — preserving the pending-box-above-running-box fix.

## [15.9.4] - 2026-06-05

### Added

- Added `PI_TUI_SYNC_OUTPUT=0` and `PI_TUI_SYNC_OUTPUT=1` to explicitly disable or force-enable DEC 2026 synchronized-output mode, alongside `PI_FORCE_SYNC_OUTPUT=1` as a force-on alias
- Added `PI_TUI_ED3_SAFE=1` environment override to treat a terminal as non-ED3-risk for eager native scrollback rebuilds on unknown POSIX hosts

### Changed

- Changed native-scrollback safety defaults to treat unknown POSIX, SSH, and multiplexer-shaped terminals as ED3-risk for passive rendering; checkpoint replay now requires a positive at-tail viewport proof instead of assuming prompt submit makes host scrollback safe.
- Changed synchronized-output defaults to a conservative opt-in profile: DEC 2026 paint wrappers stay disabled for remote/multiplexer/VTE/unknown terminals unless explicitly forced, while the autowrap guards remain active.

### Fixed

- Fixed ED3-risk unknown-viewport renders repainting offscreen structural edits over stale native scrollback, which could duplicate or shift rows when async blocks collapsed or middle rows were deleted.
- Fixed ED3-risk foreground streams committing mutable live-region rows into native scrollback, which could leave a stale `pending` tool box above the `running` box after the preview re-rendered.
- Fixed TUI shutdown leaving paint-time terminal state and Kitty image data behind by restoring synchronized-output/autowrap modes and purging all transmitted Kitty image ids on stop.
- Fixed stdin buffering splitting surrogate-pair text into UTF-16 halves and reduced timing sensitivity for incomplete escape sequences.
- Fixed terminal content not reflowing after a resize on terminals using DEC 2048 in-band resize (kitty/Ghostty/iTerm2/WezTerm). `ProcessTerminal.columns`/`rows` returned the last cached in-band report even after the OS already knew the new size, so a SIGWINCH whose in-band report was dropped or malformed (split past the stdin flush window, `:`-subparameter fields) re-rendered the whole transcript at the stale width. OS resize events now reconcile cached in-band geometry against the live `process.stdout` dimensions, dropping a stale cached value so the next render uses the true size; a valid in-band report still re-seeds pixel sizing.

## [15.9.3] - 2026-06-05

### Fixed

- Fixed ED3-risk foreground streaming erasing the head of any block that alone overflows the viewport (a tall tool result drawn in one frame, or a multi-line assistant reply growing past the viewport as it streams). The live-region pin committed native scrollback only up to the sealed-prefix boundary (`liveRegionStart`), so rows of the live block that had physically scrolled above the viewport top were neither pushed into scrollback nor kept in the repainted viewport — they vanished. The commit boundary is now the viewport top: every row above the viewport enters scrollback (only the tail still visible in the viewport stays transient and deferred to the checkpoint).
- Fixed the same ED3-risk live-region pin duplicating already-committed scrollback rows when a foreground stream's live region collapsed mid-turn (a tool preview shrinking to its compact result, an assistant block re-wrapping shorter, a late tool completion). Because growth commits every row above the viewport top to native scrollback, a subsequent shrink moved the bottom-anchored viewport back across those committed rows and the repaint re-drew them into the viewport — so they appeared twice on scroll-up, and with no prompt-submit checkpoint to reconcile (autonomous multi-turn runs, or the session ending into the welcome screen) the duplicate was baked permanently into terminal history. The pinned repaint now separates commit geometry from repaint geometry: a collapse clamps the repaint to the committed sealed boundary (`min(#scrollbackHighWater, liveRegionStart)`) instead of re-exposing those rows, leaving native scrollback un-duplicated without emitting ED3 under a possibly-scrolled reader; stale mutable live-region saved lines still reconcile at the next checkpoint.
- Fixed hiding overlays during ED3-risk foreground streaming on unknown-viewport terminals leaving the overlay's transient rows in native scrollback. Overlay visibility reductions now bypass the streaming deferral path and rebuild once, so hidden dialog/notification sentinels are scrubbed immediately.
- Fixed ED3-risk / unknown-viewport terminals (including WSL fronted by Windows Terminal) keeping the foreground-stream eager-rebuild mode active after the stream had already settled. A later scrolled content shrink or resize-with-append could then bypass the anti-yank deferral and repaint from stale geometry, jumping the viewport or replaying the wrong rows. The eager opt-in now drops immediately when no teardown render is pending, and the one-frame post-checkpoint suffix-suppression path no longer overrides geometry reflow handling.

## [15.9.2] - 2026-06-05

### Changed

- Changed foreground-stream rendering on ED3-risk terminals (Ghostty/kitty/Alacritty/VTE/iTerm2 on POSIX) to defer native-scrollback commits for unpinned transient frames: while a turn streams, generic frames repaint only the viewport and suppress `\r\n` scroll growth, so transient output (spinner ticks, partial lines, status rows) never pollutes terminal history. Components that report a `NativeScrollbackLiveRegion` still commit newly sealed prefix rows while keeping the active suffix dirty for checkpoint replay. Native scrollback is reconciled in a single ED3 (`CSI 3 J`) + re-emit at the next checkpoint (prompt submit) or on an explicit user-input/IME opt-in; an erase is never emitted mid-stream under a possibly-scrolled reader. Non-ED3-risk terminals keep their eager live rebuild. ([#1895](https://github.com/can1357/oh-my-pi/pull/1895))

### Fixed

- Fixed ED3-risk foreground streaming dropping sealed transcript rows above the live block until the next prompt-submit checkpoint, which made scrollback beyond the viewport appear duplicated or out of order. The renderer restores native-scrollback live-region pinning so newly sealed rows are appended once while active live rows remain deferred.
- Fixed inline images (added in 15.9) rendering as a wall of empty PUA box glyphs and producing laggy scrolling on Kitty-protocol terminals that do not implement Unicode placeholders — most notably WezTerm (per upstream wezterm/wezterm#986, placeholder support is still unchecked) and the tmux/screen `getFallbackImageProtocol` path that forces Kitty mode even on non-supporting outer terminals (Terminal.app, etc.). `unicodePlaceholders` now defaults on only for `kitty` and `ghostty`; everything else falls back to direct `a=p,i=…,p=…` placement, which those paths already render correctly. `PI_NO_KITTY_PLACEHOLDERS=1` is still honored as a hard opt-out, and a new `PI_KITTY_PLACEHOLDERS=1` opts in on otherwise-unsupported terminals (e.g. a wezterm nightly that has merged placeholder support) ([#1877](https://github.com/can1357/oh-my-pi/issues/1877)).

## [15.9.1] - 2026-06-04

### Fixed

- Fixed the OSC 11 appearance poll re-querying every 2s forever on terminals that support Mode 2031 but never change theme, whose repeated OSC 11/DA1 writes cleared the user's active text selection (breaking copy every 2 seconds). The poll now stops as soon as DECRQM confirms Mode 2031 support, since push notifications make polling redundant.

## [15.9.0] - 2026-06-04

### Added

- Added Kitty `CSI 22 J` screen-to-scrollback clears for non-destructive full paints, while keeping ED3 for destructive history/session rebuilds.
- Added Kitty OSC 99 rich notification formatting and startup capability probing.
- Added Kitty OSC 66 text-sized Markdown H1 headings (2x scale) plus native text-width support for OSC 66 spans. Off by default and gated to Kitty (the only terminal implementing OSC 66) via the `TERMINAL.textSizing` capability; hosts enable it through `setTextSizing`.
- Added Kitty Unicode placeholder image rendering (`U=1` + U+10EEEE with explicit row/column diacritics): inline images are drawn as real text cells that carry the image id in their foreground color, so they survive horizontal slicing, reflow, and overlapping draws instead of relying on cursor-positioned `a=p` placements. Enabled by default on Kitty-family terminals; opt out with `PI_NO_KITTY_PLACEHOLDERS=1`, and falls back to direct placement when a grid exceeds the diacritic table's addressable range.
- Added Kitty temp-file image transmission (`t=t`): on local sessions, decoded PNG bytes are written to a `tty-graphics-protocol` temp file and the path is sent instead of in-band base64, gated behind a startup `a=q,t=t` support probe. Controlled by `PI_KITTY_IMAGE_TRANSMISSION=direct|temp-file|auto`; disabled over SSH unless explicitly forced.
- Added DECRQM capability detection for DEC private modes 2026 (synchronized output) and 2048 (in-band resize). Synchronized-output paint wrappers are dropped when the terminal reports 2026 unsupported (preserving the `PI_NO_SYNC_OUTPUT` override), and DEC 2048 in-band resize is enabled when supported — reported geometry and cell pixel size are updated from `CSI 48 ; rows ; cols ; yPx ; xPx t` reports, with SIGWINCH and `CSI 16 t` kept as fallbacks.
- Added an injectable render scheduler for TUI tests, allowing deterministic render drains without patching global clocks or event-loop timing.
- Added `ImageBudget`, an inline-image cap that keeps only the most recent N images as live terminal graphics and demotes older ones to their text fallback. Once a new image pushes the count past the cap, the renderer hides the oldest via a full redraw plus an explicit Kitty graphics purge (`a=d,d=I`) — text-clear escapes (`CSI 2 J`/`CSI 3 J`) do not remove Kitty images. Configure the cap via `TUI#setMaxInlineImages` (`0` disables it).
- Changed Kitty inline images to a transmit-once + placement scheme: the base64 data is sent a single time (`a=t`) keyed by a stable image id, then every repaint emits only the tiny placement (`a=p,i=…,p=…`). Repaints — including full redraws — no longer re-send image data or stack duplicate placements, and the diff/line buffers and render caches hold short placement strings instead of multi-KB base64. The `ImageBudget` doubles as the transmit store (it tracks which ids are loaded and re-transmits after a purge frees the data). iTerm2/Sixel, which have no addressable image store, keep sending inline data as before.
- Added a renderer-level DECCARA rectangular-SGR optimizer that paints solid background panels/rows (Box/Text/Markdown fills, status bars, any full-width `theme.bg` row) as a single coalesced rectangle escape (`CSI 2*x` / `CSI Pt;Pl;Pb;Pr;<sgr>$r` / `CSI *x`) instead of emitting a full-width run of background-styled spaces on every visible row. It operates at emit time on the final ANSI strings — components are unchanged — and strips only trailing padding it can prove sits under a single non-default background span, coalescing vertically adjacent identical fills into one rectangle and falling back to the original bytes whenever the rectangle would not save bytes. Enabled only on Kitty, which implements the SGR-background extension (`docs/deccara.rst`); **Ghostty is intentionally excluded** because its `CSI $r` is unimplemented (ghostty-org/ghostty#632) and would drop the background entirely. Scrollback-bound rows and the append/scroll paths always keep the padded representation so native history preserves colored cells, and the `PI_NO_DECCARA` kill switch (plus tmux/screen/zellij detection) forces the fallback.
- Added `CMUX_SURFACE_ID` environment variable support to `getTerminalId()`, so cmux terminal surfaces get a stable identifier alongside kitty, tmux, macOS Terminal.app, and Windows Terminal — enabling per-surface session breadcrumbs for `omp -c` in cmux.

### Changed

- Changed TUI tests to use Ghostty's VT engine (`ghostty-web`) instead of `@xterm/headless`.
- Changed the default inline-image live graphics budget from 3 to 8 images.

### Fixed

- Fixed the DECCARA background-fill optimizer rejecting or repainting the wrong cells when a trailing fill crossed from default-background spaces into colored spaces.
- Fixed DEC private-mode reports with DECRPM status 3/4 being treated as unsupported, so permanent 2026/2048 reports stay recognized.
- Fixed OSC 66 text-sizing width and slicing edge cases, including ZWJ emoji payloads and partial slices through scaled spans.

- Fixed focused `Input` components following `TUI#setShowHardwareCursor`, so single-line prompts render either the terminal cursor or software cursor consistently with the editor.
- Fixed the DECCARA background-fill optimizer painting fills on the wrong rows ("split into unaligned halves") in the differential repaint path. When a diff grew the transcript past the viewport, writing the rewritten rows scrolled the terminal, but the absolute DECCARA rectangle coordinates were derived from the pre-scroll viewport top, so every fill landed `scrollAmount` rows too low while the relatively-positioned text settled correctly; rows scrolled into history were also shortened, dropping their background padding from native scrollback. Rectangles now target the post-scroll rows and only rows remaining in the final viewport are optimized.
- Fixed native scrollback desynchronization after terminal width or height changes reflowed overflowing content while the viewport was not at the bottom
- Fixed a notification chip (or any injected block) rendering on top of an actively streaming tool render on ED3-risk terminals (Ghostty/kitty/Alacritty/iTerm2). While a foreground tool streams, its header's elapsed-time counter ticks every frame; once output scrolls the header above the viewport top, each tick is an offscreen edit that — because the eager scrollback-rebuild opt-in is gated off on these terminals — repaints the viewport in place and advances the rendered line count without committing the new overflow to native history. `#scrollbackHighWater` then lagged the logical viewport top, so a later content shrink whose changes landed in the visible region slipped past the shrink-across-boundary guard and reached the differential emitter, which is anchored to `#maxLinesRendered - height`: it rewrote only the suffix, dropped the newly exposed top row, and left a blank at the bottom, drifting every row below the edit one line up so it painted over the rows above. Such shrinks now re-anchor the bottom of the viewport with a non-destructive repaint, and the foreground-streaming shrink-across-boundary case repaints the live tail instead of padding and pinning the pre-shrink viewport.
- Fixed a terminal resize during foreground-tool streaming on an unknown-viewport / ED3-risk host (Ghostty/kitty/Alacritty/iTerm2/WSL) leaving native scrollback permanently out of sync, so scrolling back after the turn showed missing rows. A pure geometry resize (no content change) takes the in-place viewport-repaint path, which — unlike a content-bearing resize that rebuilds via the geometry branch — never flagged native history. Because the prompt-submit checkpoint (`refreshNativeScrollbackIfDirty`) only rebuilds when scrollback is marked dirty on these hosts, the discrepancy was never reconciled. Overflowing geometry repaints whose viewport is not known to be at the bottom now mark scrollback dirty so the next checkpoint rebuilds an exact copy of the transcript.

## [15.8.2] - 2026-06-03

### Added

- Added `PI_NO_SYNC_OUTPUT=1` to disable DEC 2026 synchronized-output wrappers for terminals whose implementation is buggy or visually worse, while keeping the renderer's autowrap guards active during paints ([#1765](https://github.com/can1357/oh-my-pi/issues/1765)).

### Fixed

- Fixed terminal resizes that land in the same render frame as streamed output splicing a phantom blank row into native scrollback and offsetting every later row by one. A height shrink (or width change carrying an append) with content overflowing the viewport fell through to the differential emitter, whose scroll math is anchored to the pre-resize viewport top and hardware-cursor row — both invalidated by the terminal's own resize reflow. Geometry-changed frames now rebuild native history when the viewport is at (or possibly at) the bottom, and defer non-destructively for a reader confirmed scrolled into history.
- Fixed Ghostty/kitty/Alacritty-style ED3-risk terminals freezing the prompt after a deferred shrink; focused keyboard input now uses the same explicit user-input viewport opt-in as autocomplete and can repaint immediately instead of waiting for a resize.
- Deferred eager live scrollback rebuilds under WSL fronted by Windows Terminal (`WT_SESSION` present in a Linux environment) so foreground streaming no longer emits ED3 (`CSI 3 J`) and yanks a reader scrolled into Windows Terminal's host scrollback; deferred rewrites still reconcile at the next prompt-submit checkpoint ([#1610](https://github.com/can1357/oh-my-pi/issues/1610)).
- Fixed tmux (and screen/zellij) pane history gaining a complete duplicate copy of the transcript every time a deferred offscreen edit was followed by another render. Multiplexer panes never receive a destructive scrollback clear, so the dirty-scrollback rebuild path only appended the full transcript on top of preserved pane history — repeatedly. Live frames inside multiplexers now keep repainting the viewport and leave history reconciliation to explicit checkpoints, which also removes the O(transcript) write amplification per frame.
- Fixed tmux pane viewports corrupting and pane history duplicating when a resize coincides with rendering: a resize racing a streamed append reached the stale-anchor diff emitters (phantom rows in the pane), a forced render racing a resize replayed the whole transcript into preserved pane history, and the prompt-submit checkpoint did the same after any deferred offscreen edit. Geometry-changed frames inside multiplexers now repaint the viewport in place, and forced-render geometry replays plus checkpoint replays are disabled there — tmux reflows its own pane grid and its history cannot be cleared, only duplicated.
- Fixed terminal resize events whose dimensions net out unchanged by render time (rapid SIGWINCH round trips during a window drag, coalesced into one 16ms frame) being invisible to the renderer. The terminal reflows its buffer on every resize event — rows move between the viewport and scrollback and can be evicted at the scrollback cap — so diffing against the pre-resize screen splices blank phantom rows into the viewport. The renderer now tracks the resize event itself, not just the dimension delta, and routes such frames through the geometry-change repaint/rebuild paths.
- Fixed Termux terminal resizes (screen rotation or software-keyboard toggles) displacing or hiding output after the viewport height changed. Content-bearing resizes were routed to the differential emitter, whose scroll math is anchored to the pre-resize viewport, so appended rows landed too low; pure height changes were treated as no-ops, exposing blank rows that later appends could fill without growing native scrollback. Termux resizes now repaint or rebuild at the new geometry like every other non-multiplexer terminal.
- Fixed the turn-end teardown frame freezing on ED3-risk terminals (Ghostty/kitty/Alacritty/iTerm2): disabling eager scrollback rebuild now takes effect only after the in-flight frame is classified, so the loader/status removal still paints instead of deferring and leaving a stale spinner until the next keystroke.
- Fixed non-WT ConPTY terminals on Windows (Tabby, Hyper, VS Code, conhost) clearing scrollback and yanking the viewport to the top whenever streaming output or a prompt-submit rebuild arrived while the user was scrolled up. The kernel32 viewport probe describes the ConPTY pseudo-console buffer — which is pinned to the visible grid, invisible to host-UI scrollback — so it reported "at bottom" no matter where the user had scrolled, and the [#1635](https://github.com/can1357/oh-my-pi/issues/1635) fix only distrusted it under `WT_SESSION`, which Tabby and other ConPTY hosts never set. The probe is now removed entirely: every Windows host is treated as viewport-unobservable, live mutations defer destructive rebuilds (no `\x1b[3J`, no viewport movement), and native scrollback reconciles at the prompt-submit checkpoint where the Enter keystroke has already pinned the host viewport to the bottom ([#1746](https://github.com/can1357/oh-my-pi/issues/1746)).
- Fixed emoji-presentation symbols (a default-text symbol followed by variation-selector-16 `U+FE0F`, e.g. `⚠️`, `ℹ️`, `❤️`, keycaps) measuring as 1 cell instead of 2 in the native width engine on macOS. The native scanner now keeps `UnicodeWidthStr` as the source of truth for multi-codepoint graphemes and applies only the local macOS Hangul Compatibility Jamo character-width delta, preserving VS16/keycap sequence widths without reintroducing jamo cursor drift.
- Deferred eager live scrollback rebuilds on macOS Terminal.app and iTerm2 so assistant/tool streaming no longer emits ED3 (`CSI 3 J`) while their native viewport position is unobservable, preserving readers scrolled into terminal history ([#1300](https://github.com/can1357/oh-my-pi/issues/1300)).
- Fixed width-shrink reflow leaving old-width rows in native history so later appends no longer undercount scrollback growth or duplicate wrapped content.
- Fixed hiding overlays after terminal reflow so stale dialog rows are scrubbed from native scrollback on non-multiplexer terminals.

### Removed

- Removed `shouldTrustNativeViewportProbe` and `ProcessTerminal`'s kernel32 `GetConsoleScreenBufferInfo` viewport probe. No Windows environment can answer "is the user's viewport at the bottom" truthfully — under ConPTY (every modern host) the pseudo-console buffer is pinned to the visible grid so the probe always read "at bottom", and under legacy conhost the window tracks the output cursor rather than the buffer tail so it always read "scrolled up" — so the probe and its trust gate are gone; `ProcessTerminal` no longer implements the optional `Terminal.isNativeViewportAtBottom`.

## [15.8.1] - 2026-06-02

### Fixed

- Deferred eager live scrollback rebuilds on VTE terminals so GNOME-style Linux terminals do not flash or erase readable scrollback during streaming ([#1719](https://github.com/can1357/oh-my-pi/issues/1719)).

## [15.8.0] - 2026-06-02

### Fixed

- Deferred eager live scrollback rebuilds on POSIX terminals where xterm ED3 (`CSI 3 J`, erase saved lines) can disturb scrolled-up readers during streaming, while keeping direct user-input and checkpoint rebuilds explicit ([#1682](https://github.com/can1357/oh-my-pi/issues/1682)).
- Fixed TUI shutdown placing the parent shell prompt one row below short rendered content instead of directly on the next line ([#1620](https://github.com/can1357/oh-my-pi/issues/1620)).
- Stopped painting inline color swatches for 4-digit hex runs in Markdown rendering. The `#RGBA` CSS form collides with hashline `#TAG` snapshot tags (4 hex digits, e.g. `#6C5E`), which were sprouting spurious RGB swatches in prose and codespans. Only `#RGB`, `#RRGGBB`, and `#RRGGBBAA` qualify now.

## [15.7.6] - 2026-06-01

### Fixed

- Fixed native Windows + Windows Terminal freezing the editor on the wrap keystroke, on `/plan`/`/resume`/model-switch/status-line toggles, and on any other offscreen structural mutation until the next prompt submit. The `15.7.5` `#1635` fix routed every viewport-saturating pure-append and structural mutation through `deferredMutation` (a literal no-op) whenever `isNativeViewportAtBottom()` returned `undefined` — which it always does under `WT_SESSION` because the kernel32 probe can't see WT host scrollback. The deferral was only ever meant for the *confirmed-scrolled* case; an unknown viewport now falls back to a non-destructive `viewportRepaint` instead, so the live UI keeps updating without emitting `\x1b[3J` and without yanking a possibly-scrolled reader. Confirmed-scrolled frames (probe returns `false`) still defer.
- Removed the hard-coded 20-result cap on `@`-prefixed fuzzy file completion in `CombinedAutocompleteProvider.#getFuzzyFileSuggestions`. The dropdown now honors the existing `maxResults: 100` ceiling already configured for `fuzzyFind`, so projects with many files sharing a common stem (e.g. `@controller`, `@test`) surface all relevant matches instead of being silently truncated. ([#1652](https://github.com/can1357/oh-my-pi/issues/1652))

## [15.7.5] - 2026-06-01

### Fixed

- Fixed native Windows + Windows Terminal scrollback being yanked to the top when a streaming response triggered a TUI full redraw. Under ConPTY the `kernel32` `GetConsoleScreenBufferInfo` probe answers about the pseudo-console (always at the buffer tail) and not about WT's host scrollback, so `isNativeViewportAtBottom()` falsely returned `true` while the user was scrolled up and the shrink-across-viewport branch issued a destructive `historyRebuild` (`\x1b[2J\x1b[H\x1b[3J`). The probe now short-circuits to `undefined` whenever `WT_SESSION` is set, letting the existing deferred-rebuild path keep streaming-time mutations non-destructive and reconcile native history at the next prompt-submit checkpoint. ([#1635](https://github.com/can1357/oh-my-pi/issues/1635))

## [15.7.3] - 2026-05-31

### Added

- Added `overflowSearch` to `SelectListLayoutOptions` to let consumers enable or disable type-to-filter search and search-status rendering per SelectList instance
- Added fuzzy type-to-filter search to overflowing `SelectList` pickers, with search status and result counts.
- Added `TUI.setEagerNativeScrollbackRebuild(enabled)` — while enabled, live render frames rebuild native scrollback on offscreen/structural changes even when the viewport position is unobservable (POSIX), instead of deferring to a non-destructive repaint. Trades the anti-yank guarantee for clean, duplicate-free history; intended for windows where output above the fold is actively re-laying out (e.g. a tool whose result is still streaming). A terminal that reports a known-scrolled viewport still defers.

### Changed

- Disabled interactive search filtering for editor autocomplete and slash-command `SelectList`s by passing `overflowSearch: false` in their layout options

### Fixed

- Preserved hidden tmux overlays in the live viewport by removing overlay content from view when an overlay was hidden while keeping pane history intact
- Preserved native scrollback when forced TUI renders coalesce with content growth, and deferred pure tail appends while readers are scrolled into history.
- Preserved existing terminal scrollback during forced and structural TUI renders so preexisting shell lines remained visible after component mutations
- Rebuilt native scrollback for safe bottom-anchored offscreen edits and high-water preview collapses instead of repainting only the viewport, preventing stale or duplicated rows above the live viewport.
- Stripped internal cursor marker sentinels from all rendered lines so offscreen focus markers no longer leak into terminal output
- Truncated all painted lines to terminal width during viewport repaints and append-tail updates so long content no longer overflows or wraps unexpectedly
- Fixed `tui.select.cancel` handling in `SelectList` so pressing Escape or Ctrl+C closes the list even when no matches are currently shown
- Fixed native scrollback corruption when an offscreen row edit and repeated-tail append land in one render frame; ambiguous appended tails now rebuild history instead of splicing stale rows into the buffer.
- Fixed scrolled-up readers being yanked back to the tail whenever streaming content arrived on POSIX terminals (macOS/Linux). Native viewport position is unobservable there (`isNativeViewportAtBottom()` returns `undefined`), and the planner optimistically treated "unknown" as "at bottom", so every offscreen streaming edit ran a destructive `historyRebuild` that cleared scrollback and snapped the view to the bottom. Live render frames now treat an unknown viewport as unsafe for a destructive rebuild — they defer to a non-destructive viewport repaint and reconcile native scrollback at the next explicit checkpoint (prompt submit). Resize and checkpoint replays keep the prior behavior.
- Fixed native scrollback not rewrapping when the terminal widens on POSIX. A width increase reflows the transcript to fewer lines, which the shrink-across-boundary branch intercepted and (after the unknown-viewport deferral) repainted only the viewport — leaving committed history wrapped at the old width and duplicated above the live viewport. Width changes now rebuild native scrollback at the new geometry even when the viewport position is unknown (a yank is acceptable on an explicit resize); a terminal that can report a scrolled viewport still defers.

## [15.7.0] - 2026-05-31

### Fixed

- Fixed slash-command autocomplete repainting when a Windows Terminal session cannot report native scrollback position; live input renders can now bypass the unknown-viewport deferral without weakening background scrollback protection. ([#1550](https://github.com/can1357/oh-my-pi/issues/1550))

## [15.6.0] - 2026-05-30

### Added

- Added autocomplete triggering for internal URL scheme tokens such as `local://` and `skill://` while typing in the editor

### Fixed

- Fixed streaming output staying invisible in Windows Terminal + WSL2 until the window was minimized + restored. The 15.5.14 WSL branch of `requiresNativeViewportProofForReplay` treated an unknown native viewport state as "scrolled into history" — but `ProcessTerminal.isNativeViewportAtBottom` can only return a real answer through `kernel32.dll` FFI, which a Linux user-space process inside WSL cannot load, so the probe was permanently `undefined`. Every row-inserting structural mutation (each new streaming token row above the bottom-anchored prompt) was therefore classified as `deferredMutation` and emitted zero bytes. Any geometry change (resize/minimize/restore) bypassed the gate via a different render intent, which is why the output became visible only on window resize. The WSL clause is removed; on platforms where the probe cannot answer, unknown is treated as at-bottom (the pre-15.5.14 behaviour) so the live render path runs again. Native Win32 keeps the conservative "assume scrolled when unknown" heuristic since `kernel32` FFI does succeed there and unknown means the probe transiently failed. ([#1534](https://github.com/can1357/oh-my-pi/issues/1534))

## [15.5.14] - 2026-05-29

### Added

- `Markdown` now renders a small color-chip swatch, painted with the referenced color, in front of CSS hex colors mentioned in prose, thinking traces, lists, tables, and blockquotes (e.g. `#C5FFD6` or `` `#C5FFD6` ``). The chip glyph comes from the theme's symbol set so it degrades across tiers (Nerd Font / Unicode `■` → ASCII `[]`) and is overridable via the `md.colorSwatch` symbol. Truecolor terminals get an exact 24-bit chip; others fall back to the nearest 256-color cell. Bare prose requires a hex letter for 3/4-digit forms so short issue/PR references (`#123`, `#1011`) don't sprout swatches; backticked codes are always treated as colors.

### Fixed

- Fixed the terminal hardware cursor disappearing in Ghostty. `resolveHardwareCursorPreference` force-hid the hardware cursor whenever it detected a Ghostty session (to fight bar-cursor afterimage "trails"), but the editor was simultaneously kept in terminal-cursor (marker-only) mode via `getUseTerminalCursorMarker()`, which renders no glyph and relies on the now-hidden hardware cursor — so Ghostty users had no visible caret at all, regardless of `PI_HARDWARE_CURSOR`. The Ghostty/`PI_FORCE_HARDWARE_CURSOR` override and the redundant `useTerminalCursorMarker` state are removed: `showHardwareCursor` is honored as-requested again (hardware cursor on by default), and disabling it cleanly falls back to the steady software-cursor glyph. The per-paint anti-trail mitigations (hide-cursor + autowrap-off inside the synchronized-output block) are retained, which is the actual trail fix.

## [15.5.12] - 2026-05-29

### Fixed

- Fixed terminal resizes corrupting native scrollback with duplicated rows. The 15.4.0 change that defers a destructive scrollback clear+replay (so a user scrolled into history is not yanked while a streaming tail cell mutates) also caught genuine width/height resizes: a resize reflows the terminal's own committed scrollback at the new geometry, but repainting only the viewport left the stale old-size rows in history, so every overflowed row showed up twice (old-size wrap + new-size copy) when scrolling back, until the next prompt submit cleaned it up. `#planRender` now rebuilds history synchronously when the frame's geometry actually changed (`widthChanged || heightChanged`) via the restored `historyRebuild` intent, and defers the rebuild only for pure content mutations where the user may be reading scrollback mid-stream.

## [15.5.0] - 2026-05-26

### Fixed

- Fixed `@` file mention autocomplete stalling for seconds when the query references something outside the project root (e.g. `@../`, `@~/`, `@/abs/`). `CombinedAutocompleteProvider` now short-circuits to plain immediate-directory prefix listing in those cases instead of dispatching a recursive `fuzzyFind` walk over a sibling directory full of unrelated projects. Inside-cwd queries keep the existing fuzzy-then-prefix behavior. ([#1395](https://github.com/can1357/oh-my-pi/issues/1395))
- Gated the Hangul Compatibility Jamo width correction (U+3131..U+318E → 1 cell, originally landed in 15.0.1 for the IME / hardware-cursor displacement bug) behind `process.platform === "darwin"` in the TS path and `cfg!(target_os = "macos")` in the `pi-natives` Rust path. macOS terminals (Ghostty / Terminal.app / iTerm2) render jamo as 1 cell despite UAX#11 classifying them as Wide, but WezTerm and most Linux terminals honor UAX#11 and render them as 2 cells. The unconditional correction therefore desynced the TUI's column bookkeeping from the terminal's actual rendering off-darwin, producing corrupted layout and broken Korean input on Linux. On non-darwin the helpers now defer entirely to `Bun.stringWidth` / `UnicodeWidthStr` (also a small perf win on the multi-char-grapheme path). ([#1410](https://github.com/can1357/oh-my-pi/issues/1410))

## [15.4.0] - 2026-05-26

### Fixed

- Fixed terminal scrollback gaining duplicate copies of the welcome screen (and any other header content) when the bottom tool cell mutated across the previous viewport boundary. Once a row scrolls into terminal history it cannot be retracted, so a subsequent shrink that would re-expose that row in the repainted viewport now clears stale scrollback and replays the transcript, then suppresses one immediate suffix-scroll frame so live status/editor chrome is not deposited twice. Multiplexer panes ignore `\x1b[3J`, so the recovery is gated on `!isMultiplexerSession()`.
- Fixed the IME / hardware cursor sticking to the bottom of the terminal after a resize that grew the viewport taller than the rendered transcript. `#emitViewportRepaint` always writes one row per screen line (padding empty rows past the content), so the post-write hardware cursor sits at screen row `height - 1`. The bookkeeping previously clamped the tracked cursor row to `lines.length - 1`, making `#cursorControlSequence`'s relative `rowDelta` underestimate the upward move by `(height - lines.length)` rows and pinning the cursor at the viewport bottom even though the focused component's `CURSOR_MARKER` was on a content row.

## [15.3.2] - 2026-05-25

### Fixed

- Fixed `matchesKey(data, "ctrl+m")` (and the other named-key collisions: `ctrl+h`/`ctrl+i`/`ctrl+j`/`ctrl+[`) returning true for the bare `\r`/`\x08`/`\t`/`\n`/`\x1b` byte terminals send for Enter/Backspace/Tab/Escape in legacy mode. Binding a command to `Ctrl+M` no longer fires when the user presses Enter — the named key wins, and `ctrl+<colliding-letter>` matches only when the terminal disambiguates via the Kitty keyboard protocol or `modifyOtherKeys`. ([#1354](https://github.com/can1357/oh-my-pi/issues/1354))
- Fixed full TUI redraws clearing terminal scrollback with `CSI 3 J`, preserving manual scrollback inspection while active sessions continue updating. ([#1295](https://github.com/can1357/oh-my-pi/issues/1295))

## [15.2.3] - 2026-05-22

### Added

- Added `SettingsList#setItems` to replace the entire settings list with a new items array while automatically clamping selection to a valid index

### Changed

- Updated `Loader` to drive renders at ~60fps (16ms tick) while keeping spinner-frame advancement at 80ms so shimmer/animated message colorizers update smoothly without altering spinner cadence

## [15.1.9] - 2026-05-21

### Fixed

- Fixed terminal probe responses (DA1, kitty keyboard, Mode 2031) leaking into the prompt as keystrokes when the response is split across stdin reads. `ProcessTerminal` now reassembles `\x1b[?<digits>...` private CSI fragments and dispatches the complete response through the existing pattern handlers. ([#1238](https://github.com/can1357/oh-my-pi/issues/1238))

## [15.1.4] - 2026-05-19

### Fixed

- Fixed `renderInlineMarkdown` crashing with `TypeError: undefined is not an object (evaluating 'e.replace')` when called with a non-string value during streaming — partial JSON parsing leaves option label fields temporarily unpopulated, causing the ask tool renderer to fail. ([#1176](https://github.com/can1357/oh-my-pi/issues/1176))

## [15.0.2] - 2026-05-15

### Added

- Restored the `Key` runtime helper on `@oh-my-pi/pi-tui` to mirror upstream `@mariozechner/pi-tui`'s surface. `Key.enter`, `Key.escape`, `Key.tab`, … return the canonical key-name strings; modifier methods (`Key.ctrl(k)`, `Key.shift(k)`, `Key.ctrlShift(k)`, etc.) build precisely-typed `KeyId` literals like `"ctrl+c"`. Pure runtime convenience for typed key-id construction — plugins built against the upstream package surface that import `Key` (e.g. `@plannotator/pi-extension`, `@juicesharp/rpiv-ask-user-question`) load again now that the specifier shim remaps them onto this package.

## [15.0.1] - 2026-05-14

### Breaking Changes

- Increased the minimum required Bun version for the TUI package from >=1.3.7 to >=1.3.14
- Fixed `TerminalInfo.sendNotification` not delivering desktop notifications on macOS. macOS requires per-app notification permission, which terminal emulators (kitty, ghostty, alacritty, …) almost never have, so OSC 9/99 sequences were silently dropped at the OS layer. `sendNotification` now shells out to `alerter` or `terminal-notifier` when either is on `$PATH` (both register their own LSApplication and ship a "Terminal" / `>_` icon). When neither is installed the dispatch is a deliberate no-op + a single `logger.warn` line on the first miss (subsequent dispatches stay silent) so the user can spot the missing binary in `~/.omp/logs/omp.YYYY-MM-DD.log` and `brew install alerter`. Linux/Windows still go through the OSC/Bell path.
- Fixed `TerminalInfo.formatNotification` losing OSC 9/99 desktop notifications when running inside tmux. The OSC sequence is now wrapped in tmux's DCS passthrough envelope (`\ePtmux;…\e\\` with embedded ESC bytes doubled) when `TMUX` is set, so notifications reach the parent terminal. `set -g allow-passthrough on` is still required on the tmux side for the wrapped sequence to be forwarded. Bell-only terminals are unchanged.
- Fixed alerter desktop notifications staying on screen indefinitely. `scripts/mac-alerter.sh` previously passed `--timeout 30` (which makes alerter call `removeDeliveredNotification` after 30 s, also purging the Notification Center entry) and forced Alert-style via `--actions "Open"` (persistent until user click). It now ships Banner-style argv (no `--actions`, no `--timeout`): macOS auto-dismisses the toast after ~10 s and archives the entry to Notification Center for later review. Click-to-focus is preserved through `@CONTENTCLICKED` body clicks. NC archival also requires "Show in Notification Center" enabled for Terminal under macOS System Settings → Notifications.
- Fixed `composeNotificationSubtitle` showing a stale tmux `pane_title` (typically `π: kitty & tmux` or the cwd prefix written before auto-naming runs) instead of the live OMP session name. The OMP-supplied `fallback` is now consulted first for the pane component; the cached tmux pane title is only used when no session name is available. Window name handling is unchanged.
- Fixed `sendDesktopNotification` always routing through `alerter` / `terminal-notifier` on darwin, even for terminals (ghostty / iTerm2 / wezterm) that surface OSC 9 / OSC 99 as native notifications through their own bundle. The dispatch now prefers the OSC path on darwin when the terminal advertises native macOS notification capability; the fallback only kicks in for kitty / alacritty / vscode / unknown shells whose host app isn't a notification-capable bundle. This unblocks the user-controlled per-app notification settings flow for ghostty / iTerm2 / wezterm — toast style, NC archival, and click-to-focus all attach to the terminal app's own System Settings entry rather than to `com.apple.Terminal` (which `alerter` would post under).
- Fixed Korean IME composition leaving a growing horizontal gap between typed jamo and the cursor inside the OMP prompt under tmux + ghostty (and other macOS terminals). `Bun.stringWidth` and the underlying UAX#11 East Asian Width tables classify Hangul Compatibility Jamo (U+3131..U+318E — ㄱ ㄴ ㄷ ㄹ ㅁ ㅂ ㅅ ㅇ ㅈ ㅊ ㅋ ㅌ ㅍ ㅎ + filler) as Wide (2 cells), but every macOS terminal we ship to (Ghostty / Terminal.app / iTerm2) actually renders them as a single cell in monospace fonts. `#extractCursorPosition` was computing `col = visibleWidth(beforeMarker)` and feeding the doubled value to `\x1b[(col+1)G`, placing the hardware cursor (and therefore the IME candidate window) `N_jamo` cells past the visible glyph — exactly the gap the user saw growing as they typed. `visibleWidthRaw` now subtracts 1 cell for each Compatibility Jamo character, returning the column count macOS terminals actually use. Hangul Syllables (U+AC00..U+D7A3, e.g. `안`) stay at 2 cells in both Bun and the terminal — unaffected. Other CJK widths (Chinese / Japanese / Halfwidth Hangul) are unchanged. NOTE: the Rust `pi-natives` width tables (used by `sliceWithWidth` / `truncateToWidth` / `wrapTextWithAnsi`) also count Compatibility Jamo as 2 cells; truncation and word-wrap on jamo-heavy lines will still be slightly aggressive. The defect is invisible in normal use because the AI composes Korean as syllables, not jamo, and users type syllables once IME composition completes. A follow-up will reconcile the Rust side.
- Fixed a brief black-flash flicker in the TUI when streaming long markdown responses inside tmux (especially noticeable in ghostty with multiple panes open). Root cause: when a markdown fence line above the viewport changed between two streaming tokens (e.g. `` ``` `` → `` ```python ``), `#doRender()` would take the `firstChanged < prevViewportTop` branch and emit `\x1b[2J\x1b[H` (full screen clear + cursor home) wrapped in BSU. The BSU envelope can split across PTY reads, leaving tmux briefly displaying a blank pane before the rest of the buffer arrives — multiplied across panes during repaint. The viewport-above branch now calls a new `viewportRefresh()` helper that does cursor-home + per-line `\x1b[2K` + line content (no `\x1b[2J`), so the visible viewport content is repainted without ever clearing the screen. Scrollback above the viewport may briefly show stale rendering, but only of the SAME lines that just changed — invisible during streaming when the user isn't scrolled up. Other full-redraw paths (resize, first render, etc.) keep the hard `fullRender(true)` behavior unchanged.

### Tests

- Added `test/no-2k-anywhere.test.ts` — lint guard that scans `packages/tui/src/` for `\x1b[2K` string literals outside comments. The earlier streaming-flicker fix re-introduced the BSU-split flash bug by moving `\x1b[2K`-before-content from `fullRender` to `viewportRefresh` (same anti-pattern in a new location). This test catches that class of regression at CI time so future changes can't silently revive it.
- Added `test/render-emit-snapshot.test.ts` — four scenario-based byte-snapshot guards (single-line mutation, streaming append, above-viewport mutation triggering `viewportRefresh`, trailing-line clear on shrink). Asserts structural invariants on the EMITTED BYTES from `terminal.write(…)`: no `\x1b[2K`, no `\x1b[2J`, the new content appears, the BSU close `\x1b[?2026l` is present. Catches render-path changes that achieve the right final viewport state via a transient blank frame (which is exactly how the typing-flicker bug slipped past `render-regressions.test.ts`).
- Added `test/ime-jamo-cursor.test.ts` — six cases asserting the Input component's hardware cursor marker column does not grow at 2× per typed Korean compatibility jamo. Before commit `79e3170c6` typing 14 jamo produced a 14-cell gap between the visible text and the IME candidate window; the test caps the cursor column at `PROMPT_WIDTH + N_jamo` and asserts the per-keystroke delta is at most 1. NOTE: the Rust `pi-natives` `sliceWithWidth` still treats jamo as 2 cells (binary package, follow-up); the test guard accepts a small residual offset but flags the doubling regression.

## [14.9.8] - 2026-05-12

### Added

- Added `Terminal.setProgress(active)` to emit OSC 9;4 progress sequences with a ~1s keepalive interval so Ghostty does not clear the indicator during long-running work (ports pi-mono `a900d251` + `76bc605a`)
- Added optional `argumentHint?: string` to `SlashCommand`; rendered before the description in the autocomplete dropdown (ports pi-mono `aa25726e`)
- Added `VirtualTerminal.waitForRender()` test helper for the throttled render pipeline (ports pi-mono `41377ee8`)

### Changed

- `ProcessTerminal` `columns`/`rows` getters consult `Bun.env.COLUMNS` / `Bun.env.LINES` before falling back to 80×24, so piped/non-TTY runs honour environment-provided dimensions (ports pi-mono `32f7fc6a`)
- `requestRender()` non-force calls are coalesced to a ~16ms frame budget; `requestRender(true)` still flushes immediately via `process.nextTick` (ports pi-mono `6f5f37f8`)
- `KNOWN_TERMINALS.base` / `KNOWN_TERMINALS.trueColor` default `hyperlinks: false`; tmux and screen (`TMUX` env or `TERM` starts with `tmux`/`screen`) force `hyperlinks: false` even when the outer terminal would advertise OSC 8 (adapts pi-mono `30a8a41f`)
- `SlashCommand.getArgumentCompletions()` may return a `Promise`; results are now awaited and non-array returns are ignored (ports pi-mono `a1e10789`)
- Fuzzy `@` autocomplete now follows symlinked directories via `ScanOptions.follow_links` plumbed through the native walker (ports pi-mono `780d5367`)
- Plain `@<query>` (no slash) fuzzy matches by basename only, so `@plan` no longer surfaces every file whose ancestor directories contain `plan` (ports pi-mono `968430f6`)
- Changed slash-command autocomplete list rendering to combine command hint and description in a single displayed suggestion text
- Changed render scheduling to throttle `requestRender` calls to roughly 60fps by batching updates
- Changed terminal input handling to process complete cell-size responses without buffering partial input
- Changed `KeyId` to accept super-modifier combinations and improve typed key-id validation

### Fixed

- Fixed editor corruption on Thai Sara Am (U+0E33) and Lao AM (U+0EB3) vowels by normalizing to their compatibility decompositions on the terminal-write path while keeping editor content logically unchanged (ports pi-mono `bc668826` + `338ce3a3` + `20ca45d5`)
- Fixed cell-size detection (`CSI 6;h;w t` response) to consume only exact replies, so a bare `Escape` keystroke is no longer swallowed while waiting for terminal image metadata (ports pi-mono `49c0d860`)
- Fixed Kitty CSI-u printable input duplicating on layouts (e.g. Italian) where the terminal also emits the raw character: the immediately-following matching codepoint is now suppressed (ports pi-mono `bdb416cb`)
- Fixed bracketed-paste CSI-u `Ctrl+<letter>` re-encoding (tmux popup with `extended-keys-format=csi-u`) leaking literal `[<code>;5u` into the editor; control bytes are decoded back to their literal byte before per-char filtering (ports pi-mono `d06db09a`)
- Fixed xterm `modifyOtherKeys` shifted printable input so uppercase letters inserted via `CSI 27;mod;codepoint~` reach the editor correctly (ports pi-mono `6b55d685`)
- Fixed `super`-modified Kitty shortcuts (`super+k`, `ctrl+super+enter`, …) to parse and match via the new `KITTY_MOD_SUPER` mask (ports pi-mono `ddb8454c` + `5ed46003`)
- Fixed `ctrl+alt+<letter>` in tmux falling through to CSI-u / `modifyOtherKeys` when the legacy `ESC<ctrl-char>` form does not match (ports pi-mono `6cf5098f`)
- Fixed Markdown strikethrough requiring strict `~~text~~` delimiters with non-whitespace boundaries; single tildes no longer render strikethrough (ports pi-mono `db5274b4`)

- Allowed `SlashCommand.getArgumentCompletions` to return asynchronous results by accepting Promise-based completions
- Added `argumentHint` support to slash command definitions and displayed it in command suggestion descriptions
- Added support for xterm `modifyOtherKeys` printable key sequences by decoding `CSI 27;mod;key~` into text input
- Normalized line output during rendering to correct Thai/Lao AM glyph composition for displayed text
- Fixed duplicated Kitty key input emissions by dropping the matching unmodified follow-up sequence after a Kitty CSI-u printable-key event

## [14.9.5] - 2026-05-12

### Fixed

- Fixed rapidly blinking cursor artifact during task execution by consolidating cursor control sequences into the synchronized output buffer ([#992](https://github.com/can1357/oh-my-pi/issues/992))

## [14.5.7] - 2026-04-29

### Fixed

- Fixed editor Ctrl+Enter handling to recognize NumLock and keypad Enter variants.

## [14.3.0] - 2026-04-25

### Fixed

- Fixed shared Markdown Mermaid fenced-block rendering to resolve diagrams from fenced source text instead of external prerender state

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
