/**
 * Pins the session-chain replay fast-path against an anchor-content
 * corruption window: when a prior in-session edit rewrote the line a
 * later stale-hash edit re-targets, replaying onto current must refuse
 * (the model is anchored against content that no longer exists), not
 * silently overwrite the new content with the stale-authored payload.
 *
 * Companion positive case: when the prior edit changed lines elsewhere
 * but left the re-targeted line alone, replay must still succeed and
 * surface the standard session-chain banner.
 */
import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	InMemorySnapshotStore,
	parsePatch,
	RECOVERY_SESSION_REPLAY_WARNING,
	Recovery,
} from "@oh-my-pi/hashline";

const PATH = "/tmp/__hashline-recovery-session-chain__.ts";

function seedTwoSnapshots(): { store: InMemorySnapshotStore; v0Text: string; v1Text: string; h0: string; h1: string } {
	const store = new InMemorySnapshotStore();
	const v0Lines = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"];
	const v1Lines = [...v0Lines];
	v1Lines[4] = "L5-CHANGED";
	const v0Text = `${v0Lines.join("\n")}\n`;
	const v1Text = `${v1Lines.join("\n")}\n`;
	const h0 = computeFileHash(v0Text);
	const h1 = computeFileHash(v1Text);
	store.recordContiguous(PATH, 1, v0Text.split("\n"), { fullText: v0Text, fileHash: h0 });
	store.recordContiguous(PATH, 1, v1Text.split("\n"), { fullText: v1Text, fileHash: h1 });
	return { store, v0Text, v1Text, h0, h1 };
}

describe("Recovery — session-chain replay anchor-content gate", () => {
	it("refuses replay when an edit anchor's line content diverges between snapshot and current", () => {
		const { store, v1Text, h0 } = seedTwoSnapshots();
		// Edit anchored at line 5 — the exact line the prior in-session edit
		// rewrote. Replaying onto current would overwrite "L5-CHANGED" with
		// payload the model authored against the stale "L5". That is
		// corruption, not recovery.
		const { edits } = parsePatch("5-5:\n+L5-MODEL");

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
		const { edits } = parsePatch("3-3:\n+L3-MODEL");

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
});
