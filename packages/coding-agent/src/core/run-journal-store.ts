import { createHash, randomUUID } from "node:crypto";
import { atomicRewriteFileSync } from "./atomic-session-file.ts";
import { acquireDurableFileMutationLockSync, type DurableFileGeneration } from "./durable-file-identity.ts";
import {
	appendFileDurablySync,
	readDurableFileSnapshot,
	sameDurableFileGeneration,
	writeExclusiveFileDurablySync,
} from "./durable-file-io.ts";
import {
	inspectRunJournal,
	RunJournal,
	type RunJournalAuditInput,
	type RunJournalAuditRecord,
	type RunJournalHashFn,
	type RunJournalRecord,
	type RunJournalStartedRecord,
	type RunJournalStartInput,
	type RunJournalTerminalInput,
	type RunJournalTerminalRecord,
	serializeRunJournalLine,
} from "./run-journal.ts";
import {
	assertSessionOwnerRecoveryAllowedUnlockedSync,
	type SessionOwnerLease,
	sessionPathFromPersistenceArtifact,
} from "./session-owner-lease.ts";
import { classifySessionTermination } from "./session-termination.ts";

export interface RunJournalQuarantineReport {
	readonly path: string;
	readonly byteCount: number;
	readonly completePrefixByteCount: number;
}

export interface OpenRunJournalStoreOptions {
	readonly journalPath?: string;
	readonly sessionId: string;
	readonly now?: () => string;
	readonly hashFn?: RunJournalHashFn;
	readonly ownerLease?: SessionOwnerLease;
	/** Test seams for deterministic persistence failures and quarantine races. */
	readonly persistRecord?: (path: string, line: string) => void;
	readonly persistQuarantine?: (path: string, bytes: Uint8Array) => void;
}

export class RunJournalStoreCorruptionError extends Error {
	override readonly name = "RunJournalStoreCorruptionError";
}

export class RunJournalStoreStaleWriteError extends Error {
	constructor() {
		super("Run journal changed since this store accepted its durable head");
		this.name = "RunJournalStoreStaleWriteError";
	}
}

type RunJournalDurableHead = {
	readonly size: number;
	readonly lastSeq: number;
	readonly lastHash: string | null;
	readonly generation: DurableFileGeneration | null;
};

/** Append one complete JSONL record and fsync it without truncation rollback. */
export const appendRunJournalRecordDurably = (path: string, line: string): void =>
	appendFileDurablySync(path, Buffer.from(line, "utf8"));

export const writeQuarantineBytesDurably = writeExclusiveFileDurablySync;

function readDurableHead(path: string, hashFn: RunJournalHashFn): RunJournalDurableHead {
	const snapshot = readDurableFileSnapshot(path);
	if (!snapshot) return { size: 0, lastSeq: 0, lastHash: null, generation: null };
	const report = inspectRunJournal(snapshot.bytes, hashFn);
	const hardFindings = report.findings.filter((finding) => finding.code !== "run_unclosed");
	if (hardFindings.length > 0) {
		throw new RunJournalStoreCorruptionError(
			`run journal is corrupt: ${hardFindings.map((finding) => finding.code).join(", ")}`,
		);
	}
	const last = report.records.at(-1);
	return {
		size: snapshot.bytes.byteLength,
		lastSeq: last?.seq ?? 0,
		lastHash: last?.hash ?? null,
		generation: snapshot.generation,
	};
}

function sameDurableHead(left: RunJournalDurableHead, right: RunJournalDurableHead): boolean {
	return (
		left.size === right.size &&
		left.lastSeq === right.lastSeq &&
		left.lastHash === right.lastHash &&
		sameDurableFileGeneration(left.generation, right.generation)
	);
}

function sameSourceSnapshot(
	left: NonNullable<ReturnType<typeof readDurableFileSnapshot>>,
	right: ReturnType<typeof readDurableFileSnapshot>,
): boolean {
	return (
		right !== null &&
		sameDurableFileGeneration(left.generation, right.generation) &&
		Buffer.compare(left.bytes, right.bytes) === 0
	);
}

