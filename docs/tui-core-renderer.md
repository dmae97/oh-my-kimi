# TUI core renderer — invariants & failure modes

What you are dealing with before you touch the rendering engine. This is the
companion to [`tui-runtime-internals.md`](./tui-runtime-internals.md): that doc
maps the *flow* (input → component tree → render); this doc explains what
**does not work, why it keeps breaking, and the invariants you must not
violate**. Scope is the core engine only:

- [`packages/tui/src/tui.ts`](../packages/tui/src/tui.ts) — render planner, intent emitters, native-scrollback bookkeeping, cursor placement.
- [`packages/tui/src/terminal.ts`](../packages/tui/src/terminal.ts) — `ProcessTerminal`, capability probes, private-CSI reassembly.
- [`packages/tui/src/terminal-capabilities.ts`](../packages/tui/src/terminal-capabilities.ts) — `TERMINAL` profile, ED3 risk / sync-output / DECCARA / image detection.
- [`packages/tui/src/stdin-buffer.ts`](../packages/tui/src/stdin-buffer.ts) — escape-sequence reassembly.
- [`packages/tui/src/utils.ts`](../packages/tui/src/utils.ts) — width/slice/wrap (the width model).
- [`packages/tui/src/kitty-graphics.ts`](../packages/tui/src/kitty-graphics.ts) + [`components/image.ts`](../packages/tui/src/components/image.ts) — inline images.
- [`packages/tui/src/deccara.ts`](../packages/tui/src/deccara.ts) — rectangular-fill optimizer.

Application-layer renderers (transcript, tool calls, session tree, editor,
widgets) are **out of scope** — they live in `packages/coding-agent`.

---

## 1. The one thing to understand first

> **The renderer cannot observe the terminal's scroll position on most hosts it
> runs on.** Every decision about rewriting native scrollback is therefore a
> *guess*, and the guess has two opposite failure modes that cannot both be
> avoided by a single policy.

We keep our transcript on the **normal screen**. We deliberately have not moved
the engine to the alternate screen: alt-screen would make the terminal handle
viewport isolation, but the transcript/resume affordances would disappear with
the alternate buffer. Keeping the normal screen means
*we* own native scrollback, which means we must decide, per frame, whether it is
safe to rebuild it. To rebuild history we emit xterm **ED3** (`CSI 3 J`, erase
saved lines). Deciding when ED3 is safe requires knowing whether the user has
scrolled up — and we usually can't:

- **ConPTY hosts** (Windows Terminal, Tabby, Hyper, VS Code, conhost): the
  pseudo-console buffer is pinned to the visible grid, so any "am I at the
  bottom?" console query answers "yes" even when the reader scrolled up. The
  probe *lies*.
- **POSIX terminals**: there is no scroll-position API at all. The probe is
  *absent*.

So `Terminal.isNativeViewportAtBottom()` returns `true` / `false` / **`undefined`**,
and `undefined` ("unknown") is the common case. The whole renderer is built
around not trusting `undefined`.

### The two-way bind

| If you guess… | …and you're wrong | Symptom |
|---|---|---|
| **Eager** (rebuild now → emit `CSI 3 J`) | reader was scrolled up | **YANK** to top + **FLASH** on terminals that snap scroll on ED3 |
| **Defer** (emit nothing, reconcile later) | viewport really was at the bottom | **CORRUPTION** (stale/duplicated rows) + **invisible-until-resize** |

Yank, flash, and buffer corruption are **the same bug wearing three masks.**
Historically, every fix that suppressed one mask for one terminal class
re-enabled the opposite mask for a neighbouring class, and the follow-on
complaint landed within a day. If you "fix flashing" by making rebuilds more
eager, you will reintroduce yank. If you "fix yank" by deferring more, you will
reintroduce corruption / invisibility. **Do not move this lever without the
fidelity harness (§9) green.**

---

## 2. The render-intent planner (what you are editing)

