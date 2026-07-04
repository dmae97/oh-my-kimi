/**
 * Pins the session-chain replay fast-path against an anchor-content
 * corruption window: when a prior in-session edit rewrote the line a
 * later stale-hash edit re-targets, replaying onto current must refuse
 * (the model is anchored against content that no longer exists), not
 * silently overwrite the new content with the stale-authored payload.
 *
 * Companion positive cases: unchanged equal-line anchors still replay with the
 * standard session-chain banner, and anchors shifted by prior insertions remap
 * to the same logical line before replay.
 */
import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	InMemorySnapshotStore,
	parsePatch,
	RECOVERY_LINE_REMAP_WARNING,
	RECOVERY_SESSION_REPLAY_WARNING,
	Recovery,
} from "@oh-my-pi/hashline";

const PATH = "/tmp/__hashline-recovery-session-chain__.ts";

function lines(...rows: string[]): string {
	return `${rows.join("\n")}\n`;
}

function seedTwoSnapshots(): { store: InMemorySnapshotStore; v0Text: string; v1Text: string; h0: string; h1: string } {
	const store = new InMemorySnapshotStore();
	const v0Lines = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"];
	const v1Lines = [...v0Lines];
	v1Lines[4] = "L5-CHANGED";
	const v0Text = `${v0Lines.join("\n")}\n`;
	const v1Text = `${v1Lines.join("\n")}\n`;
	const h0 = store.record(PATH, v0Text);
	const h1 = store.record(PATH, v1Text);
	return { store, v0Text, v1Text, h0, h1 };
}

describe("Recovery — session-chain replay anchor-content gate", () => {
	it("refuses replay when an edit anchor's line content diverges between snapshot and current", () => {
		const { store, v1Text, h0 } = seedTwoSnapshots();
		// Edit anchored at line 5 — the exact line the prior in-session edit
		// rewrote. Replaying onto current would overwrite "L5-CHANGED" with
		// payload the model authored against the stale "L5". That is
		// corruption, not recovery.
		const { edits } = parsePatch("SWAP 5.=5:\n|L5-MODEL");

		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1Text,
			fileHash: h0,
			edits,
		});

		expect(recovered).toBeNull();
	});

	it("replays edits onto current when every anchor's line content is unchanged", () => {
		const { store, v1Text, h0 } = seedTwoSnapshots();
		// Edit anchored at line 3 — unchanged between v0 and v1. The 3-way
		// merge fails (patch context includes the rewritten line 5), but the
		// replay fallback is safe because the model's anchor still names the
		// same logical content.
		const { edits } = parsePatch("SWAP 3.=3:\n|L3-MODEL");

		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1Text,
			fileHash: h0,
			edits,
		});

		expect(recovered).not.toBeNull();
		expect(recovered?.text).toContain("L3-MODEL");
		// Prior in-session change must survive — the model's edit lands on
		// top of current, not on top of the stale snapshot.
		expect(recovered?.text).toContain("L5-CHANGED");
		// The replay path is the less-certain recovery mode (a coincidental
		// insert+delete pair earlier in the chain could leave indices
		// pointing at duplicated rows even with both guards satisfied), so
		// the dedicated REPLAY warning surfaces a "verify the diff" hedge.
		expect(recovered?.warnings).toContain(RECOVERY_SESSION_REPLAY_WARNING);
	});

	it("recovers stale anchors shifted by a prior in-session insertion", () => {
		const store = new InMemorySnapshotStore();
		const v0Text = lines("L1", "L2", "L3", "L4", "L5", "L6");
		const h0 = store.record(PATH, v0Text);
		const v1Text = lines("L1", "L2", "INSERTED", "L3", "L4", "L5", "L6");
		store.record(PATH, v1Text);
		const { edits } = parsePatch("SWAP 5.=5:\n+L5-MODEL");

		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1Text,
			fileHash: h0,
			edits,
		});

		expect(recovered).not.toBeNull();
		expect(recovered?.text).toBe(lines("L1", "L2", "INSERTED", "L3", "L4", "L5-MODEL", "L6"));
		expect(recovered?.warnings).toContain(RECOVERY_LINE_REMAP_WARNING);
	});

	it("recovers stale anchors shifted by a prior in-session deletion", () => {
		const store = new InMemorySnapshotStore();
		const v0Text = lines("L1", "L2", "L3", "L4", "L5", "L6");
		const h0 = store.record(PATH, v0Text);
		const v1Text = lines("L1", "L3", "L4", "L5", "L6");
		store.record(PATH, v1Text);
		const { edits } = parsePatch("SWAP 5.=5:\n+L5-MODEL");

		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1Text,
			fileHash: h0,
			edits,
		});

		expect(recovered).not.toBeNull();
		expect(recovered?.text).toBe(lines("L1", "L3", "L4", "L5-MODEL", "L6"));
		expect(recovered?.warnings).toContain(RECOVERY_LINE_REMAP_WARNING);
	});

	it("refuses duplicate-line remaps when surrounding context no longer matches", () => {
		const store = new InMemorySnapshotStore();
		const v0Text = lines("start", "DUP", "mid", "DUP", "tail");
		const h0 = store.record(PATH, v0Text);
		const v1Text = lines("start", "mid", "DUP", "CHANGED", "tail");
		store.record(PATH, v1Text);
		const { edits } = parsePatch("SWAP 4.=4:\n+MODEL");

		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1Text,
			fileHash: h0,
			edits,
		});

		expect(recovered).toBeNull();
	});

	it("refuses unique-line remaps when following context no longer matches", () => {
		const store = new InMemorySnapshotStore();
		const v0Text = lines("L1", "L2", "L3", "L4", "T", "L6");
		const h0 = store.record(PATH, v0Text);
		const v1Text = lines("X", "L1", "L2", "L3", "L4", "T", "T_CHANGED", "L6");
		store.record(PATH, v1Text);
		const { edits } = parsePatch("SWAP 5.=5:\n+MODEL");

		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1Text,
			fileHash: h0,
			edits,
		});

		expect(recovered).toBeNull();
	});

	it("recovers duplicate-line anchors shifted by a prior insertion when context still matches", () => {
		// Remap-parity pin for the linearized validator: an anchor RANGE
		// covering a duplicated line ("DUP" appears twice) plus a unique line
		// must still remap through a prior insertion — the duplicate-context
		// and unique-context branches both accept exactly as before.
		const store = new InMemorySnapshotStore();
		const v0Text = lines("alpha", "DUP", "beta", "DUP", "omega");
		const h0 = store.record(PATH, v0Text);
		const v1Text = lines("alpha", "INSERTED", "DUP", "beta", "DUP", "omega");
		store.record(PATH, v1Text);
		const { edits } = parsePatch("SWAP 3.=4:\n+B-MODEL\n+MODEL");

		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1Text,
			fileHash: h0,
			edits,
		});

		expect(recovered).not.toBeNull();
		expect(recovered?.text).toBe(lines("alpha", "INSERTED", "DUP", "B-MODEL", "MODEL", "omega"));
		expect(recovered?.warnings).toContain(RECOVERY_LINE_REMAP_WARNING);
	});
});

