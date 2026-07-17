# TUI core renderer — the append-only contract

What you are dealing with before you touch the rendering engine. This is the
companion to [`tui-runtime-internals.md`](./tui-runtime-internals.md): that doc
maps the *flow* (input → component tree → render); this doc explains the
**render contract, why it is shaped this way, and the invariants you must not
violate**. Scope is the core engine only:

- [`packages/tui/src/tui.ts`](../packages/tui/src/tui.ts) — frame pipeline, commit ledger, window math, emitters, cursor placement.
- [`packages/tui/src/terminal.ts`](../packages/tui/src/terminal.ts) — `ProcessTerminal`, capability probes, private-CSI reassembly.
- [`packages/tui/src/terminal-capabilities.ts`](../packages/tui/src/terminal-capabilities.ts) — `TERMINAL` profile, sync-output / DECCARA / image detection.
- [`packages/tui/src/stdin-buffer.ts`](../packages/tui/src/stdin-buffer.ts) — escape-sequence reassembly.
- [`packages/tui/src/utils.ts`](../packages/tui/src/utils.ts) — width/slice/wrap (the width model).
- [`packages/tui/src/kitty-graphics.ts`](../packages/tui/src/kitty-graphics.ts) + [`components/image.ts`](../packages/tui/src/components/image.ts) — inline images.
- [`packages/tui/src/deccara.ts`](../packages/tui/src/deccara.ts) — rectangular-fill optimizer.

Application-layer renderers (transcript, tool calls, session tree, editor,
widgets) are **out of scope** — they live in `packages/coding-agent`. The one
app-layer file that is load-bearing for this contract is
[`transcript-container.ts`](../packages/coding-agent/src/modes/components/transcript-container.ts),
which implements the commit-boundary seam described below.

---

## 1. The one thing to understand first

> **The renderer cannot observe the terminal's scroll position** (ConPTY's
> probe lies; POSIX has no API at all). The previous engine tried to *guess*
> when it was safe to rewrite native scrollback, and every policy choice over
> that unobservable variable traded one failure family for another (yank ↔
> flash ↔ corruption ↔ invisible-until-resize — see the git history of this
> file for the full war journal). The current engine removes the guess
> entirely: **native scrollback is append-only.**

We keep the transcript on the **normal screen** (native scrollback, native
selection, transcript persists after exit). The engine maintains one ledger:

- **`committedRows` (C)** — frame rows `[0, C)` have been physically scrolled
  into terminal history. They are **immutable**: the engine never rewrites
  them, and components must never change them.
- **`windowTopRow` (W)** — the frame row mapped to grid row 0. The visible
  window is frame rows `[W, W + height)`, repainted in place with relative
  cursor moves.
- **commit boundary** — reported by the component tree per frame
  (`NativeScrollbackLiveRegion`) as two nested ends:
  - **byte-stable end (B)** — `commitSafeEnd ?? liveRegionStart ?? frame.length`.
    Rows below B are asserted never to re-layout and stay under the
    committed-prefix audit.
  - **durable end (D)** — `max(B, snapshotSafeEnd ?? B)`. Rows in `[B, D)` may
    still drift bytes later (a streaming markdown table re-aligning columns) but
    are *durable* — their current snapshot is permanent content, so dropping them
    when they scroll off is forbidden. They commit **audit-exempt**: later drift
    becomes a frozen stale row in history, never a re-anchor.

Per ordinary frame: `W = max(C, L − height)`, `C' = max(C, min(D, W))`, and the
only bytes that ever touch history are the **chunk** `frame[C, C')` written at
the scrollback seam. The engine also tracks **`auditRows` (A ≤ C)** — the
byte-stable leading prefix `[0, A)`; the committed-prefix audit (§2) samples only
that prefix, so the durable suffix `[A, C)` drifting never triggers a re-anchor.
Scrollback therefore equals `frame[0..C)` — every row exactly once, in order,
with its content at commit time. There is nothing to guess, nothing to defer,
and nothing to reconcile: the scroll position is irrelevant because ordinary
updates never rewrite anything a scrolled reader could be looking at.

### What this costs (the accepted tradeoffs)

- A block that has scrolled past the window top cannot reflow in place. A
  byte-stable block stays in the live region (below B) until final; a durable
  block (below D) commits its scroll-off snapshot, so a late layout change of an
  already-committed row is a frozen stale row in history (duplication never loss),
  not a dropped row.