`#doRender` is split into a **planner** (`#planRender`) that classifies a frame
into exactly one `RenderIntent`, and one `#emit*` method per intent that owns
the bytes written and the state update. All state flows through a single
`#commit` checkpoint at the end of every emitter. The intent union
(`tui.ts`, search `type RenderIntent`):

| Intent | Emits | When |
|---|---|---|
| `noop` | cursor only | nothing visible changed |
| `initial` | clear viewport, paint transcript, **keep** prior shell scrollback | first paint after `start()` |
| `sessionReplace` | clear viewport **+ ED3** (outside multiplexers) | caller forced `{ clearScrollback: true }` (switch/branch/reload/resume) |
| `historyRebuild` | clear viewport **+ ED3** (outside multiplexers) | geometry change rewrapped history, or a proven-at-tail rebuild |
| `overlayRebuild` | rebuild viewport with overlay composite | overlay visibility changed |
| `liveRegionPinned` | relative moves + per-row rewrite/suffix-clear + `\r\n` | foreground streaming on an ED3-risk host, commit-as-you-go |
| `viewportRepaint` | rewrite the visible viewport in place (optional `appendFrom` tail first) | safe non-destructive repaint |
| `deferredShrink` | padded viewport repaint, history left dirty | bottom-anchored shrink, viewport unobservable |
| `deferredMutation` | **zero bytes**, history left dirty | row-reindexing edit while possibly scrolled |
| `shrink` / `diff` | trailing-row clear / changed-line diff | ordinary in-place updates |

**ED3 (`CSI 3 J`) is emitted in exactly one place** — `#emitFullPaint` when
`clearScrollback: true` (`\x1b[2J\x1b[H\x1b[3J`). The ordinary clear is
**non-destructive**: `\x1b[22J` (copy-screen-to-scrollback, only when
`TERMINAL.supportsScreenToScrollback`) then `\x1b[2J\x1b[H`, **no `3J`**. ED3 is
reached only by `sessionReplace`/`historyRebuild`/`overlayRebuild`, and those
suppress the scrollback clear inside multiplexers (`isMultiplexerSession()` =
`TMUX || STY || ZELLIJ`).

### The predicate gates

Three private predicates encode the guessing policy. Do not "simplify" them —
each branch is load-bearing:

- `#canReplayNativeScrollbackAtCheckpoint(atBottom)` → `atBottom === true`. A
  rebuild at a **keystroke checkpoint** (prompt submit) is allowed only with a
  *positive* at-tail proof. A prompt submit is **no longer** treated as implicit
  proof for an unobservable host.
- `#canRebuildNativeScrollbackLive(atBottom, allowUnknown)` → `true` iff
  `atBottom === true`, **or** (`atBottom === undefined && allowUnknown &&
  platform !== "win32"`). i.e. live ED3 during streaming requires either proof
  or an explicit direct-user-input opt-in, and **never** on win32.
- `#nativeViewportIsScrolled(atBottom, allowUnknown)` → `true` if
  `atBottom === false`, or (`undefined && win32 && !allowUnknown`). Used to
  decide deferral.

`allowUnknownViewportMutation` is the **direct-user-input opt-in** (autocomplete
/ IME / a keystroke the user just typed). A keystroke pins the host viewport to
the bottom, so it is safe to repaint live then. It is **not** set by passive
streaming. `setEagerNativeScrollbackRebuild(true)` is the streaming opt-in; on
ED3-risk hosts it is downgraded so it never promotes to a live ED3 clear.

### Deferral + checkpoint discipline

When the viewport is unobservable during **passive streaming**, the planner
defers (`deferredMutation`/`deferredShrink`/`viewportRepaint`) and marks native
scrollback dirty (`#markNativeScrollbackDirty()`). Reconciliation happens later
at a checkpoint via `refreshNativeScrollbackIfDirty()` — and only if
`#canReplayNativeScrollbackAtCheckpoint` proves at-tail. The streaming-defer +
live-region-pin seam (`NativeScrollbackLiveRegion`,
`getNativeScrollbackLiveRegionStart` / `getNativeScrollbackCommitSafeEnd`) is the
**actively-churning** part of the engine; if you change how transient rows are
committed, every structural-mutation branch (shrink **and** grow/offscreen-edit)
must defer **symmetrically**, or you reopen the corruption family.

