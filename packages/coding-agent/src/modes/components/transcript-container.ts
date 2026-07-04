import {
	type Component,
	Container,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackLiveRegion,
	type RenderStablePrefix,
	type ViewportTailProvider,
} from "@oh-my-pi/pi-tui";

const kSnapshot = Symbol("transcript.liveDiffSnapshot");

/**
 * Per-block render cache: the block's previous stripped contribution plus the
 * derived append-only state. Still-live blocks use it as input to
 * {@link deriveLiveCommitState}; finalized blocks wholly inside already
 * committed native scrollback can replay it without calling render().
 */
interface LiveDiffSnapshot {
	width: number;
	lines: readonly string[];
	generation: number;
	appendOnly: boolean;
	/**
	 * Frames remaining until a block that rewrote an interior row may re-earn
	 * append-only status. `0` means the block is not under rewrite suspicion.
	 */
	volatileCooldown: number;
	/**
	 * Stable-prefix ratchet (see {@link deriveLiveCommitState}): leading rows
	 * promoted as commit-safe because they stayed visibly identical for
	 * {@link STABLE_PREFIX_COMMIT_FRAMES} consecutive frames, plus the in-flight
	 * candidate run and its age.
	 */
	stablePrefixLength: number;
	candidatePrefixLength: number;
	candidatePrefixAge: number;
	/**
	 * Topmost row index ever observed rewritten in place (see
	 * {@link deriveLiveCommitState}): the stable-prefix ratchet never promotes
	 * rows at/after it. `Infinity` until the first rewrite.
	 */
	rewriteFloor: number;
}

interface SnapshotCarrier {
	[kSnapshot]?: LiveDiffSnapshot;
}

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
	 * Whether a still-live block's visually settled leading rows are durable —
	 * guaranteed to survive the block's remaining transitions (finalize,
	 * displacement) byte-stable — and may therefore be promoted as commit-safe
	 * by {@link deriveLiveCommitState}. Blocks whose pending render is
	 * provisional (a tool call's tail-window streaming preview, replaced
	 * wholesale by the result render) return `false`: committing such rows
	 * strands a stale copy in immutable terminal history the moment the real
	 * content re-lays-out the block (the engine audit recommits below it —
	 * "duplication, never loss"). Absent = `true`, the default for blocks
	 * whose live rows persist (a streaming assistant message).
	 */
	isTranscriptBlockCommitStable?(): boolean;
}

function isBlockFinalized(child: Component): boolean {
	const fn = (child as Component & FinalizableBlock).isTranscriptBlockFinalized;
	return fn ? fn.call(child) : true;
}

function getBlockVersion(child: Component): number | undefined {
	const fn = (child as Component & FinalizableBlock).getTranscriptBlockVersion;
	return fn ? fn.call(child) : undefined;
}

