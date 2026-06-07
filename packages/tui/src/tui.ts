/**
 * Minimal TUI implementation with differential rendering.
 *
 * Before changing the render planner, native-scrollback bookkeeping, capability
 * detection, or width math, read `docs/tui-core-renderer.md`: it documents the
 * failure modes (yank / corruption / flash / width crashes) and the invariants
 * this engine must not violate. The short version: the renderer cannot observe
 * the terminal's scroll position on most hosts, so ED3 (`CSI 3 J`) is confined
 * to the destructive `clearScrollback` path, an unobservable viewport probe is
 * never trusted for passive streaming, and the hot path clamps over-wide lines
 * instead of throwing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { $flag, getDebugLogPath } from "@oh-my-pi/pi-utils";
import { DEFAULT_MAX_INLINE_IMAGES, ImageBudget } from "./components/image";
import { planDeccaraFills } from "./deccara";
import { isKeyRelease, matchesKey } from "./keys";
import type { Terminal } from "./terminal";
import {
	encodeKittyDeleteImage,
	ImageProtocol,
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
// Bound the raw code-unit span handed to native width/truncation. A terminal
// row can only display `width` cells, so oversized component rows should not
// force proportional JS/native copies while deciding what the viewport shows.
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
// Mouse reporting (normal click tracking + SGR extended coordinates), enabled
// only for the lifetime of a fullscreen overlay so the rest of the app keeps the
// terminal's native text selection.
const MOUSE_TRACKING_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_TRACKING_OFF = "\x1b[?1006l\x1b[?1000l";

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
		process.nextTick(callback);
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
 */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

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
	 * Optional teardown. Called when the component is permanently removed from
	 * the live tree (e.g. a transcript reset). Release timers, intervals, and
	 * subscriptions here. Must be idempotent. Containers propagate dispose to
	 * their children; leaf components without resources may omit it.
	 */
	dispose?(): void;
}

/**
 * Optional component seam for native-scrollback pinning. A component that
 * renders a stable prefix followed by a live/transient suffix reports the local
 * line index where that suffix begins after each render. TUI treats that suffix
 * — and every root child rendered below it — as not yet safe to commit to native
 * scrollback on ED3-risk terminals whose viewport position is unobservable.
 *
 * `getNativeScrollbackCommitSafeEnd` optionally reports a *deeper* boundary
 * inside that live suffix: the line index up to which the live region is
 * append-only (its earlier rows never re-layout, only new rows append at the
 * bottom — a streaming assistant message). Rows in `[liveRegionStart,
 * commitSafeEnd)` that scroll above the viewport are safe to commit to native
 * scrollback even though they are technically live, because they will never
 * change. Without this, a single live block that alone overflows the viewport
 * loses its scrolled-off head (committed nowhere, repainted nowhere). Volatile
 * live blocks (tool previews that collapse) omit it, so their mutable rows stay
 * deferred. Defaults to `liveRegionStart` when absent.
 */
export interface NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined;
	getNativeScrollbackCommitSafeEnd?(): number | undefined;
}

function getNativeScrollbackLiveRegionStart(component: Component): number | undefined {
	return (component as Component & Partial<NativeScrollbackLiveRegion>).getNativeScrollbackLiveRegionStart?.();
}

function getNativeScrollbackCommitSafeEnd(component: Component): number | undefined {
	return (component as Component & Partial<NativeScrollbackLiveRegion>).getNativeScrollbackCommitSafeEnd?.();
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
	/**
	 * Allow a transient live-viewport repaint when the terminal cannot report
	 * whether its native viewport is at the tail.
	 *
	 * This is **not** a settled transcript commit and must not be used for tool
	 * completion, session replay, or other background/offscreen rewrites. On
	 * ED3-risk terminals it may deliberately choose a viewport repaint/deferred
	 * shrink without clearing native scrollback so autocomplete, IME, and focused
	 * editor chrome stay responsive without yanking a scrolled reader.
	 */
	allowUnknownViewportMutation?: boolean;
}

/** Options for deferred native scrollback rebuild checkpoints. Reserved for API stability. */
export interface NativeScrollbackRefreshOptions {
	allowUnknownViewport?: boolean;
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
	return Boolean(Bun.env.TMUX || Bun.env.STY || Bun.env.ZELLIJ);
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
export class Container implements Component {
	children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
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

	render(width: number): string[] {
		width = Math.max(1, width);
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			for (let i = 0; i < childLines.length; i++) lines.push(childLines[i]);
		}
		return lines;
	}
}

/**
 * Render intent. `#planRender` decides which one a frame is, and the
 * corresponding `#emit*` method owns the bytes written and the state update.
 *
 * - `noop`: no content change, only cursor may move.
 * - `initial`: first paint after `start()` — clear viewport, emit transcript.
 * - `sessionReplace`: caller asked for `{ clearScrollback: true }` on a forced
 *   render — clear viewport, clear scrollback (outside multiplexers).
 * - `historyRebuild`: a geometry change (terminal resize) left native history
 *   wrapped at the old size — clear viewport and scrollback so it rewraps at the
 *   new geometry. Also flushes deferred content-only rewrites.
 * - `liveRegionPinned`: ED3-risk/unknown foreground stream with a reported live
 *   suffix — optionally append newly sealed rows, then repaint the live/mutable
 *   tail without letting transient rows enter native history.
 * - `viewportRepaint`: rewrite the visible viewport in place. If `appendFrom`
 *   is set, emit those tail rows as scrollback growth first so streaming
 *   output reaches terminal history before the corrected viewport is drawn.
 * - `deferredShrink`: pure content shrink would re-expose rows already in
 *   native history. Keep row indices stable with blank tail padding, repaint
 *   only the viewport, and defer the real shorter replay to a checkpoint.
 * - `deferredTailRepaint`: a deferred history mutation also changed the active
 *   grid's bottom row; repaint only that row relative to the tracked hardware
 *   cursor so a bottom-anchored spinner can advance without rewriting rows that
 *   a slightly-scrolled reader can still see.
 * - `deferredMutation`: a row-inserting edit would reindex native scrollback
 *   while the user is scrolled. Defer all bytes until a safe rebuild checkpoint.
 * - `shrink`: trailing rows were dropped — clear extras inline.
 * - `diff`: differential repaint of visible rows / append new rows below.
 */
type RenderIntent =
	| { kind: "noop" }
	| { kind: "initial"; clearScrollback: boolean }
	| { kind: "sessionReplace" }
	| { kind: "historyRebuild" }
	| { kind: "overlayRebuild" }
	| { kind: "liveRegionPinned"; appendFrom: number; appendTo: number; renderViewportTop: number }
	| { kind: "viewportRepaint"; appendFrom?: number }
	| { kind: "deferredShrink"; paddedLength: number }
	| { kind: "deferredTailRepaint"; row: number; line: string }
	| { kind: "deferredMutation" }
	| { kind: "shrink" }
	| { kind: "diff"; firstChanged: number; lastChanged: number; appendedLines: boolean };

interface PreparedLine {
	raw: string;
	width: number;
	line: string;
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	terminal: Terminal;
	#previousLines: string[] = [];
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
	static readonly #MIN_RENDER_INTERVAL_MS = 1000 / 30;
	#cursorRow = 0; // Logical cursor row (end of rendered content)
	#hardwareCursorRow = 0; // Actual terminal cursor row (may differ due to IME positioning)
	#viewportTopRow = 0; // Content row currently mapped to screen row 0
	#sixelProbePendingDa = false;
	#sixelProbePendingGraphics = false;
	#sixelProbeBuffer = "";
	#sixelProbeTimeout?: NodeJS.Timeout;
	#sixelProbeUnsubscribe?: () => void;
	#showHardwareCursor = $flag("PI_HARDWARE_CURSOR");
	#clearOnShrink = $flag("PI_CLEAR_ON_SHRINK"); // Clear empty rows when content shrinks (default: off)
	#synchronizedOutputEnabled = shouldEnableSynchronizedOutputByDefault();
	#paintBeginSequence = this.#synchronizedOutputEnabled ? PAINT_BEGIN : PAINT_BEGIN_NO_SYNC;
	#paintEndSequence = this.#synchronizedOutputEnabled ? PAINT_END : PAINT_END_NO_SYNC;
	#cursorBeginSequence = this.#synchronizedOutputEnabled ? CURSOR_BEGIN : CURSOR_BEGIN_NO_SYNC;
	#cursorEndSequence = this.#synchronizedOutputEnabled ? CURSOR_END : CURSOR_END_NO_SYNC;
	#maxLinesRendered = 0; // Line count from last render, used for viewport calculation
	// Highest count of content rows currently sitting in terminal scrollback
	// above the visible viewport. Used to detect shrink-across-viewport-boundary
	// frames where the new transcript would re-expose rows the terminal has
	// already committed to history — without intervention the rows visibly
	// duplicate once the user scrolls back.
	#scrollbackHighWater = 0;
	// Set after a clear+full replay so the next insert-above-suffix frame does
	// not scroll replayed live chrome (status/editor) into fresh history.
	#suppressNextSuffixScroll = false;
	#nativeScrollbackLiveRegionStart: number | undefined;
	#nativeScrollbackCommitSafeEnd: number | undefined;
	#nativeScrollbackDirty = false;
	#deferredTailLine: string | undefined;
	// Highest `#maxLinesRendered` reached during a foreground tool turn while
	// intermediate frames were prevented from committing to terminal scrollback.
	// Used after the tool finishes to push the settled content into scrollback
	// via a non-destructive full paint (no ED 3). Reset to 0 once rows are
	// committed (via any `#emitFullPaint`, `#emitDiff`, or `#emitAppendTail`
	// path).
	#streamingHighWater = 0;
	// Tracks whether the previous frame was inside a foreground tool streaming
	// turn. Used to reset `#streamingHighWater` on fresh streaming starts.
	#previousStreamingActive = false;
	#fullRedrawCount = 0;
	// Caps how many inline images render as live graphics; older ones fall back
	// to text via a purge + full redraw. Cap is configured by the host app.
	#imageBudget = new ImageBudget(DEFAULT_MAX_INLINE_IMAGES, () => this.requestRender());
	#clearScrollbackOnNextRender = false;
	#forceViewportRepaintOnNextRender = false;
	#allowUnknownViewportMutationOnNextRender = false;
	#eagerNativeScrollbackRebuild = false;
	// Set when eager mode is switched off; applied after the next frame is
	// classified so teardown frames from the same event batch still render
	// eagerly (see setEagerNativeScrollbackRebuild).
	#eagerNativeScrollbackRebuildDisablePending = false;
	#previousVisibleOverlayComponents: Component[] = [];
	#visibleOverlayComponentsThisRender: Component[] = [];
	#hasEverRendered = false;
	// Set by the terminal resize callback; consumed by the next render. A resize
	// event invalidates the committed screen even when the dimensions net out
	// unchanged by render time (e.g. a 6→4→6 round trip coalesced into one frame
	// budget): the terminal reflowed its buffer on each event, moving rows
	// between the viewport and scrollback, so the previous frame no longer
	// describes the screen. Tracking only the dimension delta misses this.
	#resizeEventPending = false;
	#stopped = false;

	// Transient alternate-screen state for a fullscreen overlay. While active, the
	// engine paints only the modal on the alt buffer and leaves every
	// normal-screen accounting field (#previousLines, #viewportTopRow, …)
	// untouched, so exiting reconciles cleanly against the terminal-restored
	// normal screen. #altPreviousLines is the last alt frame, for repaint-skip.
	#altActive = false;
	#altPreviousLines: string[] = [];
	#altEnterWidth = 0;
	#altEnterHeight = 0;