---

## 3. The five fault families

### YANK — viewport snapped to top — NOT fully converged
- **Mechanism:** a live `historyRebuild` fires `CSI 3 J` while the reader is
  scrolled up; ED3-snap terminals reset the visible viewport to the top of the
  (now-erased) scrollback.
- **Trigger to avoid:** treating an unobservable probe as "at bottom" during
  *passive* streaming, or OR-ing an eager-streaming flag into the live ED3 path.
- **Current stance:** never emit ED3 on an unobservable host during passive
  streaming; defer and reconcile at a keystroke checkpoint. ConPTY/win32 never
  trust the probe at all.

### CORRUPTION — duplicated / stale rows — NOT fully converged
- **Mechanism:** the flip side of the yank fix. A deferred/repainted frame
  leaves rows already committed to native scrollback out of sync with the live
  viewport; the scrollback↔viewport seam duplicates (e.g. a 2-row dup, a
  streaming-tail dup, or an async-expansion dup).
- **Trigger to avoid:** repainting the viewport over scrollback that still holds
  the old copy; a frozen/deferred block whose snapshot no longer matches after
  the region above it reflowed; one mutation branch deferring while its mirror
  branch repaints.
- **Current stance:** commit only the **stable prefix** line-count to native
  history; keep unstable rows out; reconcile drift at the checkpoint; park the
  hardware cursor at real content bottom, not padded bottom.

### FLASH (and invisible-until-resize) — NOT fully converged
- **Two distinct causes, one symptom:**
  - *Flash* = eager ED3 rebuild wrapped in DEC 2026 BSU/ESU fired per streaming
    frame on a terminal that clamps scroll on ED3 (VTE/GNOME family).
  - *Invisible-until-resize* = the defer fix over-firing, so a structural frame
    emits **zero bytes** (`deferredMutation` returns nothing) until a resize
    forces a repaint.
- **Trigger to avoid:** env-detection that misses a flashing terminal (SSH
  strips `VTE_VERSION`; some hosts set no distinguishing var); collapsing an
  `undefined` probe into a definite scrolled/at-bottom verdict.
- **Current stance:** confine ED3 to the destructive path; auto-disable DEC 2026
  at runtime when the terminal reports it unsupported (DECRQM), with
  `PI_NO_SYNC_OUTPUT` as a manual hatch; keep autowrap discipline regardless.

### WIDTH — measurement crashes / fidelity — crash class dead, accuracy unproven
- **Mechanism:** the measured column width of a line disagreed with the
  terminal's painted cells (emoji, wide graphemes, combining marks, Hangul
  jamo), and the old render loop **threw** on any mismatch — a 1-cell cosmetic
  error became a fatal whole-agent crash.
- **Current stance:** **never throw in the render hot path — clamp.** The loop
  truncates over-wide lines with `truncateToWidth`/`sliceByColumn` and logs
  (under debug) instead of dying. Width is owned end-to-end by one native UAX#11
  engine shared by measure/slice/wrap (see §6). Accuracy across all scripts
  (e.g. RTL/combining marks) is still not proven by a green gate.

### PROBE — stray bytes injected as keystrokes — RESOLVED
- **Mechanism:** a private-CSI probe reply (DA1 / kitty / mode 2031) split
  across a stdin flush; the unmatched prefix was dropped and the continuation
  bytes were forwarded as keystrokes.
- **Current stance:** buffer-and-reassemble partial CSI responses; give each
  probe a typed sentinel owner. This is the **one cleanly-closed family** —
  because its contract is *bounded and observable* (bytes in = bytes out),
  unlike the unobservable-viewport families. See §7.

---

## 4. Invariants — MUST / NEVER

These are the rules the recurrence taught us. Treat them as load-bearing.

