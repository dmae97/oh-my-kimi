import { type Component, Container, type NativeScrollbackLiveRegion, TERMINAL } from "@oh-my-pi/pi-tui";

const kSnapshot = Symbol("transcript.frozenRender");

interface FrozenRender {
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
	[kSnapshot]?: FrozenRender;
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
	snapshot: FrozenRender | undefined,
	width: number,
	generation: number,
): snapshot is FrozenRender {
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
	previous: FrozenRender | undefined,
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
 * Transcript container that freezes the rendered output of every block except
 * the bottom-most (live) one on terminals where committed native scrollback is
 * immutable.
 *
 * On ED3-risk terminals with an unobservable viewport (ghostty/kitty/iTerm2/…)
 * the renderer cannot clear saved lines (`\x1b[3J` may yank a reader) or query
 * whether the user has scrolled, so any block that re-lays-out *after* it has
 * scrolled past the viewport leaves a stale duplicate above the live region
 * (a finalized assistant message re-wrapping, a tool preview collapsing to its
 * compact result, a late async tool completion). The renderer's only safe move
 * for such an offscreen edit is to not repaint — which is correct only if the
 * committed region never changes underneath it.
 *
 * This container provides that guarantee: a block's render is snapshotted while
 * it is the live (bottom-most) block, and once a newer block is appended it
 * replays the snapshot instead of recomputing. Mutations after a block leaves
 * live are intentionally deferred until the next checkpoint {@link thaw} (prompt
 * submit → native-scrollback rebuild), where the whole transcript is replayed
 * and any drift reconciles safely. On terminals that can rebuild history this
 * freezing is unnecessary, so it renders every block live for full fidelity.
 */
export class TranscriptContainer extends Container implements NativeScrollbackLiveRegion {
	// Bumped to invalidate every block's snapshot at once; a snapshot is only
	// honored when its stored generation still matches.
	#generation = 0;
	// Line index where the live (repaintable) region began on the previous
	// render — the start of the earliest still-mutating block, or the bottom
	// block when everything is finalized. A block leaves the live region only
	// once it has finalized AND a finalized block sits below it; the frame it
	// crosses out is recomputed so it freezes at its true final content, not the
	// mid-stream snapshot it last rendered while live (TUI render coalescing can
	// advance a block's content in the very frame it stops being live).
	#prevLiveStartIndex = 0;
	// Local line index where the current live region begins in the most recent
	// render. TUI extends the native-scrollback pinned region from this point
	// through the live blocks and the root chrome rendered below them.
	#nativeScrollbackLiveRegionStart: number | undefined;
	// Local line index up to which the leading run of live blocks is safe to
	// commit. Finalized blocks contribute their full frozen body; still-live
	// blocks contribute only after their stripped render has been observed
	// growing without changing a previously rendered interior row.
	#nativeScrollbackCommitSafeEnd: number | undefined;

	override invalidate(): void {
		// A theme/global invalidation forces a full recompute on the rebuild that
		// follows; retire every snapshot.
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

	/**
	 * Retire all frozen snapshots so the next render reflects each block's current
	 * state. Call at reconciliation checkpoints (prompt submit) where the whole
	 * transcript is replayed into native scrollback and any drift a frozen block
	 * accumulated is reconciled.
	 */
	thaw(): void {
		this.#generation++;
	}

	override render(width: number): string[] {
		width = Math.max(1, width);
		this.#nativeScrollbackLiveRegionStart = undefined;
		this.#nativeScrollbackCommitSafeEnd = undefined;

		// Freezing/snapshotting only applies on ED3-risk terminals; elsewhere every
		// block renders live. Inter-block spacing applies on BOTH paths so the gap
		// between blocks is identical regardless of terminal.
		const risk = TERMINAL.eagerEraseScrollbackRisk;
		const count = this.children.length;

		// The live region spans from the earliest still-mutating block through the
		// bottom. A block that has not finalized must stay repaintable: out-of-band
		// inserts (TTSR/todo cards) can append a finalized block *below* a tool that
		// is still awaiting its result, and freezing the tool there would strand its
		// committed rows on the mid-stream preview the late result never reaches.
		let liveStartIndex = count - 1;
		for (let i = 0; i < count; i++) {
			if (!isBlockFinalized(this.children[i]!)) {
				liveStartIndex = i;
				break;
			}
		}
		// Blocks at [prevLiveStart, liveStart) just crossed out of the live region;
		// recompute them so they freeze at their final content. Everything below
		// the lower of the two cutoffs was already frozen last frame and replays.
		const replayCutoff = Math.min(liveStartIndex, this.#prevLiveStartIndex);
		if (risk) this.#prevLiveStartIndex = liveStartIndex;

		const lines: string[] = [];
		// Tracks whether we are still inside the leading run of commit-safe live
		// blocks. The first still-live volatile block closes it, but rendering
		// continues so lower blocks remain visible.
		let commitSafeOpen = true;
		// The live-region start is recorded at the first visible row at/after the
		// cutoff; empty leading blocks (or a separator) must not claim it early.
		let liveRecorded = false;
		for (let i = 0; i < count; i++) {
			const child = this.children[i]! as Component & SnapshotCarrier;

			// Resolve this child's contribution — its visible body with plain-blank
			// top/bottom edges stripped (the container owns inter-block gaps). On
			// ED3-risk terminals a frozen, scrolled-off block replays its snapshot
			// instead of recomputing; a stale generation (post-thaw) or width
			// mismatch (resize) recomputes, as does a block still live last frame.
			let contribution: string[] | undefined;
			const previousSnapshot = risk ? child[kSnapshot] : undefined;
			if (risk && i < liveStartIndex && i < replayCutoff) {
				if (hasValidSnapshot(previousSnapshot, width, this.#generation)) {
					contribution = previousSnapshot.lines;
				}
			}
			let liveCommitState: LiveCommitState | undefined;
			if (contribution === undefined) {
				const rendered = child.render(width);
				contribution = stripPlainBlankEdges(rendered);
				if (risk && i >= liveStartIndex && !isBlockFinalized(child)) {
					liveCommitState = deriveLiveCommitState(previousSnapshot, contribution, width, this.#generation);
				}
				// Cache every block's latest contribution. While a block is in the
				// live region this keeps its snapshot current; on the frame it crosses
				// out, the recompute above refreshes it before it freezes.
				if (risk) {
					child[kSnapshot] = {
						width,
						lines: contribution,
						generation: this.#generation,
						appendOnly: liveCommitState?.appendOnly ?? false,
						volatileCooldown: liveCommitState?.volatileCooldown ?? 0,
					};
				}
			}

			// Empty (or stripped-to-nothing) children contribute nothing and never
			// affect spacing or the live-region offsets. An empty still-live child
			// still closes the commit-safe run: if it later gains rows, it pushes
			// everything below it.
			if (contribution.length === 0) {
				if (risk && i >= liveStartIndex && commitSafeOpen && !isBlockFinalized(child)) commitSafeOpen = false;
				continue;
			}

			// Every block is separated from preceding visible content by exactly one
			// blank row — skipped when it opens the transcript or the prior row is
			// already a plain blank (a fragment's own trailing pad), never doubling.
			const sep = lines.length > 0 && !isPlainBlank(lines[lines.length - 1]!) ? 1 : 0;

			// The separator before the first live block stays in the committed prefix
			// (it is deterministic and never changes once the prior block is frozen),
			// so the live region begins at the block's first content row.
			if (risk && !liveRecorded && i >= liveStartIndex) {
				this.#nativeScrollbackLiveRegionStart = lines.length + sep;
				liveRecorded = true;
			}

			if (sep) lines.push("");
			const blockStart = lines.length;
			for (let j = 0; j < contribution.length; j++) lines.push(contribution[j]!);

			if (risk && i >= liveStartIndex && commitSafeOpen) {
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