- A component tree that reports **no seam** gets shell semantics: whatever
  scrolls off is final. Shrinking such a frame into its committed prefix
  re-anchors the window and leaves the stale copy in history (§3).
- Inside multiplexers, a resize leaves the pane history wrapped at the old
  width (same as any shell output).

---

## 2. The frame pipeline (what you are editing)

`#doRender` per frame:

1. Compose the frame (`render(width)`), collecting `liveRegionStart` /
   `commitSafeEnd` from the root children (absolute row indices).
2. **Audit the committed prefix** (`findCommittedPrefixResync`, skipped on
   geometry frames). Components must never re-layout rows below C, but real
   flows violate it (a TTSR rewind truncating a streamed block, an image-cap
   demotion shrinking a committed image) and the violation must not become
   content loss. The detector samples the prefix *tail* (up to 8 non-blank
   rows in the last 24, SGR-stripped): an in-place edit or restyle disturbs
   only the touched rows (≤1 mismatch ⇒ aligned ⇒ ignored — stale styling in
   history is the accepted artifact), while any insertion/deletion shifts
   every row below it including the tail (⇒ re-anchor C at the first changed
   row and recommit from there: history keeps the stale copy and gains a
   fresh one — **duplication, never loss**).
3. Classify: **fullPaint** (first paint, `clearScrollback` session replace, or
   geometry change outside a multiplexer — all user gestures) or **update**.
4. Window math as in §1. Two special rules:
   - **Overlays freeze commits** (`C' = C`): composited rows must never enter
     history; the hidden gap backfills via the chunk after the overlay closes.
   - **Shrink into the committed prefix** (`L ≤ C`): re-anchor
     `W = max(0, L − height)`, reset `C = min(B, W)`, keep the stale history
     above (no gesture, no erase).
5. Extract the cursor marker (strip-first: markers never reach the terminal,
   the prefix ledger, or the audit), prepare lines (width fitting), slice the
   window, composite overlays **into the window slice only** (screen
   coordinates — an overlay never touches the frame or the ledger).
6. Emit:

| Emitter | Bytes | When |
|---|---|---|
| `#emitFullPaint` | home + `frame[0, C')` + window rows; with `clearScrollback`, ED3 clears history without an ED2 viewport blank | gestures only |
| `#emitUpdate` scroll-append | `\r\n` + new bottom rows + changed-row range | the rows leaving the screen are exactly the chunk, content untouched since painted |
| `#emitUpdate` in-window diff | relative move + changed-row range rewrite | nothing scrolls, nothing commits (cursor-only when nothing changed) |
| `#emitUpdate` seam rewrite | chunk rows + full window rewrite | commit advance, window re-anchor, hidden-gap backfill, mux resize |

**ED3 (`CSI 3 J`) is emitted in exactly one place** — `#emitFullPaint` with
`clearScrollback: true` — and is reached only by user gestures: session
replace/branch/resume (`requestRender(true, { clearScrollback: true })`),
resize outside a multiplexer, `resetDisplay()` (Ctrl+L). It clears native
history without `ED2` first; the replay overwrites every row from home so
terminals without synchronized output do not expose a blank viewport. A gesture
pins the user to the tail, so the history snap is acceptable; multiplexers never
get ED3 (it is a no-op there and a replay would duplicate pane history).

The ordinary update path never emits ED2/ED3 or an absolute cursor home —
several terminal families snap a scrolled reader to the bottom on those.

### The commit-boundary seam (the load-bearing app contract)

`NativeScrollbackLiveRegion` (tui.ts) is how a component keeps mutable rows out
of history:

- `getNativeScrollbackLiveRegionStart()` — first row that may still mutate
  (everything below it, including root chrome rendered after it, stays in the
  window).
- `getNativeScrollbackCommitSafeEnd()` — optional **byte-stable** deeper boundary
  (B): the append-only prefix of the live region (a streaming assistant message's
  settled rows), asserted never to re-layout, so it stays under the audit.