function replayRecords(records: readonly RunJournalRecord[], sessionId: string, hashFn: RunJournalHashFn): RunJournal {
	const journal = new RunJournal({
		hashFn,
		sessionId,
		runId: "replay",
		sessionRevision: 0,
		timestamp: "1970-01-01T00:00:00.000Z",
		openInitialRun: false,
	});
	for (const record of records) {
		let replayed: RunJournalRecord;
		if (record.event === "run_started") {
			replayed = journal.start({
				runId: record.runId,
				sessionRevision: record.sessionRevision,
				timestamp: record.timestamp,
			});
		} else if (
			record.event === "tool_timeout" ||
			record.event === "tool_late_settlement" ||
			record.event === "transcript_repaired"
		) {
			replayed = journal.audit({
				event: record.event,
				details: record.details,
				sessionRevision: record.sessionRevision,
				timestamp: record.timestamp,
			});
		} else if ("termination" in record) {
			const input = {
				termination: record.termination,
				sessionRevision: record.sessionRevision,
				timestamp: record.timestamp,
			};
			replayed =
				record.event === "run_finished"
					? journal.finish(input)
					: record.event === "run_abandoned"
						? journal.abandon(input)
						: journal.recover(input);
		} else {
			throw new RunJournalStoreCorruptionError("run journal contains an unsupported record event");
		}
		if (serializeRunJournalLine(replayed) !== serializeRunJournalLine(record)) {
			throw new RunJournalStoreCorruptionError("run journal replay did not reproduce the accepted chain");
		}
	}
	return journal;
}

export class RunJournalStore {
	static readonly sha256: RunJournalHashFn = (bytes) => createHash("sha256").update(bytes).digest("hex");

	private readonly journalPath: string | undefined;
	private readonly sessionId: string;
	private readonly hashFn: RunJournalHashFn;
	private readonly now: () => string;
	private readonly persistRecord: (path: string, line: string) => void;
	private readonly ownerLease: SessionOwnerLease | undefined;
	private acceptedRecords: readonly RunJournalRecord[];
	private acceptedOpenRunId: string | null;
	private acceptedDurableHead: RunJournalDurableHead;
	private journalLockDepth = 0;
	readonly quarantineReport: RunJournalQuarantineReport | null;

	private constructor(
		options: OpenRunJournalStoreOptions,
		records: readonly RunJournalRecord[],
		openRunId: string | null,
		quarantineReport: RunJournalQuarantineReport | null,
		durableHead: RunJournalDurableHead,
	) {
		this.journalPath = options.journalPath;
		this.sessionId = options.sessionId;
		this.hashFn = options.hashFn ?? RunJournalStore.sha256;
		this.now = options.now ?? (() => new Date().toISOString());
		this.persistRecord = options.persistRecord ?? appendRunJournalRecordDurably;
		this.ownerLease = options.ownerLease;
		this.acceptedRecords = Object.freeze([...records]);
		this.acceptedOpenRunId = openRunId;
		this.acceptedDurableHead = durableHead;
		this.quarantineReport = quarantineReport;
	}

	static open(options: OpenRunJournalStoreOptions): RunJournalStore {
		const hashFn = options.hashFn ?? RunJournalStore.sha256;
		if (!options.journalPath) {
			return new RunJournalStore(options, [], null, null, {
				size: 0,
				lastSeq: 0,
				lastHash: null,
				generation: null,
			});
		}

		const journalPath = options.journalPath;
		const ownerLock = acquireDurableFileMutationLockSync(sessionPathFromPersistenceArtifact(journalPath));
		let journalLock: ReturnType<typeof acquireDurableFileMutationLockSync> | undefined;
		try {
			journalLock = acquireDurableFileMutationLockSync(journalPath);
			assertSessionOwnerRecoveryAllowedUnlockedSync(journalPath, options.ownerLease);
			let records: readonly RunJournalRecord[] = [];
			let openRunId: string | null = null;
			let quarantineReport: RunJournalQuarantineReport | null = null;
			const snapshot = readDurableFileSnapshot(journalPath);
			if (snapshot) {
				const report = inspectRunJournal(snapshot.bytes, hashFn);
				const hardFindings = report.findings.filter(
					(finding) => finding.code !== "trailing_fragment" && finding.code !== "run_unclosed",
				);
				if (hardFindings.length > 0) {
					throw new RunJournalStoreCorruptionError(
						`run journal is corrupt: ${hardFindings.map((finding) => finding.code).join(", ")}`,
					);
				}
				if (report.records.some((record) => record.sessionId !== options.sessionId)) {
					throw new RunJournalStoreCorruptionError("run journal session identity does not match");
				}
				records = report.records;
				openRunId = report.openRunId;

				if (report.trailingByteCount > 0) {
					const fragment = snapshot.bytes.subarray(report.completePrefix.byteCount);
					const quarantinePath = `${journalPath}.quarantine-${randomUUID()}`;
					(options.persistQuarantine ?? writeQuarantineBytesDurably)(quarantinePath, fragment);
					if (!sameSourceSnapshot(snapshot, readDurableFileSnapshot(journalPath))) {
						throw new RunJournalStoreStaleWriteError();
					}
					atomicRewriteFileSync(journalPath, snapshot.bytes.subarray(0, report.completePrefix.byteCount));
					quarantineReport = Object.freeze({
						path: quarantinePath,
						byteCount: fragment.byteLength,
						completePrefixByteCount: report.completePrefix.byteCount,
					});
				}
			}

			const store = new RunJournalStore(
				options,
				records,
				openRunId,
				quarantineReport,
				readDurableHead(journalPath, hashFn),
			);
			store.journalLockDepth = 1;
			try {
				if (openRunId !== null) {
					const timestamp = store.now();
					const sessionRevision = records.at(-1)?.sessionRevision ?? 0;
					store.recover({
						termination: classifySessionTermination({
							sessionId: options.sessionId,
							runId: openRunId,
							timestamp,
							source: "inferred_on_resume",
							message: "Previous process exited without closing the run; recovered on startup.",
							cause: { area: "process", code: "crash" },
							sideEffects: "possible",
						}),
						sessionRevision,
						timestamp,
					});
				}
			} finally {
				store.journalLockDepth = 0;
			}
			return store;
		} finally {
			journalLock?.release();
			ownerLock.release();
		}
	}

