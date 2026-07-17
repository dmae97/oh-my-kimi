/**
 * Minimal TUI implementation with differential rendering.
 *
 * Append-only render contract: rows committed to native scrollback are
 * immutable — the tape is the terminal's visual record. Whatever scrolls
 * above the window enters history exactly once, in order: as exact-final
 * bytes when the component seam (`NativeScrollbackLiveRegion`) declared them
 * final, else as a frozen snapshot of what was on screen. When recorded
 * history diverges from the frame (a finalized block replacing its
 * scrolled-off live render), the engine erases and replays (ED3, `CSI 3 J`)
 * so history holds the content exactly once — the same replay used for
 * gestures (session replace, resize, resetDisplay). Multiplexer panes, where
 * ED3 is unsafe, instead re-anchor and recommit below the stale fragment —
 * duplication, never loss. The engine never probes or guesses the terminal's
 * scroll position, and the hot path clamps over-wide lines instead of
 * throwing. See `docs/tui-core-renderer.md`.
 */
import * as fs from "node:fs";
import { performance } from "node:perf_hooks";
import { $flag, getDebugLogPath } from "@oh-my-pi/pi-utils";
import { DEFAULT_MAX_INLINE_IMAGES, ImageBudget } from "./components/image";
import { planDeccaraFills } from "./deccara";
import { isKeyRelease, matchesKey } from "./keys";
import { LoopWatchdog } from "./loop-watchdog";
import { isConPTYHosted, setAltScreenActive, type Terminal } from "./terminal";
import {
	encodeKittyDeleteImage,
	ImageProtocol,
	isInsideTerminalMultiplexer,
	setCellDimensions,
	setTerminalImageProtocol,
	shouldEnableSynchronizedOutputByDefault,
	synchronizedOutputUserOverride,
	TERMINAL,
} from "./terminal-capabilities";
import {
	Ellipsis,
	extractSegments,
	normalizeTerminalOutput,
	sliceByColumn,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
} from "./utils";

const SEGMENT_RESET = "\x1b[0m";
/**
 * Per-line terminator written after every non-image content row. It closes both
 * SGR state and any in-flight OSC 8 hyperlink so styles/links cannot bleed
 * across lines in scrollback. Kept out of the diff/width cache because reset
 * bytes are deterministic write framing, not content.
 */
const LINE_TERMINATOR = "\x1b[0m\x1b]8;;\x07";
const ERASE_LINE = "\x1b[2K";
const ERASE_TO_END_OF_LINE = "\x1b[K";
// Keep the common short-row path out of native width/truncation. Longer rows
// are fit by visible cells, not source code units, so zero-width-heavy prefixes
// cannot hide visible suffix text that still belongs in the viewport.
const LINE_FIT_MIN_SOURCE_CODE_UNITS = 4096;
const LINE_FIT_MAX_SOURCE_CODE_UNITS = 65536;
const LINE_FIT_SOURCE_WIDTH_MULTIPLIER = 64;
// Hide the hardware cursor before each paint/move write. Ghostty-style bar
// cursors can otherwise leave visual afterimages while the TUI repaints the
// row under a visible cursor. Paint writes also disable terminal autowrap:
// several terminals keep a "pending wrap" flag after an exact-width row, so a
// following cursor move can first wrap to the next row and produce staircase
// trails. The TUI emits explicit CRLFs and restores autowrap before leaving the
// paint. Synchronized output can be disabled for terminals with broken DEC 2026
// implementations; autowrap discipline stays on either way.
const HIDE_CURSOR = "\x1b[?25l";
const SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
const SYNC_OUTPUT_END = "\x1b[?2026l";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const PAINT_BEGIN = `${HIDE_CURSOR}${SYNC_OUTPUT_BEGIN}${DISABLE_AUTOWRAP}`;
const PAINT_END = `${ENABLE_AUTOWRAP}${SYNC_OUTPUT_END}`;
const PAINT_BEGIN_NO_SYNC = `${HIDE_CURSOR}${DISABLE_AUTOWRAP}`;
const PAINT_END_NO_SYNC = ENABLE_AUTOWRAP;
const CURSOR_BEGIN = `${HIDE_CURSOR}${SYNC_OUTPUT_BEGIN}`;
const CURSOR_BEGIN_NO_SYNC = HIDE_CURSOR;
const CURSOR_END = SYNC_OUTPUT_END;
const CURSOR_END_NO_SYNC = "";
// Mouse reporting is scoped to fullscreen overlays that opt into pointer
// interaction. 1000h = button click tracking, 1003h = any-motion tracking for
// hover targets, and 1006h = SGR extended coordinates past column/row 223.
// Selection-first overlays leave these modes disabled so the terminal retains
// native text selection.
const MOUSE_TRACKING_ON = "\x1b[?1000h\x1b[?1003h\x1b[?1006h";
const MOUSE_TRACKING_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;
type StartListener = () => void;

export interface RenderTimer {
	cancel(): void;
}

export interface RenderScheduler {
	now(): number;
	scheduleImmediate(callback: () => void): void;
	scheduleRender(callback: () => void, delayMs: number): RenderTimer;
}

export interface TUIOptions {
	renderScheduler?: RenderScheduler;
}

export interface TUIStartOptions {
	/** Clear saved native scrollback before the first paint. */
	clearScrollback?: boolean;
}

const DEFAULT_RENDER_SCHEDULER: RenderScheduler = {
	now: () => performance.now(),
	scheduleImmediate: callback => {
		setImmediate(callback);
	},
	scheduleRender: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		return {
			cancel: () => {
				clearTimeout(timer);
			},
		};
	},
};

/**
 * Component interface - all components must implement this
 *
 * Render contract: the returned array (and its rows) belongs to the component.
 * Callers MUST NOT mutate it — components are allowed to return a cached array
 * and will return the exact same reference for as long as their rendered
 * content is unchanged. Conversely, a component MUST return a fresh array
 * reference whenever its content changed; reference equality across two
 * render() calls is the engine's proof that the rows are byte-identical
 * (containers memoize their concatenation on it, and the TUI derives the
 * frame's stable prefix from it). A component that mutates a previously
 * returned array in place must implement {@link RenderStablePrefix} to declare
 * which leading rows survived.
 */
export interface Component {
	/**
	 * Render the component to an array of physical rows at the given width.
	 * The result is component-owned and `readonly` to the caller; an unchanged
	 * component may (and should) return the same array reference it returned
	 * last time.
	 */
	render(width: number): readonly string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Optional hook to invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate?(): void;
	/**
	 * Optional hook to set whether this component ignores tight layout mode.
	 */
	setIgnoreTight?(ignore: boolean): any;

	/**
	 * Optional teardown. Called when the component is permanently removed from
	 * the live tree (e.g. a transcript reset). Release timers, intervals, and
	 * subscriptions here. Must be idempotent. Containers propagate dispose to
	 * their children; leaf components without resources may omit it.
	 */
	dispose?(): void;
}

/** Lets an overlay root delegate keyboard focus to components it owns. */
export interface OverlayFocusOwner {
	/** Returns true when `component` is a focus target inside this overlay. */
	ownsOverlayFocusTarget(component: Component): boolean;
}

/**
 * Component seam for append-only native-scrollback commits. A component whose
 * rendered rows can still change reports, after each render, the local line
 * index where that mutable suffix begins. Rows above the boundary are declared
 * FINAL — byte-stable at the current width for the component's lifetime — and
 * commit to native scrollback as exact, audited content. Rows at/after the
 * boundary repaint in place inside the visible window; when they scroll above
 * the window top they still commit — the tape records what was on screen —
 * but as frozen visual snapshots that are permanently audit-exempt: later
 * re-layout of their source never re-anchors or recommits them. A root that
 * reports no seam commits everything that scrolls as final (shell semantics).
 *
 * When several root children report a seam in the same frame, the topmost one
 * defines the boundary: exactness is prefix-only, so everything below the
 * first seam is already excluded.
 */
export interface NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined;
}

export interface NativeScrollbackCommittedRows {
	setNativeScrollbackCommittedRows(rows: number): void;
}

/**
 * A component that discards rows after they enter native scrollback implements
 * this hook so a destructive full replay can rehydrate its complete frame.
 */
export interface NativeScrollbackReplay {
	prepareNativeScrollbackReplay(): void;
}

function prepareNativeScrollbackReplay(component: Component): void {
	(component as Component & Partial<NativeScrollbackReplay>).prepareNativeScrollbackReplay?.();
}

function setNativeScrollbackCommittedRows(component: Component, rows: number): void {
	(component as Component & Partial<NativeScrollbackCommittedRows>).setNativeScrollbackCommittedRows?.(rows);
}

function isOverlayFocusTarget(owner: Component, component: Component | null): boolean {
	if (component === owner) return true;
	if (!component) return false;
	const candidate = owner as Component & Partial<OverlayFocusOwner>;
	return candidate.ownsOverlayFocusTarget?.(component) === true;
}

function getNativeScrollbackLiveRegionStart(component: Component): number | undefined {
	return (component as Component & Partial<NativeScrollbackLiveRegion>).getNativeScrollbackLiveRegionStart?.();
}

/**
 * Opt-in stability report for components that mutate their returned render
 * array in place across frames (instead of returning a fresh array per
 * change). The engine reads it right after the component's `render()` returns:
 * the report counts the leading rows of the just-returned array that are
 * byte-identical to the array state the reader last observed. The engine uses
 * it to reuse the composed frame's prefix — skipping marker extraction, line
 * preparation, and the committed-prefix audit for those rows.
 *
 * Contract:
 * - Reading CONSUMES the report: it re-bases the baseline to the current
 *   array state. The accumulated count therefore covers every render since
 *   the previous read, so out-of-band `render()` calls between engine frames
 *   (an exporter walking the tree) can only lower the report, never inflate
 *   it past what the engine actually has.
 * - An implementer that cannot prove stability for a frame must lower the
 *   accumulated count to 0 for that render.
 * - Rows at or beyond the report may have been mutated in place; rows before
 *   it must be the identical string values at the identical indices.
 */
export interface RenderStablePrefix {
	getRenderStablePrefixRows(): number;
}

function getRenderStablePrefixRows(component: Component): number | undefined {
	return (component as Component & Partial<RenderStablePrefix>).getRenderStablePrefixRows?.();
}

/**
 * Opt-in fast path for composing only the visible tail of a tall component
 * during a terminal resize. A drag emits a SIGWINCH burst, and the width
 * changes on every event: a full compose re-lays-out (and, for markdown,
 * re-lexes) the entire transcript per event — O(history) work that is
 * discarded the instant the next event arrives. While the resize is in flight
 * the engine paints only the viewport, so it asks each tall root child for at
 * most `maxRows` rows from the bottom of its render at `width` and skips
 * composing everything above the fold. The authoritative full paint replays
 * once the drag settles (see {@link TUI} resize handling).
 *
 * Contract:
 * - Returns the BOTTOM rows of the component's full render at `width`, in
 *   top-to-bottom order, capped at `maxRows` (fewer when the component is
 *   shorter). The rows MUST be byte-identical to the corresponding tail of
 *   what `render(width)` would have returned, modulo a one-row separator at
 *   the very top edge (a transient frame the settle paint overwrites).
 * - MUST NOT mutate any persistent full-compose state: the next `render()`
 *   (the settle paint) has to reconcile exactly as if the tail render never
 *   happened. Warming pure per-width render caches is fine and desirable.
 */
export interface ViewportTailProvider {
	renderViewportTail(width: number, maxRows: number): readonly string[];
}

function asViewportTailProvider(component: Component): ViewportTailProvider | undefined {
	const candidate = component as Component & Partial<ViewportTailProvider>;
	return typeof candidate.renderViewportTail === "function" ? (candidate as ViewportTailProvider) : undefined;
}

/**
 * Interface for components that can receive focus and display a cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 *
 * Components that can switch between terminal-cursor and software-cursor
 * rendering expose `setUseTerminalCursor`; TUI keeps that mode in sync with
 * its resolved hardware-cursor preference whenever focus or the preference
 * changes.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
	/** Set by TUI when hardware cursor rendering is enabled or disabled. */
	setUseTerminalCursor?(useTerminalCursor: boolean): void;
}

/** Options for scheduling a TUI render. */
export interface RenderRequestOptions {
	/** Clear terminal scrollback for intentional transcript replacement. */
	clearScrollback?: boolean;
}
/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

/** Detect terminal multiplexers where scrollback clearing and height-change redraws are hostile. */
function isMultiplexerSession(): boolean {
	return isInsideTerminalMultiplexer();
}

/**
 * Terminals that re-report their size whenever the alternate screen buffer is
 * toggled. The non-multiplexer resize fast path ({@link TUI.#beginResizeViewport})
 * borrows the alternate screen for throwaway drag frames; on these terminals
 * entering/leaving the alt buffer emits a fresh SIGWINCH (Warp reports a height
 * one row different for the alt buffer), which re-enters the fast path — a
 * self-sustaining resize loop that floods ED3 full repaints even though the
 * geometry never actually changes. Routing them through the in-place
 * (multiplexer) resize path never touches the alt buffer, breaking the loop.
 *
 * `PI_TUI_RESIZE_IN_PLACE=1|0` forces this on/off for any terminal.
 */
function reportsSizeOnAltScreenToggle(): boolean {
	const override = Bun.env.PI_TUI_RESIZE_IN_PLACE;
	if (override === "0" || override === "false") return false;
	if (override === "1" || override === "true") return true;
	return Bun.env.TERM_PROGRAM?.toLowerCase() === "warpterminal";
}

/**
 * Resize should repaint the visible window in place — no alternate-screen
 * borrow, no ED3 scrollback rewrap — for multiplexer panes and for terminals
 * that loop on alt-screen toggles. The tradeoff is identical to a multiplexer:
 * scrollback above the window keeps its old wrap instead of being re-flowed.
 */
function resizeRepaintsInPlace(): boolean {
	return isMultiplexerSession() || reportsSizeOnAltScreenToggle();
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;

	// === Fullscreen ===
	/**
	 * Borrow the terminal's alternate screen buffer for this overlay's lifetime
	 * (vim/less idiom). While the topmost visible overlay sets this, the engine
	 * paints only the modal on the alt screen and emits no ED3 / scrollback
	 * bytes, so the transcript on the normal screen stays untouched and is not
	 * scrollable behind the modal. Defaults off — all other overlays are
	 * unchanged and still draw over the transcript on the normal screen.
	 */
	fullscreen?: boolean;
	/**
	 * Enable terminal mouse reporting while fullscreen. Defaults on; disable it
	 * when native terminal text selection takes precedence over pointer events.
	 */
	mouseTracking?: boolean;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
}

/**
 * Container - a component that contains other components
 */
export class Container implements Component, NativeScrollbackCommittedRows, NativeScrollbackReplay {
	children: Component[] = [];

	// Memoized concatenation of the children's latest renders. Children are
	// still rendered every frame (renders carry side effects: image placement
	// registration, seam/stability reports); the memo only skips rebuilding
	// the concatenated array when every child returned the exact same array
	// reference at the same width — which, per the Component render contract,
	// proves the rows are byte-identical. Cleared on any child-list change and
	// on invalidate().
	#memoLines: string[] | undefined;
	#memoChildLines: (readonly string[])[] = [];
	#memoWidth = -1;

	#ignoreTight = false;

	setIgnoreTight(ignore: boolean): this {
		this.#ignoreTight = ignore;
		for (const child of this.children) {
			child.setIgnoreTight?.(ignore);
		}
		this.invalidate();
		return this;
	}