1. **NEVER add a new `CSI 3 J` (ED3) callsite.** ED3 must flow only through
   `#emitFullPaint({ clearScrollback: true })`, for the existing destructive
   intents (`sessionReplace`, proven/safe `historyRebuild`, `overlayRebuild`).
   Ordinary redraws use the non-destructive `\x1b[22J` + `\x1b[2J\x1b[H` clear.
2. **NEVER trust an unobservable viewport probe (`undefined`) for *passive*
   streaming.** Only a positive at-tail proof, or a direct-user-input opt-in
   (`allowUnknownViewportMutation`), authorizes a live rebuild — and never on
   win32/ConPTY.
3. **NEVER throw in the render hot path.** Clamp over-wide lines; a width
   mismatch is cosmetic, not fatal.
4. **NEVER let a defer path emit a structurally-changed frame as zero bytes
   while at the bottom** — that is invisible-until-resize. `deferredMutation`/
   `deferredShrink` are only safe when the viewport is (or may be) scrolled.
5. **Defer symmetrically.** If one structural-mutation branch (shrink) defers on
   an unobservable ED3-risk host, the mirror branch (grow / offscreen-edit) must
   too. Asymmetry reopens corruption.
6. **Commit only the stable prefix to native history.** Transient/unsettled rows
   stay out of scrollback until a checkpoint; reconcile drift at the checkpoint.
7. **Park the hardware cursor at real content bottom**, not the padded viewport
   bottom, or height shrinks scroll live rows into scrollback and duplicate them
   per resize step.
8. **Cursor writes live *inside* the synchronized-output frame**, before ESU —
   never as a second frame after it (that teleports/blinks the caret).
9. **Detect terminal *risk*, not terminal *brand*, and default unknown to
   risky.** Env sniffing is necessarily incomplete (see §5); never assume an
   un-enumerated host is safe.
10. **Multiplexers (tmux/screen/zellij) get no destructive scrollback clear and
    no viewport probe.** ED3 is a no-op there and a full replay duplicates the
    transcript; repaint in place and rely on the pinned/commit-as-you-go path.
11. **Any change to the eager/defer lever, the predicates, or the live-region
    seam must be validated by the render-stress fidelity harness (§9)** across
    `{win32, POSIX} × {unknown, scrolled, at-bottom}`, not by a single-terminal
    smoke test.

---

## 5. Terminal capability detection (and why it is fragile)

`TERMINAL` (`terminal-capabilities.ts`) is resolved once at import from
`TERMINAL_ID` plus environment sniffing. The detection helpers are pure and
parameterized over `(env, platform)` so they are unit-testable:

- `detectTerminalEagerEraseScrollbackRisk(env, platform)` → is a live ED3
  rebuild unsafe here? Current policy: `false` on win32 (dedicated ConPTY
  deferral paths handle it) and when `PI_TUI_ED3_SAFE=1`; otherwise **`true`**
  for `WT_SESSION` (WT fronting WSL), SSH/tmux/screen/zellij, known
  ED3-snap/scrollback-clearing terminals (WezTerm, kitty, ghostty, alacritty,
  VTE, iTerm2, Apple Terminal, GNOME Terminal, Ptyxis, xfce4-terminal), Linux
  truecolor, **and every other unknown POSIX terminal**. The default is *risky*
  on purpose.
- `shouldEnableSynchronizedOutputByDefault(env, id)` → DEC 2026 default. Precedence:
  user opt-out (`PI_NO_SYNC_OUTPUT`/`PI_TUI_SYNC_OUTPUT=0`) → user force-on
  (`PI_FORCE_SYNC_OUTPUT=1`/`PI_TUI_SYNC_OUTPUT=1`) → `TERM_FEATURES` advertises
  `Sy` → `WT_SESSION` (WT/WSL) → known direct terminals
  (kitty/ghostty/wezterm/iterm2/alacritty/vscode; SSH passes through) → off for
  risky multiplexers and everything else (VTE-family, GNU screen, Apple Terminal,
  legacy conhost, unknown). Reconciled at runtime by the DECRQM mode-2026 report:
  a positive report **enables** sync (upgrading default-off muxes like
  zellij/tmux-master), a negative one disables it; a user override still wins.
  `synchronizedOutputUserOverride(env)` is the shared opt-out/force resolver.
