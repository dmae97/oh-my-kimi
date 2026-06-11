import {
	getImageDimensions,
	type ImageDimensions,
	imageFallback,
	renderImage,
	TERMINAL,
} from "../terminal-capabilities";
import type { Component } from "../tui";

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	/** Shared budget that caps how many inline images render as live graphics. */
	budget?: ImageBudget;
	/**
	 * Stable identity for the underlying image (e.g. `toolCallId:index`). Lets the
	 * budget hand back the same graphics id across component re-creations so a
	 * repaint replaces the placement instead of stacking a duplicate.
	 */
	imageKey?: string;
}

const EMPTY_IDS: readonly number[] = [];
const EMPTY_TRANSMITS: readonly string[] = [];
// Direct placements reserve height with leading zero-width rows. Keep them
// non-plain so transcript blank-edge trimming does not collapse image-only blocks.
const RESERVED_IMAGE_ROW = "\x1b[0m";

/** Default count of inline images kept as live graphics before older ones fall back to text. */
export const DEFAULT_MAX_INLINE_IMAGES = 8;

/**
 * Bounds how many inline images render as live terminal graphics at once.
 *
 * Terminal graphics protocols — Kitty especially — keep every transmitted image
 * in a per-terminal store and re-draw placements as content scrolls; text-clear
 * escapes (`CSI 2 J` / `CSI 3 J`) do not remove them. Unbounded, a session that
 * shows many images piles up placements plus store memory and leaves ghosts in
 * scrollback.
 *
 * The budget keeps the most recent `cap` images live and demotes older ones to
 * their text fallback. Demotion needs a full redraw (so off-screen rows are
 * rewritten) plus an explicit graphics purge of the demoted ids — {@link Image}
 * reports display order via {@link observe}, and the TUI drives the purge +
 * redraw on the frame after a new image pushes the count past the cap.
 *
 * `cap <= 0` disables budgeting: every image stays a live graphic.
 */
export class ImageBudget {
	#cap: number;
	#requestRender: () => void;
	#nextId = 1;
	#keyToId = new Map<string, number>();
	/** Display-order image ids observed during the in-flight pass. */
	#passIds: number[] = [];
	/**
	 * Suppress threshold reflected in the frame currently on the terminal: images
	 * at display indices `[0, #onTerminal)` are shown as text there.
	 */
	#onTerminal = 0;
	/** Suppress threshold the current/next render should apply. */
	#planned = 0;
	/**
	 * True while the in-flight pass applies a stricter threshold than the terminal
	 * shows — the demotion frame that must purge graphics and fully repaint.
	 */
	#applyingReset = false;
	#lastTotal = 0;
	#purgeIds: number[] = [];
	/** Image ids whose data is believed to be loaded in the terminal's store. */
	#transmitted = new Set<number>();
	/** Transmit sequences (full base64) to write once, before this frame's placements. */
	#pendingTransmits: string[] = [];

	constructor(cap: number = DEFAULT_MAX_INLINE_IMAGES, requestRender: () => void = () => {}) {
		this.#cap = normalizeCap(cap);
		this.#requestRender = requestRender;
	}

	get cap(): number {
		return this.#cap;
	}

	get enabled(): boolean {
		return this.#cap > 0;
	}

	setRequestRender(requestRender: () => void): void {
		this.#requestRender = requestRender;
	}

