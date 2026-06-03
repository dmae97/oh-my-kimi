/**
 * Recovery hot-path benchmark.
 *
 * Pin throughput of the session-chain replay path that PR #1422 hardened.
 * After the fix, every replay call walks each edit's anchors and splits both
 * `previousText` and `currentText` to compare per-line content. This bench
 * exists so future optimisation of that walk has a baseline, and so reviewers
 * can confirm the gate is cheap relative to the diff + applyPatch work that
 * dominates the path.
 *
 * Two regimes:
 *   - `accept` — anchor lands on a line unchanged across the prior in-session
 *     edit. 3-way merge on the snapshot still fails (patch context spans the
 *     rewritten neighbour), the new gate passes, and replay onto current
 *     succeeds. End-to-end this exercises diff + applyPatch + applyEdits +
 *     verifyAnchorContent.
 *   - `reject` — anchor lands on the line the prior edit rewrote. 3-way merge
 *     fails, the new gate refuses, and `tryRecover` returns null without
 *     touching `applyEdits`. This is the corruption window PR #1422 closed
 *     and the path users hit when re-targeting stale lines.
 *
 * Sizes (50/500/5000 lines) × edit batch (1/8 anchors) so the O(N) split cost
 * in `verifyAnchorContent` and the O(K) anchor walk both surface.
 */
import { InMemorySnapshotStore, parsePatch, RECOVERY_SESSION_REPLAY_WARNING, Recovery } from "../src";

const ITERATIONS = Number(Bun.env.HASHLINE_BENCH_ITERATIONS ?? "5000");
const PATH = "/tmp/__hashline-recovery-bench__.ts";

interface Fixture {
	store: InMemorySnapshotStore;
	v1Text: string;
	h0: string;
}

/**
 * Seed two snapshots: v0 → v1 where v1 differs only at `rewrittenLine`. The
 * recovery driver will fetch v0 by hash and replay onto v1.
 */
function seed(lines: number, rewrittenLine: number): Fixture {
	const v0Lines = Array.from({ length: lines }, (_, i) => `line ${i + 1} content`);
	const v1Lines = [...v0Lines];
	v1Lines[rewrittenLine - 1] = `line ${rewrittenLine} REWRITTEN`;
	const v0Text = `${v0Lines.join("\n")}\n`;
	const v1Text = `${v1Lines.join("\n")}\n`;
	const store = new InMemorySnapshotStore();
	const h0 = store.record(PATH, v0Text);
	store.record(PATH, v1Text);
	return { store, v1Text, h0 };
}

/** Build an N-anchor edit batch whose anchor lines are distinct rows. */
function batchPatch(anchors: readonly number[]): string {
	return anchors.map(line => `${line}-${line}:\n|line ${line} MODEL`).join("\n");
}

interface Case {
	name: string;
	lines: number;
	anchors: number[];
	rewrittenLine: number;
}

const cases: Case[] = [];
for (const size of [50, 500, 5000] as const) {
	const rewritten = Math.floor(size / 2);
	// Anchors spread across the file so verifyAnchorContent must walk real
	// distances, not just hammer the same cache line.
	const sparse = [Math.max(1, Math.floor(size / 8))];
	const dense = [
		Math.max(1, Math.floor(size / 9)),
		Math.max(1, Math.floor(size / 8)),
		Math.max(1, Math.floor(size / 7)),
		Math.max(1, Math.floor(size / 6)),
		Math.max(1, Math.floor(size / 5)),
		Math.max(1, Math.floor(size / 4)),
		Math.max(1, Math.floor(size / 3)),
		Math.max(2, Math.floor((size * 2) / 3)),
	];
	// Accept regime: the rewrite is the immediate neighbour of the first
	// anchor (≤3 lines), so the patch hunk's context spans the rewrite and
	// the 3-way merge fails atomically — forcing the replay path. Reject
	// regime: the rewrite IS the anchor, so verifyAnchorContent refuses.
	const acceptRewrite = sparse[0] - 1;
	const acceptRewriteDense = dense[0] - 1;
	cases.push(
		{ name: `accept ${size}L ×1 anchor`, lines: size, anchors: sparse, rewrittenLine: acceptRewrite },
		{ name: `accept ${size}L ×8 anchors`, lines: size, anchors: dense, rewrittenLine: acceptRewriteDense },
		{ name: `reject ${size}L ×1 anchor`, lines: size, anchors: [rewritten], rewrittenLine: rewritten },
	);
}

function bench(name: string, fn: () => void): { totalMs: number; perOpUs: number } {
	// Warm: JIT + InMemorySnapshotStore map/ring touches.
	for (let i = 0; i < Math.min(50, ITERATIONS); i++) fn();
	const start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) fn();
	const elapsed = Bun.nanoseconds() - start;
	const totalMs = elapsed / 1e6;
	const perOpUs = elapsed / ITERATIONS / 1e3;
	console.log(`  ${name.padEnd(28)}  ${totalMs.toFixed(2).padStart(8)}ms  ${perOpUs.toFixed(3).padStart(8)}µs/op`);
	return { totalMs, perOpUs };
}

console.log(`Recovery session-chain replay (${ITERATIONS} iterations per case)`);
console.log("Path: Recovery.tryRecover → applyEditsToSnapshot (3-way merge fails)");
console.log("      → replaySessionChainOnCurrent → verifyAnchorContent (new gate)\n");

let expectedNonNullVerified = 0;
let expectedNullVerified = 0;

for (const c of cases) {
	const isReject = c.name.startsWith("reject");
	const { store, v1Text, h0 } = seed(c.lines, c.rewrittenLine);
	const recovery = new Recovery(store);
	const { edits } = parsePatch(batchPatch(c.anchors));
	const args = { path: PATH, currentText: v1Text, fileHash: h0, edits };

	// Sanity: every iteration must hit the expected branch. Otherwise the
	// numbers measure the wrong path. Accept cases additionally must surface
	// RECOVERY_SESSION_REPLAY_WARNING — its only emitter is the replay
	// fallback past verifyAnchorContent, so its absence proves we never
	// reached the gate this bench is supposed to pin.
	const probe = recovery.tryRecover(args);
	if (isReject) {
		if (probe !== null) throw new Error(`expected null for ${c.name}, got recovery`);
		expectedNullVerified++;
	} else {
		if (probe === null) throw new Error(`expected recovery for ${c.name}, got null`);
		if (!probe.warnings.includes(RECOVERY_SESSION_REPLAY_WARNING)) {
			throw new Error(
				`expected ${c.name} to surface RECOVERY_SESSION_REPLAY_WARNING (the only signal that the replay path executed); got warnings=${JSON.stringify(probe.warnings)}`,
			);
		}
		expectedNonNullVerified++;
	}

	bench(c.name, () => {
		recovery.tryRecover(args);
	});
}

console.log(
	`\nSanity: ${expectedNonNullVerified} accept-path + ${expectedNullVerified} reject-path branches verified before timing.`,
);