/**
 * Brute-force two distinct texts sharing one 4-hex tag. 16-bit tags collide
 * within a few hundred candidates (birthday bound), so this stays cheap.
 * Texts share `template` around a varying middle line so line-anchored edits
 * against one collider are plausible-but-wrong against the other.
 */
function findCollidingTexts(): { older: string; newer: string } {
	const textFor = (n: number): string => lines("shared head", `unique payload ${n}`, "shared tail");
	const byTag = new Map<string, number>();
	for (let n = 0; ; n++) {
		const text = textFor(n);
		const tag = computeFileHash(text);
		const prior = byTag.get(tag);
		if (prior !== undefined) return { older: textFor(prior), newer: text };
		byTag.set(tag, n);
	}
}

describe("Recovery — colliding snapshot tags", () => {
	it("recovers against the most-recently retained text when two colliders share the tag", () => {
		const { older, newer } = findCollidingTexts();
		const tag = computeFileHash(older);
		expect(computeFileHash(newer)).toBe(tag);
		expect(newer).not.toBe(older);

		const store = new InMemorySnapshotStore();
		store.record(PATH, older);
		store.record(PATH, newer);

		// Live drifted away from both colliders, so recovery cannot shortcut
		// via live==snapshot. The tag cannot name a unique base; it resolves
		// to the most-recently recorded collider and 3-way merges from there.
		const currentText = `${newer}drifted trailer\n`;
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText,
			fileHash: tag,
			edits: parsePatch("SWAP 2.=2:\n+model payload").edits,
		});

		expect(recovered?.text).toBe(lines("shared head", "model payload", "shared tail", "drifted trailer"));
	});

	it("still recovers when exactly one retained text carries the tag", () => {
		// Same drift scenario with a single retained text for the tag: the
		// plain 3-way merge path.
		const { older } = findCollidingTexts();
		const store = new InMemorySnapshotStore();
		const tag = store.record(PATH, older);

		const currentText = `${older}drifted trailer\n`;
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText,
			fileHash: tag,
			edits: parsePatch("SWAP 2.=2:\n+model payload").edits,
		});

		expect(recovered).not.toBeNull();
		expect(recovered?.text).toBe(lines("shared head", "model payload", "shared tail", "drifted trailer"));
	});
});