	// Last-frame line preparation cache. Entries store normalized, width-fitted
	// content rows without the per-line terminal terminator; terminators are
	// appended only at write time so width checks stay on content, not reset bytes.
	#preparedLineCache: PreparedLine[] = [];

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
	}

	override render(width: number): string[] {
		width = Math.max(1, width);
		this.#nativeScrollbackLiveRegionStart = undefined;
		this.#nativeScrollbackCommitSafeEnd = undefined;
		const lines: string[] = [];
		for (const child of this.children) {
			const offset = lines.length;
			const childLines = child.render(width);
			const liveRegionStart = getNativeScrollbackLiveRegionStart(child);
			if (liveRegionStart !== undefined) {
				const boundedStart = Number.isFinite(liveRegionStart)
					? Math.max(0, Math.min(childLines.length, Math.trunc(liveRegionStart)))
					: childLines.length;
				this.#nativeScrollbackLiveRegionStart = offset + boundedStart;
				const commitSafeEnd = getNativeScrollbackCommitSafeEnd(child);
				if (commitSafeEnd !== undefined) {
					const boundedEnd = Number.isFinite(commitSafeEnd)
						? Math.max(boundedStart, Math.min(childLines.length, Math.trunc(commitSafeEnd)))
						: childLines.length;
					this.#nativeScrollbackCommitSafeEnd = offset + boundedEnd;
				}
			}
			for (let i = 0; i < childLines.length; i++) lines.push(childLines[i]);
		}
		return lines;
	}

	#syncTerminalCursorMode(component: Component | null): void {
		if (isFocusable(component)) {
			component.setUseTerminalCursor?.(this.#showHardwareCursor);
		}
	}

	get fullRedraws(): number {
		return this.#fullRedrawCount;
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

	getShowHardwareCursor(): boolean {
		return this.#showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.#showHardwareCursor === enabled) return;
		this.#showHardwareCursor = enabled;
		this.#syncTerminalCursorMode(this.#focusedComponent);
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.#clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true (default), empty rows are cleared when content shrinks.
	 * When false, empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.#clearOnShrink = enabled;
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

	/**
	 * When enabled, live render frames rebuild native scrollback on offscreen and
	 * structural changes even when the viewport position is unobservable (POSIX,
	 * where `isNativeViewportAtBottom()` is `undefined`), instead of deferring to a
	 * non-destructive repaint. This trades the anti-yank guarantee for a clean,
	 * duplicate-free history and is meant for windows where output above the fold
	 * is actively re-rendering — e.g. a tool whose result is still streaming and
	 * re-laying-out rows that have already scrolled into history. A terminal that
	 * reports a *known*-scrolled viewport still defers, as does native Windows
	 * (the viewport is never observable there and ConPTY hosts erase host
	 * scrollback on ED3 — #1635/#1746); only the unknown POSIX case is forced to
	 * rebuild. POSIX hosts known to disturb scrolled readers on xterm ED3
	 * (`CSI 3 J`, erase saved lines) also defer the eager opt-in; checkpoint
	 * rebuilds are unaffected.
	 *
	 * Disabling stays active through one already-requested frame: the event batch
	 * that ends a foreground stream both removes its UI rows (loader/status
	 * teardown — a shrink) and clears this flag before the throttled render timer
	 * fires. If the flag dropped immediately, that teardown frame would hit the
	 * ED3-risk idle deferral and freeze on screen (stale spinner) until the next
	 * keystroke. When no render is pending, disable immediately so a later
	 * unrelated content mutation does not inherit foreground-stream privileges.
	 */
	setEagerNativeScrollbackRebuild(enabled: boolean): void {
		if (enabled) {
			this.#eagerNativeScrollbackRebuild = true;
			this.#eagerNativeScrollbackRebuildDisablePending = false;
			return;
		}
		if (!this.#eagerNativeScrollbackRebuild) return;
		if (this.#renderRequested || this.#renderTimer !== undefined) {
			this.#eagerNativeScrollbackRebuildDisablePending = true;
			return;
		}
		if (this.#hasEagerEraseScrollbackRisk()) {
			this.#streamingHighWater = 0;
			this.#markNativeScrollbackDirty();
		}
		this.#eagerNativeScrollbackRebuild = false;
		this.#eagerNativeScrollbackRebuildDisablePending = false;
	}

	setFocus(component: Component | null): void {
		// Clear focused flag on old component
		if (isFocusable(this.#focusedComponent)) {
			this.#focusedComponent.focused = false;
		}

		this.#focusedComponent = component;

		// Set focused flag on new component and keep its software/hardware cursor
		// rendering mode aligned with TUI's single cursor-visibility preference.
		if (isFocusable(component)) {
			component.focused = true;
			this.#syncTerminalCursorMode(component);
		}
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry = { component, options, preFocus: this.#focusedComponent, hidden: false };
		this.overlayStack.push(entry);
		// Only focus if overlay is actually visible
		if (this.#isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.overlayStack.splice(index, 1);
					// Restore focus if this overlay had focus
					if (this.#focusedComponent === component) {
						const topVisible = this.#getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// Update focus when hiding/showing
				if (hidden) {
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.#focusedComponent === component) {
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
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
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

	#overlayVisibilityReduced(visibleComponents: readonly Component[]): boolean {
		if (this.#previousVisibleOverlayComponents.length === 0) return false;
		for (const component of this.#previousVisibleOverlayComponents) {
			if (!visibleComponents.includes(component)) return true;
		}
		return false;
	}

	override invalidate(): void {
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start(options?: TUIStartOptions): void {
		this.#stopped = false;
		// A DECRQM report for mode 2026 is authoritative: enable synchronized
		// output when the terminal reports support (upgrading conservatively
		// defaulted-off hosts like zellij/tmux-master/foot) and disable it when
		// the terminal reports it unsupported. An explicit user opt-out/force
		// (resolved at construction) still wins, so skip the probe in that case.
		this.terminal.onPrivateModeReport?.((mode, supported) => {
			if (mode !== 2026) return;
			if (synchronizedOutputUserOverride() !== null) return;
			this.#setSynchronizedOutput(supported);
		});
		this.terminal.start(
			data => this.#handleInput(data),
			() => {
				// Repaint immediately rather than via the throttled path: a resize must
				// clear and replay at the fresh geometry before the terminal's reflow
				// settles into a state a throttled frame would race. Forced render skips
				// the 30fps coalescing window, matching resetDisplay()'s prompt repaint.
				this.#resizeEventPending = true;
				this.requestRender(true);
			},
		);
		for (const listener of this.#startListeners) {
			try {
				listener();
			} catch {
				// Startup listeners are feature hooks; one broken hook must not prevent rendering.
			}
		}
		this.terminal.hideCursor();
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
		// Leave the alt buffer first so the teardown cursor math below runs against
		// the restored normal screen (which #previousLines still describes).
		if (this.#altActive) {
			this.terminal.write(`${MOUSE_TRACKING_OFF}\x1b[?1049l`);
			this.#altActive = false;
			this.#altPreviousLines = [];
		}
		if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
			for (const id of this.#imageBudget.takeAllTransmittedIds()) {
				this.terminal.write(encodeKittyDeleteImage(id));
			}
		}
		this.#clearSixelProbeState();
		this.#stopped = true;
		if (this.#renderTimer) {
			this.#renderTimer.cancel();
			this.#renderTimer = undefined;
		}
		// Place the parent shell on the first line after the rendered content. When
		// that line is still inside the viewport, moving there and writing `\r` is
		// enough; emitting `\r\n` would create an extra blank row. If the content
		// already reaches the viewport bottom, scroll exactly once so the prompt
		// lands directly below the last visible TUI row.
		if (this.#previousLines.length > 0) {
			const targetRow = this.#previousLines.length;
			const viewportBottom = this.#viewportTopRow + this.terminal.rows - 1;
			const clampedCursorRow = Math.max(this.#viewportTopRow, Math.min(this.#hardwareCursorRow, viewportBottom));
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
		this.terminal.stop();
	}

	/**
	 * Rebuild native terminal scrollback if live rendering deferred a history rewrite.
	 * Callers should only invoke this at checkpoints where the user is expected to be
	 * at the terminal bottom, such as after submitting a new prompt.
	 */
	refreshNativeScrollbackIfDirty(_options?: NativeScrollbackRefreshOptions): boolean {
		if (!this.#nativeScrollbackDirty || this.#stopped) return false;
		// Multiplexer panes preserve their own history and never receive a
		// destructive clear, so a checkpoint "replay" cannot reconcile anything —
		// it would only append a duplicate copy of the transcript to pane
		// history. Drop the dirty flag; there is nothing actionable behind it.
		if (isMultiplexerSession()) {
			this.#clearNativeScrollbackDirty();
			return false;
		}
		const nativeViewportAtBottom = this.#readNativeViewportAtBottom();
		// The checkpoint fires at a prompt submit — a bottom-pinning user action. On a
		// genuine local terminal the submit keystroke scrolls the host to its tail, so
		// an unprobeable viewport is safely at-bottom and the ED3 replay will not yank
		// a scrolled reader (the same explicit-user-action reasoning the resize rebuild
		// uses). Hosts whose scrollback a keystroke does not move — Windows
		// console/Terminal, SSH, multiplexers, unknown profiles — stay gated on a
		// positive at-tail probe (#1610/#1682/#1746); a known-scrolled viewport always
		// defers regardless of terminal.
		if (nativeViewportAtBottom === false) return false;
		if (nativeViewportAtBottom === undefined && !TERMINAL.submitPinsViewportToTail) return false;
		this.#prepareForcedRender(true);
		this.#renderRequested = false;
		this.#lastRenderAt = this.#renderScheduler.now();
		this.#doRender();
		return true;
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
		this.#prepareForcedRender(!isMultiplexerSession());
		this.#resizeEventPending = true;
		this.#renderRequested = false;
		this.#lastRenderAt = this.#renderScheduler.now();
		this.#doRender();
	}

	requestRender(force = false, options?: RenderRequestOptions): void {
		const allowUnknownViewportMutation = options?.allowUnknownViewportMutation === true;
		this.#allowUnknownViewportMutationOnNextRender ||= allowUnknownViewportMutation;
		if (force) {
			this.#prepareForcedRender(options?.clearScrollback === true);
			this.#renderRequested = true;
			this.#renderScheduler.scheduleImmediate(() => {
				if (this.#stopped || !this.#renderRequested) {
					return;
				}
				this.#renderRequested = false;
				this.#lastRenderAt = this.#renderScheduler.now();
				this.#doRender();
			});
			return;
		}
		if (this.#renderRequested) return;
		this.#renderRequested = true;
		this.#renderScheduler.scheduleImmediate(() => this.#scheduleRender());
	}

	#prepareForcedRender(clearScrollback: boolean): void {
		const geometryChanged =
			(this.#previousWidth > 0 && this.#previousWidth !== this.terminal.columns) ||
			(this.#previousHeight > 0 && this.#previousHeight !== this.terminal.rows);
		// A geometry replay rewraps clearable native scrollback at the new size.
		// Inside a multiplexer the pane reflows its own history and a replay only
		// duplicates it, so never promote forced renders to sessionReplace there.
		const replayGeometry =
			geometryChanged &&
			!isMultiplexerSession() &&
			this.#canReplayNativeScrollbackAtCheckpoint(this.#readNativeViewportAtBottom());
		this.#clearScrollbackOnNextRender ||= clearScrollback || replayGeometry;
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
		const elapsed = this.#renderScheduler.now() - this.#lastRenderAt;
		const delay = Math.max(0, TUI.#MIN_RENDER_INTERVAL_MS - elapsed);
		this.#renderTimer = this.#renderScheduler.scheduleRender(() => {
			this.#renderTimer = undefined;
			if (this.#stopped || !this.#renderRequested) {
				return;
			}
			this.#renderRequested = false;
			this.#lastRenderAt = this.#renderScheduler.now();
			this.#doRender();
			if (this.#renderRequested) {
				this.#scheduleRender();
			}
		}, delay);
	}

	#handleInput(data: string): void {
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
			this.requestRender(false, { allowUnknownViewportMutation: true });
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
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
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
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// Clamp to available space
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// Effective overlay height (may be clamped by maxHeight)
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

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

	/** Composite all overlays into content lines (in stack order, later = on top). */
	#compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) return lines;
		const result = [...lines];

		// Pre-render all visible overlays and calculate positions
		const rendered: { overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		for (const entry of this.overlayStack) {
			// Skip invisible overlays (hidden or visible() returns false)
			if (!this.#isOverlayVisible(entry)) continue;

			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight } = this.#resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines = component.render(width);

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			const { row, col } = this.#resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

			rendered.push({ overlayLines, row, col, w: width });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}

		// Ensure result is tall enough for overlay placement.
		// NOTE: Do not pad to maxLinesRendered.
		// maxLinesRendered tracks the terminal "working area" (max lines ever rendered) and can be much larger
		// than the current content. Padding to it can cause the renderer to output hundreds/thousands of blank
		// lines, effectively scrolling the terminal when an overlay is shown.
		const workingHeight = Math.max(result.length, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Track which lines were modified for final verification
		const modifiedLines = new Set<number>();

		// Composite each overlay
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[idx] = this.#compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
					modifiedLines.add(idx);
				}
			}
		}

		// Final verification: ensure no composited line exceeds terminal width
		// This is a belt-and-suspenders safeguard - compositeLineAt should already
		// guarantee this, but we verify here to prevent crashes from any edge cases
		// Only check lines that were actually modified (optimization)
		for (const idx of modifiedLines) {
			const lineWidth = visibleWidth(result[idx]);
			if (lineWidth > termWidth) {
				result[idx] = sliceByColumn(result[idx], 0, termWidth, true);
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
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	#extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// Cursor markers are internal sentinels and must never reach the terminal,
		// even when the focused component is above the visible viewport. Only a
		// visible marker becomes a hardware cursor target.
		const viewportTop = Math.max(0, lines.length - height);
		let cursor: { row: number; col: number } | null = null;
		for (let row = lines.length - 1; row >= 0; row--) {
			const line = lines[row];
			let markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex === -1) continue;
			if (cursor === null && row >= viewportTop) {
				const beforeMarker = line.slice(0, markerIndex);
				cursor = { row, col: visibleWidth(beforeMarker) };
			}
			let stripped = line;
			while (markerIndex !== -1) {
				stripped = stripped.slice(0, markerIndex) + stripped.slice(markerIndex + CURSOR_MARKER.length);
				markerIndex = stripped.indexOf(CURSOR_MARKER, markerIndex);
			}
			lines[row] = stripped;
		}
		return cursor;
	}

	#terminalLine(line: string): string {
		if (TERMINAL.isImageLine(line)) return line;
		return line + (line.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET);
	}

	/**
	 * Render one frame. Composes the frame, classifies the intent, and delegates
	 * to the matching emitter. Each emitter owns its bytes and ends with
	 * {@link #commit}, the single state-transition point.
	 */
	#doRender(): void {
		if (this.#stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;

		// Fullscreen alt-screen short-circuit. While the topmost visible overlay
		// requests it, borrow the terminal's alternate buffer (saved/restored by
		// the terminal around 1049h/1049l) and paint only the modal there. This
		// touches no normal-screen accounting field, so the transcript on the
		// normal screen stays untouched and unscrollable behind the modal, and
		// exiting reconciles cleanly against the terminal-restored screen.
		const wantAlt = this.#wantsAltScreen();
		if (wantAlt && !this.#altActive) {
			this.terminal.write(`\x1b[?1049h${MOUSE_TRACKING_ON}`);
			this.terminal.hideCursor();
			this.#altActive = true;
			this.#altPreviousLines = [];
			this.#altEnterWidth = width;
			this.#altEnterHeight = height;
		} else if (!wantAlt && this.#altActive) {
			this.terminal.write(`${MOUSE_TRACKING_OFF}\x1b[?1049l`);
			this.#altActive = false;
			this.#altPreviousLines = [];
			// A resize while on the alt buffer reflowed the terminal's saved normal
			// screen; it no longer matches #previousLines, so force the geometry
			// rebuild path instead of a stale diff.
			if (width !== this.#altEnterWidth || height !== this.#altEnterHeight) {
				this.#resizeEventPending = true;
			}
		}
		if (this.#altActive) {
			this.#renderAltFrame(width, height);
			return;
		}

		// 1. Compose the frame. Bracket the transcript render so the image budget
		// observes every inline image in display order (overlays carry none).
		this.#imageBudget.beginPass();
		let baseLines = this.render(width);
		if (this.#imageBudget.endPass()) {
			// A new image pushed the live-graphics count past the cap: force a full
			// redraw (so off-screen rows repaint as text) and purge the demoted
			// images' graphics in #emitFullPaint.
			this.#clearScrollbackOnNextRender = true;
		}
		const visibleOverlayComponents: Component[] = [];
		if (this.overlayStack.length > 0 || this.#previousVisibleOverlayComponents.length > 0) {
			for (const entry of this.overlayStack) {
				if (this.#isOverlayVisible(entry)) visibleOverlayComponents.push(entry.component);
			}
		}
		this.#visibleOverlayComponentsThisRender = visibleOverlayComponents;
		const overlayVisibilityReduced = this.#overlayVisibilityReduced(visibleOverlayComponents);
		let lines = visibleOverlayComponents.length > 0 ? this.#compositeOverlays(baseLines, width, height) : baseLines;
		const cursorPos = this.#extractCursorPosition(lines, height);
		lines = this.#prepareLines(lines, width, true);

		// 2. Capture transition + pre-render state before any emitter runs.
		const prevViewportTop = this.#viewportTopRow;
		const prevHardwareCursorRow = this.#hardwareCursorRow;
		const resizeEventOccurred = this.#resizeEventPending;
		this.#resizeEventPending = false;
		const widthChanged = this.#previousWidth > 0 && this.#previousWidth !== width;
		// A resize event with net-unchanged dimensions still reflowed the terminal
		// buffer; classify it as a height change so the geometry branches repaint
		// or rebuild instead of diffing against a screen that no longer exists.
		const heightChanged =
			(this.#previousHeight > 0 && this.#previousHeight !== height) ||
			(resizeEventOccurred && this.#previousHeight > 0);
		const eagerEraseScrollbackRisk = this.#hasEagerEraseScrollbackRisk();
		const eagerRebuildAllowed = this.#eagerNativeScrollbackRebuild && !eagerEraseScrollbackRisk;
		const explicitViewportMutation = this.#allowUnknownViewportMutationOnNextRender;
		const allowUnknownViewportMutation = explicitViewportMutation || eagerRebuildAllowed;
		this.#allowUnknownViewportMutationOnNextRender = false;

		// 3. Classify intent.
		let intent = this.#planRender(
			lines,
			widthChanged,
			heightChanged,
			prevViewportTop,
			height,
			visibleOverlayComponents.length > 0,
			overlayVisibilityReduced,
			allowUnknownViewportMutation,
			this.#nativeScrollbackLiveRegionStart,
			this.#nativeScrollbackCommitSafeEnd,
		);
		// 3b. Defer scrollback commits during foreground streaming, but only on
		// ED3-risk terminals whose committed scrollback cannot be rewritten without
		// yanking a scrolled reader. There the eager rebuild is gated off and the
		// diff emitter would otherwise `\r\n`-scroll every transient frame (spinner
		// ticks, partial output) into native history. Non-ED3-risk terminals keep
		// their eager live rebuild, which already commits cleanly. Explicit
		// reconciles — the prompt-submit checkpoint (`clearScrollbackOnNextRender`),
		// user-input/IME opt-ins (`explicitViewportMutation`), and overlay visibility
		// reductions that must scrub transient overlay cells from native history —
		// are never deferred: the triggering interaction pins the host to the bottom.
		const streamingWasActive = this.#eagerNativeScrollbackRebuild;
		if (streamingWasActive && !this.#previousStreamingActive) {
			this.#streamingHighWater = 0;
		}
		this.#previousStreamingActive = streamingWasActive;
		if (streamingWasActive && eagerEraseScrollbackRisk) {
			const streamingActive =
				this.#eagerNativeScrollbackRebuild && !this.#eagerNativeScrollbackRebuildDisablePending;
			// A terminal resize reflowed native scrollback at the OLD geometry, so the
			// saved rows are already mis-wrapped garbage. The planned historyRebuild
			// must stand and erase them (ED 3) — capping to a viewport repaint would
			// leave the corrupt history on screen. Like the other reconciles, a resize
			// is an explicit user action that snaps the host to the bottom, so there is
			// no scrolled reader to yank.
			const geometryChanged = widthChanged || heightChanged;
			const explicitReconcile =
				explicitViewportMutation ||
				this.#clearScrollbackOnNextRender ||
				overlayVisibilityReduced ||
				geometryChanged;
			// The defer below exists only to avoid `\r\n`-scrolling transient frames
			// past a reader parked in native scrollback. When the terminal can report
			// that the viewport is at the tail, there is no scrolled reader to yank,
			// so the planned intent must stand and commit normally — otherwise a row
			// that scrolls above the viewport top is dropped (neither pushed to
			// history nor kept in the capped viewport). Production POSIX ED3-risk
			// terminals cannot report this and stay `undefined`, so they still defer.
			const nativeViewportAtBottom = this.#readNativeViewportAtBottom();
			if (!streamingActive) {
				// Streaming just ended. Keep native scrollback dirty so the next
				// checkpoint reconciles the settled transcript; never erase here.
				this.#streamingHighWater = 0;
				this.#markNativeScrollbackDirty();
			} else if (
				!explicitReconcile &&
				nativeViewportAtBottom !== true &&
				!isMultiplexerSession() &&
				(intent.kind === "sessionReplace" ||
					intent.kind === "historyRebuild" ||
					intent.kind === "overlayRebuild" ||
					(intent.kind === "diff" && intent.appendedLines))
			) {
				// Cap the frame to the viewport and keep scrollback dirty: transient
				// rows never enter history, and the checkpoint reconciles later.
				// Multiplexers (tmux/screen/zellij) are excluded: their checkpoint
				// reconcile is a no-op (pane history cannot be erased), so any rows
				// dropped here are dropped forever. Pane history is append-only
				// anyway, so a normal diff/append `\r\n` commit is exactly what the
				// multiplexer needs — and the `liveRegionPinned` planner above
				// keeps the actively-mutating live tail out of pane history while
				// committing only the sealed prefix (issue #1974).
				// Do not lower #scrollbackHighWater here. The viewport repaint below
				// avoids committing new transient rows, but rows committed by earlier
				// full/diff paints are still physically present in native scrollback and
				// must remain in the shrink/de-dup accounting until an ED3 checkpoint
				// clears them.
				this.#markNativeScrollbackDirty();
				this.#streamingHighWater = Math.max(this.#streamingHighWater, lines.length);
				lines = lines.slice(-height);
				intent = { kind: "viewportRepaint" };
			} else {
				// Explicit reconcile or a non-committing frame (noop): let the
				// planned intent stand, but keep tracking the streaming peak.
				this.#streamingHighWater = Math.max(this.#streamingHighWater, lines.length);
			}
		}
		if (this.#eagerNativeScrollbackRebuildDisablePending) {
			this.#eagerNativeScrollbackRebuildDisablePending = false;
			this.#eagerNativeScrollbackRebuild = false;
		}
		this.#logRedraw(intent, lines.length, height);
		// Load any newly-displayed image data into the terminal once, before this
		// frame's placements (and any emitter) reference it. Data persists across
		// paints, so subsequent frames re-emit only the tiny placement sequence.
		// `a=t` produces no display, so writing it ahead of the synchronized paint
		// is artifact-free.
		const imageTransmits = this.#imageBudget.takeTransmits();
		if (imageTransmits.length > 0) {
			let transmitBuffer = "";
			for (const seq of imageTransmits) transmitBuffer += seq;
			this.terminal.write(transmitBuffer);
		}
		// 4. Execute.
		switch (intent.kind) {
			case "noop":
				this.#writeCursorPosition(cursorPos, lines.length);
				this.#viewportTopRow = Math.max(0, this.#maxLinesRendered - height);
				this.#previousWidth = width;
				this.#previousHeight = height;
				return;
			case "initial": {
				const liveRegionStart = this.#nativeScrollbackLiveRegionStart;
				if (
					this.#eagerNativeScrollbackRebuild &&
					eagerEraseScrollbackRisk &&
					!intent.clearScrollback &&
					!allowUnknownViewportMutation &&
					liveRegionStart !== undefined &&
					liveRegionStart < lines.length &&
					!isMultiplexerSession() &&
					this.#readNativeViewportAtBottom() === undefined
				) {
					this.#emitInitialLiveRegionPinnedPaint(
						lines,
						width,
						height,
						cursorPos,
						liveRegionStart,
						this.#nativeScrollbackCommitSafeEnd,
					);
				} else {
					this.#emitFullPaint(lines, width, height, cursorPos, {
						clearViewport: true,
						clearScrollback: intent.clearScrollback && !isMultiplexerSession(),
					});
				}
				this.#clearScrollbackOnNextRender = false;
				this.#hasEverRendered = true;
				return;
			}
			case "sessionReplace":
				this.#clearScrollbackOnNextRender = false;
				this.#clearNativeScrollbackDirty();
				this.#emitFullPaint(lines, width, height, cursorPos, {
					clearViewport: true,
					clearScrollback: !isMultiplexerSession(),
				});
				this.#hasEverRendered = true;
				return;
			case "historyRebuild":
				this.#clearNativeScrollbackDirty();
				this.#emitFullPaint(lines, width, height, cursorPos, {
					clearViewport: true,
					clearScrollback: !isMultiplexerSession(),
				});
				return;
			case "overlayRebuild":
				this.#clearNativeScrollbackDirty();
				this.#extractCursorPosition(baseLines, height);
				baseLines = this.#prepareLines(baseLines, width, false);
				this.#emitFullPaint(baseLines, width, height, null, {
					clearViewport: true,
					clearScrollback: !isMultiplexerSession(),
				});
				this.#emitViewportRepaint(lines, width, height, cursorPos);
				return;
			case "liveRegionPinned":
				this.#emitLiveRegionPinnedRepaint(
					lines,
					width,
					height,
					cursorPos,
					intent.appendFrom,
					intent.appendTo,
					intent.renderViewportTop,
					prevViewportTop,
					prevHardwareCursorRow,
				);
				return;
			case "viewportRepaint":
				if (intent.appendFrom !== undefined) {
					this.#emitAppendTail(lines, intent.appendFrom, height, prevViewportTop, prevHardwareCursorRow);
				}
				this.#emitViewportRepaint(lines, width, height, cursorPos);
				return;
			case "deferredTailRepaint":
				this.#emitDeferredTailRepaint(
					intent.line,
					width,
					height,
					intent.row,
					prevViewportTop,
					prevHardwareCursorRow,
				);
				return;
			case "deferredMutation":
				return;
			case "deferredShrink":
				this.#emitViewportRepaint(
					this.#padDeferredShrinkLines(lines, intent.paddedLength),
					width,
					height,
					cursorPos,
				);
				return;
			case "shrink":
				this.#emitShrink(lines, width, height, cursorPos, prevHardwareCursorRow, prevViewportTop);
				return;
			case "diff":
				this.#emitDiff(
					lines,
					width,
					height,
					cursorPos,
					intent.firstChanged,
					intent.lastChanged,
					intent.appendedLines,
					prevViewportTop,
					prevHardwareCursorRow,
				);
				return;
		}
	}

	/**
	 * Map the current frame onto a single render intent. Order matters: forced
	 * resets and session replacement short-circuit first, then a terminal resize
	 * (width or height change) always reduces to a clean reset + redraw at the new
	 * geometry — `historyRebuild` normally, `viewportRepaint` inside a multiplexer
	 * whose pane scrollback cannot be erased. Pure content mutations fall through
	 * to the differential machinery below.
	 */
	#planRender(
		newLines: string[],
		widthChanged: boolean,
		heightChanged: boolean,
		prevViewportTop: number,
		height: number,
		hasVisibleOverlay: boolean,
		overlayVisibilityReduced: boolean,
		allowUnknownViewportMutation: boolean,
		liveRegionStart: number | undefined,
		commitSafeEnd: number | undefined,
	): RenderIntent {
		// Initial paint after start(): preserve prior shell scrollback by default,
		// but honor callers that are replacing terminal history before any frame is
		// committed. This keeps the first visible commit clean instead of appending
		// a tall transcript once and wiping on the next render.
		if (!this.#hasEverRendered) return { kind: "initial", clearScrollback: this.#clearScrollbackOnNextRender };

		if (this.#clearScrollbackOnNextRender) return { kind: "sessionReplace" };

		const forceViewportRepaint = this.#forceViewportRepaintOnNextRender;
		const eagerEraseScrollbackRisk = this.#hasEagerEraseScrollbackRisk();
		if (overlayVisibilityReduced && !isMultiplexerSession()) {
			return hasVisibleOverlay ? { kind: "overlayRebuild" } : { kind: "historyRebuild" };
		}

		// A terminal resize (width or height change) reflows the terminal's own
		// buffer, moving rows between the viewport and native scrollback and
		// invalidating every cursor/viewport anchor the diff and append emitters
		// rely on. Always reset cleanly at the new geometry and redraw. Inside a
		// multiplexer the pane's saved lines cannot be erased (ED 3 is a no-op there
		// and a full replay only duplicates the transcript), so repaint the visible
		// window in place; a visible overlay rebuilds with its composite. This
		// deliberately drops the no-overflow and confirmed-scrolled guards — a
		// resize is an explicit user action, so a scrolled reader snaps to the
		// bottom and preexisting shell scrollback above the UI is cleared. The
		// streaming cap above explicitly exempts geometry changes, so even during
		// active ED3-risk foreground streaming this rebuild stands and erases the
		// scrollback the terminal just re-wrapped at the old size.
		if (widthChanged || heightChanged) {
			if (isMultiplexerSession()) return { kind: "viewportRepaint" };
			return hasVisibleOverlay ? { kind: "overlayRebuild" } : { kind: "historyRebuild" };
		}

		// Same dirty-scrollback opt-in policy as the non-overlay branch below: an
		// ED3-risk macOS/POSIX terminal with an unobservable viewport ignores
		// focused-input unknown opt-ins, so overlay selector Up/Down moves do not
		// become ED3 clears plus full transcript replays. Non-ED3-risk POSIX still
		// honors direct-input/IME/autocomplete opt-ins.
		if (hasVisibleOverlay) {
			const nativeViewportAtBottom = this.#readNativeViewportAtBottom();
			// Multiplexer panes never get a destructive scrollback clear
			// (clearScrollback is forced off inside them), so a dirty-scrollback
			// "rebuild" would only append a full duplicate copy of the transcript
			// to pane history on every dirty frame. Keep repainting the viewport
			// and leave reconciliation to explicit checkpoints.
			const allowDirtyUnknownViewportMutation = allowUnknownViewportMutation && !eagerEraseScrollbackRisk;
			if (
				this.#nativeScrollbackDirty &&
				!isMultiplexerSession() &&
				this.#canRebuildNativeScrollbackLive(nativeViewportAtBottom, allowDirtyUnknownViewportMutation)
			) {
				return { kind: "overlayRebuild" };
			}
			this.#markNativeScrollbackDirty();
			return { kind: "viewportRepaint" };
		}

		const liveRegionPinnedIntent = this.#planLiveRegionPinnedRender(
			newLines,
			height,
			liveRegionStart,
			commitSafeEnd,
			eagerEraseScrollbackRisk,
			allowUnknownViewportMutation,
		);
		if (liveRegionPinnedIntent) return liveRegionPinnedIntent;

		// After foreground tool streaming: when content finally shrinks from the
		// streaming peak, rebuild with ED 3 to commit the settled state cleanly.
		// The check uses `#streamingHighWater` (the real peak) rather than
		// `#previousLines.length` because unpinned ED3-risk streaming frames may
		// commit only a viewport slice while native history is deferred.
		if (this.#streamingHighWater > height && newLines.length < this.#streamingHighWater && newLines.length > height) {
			this.#streamingHighWater = 0;
			return { kind: "historyRebuild" };
		}
		if (this.#streamingHighWater > 0 && newLines.length <= height) {
			this.#streamingHighWater = 0;
		}

		if (this.#nativeScrollbackDirty && !isMultiplexerSession()) {
			// A dirty flag means older native history is stale; it is not required to
			// make the current focused-input frame correct. On ED3-risk macOS/POSIX
			// terminals with an unobservable viewport, ignore focused-input unknown
			// opt-ins so Up/Down selector moves do not become ED3 clears plus full
			// transcript replays. Non-ED3-risk POSIX terminals keep their safe
			// direct-input/IME/autocomplete opt-in.
			const allowDirtyUnknownViewportMutation = allowUnknownViewportMutation && !eagerEraseScrollbackRisk;
			if (
				this.#canRebuildNativeScrollbackLive(this.#readNativeViewportAtBottom(), allowDirtyUnknownViewportMutation)
			) {
				return { kind: "historyRebuild" };
			}
		}

		const diff = this.#diffLines(newLines);
		// Shrink across the viewport boundary: the new transcript would re-expose
		// rows already committed to native scrollback. Rebuild immediately when the
		// viewport is known/allowed to be at the tail; otherwise defer the rewrite
		// and repaint against the previous row count so users scrolled into history
		// are not yanked. A viewport-only repaint for a bottom-anchored shrink leaves
		// stale high-water rows in native scrollback and duplicates the new tail above
		// the viewport.
		const naturalViewportTop = Math.max(0, newLines.length - height);
		if (
			diff.firstChanged !== -1 &&
			newLines.length < this.#previousLines.length &&
			naturalViewportTop < this.#scrollbackHighWater &&
			!isMultiplexerSession()
		) {
			const nativeViewportAtBottom = this.#readNativeViewportAtBottom();
			if (this.#nativeViewportIsScrolled(nativeViewportAtBottom, allowUnknownViewportMutation)) {
				this.#markNativeScrollbackDirty();
				return { kind: "deferredShrink", paddedLength: this.#previousLines.length };
			}
			// A shrink that re-exposes rows already committed to native scrollback
			// must rebuild so the stale committed copy is cleared. Rebuild only with a
			// positive at-tail proof; unknown viewports stay dirty because the host
			// scroll position is not observable and ED3 can yank readers.
			if (this.#canRebuildNativeScrollbackLive(nativeViewportAtBottom, false)) {
				return { kind: "historyRebuild" };
			}
			// POSIX terminals — and Windows Terminal/ConPTY — that cannot report the
			// viewport position fall through here (`canRebuildNativeScrollbackLive` is
			// false). A destructive rebuild emits `\x1b[3J` (xterm erase saved lines),
			// which can clear or reposition native scrollback and yank a scrolled-up
			// reader (issue #1635), so it is unsafe while the probe is unavailable.
			//
			const paddedViewportTop = Math.max(0, this.#previousLines.length - height);
			// ED3-risk terminals with an unobservable viewport cannot safely clear
			// saved lines. Direct user-input frames (autocomplete/IME) may still
			// repaint the live viewport: the user action pins the host to the tail, and
			// emitting zero bytes leaves stale autocomplete rows on screen until a later
			// checkpoint. When the changed rows are at or below the previous viewport
			// top, keep the old bottom anchor by padding the frame to its previous
			// length; that clears stale popup rows without re-exposing rows already
			// committed to native history. If an offscreen edit shifted rows above the
			// viewport, padding would repaint the wrong seam, so use a viewport repaint
			// for liveness and keep history dirty. Active eager streaming also uses a
			// viewport repaint so the live tail keeps moving. With neither direct input
			// nor active eager streaming, the reader may be scrolled, so defer
			// completely rather than repainting over their history.
			if (nativeViewportAtBottom === undefined && eagerEraseScrollbackRisk) {
				this.#markNativeScrollbackDirty();
				if (allowUnknownViewportMutation) {
					return diff.firstChanged < prevViewportTop
						? { kind: "viewportRepaint" }
						: { kind: "deferredShrink", paddedLength: this.#previousLines.length };
				}
				return this.#eagerNativeScrollbackRebuild
					? { kind: "viewportRepaint" }
					: this.#planDeferredTailRepaint(newLines, prevViewportTop, height);
			}

			// Non-ED3-risk POSIX with an unobservable viewport. `deferredShrink` is
			// safe only when changed rows are at or below the previous viewport top.
			// Middle/offscreen deletes renumber rows above the viewport and padding
			// the old length would repaint shifted rows or blank tail cells.
			if (newLines.length <= paddedViewportTop) {
				return { kind: "historyRebuild" };
			}
			this.#markNativeScrollbackDirty();
			if (diff.firstChanged < prevViewportTop) {
				return this.#planDeferredTailRepaint(newLines, prevViewportTop, height);
			}
			return { kind: "deferredShrink", paddedLength: this.#previousLines.length };
		}

		// Multiplexer panes do not give us a safe native-history rebuild path, but
		// a shrink can still move the logical viewport upward (for example hiding an
		// overlay that extended past the base frame). A row-diff from the old
		// viewport top would only clear the old suffix and leave the newly exposed
		// base rows stale/blank, so repaint the live viewport in place.
		if (
			isMultiplexerSession() &&
			diff.firstChanged !== -1 &&
			newLines.length < this.#previousLines.length &&
			naturalViewportTop !== prevViewportTop
		) {
			return { kind: "viewportRepaint" };
		}

		// Direct-input shrink can also move the natural viewport upward even when
		// no stale high-water scrollback is involved (for example slash autocomplete
		// filtering from many rows to a few). The diff emitter is anchored to the
		// previous viewport top and would only clear the old suffix, hiding the
		// editor above the live window.
		if (
			allowUnknownViewportMutation &&
			diff.firstChanged !== -1 &&
			newLines.length < this.#previousLines.length &&
			naturalViewportTop !== prevViewportTop
		) {
			return { kind: "viewportRepaint" };
		}

		// A shrink that moves the bottom-anchored viewport upward must re-anchor the
		// visible window. The shrink-across-high-water block above already
		// rebuilt/deferred when the shrink re-exposes rows committed to native
		// scrollback (`naturalViewportTop < #scrollbackHighWater`). The remaining
		// case slips through when the high-water mark lags the logical viewport top:
		// non-destructive viewport repaints during foreground-tool streaming on
		// ED3-risk terminals (ghostty/kitty/…) advance `#maxLinesRendered` without
		// committing the overflow to native history, so a later shrink finds
		// `naturalViewportTop >= #scrollbackHighWater` yet still needs to move the
		// window up. The diff emitter below anchors to `#maxLinesRendered - height`
		// and would only rewrite the suffix — dropping the newly exposed top row and
		// leaving a blank at the bottom, so the rows below appear to render over the
		// ones above. Repaint the true bottom-anchored tail and leave stale
		// scrollback for the next checkpoint.
		if (
			!isMultiplexerSession() &&
			diff.firstChanged !== -1 &&
			newLines.length < this.#previousLines.length &&
			naturalViewportTop < prevViewportTop
		) {
			this.#markNativeScrollbackDirty();
			return { kind: "viewportRepaint" };
		}

		const suppressSuffixScroll = this.#suppressNextSuffixScroll;
		this.#suppressNextSuffixScroll = false;
		if (
			suppressSuffixScroll &&
			diff.appendedLines &&
			diff.firstChanged < this.#previousLines.length &&
			!isMultiplexerSession()
		) {
			// A checkpoint replay is followed by one frame where transient live chrome
			// (status/footer rows) may be inserted inside the visible suffix and then
			// disappear; repaint it in place so it never enters scrollback. If the
			// insertion grows the overflow boundary, native history would lose rows
			// while the viewport looks correct, so rebuild instead.
			const appendedTailStart = this.#findAppendedTailStart(newLines);
			const overflowBefore = Math.max(0, this.#previousLines.length - height);
			const overflowAfter = Math.max(0, newLines.length - height);
			if (
				appendedTailStart === newLines.length &&
				diff.firstChanged >= prevViewportTop &&
				overflowAfter <= overflowBefore
			) {
				return { kind: "viewportRepaint" };
			}
			const nativeViewportAtBottom = this.#readNativeViewportAtBottom();
			if (this.#canRebuildNativeScrollbackLive(nativeViewportAtBottom, allowUnknownViewportMutation)) {
				return { kind: "historyRebuild" };
			}
			this.#markNativeScrollbackDirty();
			return { kind: "viewportRepaint" };
		}

		if (diff.firstChanged === -1) {
			// Content unchanged. A forced render still refreshes the visible viewport
			// but keeps the existing diff basis so later coalesced content mutations
			// can still update native scrollback correctly.
			if (forceViewportRepaint) return { kind: "viewportRepaint" };
			return { kind: "noop" };
		}

		const contentGrew = newLines.length > this.#previousLines.length;
		const pureAppend = diff.appendedLines && diff.firstChanged === this.#previousLines.length;
		const structuralMutation = newLines.length !== this.#previousLines.length || diff.firstChanged < prevViewportTop;
		if (pureAppend && contentGrew && this.#previousLines.length >= height && !isMultiplexerSession()) {
			const nativeViewportAtBottom = this.#readNativeViewportAtBottom();
			if (this.#nativeViewportIsKnownScrolled(nativeViewportAtBottom)) {
				this.#markNativeScrollbackDirty();
				return { kind: "deferredMutation" };
			}
			if (nativeViewportAtBottom === undefined && allowUnknownViewportMutation) {
				// Direct input can grow transient live UI (autocomplete/IME/editor
				// wraps) while the previous frame already touched the viewport bottom.
				// A diff append would `\r\n`-scroll those transient rows into native
				// history, and a later popup shrink would duplicate the stable prefix at
				// the scrollback seam. Repaint the live viewport in place instead; the
				// dirty checkpoint owns native-history reconciliation.
				this.#markNativeScrollbackDirty();
				return { kind: "viewportRepaint" };
			}
			if (this.#nativeViewportIsScrolled(nativeViewportAtBottom, allowUnknownViewportMutation)) {
				this.#markNativeScrollbackDirty();
				// Unknown viewport (e.g. native Windows Terminal where the probe cannot
				// see WT host scrollback) is a different case: a no-op there freezes the
				// editor on the keystroke that grows `lines.length` past the viewport
				// (the wrap keystroke). Fall through to a non-destructive viewport
				// repaint instead so the live UI keeps updating without yanking a
				// possibly-scrolled reader.
				return { kind: "viewportRepaint" };
			}
		}
		// A structural mutation (offscreen edit or inserted rows) while bottom-
		// anchored: when the reader is scrolled, repaint/clamp without trusting the
		// stale viewport anchors; otherwise rebuild native history when a safe
		// checkpoint allows.
		if (!pureAppend && structuralMutation && !isMultiplexerSession()) {
			const nativeViewportAtBottom = this.#readNativeViewportAtBottom();
			if (this.#nativeViewportIsScrolled(nativeViewportAtBottom, allowUnknownViewportMutation)) {
				this.#markNativeScrollbackDirty();
				// See the matching comment on the pure-append branch above: confirmed
				// scrolled stays a no-op; unknown viewport repaints the visible window
				// so slash-command transitions and offscreen chrome edits paint on the
				// same frame instead of stalling until the next prompt submit.
				if (this.#nativeViewportIsKnownScrolled(nativeViewportAtBottom)) {
					return { kind: "deferredMutation" };
				}
				return { kind: "viewportRepaint" };
			}
			// The append-tail path can only scroll a clean pure-tail append over an
			// offscreen edit into history: the rows it pushes must equal the net
			// growth, i.e. `#findAppendedTailStart` must land on `previousLines.length`
			// (`tailAppendCount === addedCount`). Any mismatch is structurally
			// ambiguous — more added than the matched tail means offscreen rows were
			// inserted (a collapsed cell expanding); fewer means the previous last
			// line repeats earlier so the tail is mis-located. Under-counting splices
			// stale history; over-counting scrolls an extra row and duplicates the
			// line at the viewport top. Rebuild whenever the replay checkpoint allows.
			if (
				contentGrew &&
				diff.firstChanged < prevViewportTop &&
				this.#canRebuildNativeScrollbackLive(nativeViewportAtBottom, false)
			) {
				const appendedTailStart = diff.appendedLines ? this.#findAppendedTailStart(newLines) : newLines.length;
				const tailAppendCount = newLines.length - appendedTailStart;
				const addedCount = newLines.length - this.#previousLines.length;
				if (addedCount !== tailAppendCount) {
					return { kind: "historyRebuild" };
				}
			}
			if (
				newLines.length !== this.#previousLines.length &&
				this.#scrollbackHighWater > 0 &&
				this.#canRebuildNativeScrollbackLive(nativeViewportAtBottom, allowUnknownViewportMutation)
			) {
				return { kind: "historyRebuild" };
			}
		}

		// Configurable shrink-clear: opt-in path that repaints to wipe rows the
		// diff path would leave behind.
		if (this.#clearOnShrink && newLines.length < this.#previousLines.length && this.overlayStack.length === 0) {
			return { kind: "viewportRepaint" };
		}

		// Pure trailing shrink: all changed indices live past the new tail.
		if (diff.firstChanged >= newLines.length) {
			return { kind: "shrink" };
		}

		// Offscreen edit: repainting only the viewport leaves native history stale
		// while the user is bottom-anchored. Rebuild whenever replay is safe. If
		// replay is not safe, keep the viewport stable, mark history dirty, and only
		// scroll a clean appended tail so newly streamed rows remain reachable until
		// the next checkpoint rebuild.
		if (diff.firstChanged < prevViewportTop) {
			const nativeViewportAtBottom = this.#readNativeViewportAtBottom();
			const cleanTailAppend =
				diff.appendedLines && this.#findAppendedTailStart(newLines) === this.#previousLines.length;
			if (
				!isMultiplexerSession() &&
				this.#canRebuildNativeScrollbackLive(nativeViewportAtBottom, allowUnknownViewportMutation)
			) {
				return { kind: "historyRebuild" };
			}
			this.#markNativeScrollbackDirty();
			if (
				nativeViewportAtBottom === undefined &&
				eagerEraseScrollbackRisk &&
				!cleanTailAppend &&
				!this.#eagerNativeScrollbackRebuild
			) {
				return this.#planDeferredTailRepaint(newLines, prevViewportTop, height);
			}
			return { kind: "viewportRepaint", appendFrom: cleanTailAppend ? this.#previousLines.length : undefined };
		}

		if (forceViewportRepaint) {
			if (isMultiplexerSession()) return { kind: "viewportRepaint" };
			if (pureAppend && contentGrew && this.#previousLines.length >= height) {
				return { kind: "viewportRepaint", appendFrom: this.#previousLines.length };
			}
			if (newLines.length === this.#previousLines.length && diff.firstChanged >= prevViewportTop) {
				return { kind: "viewportRepaint" };
			}
		}

		return {
			kind: "diff",
			firstChanged: diff.firstChanged,
			lastChanged: diff.lastChanged,
			appendedLines: diff.appendedLines,
		};
	}

	/**
	 * Two-pointer diff over `#previousLines` and `newLines`. `firstChanged` is
	 * `-1` when the two are identical; otherwise it is the first differing
	 * index. Trailing appends are normalized so `lastChanged` always ends at the
	 * last row that needs to be touched.
	 */
	#diffLines(newLines: string[]): { firstChanged: number; lastChanged: number; appendedLines: boolean } {
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.#previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.#previousLines.length ? this.#previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";
			if (oldLine !== newLine) {
				if (firstChanged === -1) firstChanged = i;
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.#previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) firstChanged = this.#previousLines.length;
			lastChanged = newLines.length - 1;
		}
		return { firstChanged, lastChanged, appendedLines };
	}

	/**
	 * Locate the longest suffix of `#previousLines` that appears in `newLines`.
	 * The returned index is the first row past that suffix — the rows that are
	 * "new appends" relative to the unchanged tail. Used to push streaming
	 * output into scrollback even when an offscreen edit also moved rows.
	 */
	#findAppendedTailStart(newLines: string[]): number {
		if (this.#previousLines.length === 0) return newLines.length;
		const previousLast = this.#previousLines[this.#previousLines.length - 1];
		let bestEnd = -1;
		let bestLength = 0;
		for (let end = newLines.length - 1; end >= 0; end--) {
			if (newLines[end] !== previousLast) continue;
			let length = 1;
			while (
				length < this.#previousLines.length &&
				end - length >= 0 &&
				this.#previousLines[this.#previousLines.length - 1 - length] === newLines[end - length]
			) {
				length += 1;
			}
			if (length > bestLength) {
				bestLength = length;
				bestEnd = end;
			}
		}
		return bestEnd === -1 ? newLines.length : bestEnd + 1;
	}

	#markNativeScrollbackDirty(): void {
		this.#nativeScrollbackDirty = true;
	}

	#clearNativeScrollbackDirty(): void {
		this.#nativeScrollbackDirty = false;
	}

	#hasEagerEraseScrollbackRisk(): boolean {
		if (process.platform === "win32") return false;
		return this.terminal.hasEagerEraseScrollbackRisk?.() ?? TERMINAL.eagerEraseScrollbackRisk;
	}

	#readNativeViewportAtBottom(): boolean | undefined {
		// A stale positive is destructive: live history rebuilds clear native
		// scrollback. Require two consecutive at-bottom probes before trusting it.
		const first = this.terminal.isNativeViewportAtBottom?.();
		if (first !== true) return first;
		const second = this.terminal.isNativeViewportAtBottom?.();
		return second === true ? true : second;
	}

	#nativeViewportIsScrolled(
		nativeViewportAtBottom: boolean | undefined,
		allowUnknownViewportMutation = false,
	): boolean {
		return (
			nativeViewportAtBottom === false ||
			(nativeViewportAtBottom === undefined && process.platform === "win32" && !allowUnknownViewportMutation)
		);
	}

	#nativeViewportIsKnownScrolled(nativeViewportAtBottom: boolean | undefined): boolean {
		return nativeViewportAtBottom === false;
	}
	#canReplayNativeScrollbackAtCheckpoint(nativeViewportAtBottom: boolean | undefined): boolean {
		return nativeViewportAtBottom === true;
	}

	/**
	 * Live-frame counterpart to {@link #canReplayNativeScrollbackAtCheckpoint}.
	 * Decides whether a destructive native scrollback rebuild
	 * (`historyRebuild`/`overlayRebuild`, which clears saved lines and may move
	 * the native viewport) is safe to emit *during ordinary rendering*. POSIX
	 * terminals cannot report whether the user has scrolled up
	 * (`isNativeViewportAtBottom()` is `undefined`), so an unknown position is
	 * treated as unsafe by default: defer to a non-destructive viewport repaint and
	 * keep scrollback dirty until a later checkpoint/positive at-tail proof.
	 *
	 * `allowUnknownViewportMutation` is the narrow exception for direct
	 * input chrome (autocomplete/IME/editor wrapping): those frames may repaint or,
	 * on non-Windows hosts, rebuild live UI while the user action pins the prompt
	 * to the tail. Settled transcript commits should not use this flag; they must
	 * request an explicit clear+replay instead.
	 */
	#canRebuildNativeScrollbackLive(
		nativeViewportAtBottom: boolean | undefined,
		allowUnknownViewportMutation: boolean,
	): boolean {
		return (
			nativeViewportAtBottom === true ||
			(nativeViewportAtBottom === undefined && allowUnknownViewportMutation && process.platform !== "win32")
		);
	}

	#planLiveRegionPinnedRender(
		newLines: string[],
		height: number,
		liveRegionStart: number | undefined,
		commitSafeEnd: number | undefined,
		eagerEraseScrollbackRisk: boolean,
		allowUnknownViewportMutation: boolean,
	): RenderIntent | undefined {
		if (
			liveRegionStart === undefined ||
			liveRegionStart >= newLines.length ||
			!this.#eagerNativeScrollbackRebuild ||
			!eagerEraseScrollbackRisk ||
			allowUnknownViewportMutation
		) {
			return undefined;
		}
		// Multiplexers (tmux/screen/zellij) cannot erase pane history with `\x1b[3J`
		// and cannot answer a viewport-position probe, so the destructive checkpoint
		// rebuild path is forever unavailable. The pinned emitter is built from the
		// opposite primitives — relative cursor moves, per-row rewrite/suffix-clear,
		// and `\r\n` to scroll sealed rows past the viewport bottom — which are exactly
		// what tmux pane history accepts. Without this commit-as-you-go path, the
		// streaming cap below clipped every frame to the visible tail and the
		// scrolled-off head was committed nowhere (issue #1974).
		if (newLines.length <= height && this.#scrollbackHighWater === 0) return undefined;
		if (this.#readNativeViewportAtBottom() !== undefined) return undefined;

		this.#markNativeScrollbackDirty();
		const naturalViewportTop = Math.max(0, newLines.length - height);
		// Rows before the live-region boundary are sealed. The commit boundary is
		// the deeper of the sealed start and the append-only `commitSafeEnd`: a
		// streaming assistant block reports a `commitSafeEnd` spanning its whole
		// body, so its head rows that scroll above the viewport commit to native
		// scrollback instead of vanishing (committed nowhere, repainted nowhere).
		// A volatile live block (a tool preview that later collapses) omits
		// `commitSafeEnd`, so the boundary falls back to `liveRegionStart` and its
		// mutable rows stay deferred — otherwise a pending box that later collapses
		// to its running/final shape leaves the old top half in scrollback and
		// repaints the new tail below it, visually splitting one box across the
		// scrollback seam.
		const commitBoundary = commitSafeEnd ?? liveRegionStart;
		const sealedAppendTo = Math.min(naturalViewportTop, commitBoundary);
		const appendTo = Math.max(0, sealedAppendTo);
		const appendFrom = Math.min(this.#scrollbackHighWater, appendTo);
		// If the live-region collapse would re-expose committed rows already written
		// to native scrollback, clamp the repaint below that committed prefix so
		// committed rows are not duplicated. Mutable rows beyond the commit boundary
		// may remain hidden above the viewport until the next checkpoint rebuild;
		// that is safer than committing transient rows that can later re-layout.
		const committedSealedEnd = Math.min(this.#scrollbackHighWater, commitBoundary);
		const renderViewportTop = Math.max(naturalViewportTop, committedSealedEnd);
		return { kind: "liveRegionPinned", appendFrom, appendTo, renderViewportTop };
	}

	#planDeferredTailRepaint(newLines: string[], prevViewportTop: number, height: number): RenderIntent {
		const row = prevViewportTop + height - 1;
		if (row < 0 || row >= this.#previousLines.length || newLines.length !== this.#previousLines.length) {
			return { kind: "deferredMutation" };
		}
		const line = newLines[row] ?? "";
		const previousLine = this.#deferredTailLine ?? this.#previousLines[row] ?? "";
		if (line === previousLine) {
			return { kind: "deferredMutation" };
		}
		return { kind: "deferredTailRepaint", row, line };
	}

	#padDeferredShrinkLines(lines: string[], paddedLength: number): string[] {
		if (lines.length >= paddedLength) return lines;
		return [...lines, ...new Array<string>(paddedLength - lines.length).fill("")];
	}
	#prepareLines(lines: string[], width: number, useCache: boolean): string[] {
		const prepared: string[] = new Array(lines.length);
		const previous = useCache ? this.#preparedLineCache : [];
		const nextCache: PreparedLine[] | undefined = useCache ? new Array(lines.length) : undefined;
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i]!;
			const cached = previous[i];
			if (cached && cached.raw === raw && cached.width === width) {
				prepared[i] = cached.line;
				if (nextCache) nextCache[i] = cached;
				continue;
			}
			const entry = this.#prepareLine(raw, width);
			prepared[i] = entry.line;
			if (nextCache) nextCache[i] = entry;
		}
		if (nextCache) this.#preparedLineCache = nextCache;
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

		const chunks: string[] = [];
		let emitted = 0;
		for (let i = 0; i < raw.length && emitted < maxSourceLength; ) {
			if (raw.charCodeAt(i) === 0x1b) {
				const end = this.#ansiSequenceEnd(raw, i);
				if (end === -1) break;
				const sequenceLength = end - i;
				if (emitted > 0 && sequenceLength <= maxSourceLength - emitted) {
					chunks.push(raw.slice(i, end));
					emitted += sequenceLength;
				}
				i = end;
				continue;
			}

			const start = i;
			const end = Math.min(raw.length, start + maxSourceLength - emitted);
			while (i < end && raw.charCodeAt(i) !== 0x1b) i++;
			if (i === start) break;
			chunks.push(raw.slice(start, i));
			emitted += i - start;
		}

		return chunks.join("") + SEGMENT_RESET;
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
		const lineWidth = asciiWidth ?? visibleWidth(line);
		return lineWidth >= width ? terminalLine : terminalLine + ERASE_TO_END_OF_LINE;
	}

	/**
	 * Single state-transition point. Every emitter calls this exactly once at
	 * the end so cursor/viewport/scrollback accounting stays consistent.
	 */

	#commit(lines: string[], width: number, height: number, viewportTop: number, hardwareCursorRow: number): void {
		this.#deferredTailLine = undefined;
		this.#previousLines = lines;
		this.#previousVisibleOverlayComponents = this.#visibleOverlayComponentsThisRender;
		this.#forceViewportRepaintOnNextRender = false;
		this.#previousWidth = width;
		this.#previousHeight = height;
		this.#cursorRow = Math.max(0, lines.length - 1);
		this.#viewportTopRow = viewportTop;
		this.#hardwareCursorRow = hardwareCursorRow;
	}

	/**
	 * Clear the viewport (optionally scrollback) and emit the full transcript.
	 * Backs `initial`, `sessionReplace`, and `historyRebuild` intents.
	 */
	#emitFullPaint(
		lines: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		options: { clearViewport: boolean; clearScrollback: boolean },
	): void {
		this.#fullRedrawCount += 1;
		let buffer = this.#paintBeginSequence;
		// Purge graphics for images the budget just demoted to text. Kitty keeps
		// images in a store that text-clear escapes don't touch, so delete them by
		// id; other protocols bake images into cells the clear-screen below wipes.
		const purgeIds = this.#imageBudget.takePurgeIds();
		if (TERMINAL.imageProtocol === ImageProtocol.Kitty) {
			for (const id of purgeIds) buffer += encodeKittyDeleteImage(id);
		}
		if (options.clearViewport) {
			if (options.clearScrollback) {
				buffer += "\x1b[2J\x1b[H\x1b[3J";
			} else {
				// Best-effort: push the pre-paint screen into scrollback on terminals
				// that implement kitty's ED 22 (copy-screen-to-scrollback-then-erase).
				// ED 22 is not universal: multiplexers (tmux/screen/zellij), non-kitty
				// terminals, and old kitty ignore the unknown ED parameter, which left
				// the initial paint with no viewport clear (stale prior-program content
				// bled through until a resize). Always follow with ED 2 so the viewport
				// is cleared regardless; on real kitty, ED 2 over the now-blank screen
				// is a no-op and does not push a second (blank) copy to scrollback.
				if (TERMINAL.supportsScreenToScrollback) buffer += "\x1b[22J";
				buffer += "\x1b[2J\x1b[H";
			}
		}
		// Only the final viewport rows stay on screen; everything above scrolls
		// into native scrollback, so optimize the visible tail with DECCARA
		// rectangles while writing scrollback-bound rows as full styled strings
		// (their background must survive in history, which DECCARA cannot reach).
		const visibleStart = Math.max(0, lines.length - height);
		let fillSequence = "";
		let visibleTexts: string[] | null = null;
		if (this.#deccaraFillsEnabled() && visibleStart < lines.length) {
			const visible: string[] = new Array(lines.length - visibleStart);
			for (let k = 0; k < visible.length; k++) {
				visible[k] = lines[visibleStart + k] ?? "";
			}
			const plan = planDeccaraFills(visible, width);
			visibleTexts = plan.texts;
			fillSequence = plan.sequence;
		}
		for (let i = 0; i < lines.length; i++) {
			if (i > 0) buffer += "\r\n";
			buffer += this.#terminalLine(
				visibleTexts && i >= visibleStart ? visibleTexts[i - visibleStart] : (lines[i] ?? ""),
			);
		}
		buffer += fillSequence;
		const finalRow = Math.max(0, lines.length - 1);
		const { seq, toRow } = this.#cursorControlSequence(cursorPos, lines.length, finalRow);
		buffer += seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);

		this.#maxLinesRendered = options.clearViewport ? lines.length : Math.max(this.#maxLinesRendered, lines.length);
		if (options.clearScrollback) {
			this.#scrollbackHighWater = 0;
			this.#suppressNextSuffixScroll = lines.length > height;
		}
		const pushedNow = Math.max(0, lines.length - height);
		if (pushedNow > this.#scrollbackHighWater) {
			this.#scrollbackHighWater = pushedNow;
		}
		this.#commit(lines, width, height, Math.max(0, this.#maxLinesRendered - height), toRow);
	}

	/**
	 * Initial foreground-stream paint on ED3-risk hosts with unknown viewport
	 * position. Clears only the visible screen, commits the stable prefix, and
	 * paints the mutable live tail without first writing hidden live rows into
	 * native scrollback.
	 */
	#emitInitialLiveRegionPinnedPaint(
		lines: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		liveRegionStart: number,
		commitSafeEnd: number | undefined,
	): void {
		this.#fullRedrawCount += 1;
		this.#markNativeScrollbackDirty();
		const naturalViewportTop = Math.max(0, lines.length - height);
		const commitBoundary = commitSafeEnd ?? liveRegionStart;
		const appendTo = Math.max(0, Math.min(naturalViewportTop, commitBoundary, lines.length));
		const viewportTop = naturalViewportTop;

		let buffer = this.#paintBeginSequence;
		if (TERMINAL.supportsScreenToScrollback) buffer += "\x1b[22J";
		buffer += "\x1b[2J\x1b[H";

		let wroteLine = false;
		for (let i = 0; i < appendTo; i++) {
			if (wroteLine) buffer += "\r\n";
			buffer += this.#terminalLine(lines[i] ?? "");
			wroteLine = true;
		}
		for (let screenRow = 0; screenRow < height; screenRow++) {
			if (wroteLine) buffer += "\r\n";
			buffer += this.#terminalLine(lines[viewportTop + screenRow] ?? "");
			wroteLine = true;
		}

		const viewportBottomRow = viewportTop + height - 1;
		const contentBottomRow = Math.min(viewportBottomRow, Math.max(viewportTop, lines.length - 1));
		const parkUp = viewportBottomRow - contentBottomRow;
		if (parkUp > 0) buffer += `\x1b[${parkUp}A`;
		const { seq, toRow } = this.#cursorControlSequence(cursorPos, lines.length, contentBottomRow);
		buffer += seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);

		this.#maxLinesRendered = Math.max(lines.length, viewportTop + height);
		this.#scrollbackHighWater = appendTo;
		this.#commit(lines, width, height, viewportTop, toRow);
	}
	/**
	 * Rewrite the visible viewport in place. Cursor home, clear each row,
	 * emit the bottom-anchored slice of `lines`. No scrollback growth.
	 */
	#emitViewportRepaint(
		lines: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
	): void {
		this.#fullRedrawCount += 1;
		// A viewport repaint is a strictly in-place rewrite of the live window: it
		// homes to the screen top and writes exactly `height` rows, so it must stay
		// bottom-anchored at `lines.length - height`. Anchoring anywhere else pushes
		// the live tail off the screen bottom (blank rows below the content) AND — far
		// worse — persists the off-tail anchor into `#viewportTopRow` via `#commit`.
		// A later frame then reads that inflated `prevViewportTop`, mis-classifies an
		// ordinary tail change as an offscreen edit (`diff.firstChanged <
		// prevViewportTop`), and re-routes into an append/scroll path that re-commits
		// the same frame into native scrollback every tick — the self-driven "options
		// drawn again and again" spam.
		//
		// This repaint cannot un-commit rows already in native scrollback (no safe ED3
		// on ED3-risk hosts), so a shrink that re-exposes a committed prefix leaves a
		// stale copy above the viewport. That is the accepted deferred state: the live
		// window stays correct here, `#nativeScrollbackDirty` stays set, and the next
		// at-tail checkpoint (`refreshNativeScrollbackIfDirty`) reconciles history with
		// a clean clear+replay. Hiding the live tail to paper over the stale history —
		// the previous "anti-duplication clamp" — traded a transient, off-screen
		// history artifact for a broken live viewport, which is the worse defect.
		const viewportTop = Math.max(0, lines.length - height);
		// Each visible screen row, bottom-anchored, blank past content.
		const visible: string[] = new Array(height);
		for (let screenRow = 0; screenRow < height; screenRow++) {
			visible[screenRow] = lines[viewportTop + screenRow] ?? "";
		}
		const { texts, sequence } = this.#deccaraFillsEnabled()
			? planDeccaraFills(visible, width)
			: { texts: visible, sequence: "" };
		let buffer = `${this.#paintBeginSequence}\x1b[H`;
		for (let screenRow = 0; screenRow < height; screenRow++) {
			if (screenRow > 0) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(texts[screenRow], width);
		}
		// DECCARA rectangles paint the visible fills before cursor positioning;
		// the cleared cells written above are what the rectangles repaint.
		buffer += sequence;
		// The loop unconditionally writes `height` rows from screen row 0, so the
		// hardware cursor lands at the padded viewport bottom (`viewportTop +
		// height - 1`) even when the content is shorter than the viewport and the
		// trailing rows are blank. Parking it below the content is unsafe: a later
		// terminal height *shrink* scrolls the live content rows up into native
		// scrollback to keep that cursor on screen, and the next repaint redraws
		// them — committing a duplicate copy of the visible block to history once
		// per resize step (a drag-resize multiplies it). Move the cursor up to the
		// real content bottom so it matches the post-paint invariant every other
		// emitter holds and the reflow has no live rows to scroll away. The move is
		// physical (not just tracked), so `#cursorControlSequence`'s relative
		// `rowDelta` stays correct and the IME cursor still lands on its row after a
		// height-grow resize.
		const viewportBottomRow = viewportTop + height - 1;
		const contentBottomRow = Math.min(viewportBottomRow, Math.max(viewportTop, lines.length - 1));
		const parkUp = viewportBottomRow - contentBottomRow;
		if (parkUp > 0) buffer += `\x1b[${parkUp}A`;
		const { seq, toRow } = this.#cursorControlSequence(cursorPos, lines.length, contentBottomRow);
		buffer += seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);

		this.#maxLinesRendered = lines.length;
		this.#commit(lines, width, height, viewportTop, toRow);
	}

	/** Topmost visible overlay requests the alternate-screen buffer. */
	#wantsAltScreen(): boolean {
		for (let i = this.overlayStack.length - 1; i >= 0; i--) {
			const entry = this.overlayStack[i]!;
			if (!this.#isOverlayVisible(entry)) continue;
			return entry.options?.fullscreen === true;
		}
		return false;
	}

	/**
	 * Compose and paint a single fullscreen overlay frame on the alt buffer.
	 * Cursor markers are stripped (the modal draws its own in-band caret and
	 * keeps the hardware cursor hidden), and only the modal is composited over a
	 * blank base — the transcript is never touched while the alt buffer is up.
	 */
	#renderAltFrame(width: number, height: number): void {
		const base: string[] = new Array(Math.max(0, height)).fill("");
		let lines = this.#compositeOverlays(base, width, height);
		this.#extractCursorPosition(lines, height);
		lines = this.#prepareLines(lines, width, false);
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
		// Skip an identical repaint (the modal is mostly static between keystrokes).
		if (this.#altPreviousLines.length === height) {
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
	 * Foreground-stream live-region paint for ED3-risk terminals with an
	 * unobservable viewport. Commits the newly-sealed chunk to native scrollback
	 * (so finished blocks stay scrollable) and repaints the live tail in place,
	 * leaving the transient live region out of saved lines.
	 *
	 * Uses only the no-scroll-snap vocabulary of {@link #emitDiff}: relative
	 * cursor moves, per-row rewrite/suffix-clear, and `\r\n` to push the sealed
	 * chunk into history. It deliberately avoids a full-screen erase (`\x1b[2J`) and absolute
	 * cursor home (`\x1b[H`): on Ghostty those snap a reader scrolled into history
	 * back to the bottom on every frame.
	 */
	#emitLiveRegionPinnedRepaint(
		lines: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		appendFrom: number,
		appendTo: number,
		renderViewportTop: number,
		prevViewportTop: number,
		prevHardwareCursorRow: number,
	): void {
		this.#fullRedrawCount += 1;
		const naturalViewportTop = Math.max(0, lines.length - height);
		const viewportTop = Math.max(0, Math.min(renderViewportTop, lines.length));
		const boundedAppendTo = Math.max(0, Math.min(appendTo, naturalViewportTop, lines.length));
		const boundedAppendFrom = Math.max(0, Math.min(appendFrom, boundedAppendTo));

		if (boundedAppendFrom === boundedAppendTo && viewportTop === prevViewportTop) {
			let firstChangedScreenRow = -1;
			let lastChangedScreenRow = -1;
			for (let screenRow = 0; screenRow < height; screenRow++) {
				const nextLine = lines[viewportTop + screenRow] ?? "";
				const previousLine = this.#previousLines[prevViewportTop + screenRow] ?? "";
				if (nextLine === previousLine) continue;
				if (firstChangedScreenRow === -1) firstChangedScreenRow = screenRow;
				lastChangedScreenRow = screenRow;
			}

			let buffer = this.#paintBeginSequence;
			let cursorFromRow = prevHardwareCursorRow;
			if (firstChangedScreenRow !== -1) {
				const clampedCursor = Math.min(prevHardwareCursorRow, prevViewportTop + height - 1);
				const currentScreenRow = Math.max(0, Math.min(height - 1, clampedCursor - prevViewportTop));
				const rowDelta = firstChangedScreenRow - currentScreenRow;
				if (rowDelta > 0) buffer += `\x1b[${rowDelta}B`;
				else if (rowDelta < 0) buffer += `\x1b[${-rowDelta}A`;
				buffer += "\r";
				for (let screenRow = firstChangedScreenRow; screenRow <= lastChangedScreenRow; screenRow++) {
					if (screenRow > firstChangedScreenRow) buffer += "\r\n";
					buffer += this.#lineRewriteSequence(lines[viewportTop + screenRow] ?? "", width);
				}
				cursorFromRow = viewportTop + lastChangedScreenRow;
			}
			const { seq, toRow } = this.#cursorControlSequence(cursorPos, lines.length, cursorFromRow);
			buffer += seq;
			buffer += this.#paintEndSequence;
			this.terminal.write(buffer);

			this.#maxLinesRendered = Math.max(lines.length, viewportTop + height);
			this.#commit(lines, width, height, viewportTop, toRow);
			return;
		}

		// Position at the top visible row with a relative move. Terminals clamp the
		// hardware cursor to the viewport on resize, so clamp our tracking to match
		// before computing the delta (mirrors #emitDiff).
		const clampedCursor = Math.min(prevHardwareCursorRow, prevViewportTop + height - 1);
		const currentScreenRow = Math.max(0, Math.min(height - 1, clampedCursor - prevViewportTop));
		let buffer = this.#paintBeginSequence;
		if (currentScreenRow > 0) buffer += `\x1b[${currentScreenRow}A`;
		buffer += "\r";

		// Write the sealed chunk followed by the full viewport from the top row.
		// The first (boundedAppendTo - boundedAppendFrom) rows scroll into native
		// history; the trailing `height` rows fill the viewport. Text rows overwrite
		// first and clear only the suffix so non-synchronized hosts do not visibly
		// blank stable content before repainting it.
		let wroteLine = false;
		for (let i = boundedAppendFrom; i < boundedAppendTo; i++) {
			if (wroteLine) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(lines[i] ?? "", width);
			wroteLine = true;
		}
		for (let screenRow = 0; screenRow < height; screenRow++) {
			if (wroteLine) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(lines[viewportTop + screenRow] ?? "", width);
			wroteLine = true;
		}

		const viewportBottomRow = viewportTop + height - 1;
		const contentBottomRow = Math.min(viewportBottomRow, Math.max(viewportTop, lines.length - 1));
		const parkUp = viewportBottomRow - contentBottomRow;
		if (parkUp > 0) buffer += `\x1b[${parkUp}A`;
		const { seq, toRow } = this.#cursorControlSequence(cursorPos, lines.length, contentBottomRow);
		buffer += seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);

		this.#maxLinesRendered = Math.max(lines.length, viewportTop + height);
		if (boundedAppendTo > this.#scrollbackHighWater) {
			this.#scrollbackHighWater = boundedAppendTo;
		}
		this.#commit(lines, width, height, viewportTop, toRow);
	}

	/**
	 * Push the appended tail into terminal scrollback by `\r\n`-ing past the
	 * previous viewport bottom. Used as a prefix to {@link #emitViewportRepaint}
	 * when an offscreen edit and an append land in the same frame; does not
	 * call {@link #commit} (the following repaint owns final state).
	 */
	#emitAppendTail(
		lines: string[],
		start: number,
		height: number,
		prevViewportTop: number,
		prevHardwareCursorRow: number,
	): void {
		if (start >= lines.length) return;
		let buffer = this.#paintBeginSequence;
		// Clamp tracked cursor to the visible viewport bottom — terminals clamp
		// on resize, so a prior frame may have committed a row that no longer
		// exists. Without this the scroll math points outside the viewport.
		const clampedCursor = Math.min(prevHardwareCursorRow, prevViewportTop + height - 1);
		const currentScreenRow = Math.max(0, Math.min(height - 1, clampedCursor - prevViewportTop));
		const moveToBottom = height - 1 - currentScreenRow;
		if (moveToBottom > 0) buffer += `\x1b[${moveToBottom}B`;
		for (let i = start; i < lines.length; i++) {
			buffer += "\r\n";
			buffer += this.#terminalLine(lines[i] ?? "");
		}
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
		const pushedNow = Math.max(0, lines.length - height);
		if (pushedNow > this.#scrollbackHighWater) {
			this.#scrollbackHighWater = pushedNow;
		}
	}

	/**
	 * Paint only the active-grid bottom row while a scrollback mutation remains
	 * deferred. If the native viewport is unknown and the user is scrolled up by a
	 * single line, every active-grid row except the bottom can still be visible in
	 * their scrollback window; touching only this row keeps that reader's viewport
	 * unchanged while allowing bottom-anchored live chrome (spinner/status tail) to
	 * advance for users at the tail.
	 */
	#emitDeferredTailRepaint(
		line: string,
		width: number,
		height: number,
		row: number,
		prevViewportTop: number,
		prevHardwareCursorRow: number,
	): void {
		const viewportBottom = prevViewportTop + height - 1;
		if (row !== viewportBottom) return;

		let buffer = this.#paintBeginSequence;
		const clampedCursor = Math.min(prevHardwareCursorRow, viewportBottom);
		const currentScreenRow = Math.max(0, Math.min(height - 1, clampedCursor - prevViewportTop));
		const moveDown = height - 1 - currentScreenRow;
		if (moveDown > 0) buffer += `\x1b[${moveDown}B`;
		buffer += `\r${this.#lineRewriteSequence(line, width)}\x1b[?25l`;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);

		this.#deferredTailLine = line;
		this.#previousWidth = width;
		this.#previousHeight = height;
		this.#viewportTopRow = prevViewportTop;
		this.#hardwareCursorRow = row;
	}

	/**
	 * Trailing-shrink: prior content shared a prefix with the new content; the
	 * extra rows below the new tail need to be cleared without scrolling. Falls
	 * back to {@link #emitViewportRepaint} when more rows must be cleared than
	 * fit on screen.
	 */
	#emitShrink(
		lines: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		prevHardwareCursorRow: number,
		prevViewportTop: number,
	): void {
		const extraLines = this.#previousLines.length - lines.length;
		if (extraLines <= 0) {
			this.#commit(lines, width, height, Math.max(0, lines.length - height), prevHardwareCursorRow);
			this.#maxLinesRendered = lines.length;
			return;
		}
		if (extraLines > height) {
			this.#emitViewportRepaint(lines, width, height, cursorPos);
			return;
		}

		const viewportTop = Math.max(0, this.#maxLinesRendered - height);
		const targetRow = Math.max(0, lines.length - 1);

		let buffer = this.#paintBeginSequence;

		const clampedCursor = Math.min(prevHardwareCursorRow, prevViewportTop + height - 1);
		const currentScreenRow = clampedCursor - prevViewportTop;
		const targetScreenRow = targetRow - viewportTop;
		const lineDiff = targetScreenRow - currentScreenRow;
		if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
		else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
		buffer += "\r";

		const clearStartOffset = lines.length > 0 ? 1 : 0;
		if (clearStartOffset > 0) {
			buffer += `\x1b[${clearStartOffset}B`;
		}
		for (let i = 0; i < extraLines; i++) {
			buffer += "\r\x1b[2K";
			if (i < extraLines - 1) buffer += "\x1b[1B";
		}
		const moveUp = extraLines - 1 + clearStartOffset;
		if (moveUp > 0) {
			buffer += `\x1b[${moveUp}A`;
		}

		const { seq, toRow } = this.#cursorControlSequence(cursorPos, lines.length, targetRow);
		buffer += seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);

		this.#maxLinesRendered = lines.length;
		this.#commit(lines, width, height, Math.max(0, lines.length - height), toRow);
	}

	/**
	 * Differential rewrite from `firstChanged` through `lastChanged`. Handles
	 * three sub-shapes: pure append below the prior viewport (scroll + write),
	 * in-place replace of visible rows, and replace-plus-trailing-shrink (clear
	 * extras after writing). Cursor math is local to this method.
	 */
	#emitDiff(
		lines: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		firstChanged: number,
		lastChanged: number,
		appendedLines: boolean,
		prevViewportTop: number,
		prevHardwareCursorRow: number,
	): void {
		let viewportTop = Math.max(0, this.#maxLinesRendered - height);
		let activeViewportTop = prevViewportTop;
		// Terminals clamp the hardware cursor to the visible viewport on resize.
		// If our tracked row is past the viewport bottom, the real cursor was
		// clamped; clamp our tracking to match so relative moves land correctly.
		let hardwareCursorRow = Math.min(prevHardwareCursorRow, activeViewportTop + height - 1);

		const appendStart = appendedLines && firstChanged === this.#previousLines.length && firstChanged > 0;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;

		let buffer = this.#paintBeginSequence;

		// Scroll-down branch: target row is past the bottom of the previous
		// viewport (a pure append). Emit `\r\n`s so the terminal pushes the
		// existing viewport into scrollback before we start writing.
		const prevViewportBottom = activeViewportTop + height - 1;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - activeViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) buffer += `\x1b[${moveToBottom}B`;
			const scroll = moveTargetRow - prevViewportBottom;
			buffer += "\r\n".repeat(scroll);
			activeViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Position cursor at the row we need to start writing from.
		const currentScreenRow = hardwareCursorRow - activeViewportTop;
		const targetScreenRow = moveTargetRow - viewportTop;
		const lineDiff = targetScreenRow - currentScreenRow;
		if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
		else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
		buffer += appendStart ? "\r\n" : "\r";

		// Repaint only firstChanged..lastChanged, not all rows to the end.
		// This bounds flicker for single-row updates (e.g. spinner ticks).
		const renderEnd = Math.min(lastChanged, lines.length - 1);
		// Optimize the in-place rewrite of a contiguous visible row range with
		// DECCARA. The rectangle coordinates are absolute screen rows, so two
		// effects that the relatively-positioned text absorbs transparently must
		// be folded into the coordinates explicitly:
		//   1. Writing rows past the viewport bottom scrolls the terminal, so the
		//      rewritten rows settle `scrollAmount` rows higher than where they
		//      were first painted. The rectangles must target the post-scroll rows.
		//   2. Rows pushed into history keep their full background padding (DECCARA
		//      cannot reach scrollback), so only rows that remain in the final
		//      viewport are shortened and repainted.
		// The append/scroll branch (`moveTargetRow > prevViewportBottom`) already
		// pushed rows into history and is excluded.
		const scrollAmount = Math.max(0, renderEnd - viewportTop - (height - 1));
		const fillViewportTop = viewportTop + scrollAmount;
		const fillStart = Math.max(firstChanged, fillViewportTop);
		let fillSequence = "";
		let fillTexts: string[] | null = null;
		if (
			this.#deccaraFillsEnabled() &&
			!appendStart &&
			moveTargetRow <= prevViewportBottom &&
			renderEnd >= fillStart
		) {
			const slice: string[] = new Array(renderEnd - fillStart + 1);
			for (let i = fillStart; i <= renderEnd; i++) {
				slice[i - fillStart] = lines[i] ?? "";
			}
			const plan = planDeccaraFills(slice, width, fillStart - fillViewportTop);
			fillTexts = plan.texts;
			fillSequence = plan.sequence;
		}
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(fillTexts && i >= fillStart ? fillTexts[i - fillStart] : lines[i], width);
		}

		// If the prior frame was taller, clear the trailing rows.
		let finalCursorRow = renderEnd;
		if (this.#previousLines.length > lines.length) {
			if (renderEnd < lines.length - 1) {
				const moveDown = lines.length - 1 - renderEnd;
				buffer += `\x1b[${moveDown}B`;
				finalCursorRow = lines.length - 1;
			}
			const extraLines = this.#previousLines.length - lines.length;
			for (let i = lines.length; i < this.#previousLines.length; i++) {
				buffer += "\r\n\x1b[2K";
			}
			buffer += `\x1b[${extraLines}A`;
		}
		// DECCARA rectangles for the rewritten visible fills. Absolute-positioned,
		// so emitting them after the trailing-shrink cursor moves is safe.
		buffer += fillSequence;

		const { seq, toRow } = this.#cursorControlSequence(cursorPos, lines.length, finalCursorRow);
		buffer += seq;
		buffer += this.#paintEndSequence;

		this.#writeDiffDebug(
			lines,
			firstChanged,
			viewportTop,
			height,
			lineDiff,
			hardwareCursorRow,
			renderEnd,
			finalCursorRow,
			cursorPos,
			toRow,
			buffer,
		);
		this.terminal.write(buffer);

		this.#maxLinesRendered = lines.length;
		if (lines.length > this.#previousLines.length) {
			const pushedNow = Math.max(0, lines.length - height);
			if (pushedNow > this.#scrollbackHighWater) {
				this.#scrollbackHighWater = pushedNow;
			}
		}
		this.#commit(lines, width, height, Math.max(0, lines.length - height), toRow);
	}

	/** Optional intent log under PI_DEBUG_REDRAW. */
	#logRedraw(intent: RenderIntent, newLength: number, height: number): void {
		if (!$flag("PI_DEBUG_REDRAW")) return;
		const detail =
			intent.kind === "diff"
				? `${intent.kind}(first=${intent.firstChanged}, last=${intent.lastChanged}, appended=${intent.appendedLines})`
				: intent.kind === "liveRegionPinned"
					? `${intent.kind}(append=${intent.appendFrom}..${intent.appendTo}, viewportTop=${intent.renderViewportTop})`
					: intent.kind === "viewportRepaint" && intent.appendFrom !== undefined
						? `${intent.kind}(appendFrom=${intent.appendFrom})`
						: intent.kind === "deferredTailRepaint"
							? `${intent.kind}(row=${intent.row})`
							: intent.kind;
		const state =
			`shw=${this.#scrollbackHighWater}, max=${this.#maxLinesRendered}, vpTop=${this.#viewportTopRow}, ` +
			`dirty=${this.#nativeScrollbackDirty}, eager=${this.#eagerNativeScrollbackRebuild}, ` +
			`lrStart=${this.#nativeScrollbackLiveRegionStart}, commitSafeEnd=${this.#nativeScrollbackCommitSafeEnd}`;
		const msg = `[${new Date().toISOString()}] render: ${detail} (prev=${this.#previousLines.length}, new=${newLength}, height=${height}, ${state})\n`;
		fs.appendFileSync(getDebugLogPath(), msg);
	}

	/** Optional per-render dump under PI_TUI_DEBUG; isolated so #emitDiff stays readable. */
	#writeDiffDebug(
		lines: string[],
		firstChanged: number,
		viewportTop: number,
		height: number,
		lineDiff: number,
		hardwareCursorRow: number,
		renderEnd: number,
		finalCursorRow: number,
		cursorPos: { row: number; col: number } | null,
		toRow: number,
		buffer: string,
	): void {
		if (!$flag("PI_TUI_DEBUG")) return;
		const debugDir = "/tmp/tui";
		fs.mkdirSync(debugDir, { recursive: true });
		const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
		const debugData = [
			`firstChanged: ${firstChanged}`,
			`viewportTop: ${viewportTop}`,
			`cursorRow: ${this.#cursorRow}`,
			`height: ${height}`,
			`lineDiff: ${lineDiff}`,
			`hardwareCursorRow: ${hardwareCursorRow}`,
			`hardwareCursorRow (post): ${toRow}`,
			`renderEnd: ${renderEnd}`,
			`finalCursorRow: ${finalCursorRow}`,
			`cursorPos: ${JSON.stringify(cursorPos)}`,
			`newLines.length: ${lines.length}`,
			`previousLines.length: ${this.#previousLines.length}`,
			"",
			"=== newLines ===",
			JSON.stringify(lines, null, 2),
			"",
			"=== previousLines ===",
			JSON.stringify(this.#previousLines, null, 2),
			"",
			"=== buffer ===",
			JSON.stringify(buffer),
		].join("\n");
		fs.writeFileSync(debugPath, debugData);
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
	): { seq: string; toRow: number } {
		// No IME target or no content — hide cursor regardless of preference
		if (!cursorPos || totalLines <= 0) return { seq: "\x1b[?25l", toRow: fromRow };

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - fromRow;
		let seq = "";
		if (rowDelta > 0) {
			seq += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			seq += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		seq += `\x1b[${targetCol + 1}G`;
		seq += this.#showHardwareCursor ? "\x1b[?25h" : "\x1b[?25l";

		return { seq, toRow: targetRow };
	}

	/**
	 * Write the hardware cursor position to the terminal as a standalone
	 * synchronized output block. Use when there is no surrounding render buffer
	 * to embed the sequences into.
	 */
	#writeCursorPosition(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}
		const { seq, toRow } = this.#cursorControlSequence(cursorPos, totalLines, this.#hardwareCursorRow);
		this.#hardwareCursorRow = toRow;
		this.terminal.write(`${this.#cursorBeginSequence}${seq}${this.#cursorEndSequence}`);
	}
}
