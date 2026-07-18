import {
	type Component,
	Container,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackLiveRegion,
	type RenderStablePrefix,
	type ViewportTailProvider,
} from "@oh-my-pi/pi-tui";

/**
 * A transcript block that is still mutating (a foreground tool awaiting its
 * result, an assistant message mid-stream) reports `false` so the container
 * keeps it inside the live (repaintable) region instead of freezing it. Blocks
 * without the method are treated as finalized — the default, stable behavior.
 */
interface FinalizableBlock {
	isTranscriptBlockFinalized?(): boolean;
	/**
	 * Monotonic content version for blocks that can still mutate *after*
	 * reporting finalized (e.g. `AssistantMessageComponent`: the inline error
	 * restored at the next turn's `agent_start`, late tool-result images). The
	 * committed-scrollback render bypass only replays a block's previous rows
	 * when the version is unchanged; without this signal a post-finalize
	 * mutation would stay invisible until a global invalidation. Blocks that
	 * never mutate post-finalize simply omit the method.
	 */
	getTranscriptBlockVersion?(): number;
	/**
	 * Leading rows of the block's current render() output that are declared
	 * FINAL while the block is still live: byte-stable at the current width
	 * until the block finalizes, monotone non-decreasing under streaming
	 * growth, re-derived per render (the container reads it right after
	 * calling render()). The container extends the native-scrollback commit
	 * boundary through these rows so a long streaming reply's scrolled-off
	 * head reaches terminal history mid-stream. Declaring a row that later
	 * changes strands a stale copy in immutable history (the engine audit
	 * repairs by recommitting below — duplication, never loss), so
	 * implementers report only rows whose bytes provably cannot change (e.g.
	 * rendered output of markdown's frozen token prefix). Absent = 0: nothing
	 * commits until the block finalizes.
	 */
	getTranscriptBlockSettledRows?(): number;
	/**
	 * Whether the block is a displaceable snapshot (todo/poll card) kept
	 * unfinalized only so a follow-up matching call can retract it. Paired
	 * with {@link seal}: once any of its rows enters native scrollback the
	 * container seals it — rows on the tape are immutable, so retraction is
	 * no longer possible, and an unfinalized block would otherwise pin the
	 * live-region seam open for the rest of the turn (every row committed
	 * below it audit-exempt, mass-recommitted when it finally finalizes).
	 */
	isDisplaceableBlock?(): boolean;
	/** Finalize a displaceable snapshot in place (settle animation, freeze bytes). */
	seal?(): void;
}

function isBlockFinalized(child: Component): boolean {
	const fn = (child as Component & FinalizableBlock).isTranscriptBlockFinalized;
	return fn ? fn.call(child) : true;
}

function getBlockVersion(child: Component): number | undefined {
	const fn = (child as Component & FinalizableBlock).getTranscriptBlockVersion;
	return fn ? fn.call(child) : undefined;
}

/** Clamped read of a block's declared settled rows (see {@link FinalizableBlock}). */
function getBlockSettledRows(child: Component): number {
	const fn = (child as Component & FinalizableBlock).getTranscriptBlockSettledRows;
	if (!fn) return 0;
	const value = fn.call(child);
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Seal a displaceable snapshot whose rows entered native scrollback (see {@link FinalizableBlock.isDisplaceableBlock}). */
function sealCommittedSnapshot(child: Component): void {
	const block = child as Component & FinalizableBlock;
	if (block.isDisplaceableBlock?.()) block.seal?.();
}

function setBlockCommittedRows(child: Component, rows: number): void {
	(child as Component & Partial<NativeScrollbackCommittedRows>).setNativeScrollbackCommittedRows?.(rows);
}

// A "plain blank" row is empty or whitespace-only with no ANSI bytes. It marks
// separation padding (a `Spacer`, or a no-background `paddingY` row) as opposed
// to a background-colored padding row, whose escape sequences contain `\S` and
// are therefore preserved as part of a block's visual design.
const NON_WHITESPACE = /\S/;
function isPlainBlank(line: string): boolean {
	return !NON_WHITESPACE.test(line);
}

// Strip leading/trailing plain-blank rows so each block contributes only its
// visible body; the container owns the gaps between blocks. Returns the input
// array unchanged when there is nothing to trim (no allocation on the hot path).
function stripPlainBlankEdges(lines: readonly string[]): readonly string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isPlainBlank(lines[start]!)) start++;
	while (end > start && isPlainBlank(lines[end - 1]!)) end--;
	return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}

