import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CompactionEnvelope, validateCompactionEnvelope } from "../src/core/compaction/transaction.ts";
import { type CompactionEntry, type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

function sourceDigest(entries: readonly SessionEntry[]): string {
	return createHash("sha256")
		.update(entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8")
		.digest("hex");
}

function envelopeFor(session: SessionManager, summary: string): CompactionEnvelope {
	const entries = session.getBranch();
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

function entryEnvelope(entry: CompactionEntry): CompactionEnvelope {
	if (typeof entry.details !== "object" || entry.details === null) throw new Error("expected compaction details");
	return validateCompactionEnvelope(Reflect.get(entry.details, "compactionEnvelope"));
}

function persistedRecords(path: string): Record<string, unknown>[] {
	return readFileSync(path, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function mutableEnvelope(record: Record<string, unknown>): Record<string, unknown> {
	const details = record.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) throw new Error("expected details");
	const envelope = Reflect.get(details, "compactionEnvelope");
	if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope))
		throw new Error("expected envelope");
	return envelope as Record<string, unknown>;
}

describe("branched session compaction provenance", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-session-compaction-branch-"));
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("rebinds copied envelopes to the new session and rewritten source digests", () => {
		// Given: a persisted branch with two envelopes, where the second hashes the first.
		const session = SessionManager.create(root, root);
		session.appendMessage(userMsg("first"));
		session.appendMessage(assistantMsg("answer"));
		const firstSource = session.getEntries()[0];
		if (!firstSource) throw new Error("expected first source entry");
		const firstSummary = "first compacted summary";
		const firstCompactionId = session.appendCompaction(firstSummary, firstSource.id, 100, {
			compactionEnvelope: envelopeFor(session, firstSummary),
		});
		session.appendMessage(userMsg("after compaction"));
		session.appendMessage(assistantMsg("after answer"));
		const secondSummary = "second compacted summary";
		const secondEnvelopeBefore = envelopeFor(session, secondSummary);
		const secondCompactionId = session.appendCompaction(secondSummary, firstSource.id, 120, {
			compactionEnvelope: secondEnvelopeBefore,
		});

		// When: the active path is copied into a new durable session and reopened.
		const newFile = session.createBranchedSession(secondCompactionId);
		if (!newFile) throw new Error("expected branched session path");
		const reopened = SessionManager.open(newFile, root);

		// Then: both envelopes bind to the new ID and the nested source is rehashed.
		const compactions = reopened
			.getEntries()
			.filter((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(compactions.map((entry) => entry.id)).toEqual([firstCompactionId, secondCompactionId]);
		const firstEnvelope = entryEnvelope(compactions[0]);
		const secondEnvelope = entryEnvelope(compactions[1]);
		expect(firstEnvelope.source.sessionId).toBe(reopened.getSessionId());
		expect(secondEnvelope.source.sessionId).toBe(reopened.getSessionId());
		expect(secondEnvelope.source.sourceSha256).not.toBe(secondEnvelopeBefore.source.sourceSha256);
		const byId = new Map(reopened.getEntries().map((entry) => [entry.id, entry]));
		const reboundSource = secondEnvelope.source.entryIds.map((id) => byId.get(id));
		expect(reboundSource.every((entry) => entry !== undefined)).toBe(true);
		expect(secondEnvelope.source.sourceSha256).toBe(
			sourceDigest(reboundSource.filter((entry) => entry !== undefined)),
		);
		const records = persistedRecords(newFile);
		const secondIndex = records.findIndex((entry) => entry.id === secondCompactionId);
		const prefixBytes = `${records
			.slice(0, secondIndex)
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		expect(secondEnvelope.baseRevision).toMatchObject({
			sessionId: reopened.getSessionId(),
			completeBytes: Buffer.byteLength(prefixBytes),
			recordCount: secondIndex,
			leafId: compactions[1].parentId,
			completePrefixSha256: createHash("sha256").update(prefixBytes).digest("hex"),
		});
	});

	it("preserves a label referenced by compaction source while branching", () => {
		// Given: a compaction source whose active branch ends in a persisted label.
		const session = SessionManager.create(root, root);
		session.appendMessage(userMsg("labeled source"));
		const answerId = session.appendMessage(assistantMsg("labeled answer"));
		const labelId = session.appendLabelChange(answerId, "checkpoint");
		const source = session.getEntries()[0];
		if (!source) throw new Error("expected source entry");
		const summary = "labeled compacted summary";
		const compactionId = session.appendCompaction(summary, source.id, 90, {
			compactionEnvelope: envelopeFor(session, summary),
		});

		// When: the compaction branch is copied and reopened.
		const newFile = session.createBranchedSession(compactionId);
		if (!newFile) throw new Error("expected branched session path");
		const reopened = SessionManager.open(newFile, root);

		// Then: source order and digest still include the original label identity.
		const compaction = reopened.getEntry(compactionId);
		if (!compaction || compaction.type !== "compaction") throw new Error("expected compaction");
		const envelope = entryEnvelope(compaction);
		expect(envelope.source.entryIds).toContain(labelId);
		const byId = new Map(reopened.getEntries().map((entry) => [entry.id, entry]));
		const rebound = envelope.source.entryIds.map((id) => byId.get(id));
		expect(rebound.every((entry) => entry !== undefined)).toBe(true);
		expect(envelope.source.sourceSha256).toBe(sourceDigest(rebound.filter((entry) => entry !== undefined)));
		expect(reopened.getLabel(answerId)).toBe("checkpoint");
	});

	it.each(["base revision", "source order", "source digest"] as const)(
		"rejects persisted compaction %s tampering on reopen",
		(tamper) => {
			// Given: a valid persisted compaction with a four-entry source.
			const session = SessionManager.create(root, root);
			session.appendMessage(userMsg("one"));
			session.appendMessage(assistantMsg("two"));
			session.appendMessage(userMsg("three"));
			session.appendMessage(assistantMsg("four"));
			const source = session.getEntries()[0];
			if (!source) throw new Error("expected source entry");
			const summary = "tamper target summary";
			session.appendCompaction(summary, source.id, 80, { compactionEnvelope: envelopeFor(session, summary) });
			const path = session.getSessionFile();
			if (!path) throw new Error("expected persisted path");
			const records = persistedRecords(path);
			const compaction = records.find((record) => record.type === "compaction");
			if (!compaction) throw new Error("expected persisted compaction");
			const envelope = mutableEnvelope(compaction);
			const baseRevision = Reflect.get(envelope, "baseRevision");
			const sourceIdentity = Reflect.get(envelope, "source");
			if (typeof baseRevision !== "object" || baseRevision === null || Array.isArray(baseRevision))
				throw new Error("expected base revision");
			if (typeof sourceIdentity !== "object" || sourceIdentity === null || Array.isArray(sourceIdentity))
				throw new Error("expected source identity");
			if (tamper === "base revision") {
				Reflect.set(baseRevision, "completeBytes", Number(Reflect.get(baseRevision, "completeBytes")) + 1);
			} else if (tamper === "source order") {
				const ids = Reflect.get(sourceIdentity, "entryIds");
				if (!Array.isArray(ids) || ids.length < 4) throw new Error("expected source IDs");
				const reordered = [ids[0], ids[2], ids[1], ids[3]];
				Reflect.set(sourceIdentity, "entryIds", reordered);
				const byId = new Map(records.map((record) => [record.id, record]));
				Reflect.set(
					sourceIdentity,
					"sourceSha256",
					createHash("sha256")
						.update(reordered.map((id) => JSON.stringify(byId.get(id))).join("\n"), "utf8")
						.digest("hex"),
				);
			} else {
				Reflect.set(sourceIdentity, "sourceSha256", "0".repeat(64));
			}
			writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

			// When/Then: reopening recomputes provenance from the persisted prefix and fails closed.
			expect(() => SessionManager.open(path, root)).toThrow(/envelope|doctor/i);
		},
	);
});