	addChild(component: Component): void {
		this.children.push(component);
		if (this.#ignoreTight) {
			component.setIgnoreTight?.(true);
		}
		this.#memoLines = undefined;
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.#memoLines = undefined;
		}
	}

	clear(): void {
		this.children = [];
		this.#memoLines = undefined;
	}

	/** Dispose every child, then detach it from this container. */
	disposeChildren(): void {
		this.dispose();
		this.clear();
	}

	invalidate(): void {
		this.#memoLines = undefined;
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	/**
	 * Propagate teardown to children. Call when the container's children are
	 * being permanently discarded (not when they are detached for reuse — use
	 * {@link clear} for that). Idempotent per child via each child's own dispose.
	 */
	dispose(): void {
		for (const child of this.children) {
			child.dispose?.();
		}
	}

	/**
	 * Split the committed prefix from the container's most recently rendered
	 * rows across its children. The memoized child arrays are the exact geometry
	 * that produced that frame; when the child list was invalidated or rebuilt,
	 * there is no safe old-to-new coordinate mapping, so propagation waits for
	 * the next render/post-emit publication.
	 */
	setNativeScrollbackCommittedRows(rows: number): void {
		const refs = this.#memoChildLines;
		if (this.#memoLines === undefined || refs.length !== this.children.length) return;
		const committed = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
		let offset = 0;
		for (let i = 0; i < this.children.length; i++) {
			const childRows = refs[i];
			if (childRows === undefined) return;
			setNativeScrollbackCommittedRows(
				this.children[i]!,
				Math.min(childRows.length, Math.max(0, committed - offset)),
			);
			offset += childRows.length;
		}
	}

	/** Recursively discard layout locks that are meaningful only to the old tape. */
	prepareNativeScrollbackReplay(): void {
		for (const child of this.children) prepareNativeScrollbackReplay(child);
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		const children = this.children;
		const count = children.length;
		let refs = this.#memoChildLines;
		let unchanged = this.#memoLines !== undefined && this.#memoWidth === width && refs.length === count;
		if (refs.length !== count) {
			refs = new Array(count);
			this.#memoChildLines = refs;
		}
		for (let i = 0; i < count; i++) {
			const childLines = children[i]!.render(width);
			if (refs[i] !== childLines) {
				unchanged = false;
				refs[i] = childLines;
			}
		}
		this.#memoWidth = width;
		if (unchanged) return this.#memoLines!;
		const lines: string[] = [];
		for (let i = 0; i < count; i++) {
			const childLines = refs[i]!;
			for (let j = 0; j < childLines.length; j++) lines.push(childLines[j]!);
		}
		this.#memoLines = lines;
		return lines;
	}
}

/**
 * Render intent. `#doRender` classifies each frame, and the matching `#emit*`
 * method owns the bytes written and the state update.
 *
 * - `fullPaint`: gesture-driven replay — initial paint, session replacement,
 *   resize, resetDisplay. Rewrites the frame from home; destructive replaces
 *   clear native scrollback via ED3 without first blanking the viewport. The
 *   only ED3 callsite in the engine.
 * - `update`: ordinary frame. Commits the newly settled chunk at the
 *   scrollback seam (if any) and repaints the window with relative moves.
 */
type RenderIntent =
	| { kind: "fullPaint"; clearScrollback: boolean }
	| { kind: "update"; chunkTo: number; windowTop: number };

interface HardwareCursorState {
	row: number;
	col: number;
	visible: boolean;
}

interface HardwareCursorUpdate {
	toRow: number;
	state: HardwareCursorState | null;
	visible?: boolean;
}

interface CursorControlResult extends HardwareCursorUpdate {
	seq: string;
	toCol: number;
	visible: boolean;
}

/**
 * One root child's contribution to the composed frame: the array reference its
 * render() returned, the frame row it starts at, the row count recorded at
 * compose time (in-place mutators keep the reference but may change length),
 * and the child-local seam report captured at render time — replayed verbatim
 * when a component-scoped frame reuses this segment without re-rendering.
 */
interface FrameSegment {
	component: Component;
	lines: readonly string[];
	start: number;
	rowCount: number;
	liveLocalStart?: number;
}

/** Depth-first identity search through `Container`-shaped children. */
function subtreeContains(root: Component, target: Component): boolean {
	if (root === target) return true;
	const children = (root as Partial<Container>).children;
	if (!Array.isArray(children)) return false;
	for (let i = 0; i < children.length; i++) {
		if (subtreeContains(children[i]!, target)) return true;
	}
	return false;
}

interface PreparedLine {
	raw: string;
	width: number;
	line: string;
}

const SGR_SEQUENCE = /\x1b\[[0-9;:]*m/g;

// SGR coalescing. The renderer's component tree emits a styled span as
// `<set-color>text<reset>`, so adjacent spans produce runs of byte-adjacent
// SGR sequences (e.g. a `CSI 39 m` fg-reset immediately followed by the next
// span's `CSI 38;2;r;g;b m`). Two byte-adjacent SGR sequences are semantically
// identical to one SGR carrying both parameter lists (SGR params apply
// left-to-right), so merging the run into a single `CSI … m` is
// behavior-preserving: it drops the redundant `ESC[`/`m` framing and lets the
// terminal dispatch one SGR instead of several. On a real transcript ~40% of
// all SGR sequences are collapsible this way, which meaningfully cuts the
// per-frame byte volume and SGR-dispatch count a slow (xterm.js/WebGL) terminal
// must process. On by default; `PI_NO_SGR_COALESCE=1` disables it.
const SGR_COALESCE_ENABLED = !$flag("PI_NO_SGR_COALESCE");
const CC_ESC = 0x1b;
const CC_BRACKET = 0x5b; // [
const CC_M = 0x6d; // m
const CC_SEMI = 0x3b; // ;
const CC_COLON = 0x3a; // :
// Max parameter tokens per emitted merged SGR. Kept well under xterm.js's
// 32-param cap (and the tighter limits of some real terminals) so a long
// adjacent run is split into several valid CSIs instead of overflowing one.
const MERGE_TOKEN_CAP = 16;

function isSgrParamByte(c: number): boolean {
	return (c >= 0x30 && c <= 0x39) || c === CC_SEMI || c === CC_COLON;
}

// True when a parameter list ends mid extended-color spec in the ambiguous
// semicolon form: `38/48/58;2` with fewer than three channel values, or
// `38/48/58;5` with no palette index. Concatenating another list after such a
// run would let the next code be absorbed as the missing channel/index (e.g.
// `38;2;255;0` + `31` → `38;2;255;0;31`, where `31` becomes blue instead of a
// standalone fg-red), changing the rendered color. The self-delimiting colon
// form (`38:2::r:g:b`) is unambiguous — its tokens never equal a bare `38`, so
// the scan treats it as a complete unit and merging stays safe.
function endsWithIncompleteExtendedColor(params: string): boolean {
	const t = params.split(";");
	let i = 0;
	while (i < t.length) {
		const tok = t[i];
		if (tok === "38" || tok === "48" || tok === "58") {
			const mode = t[i + 1];
			if (mode === undefined) return true; // introducer with no mode
			if (mode === "2") {
				if (i + 4 >= t.length) return true; // missing r/g/b
				i += 5;
				continue;
			}
			if (mode === "5") {
				if (i + 2 >= t.length) return true; // missing index
				i += 3;
				continue;
			}
		}
		i += 1;
	}
	return false;
}

/**
 * Merge runs of byte-adjacent SGR sequences (`CSI [0-9;:]* m`) into one. Only
 * CSI-SGR sequences are touched; text, cursor moves, OSC, hyperlinks and image
 * payloads pass through verbatim. Returns the original reference when nothing
 * merges, so SGR-light lines incur only a single `indexOf` scan.
 */
export function coalesceAdjacentSgr(line: string): string {
	if (!SGR_COALESCE_ENABLED || line.indexOf("\x1b[") === -1) return line;
	const n = line.length;
	let out = "";
	let copiedUpto = 0;
	let i = 0;
	while (i < n) {
		if (line.charCodeAt(i) !== CC_ESC || line.charCodeAt(i + 1) !== CC_BRACKET) {
			i++;
			continue;
		}
		// Scan a candidate SGR sequence: ESC [ <params> m.
		let j = i + 2;
		while (j < n && isSgrParamByte(line.charCodeAt(j))) j++;
		if (j >= n || line.charCodeAt(j) !== CC_M) {
			// Not an SGR (e.g. cursor move); leave it in the pending region.
			i = j;
			continue;
		}
		// Collect the run of adjacent SGR sequences starting here.
		const params: string[] = [line.slice(i + 2, j)];
		let k = j + 1;
		while (k < n && line.charCodeAt(k) === CC_ESC && line.charCodeAt(k + 1) === CC_BRACKET) {
			let p = k + 2;
			while (p < n && isSgrParamByte(line.charCodeAt(p))) p++;
			if (p >= n || line.charCodeAt(p) !== CC_M) break;
			params.push(line.slice(k + 2, p));
			k = p + 1;
		}
		if (params.length > 1) {
			out += line.slice(copiedUpto, i);
			// Emit the merged run, but flush the current group before appending a
			// list when (a) the previous list ended mid extended-color, so the
			// next code cannot be absorbed as its missing channel/index, or (b)
			// the token count would exceed MERGE_TOKEN_CAP. SGR params apply
			// left-to-right regardless of how they are grouped across adjacent
			// CSIs, so a capped/guarded split stays behavior-preserving — while a
			// single unbounded merge would overflow a terminal's CSI parameter
			// buffer (xterm.js caps at 32 and silently truncates the rest,
			// corrupting colors). Empty params (`CSI m`) mean a full reset;
			// normalize to `0` so the merged list stays unambiguous.
			let group = "";
			let groupTokens = 0;
			let groupOpenSafe = true;
			for (let q = 0; q < params.length; q++) {
				const norm = params[q]!.length === 0 ? "0" : params[q]!;
				let tk = 1;
				for (let z = 0; z < norm.length; z++) {
					const cc = norm.charCodeAt(z);
					if (cc === CC_SEMI || cc === CC_COLON) tk++;
				}
				if (groupTokens > 0 && (!groupOpenSafe || groupTokens + tk > MERGE_TOKEN_CAP)) {
					out += `\x1b[${group}m`;
					group = "";
					groupTokens = 0;
				}
				group += group.length === 0 ? norm : `;${norm}`;
				groupTokens += tk;
				groupOpenSafe = !endsWithIncompleteExtendedColor(norm);
			}
			if (group.length > 0) out += `\x1b[${group}m`;
			copiedUpto = k;
		}
		i = k;
	}
	if (copiedUpto === 0) return line;
	return out + line.slice(copiedUpto);
}

/** Compare two rows ignoring SGR styling (theme restyles keep alignment). */
function rowsEquivalent(a: string, b: string): boolean {
	if (a === b) return true;
	return a.replace(SGR_SEQUENCE, "") === b.replace(SGR_SEQUENCE, "");
}

function isBlankRow(row: string): boolean {
	if (row.length === 0) return true;
	return row.replace(SGR_SEQUENCE, "").trim().length === 0;
}

// Tail-alignment sampling bounds: look back through up to LOOKBACK rows of
// the committed prefix to collect SAMPLES non-blank comparisons.
const RESYNC_TAIL_LOOKBACK = 24;
const RESYNC_TAIL_SAMPLES = 8;

/**
 * Decide whether `frame` still aligns with the committed prefix, and where to
 * re-anchor the commit index when it does not. Returns the resync row index,
 * or -1 when no resync is needed.
 *
 * Zones (verifiedTo ≤ finalTo ≤ prefix.length):
 *   [0, verifiedTo)         VERIFIED exact rows — sampled with tolerance.
 *   [verifiedTo, finalTo)   NEWLY-FINAL rows — frozen visual snapshots whose
 *       source just became declared-final (the block finalized / a barrier
 *       cleared). Hard-scanned in FULL with no tolerance: any content change
 *       (a pending header settling, a preview replaced by its result, a tail
 *       shifting up after a barrier removal) re-anchors so the engine can
 *       erase-and-replay history with the final content exactly once (or, on
 *       ED3-unsafe multiplexers, recommit it below the frozen snapshot —
 *       duplication, never loss) instead of committing it nowhere and
 *       painting it nowhere.
 *   [finalTo, prefix.length) FROZEN visual snapshots of still-live rows —
 *       exempt: their drift is expected (a collapsing preview, a ticking
 *       progress tree) and must never spray re-anchors mid-run.
 *
 * The verified zone's sampled check exploits the asymmetry between the two
 * mutation classes: an in-place edit/restyle disturbs only the touched rows
 * (alignment below stays intact; the stale copy in history is the accepted
 * artifact), while an insertion/deletion shifts EVERY row below it. Up to 8
 * non-blank rows within the last 24 verified rows are compared SGR-stripped
 * (theme changes stay quiet), tolerating a SINGLE mismatch. The tolerance is
 * load-bearing for roots that report NO seam: an animated row already in
 * history would otherwise re-anchor on every glyph tick.
 *
 * Highly repetitive tails (identical filler rows) can mask a shift in the tail
 * sample, in which case the skipped rows are content-identical to the committed
 * ones — observationally harmless. Exported for the render-stress harness, whose
 * shadow commit ledger must mirror the engine's law exactly.
 */
export function findCommittedPrefixResync(
	frame: readonly string[],
	prefix: readonly string[],
	verifiedTo: number = prefix.length,
	finalTo: number = verifiedTo,
): number {
	const verified = Math.min(prefix.length, Math.max(0, Math.trunc(verifiedTo)));
	const hardEnd = Math.min(prefix.length, Math.max(verified, Math.trunc(finalTo)));
	if (hardEnd === 0) return -1;
	if (frame.length >= hardEnd) {
		// 1. Hard scan: frozen snapshots whose source just became final. Full
		// scan, no tolerance — a finalized row that changed must re-anchor.
		let hardMismatch = false;
		for (let i = verified; i < hardEnd; i++) {
			if (!rowsEquivalent(frame[i]!, prefix[i]!)) {
				hardMismatch = true;
				break;
			}
		}
		if (!hardMismatch) {
			// 2. Tail sample over the verified zone (only when the hard scan is
			// clean): walk up from its end until LOOKBACK rows or SAMPLES
			// non-blank comparisons.
			let samples = 0;
			let mismatches = 0;
			for (let j = 1; j <= verified && j <= RESYNC_TAIL_LOOKBACK && samples < RESYNC_TAIL_SAMPLES; j++) {
				const idx = verified - j;
				const row = frame[idx]!;
				const old = prefix[idx]!;
				if (row === old) {
					if (!isBlankRow(row)) samples++;
					continue;
				}
				if (isBlankRow(row) && isBlankRow(old)) continue;
				samples++;
				if (!rowsEquivalent(row, old)) mismatches++;
			}
			// No signal (all-blank tail) or at most one edited row: aligned.
			if (samples === 0 || mismatches <= 1) return -1;
		}
	}
	// Misaligned (hard mismatch, tail-sample shift, or the frame no longer
	// covers the checked zones): re-anchor at the first row whose content
	// changed.
	const limit = Math.min(hardEnd, frame.length);
	for (let i = 0; i < limit; i++) {
		if (!rowsEquivalent(frame[i]!, prefix[i]!)) return i;
	}
	return limit < hardEnd ? limit : -1;
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	terminal: Terminal;
	#previousFrameLength = 0;
	#previousWidth = 0;
	#previousHeight = 0;
	#focusedComponent: Component | null = null;
	#inputListeners = new Set<InputListener>();
	#startListeners = new Set<StartListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	onDebug?: () => void;
	#renderRequested = false;
	#renderTimer: RenderTimer | undefined;
	#renderScheduler: RenderScheduler;
	#lastRenderAt = 0;
	/**
	 * Wall-clock cost of the most recent `#doRender()` call. Used by
	 * `#scheduleRender` to inflate the next render delay proportionally so a
	 * spike of slow frames (large transcript diffs, huge assistant text wrap,
	 * component-tree walks) does not busy-loop the CPU: the throttle would
	 * otherwise collapse to zero once `elapsed >= MIN_RENDER_INTERVAL_MS` and
	 * fire the next frame immediately (see #4145).
	 */
	#lastFrameCostMs = 0;
	static readonly #MIN_RENDER_INTERVAL_MS = 1000 / 30;
	static readonly #INPUT_RENDER_GRACE_MS = TUI.#MIN_RENDER_INTERVAL_MS;
	/**
	 * Cap on the adaptive floor derived from `#lastFrameCostMs`. Bounds the UI
	 * responsiveness at ~5 fps under sustained heavy renders — anything slower
	 * feels dead to the user and no longer justifies further CPU savings.
	 */
	static readonly #MAX_ADAPTIVE_RENDER_MS = 200;
	#inputRenderGraceUntilMs = 0;
	// Pane-reflow settle window for tmux/screen/zellij. The host process gets
	// SIGWINCH (and `process.stdout` already reports the new geometry) before
	// the multiplexer finishes repainting the pane at the new size, and
	// drag-resize/pane-close animations fire several events in flight. A forced
	// render on each SIGWINCH races those mid-reflow paints — the multiplexer's
	// catch-up paint then partially overwrites the TUI output, which the user
	// sees as a viewport flash or blank screen before the next throttled frame
	// arrives (issue #2088). Coalescing every SIGWINCH inside this window into
	// a single forced render lets the multiplexer settle first.
	static readonly #MULTIPLEXER_RESIZE_DEBOUNCE_MS = 50;
	// Resize viewport fast path (non-multiplexer). A drag emits a SIGWINCH burst,
	// and outside a multiplexer the host gets each new geometry atomically. The
	// authoritative resize paint erases and replays the entire transcript so it
	// rewraps at the new width — O(history) compose (markdown re-lexes every
	// block, the per-width cache missing on every distinct drag width) plus an
	// O(history) write that pushes all of it back through native scrollback. At
	// drag rates that whole-history pass is recomputed dozens of times a second
	// and discarded the instant the next event lands. While the drag is in
	// flight the engine instead composes and paints ONLY the viewport (see
	// `#renderResizeViewport`): a state-isolated, throwaway frame that never
	// touches the commit ledger. The authoritative full replay fires once, after
	// the drag has been quiet for this long. Multiplexer sessions keep their own
	// debounce (`#armMultiplexerResizeTimer`, see #2088) and never take this path.
	static readonly #RESIZE_VIEWPORT_SETTLE_MS = 120;
	// Ghostty can drop Kitty graphics commands sent during its first post-startup
	// settle window, leaving only Unicode placeholder cells. Hold the first image
	// paint until that window has passed; later images render normally.
	static readonly #GHOSTTY_INITIAL_IMAGE_DELAY_MS = 100;
	// Post-paint settle window for ConPTY hosts. The `sessionReplace` /
	// `historyRebuild` / `overlayRebuild` intents drive `#emitFullPaint` over
	// a transcript that overflows the viewport, scroll-pushing everything past
	// the last `height` rows into native scrollback. Windows Terminal's
	// viewport-follow logic gets lossy during that burst: spinner/blink-driven
	// `requestRender(false)` calls firing inside the window each produce another
	// diff write, and the WT host processes them faster than its viewport
	// tracker can keep up — the visible tail ends up parked a few rows above
	// the actual last row until any focus event (Alt+Tab) forces a host repaint.
	// Coalescing every non-forced render inside this window into a single
	// trailing render lets the host fully settle the big paint before any
	// follow-up writes touch the buffer. The first-ever `initial` paint is
	// deliberately exempt: nothing has been on screen yet, so no drift can
	// have accumulated, and tests that start the TUI over an over-tall
	// component depend on the next paint firing without delay. Only armed on
	// ConPTY hosts (`isConPTYHosted()`); other terminals do not exhibit the
	// drift and would just see an unnecessary post-paint latency. See #2095.
	static readonly #CONPTY_POST_FULL_PAINT_SETTLE_MS = 150;
	static readonly #CONPTY_FRAME_TRUNCATE_THRESHOLD_BYTES = 512 * 1024;
	static readonly #CONPTY_FRAME_RETAIN_BYTES = 64 * 1024;
	#postFullPaintSettleUntilMs = 0;
	#postFullPaintSettleTimer: RenderTimer | undefined;
	#hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	#hardwareCursorState: HardwareCursorState | null = null;
	#hardwareCursorVisibilityKnown = false;
	#hardwareCursorVisible = false;
	#sixelProbePendingDa = false;
	#sixelProbePendingGraphics = false;
	#sixelProbeBuffer = "";
	#sixelProbeTimeout?: NodeJS.Timeout;
	#sixelProbeUnsubscribe?: () => void;
	#showHardwareCursor = $flag("PI_HARDWARE_CURSOR");
	#synchronizedOutputEnabled = shouldEnableSynchronizedOutputByDefault();
	#paintBeginSequence = this.#synchronizedOutputEnabled ? PAINT_BEGIN : PAINT_BEGIN_NO_SYNC;
	#paintEndSequence = this.#synchronizedOutputEnabled ? PAINT_END : PAINT_END_NO_SYNC;
	#cursorBeginSequence = this.#synchronizedOutputEnabled ? CURSOR_BEGIN : CURSOR_BEGIN_NO_SYNC;
	#cursorEndSequence = this.#synchronizedOutputEnabled ? CURSOR_END : CURSOR_END_NO_SYNC;
	// Rows of the current frame physically committed to the terminal tape
	// (native scrollback or scrolled past the window top). Immutable by
	// contract: the engine never rewrites them. Rows below
	// #committedPrefixAuditRows entered as exact-final bytes (the component
	// seam declared them); rows at/after it are frozen visual snapshots that
	// scrolled off the window top while still live.
	#committedRows = 0;
	// Raw rows mirroring [0, #committedRows) — the engine's claim of what it
	// committed. The audited prefix [0, #committedPrefixAuditRows) is checked
	// each ordinary frame against the current render to detect components
	// re-laying-out declared-final content (see #auditCommittedPrefix). Holds
	// references to component-cached strings, so the audit is a pointer walk
	// in the common case.
	#committedPrefix: string[] = [];
	// Rows of the committed prefix that were HARD-VERIFIED as exact-final
	// bytes (committed below the exactness boundary, or frozen snapshots that
	// passed the one-time strict scan when the boundary rose past them). Rows
	// in [#committedPrefixAuditRows, #committedRows) are frozen visual
	// snapshots of still-live content — the terminal's record of what was on
	// screen when it scrolled off — and are audit-exempt while their source
	// remains live, so a collapsing preview never sprays re-anchors mid-run.
	// When the exactness boundary rises past them (the block finalized), they
	// are strict-scanned exactly once: unchanged rows join the verified zone,
	// a divergence re-anchors so the final content recommits below the frozen
	// snapshot (duplication, never loss). Re-based on full paints / shrinks /
	// geometry frames.
	#committedPrefixAuditRows = 0;
	// Frame row currently mapped to screen row 0. Monotonic between full
	// paints: a shrink never re-exposes scrolled-off rows (they cannot be
	// un-scrolled without rewriting history); live rows repaint at fixed
	// positions with blank rows below the shrunken tail.
	#windowTopRow = 0;
	// Exactly what is painted on the screen rows (post-composite, prepared).
	#previousWindow: string[] = [];
	#nativeScrollbackLiveRegionStart: number | undefined;
	#fullRedrawCount = 0;
	// Caps how many inline images render as live graphics; older ones fall back
	// to text via a purge + full redraw. Cap is configured by the host app.
	#imageBudget = new ImageBudget(DEFAULT_MAX_INLINE_IMAGES, () => this.requestRender());
	#ghosttyInitialImageDelayDone = false;
	#ghosttyInitialImageDelayTimer: RenderTimer | undefined;
	#ghosttyImageReadyAtMs = 0;
	#clearScrollbackOnNextRender = false;
	#forceViewportRepaintOnNextRender = false;
	#hasEverRendered = false;
	#scrollbackRebuildEnabled =
		Bun.env.PI_TUI_SCROLLBACK_REBUILD === "1" || Bun.env.PI_TUI_SCROLLBACK_REBUILD === "true";
	// Set by the terminal resize callback; consumed by the next render. A resize
	// event invalidates the committed screen even when the dimensions net out
	// unchanged by render time (e.g. a 6→4→6 round trip coalesced into one frame
	// budget): the terminal reflowed its buffer on each event, moving rows
	// between the viewport and scrollback, so the previous frame no longer
	// describes the screen. Tracking only the dimension delta misses this.
	#resizeEventPending = false;
	// Active multiplexer SIGWINCH debounce. Reset on each event so the timer
	// only fires once the pane stops resizing. Forced renders (resetDisplay,
	// finishSixelProbe, …) issued during the settle window route through the
	// same timer; their `clearScrollback` intent is OR'd into the deferred
	// flag below so the settled paint still honours every caller's request.
	#multiplexerResizeTimer: RenderTimer | undefined;
	#deferredForcedClearScrollback = false;
	// True from the first SIGWINCH of a non-multiplexer drag until the settle
	// timer fires. While set, every `#doRender` short-circuits to the viewport
	// fast path (`#renderResizeViewport`) instead of an authoritative full
	// paint, and no commit/window/diff state is advanced.
	#resizeViewportActive = false;
	// Quiet-window timer that ends the drag: its callback clears the flag and
	// drives the one authoritative full paint. Reset on every resize event so it
	// only fires once the drag stops. Cancelled on stop().
	#resizeViewportSettleTimer: RenderTimer | undefined;
	// Count of transient viewport-only resize paints emitted. Distinct from
	// `#fullRedrawCount`: these never enter native scrollback and exist only for
	// the lifetime of the drag. Exposed for tests/diagnostics.
	#resizeViewportPaintCount = 0;
	// During a live resize drag the terminal's normal buffer may reflow full-width
	// rows before our repaint lands. Borrow the alternate screen for throwaway
	// resize frames so width changes truncate the transient viewport instead of
	// pushing wrapped fragments into native scrollback.
	#resizeAltActive = false;
	#stopped = false;
	// Always-on event-loop lag probe. The high default threshold keeps it quiet;
	// it only logs `ui.loop-blocked` (with the current loop phase) when a frame
	// budget is genuinely starved. Armed in start(), disarmed in stop().
	#watchdog: LoopWatchdog;

	// Transient alternate-screen state for a fullscreen overlay. While active, the
	// engine paints only the modal on the alt buffer and leaves every
	// normal-screen accounting field (#previousFrameLength, #viewportTopRow, …)
	// untouched, so exiting reconciles cleanly against the terminal-restored
	// normal screen. #altPreviousLines is the last alt frame, for repaint-skip.
	#altActive = false;
	#altMouseTrackingActive = false;
	#altPreviousLines: string[] = [];
	#altEnterWidth = 0;
	#altEnterHeight = 0;
	// Holds an alternate-screen exit until its replacement full paint can emit it
	// atomically. It must survive a deferred Ghostty image frame.
	#pendingAltExit = "";

	// Persistent composed frame. The render override splices only rows at/after
	// the stable prefix each frame; cursor markers are stripped at ingestion so
	// the frame never carries them. Returned to render() callers — treated as
	// immutable by them per the Component render contract.
	#composedFrame: string[] = [];
	// Per-root-child segment ledger backing the stable-prefix computation.
	#frameSegments: FrameSegment[] = [];
	#composeWidth = -1;
	// Cursor markers stripped at ingestion, ascending by frame row.
	#frameCursorMarkers: { row: number; col: number }[] = [];
	// Leading rows of #composedFrame byte-identical to the previous compose.
	#renderStablePrefixRows = 0;

	// Component-scoped render accumulation. Targets are the components handed
	// to requestComponentRender() since the last frame; the flag stays true
	// only while EVERY pending request is component-scoped. Both are consumed
	// once per frame by #doRender.
	#componentRenderTargets = new Set<Component>();
	#pendingRenderComponentsOnly = false;
	// Root children that must re-render during the current compose; null for a
	// full compose. Non-null only for the duration of a component-scoped
	// render() call inside #doRender (the scratch set below, reused per frame).
	#partialComposeRoots: Set<Component> | null = null;
	#partialComposeRootsScratch = new Set<Component>();
	// Target component -> containing root child, so animation-rate requests do
	// not re-walk a huge transcript subtree every frame.
	#componentRootCache = new WeakMap<Component, Component>();

	// Persistent prepared frame, row-aligned with #composedFrame. Entries store
	// normalized, width-fitted content rows without the per-line terminal
	// terminator; terminators are appended only at write time so width checks
	// stay on content, not reset bytes. #preparedValidRows counts the leading
	// rows known prepared against the CURRENT composed frame: a compose lowers
	// it to the stable prefix, a completed prepare raises it to the frame
	// length, and an abandoned frame (ghostty image defer) leaves it lowered so
	// the next prepare revalidates the splice.
	#preparedFrame: string[] = [];
	#preparedMeta: PreparedLine[] = [];
	#preparedValidRows = 0;

	// Overlay stack for modal components rendered on top of base content
	overlayStack: {
		component: Component;
		options?: OverlayOptions;
		preFocus: Component | null;
		hidden: boolean;
	}[] = [];

	constructor(terminal: Terminal, showHardwareCursor?: boolean, options?: TUIOptions) {
		super();
		this.terminal = terminal;
		this.#renderScheduler = options?.renderScheduler ?? DEFAULT_RENDER_SCHEDULER;
		this.#showHardwareCursor = showHardwareCursor === undefined ? this.#showHardwareCursor : showHardwareCursor;
		this.#watchdog = new LoopWatchdog();
	}

	override render(width: number): readonly string[] {
		width = Math.max(1, width);
		this.#nativeScrollbackLiveRegionStart = undefined;
		const children = this.children;
		const previousSegments = this.#frameSegments;
		const segments: FrameSegment[] = new Array(children.length);
		// A width change re-renders every child; nothing carries over.
		let chainStable = this.#composeWidth === width;
		this.#composeWidth = width;
		let offset = 0;
		let stableRows = 0;
		const partialRoots = this.#partialComposeRoots;
		for (let index = 0; index < children.length; index++) {
			const child = children[index]!;
			const previous = previousSegments[index];
			// Component-scoped frame: a root child outside every requested
			// subtree provably did not change (content mutations route through
			// a render request, which would have made this frame a full one) —
			// reuse its previous rows and seam report without calling render().
			const reuse =
				partialRoots !== null && previous !== undefined && previous.component === child && !partialRoots.has(child);
			let childLines: readonly string[];
			let liveLocalStart: number | undefined;
			let reported: number | undefined;
			if (reuse) {
				childLines = previous.lines;
				liveLocalStart = previous.liveLocalStart;
			} else {
				// Feed the engine's committed-row claim (from the previous frame's
				// emit) before rendering so the child can skip re-deriving blocks
				// that already live in immutable native scrollback. Reused segments
				// skip this: they never call render(), so the signal is moot. The
				// claim is in the previous frame's coordinates and never exceeds
				// the rows the child actually contributed there — history that
				// advanced into LATER root children must not read as this child's
				// own future rows being pre-committed.
				const prevRows = previous !== undefined && previous.component === child ? previous.rowCount : 0;
				const prevStart = previous !== undefined && previous.component === child ? previous.start : offset;
				setNativeScrollbackCommittedRows(child, Math.min(prevRows, Math.max(0, this.#committedRows - prevStart)));
				childLines = child.render(width);
				const liveRegionStart = getNativeScrollbackLiveRegionStart(child);
				if (liveRegionStart !== undefined) {
					liveLocalStart = Number.isFinite(liveRegionStart)
						? Math.max(0, Math.min(childLines.length, Math.trunc(liveRegionStart)))
						: childLines.length;
				}
				// Consume the stability report unconditionally for implementers:
				// reading re-bases the component's baseline to the state this
				// compose is about to ingest (used or not, the current rows are
				// what ends up in the composed frame). Reused segments are
				// deliberately NOT read — their baseline must stay anchored to
				// the last render the engine actually observed.
				reported = getRenderStablePrefixRows(child);
			}
			// Topmost seam wins. Commits are prefix-only: the first child that
			// reports a live region already bounds everything below it, so a
			// lower sibling's seam (e.g. a status loader under a streaming
			// transcript) must never overwrite it — moving the boundary down
			// would commit the earlier child's still-mutable rows as stale
			// history.
			if (liveLocalStart !== undefined && this.#nativeScrollbackLiveRegionStart === undefined) {
				this.#nativeScrollbackLiveRegionStart = offset + liveLocalStart;
			}
			if (chainStable) {
				if (previous !== undefined && previous.component === child && previous.start === offset) {
					let stableCount = 0;
					if (reported !== undefined) {
						// In-place mutator: its report overrides reference equality.
						// Rows beyond the previous row count cannot be "unchanged".
						stableCount = Number.isFinite(reported)
							? Math.max(0, Math.min(childLines.length, previous.rowCount, Math.trunc(reported)))
							: 0;
					} else if (previous.lines === childLines) {
						stableCount = childLines.length;
					}
					stableRows += stableCount;
					// The chain survives only a fully stable segment: identical rows
					// AND identical row count (a grown/shrunk segment shifts every
					// row below it).
					if (stableCount < childLines.length || previous.rowCount !== childLines.length) chainStable = false;
				} else {
					chainStable = false;
				}
			}
			segments[index] = {
				component: child,
				lines: childLines,
				start: offset,
				rowCount: childLines.length,
				liveLocalStart,
			};
			offset += childLines.length;
		}
		this.#frameSegments = segments;

		const frame = this.#composedFrame;
		// Defensive clamp: stable rows can never exceed what the previous
		// compose actually materialized (only reachable if a child render threw
		// mid-compose on the previous frame).
		if (stableRows > frame.length) stableRows = frame.length;
		if (stableRows !== offset || frame.length !== offset) {
			// Re-ingest every row at/after the stable prefix: truncate, strip
			// cursor markers, record their positions.
			frame.length = stableRows;
			this.#pruneFrameCursorMarkers(stableRows);
			for (const segment of segments) {
				const lines = segment.lines;
				const from = segment.start >= stableRows ? 0 : stableRows - segment.start;
				for (let i = from; i < lines.length; i++) this.#ingestFrameRow(lines[i]!);
			}
		}
		this.#renderStablePrefixRows = stableRows;
		this.#preparedValidRows = Math.min(this.#preparedValidRows, stableRows);
		return frame;
	}

	/** Drop cached cursor markers at/after `fromRow` (those rows re-ingest). */
	#pruneFrameCursorMarkers(fromRow: number): void {
		const markers = this.#frameCursorMarkers;
		let keep = markers.length;
		while (keep > 0 && markers[keep - 1]!.row >= fromRow) keep--;
		markers.length = keep;
	}

	/**
	 * Append one row to the composed frame, stripping CURSOR_MARKER occurrences
	 * (internal sentinels that must never reach the terminal, the committed
	 * prefix, or the resync audit) and recording the first marker's position.
	 */
	#ingestFrameRow(line: string): void {
		let markerIndex = line.indexOf(CURSOR_MARKER);
		if (markerIndex === -1) {
			this.#composedFrame.push(line);
			return;
		}
		this.#frameCursorMarkers.push({
			row: this.#composedFrame.length,
			col: visibleWidth(line.slice(0, markerIndex)),
		});
		let stripped = line;
		while (markerIndex !== -1) {
			stripped = stripped.slice(0, markerIndex) + stripped.slice(markerIndex + CURSOR_MARKER.length);
			markerIndex = stripped.indexOf(CURSOR_MARKER, markerIndex);
		}
		this.#composedFrame.push(stripped);
	}

	#syncTerminalCursorMode(component: Component | null): void {
		if (isFocusable(component)) {
			component.setUseTerminalCursor?.(this.#showHardwareCursor);
		}
	}

	get fullRedraws(): number {
		return this.#fullRedrawCount;
	}

	/**
	 * Transient viewport-only paints emitted by the non-multiplexer resize fast
	 * path. These never touch native scrollback or the commit ledger, so they
	 * are counted apart from {@link fullRedraws}.
	 */
	get resizeViewportPaints(): number {
		return this.#resizeViewportPaintCount;
	}

	/** Whether a non-multiplexer resize drag is currently in flight. */
	get resizeViewportActive(): boolean {
		return this.#resizeViewportActive;
	}

	/** Shared budget that caps how many inline images render as live graphics. */
	get imageBudget(): ImageBudget {
		return this.#imageBudget;
	}

	/**
	 * Set how many inline images stay live graphics before older ones fall back
	 * to text (`0` disables the cap). Older images are hidden via a graphics purge
	 * plus a full redraw on the frame after a new image exceeds the cap.
	 */
	setMaxInlineImages(cap: number): void {
		this.#imageBudget.setCap(cap);
	}

	/**
	 * Get whether scrollback divergence rebuild is enabled.
	 */
	getScrollbackRebuild(): boolean {
		return this.#scrollbackRebuildEnabled;
	}

	/**
	 * Enable or disable scrollback divergence rebuild (default off).
	 * When enabled, the engine will erase and replay the terminal's
	 * scrollback (using ED3 / alt buffer / scrollback replay) to avoid
	 * duplicate blocks when a block's final form replaces its live preview.
	 */
	setScrollbackRebuild(enabled: boolean): void {
		this.#scrollbackRebuildEnabled = enabled;
	}

	getShowHardwareCursor(): boolean {
		return this.#showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.#showHardwareCursor === enabled) return;
		this.#showHardwareCursor = enabled;
		this.#syncTerminalCursorMode(this.#focusedComponent);
		if (!enabled) {
			this.terminal.hideCursor();
			this.#recordHardwareCursorHidden();
		}
		this.requestRender();
	}

	/**
	 * Whether DEC 2026 synchronized-output wrappers are currently emitted around
	 * paints. Starts from conservative terminal/env detection and is reconciled at
	 * runtime against the terminal's DECRQM mode-2026 report — enabled on a
	 * positive report, disabled on a negative one.
	 */
	get synchronizedOutput(): boolean {
		return this.#synchronizedOutputEnabled;
	}
	#deccaraFillsEnabled(): boolean {
		// DECCARA fill rectangles arrive after shortened row text; synchronized
		// output hides that intermediate default-background state from users.
		return TERMINAL.deccara && this.#synchronizedOutputEnabled;
	}

	setFocus(component: Component | null): void {
		const topVisibleOverlay = this.#getTopmostVisibleOverlay();
		if (topVisibleOverlay && !isOverlayFocusTarget(topVisibleOverlay.component, component)) {
			const currentFocus = this.#focusedComponent;
			component = isOverlayFocusTarget(topVisibleOverlay.component, currentFocus)
				? currentFocus
				: topVisibleOverlay.component;
		}

		const previousFocusedComponent = this.#focusedComponent;
		// Clear focused flag on old component
		if (isFocusable(previousFocusedComponent)) {
			previousFocusedComponent.focused = false;
		}

		this.#focusedComponent = component;

		// Set focused flag on new component and keep its software/hardware cursor
		// rendering mode aligned with TUI's single cursor-visibility preference.
		if (isFocusable(component)) {
			component.focused = true;
			this.#syncTerminalCursorMode(component);
		}
	}

	/** Component currently receiving keyboard input, if any. */
	getFocused(): Component | null {
		return this.#focusedComponent;
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		component.setIgnoreTight?.(true);
		const entry = { component, options, preFocus: this.#focusedComponent, hidden: false };
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (this.#isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.#recordHardwareCursorHidden();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay or one of its owned targets had focus
					if (isOverlayFocusTarget(component, this.#focusedComponent)) {
						const topVisible = this.#getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) {
						this.terminal.hideCursor();
						this.#recordHardwareCursorHidden();
					}
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					// If this overlay or one of its owned targets had focus, move focus to next visible or preFocus
					if (isOverlayFocusTarget(component, this.#focusedComponent)) {
						const topVisible = this.#getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (this.#isOverlayVisible(entry)) {
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack.pop();
		if (!overlay) return;
		// Find topmost visible overlay, or fall back to preFocus
		const topVisible = this.#getTopmostVisibleOverlay();
		this.setFocus(topVisible?.component ?? overlay.preFocus);
		if (this.overlayStack.length === 0) {
			this.terminal.hideCursor();
			this.#recordHardwareCursorHidden();
		}
		this.requestRender();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some(o => this.#isOverlayVisible(o));
	}

	/** Check if an overlay entry is currently visible */
	#isOverlayVisible(entry: (typeof this.overlayStack)[number]): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the topmost visible overlay, if any */
	#getTopmostVisibleOverlay(): (typeof this.overlayStack)[number] | undefined {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			if (this.#isOverlayVisible(this.overlayStack[i])) {
				return this.overlayStack[i];
			}
		}
		return undefined;
	}

	override invalidate(): void {
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start(options?: TUIStartOptions): void {
		this.#stopped = false;
		this.#watchdog.start();
		this.#ghosttyInitialImageDelayDone = false;
		this.#ghosttyImageReadyAtMs = this.#renderScheduler.now() + TUI.#GHOSTTY_INITIAL_IMAGE_DELAY_MS;
		// A confirmed DECRPM report for mode 2026 is authoritative: enable
		// synchronized output when the terminal reports support and disable it for
		// an explicit unsupported status. A DA1 sentinel without a DECRPM reply is
		// inconclusive: many terminals implement synchronized output without
		// implementing DECRQM, so retain the statically detected default instead of
		// exposing destructive full paints. An explicit user opt-out/force still
		// wins, so skip every probe result in that case.
		this.terminal.onPrivateModeReport?.((mode, supported, confirmed = true) => {
			if (mode !== 2026 || !confirmed) return;
			if (synchronizedOutputUserOverride() !== null) return;
			this.#setSynchronizedOutput(supported);
		});
		this.terminal.start(
			data => this.#handleInput(data),
			() => {
				// Real terminals deliver SIGWINCH (and the equivalent ConPTY
				// notification) atomically with the new `process.stdout` geometry, so
				// a forced render must fire immediately: it clears and replays at the
				// fresh size before the terminal's reflow settles into a state a
				// throttled frame would race. Multiplexer panes (tmux/screen/zellij)
				// do not give that guarantee. The host receives SIGWINCH while the
				// multiplexer is still mid-reflow — it has not finished repainting
				// the pane buffer at the new size — and a drag-resize or pane-close
				// animation fires several events in flight. Forcing a render on each
				// event races those mid-reflow paints: the multiplexer's catch-up
				// paint then partially overwrites the TUI output, which the user sees
				// as a viewport flash or blank screen before the next throttled
				// frame arrives (issue #2088). `#armMultiplexerResizeTimer` coalesces
				// SIGWINCHes (and any forced repaints arriving during the settle
				// window) into a single render once the pane is quiet —
				// `#resizeEventPending` is set first so the eventual render still
				// classifies as a resize.
				this.#resizeEventPending = true;
				if (!resizeRepaintsInPlace()) {
					// Enter the viewport fast path and (re)arm the settle timer, then
					// request the cheap viewport-only paint. The authoritative full
					// replay fires from the settle timer once the drag goes quiet.
					this.#beginResizeViewport();
					this.#requestResizeViewportPaint();
					return;
				}
				this.#armMultiplexerResizeTimer(false);
			},
			() => this.stop(),
		);
		if (this.#stopped) return;
		for (const listener of this.#startListeners) {
			try {
				listener();
			} catch {
				// Startup listeners are feature hooks; one broken hook must not prevent rendering.
			}
		}
		this.terminal.hideCursor();
		this.#recordHardwareCursorHidden();
		this.#querySixelSupport();
		this.#queryCellSize();
		this.requestRender(true, { clearScrollback: options?.clearScrollback === true });
	}

	addStartListener(listener: StartListener): () => void {
		this.#startListeners.add(listener);
		return () => {
			this.#startListeners.delete(listener);
		};
	}

	addInputListener(listener: InputListener): () => void {
		this.#inputListeners.add(listener);
		return () => {
			this.#inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: InputListener): void {
		this.#inputListeners.delete(listener);
	}

	#querySixelSupport(): void {
		if (TERMINAL.imageProtocol) return;
		if (process.platform !== "win32") return;
		if (!Bun.env.WT_SESSION) return;
		if (!process.stdin.isTTY || !process.stdout.isTTY) return;

		this.#clearSixelProbeState();
		this.#sixelProbePendingDa = true;
		this.#sixelProbePendingGraphics = true;
		this.#sixelProbeUnsubscribe = this.addInputListener(data => this.#handleSixelProbeInput(data));
		this.terminal.write("\x1b[c");
		this.terminal.write("\x1b[?2;1;0S");
		this.#sixelProbeTimeout = setTimeout(() => {
			this.#finishSixelProbe(false);
		}, 250);
	}

	#handleSixelProbeInput(data: string): InputListenerResult {
		if (!this.#sixelProbePendingDa && !this.#sixelProbePendingGraphics) {
			return undefined;
		}

		this.#sixelProbeBuffer += data;
		let passthrough = "";
		let probeOutcome: boolean | null = null;

		while (this.#sixelProbeBuffer.length > 0) {
			const daMatch = this.#sixelProbeBuffer.match(/\x1b\[\?([0-9;]+)c/u);
			const graphicsMatch = this.#sixelProbeBuffer.match(/\x1b\[\?2;(\d+);([0-9;]+)S/u);

			if (!daMatch && !graphicsMatch) break;

			const daIndex = daMatch?.index ?? Number.POSITIVE_INFINITY;
			const graphicsIndex = graphicsMatch?.index ?? Number.POSITIVE_INFINITY;
			const useDa = daIndex <= graphicsIndex;
			const match = useDa ? daMatch : graphicsMatch;
			if (!match || match.index === undefined) break;

			passthrough += this.#sixelProbeBuffer.slice(0, match.index);
			this.#sixelProbeBuffer = this.#sixelProbeBuffer.slice(match.index + match[0].length);

			if (useDa && this.#sixelProbePendingDa) {
				this.#sixelProbePendingDa = false;
				const attributes = (match[1] ?? "")
					.split(";")
					.map(value => Number.parseInt(value, 10))
					.filter(value => Number.isFinite(value));
				const hasSixelAttribute = attributes.includes(4);
				if (hasSixelAttribute) {
					this.#sixelProbePendingGraphics = false;
					probeOutcome = true;
				} else if (!this.#sixelProbePendingGraphics) {
					probeOutcome = false;
				}
			} else if (!useDa && this.#sixelProbePendingGraphics) {
				this.#sixelProbePendingGraphics = false;
				const status = Number.parseInt(match[1] ?? "", 10);
				const supportsSixel = !Number.isNaN(status) && status !== 0;
				if (supportsSixel) {
					this.#sixelProbePendingDa = false;
					probeOutcome = true;
				} else if (!this.#sixelProbePendingDa) {
					probeOutcome = false;
				}
			}
		}

		if (this.#sixelProbePendingDa || this.#sixelProbePendingGraphics) {
			const partialStart = this.#getSixelProbePartialStart(this.#sixelProbeBuffer);
			if (partialStart >= 0) {
				passthrough += this.#sixelProbeBuffer.slice(0, partialStart);
				this.#sixelProbeBuffer = this.#sixelProbeBuffer.slice(partialStart);
			} else {
				passthrough += this.#sixelProbeBuffer;
				this.#sixelProbeBuffer = "";
			}
		} else {
			passthrough += this.#sixelProbeBuffer;
			this.#sixelProbeBuffer = "";
		}

		if (probeOutcome !== null) {
			this.#finishSixelProbe(probeOutcome);
		}

		if (passthrough.length === 0) {
			return { consume: true };
		}

		return { data: passthrough };
	}

	#getSixelProbePartialStart(buffer: string): number {
		const lastEsc = buffer.lastIndexOf("\x1b");
		if (lastEsc < 0) return -1;
		const tail = buffer.slice(lastEsc);
		if (/^\x1b\[\?[0-9;]*$/u.test(tail)) {
			return lastEsc;
		}
		return -1;
	}

	#clearSixelProbeState(): void {
		if (this.#sixelProbeTimeout) {
			clearTimeout(this.#sixelProbeTimeout);
			this.#sixelProbeTimeout = undefined;
		}
		if (this.#sixelProbeUnsubscribe) {
			this.#sixelProbeUnsubscribe();
			this.#sixelProbeUnsubscribe = undefined;
		}
		this.#sixelProbePendingDa = false;
		this.#sixelProbePendingGraphics = false;
		this.#sixelProbeBuffer = "";
	}

	#finishSixelProbe(supported: boolean): void {
		this.#clearSixelProbeState();
		if (!supported || TERMINAL.imageProtocol) return;

		setTerminalImageProtocol(ImageProtocol.Sixel);
		this.#queryCellSize();
		this.invalidate();
		this.requestRender(true);
	}
	#queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!TERMINAL.imageProtocol) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	/**
	 * Toggle synchronized-output (DEC 2026) wrappers on paint/cursor writes and
	 * recompute the cached begin/end sequences. Driven by the terminal's DECRQM
	 * mode-2026 report (#1765 covers the static env opt-out).
	 */
	#setSynchronizedOutput(enabled: boolean): void {
		if (this.#synchronizedOutputEnabled === enabled) return;
		this.#synchronizedOutputEnabled = enabled;
		this.#paintBeginSequence = enabled ? PAINT_BEGIN : PAINT_BEGIN_NO_SYNC;
		this.#paintEndSequence = enabled ? PAINT_END : PAINT_END_NO_SYNC;
		this.#cursorBeginSequence = enabled ? CURSOR_BEGIN : CURSOR_BEGIN_NO_SYNC;
		this.#cursorEndSequence = enabled ? CURSOR_END : CURSOR_END_NO_SYNC;
	}

	stop(): void {
		// Leave the resize alt buffer first so the teardown cursor math below runs
		// against the restored normal screen (which #previousLines still describes).
		if (this.#resizeAltActive) {
			this.terminal.write(this.#leaveResizeAltSequence());
		}
		if (this.#altActive || this.#pendingAltExit) {
			const mouseExit = this.#altMouseTrackingActive ? MOUSE_TRACKING_OFF : "";
			const exitSequence = this.#pendingAltExit || `${mouseExit}${this.#keyboardEnhancementExit()}\x1b[?1049l`;
			this.terminal.write(exitSequence);
			setAltScreenActive(false);
			this.#altActive = false;
			this.#altMouseTrackingActive = false;
			this.#altPreviousLines = [];
			this.#pendingAltExit = "";
		}
		if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
			for (const id of this.#imageBudget.takeAllTransmittedIds()) {
				this.terminal.write(encodeKittyDeleteImage(id));
			}
		}
		this.#clearSixelProbeState();
		this.#stopped = true;
		this.#watchdog.stop();
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
		if (this.#ghosttyInitialImageDelayTimer) {
			this.#ghosttyInitialImageDelayTimer.cancel();
			this.#ghosttyInitialImageDelayTimer = undefined;
		}
		if (this.#multiplexerResizeTimer) {
			this.#multiplexerResizeTimer.cancel();
			this.#multiplexerResizeTimer = undefined;
		}
		if (this.#resizeViewportSettleTimer) {
			this.#resizeViewportSettleTimer.cancel();
			this.#resizeViewportSettleTimer = undefined;
		}
		this.#resizeViewportActive = false;
		this.#clearPostFullPaintSettle();
		this.#deferredForcedClearScrollback = false;
		// Place the parent shell on the first line after the rendered content. When
		// that line is still inside the viewport, moving there and writing `\r` is
		// enough; emitting `\r\n` would create an extra blank row. If the content
		// already reaches the viewport bottom, scroll exactly once so the prompt
		// lands directly below the last visible TUI row.
		if (this.#previousFrameLength > 0) {
			const targetRow = this.#previousFrameLength;
			const viewportBottom = this.#windowTopRow + this.terminal.rows - 1;
			const clampedCursorRow = Math.max(this.#windowTopRow, Math.min(this.#hardwareCursorRow, viewportBottom));
			const moveTargetRow = Math.min(targetRow, viewportBottom);
			const lineDiff = moveTargetRow - clampedCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write(targetRow <= viewportBottom ? "\r" : "\r\n");
		}

		this.terminal.showCursor();
		this.#forgetHardwareCursorState();
		this.terminal.stop();
	}

	/**
	 * Force an immediate full replay of the current frame, including native
	 * scrollback. This is the keyboard-accessible equivalent of the resize reset:
	 * no queued diff frame or terminal scrollback probe can downgrade it to a
	 * viewport-only repaint.
	 *
	 * Invalidates every component first so the replay reflects current state. A
	 * geometry-driven reset thaws frozen scrollback snapshots implicitly (the new
	 * width misses every cached snapshot), but a same-width reset would otherwise
	 * replay stale snapshots — leaving host-frozen blocks (e.g. a transcript whose
	 * committed rows are immutable on ED3-risk terminals) showing pre-mutation
	 * content. Invalidation is the generic signal those containers use to retire
	 * their snapshots, which is exactly what a user-driven display reset wants.
	 */
	resetDisplay(): void {
		if (this.#stopped) return;
		this.invalidate();
		// A reset that lands inside a tmux/screen/zellij resize burst would
		// paint mid-reflow and re-introduce the flash race (issue #2088).
		// Fold it into the in-flight debounce instead; the settled paint runs
		// the same `#prepareForcedRender(!isMultiplexerSession())` path via
		// `requestRender(true)`, so the clear-scrollback intent is preserved.
		if (this.#multiplexerResizeTimer) {
			this.#armMultiplexerResizeTimer(!isMultiplexerSession());
			return;
		}
		this.#prepareForcedRender(!isMultiplexerSession());
		this.#resizeEventPending = true;
		this.#renderRequested = false;
		this.#executeRender();
	}

	requestRender(force = false, options?: RenderRequestOptions): void {
		// Any non-component-scoped request makes the pending frame a full one.
		this.#pendingRenderComponentsOnly = false;
		if (force) {
			// Forced repaints landing inside the multiplexer resize debounce
			// (e.g. `#finishSixelProbe`, image-budget eviction, a programmatic
			// `requestRender(true)`) would paint into a still-reflowing pane
			// and reintroduce the flash race. Fold them into the in-flight
			// debounce while preserving the caller's `clearScrollback` intent
			// for the settled paint. The timer's own callback clears
			// `#multiplexerResizeTimer` before re-entering `requestRender(true)`,
			// so this guard only catches external callers — the deferred render
			// itself proceeds straight to `#prepareForcedRender`.
			if (this.#multiplexerResizeTimer) {
				this.#armMultiplexerResizeTimer(options?.clearScrollback === true);
				return;
			}
			// A forced render preempts the post-full-paint ConPTY settle: it owns
			// the next paint and is going to redraw the buffer anyway, so the
			// trailing coalesced render queued by the settle would only race it.
			this.#clearPostFullPaintSettle();
			this.#prepareForcedRender(options?.clearScrollback === true);
			this.#renderRequested = true;
			this.#renderScheduler.scheduleImmediate(() => {
				if (this.#stopped || !this.#renderRequested) {
					return;
				}
				this.#renderRequested = false;
				this.#executeRender();
			});
			return;
		}
		this.#requestOrdinaryRender();
	}

	/**
	 * Schedule a render on behalf of `component` after a self-contained change
	 * (spinner frame, blink) that cannot have affected any other component.
	 *
	 * When every request since the last frame is component-scoped and the
	 * frame is otherwise quiet — no resize or geometry change, no overlays, no
	 * live inline images, no forced repaint, unchanged root child list — the
	 * next compose re-renders only the root subtrees containing the requesting
	 * components and reuses the previous frame's rows (and seam reports) for
	 * every other root child, skipping the full component-tree walk that makes
	 * long transcripts expensive to repaint at animation rate. Any concurrent
	 * full request or unsafe condition downgrades the frame to a normal full
	 * compose, so this is never less correct than `requestRender()` — only
	 * cheaper.
	 */
	requestComponentRender(component: Component): void {
		if (this.#stopped) return;
		// Start a component-scoped accumulation only when nothing else is in
		// flight (a pending throttled request or a deferred ConPTY settle
		// replay may carry full-render intent that must not be narrowed).
		if (!this.#renderRequested && this.#postFullPaintSettleTimer === undefined) {
			this.#pendingRenderComponentsOnly = true;
		}
		this.#componentRenderTargets.add(component);
		this.#requestOrdinaryRender();
	}

	/**
	 * Rewrite a quiet, visible component segment directly.
	 *
	 * Loader-style animation changes one already-positioned segment at a fixed
	 * size. When the current frame geometry is still valid, rewrite just those
	 * rows and update the diff baseline instead of scheduling a full render
	 * cycle. Unsafe states fall back to `requestComponentRender()`, preserving
	 * the ordinary renderer as the correctness path.
	 */
	requestDirectWrite(component: Component): void {
		if (this.#stopped) return;
		if (
			this.#renderRequested ||
			this.#postFullPaintSettleTimer !== undefined ||
			this.#postFullPaintSettleUntilMs > 0
		) {
			this.requestComponentRender(component);
			return;
		}

		const width = this.terminal.columns;
		const height = this.terminal.rows;
		if (!this.#hasEverRendered || this.#resizeEventPending) {
			this.requestComponentRender(component);
			return;
		}
		if (width !== this.#previousWidth || height !== this.#previousHeight || width !== this.#composeWidth) {
			this.requestComponentRender(component);
			return;
		}
		if (this.#clearScrollbackOnNextRender || this.#forceViewportRepaintOnNextRender) {
			this.requestComponentRender(component);
			return;
		}
		if (this.overlayStack.length > 0 || this.#altActive || !this.#imageBudget.quiescent) {
			this.requestComponentRender(component);
			return;
		}

		const children = this.children;
		const segments = this.#frameSegments;
		if (segments.length !== children.length) {
			this.requestComponentRender(component);
			return;
		}
		for (let i = 0; i < children.length; i++) {
			if (segments[i]!.component !== children[i]) {
				this.requestComponentRender(component);
				return;
			}
		}

		const root = this.#resolveComponentRoot(component);
		if (root === null) {
			this.requestComponentRender(component);
			return;
		}
		const segmentIndex = segments.findIndex(segment => segment.component === root);
		if (segmentIndex === -1) {
			this.requestComponentRender(component);
			return;
		}
		const segment = segments[segmentIndex]!;
		const fullyLiveUncommittedSegment = segment.liveLocalStart === 0 && segment.start >= this.#committedRows;
		if (
			(segment.liveLocalStart !== undefined && !fullyLiveUncommittedSegment) ||
			segment.start < this.#committedRows
		) {
			this.requestComponentRender(component);
			return;
		}

		const windowTop = Math.max(this.#committedRows, this.#composedFrame.length - height, 0);
		if (windowTop !== this.#windowTopRow) {
			this.requestComponentRender(component);
			return;
		}
		const screenStart = segment.start - windowTop;
		if (screenStart < 0 || screenStart + segment.rowCount > height) {
			this.requestComponentRender(component);
			return;
		}

		const nextLines = root.render(width);
		if (nextLines.length !== segment.rowCount) {
			this.requestComponentRender(component);
			return;
		}
		for (const line of nextLines) {
			if (line.includes(CURSOR_MARKER)) {
				this.requestComponentRender(component);
				return;
			}
		}

		let firstChanged = -1;
		let lastChanged = -1;
		const previousWindow = this.#previousWindow;
		for (let i = 0; i < nextLines.length; i++) {
			const frameRow = segment.start + i;
			const raw = nextLines[i]!;
			const prepared = this.#prepareLine(raw, width);
			this.#composedFrame[frameRow] = raw;
			this.#preparedMeta[frameRow] = prepared;
			this.#preparedFrame[frameRow] = prepared.line;
			if (previousWindow[screenStart + i] === prepared.line) continue;
			previousWindow[screenStart + i] = prepared.line;
			if (firstChanged === -1) firstChanged = i;
			lastChanged = i;
		}
		segments[segmentIndex] = { ...segment, lines: nextLines };
		this.#preparedValidRows = Math.max(this.#preparedValidRows, segment.start + nextLines.length);
		this.#renderStablePrefixRows = Math.min(this.#renderStablePrefixRows, segment.start);

		let cursorPos: { row: number; col: number } | null = null;
		for (let i = this.#frameCursorMarkers.length - 1; i >= 0; i--) {
			const marker = this.#frameCursorMarkers[i]!;
			if (marker.row >= windowTop) {
				cursorPos = marker;
				break;
			}
		}

		if (firstChanged === -1) {
			this.#writeCursorPosition(cursorPos, this.#composedFrame.length);
			this.#previousWidth = width;
			this.#previousHeight = height;
			return;
		}

		const currentScreenRow = Math.max(0, Math.min(height - 1, this.#hardwareCursorRow - windowTop));
		const targetScreenRow = screenStart + firstChanged;
		const rowDelta = targetScreenRow - currentScreenRow;
		let buffer = this.#paintBeginSequence;
		if (rowDelta > 0) buffer += `\x1b[${rowDelta}B`;
		else if (rowDelta < 0) buffer += `\x1b[${-rowDelta}A`;
		buffer += "\r";
		for (let i = firstChanged; i <= lastChanged; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(this.#preparedFrame[segment.start + i] ?? "", width);
		}
		const cursorControl = this.#cursorControlSequence(
			cursorPos,
			this.#composedFrame.length,
			segment.start + lastChanged,
		);
		buffer += cursorControl.seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
		this.#windowTopRow = windowTop;
		this.#commit(this.#composedFrame, previousWindow, width, height, cursorControl);
	}

	/** Ordinary (non-forced) scheduling shared by full and component-scoped requests. */
	#requestOrdinaryRender(): void {
		// Coalesce non-forced renders inside the post-full-paint ConPTY settle
		// window into one trailing render. Spinner/blink/streaming components
		// otherwise fire `requestRender(false)` at 30 Hz while the host is still
		// catching up with the previous big paint, and each follow-up viewport
		// repaint nudges Windows Terminal's viewport tracker further off the
		// last row (see #2095).
		if (this.#postFullPaintSettleUntilMs > 0) {
			const now = this.#renderScheduler.now();
			if (now < this.#postFullPaintSettleUntilMs) {
				if (this.#postFullPaintSettleTimer === undefined) {
					this.#postFullPaintSettleTimer = this.#renderScheduler.scheduleRender(() => {
						this.#postFullPaintSettleTimer = undefined;
						this.#postFullPaintSettleUntilMs = 0;
						if (this.#stopped) return;
						this.#requestOrdinaryRender();
					}, this.#postFullPaintSettleUntilMs - now);
				}
				return;
			}
			this.#postFullPaintSettleUntilMs = 0;
		}
		if (this.#renderRequested) return;
		this.#renderRequested = true;
		this.#renderScheduler.scheduleImmediate(() => this.#scheduleRender());
	}

	/**
	 * Decide whether this frame may compose component-scoped, and resolve the
	 * requested components to the root children that must re-render. Returns
	 * null — full compose — whenever a global condition could invalidate rows
	 * the partial compose would reuse, or when a requested component is not
	 * reachable from the current root child list.
	 */
	#resolvePartialComposeRoots(width: number, height: number): Set<Component> | null {
		if (this.#componentRenderTargets.size === 0) return null;
		if (!this.#hasEverRendered || this.#resizeEventPending) return null;
		if (width !== this.#previousWidth || height !== this.#previousHeight || width !== this.#composeWidth) return null;
		if (this.#clearScrollbackOnNextRender || this.#forceViewportRepaintOnNextRender) return null;
		if (this.overlayStack.length > 0) return null;
		// The image budget audits display order across the whole frame; a
		// partial walk would under-count it. Engage only on image-free frames.
		if (!this.#imageBudget.quiescent) return null;
		// The root child list must match the segment ledger exactly — a
		// structural change shifts offsets under every reused segment.
		const children = this.children;
		const segments = this.#frameSegments;
		if (segments.length !== children.length) return null;
		for (let i = 0; i < children.length; i++) {
			if (segments[i]!.component !== children[i]) return null;
		}
		const roots = this.#partialComposeRootsScratch;
		roots.clear();
		for (const target of this.#componentRenderTargets) {
			const root = this.#resolveComponentRoot(target);
			if (root === null) return null;
			roots.add(root);
		}
		return roots;
	}

	/** Root child whose subtree contains `target`, memoized per component. */
	#resolveComponentRoot(target: Component): Component | null {
		const cached = this.#componentRootCache.get(target);
		if (cached !== undefined && this.children.includes(cached) && subtreeContains(cached, target)) {
			return cached;
		}
		for (const child of this.children) {
			if (subtreeContains(child, target)) {
				this.#componentRootCache.set(target, child);
				return child;
			}
		}
		this.#componentRootCache.delete(target);
		return null;
	}

	/**
	 * Arm or extend the multiplexer-resize debounce so a single forced render
	 * fires once the pane is quiet. Called by the SIGWINCH callback on every
	 * resize event, and by `requestRender(true)` / `resetDisplay()` when they
	 * land inside an in-flight settle window. Each call cancels the prior
	 * timer, supersedes any queued throttled render (otherwise it would race
	 * tmux's mid-reflow paint), and OR's the caller's `clearScrollback`
	 * intent into `#deferredForcedClearScrollback` — the timer's callback
	 * consumes that flag exactly once when it re-enters `requestRender(true)`.
	 */
	#armMultiplexerResizeTimer(clearScrollback: boolean): void {
		this.#deferredForcedClearScrollback ||= clearScrollback;
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
		this.#renderRequested = false;
		if (this.#multiplexerResizeTimer) {
			this.#multiplexerResizeTimer.cancel();
		}
		this.#multiplexerResizeTimer = this.#renderScheduler.scheduleRender(() => {
			this.#multiplexerResizeTimer = undefined;
			if (this.#stopped) {
				this.#deferredForcedClearScrollback = false;
				return;
			}
			const deferredClearScrollback = this.#deferredForcedClearScrollback;
			this.#deferredForcedClearScrollback = false;
			this.requestRender(true, { clearScrollback: deferredClearScrollback });
		}, TUI.#MULTIPLEXER_RESIZE_DEBOUNCE_MS);
	}

	/**
	 * Arm the post-full-paint settle window after an `#emitFullPaint` that
	 * pushed content into native scrollback on a ConPTY host. Idempotent inside
	 * the window: a later overflowing paint extends `until` to the later
	 * deadline so back-to-back big paints do not double-fire the trailing
	 * coalesced render, and the existing deferred timer is rescheduled to the
	 * later deadline.
	 *
	 * Mid-composition callers (most notably `ImageBudget.endPass()`, which can
	 * call `requestRender()` from inside the in-flight paint when a new image
	 * trips the budget) queue their render *before* the settle exists, so they
	 * fall through the gate and set `#renderRequested` / `#renderTimer` on the
	 * 30 Hz throttle. Without absorbing those, the throttled follow-up fires
	 * inside the 150 ms quiet window and reintroduces the cascade the settle
	 * was meant to stop. Cancel both, then eagerly arm the trailing settle
	 * timer so the in-flight request still rides one coalesced render at the
	 * end of the window. See #2095.
	 */
	#armPostFullPaintSettle(): void {
		if (!isConPTYHosted()) return;
		const until = this.#renderScheduler.now() + TUI.#CONPTY_POST_FULL_PAINT_SETTLE_MS;
		if (until <= this.#postFullPaintSettleUntilMs) return;
		this.#postFullPaintSettleUntilMs = until;
		const hadPendingRender = this.#renderRequested || this.#renderTimer !== undefined;
		// Reclaim any render that was queued during the in-flight composition:
		// `#renderRequested` was set before the settle existed and would
		// otherwise fire on the standard throttle inside the window.
		this.#renderRequested = false;
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
		if (this.#postFullPaintSettleTimer) {
			this.#postFullPaintSettleTimer.cancel();
			this.#postFullPaintSettleTimer = undefined;
		}
		if (hadPendingRender) {
			// Replay the absorbed request via the trailing settle timer so the
			// caller's render still happens — just deferred to the end of the
			// window. Subsequent `requestRender(false)` calls during the
			// settle see this timer and fold into it (existing gate at L1263).
			this.#postFullPaintSettleTimer = this.#renderScheduler.scheduleRender(() => {
				this.#postFullPaintSettleTimer = undefined;
				this.#postFullPaintSettleUntilMs = 0;
				if (this.#stopped) return;
				this.#requestOrdinaryRender();
			}, TUI.#CONPTY_POST_FULL_PAINT_SETTLE_MS);
		}
	}

	#clearPostFullPaintSettle(): void {
		if (this.#postFullPaintSettleTimer) {
			this.#postFullPaintSettleTimer.cancel();
			this.#postFullPaintSettleTimer = undefined;
		}
		this.#postFullPaintSettleUntilMs = 0;
	}

	#maybeDeferGhosttyInitialImagePaint(): boolean {
		if (this.#ghosttyInitialImageDelayDone) return false;
		if (TERMINAL.id !== "ghostty" || TERMINAL.imageProtocol !== ImageProtocol.Kitty) {
			this.#ghosttyInitialImageDelayDone = true;
			return false;
		}
		if (!this.#imageBudget.hasPendingTransmits()) return false;
		if (this.#ghosttyInitialImageDelayTimer) return true;

		const delayMs = Math.max(0, this.#ghosttyImageReadyAtMs - this.#renderScheduler.now());
		if (delayMs === 0) {
			this.#ghosttyInitialImageDelayDone = true;
			return false;
		}

		this.#ghosttyInitialImageDelayTimer = this.#renderScheduler.scheduleRender(() => {
			this.#ghosttyInitialImageDelayTimer = undefined;
			this.#ghosttyInitialImageDelayDone = true;
			if (this.#stopped) return;
			this.#executeRender();
			if (this.#renderRequested) this.#scheduleRender();
		}, delayMs);
		return true;
	}
	#prepareForcedRender(clearScrollback: boolean): void {
		this.#clearScrollbackOnNextRender ||= clearScrollback;
		this.#forceViewportRepaintOnNextRender = true;
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
	}

	#scheduleRender(): void {
		if (this.#stopped || this.#renderTimer || !this.#renderRequested) {
			return;
		}
		// Defer any new throttled render scheduled inside the multiplexer
		// resize settle window: it would race tmux's mid-reflow pane repaint.
		// `#renderRequested` stays set so the eventual forced render — armed
		// by the SIGWINCH callback — picks up the latest component state.
		if (this.#multiplexerResizeTimer) {
			return;
		}
		const now = this.#renderScheduler.now();
		const elapsed = now - this.#lastRenderAt;
		const cadenceDelay = Math.max(0, TUI.#MIN_RENDER_INTERVAL_MS - elapsed);
		// Adaptive backpressure — target ~50% render duty cycle: the next frame
		// starts no sooner than `last_frame_end + last_frame_cost`, i.e.
		// `last_frame_start + 2 × last_frame_cost`. So `elapsed` (which counts
		// from the last frame's start) must already exceed twice the cost
		// before we allow the follow-up render to fire. Capped so a
		// pathological one-off spike doesn't lock the UI (#4145).
		const adaptiveFloor = Math.min(TUI.#MAX_ADAPTIVE_RENDER_MS, this.#lastFrameCostMs * 2);
		const adaptiveDelay = Math.max(0, adaptiveFloor - elapsed);
		const inputGraceDelay = Math.max(0, this.#inputRenderGraceUntilMs - now);
		const delay = Math.max(cadenceDelay, adaptiveDelay, inputGraceDelay);
		this.#renderTimer = this.#renderScheduler.scheduleRender(() => {
			this.#renderTimer = undefined;
			if (this.#stopped || !this.#renderRequested) {
				return;
			}
			this.#renderRequested = false;
			this.#executeRender();
			if (this.#renderRequested) {
				this.#scheduleRender();
			}
		}, delay);
	}

	/**
	 * Wrap `#doRender()` so every path records the wall-clock frame cost that
	 * feeds adaptive backpressure. Set `#lastRenderAt` first (some render code
	 * reads it re-entrantly) and compute the cost once the paint returns.
	 */
	#executeRender(): void {
		const start = this.#renderScheduler.now();
		this.#lastRenderAt = start;
		this.#doRender();
		this.#lastFrameCostMs = this.#renderScheduler.now() - start;
	}

	#handleInput(data: string): void {
		// Ctrl+C/Esc use app-level double-press windows. Give those gestures one
		// frame to drain queued input before an ordinary repaint; delaying every
		// key would make idle navigation pay a full frame of latency.
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
			this.#inputRenderGraceUntilMs = this.#renderScheduler.now() + TUI.#INPUT_RENDER_GRACE_MS;
		}
		if (this.#inputListeners.size > 0) {
			let current = data;
			for (const listener of this.#inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.#consumeCellSizeResponse(data)) {
			return;
		}

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// If focused component is an overlay, verify it's still visible
		// (visibility can change due to terminal resize or visible() callback)
		const focusedOverlay = this.overlayStack.find(o => o.component === this.#focusedComponent);
		if (focusedOverlay && !this.#isOverlayVisible(focusedOverlay)) {
			// Focused overlay is no longer visible, redirect to topmost visible overlay
			const topVisible = this.#getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				// No visible overlays, restore to preFocus
				this.setFocus(focusedOverlay.preFocus);
			}
		}

		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.#focusedComponent?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !this.#focusedComponent.wantsKeyRelease) {
				return;
			}
			this.#focusedComponent.handleInput(data);
			this.requestRender();
		}
	}

	#consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * Resolve overlay layout from options.
	 * Returns { width, row, col, maxHeight } for rendering.
	 */
	#resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number } {
		const opt = options ?? {};

		// Parse margin (clamp to non-negative)
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// Available space after margins
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === Resolve width ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// Apply minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// Clamp to available space
		width = Math.max(1, Math.min(width, availWidth));

		// === Resolve maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight) ?? availHeight;
		maxHeight = Math.max(1, Math.min(maxHeight, availHeight));

		// Effective overlay height: maxHeight is always resolved (defaults to
		// availHeight above), so the overlay is unconditionally clamped to fit.
		const effectiveHeight = Math.min(overlayHeight, maxHeight);

		// === Resolve position ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// Percentage: 0% = top, 100% = bottom (overlay stays within bounds)
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// Invalid format, fall back to center
					row = this.#resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// Absolute row position
				row = opt.row;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			row = this.#resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// Percentage: 0% = left, 100% = right (overlay stays within bounds)
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// Invalid format, fall back to center
					col = this.#resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// Absolute column position
				col = opt.col;
			}
		} else {
			// Anchor-based (default: center)
			const anchor = opt.anchor ?? "center";
			col = this.#resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// Apply offsets
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// Clamp to terminal bounds (respecting margins)
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	#resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	#resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/**
	 * Composite all visible overlays into the window slice (screen
	 * coordinates, in stack order, later = on top). Overlays never touch the
	 * frame: composited rows exist only in the painted window, and commits are
	 * frozen while an overlay is visible, so overlay pixels can never enter
	 * native scrollback.
	 */
	#compositeOverlaysIntoWindow(window: string[], termWidth: number, termHeight: number): string[] {
		const result = [...window];
		for (const entry of this.overlayStack) {
			if (!this.#isOverlayVisible(entry)) continue;
			const { component, options } = entry;
			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height).
			const { width, maxHeight } = this.#resolveOverlayLayout(options, 0, termWidth, termHeight);
			let overlayLines = component.render(width);
			if (overlayLines.length > maxHeight) {
				const anchor = options?.anchor ?? "center";
				overlayLines =
					anchor === "bottom-left" || anchor === "bottom-center" || anchor === "bottom-right"
						? overlayLines.slice(overlayLines.length - maxHeight)
						: overlayLines.slice(0, maxHeight);
			}
			const { row, col } = this.#resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = row + i;
				if (idx < 0 || idx >= result.length) continue;
				const truncatedOverlayLine =
					visibleWidth(overlayLines[i]) > width ? sliceByColumn(overlayLines[i], 0, width, true) : overlayLines[i];
				result[idx] = this.#compositeLineAt(result[idx], truncatedOverlayLine, col, width, termWidth);
			}
		}
		return result;
	}

	/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
	#compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		if (TERMINAL.isImageLine(baseLine)) return baseLine;

		// Single pass through baseLine extracts both before and after segments
		const afterStart = startCol + overlayWidth;
		const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

		// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
		const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

		// Pad segments to target widths
		const beforePad = Math.max(0, startCol - base.beforeWidth);
		const overlayPad = Math.max(0, overlayWidth - overlay.width);
		const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
		const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
		const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
		const afterPad = Math.max(0, afterTarget - base.afterWidth);

		// Compose result
		const r = SEGMENT_RESET;
		const result =
			base.before +
			" ".repeat(beforePad) +
			r +
			overlay.text +
			" ".repeat(overlayPad) +
			r +
			base.after +
			" ".repeat(afterPad);

		// CRITICAL: Always verify and truncate to terminal width.
		// This is the final safeguard against width overflow which would crash the TUI.
		// Width tracking can drift from actual visible width due to:
		// - Complex ANSI/OSC sequences (hyperlinks, colors)
		// - Wide characters at segment boundaries
		// - Edge cases in segment extraction
		const resultWidth = visibleWidth(result);
		if (resultWidth <= totalWidth) {
			return result;
		}
		// Truncate with strict=true to ensure we don't exceed totalWidth
		return sliceByColumn(result, 0, totalWidth, true);
	}

	/**
	 * Strip every CURSOR_MARKER from the rendered lines (markers are internal
	 * sentinels and must never reach the terminal, the committed prefix, or
	 * the resync audit) and return the positions of the stripped markers,
	 * bottom-most first. Callers pick the visible one once the window top is
	 * known.
	 */
	#extractCursorMarkers(lines: string[]): { row: number; col: number }[] {
		const markers: { row: number; col: number }[] = [];
		for (let row = lines.length - 1; row >= 0; row--) {
			const line = lines[row];
			let markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex === -1) continue;
			const beforeMarker = line.slice(0, markerIndex);
			markers.push({ row, col: visibleWidth(beforeMarker) });
			let stripped = line;
			while (markerIndex !== -1) {
				stripped = stripped.slice(0, markerIndex) + stripped.slice(markerIndex + CURSOR_MARKER.length);
				markerIndex = stripped.indexOf(CURSOR_MARKER, markerIndex);
			}
			lines[row] = stripped;
		}
		return markers;
	}

	#truncateLargeConptyFrame(
		lines: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
	): { lines: string[]; cursorPos: { row: number; col: number } | null } {
		if (!isConPTYHosted()) return { lines, cursorPos };

		let totalBytes = 0;
		let exceedsThreshold = false;
		for (const line of lines) {
			totalBytes += Buffer.byteLength(line, "utf8") + 8;
			if (totalBytes > TUI.#CONPTY_FRAME_TRUNCATE_THRESHOLD_BYTES) {
				exceedsThreshold = true;
				break;
			}
		}
		if (!exceedsThreshold) return { lines, cursorPos };

		let retainedBytes = 0;
		let retainedStart = lines.length;
		while (
			retainedStart > 0 &&
			(retainedBytes < TUI.#CONPTY_FRAME_RETAIN_BYTES || lines.length - retainedStart < height)
		) {
			retainedStart -= 1;
			retainedBytes += Buffer.byteLength(lines[retainedStart] ?? "", "utf8") + 8;
		}
		if (retainedStart <= 0) return { lines, cursorPos };

		const marker = truncateToWidth(
			`[${retainedStart} older lines hidden to keep Windows console resume responsive]`,
			width,
			Ellipsis.Omit,
		);
		const truncated = new Array<string>(lines.length - retainedStart + 1);
		truncated[0] = marker;
		for (let i = retainedStart; i < lines.length; i++) {
			truncated[i - retainedStart + 1] = lines[i] ?? "";
		}

		if (cursorPos === null || cursorPos.row < retainedStart) {
			return { lines: truncated, cursorPos: null };
		}
		return {
			lines: truncated,
			cursorPos: { row: cursorPos.row - retainedStart + 1, col: cursorPos.col },
		};
	}

	#terminalLine(line: string): string {
		if (TERMINAL.isImageLine(line)) return line;
		const coalesced = coalesceAdjacentSgr(line);
		return coalesced + (line.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET);
	}

	/**
	 * Render one frame.
	 *
	 * Append-only pipeline: compose the frame, derive the commit boundary from
	 * the component-reported live-region seam, advance the committed-row count
	 * monotonically, and emit either a gesture-driven full paint or an
	 * incremental update. Scrollback is `frame[0..committedRows)` at all
	 * times — no viewport probes, no deferred reconciliation.
	 */
	#doRender(): void {
		if (this.#stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;

		// Consume the component-scoped accumulation: it describes the render
		// requests made up to this frame, whichever path the frame takes.
		const componentScopedOnly = this.#pendingRenderComponentsOnly;
		this.#pendingRenderComponentsOnly = false;

		// Fullscreen alt-screen short-circuit. While the topmost visible overlay
		// requests it, borrow the terminal's alternate buffer and paint only the
		// modal there; the normal screen and all accounting stay untouched.
		let deferredAltExit = this.#pendingAltExit;
		const topOverlay = this.#getTopmostVisibleOverlay();
		const wantAlt = topOverlay?.options?.fullscreen === true;
		const wantMouseTracking = wantAlt && topOverlay.options?.mouseTracking !== false;
		if (wantAlt && !this.#altActive) {
			// Enhanced keyboard modes can be buffer-local: re-push the active
			// modified-key reporting sequence on the freshly entered alternate
			// screen, or Esc/modified keys revert to legacy encoding inside
			// fullscreen overlays (Ghostty/kitty/iTerm2).
			const mouseEnter = wantMouseTracking ? MOUSE_TRACKING_ON : "";
			this.terminal.write(`\x1b[?1049h${this.#keyboardEnhancementEnter()}${mouseEnter}`);
			setAltScreenActive(true);
			this.terminal.hideCursor();
			this.#forgetHardwareCursorState();
			this.#recordHardwareCursorHidden();
			this.#altActive = true;
			this.#altMouseTrackingActive = wantMouseTracking;
			this.#altPreviousLines = [];
			this.#altEnterWidth = width;
			this.#altEnterHeight = height;
		} else if (!wantAlt && this.#altActive) {
			const mouseExit = this.#altMouseTrackingActive ? MOUSE_TRACKING_OFF : "";
			const enhancementExit = this.#keyboardEnhancementExit();
			const exitSequence = `${mouseExit}${enhancementExit}\x1b[?1049l`;
			// Session replacement can finish while a fullscreen selector is still
			// covering the old normal buffer. Keep the overlay visible until the
			// replacement is ready, then fuse the buffer restore into that full paint;
			// a standalone exit exposes the stale session for one terminal frame.
			if (this.#clearScrollbackOnNextRender) {
				this.#pendingAltExit = exitSequence;
				deferredAltExit = exitSequence;
			} else this.terminal.write(exitSequence);
			setAltScreenActive(false);
			this.#forgetHardwareCursorState();
			this.#altActive = false;
			this.#altMouseTrackingActive = false;
			this.#altPreviousLines = [];
			// A resize while on the alt buffer reflowed the terminal's saved
			// normal screen; it no longer matches our accounting, so force the
			// geometry rebuild path instead of a stale diff.
			if (width !== this.#altEnterWidth || height !== this.#altEnterHeight) {
				this.#resizeEventPending = true;
			}
		} else if (wantMouseTracking !== this.#altMouseTrackingActive) {
			this.terminal.write(wantMouseTracking ? MOUSE_TRACKING_ON : MOUSE_TRACKING_OFF);
			this.#altMouseTrackingActive = wantMouseTracking;
		}
		if (this.#altActive) {
			this.#componentRenderTargets.clear();
			this.#renderAltFrame(width, height);
			return;
		}

		// Resize viewport fast path. While a non-multiplexer drag is in flight,
		// paint only the viewport and skip composing the off-screen history.
		// Strictly state-isolated: it never consumes #resizeEventPending nor
		// advances any commit/window/diff field, so the authoritative full paint
		// the settle timer queues reconciles as if these throwaway frames never
		// ran. Two render sources reach here mid-drag and BOTH must stay on this
		// path:
		//   - the resize callback's own cheap paint after each SIGWINCH;
		//   - an ordinary (non-forced) render from a live block that keeps
		//     animating through the drag — a spinner tick, a streamed token, a
		//     cursor blink — firing requestRender(false)/requestComponentRender.
		//     #resizeEventPending is still set (the fast path never consumed it),
		//     so without this branch the ordinary render falls through to the
		//     geometry-rebuild full paint below, which LEAVES the borrowed
		//     alternate screen to repaint the whole transcript on the normal
		//     screen — then the next SIGWINCH re-enters the alt screen and paints
		//     only the tail, so the block flashes in for one frame and vanishes.
		// A FORCED render mid-drag (tool finalization, resetDisplay, image
		// reconciliation) also stays on the fast path: preempting would leave
		// the borrowed alternate screen and run the geometry-rebuild full paint
		// on the normal screen — ED3 plus an O(history) replay that visibly
		// scrolls the whole transcript through the viewport, once per forced
		// render and once more at settle. The forced intent is not lost: the
		// fast path consumes neither #forceViewportRepaintOnNextRender nor
		// #clearScrollbackOnNextRender, and the settle's authoritative
		// requestRender(true) honors both — same fold-into-the-settle contract
		// as the multiplexer resize debounce. A visible overlay composites over
		// the transcript and needs the whole window, so it falls through
		// (overlay resizes are not on the drag-cost hot path).
		if (this.#resizeViewportActive && this.#hasEverRendered && this.#getTopmostVisibleOverlay() === undefined) {
			this.#componentRenderTargets.clear();
			this.#renderResizeViewport(width, height);
			return;
		}

		// A destructive replay erases native history and must receive the complete
		// component frame. Give virtualized roots one compose to rehydrate rows
		// they dropped after commit. Height-only and net-unchanged resize events
		// count too: both enter the geometry rebuild path below.
		const replayFullHistory =
			this.#hasEverRendered &&
			!resizeRepaintsInPlace() &&
			(this.#clearScrollbackOnNextRender ||
				this.#resizeEventPending ||
				(this.#previousWidth > 0 && this.#previousWidth !== width) ||
				(this.#previousHeight > 0 && this.#previousHeight !== height));
		if (replayFullHistory) {
			for (const child of this.children) prepareNativeScrollbackReplay(child);
		}

		// 1. Compose the frame. Bracket the render so the image budget observes
		// every inline image in display order (overlays carry none). A
		// component-scoped frame skips the budget pass instead — it is gated on
		// a quiescent budget, and a partial tree walk would under-count display
		// order — and re-renders only the requested root subtrees, reusing the
		// previous segment of every other root child.
		const partialRoots = componentScopedOnly ? this.#resolvePartialComposeRoots(width, height) : null;
		this.#componentRenderTargets.clear();
		let rawFrame: readonly string[];
		if (partialRoots !== null) {
			this.#partialComposeRoots = partialRoots;
			try {
				rawFrame = this.render(width);
			} finally {
				this.#partialComposeRoots = null;
			}
		} else {
			this.#imageBudget.beginPass();
			rawFrame = this.render(width);
			this.#imageBudget.endPass();
		}
		// Ghostty initial-image deferral must run before any render state is
		// consumed (#resizeEventPending, hardware-cursor state, commit
		// re-anchoring): the early return abandons this frame and the deferred
		// render recomposes from scratch, so consuming state here would
		// misclassify a pending resize as an ordinary diff and corrupt the paint.
		if (this.#maybeDeferGhosttyInitialImagePaint()) return;
		// Cursor markers were stripped at compose time (they are internal
		// sentinels and must never reach the terminal, the committed prefix, or
		// the audit); the visible marker is chosen after the window top is
		// known. Ascending by frame row.
		const cursorMarkers = this.#frameCursorMarkers;
		const liveRegionStart = this.#nativeScrollbackLiveRegionStart;

		// Exactness boundary (used by the audit-zone math below). Rows below it
		// are declared FINAL by the component seam: when they commit, they enter
		// the audited zone (byte-exact, repairable on violation). Rows above it
		// that scroll off the window commit as frozen visual snapshots (see
		// #committedPrefixAuditRows). The whole frame is final when the root
		// reports no seam (shell semantics).
		const frameLength = rawFrame.length;
		const finalBoundary = Math.max(0, Math.min(frameLength, liveRegionStart ?? frameLength));

		// 2. Transition state captured before any emitter runs.
		const prevWindowTop = this.#windowTopRow;
		const prevHardwareCursorRow = this.#hardwareCursorRow;
		const resizeEventOccurred = this.#resizeEventPending;
		this.#resizeEventPending = false;
		if (resizeEventOccurred) this.#forgetHardwareCursorState();
		const widthChanged = this.#previousWidth > 0 && this.#previousWidth !== width;
		// A resize event with net-unchanged dimensions still reflowed the
		// terminal buffer; classify it as a height change so geometry handling
		// repaints instead of diffing against a screen that no longer exists.
		const heightChanged =
			(this.#previousHeight > 0 && this.#previousHeight !== height) ||
			(resizeEventOccurred && this.#previousHeight > 0);
		const geometryChanged = widthChanged || heightChanged;

		// Committed-prefix audit. Rows below the audit mark are hard-verified
		// exact bytes; rows between the mark and the current exactness boundary
		// are frozen snapshots whose source JUST became final and must be
		// verified once (a pending header settling, a barrier clearing above a
		// shifted tail); rows past the boundary are still-live frozen snapshots,
		// exempt so a collapsing preview can never spray re-anchors mid-run. A
		// divergence re-anchors — feeding the divergenceRebuild erase-and-replay
		// below (mux fallback: recommit below the stale copy; duplication, never
		// loss) — instead of silently skipping rows (committed nowhere, painted
		// nowhere). Skipped on geometry frames (a rewrap legitimately reflows
		// every row), and skipped when the composed frame's stable prefix
		// covers every verified row and no rows newly became final.
		let committedRowsResynced = false;
		const newlyFinalEnd = Math.min(this.#committedRows, finalBoundary);
		// The exactness boundary can RETREAT (a markdown rewind, a mermaid fence
		// appearing, a fast-path reset re-opening a block): rows verified under
		// the old boundary have a live source again. Demote them to frozen
		// snapshots instead of auditing content that is expected to change —
		// their committed bytes stay as the visual record, and the next boundary
		// rise strict-verifies them once like any other frozen row.
		if (this.#committedPrefixAuditRows > newlyFinalEnd) {
			this.#committedPrefixAuditRows = newlyFinalEnd;
		}
		const auditRan =
			this.#hasEverRendered &&
			!geometryChanged &&
			!this.#clearScrollbackOnNextRender &&
			(this.#renderStablePrefixRows < this.#committedPrefixAuditRows ||
				newlyFinalEnd > this.#committedPrefixAuditRows);
		if (auditRan) {
			const committedRowsBeforeAudit = this.#committedRows;
			this.#auditCommittedPrefix(rawFrame, newlyFinalEnd);
			committedRowsResynced = this.#committedRows !== committedRowsBeforeAudit;
		}
		// A frame that shrank below the committed row count collapsed content
		// that was already recorded (a live suffix collapsing on abort/result).
		// Re-base the commit index at the first divergence against the recorded
		// prefix — frozen snapshots included; a collapse is precisely when the
		// record and the frame part ways — so the surviving exact prefix stays
		// recognized and is never re-shown or re-committed. Only genuinely new
		// content repaints below it.
		if (!geometryChanged && !this.#clearScrollbackOnNextRender && frameLength < this.#committedRows) {
			const limit = Math.min(this.#committedRows, frameLength);
			let diverged = limit;
			for (let i = 0; i < limit; i++) {
				if (!rowsEquivalent(rawFrame[i]!, this.#committedPrefix[i]!)) {
					diverged = i;
					break;
				}
			}
			if (diverged < this.#committedRows) {
				this.#committedRows = diverged;
				this.#committedPrefixAuditRows = Math.min(this.#committedPrefixAuditRows, diverged);
				this.#committedPrefix.length = diverged;
				committedRowsResynced = true;
			}
		}
		// Committed-prefix state this frame's commit math extends from
		// (post-audit): drives the audit-mark advance after the emit.
		const preCommitRows = this.#committedRows;
		const preAuditRows = this.#committedPrefixAuditRows;
		let committedPrefixResliced = false;

		// 3. Window and commit math (lengths only; content prepared below).
		let hasVisibleOverlay = false;
		for (const entry of this.overlayStack) {
			if (this.#isOverlayVisible(entry)) {
				hasVisibleOverlay = true;
				break;
			}
		}

		// 4. Classify. A resize is an explicit user gesture: normally the engine
		// erases and replays so history rewraps at the new geometry (the reader
		// snapped to the bottom just dragged the window). Multiplexer panes — and
		// terminals that re-report size on alt-screen toggles — instead repaint in
		// place, because an ED3 rewrap is unsafe (pane scrollback / alt-screen
		// feedback loop), so committed history keeps its old wrap.
		const firstPaint = !this.#hasEverRendered;
		const replaceRequested = this.#clearScrollbackOnNextRender;
		const geometryRebuild = geometryChanged && !resizeRepaintsInPlace();
		// Committed history no longer matches the frame: a finalized block
		// replaced its scrolled-off live render, or the frame collapsed into
		// recorded rows. Native scrollback is a render cache, not a court
		// record — erase and replay so history holds the content exactly once,
		// instead of recommitting the final form below the stale fragment
		// (a visibly duplicated block). Multiplexer panes cannot ED3 safely
		// and keep the repair-below fallback in the branches under this one.
		const divergenceRebuild =
			this.#scrollbackRebuildEnabled &&
			!firstPaint &&
			!replaceRequested &&
			!geometryChanged &&
			!isMultiplexerSession() &&
			(committedRowsResynced || frameLength <= this.#committedRows);
		const fullPaint = firstPaint || replaceRequested || geometryRebuild || divergenceRebuild;
		let windowTop: number;
		let chunkTo: number;
		if (fullPaint) {
			committedPrefixResliced = true;
			windowTop = Math.max(0, frameLength - height);
			chunkTo = windowTop;
		} else if (
			frameLength <= this.#committedRows ||
			(committedRowsResynced &&
				frameLength - this.#committedRows < height &&
				cursorMarkers.some(marker => marker.row >= this.#committedRows))
		) {
			// Multiplexer fallback (a direct terminal takes the divergenceRebuild
			// full paint above): either the frame shrank into the committed
			// prefix, or a committed-prefix resync left a focused cursor tail
			// shorter than the viewport. The latter happens when a streaming/live
			// block had an append-only prefix committed, then collapses on
			// abort/finalize: the audit re-anchors #committedRows at the first
			// divergent row, but flooring windowTop there would pin the editor
			// near the top and leave blank rows underneath. Re-show the frame
			// tail instead. The stale committed copy stays in native history;
			// duplicating a few rows is preferable to a live editor gap —
			// "duplication, never loss" is the ED3-unsafe fallback contract.
			committedPrefixResliced = true;
			windowTop = Math.max(0, frameLength - height);
			chunkTo = windowTop;
			this.#committedRows = chunkTo;
			this.#committedPrefix = rawFrame.slice(0, chunkTo);
		} else {
			// Re-anchor to the frame tail, floored at the committed boundary: a
			// shrink (or overlay close) pulls the window back down, but never
			// onto rows already in native history — re-showing those on the
			// grid would duplicate them for a scrolling reader. On a
			// multiplexer resize the pane reflowed its own history; committed
			// rows keep their old wrap there, same as any shell output.
			windowTop = Math.max(this.#committedRows, frameLength - height, 0);
			// Whatever scrolls above the window commits — the tape is the visual
			// record; nothing that was painted may vanish. Overlays freeze
			// commits: composited rows must never enter history, and the hidden
			// gap backfills via the chunk once the overlay closes. A multiplexer
			// resize also commits nothing — the pane keeps its own (old-wrap)
			// history — and re-bases the audit prefix at the new width so the
			// accepted wrap drift does not read as a violation on the next
			// ordinary frame.
			chunkTo = hasVisibleOverlay || geometryChanged ? this.#committedRows : windowTop;
			if (geometryChanged) {
				committedPrefixResliced = true;
				this.#committedPrefix = rawFrame.slice(0, this.#committedRows);
			}
		}

		// 5. Pick the visible cursor marker (bottom-most at or below the window
		// top), prepare lines, and build the visible window slice.
		let cursorPos: { row: number; col: number } | null = null;
		for (let i = cursorMarkers.length - 1; i >= 0; i--) {
			const marker = cursorMarkers[i]!;
			if (marker.row >= windowTop) {
				cursorPos = marker;
				break;
			}
		}
		const frame = this.#prepareFrame(rawFrame, width);
		let window: string[] = new Array(height);
		for (let r = 0; r < height; r++) window[r] = frame[windowTop + r] ?? "";
		if (hasVisibleOverlay) {
			window = this.#compositeOverlaysIntoWindow(window, width, height);
			const overlayMarkers = this.#extractCursorMarkers(window);
			if (overlayMarkers.length > 0) {
				cursorPos = { row: windowTop + overlayMarkers[0]!.row, col: overlayMarkers[0]!.col };
			}
			window = this.#prepareLinesArray(window, width);
		}
		const cursorTrackingLineCount = hasVisibleOverlay ? Math.max(frame.length, windowTop + height) : frame.length;

		const intent: RenderIntent = fullPaint
			? {
					kind: "fullPaint",
					clearScrollback: divergenceRebuild || ((replaceRequested || geometryRebuild) && !isMultiplexerSession()),
				}
			: { kind: "update", chunkTo, windowTop };
		this.#logRedraw(intent, frameLength, height);

		// Load newly-displayed image data once, before this frame's placements
		// reference it. For full paints, the emitter may need to place the
		// transmit after a destructive clear (ED2/ED3) but before row replay, so
		// build the buffer here and let the emitter decide where it lands.
		let imageTransmitBuffer = "";
		for (const seq of this.#imageBudget.takeTransmits()) imageTransmitBuffer += seq;
		// Purge graphics for images the budget demoted to text. Kitty keeps
		// images in a store that text clears don't touch; demoted rows still
		// visible re-render as text and the window diff repaints them.
		// Committed placements are immutable — their pixels are deleted but
		// their rows are not rewritten.
		let purgeSequence = "";
		if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
			for (const id of this.#imageBudget.takePurgeIds()) purgeSequence += encodeKittyDeleteImage(id);
		} else {
			this.#imageBudget.takePurgeIds();
		}

		// 6. Emit.
		if (intent.kind === "fullPaint") {
			this.#emitFullPaint(frame, window, width, height, cursorPos, purgeSequence, imageTransmitBuffer, {
				clearScrollback: intent.clearScrollback,
				chunkTo,
				windowTop,
				cursorTrackingLineCount,
				leadingSequence: deferredAltExit,
			});
			this.#pendingAltExit = "";
			this.#committedPrefix = rawFrame.slice(0, chunkTo);
			this.#committedPrefixAuditRows = Math.min(chunkTo, finalBoundary);
			this.#clearScrollbackOnNextRender = false;
			this.#hasEverRendered = true;
			this.#publishCommittedRows();
			if (!firstPaint && frameLength > height) this.#armPostFullPaintSettle();
			return;
		}
		if (imageTransmitBuffer.length > 0) {
			this.terminal.write(imageTransmitBuffer);
		}
		this.#emitUpdate(frame, window, width, height, cursorPos, purgeSequence, {
			chunkTo,
			windowTop,
			prevWindowTop,
			prevHardwareCursorRow,
			forceWindowRewrite: this.#forceViewportRepaintOnNextRender || (geometryChanged && resizeRepaintsInPlace()),
			repaintVirtualScrollInPlace: hasVisibleOverlay,
			cursorTrackingLineCount,
		});
		for (let i = this.#committedPrefix.length; i < chunkTo; i++) {
			this.#committedPrefix.push(rawFrame[i] ?? "");
		}
		// Audit-mark advance. A re-slice re-bases it outright. Otherwise it may
		// advance to the exactness boundary only when this frame verified the
		// newly-final span (auditRan hard-scans it) or no such span existed —
		// rows committed this frame below the boundary are fresh exact bytes.
		if (committedPrefixResliced || auditRan || preAuditRows >= Math.min(preCommitRows, finalBoundary)) {
			this.#committedPrefixAuditRows = Math.min(this.#committedRows, finalBoundary);
		} else {
			this.#committedPrefixAuditRows = Math.min(preAuditRows, this.#committedRows);
		}
		this.#publishCommittedRows();
	}

	/**
	 * Detect committed-prefix violations (see {@link findCommittedPrefixResync}
	 * for the zone semantics) and re-anchor the commit index at the first moved
	 * row, so subsequent rows recommit instead of being skipped: the stale copy
	 * stays in history — duplication, never loss. Pure in-place restyles keep
	 * their alignment and are left alone (stale styling in history was always
	 * the accepted artifact).
	 */
	#auditCommittedPrefix(rawFrame: readonly string[], newlyFinalEnd: number): void {
		const prefix = this.#committedPrefix;
		if (prefix.length === 0) return;
		const resyncTo = findCommittedPrefixResync(rawFrame, prefix, this.#committedPrefixAuditRows, newlyFinalEnd);
		if (resyncTo < 0) return;
		this.#committedRows = resyncTo;
		this.#committedPrefixAuditRows = Math.min(this.#committedPrefixAuditRows, resyncTo);
		prefix.length = resyncTo;
		if ($flag("PI_DEBUG_REDRAW")) {
			const msg = `[${new Date().toISOString()}] commit resync: committed prefix diverged at row ${resyncTo}; recommitting\n`;
			fs.appendFileSync(getDebugLogPath(), msg);
		}
	}

	/**
	 * Push the post-emit committed-row count to root children that implement
	 * {@link NativeScrollbackCommittedRows}. Compose feeds the same signal
	 * before each child render (see {@link render}), but guards that run
	 * BETWEEN frames — e.g. a controller consulting the transcript's
	 * committed boundary to decide whether a displaceable block may still be
	 * retracted — would otherwise observe a count one frame stale and retract
	 * rows that just entered immutable native scrollback, stranding an
	 * orphaned copy above the repainted block.
	 */
	#publishCommittedRows(): void {
		for (const segment of this.#frameSegments) {
			setNativeScrollbackCommittedRows(
				segment.component,
				Math.min(segment.rowCount, Math.max(0, this.#committedRows - segment.start)),
			);
		}
	}

	/**
	 * Prepare the composed frame for emission, in place. Rows below
	 * `#preparedValidRows` are already prepared against the current frame (the
	 * compose lowered that floor to the stable prefix); rows at/after it are
	 * revalidated positionally — a row whose raw content and width match its
	 * cached entry reuses the prepared line, anything else re-prepares.
	 */
	#prepareFrame(frame: readonly string[], width: number): string[] {
		const prepared = this.#preparedFrame;
		const meta = this.#preparedMeta;
		if (prepared.length > frame.length) {
			prepared.length = frame.length;
			meta.length = frame.length;
		}
		for (let i = Math.min(this.#preparedValidRows, prepared.length); i < frame.length; i++) {
			const raw = frame[i]!;
			const cached = meta[i];
			if (cached !== undefined && cached.raw === raw && cached.width === width) {
				prepared[i] = cached.line;
				continue;
			}
			const entry = this.#prepareLine(raw, width);
			meta[i] = entry;
			prepared[i] = entry.line;
		}
		this.#preparedValidRows = frame.length;
		return prepared;
	}

	/** Stateless variant for overlay-composited windows and alt-screen frames. */
	#prepareLinesArray(lines: readonly string[], width: number): string[] {
		const prepared: string[] = new Array(lines.length);
		for (let i = 0; i < lines.length; i++) {
			prepared[i] = this.#prepareLine(lines[i]!, width).line;
		}
		return prepared;
	}

	#prepareLine(raw: string, width: number): PreparedLine {
		if (TERMINAL.isImageLine(raw)) {
			return { raw, width, line: raw };
		}
		const source = this.#lineFitSource(raw, width);
		const normalized = normalizeTerminalOutput(source);
		const asciiWidth = this.#ansiAsciiLineWidth(normalized, width);
		if ((asciiWidth ?? visibleWidth(normalized)) <= width) {
			return { raw, width, line: normalized };
		}
		const line = truncateToWidth(normalized, width, Ellipsis.Omit);
		return { raw, width, line };
	}

	#lineFitSource(raw: string, width: number): string {
		const safeWidth = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
		const maxSourceLength = Math.min(
			LINE_FIT_MAX_SOURCE_CODE_UNITS,
			Math.max(LINE_FIT_MIN_SOURCE_CODE_UNITS, safeWidth * LINE_FIT_SOURCE_WIDTH_MULTIPLIER),
		);
		if (raw.length <= maxSourceLength) return raw;

		let output = "";
		let cells = 0;
		for (let i = 0; i < raw.length && cells < safeWidth; ) {
			if (raw.charCodeAt(i) === 0x1b) {
				const end = this.#ansiSequenceEnd(raw, i);
				if (end < 0) break;
				if (this.#ansiSequenceHasVisiblePayload(raw, i)) {
					const sequence = raw.slice(i, end);
					if (output.length + sequence.length <= maxSourceLength) {
						output += sequence;
						cells += visibleWidth(sequence);
					}
				}
				i = end;
				continue;
			}

			const code = raw.charCodeAt(i);
			if (code >= 0x20 && code <= 0x7e) {
				// Printable-ASCII run: every char here is exactly one cell wide, so
				// the run is copied with a single slice instead of a per-char
				// slice + visibleWidth call. Stop conditions mirror the general
				// path: width budget (cells), source budget (maxSourceLength).
				if (output.length >= maxSourceLength) break;
				const cap = i + Math.min(safeWidth - cells, maxSourceLength - output.length);
				let j = i + 1;
				while (j < raw.length && j < cap) {
					const c = raw.charCodeAt(j);
					if (c < 0x20 || c > 0x7e) break;
					j++;
				}
				output += raw.slice(i, j);
				cells += j - i;
				i = j;
				continue;
			}

			const next = code >= 0xd800 && code <= 0xdbff && i + 1 < raw.length ? i + 2 : i + 1;
			const char = raw.slice(i, next);
			const charWidth = visibleWidth(char);
			if (charWidth > 0 && cells + charWidth > safeWidth) break;
			if (output.length + char.length > maxSourceLength) {
				if (charWidth > 0) break;
				i = next;
				continue;
			}
			if (charWidth === 0) {
				const remainingVisibleCells = safeWidth - cells;
				const reservedCodeUnits = remainingVisibleCells * 2;
				if (output.length + char.length > maxSourceLength - reservedCodeUnits) {
					i = next;
					continue;
				}
			}
			output += char;
			cells += charWidth;
			i = next;
		}

		return output + SEGMENT_RESET;
	}

	#ansiSequenceEnd(line: string, start: number): number {
		const next = line.charCodeAt(start + 1);
		if (next === 0x5b) {
			let i = start + 2;
			while (i < line.length) {
				const final = line.charCodeAt(i);
				if (final >= 0x40 && final <= 0x7e) return i + 1;
				i++;
			}
			return -1;
		}
		if (next === 0x5d) {
			let i = start + 2;
			while (i < line.length) {
				const osc = line.charCodeAt(i);
				if (osc === 0x07) return i + 1;
				if (osc === 0x1b && line.charCodeAt(i + 1) === 0x5c) return i + 2;
				i++;
			}
			return -1;
		}
		return start + 2 <= line.length ? start + 2 : -1;
	}

	#ansiSequenceHasVisiblePayload(line: string, start: number): boolean {
		// OSC 66 (`\x1b]66;META;TEXT\x1b\\`) carries visible cells inside the payload.
		return (
			line.charCodeAt(start + 1) === 0x5d &&
			line.charCodeAt(start + 2) === 0x36 &&
			line.charCodeAt(start + 3) === 0x36 &&
			line.charCodeAt(start + 4) === 0x3b
		);
	}

	#ansiAsciiLineWidth(line: string, maxWidth: number): number | undefined {
		let col = 0;
		for (let i = 0; i < line.length; ) {
			const code = line.charCodeAt(i);
			if (code === 0x1b) {
				const next = line.charCodeAt(i + 1);
				if (next === 0x5b) {
					let j = i + 2;
					while (j < line.length) {
						const final = line.charCodeAt(j);
						if (final >= 0x40 && final <= 0x7e) break;
						j++;
					}
					if (j >= line.length) return undefined;
					i = j + 1;
					continue;
				}
				if (next === 0x5d) {
					// OSC 66 text-sizing spans carry visible payload inside the OSC.
					// Fall back to visibleWidth() so scaled cells stay exact.
					if (
						line.charCodeAt(i + 2) === 0x36 &&
						line.charCodeAt(i + 3) === 0x36 &&
						line.charCodeAt(i + 4) === 0x3b
					) {
						return undefined;
					}
					let j = i + 2;
					while (j < line.length) {
						const osc = line.charCodeAt(j);
						if (osc === 0x07) {
							i = j + 1;
							break;
						}
						if (osc === 0x1b && line.charCodeAt(j + 1) === 0x5c) {
							i = j + 2;
							break;
						}
						j++;
					}
					if (j >= line.length) return undefined;
					continue;
				}
				return undefined;
			}
			if (code < 0x20 || code > 0x7e) return undefined;
			col++;
			if (col > maxWidth) return col;
			i++;
		}
		return col;
	}

	#lineRewriteSequence(line: string, width: number): string {
		if (TERMINAL.isImageLine(line)) return ERASE_LINE + line;
		const terminalLine = this.#terminalLine(line);
		const asciiWidth = this.#ansiAsciiLineWidth(line, width);
		if (asciiWidth !== undefined) {
			// Exact width model: skip the erase only when the row truly fills
			// the line (an EL there would eat the last cell via pending-wrap).
			return asciiWidth >= width ? terminalLine : terminalLine + ERASE_TO_END_OF_LINE;
		}
		// Non-ASCII rows: the native measure can over-count combining-heavy
		// scripts, so a row it calls "full" may render short and leave stale
		// cells from the previous occupant — which would then scroll into
		// history baked into the committed row. Erase the line first instead
		// (rewrites always start at column 1, so EL-to-end clears the whole
		// row); the leading reset keeps BCE on the default background.
		return SEGMENT_RESET + ERASE_TO_END_OF_LINE + terminalLine;
	}

	/**
	 * Single state-transition point. Every emitter calls this exactly once at
	 * the end so cursor/window accounting stays consistent.
	 */
	#commit(
		lines: readonly string[],
		window: string[],
		width: number,
		height: number,
		hardwareCursor: HardwareCursorUpdate,
	): void {
		this.#previousFrameLength = lines.length;
		this.#previousWindow = window;
		this.#forceViewportRepaintOnNextRender = false;
		this.#previousWidth = width;
		this.#previousHeight = height;
		this.#recordHardwareCursorUpdate(hardwareCursor);
	}

	#targetHardwareCursorState(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
	): HardwareCursorState | null {
		if (!cursorPos || totalLines <= 0) return null;
		return {
			row: Math.max(0, Math.min(cursorPos.row, totalLines - 1)),
			col: Math.max(0, cursorPos.col),
			visible: this.#showHardwareCursor,
		};
	}

	#recordHardwareCursorState(state: HardwareCursorState): void {
		this.#hardwareCursorRow = state.row;
		this.#hardwareCursorState = state;
		this.#hardwareCursorVisible = state.visible;
		this.#hardwareCursorVisibilityKnown = true;
	}

	#recordHardwareCursorRowOnly(row: number, visible?: boolean): void {
		this.#hardwareCursorRow = row;
		this.#hardwareCursorState = null;
		if (visible !== undefined) {
			this.#hardwareCursorVisible = visible;
			this.#hardwareCursorVisibilityKnown = true;
		}
	}

	#recordHardwareCursorUpdate(update: HardwareCursorUpdate): void {
		if (update.state) {
			this.#recordHardwareCursorState(update.state);
			return;
		}
		this.#recordHardwareCursorRowOnly(update.toRow, update.visible);
	}

	#recordHardwareCursorHidden(): void {
		this.#hardwareCursorVisible = false;
		this.#hardwareCursorVisibilityKnown = true;
		if (!this.#hardwareCursorState) return;
		this.#hardwareCursorState = { ...this.#hardwareCursorState, visible: false };
	}

	#forgetHardwareCursorState(): void {
		this.#hardwareCursorState = null;
		this.#hardwareCursorVisibilityKnown = false;
	}

	#sameHardwareCursorState(state: HardwareCursorState): boolean {
		const current = this.#hardwareCursorState;
		return (
			current !== null && current.row === state.row && current.col === state.col && current.visible === state.visible
		);
	}

	/**
	 * Replay the frame from home, optionally clearing native scrollback first:
	 * committed prefix `[0, chunkTo)` followed by the visible window. ED3
	 * (`CSI 3 J`) is emitted here and only here, and only for gesture-driven
	 * paints (session replace, resize, resetDisplay, or an explicit
	 * `clearScrollback` initial paint).
	 */
	#emitFullPaint(
		frame: readonly string[],
		window: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		purgeSequence: string,
		imageTransmitBuffer: string,
		options: {
			clearScrollback: boolean;
			chunkTo: number;
			windowTop: number;
			cursorTrackingLineCount: number;
			leadingSequence: string;
		},
	): void {
		this.#fullRedrawCount += 1;
		const { chunkTo, windowTop, cursorTrackingLineCount } = options;
		// Map the frame-space cursor into paint space: committed-prefix rows
		// keep their index, visible-window rows land after the prefix, and a
		// cursor in neither region (hidden behind the overlay gap) hides.
		let paintCursorPos: { row: number; col: number } | null = null;
		if (cursorPos !== null) {
			if (cursorPos.row < chunkTo) {
				paintCursorPos = cursorPos;
			} else if (cursorPos.row >= windowTop && cursorPos.row < windowTop + height) {
				paintCursorPos = { row: chunkTo + cursorPos.row - windowTop, col: cursorPos.col };
			}
		}
		// ConPTY hosts bound the replay: merge prefix + window into one array
		// so #truncateLargeConptyFrame can measure the payload and retain only
		// the tail. Gated on the host check — everywhere else the merge would
		// copy a pointer per committed row (a 50k-row session = 50k-entry
		// array per resize step / theme change / session replace) just to be
		// returned unchanged. `paintLines` stays null unless truncation
		// actually rewrote the replay.
		let paintLines: string[] | null = null;
		let paintLineCount = chunkTo + height;
		if (isConPTYHosted()) {
			const merged = new Array<string>(chunkTo + height);
			for (let i = 0; i < chunkTo; i++) merged[i] = frame[i] ?? "";
			for (let screenRow = 0; screenRow < height; screenRow++) {
				merged[chunkTo + screenRow] = window[screenRow] ?? "";
			}
			const paint = this.#truncateLargeConptyFrame(merged, width, height, paintCursorPos);
			if (paint.lines !== merged) {
				paintLines = paint.lines;
				paintLineCount = paint.lines.length;
				paintCursorPos = paint.cursorPos;
			}
		}
		let buffer = this.#paintBeginSequence + this.#leaveResizeAltSequence() + options.leadingSequence + purgeSequence;
		if (options.clearScrollback) {
			// Clear native history without blanking the live viewport first. The
			// replay below rewrites every visible row from home, including blanks,
			// so terminals without DEC 2026 never expose an ED2-cleared frame.
			buffer += "\x1b[H\x1b[3J";
		} else {
			// Best-effort: push the pre-paint screen into scrollback on
			// terminals that implement kitty's ED 22
			// (copy-screen-to-scrollback-then-erase). Always follow with ED 2 so
			// the viewport is cleared regardless; on real kitty, ED 2 over the
			// now-blank screen is a no-op and does not push a second copy.
			if (TERMINAL.supportsScreenToScrollback) buffer += "\x1b[22J";
			buffer += "\x1b[2J\x1b[H";
		}
		if (imageTransmitBuffer.length > 0) buffer += imageTransmitBuffer;
		// DECCARA fills optimize only the rows that stay visible; history-bound
		// rows are written as full styled strings (their background must
		// survive in scrollback, which DECCARA cannot reach).
		const visibleStart = Math.max(0, paintLineCount - height);
		let fillSequence = "";
		let visibleTexts: string[] | null = null;
		if (this.#deccaraFillsEnabled() && visibleStart < paintLineCount) {
			// Untruncated, the visible slice is exactly the caller's window
			// (visibleStart === chunkTo) — reuse it rather than copying;
			// planDeccaraFills fills its own `texts` and never mutates input.
			let visible = window;
			if (paintLines !== null) {
				visible = new Array<string>(paintLineCount - visibleStart);
				for (let k = 0; k < visible.length; k++) visible[k] = paintLines[visibleStart + k] ?? "";
			}
			const plan = planDeccaraFills(visible, width);
			visibleTexts = plan.texts;
			fillSequence = plan.sequence;
		}
		if (paintLines === null) {
			// Common path: emit straight from the source arrays (the
			// pre-merge two-loop form); byte-identical to replaying the
			// merged array. Destructive history clears deliberately avoid ED2, so
			// each row must self-clear stale cells left by the previous viewport.
			for (let i = 0; i < chunkTo; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += options.clearScrollback
					? this.#lineRewriteSequence(frame[i] ?? "", width)
					: this.#terminalLine(frame[i] ?? "");
			}
			for (let screenRow = 0; screenRow < height; screenRow++) {
				if (chunkTo + screenRow > 0) buffer += "\r\n";
				const line = visibleTexts ? (visibleTexts[screenRow] ?? "") : (window[screenRow] ?? "");
				buffer += options.clearScrollback ? this.#lineRewriteSequence(line, width) : this.#terminalLine(line);
			}
		} else {
			for (let i = 0; i < paintLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				const line = visibleTexts && i >= visibleStart ? visibleTexts[i - visibleStart] : (paintLines[i] ?? "");
				buffer += options.clearScrollback ? this.#lineRewriteSequence(line, width) : this.#terminalLine(line);
			}
		}
		buffer += fillSequence;
		// Park the hardware cursor at real content bottom, not the padded
		// window bottom — a later height shrink would otherwise scroll live
		// rows into scrollback and duplicate them per resize step.
		const contentRows = Math.max(1, Math.min(height, frame.length - windowTop));
		const parkUp = height - contentRows;
		if (parkUp > 0) buffer += `\x1b[${parkUp}A`;
		const contentBottomRow = windowTop + contentRows - 1;
		const paintContentBottomRow = Math.max(0, paintLineCount - 1 - parkUp);
		const cursorControl = this.#cursorControlSequence(paintCursorPos, paintLineCount, paintContentBottomRow);
		buffer += cursorControl.seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);

		const committedCursorState = paintCursorPos
			? this.#targetHardwareCursorState(cursorPos, cursorTrackingLineCount)
			: null;
		const committedCursor = committedCursorState
			? {
					toRow: committedCursorState.row,
					state: committedCursorState,
					visible: committedCursorState.visible,
				}
			: {
					toRow: contentBottomRow,
					state: null,
					visible: cursorControl.visible,
				};

		this.#committedRows = chunkTo;
		this.#windowTopRow = windowTop;
		this.#commit(frame, window, width, height, committedCursor);
	}

	/**
	 * Enter (or extend) the non-multiplexer resize fast path. Marks the drag
	 * active so subsequent `#doRender` calls paint viewport-only, then (re)arms
	 * the quiet-window timer whose callback ends the drag with one authoritative
	 * full paint. Reset on every SIGWINCH, so the full replay fires only once the
	 * user stops dragging.
	 */
	#beginResizeViewport(): void {
		this.#resizeViewportActive = true;
		this.#resizeViewportSettleTimer?.cancel();
		this.#resizeViewportSettleTimer = this.#renderScheduler.scheduleRender(() => {
			this.#resizeViewportSettleTimer = undefined;
			this.#resizeViewportActive = false;
			if (this.#stopped) return;
			// The drag is quiet: replay the rewrapped transcript authoritatively.
			// #resizeEventPending was preserved across every viewport-only frame
			// (the fast path never consumes it), so this classifies as a geometry
			// rebuild — ED3 + full history — and the clearScrollback intent below
			// matches the gesture-driven reset path.
			this.#resizeEventPending = true;
			this.requestRender(true, { clearScrollback: !isMultiplexerSession() });
		}, TUI.#RESIZE_VIEWPORT_SETTLE_MS);
	}

	#requestResizeViewportPaint(): void {
		if (this.#stopped) return;
		this.#renderRequested = false;
		this.#executeRender();
		if (this.#renderRequested) this.#scheduleRender();
	}

	/**
	 * Compose and paint only the viewport for one resize fast-path frame.
	 * State-isolated: advances no commit/window/diff field and calls neither
	 * `#commit` nor `#emitFullPaint`, so the settle full paint reconciles against
	 * the pre-drag screen state.
	 */
	#renderResizeViewport(width: number, height: number): void {
		if (width <= 0 || height <= 0) return;
		// Tail renders call block.render(), which observes inline images on the
		// budget. This is a STABLE (partial) pass: the tail walk is bottom-up and
		// sees only the visible subset, so display-order-by-call-order is wrong
		// here — `beginPass(true)` makes observe() replay the last committed
		// live/text split per image id instead, so images keep their on-screen
		// state through the drag. Reset the pass each frame so a long drag does
		// not accumulate; never endPass() here — that mutates the demotion ledger
		// off a partial walk. The settle paint's own beginPass()/endPass() is the
		// authoritative accounting, and its beginPass() wipes these frames.
		this.#imageBudget.beginPass(true);
		const { window, contentRows } = this.#composeResizeViewport(width, height);
		this.#emitResizeViewport(window, height, contentRows, width);
		this.#resizeViewportPaintCount += 1;
	}

	/**
	 * Build the viewport window for a resize fast-path frame: the bottom
	 * `height` rows of the would-be full frame, collected bottom-up across root
	 * children. {@link ViewportTailProvider}s (the transcript) yield only their
	 * tail; the small live-region children below render in full — so every child
	 * entirely above the fold is skipped. A frame shorter than the viewport is
	 * top-aligned with blank rows below, matching the full-paint window geometry
	 * (windowTop = max(0, frameLength - height)). Cursor markers are stripped
	 * (the drag hides the hardware cursor) and rows are width-fitted via the
	 * stateless preparer, so no persistent prepared-frame cache is touched.
	 */
	#composeResizeViewport(width: number, height: number): { window: readonly string[]; contentRows: number } {
		const tail: string[] = []; // bottom-first
		const children = this.children;
		for (let i = children.length - 1; i >= 0 && tail.length < height; i--) {
			const child = children[i]!;
			const provider = asViewportTailProvider(child);
			const rows = provider ? provider.renderViewportTail(width, height - tail.length) : child.render(width);
			for (let r = rows.length - 1; r >= 0 && tail.length < height; r--) {
				tail.push(rows[r]!);
			}
		}
		const count = tail.length;
		const window: string[] = new Array(height);
		for (let screenRow = 0; screenRow < height; screenRow++) {
			// `tail` holds the bottom `count` frame rows, bottom-first. They fill
			// the viewport when the frame overflows it and sit at the top (blanks
			// below) when it underflows.
			window[screenRow] = screenRow < count ? tail[count - 1 - screenRow]! : "";
		}
		this.#extractCursorMarkers(window);
		return { window: this.#prepareLinesArray(window, width), contentRows: count };
	}

	/**
	 * Resolve the active keyboard-enhancement enter sequence. Falls back to the
	 * legacy `kittyEnableSequence` when a custom Terminal predates the
	 * `keyboardEnhancementEnterSequence` property.
	 */
	#keyboardEnhancementEnter(): string {
		return this.terminal.keyboardEnhancementEnterSequence ?? this.terminal.kittyEnableSequence ?? "";
	}

	/**
	 * Resolve the active keyboard-enhancement exit sequence. Falls back to popping
	 * kitty whenever a custom Terminal exposes its push sequence but predates the
	 * `keyboardEnhancementExitSequence` property.
	 */
	#keyboardEnhancementExit(): string {
		const exit = this.terminal.keyboardEnhancementExitSequence;
		if (exit !== undefined) return exit ?? "";
		return this.terminal.kittyEnableSequence ? "\x1b[<u" : "";
	}

	#enterResizeAltSequence(): string {
		if (this.#resizeAltActive || this.#altActive) return "";
		this.#resizeAltActive = true;
		setAltScreenActive(true);
		this.#forgetHardwareCursorState();
		this.#recordHardwareCursorHidden();
		return `${ALT_SCREEN_ENTER}${this.#keyboardEnhancementEnter()}`;
	}

	#leaveResizeAltSequence(): string {
		if (!this.#resizeAltActive) return "";
		const enhancementExit = this.#keyboardEnhancementExit();
		this.#resizeAltActive = false;
		setAltScreenActive(false);
		this.#forgetHardwareCursorState();
		return `${enhancementExit}${ALT_SCREEN_EXIT}`;
	}

	/**
	 * Emit a throwaway viewport repaint for the resize fast path as a per-row
	 * overwrite. A width change can make the terminal's normal buffer reflow
	 * full-width rows before the app repaints, so a width drag borrows the
	 * alternate screen: transient resizes truncate the viewport instead of
	 * pushing wrapped fragments into native scrollback. A height-only resize
	 * reflows nothing, so it repaints the normal screen in place — borrowing the
	 * alt buffer there is pure flicker, and on terminals that re-report their
	 * size when the alt buffer toggles it is self-sustaining: leaving a
	 * fullscreen overlay's alt screen fires a height-only SIGWINCH echo, which
	 * would otherwise re-borrow the alt buffer for one frame (the settings-exit
	 * flash, #5854). Normal-screen history is rebuilt once at settle via
	 * `#emitFullPaint`.
	 */
	#emitResizeViewport(window: readonly string[], height: number, contentRows: number, width: number): void {
		const widthChanged = this.#previousWidth > 0 && this.#previousWidth !== width;
		const altEnter = widthChanged ? this.#enterResizeAltSequence() : "";
		let buffer = `${this.#paintBeginSequence + altEnter}\x1b[H`;
		for (let r = 0; r < height; r++) {
			if (r > 0) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(window[r] ?? "", width);
		}
		// Park the hardware cursor at the real content bottom, not the padded
		// viewport bottom: a later height shrink would otherwise scroll the live
		// rows below the cursor into native scrollback and duplicate them until
		// the settle rebuild erases it.
		const parkUp = height - Math.max(1, contentRows);
		if (parkUp > 0) buffer += `\x1b[${parkUp}A`;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
	}

	/**
	 * Compose and paint a single fullscreen overlay frame on the alt buffer.
	 * Cursor markers are stripped (the modal draws its own in-band caret and
	 * keeps the hardware cursor hidden), and only the modal is composited over a
	 * blank base — the transcript is never touched while the alt buffer is up.
	 */
	#renderAltFrame(width: number, height: number): void {
		const base: string[] = new Array(Math.max(0, height)).fill("");
		let lines = this.#compositeOverlaysIntoWindow(base, width, height);
		this.#extractCursorMarkers(lines);
		lines = this.#prepareLinesArray(lines, width);
		this.#emitAltFrame(lines, width, height);
	}

	/**
	 * Full per-row viewport rewrite on the alt buffer. Emits only sync-output
	 * brackets, a cursor home, and per-row rewrites — never ED3, append-tail, or
	 * any native-scrollback byte, so it is fully isolated from the planner and
	 * #commit. The hardware cursor stays hidden (it is never re-shown here).
	 */
	#emitAltFrame(lines: string[], width: number, height: number): void {
		const fitted: string[] = new Array(height);
		for (let r = 0; r < height; r++) fitted[r] = lines[r] ?? "";
		// Flush queued image-data transmits (`a=t`, no visible output) before the
		// paint so id-keyed placements and placeholder cells composed into this
		// frame resolve against loaded data. The normal-screen path flushes these
		// ahead of its paint; without this, an image first shown inside a
		// fullscreen overlay (e.g. the settings shape preview) would render as
		// blank placeholder cells until the overlay closed.
		const imageTransmits = this.#imageBudget.takeTransmits();
		if (imageTransmits.length > 0) {
			let transmitBuffer = "";
			for (const seq of imageTransmits) transmitBuffer += seq;
			this.terminal.write(transmitBuffer);
		}
		// Skip an identical repaint (the modal is mostly static between
		// keystrokes) — unless a forced repaint (resetDisplay,
		// requestRender(true)) is pending: the redraw gesture must repair a
		// corrupted modal even when our cached frame is byte-identical.
		const force = this.#forceViewportRepaintOnNextRender;
		this.#forceViewportRepaintOnNextRender = false;
		if (!force && this.#altPreviousLines.length === height) {
			let same = true;
			for (let r = 0; r < height; r++) {
				if (fitted[r] !== this.#altPreviousLines[r]) {
					same = false;
					break;
				}
			}
			if (same) return;
		}
		let buffer = `${this.#paintBeginSequence}\x1b[H`;
		for (let r = 0; r < height; r++) {
			if (r > 0) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(fitted[r], width);
		}
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
		this.#altPreviousLines = fitted;
		this.#fullRedrawCount += 1;
	}

	/**
	 * Incremental frame update. Three byte shapes:
	 *
	 * - scroll-append: the rows leaving the screen are exactly the newly
	 *   committed chunk, already painted with final content — emit `\r\n` plus
	 *   the new bottom rows, then rewrite whatever else changed in place;
	 * - in-window diff: nothing scrolls, nothing commits — rewrite the changed
	 *   row range (cursor-only when nothing changed);
	 * - seam rewrite: write the chunk at the scrollback seam, then rewrite the
	 *   whole window (live-region re-layout, hidden-gap backfill, mux resize).
	 *
	 * Only chunk rows ever enter native history; the live window repaints in
	 * place with relative moves. This path never emits ED2/ED3 or an absolute
	 * cursor home — those snap a reader scrolled into history back to the
	 * bottom on several terminal families.
	 */
	#emitUpdate(
		frame: readonly string[],
		window: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		purgeSequence: string,
		options: {
			chunkTo: number;
			windowTop: number;
			prevWindowTop: number;
			prevHardwareCursorRow: number;
			forceWindowRewrite: boolean;
			repaintVirtualScrollInPlace: boolean;
			cursorTrackingLineCount: number;
		},
	): void {
		const {
			chunkTo,
			windowTop,
			prevWindowTop,
			prevHardwareCursorRow,
			forceWindowRewrite,
			repaintVirtualScrollInPlace,
			cursorTrackingLineCount,
		} = options;
		const chunkFrom = this.#committedRows;
		const chunkLength = chunkTo - chunkFrom;
		const scroll = windowTop - prevWindowTop;
		const previousWindow = this.#previousWindow;
		const contentRows = Math.max(1, Math.min(height, frame.length - windowTop));
		const contentBottomRow = windowTop + contentRows - 1;
		// Terminals clamp the hardware cursor to the viewport on resize; clamp
		// our tracking to match so relative moves land correctly.
		const clampedCursor = Math.min(prevHardwareCursorRow, prevWindowTop + height - 1);
		const currentScreenRow = Math.max(0, Math.min(height - 1, clampedCursor - prevWindowTop));

		// Scroll-append: committing exactly the rows that scroll off the top,
		// with content untouched since they were painted.
		if (
			!forceWindowRewrite &&
			chunkLength > 0 &&
			chunkLength === scroll &&
			scroll < height &&
			chunkFrom === prevWindowTop
		) {
			let prefixIntact = previousWindow.length === height;
			for (let i = 0; prefixIntact && i < chunkLength; i++) {
				if (previousWindow[i] !== frame[chunkFrom + i]) prefixIntact = false;
			}
			if (prefixIntact) {
				let buffer = this.#paintBeginSequence + purgeSequence;
				const moveToBottom = height - 1 - currentScreenRow;
				if (moveToBottom > 0) buffer += `\x1b[${moveToBottom}B`;
				for (let r = height - scroll; r < height; r++) {
					buffer += `\r\n${this.#lineRewriteSequence(window[r] ?? "", width)}`;
				}
				// Rewrite any remaining changed rows after the shift.
				let firstChanged = -1;
				let lastChanged = -1;
				for (let r = 0; r < height - scroll; r++) {
					if ((window[r] ?? "") === (previousWindow[r + scroll] ?? "")) continue;
					if (firstChanged === -1) firstChanged = r;
					lastChanged = r;
				}
				let cursorFromRow = windowTop + height - 1;
				if (firstChanged !== -1) {
					const up = height - 1 - firstChanged;
					if (up > 0) buffer += `\x1b[${up}A`;
					buffer += "\r";
					for (let r = firstChanged; r <= lastChanged; r++) {
						if (r > firstChanged) buffer += "\r\n";
						buffer += this.#lineRewriteSequence(window[r] ?? "", width);
					}
					cursorFromRow = windowTop + lastChanged;
				}
				const cursorControl = this.#cursorControlSequence(cursorPos, cursorTrackingLineCount, cursorFromRow);
				buffer += cursorControl.seq;
				buffer += this.#paintEndSequence;
				this.terminal.write(buffer);
				this.#committedRows = chunkTo;
				this.#windowTopRow = windowTop;
				this.#commit(frame, window, width, height, cursorControl);
				return;
			}
		}

		// In-window diff: nothing commits. Rewrite in place when the window slid
		// without a commit — an overlay visible (composited rows must never enter
		// history), a commit-frozen geometry frame, or the window pulling back
		// down after a shrink. Overlay cursor-only frames can also leave the
		// tracked row behind the physical cursor; a relative partial rewrite from
		// that stale origin can CRLF on the bottom row and scroll native history
		// without appending to the commit tape, so overlays always take the
		// top-clamped full rewrite.
		const inPlaceRewrite = repaintVirtualScrollInPlace || scroll !== 0;
		if (chunkLength === 0) {
			if (forceWindowRewrite || inPlaceRewrite) this.#fullRedrawCount += 1;
			let firstChanged = forceWindowRewrite || inPlaceRewrite ? 0 : -1;
			let lastChanged = forceWindowRewrite || inPlaceRewrite ? height - 1 : -1;
			if (!forceWindowRewrite && !inPlaceRewrite) {
				const comparable = previousWindow.length === height;
				for (let r = 0; r < height; r++) {
					if (comparable && (window[r] ?? "") === (previousWindow[r] ?? "")) continue;
					if (firstChanged === -1) firstChanged = r;
					lastChanged = r;
				}
			}
			if (firstChanged === -1) {
				if (purgeSequence.length > 0) this.terminal.write(purgeSequence);
				this.#writeCursorPosition(cursorPos, cursorTrackingLineCount);
				this.#previousWidth = width;
				this.#previousHeight = height;
				return;
			}
			let buffer = this.#paintBeginSequence + purgeSequence;
			if (inPlaceRewrite) {
				// The cursor tracker can be stale after overlay-only frames, and
				// meaningless after an uncommitted slide. A large CUU clamps at the
				// viewport top without using absolute cursor home, so the following
				// full-window rewrite cannot overflow the bottom.
				if (height > 1) buffer += `\x1b[${height - 1}A`;
			} else {
				const rowDelta = firstChanged - currentScreenRow;
				if (rowDelta > 0) buffer += `\x1b[${rowDelta}B`;
				else if (rowDelta < 0) buffer += `\x1b[${-rowDelta}A`;
			}
			buffer += "\r";
			// DECCARA-optimize the contiguous rewritten range (visible rows
			// only; rectangles are absolute screen rows).
			let fillTexts: string[] | null = null;
			let fillSequence = "";
			if (this.#deccaraFillsEnabled()) {
				const slice: string[] = new Array(lastChanged - firstChanged + 1);
				for (let r = firstChanged; r <= lastChanged; r++) slice[r - firstChanged] = window[r] ?? "";
				const plan = planDeccaraFills(slice, width, firstChanged);
				fillTexts = plan.texts;
				fillSequence = plan.sequence;
			}
			for (let r = firstChanged; r <= lastChanged; r++) {
				if (r > firstChanged) buffer += "\r\n";
				buffer += this.#lineRewriteSequence(fillTexts ? fillTexts[r - firstChanged] : (window[r] ?? ""), width);
			}
			buffer += fillSequence;
			// Never park below real content (a height shrink would scroll live
			// rows into history and duplicate them per resize step).
			let cursorFromRow = windowTop + lastChanged;
			const contentBottomScreenRow = contentBottomRow - windowTop;
			if (lastChanged > contentBottomScreenRow) {
				buffer += `\x1b[${lastChanged - contentBottomScreenRow}A`;
				cursorFromRow = contentBottomRow;
			}
			const cursorControl = this.#cursorControlSequence(cursorPos, cursorTrackingLineCount, cursorFromRow);
			buffer += cursorControl.seq;
			buffer += this.#paintEndSequence;
			this.terminal.write(buffer);
			this.#windowTopRow = windowTop;
			this.#commit(frame, window, width, height, cursorControl);
			return;
		}

		// Seam rewrite: write the chunk into history, then the whole window.
		// Cursor moves to the window top with a relative move; the chunk rows
		// pass through the screen and scroll off as the window rows are written
		// below them, so the rows entering scrollback are exactly the chunk.
		this.#fullRedrawCount += 1;
		let buffer = this.#paintBeginSequence + purgeSequence;
		if (currentScreenRow > 0) buffer += `\x1b[${currentScreenRow}A`;
		buffer += "\r";
		let wroteLine = false;
		for (let i = chunkFrom; i < chunkTo; i++) {
			if (wroteLine) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(frame[i] ?? "", width);
			wroteLine = true;
		}
		for (let screenRow = 0; screenRow < height; screenRow++) {
			if (wroteLine) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(window[screenRow] ?? "", width);
			wroteLine = true;
		}
		const parkUp = height - 1 - (contentBottomRow - windowTop);
		if (parkUp > 0) buffer += `\x1b[${parkUp}A`;
		const cursorControl = this.#cursorControlSequence(cursorPos, cursorTrackingLineCount, contentBottomRow);
		buffer += cursorControl.seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
		this.#committedRows = chunkTo;
		this.#windowTopRow = windowTop;
		this.#commit(frame, window, width, height, cursorControl);
	}

	/** Optional intent log under PI_DEBUG_REDRAW. */
	#logRedraw(intent: RenderIntent, newLength: number, height: number): void {
		if (!$flag("PI_DEBUG_REDRAW")) return;
		const detail =
			intent.kind === "update"
				? `update(chunk=${this.#committedRows}..${intent.chunkTo}, windowTop=${intent.windowTop})`
				: `fullPaint(clearScrollback=${intent.clearScrollback})`;
		const state =
			`committed=${this.#committedRows}, windowTop=${this.#windowTopRow}, ` +
			`lrStart=${this.#nativeScrollbackLiveRegionStart}`;
		const msg = `[${new Date().toISOString()}] render: ${detail} (prev=${this.#previousFrameLength}, new=${newLength}, height=${height}, ${state})\n`;
		fs.appendFileSync(getDebugLogPath(), msg);
	}

	/**
	 * Build cursor control sequences to position the hardware cursor for the IME
	 * candidate window. Returns escape sequences and the resulting cursor row for
	 * the caller to update `#hardwareCursorRow`. The sequences should be appended
	 * into the caller's own synchronized output block to avoid a flicker between
	 * content and cursor frames.
	 */
	#cursorControlSequence(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
		fromRow: number,
	): CursorControlResult {
		// No IME target or no content — hide cursor regardless of preference.
		const target = this.#targetHardwareCursorState(cursorPos, totalLines);
		if (!target) {
			return { seq: "\x1b[?25l", toRow: fromRow, toCol: 0, visible: false, state: null };
		}

		// Move cursor from current position to target.
		const rowDelta = target.row - fromRow;
		let seq = "";
		if (rowDelta > 0) {
			seq += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			seq += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		seq += `\x1b[${target.col + 1}G`;
		seq += target.visible ? "\x1b[?25h" : "\x1b[?25l";

		return { seq, toRow: target.row, toCol: target.col, visible: target.visible, state: target };
	}

	#isHiddenCursorKnown(): boolean {
		return this.#hardwareCursorVisibilityKnown && !this.#hardwareCursorVisible;
	}

	/**
	 * Write the hardware cursor position to the terminal as a standalone
	 * synchronized output block. Use when there is no surrounding render buffer
	 * to embed the sequences into.
	 */
	#writeCursorPosition(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		const target = this.#targetHardwareCursorState(cursorPos, totalLines);
		if (!target) {
			if (this.#isHiddenCursorKnown()) return;
			this.terminal.hideCursor();
			this.#recordHardwareCursorHidden();
			return;
		}
		if (this.#sameHardwareCursorState(target)) return;
		const cursorControl = this.#cursorControlSequence(cursorPos, totalLines, this.#hardwareCursorRow);
		this.terminal.write(`${this.#cursorBeginSequence}${cursorControl.seq}${this.#cursorEndSequence}`);
		this.#recordHardwareCursorUpdate(cursorControl);
	}
}