- `getNativeScrollbackSnapshotSafeEnd()` — optional **durable** deeper boundary
  (D ≥ B): rows whose current snapshot is permanent but may still drift bytes
  (a streaming markdown table whose columns keep re-aligning). They commit on
  scroll-off (never dropped) but **audit-exempt** — drift after commit freezes a
  stale row in history rather than re-anchoring the audit and spraying duplicate
  snapshots. Without it, a commit-stable block that perpetually re-lays-out an
  interior row (a table taller than the window) had no byte-stable prefix past
  the table head, so its scrolled-off rows were committed nowhere and repainted
  nowhere — silent content loss as the reply streamed.

`TranscriptContainer` implements this for the coding agent: finalized blocks
freeze (their render is snapshotted, so their content can never drift after
the engine may have committed it), still-mutating blocks
(`isTranscriptBlockFinalized?.() === false`) anchor the live region, and
`deriveLiveCommitState` derives the byte-stable commit-safe end of the first
live block from two independent signals:

- **append-only detection** — a block observed growing without visibly
  rewriting an interior row commits its full body; a rewrite suspends this
  for `VOLATILE_REARM_FRAMES` clean frames.
- **stable-prefix ratchet** — rows that stayed visibly identical for a full
  `STABLE_PREFIX_COMMIT_FRAMES` window commit even while the block's tail
  keeps rewriting (a task tool's static prompt above a ticking progress
  tree). Without it, one perpetually animating row holds the whole block out
  of history, so a block taller than the window reads as cut off (head
  neither committed nor on screen) for the entire run. The ratchet tracks the
  window-minimum common prefix; a rewrite above the promoted run retreats it
  to the divergence, and rows that already committed are the engine audit's
  problem (recommit → duplication, never loss). That retreat also arms a
  permanent **rewrite floor** at the divergence: a row that mutates *after*
  surviving a full promotion window is a slow ticker (an agent row's tool/cost
  counter updating every few seconds), not settling content — without the
  floor, every quiet stretch re-promoted it and every later tick forced an
  audit recommit, spraying stale snapshots of the block into scrollback for
  the whole run. Rows at/after the floor never re-promote while the block
  lives (the floor index travels with append-shaped insertions above it);
  one-off re-layouts before any promotion never arm it, and the append-only
  path commits the full block regardless.

The byte-stable end gates audited commits; the **durable snapshot end** is the
separate floor that guarantees no loss. `TranscriptContainer` reports the whole
body of a still-live **commit-stable** block (`isTranscriptBlockCommitStable?.()
!== false`) as the snapshot-safe end, so its scrolled-off rows always reach
history even while its interior re-lays-out. Provisional blocks
(`isTranscriptBlockCommitStable?.() === false`: a collapsing tool/edit preview
whose head is a throwaway tail window) report no snapshot-safe end, so their
head is correctly dropped rather than stranded as stale history.

Freezing is unconditional — it is the engine's required guarantee, not a
per-terminal optimization.

---

## 3. Invariants — MUST / NEVER

1. **NEVER add a new `CSI 3 J` (ED3) callsite.** ED3 flows only through
   `#emitFullPaint({ clearScrollback: true })`, only for gestures, never inside
   multiplexers.
2. **NEVER rewrite a committed row.** No emitter may touch frame rows `< C`,
   and `W ≥ C` always (re-showing a committed row on the grid duplicates it
   for a scrolling reader — the historical corruption family). When a
   *component* violates immutability, the audit (§2) degrades to duplication —
   never silently skip rows, never erase history.
3. **Commits are exactly the chunk.** Any byte shape that scrolls the screen
   must scroll *only* rows accounted for by `C' − C` — that is what makes
   scrollback provably `frame[0..C)`.
4. **NEVER probe the viewport position or fork on platform in the update
   path.** win32 behaves like POSIX. The probe APIs are gone; do not
   reintroduce them.
5. **Mutable content stays below the commit boundary.** App-layer renderers
   must finalize-before-commit; the engine trusts B and clamps, it does not
   verify content.
6. **Park the hardware cursor at real content bottom**, not the padded window
   bottom, or height shrinks scroll live rows into history and duplicate them
   per resize step.
7. **Cursor writes live inside the synchronized-output frame**, before ESU —
   never as a second frame after it.
8. **NEVER throw in the render hot path.** Clamp over-wide lines
   (`truncateToWidth`); a width mismatch is cosmetic, not fatal.
9. **Multiplexers get no destructive clear and no history rewrap on resize** —
   repaint the window in place; pane history keeps its old wrap.