	setCap(cap: number): void {
		const next = normalizeCap(cap);
		if (next === this.#cap) return;
		this.#cap = next;
		this.#reconcile(this.#lastTotal);
	}

	/**
	 * Stable graphics id for a logical image. A non-empty `key` maps to the same
	 * id across re-creations (so repaints replace the placement); a missing key
	 * gets a fresh id every call.
	 */
	acquireId(key?: string): number {
		if (key) {
			const existing = this.#keyToId.get(key);
			if (existing !== undefined) return existing;
			const id = this.#nextId++;
			this.#keyToId.set(key, id);
			return id;
		}
		return this.#nextId++;
	}

	/** Begin a render pass. Called by the renderer before composing the frame. */
	beginPass(): void {
		this.#passIds.length = 0;
		this.#applyingReset = this.#cap > 0 && this.#planned > this.#onTerminal;
	}

	/**
	 * Record an image in display order and report whether it must render its text
	 * fallback this frame. Called by every {@link Image} during render — including
	 * on a cache hit, so the image keeps its display-order slot.
	 */
	observe(imageId: number): boolean {
		const index = this.#passIds.length;
		this.#passIds.push(imageId);
		return this.#cap > 0 && index < this.#planned;
	}

	/**
	 * End a render pass. Returns true when this frame must purge graphics and
	 * fully repaint to apply a stricter budget; read the ids via
	 * {@link takePurgeIds}.
	 */
	endPass(): boolean {
		const total = this.#passIds.length;
		this.#lastTotal = total;
		let reset = false;
		if (this.#applyingReset) {
			for (let i = this.#onTerminal; i < this.#planned && i < total; i++) {
				const id = this.#passIds[i];
				this.#purgeIds.push(id);
				// d=I frees the data too, so the image must re-transmit if it returns.
				this.#transmitted.delete(id);
			}
			this.#onTerminal = this.#planned;
			this.#applyingReset = false;
			reset = true;
		}
		this.#reconcile(total);
		return reset;
	}

	/** Image ids to delete from the terminal this frame; clears the pending set. */
	takePurgeIds(): readonly number[] {
		if (this.#purgeIds.length === 0) return EMPTY_IDS;
		const ids = this.#purgeIds;
		this.#purgeIds = [];
		return ids;
	}

	/** All image ids believed to be loaded in the terminal store; clears tracking. */
	takeAllTransmittedIds(): readonly number[] {
		if (this.#transmitted.size === 0) return EMPTY_IDS;
		const ids = [...this.#transmitted];
		this.#transmitted.clear();
		this.#purgeIds = [];
		this.#pendingTransmits = [];
		return ids;
	}

	/** Whether `imageId`'s data still needs to be transmitted to the terminal. */
	shouldTransmit(imageId: number): boolean {
		return !this.#transmitted.has(imageId);
	}

	/**
	 * Queue a one-time transmit for `imageId`. No-op if already transmitted, so a
	 * repeated call (e.g. a width-change re-render) never re-sends the data.
	 */
	enqueueTransmit(imageId: number, sequence: string): void {
		if (this.#transmitted.has(imageId)) return;
		this.#transmitted.add(imageId);
		this.#pendingTransmits.push(sequence);
	}

	/** Whether a frame has image data queued but not yet written to the terminal. */
	hasPendingTransmits(): boolean {
		return this.#pendingTransmits.length > 0;
	}

	/**
	 * True when the budget has nothing in flight: no live images observed on
	 * the last pass, no queued transmits, no pending purges, and no stricter
	 * threshold left to apply. A component-scoped frame may skip the observe
	 * pass only then — a partial tree walk would under-count display order.
	 */
	get quiescent(): boolean {
		return (
			this.#lastTotal === 0 &&
			this.#pendingTransmits.length === 0 &&
			this.#purgeIds.length === 0 &&
			this.#planned === this.#onTerminal
		);
	}

	/** Transmit sequences to write before this frame's placements; clears the queue. */
	takeTransmits(): readonly string[] {
		if (this.#pendingTransmits.length === 0) return EMPTY_TRANSMITS;
		const sequences = this.#pendingTransmits;
		this.#pendingTransmits = [];
		return sequences;
	}

	#reconcile(total: number): void {
		const desired = this.#cap > 0 ? Math.max(0, total - this.#cap) : 0;
		if (desired === this.#planned) {
			// Budget relaxed without a stricter frame (cap raised or images
			// removed): surviving graphics are untouched and re-exposed rows
			// repaint normally, so just track the looser threshold.
			if (this.#planned < this.#onTerminal) this.#onTerminal = this.#planned;
			return;
		}
		this.#planned = desired;
		// More images must be demoted than the terminal shows: schedule the purge +
		// full-redraw frame. Fewer: no ghosts to clear, so just catch the tracking
		// up — a normal repaint re-exposes the un-demoted images. Either way a
		// render is needed to apply the new threshold.
		if (desired <= this.#onTerminal) this.#onTerminal = desired;
		this.#requestRender();
	}
}

function normalizeCap(cap: number): number {
	if (!Number.isFinite(cap)) return 0;
	return Math.max(0, Math.trunc(cap));
}

export class Image implements Component {
	#base64Data: string;
	#mimeType: string;
	#dimensions: ImageDimensions;
	#theme: ImageTheme;
	#options: ImageOptions;
	#budget?: ImageBudget;
	#imageId?: number;

	#cachedLines?: string[];
	#cachedWidth?: number;
	#cachedSuppressed = false;
	// Tallest graphic placement this image has rendered. The text fallback
	// pads itself to this height so a budget demotion never shrinks the block
	// (its rows may already be committed to native scrollback).
	#renderedGraphicRows = 0;

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.#base64Data = base64Data;
		this.#mimeType = mimeType;
		this.#theme = theme;
		this.#options = options;
		this.#dimensions = dimensions || getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
		this.#budget = options.budget;
		this.#imageId = options.budget ? options.budget.acquireId(options.imageKey) : undefined;
	}

	invalidate(): void {
		this.#cachedLines = undefined;
		this.#cachedWidth = undefined;
	}

	render(width: number): readonly string[] {
		const hasProtocol = TERMINAL.imageProtocol != null;
		// observe() must run on every pass — even a cache hit — so the image keeps
		// its display-order slot in the budget. Only graphics-capable frames count
		// toward (and are demoted by) the budget; without a protocol every image is
		// already text.
		const suppressed = hasProtocol && this.#budget !== undefined ? this.#budget.observe(this.#imageId ?? 0) : false;

		if (this.#cachedLines && this.#cachedWidth === width && this.#cachedSuppressed === suppressed) {
			return this.#cachedLines;
		}

		const cap = this.#options.maxWidthCells;
		const maxWidth = cap != null && cap > 0 ? Math.min(width - 2, cap) : width - 2;

		let lines: string[];

		if (hasProtocol && !suppressed) {
			// Transmit the data once (keyed by id); thereafter renderImage returns
			// just the placement, so repaints never re-send the base64.
			const needsTransmit = this.#imageId != null && (this.#budget?.shouldTransmit(this.#imageId) ?? false);
			const result = renderImage(this.#base64Data, this.#dimensions, {
				maxWidthCells: maxWidth,
				maxHeightCells: this.#options.maxHeightCells,
				imageId: this.#imageId,
				includeTransmit: needsTransmit,
			});

			if (result?.transmit && this.#imageId != null && this.#budget !== undefined) {
				this.#budget.enqueueTransmit(this.#imageId, result.transmit);
			}

			if (result?.lines) {
				// Unicode placeholders: the image is already a block of real text-cell
				// lines (line 0 carries the virtual-placement APC). No cursor moves.
				lines = result.lines;
			} else if (result) {
				// Direct placement: return `rows` lines so TUI accounts for image
				// height. First (rows-1) lines are empty (TUI clears them); the last
				// moves the cursor back up, then emits the image sequence.
				lines = [];
				for (let i = 0; i < result.rows - 1; i++) {
					lines.push(RESERVED_IMAGE_ROW);
				}
				const moveUp = result.rows > 1 ? `\x1b[${result.rows - 1}A` : "";
				lines.push(moveUp + (result.sequence ?? ""));
			} else {
				lines = this.#fallbackLines();
			}
			this.#renderedGraphicRows = Math.max(this.#renderedGraphicRows, lines.length);
		} else {
			lines = this.#fallbackLines();
		}

		this.#cachedLines = lines;
		this.#cachedWidth = width;
		this.#cachedSuppressed = suppressed;

		return lines;
	}

	/**
	 * Text fallback, height-preserving once a graphic has rendered: a demoted
	 * image must keep occupying the rows its placement used, because those
	 * rows may already be committed to native scrollback — shrinking the block
	 * would shift everything below it and force the renderer's commit-resync
	 * (stale band + recommit). Reserved rows stay non-plain so blank-edge
	 * trimming cannot collapse the block either.
	 */
	#fallbackLines(): string[] {
		const fallback = this.#theme.fallbackColor(
			imageFallback(this.#mimeType, this.#dimensions, this.#options.filename),
		);
		if (this.#renderedGraphicRows <= 1) return [fallback];
		const lines: string[] = [];
		for (let i = 0; i < this.#renderedGraphicRows - 1; i++) {
			lines.push(RESERVED_IMAGE_ROW);
		}
		lines.push(fallback);
		return lines;
	}
}
