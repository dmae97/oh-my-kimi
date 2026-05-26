/**
 * Minimal TUI implementation with differential rendering
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { $flag, getDebugLogPath } from "@oh-my-pi/pi-utils";
import { isKeyRelease, matchesKey } from "./keys";
import type { Terminal } from "./terminal";
import { ImageProtocol, setCellDimensions, setTerminalImageProtocol, TERMINAL } from "./terminal-capabilities";
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
 * Per-line terminator written at the end of every non-image line. Closes both
 * SGR state and any in-flight OSC 8 hyperlink so styles/links cannot bleed
 * across lines in scrollback. Applied by {@link TUI.#applyLineResets} before
 * diffing so `#previousLines` mirrors what was actually written.
 */
const LINE_TERMINATOR = "\x1b[0m\x1b]8;;\x07";

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;

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
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;
}

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
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

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
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

	render(width: number): string[] {
		width = Math.max(1, width);
		const lines: string[] = [];
		for (const child of this.children) {
			lines.push(...child.render(width));
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
 * - `historyRebuild`: width changed and offscreen rows changed — clear viewport
 *   and scrollback so terminal history rewraps at the new width.
 * - `viewportRepaint`: rewrite the visible viewport in place. If `appendFrom`
 *   is set, emit those tail rows as scrollback growth first so streaming
 *   output reaches terminal history before the corrected viewport is drawn.
 * - `shrink`: trailing rows were dropped — clear extras inline.
 * - `diff`: differential repaint of visible rows / append new rows below.
 */
type RenderIntent =
	| { kind: "noop" }
	| { kind: "initial" }
	| { kind: "sessionReplace" }
	| { kind: "historyRebuild" }
	| { kind: "viewportRepaint"; appendFrom?: number }
	| { kind: "shrink" }
	| { kind: "diff"; firstChanged: number; lastChanged: number; appendedLines: boolean };

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

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	onDebug?: () => void;
	#renderRequested = false;
	#renderTimer: NodeJS.Timeout | undefined;
	#lastRenderAt = 0;
	static readonly #MIN_RENDER_INTERVAL_MS = 16;
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
	#maxLinesRendered = 0; // Line count from last render, used for viewport calculation
	#fullRedrawCount = 0;
	#clearScrollbackOnNextRender = false;
	#hasEverRendered = false;
	#stopped = false;

	// Overlay stack for modal components rendered on top of base content
	overlayStack: {
		component: Component;
		options?: OverlayOptions;
		preFocus: Component | null;
		hidden: boolean;
	}[] = [];

	constructor(terminal: Terminal, showHardwareCursor?: boolean) {
		super();
		this.terminal = terminal;
		if (showHardwareCursor !== undefined) {
			this.#showHardwareCursor = showHardwareCursor;
		}
	}

	get fullRedraws(): number {
		return this.#fullRedrawCount;
	}

	getShowHardwareCursor(): boolean {
		return this.#showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.#showHardwareCursor === enabled) return;
		this.#showHardwareCursor = enabled;
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

	setFocus(component: Component | null): void {
		// Clear focused flag on old component
		if (isFocusable(this.#focusedComponent)) {
			this.#focusedComponent.focused = false;
		}

		this.#focusedComponent = component;

		// Set focused flag on new component
		if (isFocusable(component)) {
			component.focused = true;
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

	override invalidate(): void {
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start(): void {
		this.#stopped = false;
		this.terminal.start(
			data => this.#handleInput(data),
			() => this.requestRender(),
		);
		this.terminal.hideCursor();
		this.#querySixelSupport();
		this.#queryCellSize();
		this.requestRender(true);
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

	stop(): void {
		this.#clearSixelProbeState();
		this.#stopped = true;
		if (this.#renderTimer) {
			clearTimeout(this.#renderTimer);
			this.#renderTimer = undefined;
		}
		// Move cursor to the end of the content to prevent overwriting/artifacts on exit
		if (this.#previousLines.length > 0) {
			const targetRow = this.#previousLines.length; // Line after the last content
			const lineDiff = targetRow - this.#hardwareCursorRow;
			if (lineDiff > 0) {
				this.terminal.write(`\x1b[${lineDiff}B`);
			} else if (lineDiff < 0) {
				this.terminal.write(`\x1b[${-lineDiff}A`);
			}
			this.terminal.write("\r\n");
		}

		this.terminal.showCursor();
		this.terminal.stop();
	}

	requestRender(force = false, options?: RenderRequestOptions): void {
		if (force) {
			this.#clearScrollbackOnNextRender ||= options?.clearScrollback === true;
			this.#previousLines = [];
			this.#previousWidth = -1; // -1 triggers widthChanged, forcing a full clear
			this.#previousHeight = -1; // -1 triggers heightChanged, forcing a full clear
			this.#cursorRow = 0;
			this.#hardwareCursorRow = 0;
			this.#viewportTopRow = 0;
			this.#maxLinesRendered = 0;
			if (this.#renderTimer) {
				clearTimeout(this.#renderTimer);
				this.#renderTimer = undefined;
			}
			this.#renderRequested = true;
			process.nextTick(() => {
				if (this.#stopped || !this.#renderRequested) {
					return;
				}
				this.#renderRequested = false;
				this.#lastRenderAt = performance.now();
				this.#doRender();
			});
			return;
		}
		if (this.#renderRequested) return;
		this.#renderRequested = true;
		process.nextTick(() => this.#scheduleRender());
	}

	#scheduleRender(): void {
		if (this.#stopped || this.#renderTimer || !this.#renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.#lastRenderAt;
		const delay = Math.max(0, TUI.#MIN_RENDER_INTERVAL_MS - elapsed);
		this.#renderTimer = setTimeout(() => {
			this.#renderTimer = undefined;
			if (this.#stopped || !this.#renderRequested) {
				return;
			}
			this.#renderRequested = false;
			this.#lastRenderAt = performance.now();
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
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// Strip marker from the line
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	/**
	 * Append the per-line terminator ({@link LINE_TERMINATOR}) to every
	 * non-image line and normalize for terminal rendering. Mutates the input
	 * array in place so downstream diffing/storage sees exactly the bytes
	 * written to the terminal — without this, the diff cache disagrees with
	 * emitted output and OSC 8 hyperlink state can leak across lines.
	 */
	#applyLineResets(lines: string[]): string[] {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (TERMINAL.isImageLine(line)) continue;
			const normalized = normalizeTerminalOutput(line);
			// Only close OSC 8 hyperlinks when the line actually opened one;
			// emitting `\x1b]8;;\x07` on every line just feeds the terminal's OSC
			// parser for no reason (measurable cost in xterm.js parse loop).
			lines[i] = normalized + (normalized.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET);
		}
		return lines;
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

		// 1. Compose the frame.
		let lines = this.render(width);
		if (this.overlayStack.length > 0) {
			lines = this.#compositeOverlays(lines, width, height);
		}
		const cursorPos = this.#extractCursorPosition(lines, height);
		lines = this.#applyLineResets(lines);

		// 2. Capture transition + pre-render state before any emitter runs.
		const prevViewportTop = this.#viewportTopRow;
		const prevHardwareCursorRow = this.#hardwareCursorRow;
		const widthChanged = this.#previousWidth > 0 && this.#previousWidth !== width;
		const heightChanged = this.#previousHeight > 0 && this.#previousHeight !== height;

		// 3. Classify intent.
		const intent = this.#planRender(lines, widthChanged, heightChanged, prevViewportTop);
		this.#logRedraw(intent, lines.length, height);

		// 4. Execute.
		switch (intent.kind) {
			case "noop":
				this.#writeCursorPosition(cursorPos, lines.length);
				this.#viewportTopRow = Math.max(0, this.#maxLinesRendered - height);
				this.#previousWidth = width;
				this.#previousHeight = height;
				return;
			case "initial":
				this.#emitFullPaint(lines, width, height, cursorPos, { clearViewport: true, clearScrollback: false });
				this.#hasEverRendered = true;
				return;
			case "sessionReplace":
				this.#clearScrollbackOnNextRender = false;
				this.#emitFullPaint(lines, width, height, cursorPos, {
					clearViewport: true,
					clearScrollback: !isMultiplexerSession(),
				});
				return;
			case "historyRebuild":
				this.#emitFullPaint(lines, width, height, cursorPos, {
					clearViewport: true,
					clearScrollback: !isMultiplexerSession(),
				});
				return;
			case "viewportRepaint":
				if (intent.appendFrom !== undefined) {
					this.#emitAppendTail(lines, intent.appendFrom, height, prevViewportTop, prevHardwareCursorRow);
				}
				this.#emitViewportRepaint(lines, width, height, cursorPos);
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
	 * resets and session replacement short-circuit before any diff work, and
	 * width-changed-with-offscreen edits route to {@link "historyRebuild"} so
	 * terminal scrollback receives the new geometry.
	 */
	#planRender(
		newLines: string[],
		widthChanged: boolean,
		heightChanged: boolean,
		prevViewportTop: number,
	): RenderIntent {
		// Initial paint after start(): scrollback must keep its prior shell
		// content, but the viewport must be cleared so stale rows do not bleed
		// into the new UI.
		if (!this.#hasEverRendered) return { kind: "initial" };

		// Caller opted into a scrollback wipe via requestRender(true, { clearScrollback: true }).
		if (this.#clearScrollbackOnNextRender) return { kind: "sessionReplace" };

		// Forced reset (requestRender(true)) without scrollback wipe: previous
		// lines were dropped, so no diff is possible. Repaint visible rows only
		// — emitting the transcript here would duplicate it into scrollback.
		if (this.#previousLines.length === 0) return { kind: "viewportRepaint" };

		const diff = this.#diffLines(newLines);

		if (diff.firstChanged === -1) {
			// Content unchanged. Width change still alters wrapping geometry;
			// height change shifts the visible window. Either needs a repaint
			// (outside hostile environments).
			if (widthChanged) return { kind: "viewportRepaint" };
			if (heightChanged && !isTermuxSession() && !isMultiplexerSession()) return { kind: "viewportRepaint" };
			return { kind: "noop" };
		}

		// Width changes alter wrapping for the whole transcript. Offscreen
		// edits need a history rebuild so terminal scrollback receives the
		// new geometry; pure appends fall through to the diff path so the
		// append handler scrolls them into scrollback correctly.
		if (widthChanged) {
			if (diff.firstChanged < prevViewportTop) return { kind: "historyRebuild" };
			const pureAppend = diff.appendedLines && diff.firstChanged === this.#previousLines.length;
			if (!pureAppend) return { kind: "viewportRepaint" };
		}

		const contentGrew = newLines.length > this.#previousLines.length;

		// Height changes shift the visible window. Repaint when content didn't
		// grow, but skip in Termux (software keyboard toggles height) and inside
		// multiplexers (panes manage their own redraws).
		if (heightChanged && !contentGrew && !isTermuxSession() && !isMultiplexerSession()) {
			return { kind: "viewportRepaint" };
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

		// Offscreen edit: viewport repaint corrects the shifted rows. If new
		// rows also appended in the same frame, emit them as scrollback growth
		// first so streaming output is not lost from terminal history.
		if (diff.firstChanged < prevViewportTop) {
			const appendFrom = diff.appendedLines ? this.#findAppendedTailStart(newLines) : undefined;
			return { kind: "viewportRepaint", appendFrom };
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

	/**
	 * Truncate a line to the visible viewport width. Image lines are left
	 * alone, narrow lines pass through unchanged. Truncation re-appends the
	 * per-line terminator so SGR/OSC 8 state does not leak across rows when
	 * `truncateToWidth` drops the trailing bytes appended by
	 * {@link #applyLineResets}.
	 */
	#fitLineToWidth(line: string, width: number): string {
		if (TERMINAL.isImageLine(line)) return line;
		if (visibleWidth(line) <= width) return line;
		const truncated = truncateToWidth(line, width, Ellipsis.Omit);
		return truncated + (truncated.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET);
	}

	/**
	 * Single state-transition point. Every emitter calls this exactly once at
	 * the end so cursor/viewport/scrollback accounting stays consistent.
	 */
	#commit(lines: string[], width: number, height: number, viewportTop: number, hardwareCursorRow: number): void {
		this.#previousLines = lines;
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
		let buffer = "\x1b[?2026h";
		if (options.clearViewport) {
			buffer += options.clearScrollback ? "\x1b[2J\x1b[H\x1b[3J" : "\x1b[2J\x1b[H";
		}
		for (let i = 0; i < lines.length; i++) {
			if (i > 0) buffer += "\r\n";
			buffer += lines[i];
		}
		const finalRow = Math.max(0, lines.length - 1);
		const { seq, toRow } = this.#cursorControlSequence(cursorPos, lines.length, finalRow);
		buffer += seq;
		buffer += "\x1b[?2026l";
		this.terminal.write(buffer);

		this.#maxLinesRendered = options.clearViewport ? lines.length : Math.max(this.#maxLinesRendered, lines.length);
		this.#commit(lines, width, height, Math.max(0, this.#maxLinesRendered - height), toRow);
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
		const viewportTop = Math.max(0, lines.length - height);
		let buffer = "\x1b[?2026h\x1b[H";
		for (let screenRow = 0; screenRow < height; screenRow++) {
			if (screenRow > 0) buffer += "\r\n";
			buffer += "\x1b[2K";
			const line = lines[viewportTop + screenRow] ?? "";
			buffer += this.#fitLineToWidth(line, width);
		}
		const finalRow = Math.min(Math.max(0, lines.length - 1), viewportTop + height - 1);
		const { seq, toRow } = this.#cursorControlSequence(cursorPos, lines.length, finalRow);
		buffer += seq;
		buffer += "\x1b[?2026l";
		this.terminal.write(buffer);

		this.#maxLinesRendered = lines.length;
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
		let buffer = "\x1b[?2026h";
		// Clamp tracked cursor to the visible viewport bottom — terminals clamp
		// on resize, so a prior frame may have committed a row that no longer
		// exists. Without this the scroll math points outside the viewport.
		const clampedCursor = Math.min(prevHardwareCursorRow, prevViewportTop + height - 1);
		const currentScreenRow = Math.max(0, Math.min(height - 1, clampedCursor - prevViewportTop));
		const moveToBottom = height - 1 - currentScreenRow;
		if (moveToBottom > 0) buffer += `\x1b[${moveToBottom}B`;
		for (let i = start; i < lines.length; i++) {
			buffer += "\r\n";
			buffer += lines[i];
		}
		buffer += "\x1b[?2026l";
		this.terminal.write(buffer);
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

		let buffer = "\x1b[?2026h";

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
		buffer += "\x1b[?2026l";
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

		let buffer = "\x1b[?2026h";

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
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += "\x1b[2K";
			buffer += this.#fitLineToWidth(lines[i], width);
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

		const { seq, toRow } = this.#cursorControlSequence(cursorPos, lines.length, finalCursorRow);
		buffer += seq;
		buffer += "\x1b[?2026l";

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
		this.#commit(lines, width, height, Math.max(0, lines.length - height), toRow);
	}

	/** Optional intent log under PI_DEBUG_REDRAW. */
	#logRedraw(intent: RenderIntent, newLength: number, height: number): void {
		if (!$flag("PI_DEBUG_REDRAW")) return;
		const detail =
			intent.kind === "diff"
				? `${intent.kind}(first=${intent.firstChanged}, last=${intent.lastChanged}, appended=${intent.appendedLines})`
				: intent.kind === "viewportRepaint" && intent.appendFrom !== undefined
					? `${intent.kind}(appendFrom=${intent.appendFrom})`
					: intent.kind;
		const msg = `[${new Date().toISOString()}] render: ${detail} (prev=${this.#previousLines.length}, new=${newLength}, height=${height})\n`;
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
		this.terminal.write(`\x1b[?2026h${seq}\x1b[?2026l`);
	}
}