10. **Any change to the ledger math, the emitters, or the seam must be
    validated by the stress harness (§6)** across its full scenario matrix,
    not by a single-terminal smoke test.

---

## 4. Terminal capability detection

`TERMINAL` (`terminal-capabilities.ts`) is resolved once at import from
`TERMINAL_ID` plus environment sniffing; detection helpers are pure over
`(env, platform)` and unit-testable.

- `shouldEnableSynchronizedOutputByDefault(env, id)` → DEC 2026 default.
  Precedence: user opt-out (`PI_NO_SYNC_OUTPUT`/`PI_TUI_SYNC_OUTPUT=0`) → user
  force-on (`PI_FORCE_SYNC_OUTPUT=1`/`PI_TUI_SYNC_OUTPUT=1`) → `TERM_FEATURES`
  advertises `Sy` → `WT_SESSION` → known direct terminals → off for risky
  multiplexers and unknowns. Reconciled at runtime by the DECRQM mode-2026
  report; a user override still wins.
- `detectRectangularSgrSupport(id, env)` → DECCARA fills: kitty only, off in
  multiplexers and under `PI_NO_DECCARA`.
- `supportsScreenToScrollback` → kitty's ED22 (used once, on the initial
  paint, to preserve the pre-existing shell screen).

The old ED3-risk classifier (`eagerEraseScrollbackRisk`, `PI_TUI_ED3_SAFE`,
`submitPinsViewportToTail`) is gone: behavior no longer depends on which
terminal is rendering, so there is no risk class to detect. Env sniffing now
only selects *optimizations* (sync output, DECCARA, images), where a miss is
cosmetic, not corrupting.

---

## 5. Width model

`visibleWidth` / `truncateToWidth` / `sliceByColumn` / `wrapTextWithAnsi`
(`utils.ts`) all agree on **one UAX#11 width model**. Slicing, truncation,
wrapping, and segment extraction run on the native engine
(`@oh-my-pi/pi-natives`, Rust `unicode-width`); `visibleWidth` measures with
`Bun.stringWidth` **pinned to that same model** (`STRING_WIDTH_OPTS`:
`countAnsiEscapeCodes: false`, `ambiguousIsNarrow: true`) — a JSC builtin that
shares the native width tables without the per-call N-API box the native
scanner traps on under Bun 1.3.x. The two must never disagree; mixing unpinned
width models in measure-vs-slice produced crashes.

- Fast path: printable ASCII is one cell per code unit.
- Anything past the ASCII prefix measures through `Bun.stringWidth` (CSI/OSC
  stripped to zero); tabs are added back at the fixed `DEFAULT_TAB_WIDTH` columns.
- OSC 66 sized spans are added back as `scale × (explicit w ?? payload width)` —
  `Bun.stringWidth` would otherwise strip the whole span to zero.

**Rule:** any new measuring code routes through these helpers, and the hot
path clamps instead of throwing. Known residual: combining-heavy scripts
(Arabic harakat) survive painting verbatim, but ghostty-web's cell readback can
migrate non-spacing marks across cells — the stress harness compares those rows
with marks stripped (`sameLinesAllowingMarkDrift`).

---

## 6. The fidelity gate (use it)

`packages/tui/test/render-stress-harness.ts` drives the renderer's **real
emitted ANSI** into a ghostty-web `VirtualTerminal` across randomized op
sequences and parameterized terminal shapes, and validates the contract with a
**shadow commit ledger**: an independent reimplementation of §1's math, fed
only by observed frames (a `render` wrap) and observed bytes (a `write` wrap).
Per op it asserts:

- the whole tape (scrollback + grid) equals `shadowTape + window slice`, row
  for row, including across resizes;
- scrolled readers stay pinned and visible history rows are never rewritten;
- multiplexer pane history grows by exactly the committed chunk;
- sync-output/autowrap bracket discipline, cursor parking, background columns,
  duplicate accounting.

Run it — plus `render-regressions.test.ts`,
`streaming-scrollback-defer.test.ts`, and the `issue-*-repro.test.ts` files —
before changing ledger math, emitters, or the seam. A change that passes one
terminal and one seed is not verified.

---

## 7. Capability probes & stdin reassembly

`ProcessTerminal` fuses capability queries with a bare DA1 (`CSI c`) sentinel so
a non-answering terminal is detected when DA1 returns first. Replies can arrive
**split across a stdin flush**, so:

- `#privateCsiResponseBuffer` accumulates `\x1b[?…` partials while a sentinel is
  outstanding, rejoins on the terminator byte, then runs the handlers on the
  **complete** reply. A new `\x1b` mid-reassembly or >256 bytes abandons the
  partial so real keys still reach input.
- `#da1SentinelOwners` is a **typed FIFO** discriminated by `kind` so a
  keyboard DA1 cannot be mistaken for an OSC 11 / DECRQM / graphics-probe
  sentinel.
- DECRQM probes (2026/2048/2031) drive runtime feature gating.

**Rule:** any new probe must own a typed sentinel and survive a split reply
(feed the reply byte-by-byte in a test and assert nothing leaks to input).

---

## 8. Inline images & memory

Kitty images are **transmit-once, place-many** (`kitty-graphics.ts`).
`ImageBudget` keeps only the most-recent N images live; when the cap is
exceeded the demoted image's pixels are deleted by id (`a=d,d=I`) and its
visible rows re-render as the text fallback through the ordinary window diff —
**no destructive replay**. A demoted placement already committed to history
simply loses its pixels (committed rows are immutable), and the text fallback
is **height-preserving** once a graphic has rendered (reserved rows + fallback
line), so demotion never shrinks the block and never shifts committed content
below it.

**Rule:** never re-emit full base64 per frame. Kitty Unicode placeholders are
default-on only for kitty/ghostty (`PI_NO_KITTY_PLACEHOLDERS` /
`PI_KITTY_PLACEHOLDERS`).

---

## 9. Escape hatches (env vars)

| Var | Effect |
|---|---|
| `PI_NO_SYNC_OUTPUT=1` | Disable DEC 2026 BSU/ESU wrappers (autowrap discipline stays on). |
| `PI_TUI_SYNC_OUTPUT=0\|1` / `PI_FORCE_SYNC_OUTPUT=1` | Force sync output off / on. |
| `PI_NO_DECCARA` | Disable Kitty DECCARA rectangular-fill optimization. |
| `PI_FORCE_IMAGE_PROTOCOL=kitty\|iterm2\|sixel\|off` | Override image protocol detection. |
| `PI_NO_KITTY_PLACEHOLDERS=1` / `PI_KITTY_PLACEHOLDERS=1` | Force Kitty Unicode placeholders off / on. |
| `PI_HARDWARE_CURSOR=1` | Show the real hardware cursor instead of a rendered one. |
| `PI_NOTIFICATIONS=off\|0\|false` | Suppress terminal notifications. |
| `PI_DEBUG_REDRAW=1` | Log the chosen render intent + ledger state per frame to the debug log. |
| `PI_TUI_RESIZE_IN_PLACE=1\|0` | `1` preserves terminal-managed history and repaints after settle; `0` uses viewport-only drag paints plus one settled ED3 history rewrap. Neither path borrows the alternate screen. Default-on for terminals that re-report size on buffer toggles (Warp). |

Removed with the old engine: `PI_TUI_ED3_SAFE` (no ED3-risk lever exists),
`PI_CLEAR_ON_SHRINK` (shrinks always clear exactly), `PI_TUI_DEBUG` (per-render
dump superseded by `PI_DEBUG_REDRAW` ledger logging and the stress harness
replay/reduce tooling).

---

## 10. Before you touch the render core — checklist

- [ ] Are you about to emit `CSI 3 J` anywhere other than the gesture-driven
      `clearScrollback` full paint? **Stop.**
- [ ] Could any code path rewrite, or re-show on the grid, a frame row below
      `committedRows`? **Stop.**
- [ ] Does your byte shape scroll rows that are not the commit chunk? That
      breaks `scrollback == frame[0..C)`.
- [ ] Are you adding a viewport probe, a platform fork, or a terminal-brand
      branch to the update path? The contract exists so none are needed.
- [ ] New mutable UI above the editor? It must report (or live inside) the
      live-region seam, or it will freeze at first commit.
- [ ] Did you run the stress harness and the repro suite across the full
      scenario matrix — not just one terminal and one seed?
- [ ] New probe? Typed sentinel owner + split-reply test.
- [ ] New width path? Routed through the shared native engine, clamped (never
      thrown) in the hot path.