	get records(): readonly RunJournalRecord[] {
		return this.acceptedRecords;
	}

	get openRunId(): string | null {
		return this.acceptedOpenRunId;
	}

	start(input: RunJournalStartInput): RunJournalStartedRecord {
		return this.commit((journal) => journal.start(input));
	}

	finish(input: RunJournalTerminalInput): RunJournalTerminalRecord {
		return this.commit((journal) => journal.finish(input));
	}

	abandon(input: RunJournalTerminalInput): RunJournalTerminalRecord {
		return this.commit((journal) => journal.abandon(input));
	}

	recover(input: RunJournalTerminalInput): RunJournalTerminalRecord {
		return this.commit((journal) => journal.recover(input));
	}

	audit(input: RunJournalAuditInput): RunJournalAuditRecord {
		return this.commit((journal) => journal.audit(input));
	}

	private withJournalLock<T>(fn: () => T): T {
		if (!this.journalPath || this.journalLockDepth > 0) return fn();
		const ownerLock = acquireDurableFileMutationLockSync(sessionPathFromPersistenceArtifact(this.journalPath));
		let journalLock: ReturnType<typeof acquireDurableFileMutationLockSync> | undefined;
		try {
			journalLock = acquireDurableFileMutationLockSync(this.journalPath);
			this.journalLockDepth += 1;
			try {
				return fn();
			} finally {
				this.journalLockDepth -= 1;
			}
		} finally {
			journalLock?.release();
			ownerLock.release();
		}
	}

	private commit<T extends RunJournalRecord>(append: (journal: RunJournal) => T): T {
		return this.withJournalLock(() => {
			if (this.journalPath) {
				assertSessionOwnerRecoveryAllowedUnlockedSync(this.journalPath, this.ownerLease);
				const current = readDurableHead(this.journalPath, this.hashFn);
				if (!sameDurableHead(current, this.acceptedDurableHead)) throw new RunJournalStoreStaleWriteError();
			}

			const candidate = replayRecords(this.acceptedRecords, this.sessionId, this.hashFn);
			const record = append(candidate);
			let nextDurableHead = this.acceptedDurableHead;
			if (this.journalPath) {
				const line = `${serializeRunJournalLine(record)}\n`;
				this.persistRecord(this.journalPath, line);
				nextDurableHead = readDurableHead(this.journalPath, this.hashFn);
				const expected = {
					size: this.acceptedDurableHead.size + Buffer.byteLength(line, "utf8"),
					lastSeq: record.seq,
					lastHash: record.hash,
					generation: nextDurableHead.generation
						? {
								...(this.acceptedDurableHead.generation ?? nextDurableHead.generation),
								ctimeNs: nextDurableHead.generation.ctimeNs,
							}
						: null,
				};
				if (!sameDurableHead(nextDurableHead, expected)) {
					throw new RunJournalStoreCorruptionError("persisted run journal head does not match appended record");
				}
			}

			this.acceptedRecords = Object.freeze([...candidate.records]);
			this.acceptedOpenRunId = candidate.openRunId;
			this.acceptedDurableHead = nextDurableHead;
			return record;
		});
	}
}
