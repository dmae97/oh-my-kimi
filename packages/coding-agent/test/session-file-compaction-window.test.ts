import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CompactionEnvelope, validateCompactionEnvelope } from "../src/core/compaction/transaction.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

function sourceDigest(entries: readonly SessionEntry[]): string {
	return createHash("sha256")
		.update(entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8")
		.digest("hex");
}

function envelopeForEntries(
	session: SessionManager,
	entries: readonly SessionEntry[],
	summary: string,
): CompactionEnvelope {
	const first = entries[0];
	const last = entries.at(-1);
	if (!first || !last) throw new Error("expected compaction source entries");
	const revision = session.getDurableHeadToken();
	return validateCompactionEnvelope({
		schemaVersion: 2,
		transactionId: `txn-${last.id}`,
		baseRevision: revision,
		source: {
			sessionId: session.getSessionId(),
			entryIds: entries.map((entry) => entry.id),
			firstEntryId: first.id,
			lastEntryId: last.id,
			sourceSha256: sourceDigest(entries),
			activeLeafId: last.id,
			messageCount: session.buildSessionContext().messages.length,
		},
		createdAt: "2026-07-19T00:00:00.000Z",
		model: { provider: "test", id: "model" },
		summary,
		summarySha256: createHash("sha256").update(summary, "utf8").digest("hex"),
		preserved: {
			latestIntent: "continue",
			openTasks: [],
			laneIds: [],
			acceptancePredicateIds: [],
			evidenceReceiptIds: [],
			blockerReasons: [],
			repairEventIds: [],
			branch: null,
			worktree: null,
			modelHistory: [],
			nextAction: "continue",
		},
	});
}

describe("persisted compaction window provenance", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-session-compaction-window-"));
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("reopens a twice-compacted session whose second envelope attests the kept window", () => {
		// Given: a session compacted once, where the kept window starts at the last
		// pre-compaction message (the real writer behavior: firstKeptEntryId == leaf).
		const session = SessionManager.create(root, root);
		session.appendMessage(userMsg("one"));
		const m2 = session.appendMessage(assistantMsg("two"));
		const summary1 = "first compacted summary";
		const branch1 = session.getBranch();
		session.appendCompaction(summary1, m2, 100, {
			compactionEnvelope: envelopeForEntries(session, branch1, summary1),
		});
		session.appendMessage(userMsg("three"));
		const m4 = session.appendMessage(assistantMsg("four"));

		// And: a second compaction whose envelope attests the writer's kept-window
		// slice (from the previous compaction's firstKeptEntryId onward), which is
		// strictly smaller than the full parent branch.
		const branch2 = session.getBranch();
		const windowStart = branch2.findIndex((entry) => entry.id === m2);
		expect(windowStart).toBeGreaterThan(0); // window must be smaller than full branch
		const windowed = branch2.slice(windowStart);
		expect(windowed.length).toBeLessThan(branch2.length);
		const summary2 = "second compacted summary";
		session.appendCompaction(summary2, m4, 200, {
			compactionEnvelope: envelopeForEntries(session, windowed, summary2),
		});
		const path = session.getSessionFile();
		if (!path) throw new Error("expected persisted path");

		// When: the persisted session is reopened.
		const reopened = SessionManager.open(path, root);

		// Then: both compactions validate instead of failing source verification.
		const compactions = reopened.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactions).toHaveLength(2);
	});

	it("still rejects a tampered second-window source on reopen", () => {
		// Given: the same twice-compacted session.
		const session = SessionManager.create(root, root);
		session.appendMessage(userMsg("one"));
		const m2 = session.appendMessage(assistantMsg("two"));
		const summary1 = "first compacted summary";
		session.appendCompaction(summary1, m2, 100, {
			compactionEnvelope: envelopeForEntries(session, session.getBranch(), summary1),
		});
		session.appendMessage(userMsg("three"));
		const m4 = session.appendMessage(assistantMsg("four"));
		const branch2 = session.getBranch();
		const windowed = branch2.slice(branch2.findIndex((entry) => entry.id === m2));
		const summary2 = "second compacted summary";
		const secondId = session.appendCompaction(summary2, m4, 200, {
			compactionEnvelope: envelopeForEntries(session, windowed, summary2),
		});
		const path = session.getSessionFile();
		if (!path) throw new Error("expected persisted path");

		// When: the second envelope's source ids are tampered (swap two ids —
		// same length, so it passes schema shape but fails order + digest match).
		const raw = readFileSync(path, "utf8");
		const lines = raw.trimEnd().split("\n");
		const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
		const target = records.find((record) => record.id === secondId);
		if (!target) throw new Error("expected second compaction record");
		const details = target.details as Record<string, unknown>;
		const envelope = Reflect.get(details, "compactionEnvelope") as Record<string, unknown>;
		const source = Reflect.get(envelope, "source") as Record<string, unknown>;
		const ids = Reflect.get(source, "entryIds") as string[];
		if (ids.length < 3) throw new Error("expected at least three source ids");
		const swapped = [...ids];
		[swapped[1], swapped[2]] = [swapped[2], swapped[1]];
		Reflect.set(source, "entryIds", swapped);
		writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

		// Then: reopen still fails source verification.
		expect(() => SessionManager.open(path, root)).toThrowError(/Invalid compaction envelope source/);
	});
});
