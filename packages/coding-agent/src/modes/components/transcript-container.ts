import { type Component, Container, TERMINAL } from "@oh-my-pi/pi-tui";

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
export class TranscriptContainer extends Container {
	// Bumped to invalidate every block's snapshot at once; a snapshot is only
	// honored when its stored generation still matches.
	#generation = 0;

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
		if (!TERMINAL.eagerEraseScrollbackRisk) return super.render(width);

		const lines: string[] = [];
		const liveIndex = this.children.length - 1;
		for (let i = 0; i < this.children.length; i++) {
			const child = this.children[i]! as Component & SnapshotCarrier;
			if (i !== liveIndex) {
				const snapshot = child[kSnapshot];
				// Replay the block's last render from while it was live. A stale
				// generation (post-thaw) or width mismatch (resize in flight, an
				// explicit rebuild that reconciles history anyway) recomputes instead.
				if (snapshot && snapshot.generation === this.#generation && snapshot.width === width) {
					lines.push(...snapshot.lines);
					continue;
				}
			}
			const rendered = child.render(width);
			// Cache every block's latest render. While a block is live this keeps its
			// snapshot current; the frame it stops being live the cache already holds
			// its final live render, so nothing recomputes underneath it.
			child[kSnapshot] = { width, lines: rendered, generation: this.#generation };
			lines.push(...rendered);
		}
		return lines;
	}
}
