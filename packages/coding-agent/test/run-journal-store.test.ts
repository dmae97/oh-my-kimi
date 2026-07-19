import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicRewriteFileSync } from "../src/core/atomic-session-file.ts";
import { acquireDurableFileMutationLockSync, DurableFileLockBusyError } from "../src/core/durable-file-identity.ts";
import { inspectRunJournal } from "../src/core/run-journal.ts";
import {
	appendRunJournalRecordDurably,
	RunJournalStore,
	RunJournalStoreCorruptionError,
	writeQuarantineBytesDurably,
} from "../src/core/run-journal-store.ts";
import { classifySessionTermination } from "../src/core/session-termination.ts";

const SESSION_ID = "session-1";
const T0 = "2026-07-17T00:00:00.000Z";
const T1 = "2026-07-17T00:00:01.000Z";

function completed(runId: string) {
	return classifySessionTermination({
		sessionId: SESSION_ID,
		runId,
		timestamp: T1,
		source: "observed",
		message: "Run completed.",
		cause: { area: "completed" },
		sideEffects: "none",
	});
}

describe("RunJournalStore", () => {
	let root: string;
	let path: string;

	beforeEach(() => {
		root = join(tmpdir(), `omk-run-journal-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		path = join(root, "session.runjournal");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("durably appends lifecycle records without accepting a failed persistence into the in-memory chain", () => {
		let writes = 0;
		const store = RunJournalStore.open({
			journalPath: path,
			sessionId: SESSION_ID,
			now: () => T0,
			persistRecord: (target, line) => {
				writes += 1;
				if (writes === 2) throw new Error("synthetic fsync failure");
				appendRunJournalRecordDurably(target, line);
			},
		});

		store.start({ runId: "run-1", sessionRevision: 0, timestamp: T0 });
		const accepted = store.records;
		const persisted = readFileSync(path);

		expect(() => store.finish({ termination: completed("run-1"), sessionRevision: 1, timestamp: T1 })).toThrow(
			"synthetic fsync failure",
		);
		expect(store.records).toEqual(accepted);
		expect(store.openRunId).toBe("run-1");
		expect(readFileSync(path)).toEqual(persisted);
	});

	it("never truncates concurrent bytes after an indeterminate append failure", () => {
		const concurrent = Buffer.from("concurrent-writer-bytes");
		const store = RunJournalStore.open({
			journalPath: path,
			sessionId: SESSION_ID,
			now: () => T0,
			persistRecord: (target, line) => {
				appendRunJournalRecordDurably(target, line);
				appendFileSync(target, concurrent);
				throw new Error("synthetic post-append failure");
			},
		});

		expect(() => store.start({ runId: "run-1", sessionRevision: 0, timestamp: T0 })).toThrow(
			"synthetic post-append failure",
		);
		expect(store.records).toEqual([]);
		expect(readFileSync(path).subarray(-concurrent.byteLength)).toEqual(concurrent);
	});

	it("quarantines exact trailing bytes and records inferred process-crash recovery for an unclosed valid prefix", () => {
		const first = RunJournalStore.open({ journalPath: path, sessionId: SESSION_ID, now: () => T0 });
		first.start({ runId: "run-crashed", sessionRevision: 3, timestamp: T0 });
		const fragment = Buffer.from('{"partial":', "utf8");
		appendFileSync(path, fragment);

		const recovered = RunJournalStore.open({ journalPath: path, sessionId: SESSION_ID, now: () => T1 });

		expect(recovered.quarantineReport?.byteCount).toBe(fragment.byteLength);
		const quarantinePath = recovered.quarantineReport?.path;
		if (!quarantinePath) throw new Error("expected quarantine path");
		expect(readFileSync(quarantinePath)).toEqual(fragment);
		expect(recovered.records.map((record) => record.event)).toEqual(["run_started", "run_recovered"]);
		const terminal = recovered.records.at(-1);
		expect(terminal?.event).toBe("run_recovered");
		if (terminal?.event === "run_recovered") {
			expect(terminal.termination).toMatchObject({
				kind: "process_crash",
				source: "inferred_on_resume",
				runId: "run-crashed",
			});
		}
		expect(inspectRunJournal(readFileSync(path), RunJournalStore.sha256).ok).toBe(true);
	});

	it("fails closed on hash damage and never rewrites the journal", () => {
		const store = RunJournalStore.open({ journalPath: path, sessionId: SESSION_ID, now: () => T0 });
		store.start({ runId: "run-1", sessionRevision: 0, timestamp: T0 });
		const damaged = readFileSync(path, "utf8").replace(/"hash":"[0-9a-f]{64}"/, `"hash":"${"f".repeat(64)}"`);
		rmSync(path);
		appendFileSync(path, damaged);

		expect(() => RunJournalStore.open({ journalPath: path, sessionId: SESSION_ID, now: () => T1 })).toThrow(
			RunJournalStoreCorruptionError,
		);
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(damaged);
	});

	it("rejects a stale second store without accepting a forked chain", () => {
		// Given: two stores opened the same empty durable journal head.
		const first = RunJournalStore.open({ journalPath: path, sessionId: SESSION_ID, now: () => T0 });
		const stale = RunJournalStore.open({ journalPath: path, sessionId: SESSION_ID, now: () => T0 });
		const accepted = stale.records;

		// When: the first store appends before the stale store.
		first.start({ runId: "run-first", sessionRevision: 1, timestamp: T0 });

		// Then: size/sequence/hash CAS rejects the stale prefix and keeps accepted state unchanged.
		expect(() => stale.start({ runId: "run-stale", sessionRevision: 1, timestamp: T0 })).toThrow(
			/stale|changed|compare-and-swap/i,
		);
		expect(stale.records).toEqual(accepted);
		expect(stale.openRunId).toBeNull();
		const report = inspectRunJournal(readFileSync(path), RunJournalStore.sha256);
		expect(report.records.map((record) => record.runId)).toEqual(["run-first"]);
	});

	it.skipIf(process.platform === "win32")("serializes two stores opened through symlink and hardlink aliases", () => {
		const seed = RunJournalStore.open({ journalPath: path, sessionId: SESSION_ID, now: () => T0 });
		seed.start({ runId: "seed", sessionRevision: 0, timestamp: T0 });
		seed.finish({ termination: completed("seed"), sessionRevision: 1, timestamp: T1 });
		const hardlink = join(root, "hardlink.runjournal");
		const symlink = join(root, "symlink.runjournal");
		linkSync(path, hardlink);
		symlinkSync(path, symlink);
		const winner = RunJournalStore.open({ journalPath: path, sessionId: SESSION_ID, now: () => T1 });
		const hardStale = RunJournalStore.open({ journalPath: hardlink, sessionId: SESSION_ID, now: () => T1 });
		const symlinkStale = RunJournalStore.open({ journalPath: symlink, sessionId: SESSION_ID, now: () => T1 });

		winner.start({ runId: "winner", sessionRevision: 2, timestamp: T1 });

		expect(() => hardStale.start({ runId: "hard-stale", sessionRevision: 2, timestamp: T1 })).toThrow(
			/stale|changed/i,
		);
		expect(() => symlinkStale.start({ runId: "symlink-stale", sessionRevision: 2, timestamp: T1 })).toThrow(
			/stale|changed/i,
		);
	});

	it.skipIf(process.platform === "win32")("rejects same-byte journal inode replacement", () => {
		// Given: a store accepted a complete durable chain.
		const writer = RunJournalStore.open({ journalPath: path, sessionId: SESSION_ID, now: () => T0 });
		writer.start({ runId: "run-1", sessionRevision: 0, timestamp: T0 });
		writer.finish({ termination: completed("run-1"), sessionRevision: 1, timestamp: T1 });
		const stale = RunJournalStore.open({ journalPath: path, sessionId: SESSION_ID, now: () => T1 });
		const sameBytes = readFileSync(path);

		// When: the pathname is replaced with identical bytes.
		atomicRewriteFileSync(path, sameBytes);

		// Then: inode/generation CAS rejects the ABA replacement.
		expect(() => stale.start({ runId: "run-stale", sessionRevision: 2, timestamp: T1 })).toThrow(
			/stale|identity|changed/i,
		);
		expect(readFileSync(path)).toEqual(sameBytes);
	});

	it("does not rewrite a journal when quarantine persistence fails", () => {
		const first = RunJournalStore.open({ journalPath: path, sessionId: SESSION_ID, now: () => T0 });
		first.start({ runId: "run-crashed", sessionRevision: 3, timestamp: T0 });
		appendFileSync(path, '{"partial":');
		const before = readFileSync(path);

		expect(() =>
			RunJournalStore.open({
				journalPath: path,
				sessionId: SESSION_ID,
				now: () => T1,
				persistQuarantine: () => {
					throw new Error("synthetic quarantine fsync failure");
				},
			}),
		).toThrow("synthetic quarantine fsync failure");
		expect(readFileSync(path)).toEqual(before);
	});

	it("refuses quarantine rewrite when bytes advance after the inspected head", () => {
		const first = RunJournalStore.open({ journalPath: path, sessionId: SESSION_ID, now: () => T0 });
		first.start({ runId: "run-crashed", sessionRevision: 3, timestamp: T0 });
		appendFileSync(path, '{"partial":');
		const concurrent = Buffer.from("concurrent-bytes");

		expect(() =>
			RunJournalStore.open({
				journalPath: path,
				sessionId: SESSION_ID,
				now: () => T1,
				persistQuarantine: (target, bytes) => {
					writeQuarantineBytesDurably(target, bytes);
					appendFileSync(path, concurrent);
				},
			}),
		).toThrow(/stale|changed|compare-and-swap/i);
		expect(readFileSync(path).subarray(-concurrent.byteLength)).toEqual(concurrent);
	});

	it("holds the shared sidecar lock while recovery appends", () => {
		// Given: an unclosed run that requires startup recovery.
		const first = RunJournalStore.open({ journalPath: path, sessionId: SESSION_ID, now: () => T0 });
		first.start({ runId: "run-crashed", sessionRevision: 2, timestamp: T0 });
		let observedLock = false;

		// When: open performs inferred recovery through the persistence seam.
		RunJournalStore.open({
			journalPath: path,
			sessionId: SESSION_ID,
			now: () => T1,
			persistRecord: (target, line) => {
				try {
					acquireDurableFileMutationLockSync(target, { timeoutMs: 0 }).release();
				} catch (error) {
					if (!(error instanceof DurableFileLockBusyError)) throw error;
					observedLock = true;
				}
				appendRunJournalRecordDurably(target, line);
			},
		});

		// Then: recovery was persisted inside the same interprocess lock window.
		expect(observedLock).toBe(true);
		expect(inspectRunJournal(readFileSync(path), RunJournalStore.sha256).openRunId).toBeNull();
	});
});