function isBlockCommitStable(child: Component): boolean {
	const fn = (child as Component & FinalizableBlock).isTranscriptBlockCommitStable;
	return fn ? fn.call(child) : true;
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

interface LiveCommitState {
	appendOnly: boolean;
	volatileCooldown: number;
	stablePrefixLength: number;
	candidatePrefixLength: number;
	candidatePrefixAge: number;
	rewriteFloor: number;
	safeLength: number;
}

/**
 * Render frames a block must stay clean (static or append-shaped) after an
 * interior rewrite before its rows become committable again. A one-off
 * re-layout (a codespan finalizing across a wrap boundary, a paragraph
 * re-parsed as a heading) only suspends commits briefly — the pinned emitter
 * appends from the stalled high-water mark, so the gap backfills contiguously
 * once the block re-earns append-only. Periodic animations (a spinner rewrites
 * its row every few frames) keep resetting the countdown and never re-earn it,
 * so genuinely volatile blocks stay deferred. Frames arrive at most at the
 * TUI's 30 Hz render cadence, so 30 frames ≈ 1s of clean streaming.
 */
const VOLATILE_REARM_FRAMES = 30;

/**
 * Consecutive frames a leading row run must stay visibly identical before it
 * is promoted as commit-safe even though the block's tail keeps rewriting.
 * Append-only detection alone is all-or-nothing per block: one perpetually
 * ticking row (a task tool's progress tree, per-agent cost/tool counters, a
 * log line spinner) suspends commits for the WHOLE block forever, so once the
 * block outgrows the viewport its static head — e.g. a task's prompt/context
 * markdown — is neither committed to native scrollback nor on screen: the
 * transcript reads as cut off for the entire (possibly minutes-long) run.
 * The ratchet commits the settled head while only the genuinely volatile tail
 * stays deferred. If a promoted row is later rewritten (a collapsing
 * preview), the engine's committed-prefix audit re-anchors and recommits —
 * duplication, never loss — and the ratchet retreats to the divergence.
 */
const STABLE_PREFIX_COMMIT_FRAMES = 30;

/**
 * Rows at a live block's tail treated as the volatile streaming edge. Real
 * streaming is not strictly append-only at the bottom: the in-flight markdown
 * paragraph re-wraps as words arrive (rewriting its last 1-2 visual rows), an
 * unclosed token (`**bold`, a half-streamed link) re-renders when its closer
 * arrives, and a wrap-shrink moves the last word onto a new row. Divergence
 * confined to this zone is clean growth, and the zone itself is held back
 * from the offered commit boundary — so a tolerated rewrite can never touch a
 * row the engine may have committed. Width 4 covers the observed shapes (≤2
 * rows) with margin for wide glyphs and multi-row token spans; the cost is
 * only that the last 4 rows of a live block commit at finalization instead of
 * mid-stream, which is invisible (they are on screen — the viewport is always
 * taller than the holdback).
 */
const TAIL_VOLATILITY_ROWS = 4;

/**
 * Visible-content form of a row: SGR/OSC bytes and trailing pad spaces are
 * write framing, not content. A styled line's closing escape moves when the
 * line stops being the last of its span (a wrapped thinking paragraph growing
 * by one row), and width-padded rows shift their trailing spaces as text
 * grows; both leave the on-screen cells identical and must not count as a
 * rewrite of a committed-candidate row. Committed scrollback rows are written
 * with a full SGR/OSC reset terminator, so escape-placement drift between
 * visually identical renders cannot bleed styles across rows.
 */
function normalizeRow(line: string): string {
	return Bun.stripANSI(line).trimEnd();
}

function rowsVisiblyEqual(prev: string, cur: string): boolean {
	return prev === cur || normalizeRow(prev) === normalizeRow(cur);
}

/**
 * Whether `cur` is `prev` grown in place: the visible content of `prev` is a
 * strict-or-equal prefix of `cur`'s (token streaming appending to the cursor
 * row). Escape placement and pad drift are ignored, same as rowsVisiblyEqual.
 */
function rowVisiblyGrew(prev: string, cur: string): boolean {
	return normalizeRow(cur).startsWith(normalizeRow(prev));
}

function hasValidSnapshot(
	snapshot: LiveDiffSnapshot | undefined,
	width: number,
	generation: number,
): snapshot is LiveDiffSnapshot {
	return snapshot !== undefined && snapshot.generation === generation && snapshot.width === width;
}

function commonPrefixLength(prev: readonly string[], cur: readonly string[]): number {
	const limit = Math.min(prev.length, cur.length);
	let i = 0;
	while (i < limit && rowsVisiblyEqual(prev[i]!, cur[i]!)) i++;
	return i;
}

function commonSuffixLength(prev: readonly string[], cur: readonly string[], prefixLength: number): number {
	const limit = Math.min(prev.length - prefixLength, cur.length - prefixLength);
	let i = 0;
	while (i < limit && rowsVisiblyEqual(prev[prev.length - 1 - i]!, cur[cur.length - 1 - i]!)) i++;
	return i;
}

function deriveLiveCommitState(
	previous: LiveDiffSnapshot | undefined,
	current: readonly string[],
	width: number,
	generation: number,
): LiveCommitState {
	let appendOnly = false;
	let volatileCooldown = 0;
	let stablePrefixLength = 0;
	let candidatePrefixLength = 0;
	let candidatePrefixAge = 0;
	let rewriteFloor = Number.POSITIVE_INFINITY;
	let trailingRowGrowth = false;
	if (hasValidSnapshot(previous, width, generation)) {
		appendOnly = previous.appendOnly;
		volatileCooldown = previous.volatileCooldown;
		stablePrefixLength = previous.stablePrefixLength;
		candidatePrefixLength = previous.candidatePrefixLength;
		candidatePrefixAge = previous.candidatePrefixAge;
		rewriteFloor = previous.rewriteFloor;

		const prefixLength = commonPrefixLength(previous.lines, current);
		const staticRender = prefixLength === previous.lines.length && prefixLength === current.length;
		let cleanFrame = true;
		if (!staticRender) {
			const suffixLength = commonSuffixLength(previous.lines, current, prefixLength);
			// Append-only growth never rewrites a row that may already have scrolled
			// into native scrollback; it only grows the block at/near its tail. Two
			// shapes qualify:
			// - a pure insertion that preserves every previous row across a
			//   matching prefix + suffix (a bottom append, or an insertion above
			//   stable trailing chrome like a streaming tool's footer/border);
			// - a rewrite whose divergence BEGINS inside the trailing
			//   TAIL_VOLATILITY_ROWS of the previous render — the streaming edge:
			//   the in-flight paragraph re-wrapping as words arrive (its last 1-2
			//   visual rows), an unclosed markdown token (`**bold`) re-rendering
			//   when its closer streams in, a wrap-shrink pushing the last word
			//   onto an appended row. That zone is held back from `safeLength`
			//   below, so a tolerated rewrite can never touch a row that was
			//   offered for commit.
			// The anchor matters: the gap must START in the tail zone, not merely
			// be small — a one-row ticker mid-block with stable rows beneath it
			// would otherwise classify clean, get offered past, and rewrite
			// committed rows on every tick. Any deeper divergent row means the
			// block re-laid-out committed-candidate content — a rewrite, which
			// suspends commits until the block re-earns append-only.
			const preservedEveryRow = prefixLength + suffixLength >= previous.lines.length;
			const tailConfined = preservedEveryRow || prefixLength >= previous.lines.length - TAIL_VOLATILITY_ROWS;
			if (tailConfined && current.length >= previous.lines.length) {
				// Strict trailing-row growth: every previous row except the last
				// is visibly unchanged and the last grew in place as a visible
				// prefix, with no rows appended — a line accumulating tokens.
				// The sole divergent row is the block's physical last row, which
				// the engine's window floor never commits while it stays last
				// (chunkTo ≤ windowTop ≤ last row index), so the volatile-tail
				// holdback below is unnecessary: the whole body is offerable and
				// the block's scrolled-off head reaches native scrollback.
				trailingRowGrowth =
					current.length === previous.lines.length &&
					prefixLength === previous.lines.length - 1 &&
					rowVisiblyGrew(previous.lines[prefixLength]!, current[prefixLength]!);
				if (volatileCooldown === 0) appendOnly = true;
				// Clean growth inserts/rewrites rows at the divergence; a floor
				// inside the preserved suffix travels down with it, a floor at or
				// above the divergent zone stays put (conservative: a stale floor
				// index can only point at an earlier row, never a later one).
				const delta = current.length - previous.lines.length;
				if (delta > 0 && Number.isFinite(rewriteFloor)) {
					const suffixStart = Math.max(prefixLength, previous.lines.length - suffixLength);
					if (rewriteFloor >= suffixStart) rewriteFloor += delta;
				}
			} else {
				cleanFrame = false;
				appendOnly = false;
				volatileCooldown = VOLATILE_REARM_FRAMES;
			}
		}
		if (cleanFrame && volatileCooldown > 0) volatileCooldown--;

		// Stable-prefix ratchet, independent of append-only. `prefixLength` is
		// this frame's visibly-unchanged leading run; the candidate accumulates
		// the MINIMUM prefix across a STABLE_PREFIX_COMMIT_FRAMES window, so
		// promotion means every promoted row stayed identical for the whole
		// window (row r is inside frame i's common prefix iff r < p_i, so
		// r < min(p) holds for every frame of the window). A row settling
		// mid-window promotes at most two windows later. The engine audit owns
		// any promoted rows that already committed (recommit, never loss).
		if (prefixLength < stablePrefixLength) {
			// A divergence inside the promoted run is the ratchet's proof of
			// over-promotion: this row was visibly stable for a full window,
			// got promoted (and likely committed), and then mutated anyway — a
			// slow ticker (an agent row's tool/cost counter, a growing progress
			// tree), not settling content. It will mutate again, and every
			// promote→mutate cycle makes the engine audit recommit, spraying a
			// stale snapshot of the block into native scrollback. Floor the
			// ratchet at the divergence permanently: rows above it may still
			// promote, rows at/below it never re-promote while the block lives.
			// One-off re-layouts before any promotion (a call→result frame
			// transition, a codespan finalizing) never hit this branch, and the
			// append-only re-arm path commits the full block regardless of the
			// floor.
			rewriteFloor = Math.min(rewriteFloor, prefixLength);
			stablePrefixLength = prefixLength;
			candidatePrefixLength = prefixLength;
			candidatePrefixAge = 0;
		} else {
			candidatePrefixLength =
				candidatePrefixAge === 0 ? prefixLength : Math.min(candidatePrefixLength, prefixLength);
			candidatePrefixAge++;
			if (candidatePrefixAge >= STABLE_PREFIX_COMMIT_FRAMES) {
				// Cap at the volatile-tail holdback: a long static stretch would
				// otherwise promote the streaming edge itself (min prefix == full
				// length), and the next chunk's tail re-wrap would then rewrite
				// offered rows.
				stablePrefixLength = Math.min(
					candidatePrefixLength,
					rewriteFloor,
					Math.max(0, current.length - TAIL_VOLATILITY_ROWS),
				);
				candidatePrefixLength = prefixLength;
				candidatePrefixAge = 0;
			}
		}
	}

	return {
		appendOnly,
		volatileCooldown,
		stablePrefixLength,
		candidatePrefixLength,
		candidatePrefixAge,
		rewriteFloor,
		// A clean-streaming block's body is committable up to the volatile-tail
		// holdback (the streaming edge is never offered, so its tolerated
		// rewrites can never touch committed rows); otherwise the settled head
		// still is — only the volatile tail stays deferred. Strict in-place
		// growth of the trailing row skips the holdback: its only mutable row
		// is the block's last, which cannot commit while it remains last.
		safeLength: appendOnly
			? trailingRowGrowth
				? current.length
				: Math.max(stablePrefixLength, current.length - TAIL_VOLATILITY_ROWS, 0)
			: stablePrefixLength,
	};
}

/**
 * Transcript container that renders every block's current content each frame
 * and reports the live-region seam (`NativeScrollbackLiveRegion`) that gates
 * the engine's append-only scrollback commits.
 *
 * The engine never rewrites committed history: rows above the seam that have
 * entered the tape keep whatever bytes they were committed with ("let the
 * history be"), while the visible window always repaints from each block's
 * latest render — a late tool result, a post-finalize error pin, or an expand
 * toggle is always reflected on screen. Blocks that are still mutating (an
 * unfinalized tool, a streaming assistant message) stay below the seam so
 * their rows do not enter history while they can still change; a streaming
 * block whose render grows append-only deepens the seam through its settled
 * head so a long reply's scrolled-off rows still reach scrollback mid-stream.
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
	// Bumped to retire every block's diff snapshot at once (theme change /
	// clear); a snapshot is only honored when its stored generation matches.
	#generation = 0;
	// Local line index where the current live region begins in the most recent
	// render. TUI commits rows to native scrollback only above this seam (or
	// the deeper commit-safe end below).
	#nativeScrollbackLiveRegionStart: number | undefined;
	// Local line index up to which the leading run of live blocks is safe to
	// commit. Finalized blocks contribute their full body; still-live blocks
	// contribute only while their render has been observed growing without
	// visibly rewriting a previously rendered interior row (escape placement
	// and pad drift are ignored). A rewrite suspends the block's contribution
	// until it re-earns append-only via VOLATILE_REARM_FRAMES clean frames;
	// the engine then backfills the stalled gap.
	#nativeScrollbackCommitSafeEnd: number | undefined;
	// Local line index up to which the leading run of live blocks is DURABLE: a
	// commit-stable block's full body is permanent content even while its interior
	// rows re-lay-out (a streaming markdown table re-aligning columns), so the
	// engine must append their scroll-off snapshot rather than drop it. Reported
	// separately from the byte-stable commit-safe end because these rows may still
	// drift after commit; the engine commits them audit-exempt. Provisional
	// (commit-unstable) blocks never extend it.
	#nativeScrollbackSnapshotSafeEnd: number | undefined;
	// Local line index through which lower finalized siblings are safe to OFFER to
	// native scrollback while still audited. Unlike snapshotSafeEnd, rows below a
	// live block are not durable: growth above them must repair stale history.
	#nativeScrollbackOfferSafeEnd: number | undefined;
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
	}

	setNativeScrollbackCommittedRows(rows: number): void {
		this.#committedRows = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
	}

	getRenderStablePrefixRows(): number {
		const value = Math.min(this.#stableRowsFloor, this.#lines.length);
		this.#stableRowsFloor = this.#lines.length;
		return value;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#nativeScrollbackLiveRegionStart;
	}

	getNativeScrollbackCommitSafeEnd(): number | undefined {
		return this.#nativeScrollbackCommitSafeEnd;
	}

	getNativeScrollbackSnapshotSafeEnd(): number | undefined {
		return this.#nativeScrollbackSnapshotSafeEnd;
	}

	getNativeScrollbackOfferSafeEnd(): number | undefined {
		return this.#nativeScrollbackOfferSafeEnd;
	}

	/**
	 * Whether `component` sits below a still-mutating block — i.e. inside the
	 * live region, where its rows cannot have been committed to native
	 * scrollback yet (commits are prefix-only and stop at the first
	 * still-live block). Callers that retract ephemeral blocks (IRC cards)
	 * must check this: removing a block whose rows may already be in history
	 * is an interior deletion of the committed prefix, which the engine can
	 * only repair by recommitting everything below it — duplication.
	 */
	isWithinLiveRegion(component: Component): boolean {
		const index = this.children.indexOf(component);
		if (index < 0) return false;
		for (let i = 0; i < index; i++) {
			if (!isBlockFinalized(this.children[i]!)) return true;
		}
		return false;
	}

	/**
	 * Whether `component` is inside the live (repaintable) region exactly as
	 * {@link render} computes it: at/after the first still-mutating block, or
	 * the transcript tail when every block has finalized. Unlike
	 * {@link isWithinLiveRegion} (strictly below a still-mutating block, i.e.
	 * guaranteed-uncommitted), this also counts the trailing block that anchors
	 * the live region. Self-animating finalized blocks (a detached task's
	 * shimmering progress rows) poll this to stop animating — and settle on
	 * static bytes — the moment they sit above the seam, where their rows
	 * become commit-eligible native-scrollback history.
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
		this.#nativeScrollbackCommitSafeEnd = undefined;
		this.#nativeScrollbackSnapshotSafeEnd = undefined;
		this.#nativeScrollbackOfferSafeEnd = undefined;

		const count = this.children.length;

		// The live region spans from the earliest still-mutating block through the
		// bottom. A block that has not finalized must stay below the seam: out-of-
		// band inserts (TTSR/todo cards) can append a finalized block *below* a
		// tool that is still awaiting its result, and committing the tool there
		// would strand its history rows on the mid-stream preview the late result
		// never reaches.
		let liveStartIndex = count - 1;
		for (let i = 0; i < count; i++) {
			if (!isBlockFinalized(this.children[i]!)) {
				liveStartIndex = i;
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

		// Tracks whether we are still inside the leading run of commit-safe live
		// blocks. The first still-live volatile block closes it, but rendering
		// continues so lower blocks remain visible.
		let commitSafeOpen = true;
		// The live-region start is recorded at the first visible row at/after
		// liveStartIndex; empty leading blocks (or a separator) must not claim it
		// early.
		let liveRecorded = false;
		// Prefix boundary for finalized siblings rendered below the first live
		// block. These rows may be offered to native scrollback, but they cannot
		// extend snapshotSafeEnd because a live block above can still move them.
		let offerSafeEnd: number | undefined;
		// Offer rows must be a contiguous finalized run below the first live
		// block. A later live/provisional block can still push rows below it, so
		// finalized siblings after that barrier must stay forced-overflow.
		let offerSafeOpen = true;
		// Frame row cursor: rows emitted (reused or pushed) so far.
		let row = 0;
		let stableRows = 0;
		for (let i = 0; i < count; i++) {
			const child = this.children[i]! as Component & SnapshotCarrier;

			// This child's contribution: its current render with plain-blank
			// top/bottom edges stripped (the container owns inter-block gaps).
			// Finalized blocks wholly inside committed native scrollback can reuse
			// their previous contribution without calling render(): those rows are
			// immutable terminal history for the current width/generation. Blocks
			// outside committed history still render normally so late results,
			// post-finalize re-layouts, and expand toggles remain visible.
			const previousSnapshot = child[kSnapshot];
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
			let liveCommitState: LiveCommitState | undefined;
			// Provisional live renders (commit-unstable blocks) never feed the
			// promotion machinery: their settled-looking rows are replaced
			// wholesale on finalize, so offering them would commit a stale
			// preview the result render can only duplicate, never erase.
			if (i >= liveStartIndex && !finalized && isBlockCommitStable(child)) {
				liveCommitState = deriveLiveCommitState(previousSnapshot, contribution, width, this.#generation);
			}
			// Cache the latest contribution as the next frame's diff input.
			child[kSnapshot] = {
				width,
				lines: contribution,
				generation: this.#generation,
				appendOnly: liveCommitState?.appendOnly ?? false,
				volatileCooldown: liveCommitState?.volatileCooldown ?? 0,
				stablePrefixLength: liveCommitState?.stablePrefixLength ?? 0,
				candidatePrefixLength: liveCommitState?.candidatePrefixLength ?? 0,
				candidatePrefixAge: liveCommitState?.candidatePrefixAge ?? 0,
				rewriteFloor: liveCommitState?.rewriteFloor ?? Number.POSITIVE_INFINITY,
			};

			// Empty (or stripped-to-nothing) children contribute nothing and never
			// affect spacing or the live-region offsets. An empty still-live child
			// still closes the commit-safe run: if it later gains rows, it pushes
			// everything below it.
			if (contribution.length === 0) {
				if (i >= liveStartIndex && commitSafeOpen && !finalized) commitSafeOpen = false;
				if (i > liveStartIndex && !finalized) offerSafeOpen = false;
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
			// prefix (it is deterministic once the prior block's body is settled),
			// so the live region begins at the block's first content row.
			if (!liveRecorded && i >= liveStartIndex) {
				this.#nativeScrollbackLiveRegionStart = row + sep;
				liveRecorded = true;
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

			const blockStart = row + sep;
			if (i >= liveStartIndex && commitSafeOpen) {
				const safeLength = finalized ? contribution.length : (liveCommitState?.safeLength ?? 0);
				if (safeLength > 0) {
					this.#nativeScrollbackCommitSafeEnd = blockStart + safeLength;
				}
				// Durable snapshot end: a commit-stable block's whole body is durable
				// content — its scrolled-off rows are permanent even while interior
				// rows re-lay-out (a streaming table re-aligning columns), so the
				// engine must commit their snapshot on scroll-off rather than drop it.
				// Finalized blocks are wholly durable; provisional (commit-unstable)
				// blocks offer nothing beyond their byte-stable safe length.
				const snapshotLength = finalized || isBlockCommitStable(child) ? contribution.length : safeLength;
				if (snapshotLength > 0) {
					this.#nativeScrollbackSnapshotSafeEnd = blockStart + snapshotLength;
				}
				// A finalized, fully safe block may let the contiguous safe run extend
				// into blocks rendered below it. A still-live block keeps pushing lower
				// rows around as it grows, so the run closes there.
				if (!(finalized && safeLength >= contribution.length)) commitSafeOpen = false;
			}
			if (i > liveStartIndex) {
				if (offerSafeOpen && finalized) {
					offerSafeEnd = blockStart + contribution.length;
				} else if (!finalized) {
					offerSafeOpen = false;
				}
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
		this.#nativeScrollbackOfferSafeEnd = offerSafeEnd;
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