- `detectRectangularSgrSupport(id, env)` → DECCARA fills: **kitty only**
  (ghostty does not implement the SGR-background extension), off in multiplexers
  and under `PI_NO_DECCARA`.

**Why this keeps leaking:** terminal class is inferred from env vars that are
**not durable**. `VTE_VERSION` is stripped by `sshd` (default `AcceptEnv`);
`COLORTERM` is also not in default `AcceptEnv`; some hosts (Tabby) set no
distinguishing var; WSL-fronting-WT is neither pure win32 nor pure POSIX. Every
missed env var is a missed terminal class is a new complaint. The mitigations
are: (a) **default unknown to risky** rather than safe, and (b) detect by
*behavior/handshake* (DECRQM) where possible rather than a host allow-list. When
you add a terminal, add it to the pure detector and add the **SSH-stripped env
shape** to the test, not just the env-present shape.

---

## 6. Width model

`visibleWidth` / `truncateToWidth` / `sliceByColumn` / `wrapTextWithAnsi`
(`utils.ts`) all route through **one native UAX#11 engine** (`@oh-my-pi/pi-natives`,
Rust `unicode-width`). We deliberately dropped `Bun.stringWidth` because it
disagreed with the engine on combining marks and jamo, and mixing two width
models in measure-vs-slice produced the crashes.

- Fast path: printable ASCII is one cell per code unit.
- ZWJ pictographic emoji take the `visibleWidthByGrapheme` override (ANSI spans
  excised first, then `Intl.Segmenter`), because the native scanner double-counts
  SGR bytes when a sequence is split by the segmenter.
- OSC 66 sized text (`\x1b]66;…`) takes the native path.

**Rule:** if you add a code path that measures width, route it through these
helpers. Never reintroduce `Bun.stringWidth` or a parallel width table — the
measure model and the slice/wrap model must agree, or you get over-wide lines
that the hot-path clamp silently truncates (cosmetic loss) or, worse, seam
duplication.

---

## 7. Capability probes & stdin reassembly

`ProcessTerminal` fuses capability queries with a bare DA1 (`CSI c`) sentinel so
a non-answering terminal is detected when DA1 returns first. Replies can arrive
**split across a stdin flush**, so:

- `#privateCsiResponseBuffer` accumulates `\x1b[?…` partials while a sentinel is
  outstanding, rejoins on the terminator byte (0x40–0x7e), then runs the
  DA1/kitty/mode-2031 handlers on the **complete** reply. A new `\x1b`
  mid-reassembly or >256 bytes abandons the partial so real keys (e.g. arrow
  `\x1b[A`) still reach input.
- `#da1SentinelOwners` is a **typed FIFO** discriminated by `kind` (`keyboard`,
  `osc11`, `privateMode`, `kittyGraphicsProbe`, `osc99Probe`) so a keyboard DA1
  cannot be mistaken for an OSC 11 / DECRQM / graphics-probe sentinel.
- DECRQM probes (`#queryPrivateMode(2026/2048/2031)`) record support via DECRPM
  and drive runtime feature gating (e.g. auto-disabling DEC 2026 sync output).

**Rule:** any new probe must own a typed sentinel and survive a split reply. The
contract is bytes-in = bytes-out; it is testable, so test it (feed the reply
byte-by-byte and assert nothing leaks to the input handler).

---

## 8. Inline images & memory

Kitty images are **transmit-once, place-many** (`kitty-graphics.ts`):
`encodeKittyTransmit` (`a=t`, keyed by a stable `i=`) writes the base64 a single
time; repaints emit only `encodeKittyPlacement` (`a=p`). Text clears
(`CSI 2 J` / `CSI 3 J`) do **not** purge the terminal's image store — only
`encodeKittyDeleteImage` (`a=d,d=I`) does. `ImageBudget` (`components/image.ts`)
keeps only the most-recent N images live; demoted images render their text
fallback and are explicitly purged.

