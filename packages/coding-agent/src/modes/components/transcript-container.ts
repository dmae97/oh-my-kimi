import { type Component, Container, type NativeScrollbackLiveRegion, TERMINAL } from "@oh-my-pi/pi-tui";

const kSnapshot = Symbol("transcript.frozenRender");

interface FrozenRender {
	width: number;
	lines: string[];
	generation: number;
}

interface SnapshotCarrier {
	[kSnapshot]?: FrozenRender;
}

/**
 * A transcript block that is still mutating (a foreground tool awaiting its
 * result, an assistant message mid-stream) reports `false` so the container
 * keeps it inside the live (repaintable) region instead of freezing it. Blocks
 * without the method are treated as finalized — the default, stable behavior.
 *
 * `isTranscriptBlockAppendOnly` marks a still-live block whose rendered rows
 * only grow at the bottom and never re-layout (a streaming assistant reply).
 * Such a block's scrolled-off head is safe to commit to native scrollback even
 * while live; blocks that omit it (tool previews that collapse to a compact
 * result) keep their mutable rows deferred. Default is `false`.
 */
interface FinalizableBlock {
	isTranscriptBlockFinalized?(): boolean;
	isTranscriptBlockAppendOnly?(): boolean;
}

function isBlockFinalized(child: Component): boolean {
	const fn = (child as Component & FinalizableBlock).isTranscriptBlockFinalized;
	return fn ? fn.call(child) : true;
}

function isBlockAppendOnly(child: Component): boolean {
	const fn = (child as Component & FinalizableBlock).isTranscriptBlockAppendOnly;
	return fn ? fn.call(child) : false;
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
	// Local line index up to which the leading run of live blocks is append-only
	// (a streaming assistant reply): everything in [liveRegionStart,
	// commitSafeEnd) only grows at the bottom and never re-layouts, so its
	// scrolled-off head is safe to commit to native scrollback. `undefined` when
	// the first live block is volatile (a tool preview).
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
		// Tracks whether we are still inside the leading run of append-only live
		// blocks. The first non-append-only live block closes it.
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
			if (risk && i < liveStartIndex && i < replayCutoff) {
				const snapshot = child[kSnapshot];
				if (snapshot && snapshot.generation === this.#generation && snapshot.width === width) {
					contribution = snapshot.lines;
				}
			}
			if (contribution === undefined) {
				const rendered = child.render(width);
				contribution = stripPlainBlankEdges(rendered);
				// Cache every block's latest contribution. While a block is in the
				// live region this keeps its snapshot current; on the frame it crosses
				// out, the recompute above refreshes it before it freezes.
				if (risk) child[kSnapshot] = { width, lines: contribution, generation: this.#generation };
			}

			// Empty (or stripped-to-nothing) children contribute nothing and never
			// affect spacing or the live-region offsets.
			if (contribution.length === 0) continue;

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
			for (let j = 0; j < contribution.length; j++) lines.push(contribution[j]!);

			// Extend the commit-safe boundary through each leading append-only live
			// block. The first volatile live block closes the run so its mutable
			// rows stay deferred.
			if (risk && i >= liveStartIndex && commitSafeOpen) {
				if (isBlockAppendOnly(child)) {
					this.#nativeScrollbackCommitSafeEnd = lines.length;
				} else {
					commitSafeOpen = false;
				}
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
