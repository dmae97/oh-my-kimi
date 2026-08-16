import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { inspectRunJournal } from "../src/core/run-journal.ts";
import { RunJournalStore, RunJournalStoreStaleWriteError } from "../src/core/run-journal-store.ts";

const safeId = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/);

describe("run journal race properties", () => {
	it("rejects every stale CAS append without forking the durable chain", () => {
		fc.assert(
			fc.property(
				safeId,
				safeId,
				fc.nat({ max: 10_000 }),
				fc.boolean(),
				(firstId, secondId, revision, swapWinner) => {
					fc.pre(firstId !== secondId);
					const root = mkdtempSync(join(tmpdir(), "omk-run-journal-property-"));
					const journalPath = join(root, "session.runjournal");
					try {
						const first = RunJournalStore.open({ journalPath, sessionId: "property-session" });
						const second = RunJournalStore.open({ journalPath, sessionId: "property-session" });
						const winner = swapWinner ? second : first;
						const stale = swapWinner ? first : second;
						const winnerId = swapWinner ? secondId : firstId;
						const staleId = swapWinner ? firstId : secondId;

						winner.start({ runId: winnerId, sessionRevision: revision, timestamp: "2026-08-16T00:00:00.000Z" });
						expect(() =>
							stale.start({ runId: staleId, sessionRevision: revision, timestamp: "2026-08-16T00:00:00.000Z" }),
						).toThrow(RunJournalStoreStaleWriteError);
						expect(stale.records).toEqual([]);
						expect(stale.openRunId).toBeNull();

						const report = inspectRunJournal(readFileSync(journalPath), RunJournalStore.sha256);
						expect(report.findings.filter((finding) => finding.code !== "run_unclosed")).toEqual([]);
						expect(report.records).toHaveLength(1);
						expect(report.records[0]).toMatchObject({ event: "run_started", runId: winnerId });
					} finally {
						rmSync(root, { recursive: true, force: true });
					}
				},
			),
			{ numRuns: 30, seed: 0x0fc52026 },
		);
	});
});