**Rule:** never re-emit full base64 per frame (it pegged RAM and pinned the UI
thread). Kitty Unicode placeholders are default-on only for kitty/ghostty
(`PI_NO_KITTY_PLACEHOLDERS` / `PI_KITTY_PLACEHOLDERS`); other Kitty-protocol
hosts render placeholder cells as literal PUA glyphs, so they fall back to
direct `a=p` placement.

---

## 9. The fidelity gate (use it)

`packages/tui/test/render-stress-harness.ts` renders the renderer's **real emitted ANSI** into
a ghostty-web `VirtualTerminal` and asserts viewport fidelity (a scrolled reader
stays put), background-column fidelity, and scrollback-buffer fidelity, across
parameterized terminal shapes and randomized op sequences.

This harness is the structural fix for the whole recurrence: every guess-flip and
sniffing-gap regression historically **shipped blind and was caught by a user**,
because no automated "a scrolled-up reader stays pinned across kitty/WT/WSL/
ConPTY" assertion gated CI. **Before you change the eager/defer lever, a
predicate, the live-region seam, or width math, run the stress harness and the
targeted repro tests** (`packages/tui/test/render-regressions.test.ts`,
`packages/tui/test/streaming-scrollback-defer.test.ts`, the `issue-*-repro.test.ts` files).
A change that passes one terminal and one seed is not verified.

---

## 10. Escape hatches (env vars)

| Var | Effect |
|---|---|
| `PI_NO_SYNC_OUTPUT=1` | Disable DEC 2026 BSU/ESU wrappers (autowrap discipline stays on). For terminals that advertise but mishandle mode 2026. |
| `PI_TUI_SYNC_OUTPUT=0\|1` / `PI_FORCE_SYNC_OUTPUT=1` | Force sync output off / on. |
| `PI_TUI_ED3_SAFE=1` | Declare the terminal safe for live ED3 (disables `eagerEraseScrollbackRisk`). |
| `PI_NO_DECCARA` | Disable Kitty DECCARA rectangular-fill optimization (force padded-string fills). |
| `PI_FORCE_IMAGE_PROTOCOL=kitty\|iterm2\|sixel\|off` | Override image protocol detection. |
| `PI_NO_KITTY_PLACEHOLDERS=1` / `PI_KITTY_PLACEHOLDERS=1` | Force Kitty Unicode placeholders off / on. |
| `PI_CLEAR_ON_SHRINK=1` | Clear empty rows when content shrinks (default off). |
| `PI_HARDWARE_CURSOR=1` | Show the real hardware cursor instead of a rendered one. |
| `PI_NOTIFICATIONS=off\|0\|false` | Suppress terminal notifications. |
| `PI_DEBUG_REDRAW=1` | Log the chosen render intent per frame to the debug log. |
| `PI_TUI_DEBUG=1` | Dump per-render diff state under `/tmp/tui`. |

---

## 11. Before you touch the render core — checklist

- [ ] Are you about to emit `CSI 3 J` anywhere other than the destructive
      `clearScrollback` path? **Stop.**
- [ ] Does your change trust `isNativeViewportAtBottom() === undefined` as
      "at bottom" during passive streaming? **Stop.**
- [ ] Did you change one structural-mutation branch without mirroring its
      sibling (shrink ↔ grow)? **Defer symmetrically.**
- [ ] Could any frame now emit zero bytes while the viewport is at the bottom?
      That's invisible-until-resize.
- [ ] Did you add a terminal by brand instead of by behavior, or skip the
      SSH-stripped env shape in the test?
- [ ] Did you run `packages/tui/test/render-stress-harness.ts` + the repro suite across
      win32/POSIX × unknown/scrolled/at-bottom — not just one terminal?
- [ ] New probe? Typed sentinel owner + split-reply test.
- [ ] New width path? Routed through the shared native engine, clamped (never
      thrown) in the hot path.