/**
 * One block's recorded contribution to the assembled transcript: the raw array
 * reference its render() returned, the stripped contribution derived from it,
 * and where those rows landed. Reference-compared on the next render — per the
 * Component render contract, an identical raw reference proves the block's
 * rows are byte-identical, so the stripped contribution and the assembled rows
 * can be reused without re-deriving anything.
 */
interface BlockSegment {
	component: Component;
	rawRef: readonly string[];
	contribution: readonly string[];
	width: number;
	generation: number;
	/** Frame row of this block's first emitted row (the separator when present). */
	startRow: number;
	/** Rows emitted: separator + contribution (0 for empty contributions). */
	rowCount: number;
	sep: number;
	/** Whether the block reported finalized when this segment was rendered. */
	finalized: boolean;
	/** Block version observed when this segment was rendered (see {@link FinalizableBlock}). */
	version: number | undefined;
}

const EMPTY_SEGMENTS: BlockSegment[] = [];
/** Shared empty result for an empty viewport-tail render (no allocation). */
const EMPTY_TAIL: readonly string[] = [];

/**
 * Transcript container that renders every block's current content each frame
 * and reports the native-scrollback exactness boundary
 * (`NativeScrollbackLiveRegion`): the frame row below which every rendered
 * row is final. The boundary covers the leading run of finalized blocks plus
 * the first still-live block's declared settled rows
 * ({@link FinalizableBlock.getTranscriptBlockSettledRows}). Rows below it
 * commit to native scrollback as exact, audited content; rows above it that
 * scroll off the window commit as frozen visual snapshots the engine never
 * re-anchors or recommits (the tape records what was on screen).
 *
 * The engine never rewrites committed history: rows that have entered the
 * tape keep whatever bytes they were committed with ("let the history be"),
 * while the visible window always repaints from each block's latest render —
 * a late tool result, a post-finalize error pin, or an expand toggle is
 * always reflected on screen while it remains in the window.
 *
 * Assembly is incremental: the returned array is persistent and mutated in
 * place. Each block's render is still called every frame, but a block whose
 * render returned the same array reference at an unchanged offset reuses its
 * previously assembled rows; the array is truncated and re-pushed only from
 * the first divergent block. The leading byte-identical row count is reported
 * through {@link RenderStablePrefix} so the engine can skip marker scanning,
 * line preparation, and the committed-prefix audit for those rows.
 */
