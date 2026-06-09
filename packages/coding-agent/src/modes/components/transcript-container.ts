import { type Component, Container, type NativeScrollbackLiveRegion } from "@oh-my-pi/pi-tui";

const kSnapshot = Symbol("transcript.liveDiffSnapshot");

/**
 * Per-block diff cache: the block's previous stripped contribution plus the
 * derived append-only state. Purely an input to {@link deriveLiveCommitState}
 * for still-live blocks — it is never replayed as render output. Every block
 * renders its current content on every frame.
 */
interface LiveDiffSnapshot {
	width: number;
	lines: string[];
	generation: number;
	appendOnly: boolean;
	/**
	 * Frames remaining until a block that rewrote an interior row may re-earn
	 * append-only status. `0` means the block is not under rewrite suspicion.
	 */
	volatileCooldown: number;
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
}

function isBlockFinalized(child: Component): boolean {
	const fn = (child as Component & FinalizableBlock).isTranscriptBlockFinalized;
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
function stripPlainBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isPlainBlank(lines[start]!)) start++;
	while (end > start && isPlainBlank(lines[end - 1]!)) end--;
	return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}

interface LiveCommitState {
	appendOnly: boolean;
	volatileCooldown: number;
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

function hasValidSnapshot(
	snapshot: LiveDiffSnapshot | undefined,
	width: number,
	generation: number,
): snapshot is LiveDiffSnapshot {
	return snapshot !== undefined && snapshot.generation === generation && snapshot.width === width;
}

function commonPrefixLength(prev: string[], cur: string[]): number {
	const limit = Math.min(prev.length, cur.length);
	let i = 0;
	while (i < limit && rowsVisiblyEqual(prev[i]!, cur[i]!)) i++;
	return i;
}

function commonSuffixLength(prev: string[], cur: string[], prefixLength: number): number {
	const limit = Math.min(prev.length - prefixLength, cur.length - prefixLength);
	let i = 0;
	while (i < limit && rowsVisiblyEqual(prev[prev.length - 1 - i]!, cur[cur.length - 1 - i]!)) i++;
	return i;
}

function deriveLiveCommitState(
	previous: LiveDiffSnapshot | undefined,
	current: string[],
	width: number,
	generation: number,
): LiveCommitState {
	let appendOnly = false;
	let volatileCooldown = 0;
	if (hasValidSnapshot(previous, width, generation)) {
		appendOnly = previous.appendOnly;
		volatileCooldown = previous.volatileCooldown;

		const prefixLength = commonPrefixLength(previous.lines, current);
		const staticRender = prefixLength === previous.lines.length && prefixLength === current.length;
		let cleanFrame = true;
		if (!staticRender) {
			const suffixLength = commonSuffixLength(previous.lines, current, prefixLength);
			// Append-only growth never rewrites a row that may already have scrolled
			// into native scrollback; it only grows the block at/near its tail. Four
			// shapes qualify: a pure bottom append, an insertion above stable trailing
			// chrome (a streaming tool's footer/border), an in-place extension of the
			// current line by one streamed token (line count unchanged), and a
			// wrap-shrink of the current line where its last word grew past the wrap
			// column and moved down onto an appended row. The first two preserve every
			// previous row across a matching prefix + suffix; the last two leave a
			// single divergent previous row — the block's in-flight bottom line, which
			// cannot have been committed (commits stop at the viewport top and the
			// bottom line is by definition on screen). Any other divergent interior
			// row means the block re-laid-out committed-candidate content — a rewrite,
			// which suspends commits until the block re-earns append-only.
			const preservedEveryRow = prefixLength + suffixLength >= previous.lines.length;
			let tailExtendedInPlace = false;
			if (
				!preservedEveryRow &&
				prefixLength + suffixLength === previous.lines.length - 1 &&
				prefixLength < current.length
			) {
				const prevTail = normalizeRow(previous.lines[prefixLength]!);
				const curTail = normalizeRow(current[prefixLength]!);
				tailExtendedInPlace =
					curTail.startsWith(prevTail) || (current.length > previous.lines.length && prevTail.startsWith(curTail));
			}
			if ((preservedEveryRow || tailExtendedInPlace) && current.length >= previous.lines.length) {
				if (volatileCooldown === 0) appendOnly = true;
			} else {
				cleanFrame = false;
				appendOnly = false;
				volatileCooldown = VOLATILE_REARM_FRAMES;
			}
		}
		if (cleanFrame && volatileCooldown > 0) volatileCooldown--;
	}

	return {
		appendOnly,
		volatileCooldown,
		safeLength: appendOnly ? current.length : 0,
	};
}

/**
 * Transcript container that always renders every block's current content and
 * reports the live-region seam (`NativeScrollbackLiveRegion`) that gates the
 * engine's append-only scrollback commits.
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
 */
export class TranscriptContainer extends Container implements NativeScrollbackLiveRegion {
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

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#nativeScrollbackLiveRegionStart;
	}