export class TranscriptContainer
	extends Container
	implements NativeScrollbackLiveRegion, NativeScrollbackCommittedRows, RenderStablePrefix, ViewportTailProvider
{
	// Bumped to retire every block segment at once (theme change / clear); a
	// segment is only reused when its stored generation matches.
	#generation = 0;
	// Local line index below which every row of the most recent render is
	// final: the leading finalized blocks plus the first live block's declared
	// settled rows. TUI commits rows to native scrollback only above it.
	#nativeScrollbackLiveRegionStart: number | undefined;
	#nativeScrollbackLiveRegionPinned = false;
	// Persistent assembled transcript rows. Rows before the stable floor are
	// byte-identical to the previous render; rows at/after it were re-pushed.
	#lines: string[] = [];
	#segments: BlockSegment[] = EMPTY_SEGMENTS;
	#renderWidth = -1;
	// Local rows already committed to native scrollback by the previous frame.
	// Finalized blocks wholly before this boundary are immutable on-screen history;
	// their previous contribution can be replayed without calling render().
	#committedRows = 0;
	// Stable-prefix floor accumulated across renders since the last
	// getRenderStablePrefixRows() read (see RenderStablePrefix: reading
	// consumes the report and re-bases the baseline). Out-of-band renders
	// between engine frames lower it; they can never inflate it.
	#stableRowsFloor = 0;
	override invalidate(): void {
		// Theme/global invalidation: retire every diff snapshot so stale styling
		// is not diffed against the recolored render.
		this.#generation++;
		super.invalidate();
	}

	override clear(): void {
		this.#generation++;
		super.clear();
		this.#committedRows = 0;
	}

	override setNativeScrollbackCommittedRows(rows: number): void {
		this.#committedRows = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
		for (let i = 0; i < this.children.length; i++) {
			const child = this.children[i]!;
			const segment = this.#segments[i];
			if (segment === undefined || segment.component !== child) continue;
			const committedContribution = Math.min(
				segment.contribution.length,
				Math.max(0, this.#committedRows - segment.startRow - segment.sep),
			);
			if (committedContribution === 0) {
				setBlockCommittedRows(child, 0);
				continue;
			}
			// Transcript assembly strips plain blank edges from each block. Map the
			// committed contribution back into the child's raw render coordinates so
			// nested containers can split the prefix against their exact child rows.
			let leadingTrimmedRows = 0;
			while (leadingTrimmedRows < segment.rawRef.length && isPlainBlank(segment.rawRef[leadingTrimmedRows]!)) {
				leadingTrimmedRows++;
			}
			setBlockCommittedRows(child, Math.min(segment.rawRef.length, leadingTrimmedRows + committedContribution));
		}
	}

	getRenderStablePrefixRows(): number {
		const value = Math.min(this.#stableRowsFloor, this.#lines.length);
		this.#stableRowsFloor = this.#lines.length;
		return value;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#nativeScrollbackLiveRegionStart;
	}

	/** Propagates viewport pinning from the first still-mutating transcript block. */
	isNativeScrollbackLiveRegionPinned(): boolean {
		return this.#nativeScrollbackLiveRegionPinned;
	}

	/**
	 * Whether none of `component`'s rows (per the most recent render) have
	 * entered native scrollback. Callers that retract ephemeral blocks (IRC
	 * cards, displaceable todo/job snapshots) must check this: removing a
	 * block whose rows are already on the tape is an interior deletion of
	 * committed history the engine cannot express — the block must be sealed
	 * in place as history instead. A component that has never rendered has no
	 * committed rows and is safely removable.
	 */
	isBlockUncommitted(component: Component): boolean {
		for (const segment of this.#segments) {
			if (segment.component !== component) continue;
			return segment.rowCount === 0 || segment.startRow >= this.#committedRows;
		}
		return true;
	}

	/**
	 * Whether `component` is inside the live (repaintable) region exactly as
	 * {@link render} computes it: at/after the first still-mutating block, or
	 * the transcript tail when every block has finalized. Self-animating
	 * finalized blocks (a detached task's shimmering progress rows) poll this
	 * to stop animating — and settle on static bytes — the moment they sit
	 * above the seam, where their rows become commit-eligible native-scrollback
	 * history.
	 */
	isBlockInLiveRegion(component: Component): boolean {
		const children = this.children;
		const index = children.indexOf(component);
		if (index < 0) return false;
		for (let i = 0; i <= index; i++) {
			if (!isBlockFinalized(children[i]!)) return true;
		}
		// Every block at/before `index` finalized: the live region starts at the
		// first unfinalized block below it, or at the last child when none exists.
		for (let i = index + 1; i < children.length; i++) {
			if (!isBlockFinalized(children[i]!)) return false;
		}
		return index === children.length - 1;
	}

	/**
	 * Render only the bottom `maxRows` rows of the transcript at `width`, walking
	 * blocks from the last toward the first and stopping the instant enough rows
	 * are collected — blocks above the fold are never rendered. The engine's
	 * resize viewport fast path uses this so a drag (a SIGWINCH burst, each event
	 * a fresh width that misses every per-width cache) re-lays-out only the
	 * handful of visible blocks instead of the whole history every event.
	 *
	 * State-isolated by contract: touches none of the persistent full-compose
	 * fields (#lines, #segments, the per-block diff snapshots, the commit/stable
	 * bookkeeping), so the authoritative full render on settle reconciles exactly
	 * as if this never ran. Calling each block's render() still warms its own
	 * per-width cache, which that settle render then reuses for free.
	 *
	 * Consecutive visible blocks are joined by exactly one blank separator, the
	 * same rule render() applies, so the result equals the bottom of a full
	 * render except for an at-most-one-row separator on the topmost included
	 * block — a transient discrepancy the settle paint overwrites.
	 */
	renderViewportTail(width: number, maxRows: number): readonly string[] {
		width = Math.max(1, width);
		if (maxRows <= 0) return EMPTY_TAIL;
		const collected: (readonly string[])[] = [];
		let total = 0;
		for (let i = this.children.length - 1; i >= 0 && total < maxRows; i--) {
			const contribution = stripPlainBlankEdges(this.children[i]!.render(width));
			if (contribution.length === 0) continue;
			// One blank separator sits between this block and the (already
			// collected) visible block below it.
			if (collected.length > 0) total += 1;
			collected.push(contribution);
			total += contribution.length;
		}
		if (collected.length === 0) return EMPTY_TAIL;
		const rows: string[] = [];
		for (let k = collected.length - 1; k >= 0; k--) {
			if (rows.length > 0) rows.push("");
			const body = collected[k]!;
			for (let j = 0; j < body.length; j++) rows.push(body[j]!);
		}
		return rows.length > maxRows ? rows.slice(rows.length - maxRows) : rows;
	}

	override render(width: number): readonly string[] {
		width = Math.max(1, width);
		this.#nativeScrollbackLiveRegionStart = undefined;
		this.#nativeScrollbackLiveRegionPinned = false;

		const count = this.children.length;

		// Seal displaceable snapshots whose rows are already on the tape (per the
		// previous frame's segments — the geometry the committed count was
		// computed against): immutable history can no longer be retracted, and
		// left unfinalized such a block would pin the live-region seam open below
		// it. Runs before the live-block scan so the seam unpins in this same
		// frame, and every frame so a block that BECAME displaceable after its
		// pending-preview rows committed (late result on a scrolled-off call) is
		// caught too.
		for (let i = 0; i < count && i < this.#segments.length; i++) {
			const previous = this.#segments[i];
			if (previous === undefined) continue;
			if (previous.startRow >= this.#committedRows) break;
			if (previous.rowCount === 0 || previous.component !== this.children[i]) continue;
			sealCommittedSnapshot(previous.component);
		}

		// The commit boundary stops at the earliest still-mutating block. A
		// block that has not finalized must gate it: out-of-band inserts
		// (TTSR/todo cards) can append a finalized block *below* a tool that is
		// still awaiting its result, and committing rows there would strand the
		// tool's history rows on a mid-stream preview the late result never
		// reaches.
		let liveStartIndex = -1;
		let hasLiveBlock = false;
		for (let i = 0; i < count; i++) {
			if (!isBlockFinalized(this.children[i]!)) {
				liveStartIndex = i;
				hasLiveBlock = true;
				this.#nativeScrollbackLiveRegionPinned =
					(
						this.children[i] as Component & Partial<NativeScrollbackLiveRegion>
					).isNativeScrollbackLiveRegionPinned?.() === true;
				break;
			}
		}

		const lines = this.#lines;
		const previousSegments = this.#segments;
		const segments: BlockSegment[] = new Array(count);
		// Poisoned until the walk completes: a block render throwing mid-walk
		// leaves the persistent array half-rebuilt, and the next render must
		// not trust stale segments against it. Restored at the end.
		this.#segments = EMPTY_SEGMENTS;
		const stableFloorBefore = this.#stableRowsFloor;
		this.#stableRowsFloor = 0;
		// Stability requires the same width and, per segment, the same block at
		// the same offset returning the same array reference. The first
		// divergence truncates the persistent array there; everything after
		// re-pushes.
		let chainStable = this.#renderWidth === width;
		this.#renderWidth = width;
		// Entry-unstable (width change): the divergence truncation inside the
		// loop only fires on a stable→unstable transition, so reset the
		// persistent array here to keep the `!chainStable ⇒ lines.length === row`
		// invariant — otherwise re-pushed rows land after the stale frame.
		if (!chainStable) lines.length = 0;

		// Frame row cursor: rows emitted (reused or pushed) so far.
		let row = 0;
		let stableRows = 0;
		for (let i = 0; i < count; i++) {
			const child = this.children[i]!;

			// This child's contribution: its current render with plain-blank
			// top/bottom edges stripped (the container owns inter-block gaps).
			// Finalized blocks wholly inside committed native scrollback can reuse
			// their previous contribution without calling render(): those rows are
			// immutable terminal history for the current width/generation. Blocks
			// outside committed history still render normally so late results,
			// post-finalize re-layouts, and expand toggles remain visible.
			const previous = previousSegments[i];
			const finalized = isBlockFinalized(child);
			const version = getBlockVersion(child);
			const committedReusable =
				previous !== undefined &&
				previous.component === child &&
				previous.width === width &&
				previous.generation === this.#generation &&
				previous.startRow === row &&
				previous.startRow + previous.rowCount <= this.#committedRows &&
				finalized &&
				// Only replay bytes that were themselves produced by a finalized
				// render: a block finalizing between frames may have changed content
				// while its rows were already committed via the append-only live
				// path, so the first post-transition frame must render. Defense in
				// depth on the transcript side — the TUI commit policy should keep
				// that window closed, but the safety must not live there alone.
				previous.finalized &&
				// Post-finalize mutations (inline error restore, late tool images)
				// bump the block version; a mismatch forces a real render so the
				// committed-prefix audit can observe and re-anchor the change.
				previous.version === version;
			const raw = committedReusable ? previous.rawRef : child.render(width);
			const reusable =
				committedReusable ||
				(previous !== undefined &&
					previous.component === child &&
					previous.rawRef === raw &&
					previous.width === width &&
					previous.generation === this.#generation);
			const contribution = reusable ? previous.contribution : stripPlainBlankEdges(raw);

			// Empty (or stripped-to-nothing) children contribute nothing and never
			// affect spacing. An empty still-live child still gates the commit
			// boundary at its position: if it later gains rows, it pushes
			// everything below it.
			if (contribution.length === 0) {
				if (hasLiveBlock && i === liveStartIndex) {
					this.#nativeScrollbackLiveRegionStart = row;
				}
				if (chainStable && !(reusable && previous.rowCount === 0 && previous.startRow === row)) {
					chainStable = false;
					lines.length = row;
				}
				if (chainStable) stableRows = row;
				segments[i] = {
					component: child,
					rawRef: raw,
					contribution,
					width,
					generation: this.#generation,
					startRow: row,
					rowCount: 0,
					sep: 0,
					finalized,
					version,
				};
				continue;
			}

			// Every block is separated from preceding visible content by exactly one
			// blank row — skipped when it opens the transcript or the prior row is
			// already a plain blank (a fragment's own trailing pad), never doubling.
			// `lines[row - 1]` is valid in both modes: reused rows are still present
			// in the persistent array, re-pushed rows were just written.
			const sep = row > 0 && !isPlainBlank(lines[row - 1]!) ? 1 : 0;

			// The separator before the first live block stays in the committed
			// prefix (it is deterministic once the prior block's body is
			// settled); the boundary then extends through the live block's
			// declared settled rows, mapped from its raw render into the
			// stripped contribution.
			if (hasLiveBlock && i === liveStartIndex) {
				let settled = 0;
				const settledRaw = getBlockSettledRows(child);
				if (settledRaw > 0) {
					let lead = 0;
					while (lead < raw.length && isPlainBlank(raw[lead]!)) lead++;
					settled = Math.max(0, Math.min(contribution.length, settledRaw - lead));
				}
				this.#nativeScrollbackLiveRegionStart = row + sep + settled;
			}

			const rowCount = sep + contribution.length;
			const stable = chainStable && reusable && previous.startRow === row && previous.sep === sep;
			if (stable) {
				stableRows = row + rowCount;
			} else {
				if (chainStable) {
					chainStable = false;
					lines.length = row;
				}
				if (sep) lines.push("");
				for (let j = 0; j < contribution.length; j++) lines.push(contribution[j]!);
			}

			segments[i] = {
				component: child,
				rawRef: raw,
				contribution,
				width,
				generation: this.#generation,
				startRow: row,
				rowCount,
				sep,
				finalized,
				version,
			};
			row += rowCount;
		}
		// Trailing shrink: blocks removed from the tail leave stale rows behind
		// when every surviving segment was reused.
		if (lines.length !== row) lines.length = row;
		this.#segments = segments;
		this.#stableRowsFloor = Math.min(stableFloorBefore, stableRows, row);
		return lines;
	}
}

/**
 * Groups a run of sibling rows (an IRC card's header + body, a file-mention
 * list, a bordered command/version panel) into a single transcript child so the
 * container spaces it as one block — one blank line above, none injected between
 * its rows. Without this wrapper the rows would be top-level children and the
 * container would put a blank line between each (and inside any border box).
 * It is a plain {@link Container}; the named subclass documents intent and makes
 * every manual block grouping greppable.
 */
export class TranscriptBlock extends Container {}