	getNativeScrollbackCommitSafeEnd(): number | undefined {
		return this.#nativeScrollbackCommitSafeEnd;
	}

	override render(width: number): string[] {
		width = Math.max(1, width);
		this.#nativeScrollbackLiveRegionStart = undefined;
		this.#nativeScrollbackCommitSafeEnd = undefined;

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

		const lines: string[] = [];
		// Tracks whether we are still inside the leading run of commit-safe live
		// blocks. The first still-live volatile block closes it, but rendering
		// continues so lower blocks remain visible.
		let commitSafeOpen = true;
		// The live-region start is recorded at the first visible row at/after
		// liveStartIndex; empty leading blocks (or a separator) must not claim it
		// early.
		let liveRecorded = false;
		for (let i = 0; i < count; i++) {
			const child = this.children[i]! as Component & SnapshotCarrier;

			// This child's contribution: its current render with plain-blank
			// top/bottom edges stripped (the container owns inter-block gaps).
			// Always the latest content — committed history keeps whatever bytes
			// it was written with, but the window must reflect the present state
			// (late tool results, post-finalize re-layouts, expand toggles).
			const previousSnapshot = child[kSnapshot];
			const contribution = stripPlainBlankEdges(child.render(width));
			let liveCommitState: LiveCommitState | undefined;
			if (i >= liveStartIndex && !isBlockFinalized(child)) {
				liveCommitState = deriveLiveCommitState(previousSnapshot, contribution, width, this.#generation);
			}
			// Cache the latest contribution as the next frame's diff input.
			child[kSnapshot] = {
				width,
				lines: contribution,
				generation: this.#generation,
				appendOnly: liveCommitState?.appendOnly ?? false,
				volatileCooldown: liveCommitState?.volatileCooldown ?? 0,
			};

			// Empty (or stripped-to-nothing) children contribute nothing and never
			// affect spacing or the live-region offsets. An empty still-live child
			// still closes the commit-safe run: if it later gains rows, it pushes
			// everything below it.
			if (contribution.length === 0) {
				if (i >= liveStartIndex && commitSafeOpen && !isBlockFinalized(child)) commitSafeOpen = false;
				continue;
			}

			// Every block is separated from preceding visible content by exactly one
			// blank row — skipped when it opens the transcript or the prior row is
			// already a plain blank (a fragment's own trailing pad), never doubling.
			const sep = lines.length > 0 && !isPlainBlank(lines[lines.length - 1]!) ? 1 : 0;

			// The separator before the first live block stays in the committed
			// prefix (it is deterministic once the prior block's body is settled),
			// so the live region begins at the block's first content row.
			if (!liveRecorded && i >= liveStartIndex) {
				this.#nativeScrollbackLiveRegionStart = lines.length + sep;
				liveRecorded = true;
			}

			if (sep) lines.push("");
			const blockStart = lines.length;
			for (let j = 0; j < contribution.length; j++) lines.push(contribution[j]!);

			if (i >= liveStartIndex && commitSafeOpen) {
				const finalized = isBlockFinalized(child);
				const safeLength = finalized ? contribution.length : (liveCommitState?.safeLength ?? 0);
				if (safeLength > 0) {
					this.#nativeScrollbackCommitSafeEnd = blockStart + safeLength;
				}
				// A finalized, fully safe block may let the contiguous safe run extend
				// into blocks rendered below it. A still-live block keeps pushing lower
				// rows around as it grows, so the run closes there.
				if (!(finalized && safeLength >= contribution.length)) commitSafeOpen = false;
			}
		}
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
