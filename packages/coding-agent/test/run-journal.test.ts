import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	canonicalJson,
	GENESIS_HASH,
	inspectRunJournal,
	RUN_JOURNAL_SCHEMA_VERSION,
	RunJournal,
	type RunJournalAuditDetails,
	type RunJournalAuditRecord,
	type RunJournalFindingCode,
	type RunJournalRecord,
	type RunJournalStartedRecord,
	type RunJournalStartInput,
	type RunJournalTerminalRecord,
	serializeRunJournalLine,
	serializeRunJournalMaterial,
} from "../src/core/run-journal.ts";
import {
	classifySessionTermination,
	SESSION_TERMINATION_KIND_VALUES,
	type SessionTermination,
	type SessionTerminationCause,
} from "../src/core/session-termination.ts";

const NOW = "2026-07-16T00:00:00.000Z";
const NOW2 = "2026-07-16T00:00:01.000Z";
const NOW3 = "2026-07-16T00:00:02.000Z";
const SESSION = "session-1";

const encoder = new TextEncoder();
const enc = (text: string): Uint8Array => encoder.encode(text);

/** Deterministic, dependency-free 64-hex digest. NOT cryptographic; test fixture only. */
function testHash(bytes: Uint8Array): string {
	const words = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n];
	for (let index = 0; index < bytes.length; index += 1) {
		const slot = words[index % 4];
		words[index % 4] = (slot ^ (BigInt(bytes[index]) * 0x9e3779b97f4a7c15n) ^ (slot >> 31n)) & 0xffffffffffffffffn;
	}
	words[0] = (words[0] ^ BigInt(bytes.length)) & 0xffffffffffffffffn;
	return words.map((word) => word.toString(16).padStart(16, "0")).join("");
}

function finishedTermination(runId: string, sessionId = SESSION, timestamp = NOW): SessionTermination {
	return classifySessionTermination({
		sessionId,
		runId,
		timestamp,
		source: "observed",
		message: "run completed",
		cause: { area: "completed" },
		sideEffects: "none",
	});
}
function abandonedTermination(runId: string, sessionId = SESSION, timestamp = NOW): SessionTermination {
	return classifySessionTermination({
		sessionId,
		runId,
		timestamp,
		source: "observed",
		message: "user aborted",
		cause: { area: "user", code: "abort" },
		sideEffects: "none",
	});
}
function recoveredTermination(runId: string, sessionId = SESSION, timestamp = NOW): SessionTermination {
	return classifySessionTermination({
		sessionId,
		runId,
		timestamp,
		source: "inferred_on_resume",
		message: "prior run crash inferred on resume",
		cause: { area: "process", code: "crash" },
		sideEffects: "possible",
	});
}
function rateLimitTermination(runId: string, sessionId = SESSION, timestamp = NOW): SessionTermination {
	return classifySessionTermination({
		sessionId,
		runId,
		timestamp,
		source: "observed",
		message: "provider rate limited",
		cause: { area: "provider", code: "rate_limit" },
		sideEffects: "none",
	});
}
function transcriptTermination(runId: string, sessionId = SESSION, timestamp = NOW): SessionTermination {
	return classifySessionTermination({
		sessionId,
		runId,
		timestamp,
		source: "observed",
		message: "transcript was invalid",
		cause: { area: "transcript", code: "missing_result" },
		sideEffects: "possible",
	});
}

type Material =
	| Omit<RunJournalStartedRecord, "hash">
	| Omit<RunJournalTerminalRecord, "hash">
	| Omit<RunJournalAuditRecord, "hash">;

function rehash(material: Material): RunJournalRecord {
	const hash = testHash(enc(serializeRunJournalMaterial(material)));
	return { ...material, hash } as RunJournalRecord;
}

function buildBytes(materials: readonly Material[], trailing = ""): Uint8Array {
	let prev = GENESIS_HASH;
	const lines: string[] = [];
	for (const material of materials) {
		const chained: Material = { ...material, prevHash: prev };
		const record = rehash(chained);
		lines.push(serializeRunJournalLine(record));
		prev = record.hash;
	}
	return enc(`${lines.join("\n")}${lines.length === 0 ? "" : "\n"}${trailing}`);
}

function startedMaterial(runId: string, seq: number, sessionRevision = 0, timestamp = NOW): Material {
	return {
		schemaVersion: RUN_JOURNAL_SCHEMA_VERSION,
		seq,
		event: "run_started",
		runId,
		sessionId: SESSION,
		sessionRevision,
		timestamp,
		prevHash: GENESIS_HASH,
	};
}
function terminalMaterial(
	event: "run_finished" | "run_recovered" | "run_abandoned",
	runId: string,
	seq: number,
	termination: SessionTermination,
	timestamp = NOW,
): Material {
	return {
		schemaVersion: RUN_JOURNAL_SCHEMA_VERSION,
		seq,
		event,
		runId,
		sessionId: SESSION,
		sessionRevision: 0,
		timestamp,
		prevHash: GENESIS_HASH,
		termination,
	};
}

const codes = (report: {
	readonly findings: readonly { readonly code: RunJournalFindingCode }[];
}): RunJournalFindingCode[] => report.findings.map((finding) => finding.code);

describe("RunJournal writer", () => {
	it("writes a deterministic started->finished chain with recomputed hashes", () => {
		const journal = new RunJournal({
			hashFn: testHash,
			sessionId: SESSION,
			runId: "run-1",
			sessionRevision: 0,
			timestamp: NOW,
		});
		const started = journal.records[0];
		expect(started.event).toBe("run_started");
		expect(started.seq).toBe(0);
		expect(started.prevHash).toBe(GENESIS_HASH);
		expect(started.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(Object.isFrozen(started)).toBe(true);

		const finished = journal.finish({
			termination: finishedTermination("run-1", SESSION, NOW2),
			sessionRevision: 0,
			timestamp: NOW2,
		});
		expect(finished.event).toBe("run_finished");
		expect(finished.seq).toBe(1);
		expect(finished.prevHash).toBe(started.hash);
		expect(finished.termination.runId).toBe("run-1");
		expect(journal.openRunId).toBeNull();
		expect(journal.records).toHaveLength(2);

		const report = inspectRunJournal(journal.toBytes(), testHash);
		expect(report.ok).toBe(true);
		expect(report.records).toHaveLength(2);
		expect(report.openRunId).toBeNull();
	});

	it("journals a provider refusal termination without masking it as a protocol error", () => {
		const journal = new RunJournal({
			hashFn: testHash,
			sessionId: SESSION,
			runId: "run-1",
			sessionRevision: 0,
			timestamp: NOW,
		});
		const refusal = classifySessionTermination({
			sessionId: SESSION,
			runId: "run-1",
			timestamp: NOW2,
			source: "observed",
			message:
				"Model ended the turn with a content/safety stop (stop_reason=refusal); the response was not completed. Often a false positive on benign input — rephrase or retry.",
			cause: { area: "provider", code: "refusal" },
			sideEffects: "none",
			provider: "anthropic",
			model: "claude-fable-5",
		});
		expect(refusal.kind).toBe("provider_refusal");

		const finished = journal.finish({ termination: refusal, sessionRevision: 0, timestamp: NOW2 });
		expect(finished.termination.kind).toBe("provider_refusal");

		const report = inspectRunJournal(journal.toBytes(), testHash);
		expect(report.ok).toBe(true);
		expect(report.records).toHaveLength(2);
	});

	it("accepts every termination kind the classifier can produce (validator drift lock)", () => {
		const causes: readonly SessionTerminationCause[] = [
			{ area: "completed" },
			{ area: "user", code: "abort" },
			{ area: "provider", code: "abort" },
			{ area: "provider", code: "auth" },
			{ area: "provider", code: "rate_limit" },
			{ area: "provider", code: "network" },
			{ area: "provider", code: "protocol" },
			{ area: "provider", code: "refusal" },
			{ area: "provider", code: "context_overflow" },
			{ area: "transcript", code: "missing_result" },
			{ area: "tool", code: "timeout" },
			{ area: "tool", code: "fatal" },
			{ area: "compaction", code: "failed" },
			{ area: "persistence", code: "append_failed" },
			{ area: "process", code: "signal", signal: "SIGTERM" },
			{ area: "process", code: "crash" },
			{ area: "configuration", code: "invalid" },
			{ area: "internal", code: "unclassified" },
		];
		const producedKinds = new Set<string>();
		for (const [index, cause] of causes.entries()) {
			const runId = `run-${index}`;
			const source = cause.area === "process" && cause.code === "crash" ? "inferred_on_resume" : "observed";
			const termination = classifySessionTermination({
				sessionId: SESSION,
				runId,
				timestamp: NOW2,
				source,
				message: "drift lock probe",
				cause,
				sideEffects: "none",
			});
			producedKinds.add(termination.kind);
			const journal = new RunJournal({
				hashFn: testHash,
				sessionId: SESSION,
				runId,
				sessionRevision: 0,
				timestamp: NOW,
			});
			if (termination.kind === "process_crash") {
				journal.recover({ termination, sessionRevision: 0, timestamp: NOW2 });
			} else {
				journal.finish({ termination, sessionRevision: 0, timestamp: NOW2 });
			}
			expect(inspectRunJournal(journal.toBytes(), testHash).ok).toBe(true);
		}
		for (const kind of SESSION_TERMINATION_KIND_VALUES) {
			expect(producedKinds.has(kind), `classifier must be able to produce kind ${kind}`).toBe(true);
		}
	});

	it("supports recovered and abandoned terminations", () => {
		const journal = new RunJournal({
			hashFn: testHash,
			sessionId: SESSION,
			runId: "run-1",
			sessionRevision: 0,
			timestamp: NOW,
		});
		journal.recover({
			termination: recoveredTermination("run-1", SESSION, NOW2),
			sessionRevision: 0,
			timestamp: NOW2,
		});
		expect(journal.openRunId).toBeNull();
		journal.start({ runId: "run-2", sessionRevision: 1, timestamp: NOW3 });
		journal.abandon({
			termination: abandonedTermination("run-2", SESSION, NOW3),
			sessionRevision: 1,
			timestamp: NOW3,
		});
		expect(journal.records.map((record) => record.event)).toEqual([
			"run_started",
			"run_recovered",
			"run_started",
			"run_abandoned",
		]);
		expect(inspectRunJournal(journal.toBytes(), testHash).ok).toBe(true);
	});

	it("supports multiple sequential runs with a flowing hash chain", () => {
		const journal = new RunJournal({
			hashFn: testHash,
			sessionId: SESSION,
			runId: "run-1",
			sessionRevision: 0,
			timestamp: NOW,
		});
		journal.finish({ termination: finishedTermination("run-1", SESSION, NOW2), sessionRevision: 0, timestamp: NOW2 });
		journal.start({ runId: "run-2", sessionRevision: 0, timestamp: NOW3 });
		journal.finish({ termination: finishedTermination("run-2", SESSION, NOW3), sessionRevision: 0, timestamp: NOW3 });
		const records = journal.records;
		expect(records[0].prevHash).toBe(GENESIS_HASH);
		expect(records[1].prevHash).toBe(records[0].hash);
		expect(records[2].prevHash).toBe(records[1].hash);
		expect(records[3].prevHash).toBe(records[2].hash);
		expect(inspectRunJournal(journal.toBytes(), testHash).ok).toBe(true);
	});

	it("enforces one open run at a time", () => {
		const journal = new RunJournal({
			hashFn: testHash,
			sessionId: SESSION,
			runId: "run-1",
			sessionRevision: 0,
			timestamp: NOW,
		});
		expect(() => journal.start({ runId: "run-2", sessionRevision: 0, timestamp: NOW2 })).toThrow("already open");
		expect(() =>
			journal.recover({ termination: finishedTermination("run-1"), sessionRevision: 0, timestamp: NOW2 }),
		).toThrow("inferred_on_resume");
		expect(() =>
			journal.finish({ termination: finishedTermination("run-2"), sessionRevision: 0, timestamp: NOW2 }),
		).toThrow("termination runId");
	});

	it("rejects duplicate runIds and terminals without an open run", () => {
		const journal = new RunJournal({
			hashFn: testHash,
			sessionId: SESSION,
			runId: "run-1",
			sessionRevision: 0,
			timestamp: NOW,
		});
		journal.finish({ termination: finishedTermination("run-1", SESSION, NOW2), sessionRevision: 0, timestamp: NOW2 });
		expect(() => journal.start({ runId: "run-1", sessionRevision: 0, timestamp: NOW3 })).toThrow("already started");
		expect(() =>
			journal.finish({ termination: finishedTermination("run-1"), sessionRevision: 0, timestamp: NOW3 }),
		).toThrow("no run is open");
	});

	it("fails closed when the injected hash function throws or returns non-hex", () => {
		const throwing = (): string => {
			throw new Error("boom");
		};
		expect(
			() =>
				new RunJournal({
					hashFn: throwing,
					sessionId: SESSION,
					runId: "run-1",
					sessionRevision: 0,
					timestamp: NOW,
				}),
		).toThrow("failing closed");
		const nonhex = (): string => "not-a-hash";
		expect(
			() =>
				new RunJournal({ hashFn: nonhex, sessionId: SESSION, runId: "run-1", sessionRevision: 0, timestamp: NOW }),
		).toThrow("64 lowercase hex");
		expect(
			() =>
				new RunJournal({
					hashFn: (): string => "abcdef",
					sessionId: SESSION,
					runId: "r",
					sessionRevision: 0,
					timestamp: NOW,
				}),
		).toThrow("64 lowercase hex");
	});
});

describe("canonical serialization determinism", () => {
	it("serializes records with recursively key-sorted fields", () => {
		const journal = new RunJournal({
			hashFn: testHash,
			sessionId: SESSION,
			runId: "run-1",
			sessionRevision: 0,
			timestamp: NOW,
		});
		journal.finish({ termination: finishedTermination("run-1", SESSION, NOW2), sessionRevision: 0, timestamp: NOW2 });
		const line = serializeRunJournalLine(journal.records[0]);
		expect(line.startsWith('{"event":"run_started","hash":')).toBe(true);
		const parsed = JSON.parse(line) as Record<string, unknown>;
		expect(Object.keys(parsed)).toEqual([
			"event",
			"hash",
			"prevHash",
			"runId",
			"schemaVersion",
			"seq",
			"sessionId",
			"sessionRevision",
			"timestamp",
		]);
	});

	it("is stable across two equivalent constructions and matches the writer output", () => {
		const make = (): Uint8Array => {
			const journal = new RunJournal({
				hashFn: testHash,
				sessionId: SESSION,
				runId: "run-1",
				sessionRevision: 0,
				timestamp: NOW,
			});
			journal.finish({
				termination: finishedTermination("run-1", SESSION, NOW2),
				sessionRevision: 0,
				timestamp: NOW2,
			});
			return journal.toBytes();
		};
		const a = make();
		const b = make();
		expect([...b]).toEqual([...a]);
		const independently = enc(`${journalRecords(a).map(serializeRunJournalLine).join("\n")}\n`);
		expect([...independently]).toEqual([...a]);
	});

	it("canonicalJson sorts nested termination keys", () => {
		const termination = finishedTermination("run-1");
		const sorted = canonicalJson(termination);
		const keys = [...sorted.matchAll(/"([a-zA-Z]+)":/g)].map((match) => match[1]);
		expect([...keys].sort()).toEqual(keys);
	});

	it("excludes the material hash field from the hashed material", () => {
		const materialSource = startedMaterial("run-1", 0);
		const material = serializeRunJournalMaterial(materialSource);
		expect(material).not.toContain('"hash"');
		expect(material).toContain('"prevHash"');
		const record = rehash(materialSource);
		expect(testHash(enc(material))).toBe(record.hash);
	});
});

function journalRecords(bytes: Uint8Array): RunJournalRecord[] {
	const report = inspectRunJournal(bytes, testHash);
	return [...report.records];
}

describe("inspectRunJournal complete-prefix handling", () => {
	it("parses a clean journal as ok with stable complete-prefix metrics", () => {
		const bytes = buildBytes([
			startedMaterial("run-1", 0),
			terminalMaterial("run_finished", "run-1", 1, finishedTermination("run-1")),
		]);
		const report = inspectRunJournal(bytes, testHash);
		expect(report.ok).toBe(true);
		expect(report.completePrefix).toEqual({ byteCount: bytes.byteLength, lineCount: 2 });
		expect(report.trailingByteCount).toBe(0);
		expect(report.records).toHaveLength(2);
		expect(report.openRunId).toBeNull();
		expect(Object.isFrozen(report)).toBe(true);
		expect(Object.isFrozen(report.records)).toBe(true);
		expect(Object.isFrozen(report.findings)).toBe(true);
		expect(Object.isFrozen(report.records[0])).toBe(true);
	});

	it("reports a trailing fragment and never parses trailing bytes", () => {
		const base = buildBytes([startedMaterial("run-1", 0)]);
		const bytes = enc(`${new TextDecoder().decode(base)}{"event":"run_started"`);
		const report = inspectRunJournal(bytes, testHash);
		expect(report.trailingByteCount).toBe('{"event":"run_started"'.length);
		expect(report.completePrefix.lineCount).toBe(1);
		expect(report.records).toHaveLength(1);
		expect(codes(report)).toContain("trailing_fragment");
		expect(report.ok).toBe(false);
	});

	it("reports invalid UTF-8 in the complete prefix", () => {
		const bytes = Uint8Array.of(0x80, 0x0a);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("invalid_utf8");
		expect(report.records).toHaveLength(0);
		expect(report.ok).toBe(false);
	});

	it("reports malformed JSON on a non-empty unparseable line", () => {
		const bytes = enc("{not json}\n");
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toEqual(["malformed_json"]);
		expect(report.records).toHaveLength(0);
	});

	it("reports empty bytes as ok with an empty complete prefix", () => {
		const report = inspectRunJournal(new Uint8Array(0), testHash);
		expect(report).toMatchObject({ ok: true, trailingByteCount: 0, records: [], openRunId: null });
		expect(report.completePrefix).toEqual({ byteCount: 0, lineCount: 0 });
	});
});

describe("inspectRunJournal hash chain integrity", () => {
	it("detects a tampered field via hash mismatch", () => {
		const journal = new RunJournal({
			hashFn: testHash,
			sessionId: SESSION,
			runId: "run-1",
			sessionRevision: 0,
			timestamp: NOW,
		});
		journal.finish({ termination: finishedTermination("run-1", SESSION, NOW2), sessionRevision: 0, timestamp: NOW2 });
		const records = journal.records.map((record) => ({ ...record }));
		const tampered = { ...records[1], sessionRevision: 9 };
		const bytes = enc(`${[records[0], tampered].map(serializeRunJournalLine).join("\n")}\n`);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("hash_mismatch");
		expect(codes(report)).not.toContain("hash_chain_break");
	});

	it("detects a middle-record hash tamper that breaks the following chain", () => {
		const journal = new RunJournal({
			hashFn: testHash,
			sessionId: SESSION,
			runId: "run-1",
			sessionRevision: 0,
			timestamp: NOW,
		});
		journal.finish({ termination: finishedTermination("run-1", SESSION, NOW2), sessionRevision: 0, timestamp: NOW2 });
		journal.start({ runId: "run-2", sessionRevision: 0, timestamp: NOW3 });
		journal.finish({ termination: finishedTermination("run-2", SESSION, NOW3), sessionRevision: 0, timestamp: NOW3 });
		const records = journal.records.map((record) => ({ ...record }));
		const tamperedMiddle = { ...records[1], hash: "g".repeat(64) };
		const bytes = enc(
			`${[records[0], tamperedMiddle, records[2], records[3]].map(serializeRunJournalLine).join("\n")}\n`,
		);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("hash_shape");
		expect(codes(report)).toContain("hash_chain_break");
	});

	it("detects a broken prevHash link in isolation", () => {
		const journal = new RunJournal({
			hashFn: testHash,
			sessionId: SESSION,
			runId: "run-1",
			sessionRevision: 0,
			timestamp: NOW,
		});
		journal.finish({ termination: finishedTermination("run-1", SESSION, NOW2), sessionRevision: 0, timestamp: NOW2 });
		const records = journal.records.map((record) => ({ ...record }));
		const broken = rehash({ ...records[1], prevHash: "1".repeat(64) });
		const bytes = enc(`${[records[0], broken].map(serializeRunJournalLine).join("\n")}\n`);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("hash_chain_break");
		expect(codes(report)).not.toContain("hash_mismatch");
	});

	it("detects malformed hash field shapes", () => {
		const records = [startedMaterial("run-1", 0)];
		const record = { ...rehash(records[0]), hash: "deadbeef" };
		const report = inspectRunJournal(enc(`${serializeRunJournalLine(record)}\n`), testHash);
		expect(codes(report)).toContain("hash_shape");
		expect(codes(report)).toContain("hash_mismatch");
	});

	it("fails closed when the inspector hash function throws or returns non-hex", () => {
		const bytes = buildBytes([startedMaterial("run-1", 0)]);
		const throwing = (): string => {
			throw new Error("boom");
		};
		expect(codes(inspectRunJournal(bytes, throwing))).toContain("hash_mismatch");
		const nonhex = (): string => "zzz";
		expect(codes(inspectRunJournal(bytes, nonhex))).toContain("hash_mismatch");
	});
});

describe("inspectRunJournal sequence integrity", () => {
	it("detects a seq gap on the final record in isolation", () => {
		const records = [
			startedMaterial("run-1", 0),
			terminalMaterial("run_finished", "run-1", 1, finishedTermination("run-1")),
		];
		const first = rehash(records[0]);
		const gapped = rehash({ ...records[1], seq: 7, prevHash: first.hash });
		const bytes = enc(`${[first, gapped].map(serializeRunJournalLine).join("\n")}\n`);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("seq_gap");
		expect(codes(report)).not.toContain("hash_chain_break");
	});

	it("detects a seq regression on the final record in isolation", () => {
		const records = [
			startedMaterial("run-1", 0),
			terminalMaterial("run_finished", "run-1", 1, finishedTermination("run-1")),
		];
		const first = rehash(records[0]);
		const regressed = rehash({ ...records[1], seq: 0, prevHash: first.hash });
		const bytes = enc(`${[first, regressed].map(serializeRunJournalLine).join("\n")}\n`);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("seq_regression");
	});
});

describe("inspectRunJournal finite-state machine", () => {
	it("flags an orphan terminal with no preceding start", () => {
		const bytes = buildBytes([terminalMaterial("run_finished", "run-1", 0, finishedTermination("run-1"))]);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("orphan_terminal");
	});

	it("flags a duplicate terminal for an already-terminated run", () => {
		const bytes = buildBytes([
			startedMaterial("run-1", 0),
			terminalMaterial("run_finished", "run-1", 1, finishedTermination("run-1")),
			terminalMaterial("run_finished", "run-1", 2, finishedTermination("run-1")),
		]);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("duplicate_terminal");
	});

	it("flags a duplicate start", () => {
		const bytes = buildBytes([
			startedMaterial("run-1", 0),
			startedMaterial("run-1", 1),
			terminalMaterial("run_finished", "run-1", 2, finishedTermination("run-1")),
		]);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("duplicate_start");
	});

	it("flags an interleaved run without losing the original open run", () => {
		const bytes = buildBytes([
			startedMaterial("run-1", 0),
			startedMaterial("run-2", 1),
			terminalMaterial("run_finished", "run-1", 2, finishedTermination("run-1")),
		]);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("interleaved_run");
		expect(codes(report)).not.toContain("run_unclosed");
		expect(report.openRunId).toBeNull();
	});

	it("flags an unclosed run", () => {
		const bytes = buildBytes([startedMaterial("run-1", 0)]);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("run_unclosed");
		expect(report.openRunId).toBe("run-1");
		expect(report.ok).toBe(false);
	});

	it("flags a recovered event whose source is not inferred_on_resume", () => {
		const observedRecovery = classifySessionTermination({
			sessionId: SESSION,
			runId: "run-1",
			timestamp: NOW2,
			source: "inferred_on_resume",
			message: "recovered",
			cause: { area: "process", code: "crash" },
			sideEffects: "possible",
		});
		const tamperedTermination = { ...observedRecovery, source: "observed" as const };
		const bytes = buildBytes([
			startedMaterial("run-1", 0),
			terminalMaterial("run_recovered", "run-1", 1, tamperedTermination as SessionTermination, NOW2),
		]);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("recovered_source_invalid");
	});

	it("flags a finished event carrying the reserved inferred_on_resume source", () => {
		// recoveredTermination is a coherent process_crash whose source is the
		// reserved inferred_on_resume; pairing it with run_finished is an
		// event/source incoherence flagged as recovered_source_invalid.
		const inferredOnResume = recoveredTermination("run-1");
		const bytes = buildBytes([
			startedMaterial("run-1", 0),
			terminalMaterial("run_finished", "run-1", 1, inferredOnResume),
		]);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("recovered_source_invalid");
	});

	it("flags a terminal whose termination does not match the record identity", () => {
		const mismatched = { ...finishedTermination("run-1"), runId: "run-other" } as SessionTermination;
		const bytes = buildBytes([startedMaterial("run-1", 0), terminalMaterial("run_finished", "run-1", 1, mismatched)]);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("termination_mismatch");
	});
});

describe("inspectRunJournal schema and trust-boundary rejection", () => {
	it("rejects an unsupported schema version", () => {
		const record = { ...rehash(startedMaterial("run-1", 0)), schemaVersion: 2 };
		const report = inspectRunJournal(
			enc(`${serializeRunJournalLine(record as unknown as RunJournalRecord)}\n`),
			testHash,
		);
		expect(codes(report)).toContain("schema");
		expect(report.records).toHaveLength(0);
	});

	it("rejects an unknown event name", () => {
		const record = { ...rehash(startedMaterial("run-1", 0)), event: "run_paused" } as unknown as RunJournalRecord;
		const report = inspectRunJournal(enc(`${serializeRunJournalLine(record)}\n`), testHash);
		expect(codes(report)).toContain("schema");
	});

	it("rejects a started record carrying a termination", () => {
		const record = {
			...rehash(startedMaterial("run-1", 0)),
			termination: finishedTermination("run-1"),
		} as unknown as RunJournalRecord;
		const report = inspectRunJournal(enc(`${serializeRunJournalLine(record)}\n`), testHash);
		expect(codes(report)).toContain("schema");
	});

	it("rejects a terminal record missing its termination", () => {
		const record = rehash({
			schemaVersion: RUN_JOURNAL_SCHEMA_VERSION,
			seq: 0,
			event: "run_finished",
			runId: "run-1",
			sessionId: SESSION,
			sessionRevision: 0,
			timestamp: NOW,
			prevHash: GENESIS_HASH,
		} as unknown as Material);
		const report = inspectRunJournal(enc(`${serializeRunJournalLine(record)}\n`), testHash);
		expect(codes(report)).toContain("schema");
	});

	it("rejects extra top-level keys", () => {
		const record = { ...rehash(startedMaterial("run-1", 0)), extra: "field" } as unknown as RunJournalRecord;
		const report = inspectRunJournal(enc(`${serializeRunJournalLine(record)}\n`), testHash);
		expect(codes(report)).toContain("schema");
	});

	it("rejects C0 control characters in identifiers", () => {
		const record = { ...rehash(startedMaterial("run-1", 0)), runId: "bad\u0001id" } as RunJournalRecord;
		const report = inspectRunJournal(enc(`${serializeRunJournalLine(record)}\n`), testHash);
		expect(codes(report)).toContain("schema");
	});

	it("rejects credential-shaped identifiers", () => {
		const record = {
			...rehash(startedMaterial("run-1", 0)),
			runId: "sk-abcdefghijklmnopqrstuvwxyz123456",
		} as RunJournalRecord;
		const report = inspectRunJournal(enc(`${serializeRunJournalLine(record)}\n`), testHash);
		expect(codes(report)).toContain("schema");
	});

	it("rejects a negative session revision", () => {
		const record = { ...rehash(startedMaterial("run-1", 0)), sessionRevision: -1 } as RunJournalRecord;
		const report = inspectRunJournal(enc(`${serializeRunJournalLine(record)}\n`), testHash);
		expect(codes(report)).toContain("schema");
	});

	it("rejects a non-canonical timestamp", () => {
		const record = { ...rehash(startedMaterial("run-1", 0)), timestamp: "today" } as RunJournalRecord;
		const report = inspectRunJournal(enc(`${serializeRunJournalLine(record)}\n`), testHash);
		expect(codes(report)).toContain("schema");
	});

	it("rejects a credential-shaped termination message as a termination mismatch", () => {
		const termination = {
			...finishedTermination("run-1"),
			message: "api_key=supersecretvalue123",
		} as SessionTermination;
		const bytes = buildBytes([
			startedMaterial("run-1", 0),
			terminalMaterial("run_finished", "run-1", 1, termination),
		]);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("termination_mismatch");
	});
});

describe("RunJournal construction bounds", () => {
	const base = { hashFn: testHash, sessionId: SESSION, runId: "run-1", sessionRevision: 0, timestamp: NOW };

	it("rejects credential-shaped, C0-bearing, and oversized identifiers", () => {
		expect(() => new RunJournal({ ...base, sessionId: "sk-abcdefghijklmnopqrstuvwxyz123456" })).toThrow("credential");
		expect(() => new RunJournal({ ...base, runId: "bad\u0001id" })).toThrow("C0 or DEL");
		expect(() => new RunJournal({ ...base, runId: "x".repeat(129) })).toThrow("bounded text");
	});

	it("rejects negative revisions and non-canonical timestamps", () => {
		expect(() => new RunJournal({ ...base, sessionRevision: -1 })).toThrow("non-negative safe integer");
		expect(() => new RunJournal({ ...base, timestamp: "2026-07-16T00:00:00Z" })).toThrow("canonical ISO-8601");
	});

	it("rejects a non-function hash function", () => {
		expect(() => new RunJournal({ ...base, hashFn: "nope" as never })).toThrow("hashFn must be a function");
	});
});

describe("frozen outputs", () => {
	it("returns deeply immutable records and reports", () => {
		const journal = new RunJournal({
			hashFn: testHash,
			sessionId: SESSION,
			runId: "run-1",
			sessionRevision: 0,
			timestamp: NOW,
		});
		const started = journal.records[0];
		expect(Object.isFrozen(started)).toBe(true);
		expect(() => {
			(started as unknown as { runId: string }).runId = "mutated";
		}).toThrow(TypeError);
		const report = inspectRunJournal(journal.toBytes(), testHash);
		expect(Object.isFrozen(report)).toBe(true);
		expect(() => {
			(report.records[0] as unknown as { seq: number }).seq = 99;
		}).toThrow(TypeError);
	});
});

describe("P73 hardening regressions", () => {
	const base = { hashFn: testHash, sessionId: SESSION, runId: "run-1", sessionRevision: 0, timestamp: NOW };

	// (1) TS2345: widened record-key receiver must still reject extra keys on a terminal record.
	it("rejects an extra key on a terminal record via exact-key validation", () => {
		const record = {
			...rehash(terminalMaterial("run_finished", "run-1", 1, finishedTermination("run-1"))),
			extra: "field",
		} as unknown as RunJournalRecord;
		const report = inspectRunJournal(enc(`${serializeRunJournalLine(record)}\n`), testHash);
		expect(codes(report)).toContain("schema");
	});

	// (2) records getter returns a frozen snapshot, refreshed after each append; not the live array.
	it("records getter returns a frozen, refreshed snapshot that is not the live array", () => {
		const journal = new RunJournal({ ...base });
		const before = journal.records;
		expect(Object.isFrozen(before)).toBe(true);
		expect(before).toHaveLength(1);
		journal.finish({ termination: finishedTermination("run-1", SESSION, NOW2), sessionRevision: 0, timestamp: NOW2 });
		const after = journal.records;
		expect(after).toHaveLength(2);
		expect(before).toHaveLength(1);
		expect(after).not.toBe(before);
		expect(() => (after as readonly unknown[] as unknown[]).push({} as never)).toThrow(TypeError);
	});

	// (2) external mutation of a captured snapshot cannot affect serialize or the FSM.
	it("external mutation of a captured snapshot cannot affect serialize or the FSM", () => {
		const journal = new RunJournal({ ...base });
		const snap = journal.records;
		expect(() => {
			(snap as readonly unknown[] as unknown[]).length = 0;
		}).toThrow(TypeError);
		const serializedBefore = journal.serialize();
		journal.finish({ termination: finishedTermination("run-1", SESSION, NOW2), sessionRevision: 0, timestamp: NOW2 });
		const serializedAfter = journal.serialize();
		expect(serializedAfter).not.toBe(serializedBefore);
		expect(serializedAfter.split("\n").filter((line) => line.length > 0)).toHaveLength(2);
		expect(snap).toHaveLength(1);
	});

	// (3) Bearer / sensitive-assignment credential shapes rejected in writer identifiers.
	it("rejects Bearer and sensitive-assignment credential shapes in writer identifiers", () => {
		expect(() => new RunJournal({ ...base, runId: "Bearer abcdefghijk123456" })).toThrow("credential");
		expect(() => new RunJournal({ ...base, sessionId: "api_key=topsecret123" })).toThrow("credential");
	});

	// (3) Bearer / sensitive-assignment credential shapes rejected by the inspector.
	it("rejects Bearer and sensitive-assignment credential shapes in inspected identifiers", () => {
		const bearer = { ...rehash(startedMaterial("run-1", 0)), runId: "Bearer abcdefghijk123456" } as RunJournalRecord;
		expect(codes(inspectRunJournal(enc(`${serializeRunJournalLine(bearer)}\n`), testHash))).toContain("schema");
		const assigned = {
			...rehash(startedMaterial("run-1", 0)),
			sessionId: "api_key=topsecret123",
		} as RunJournalRecord;
		expect(codes(inspectRunJournal(enc(`${serializeRunJournalLine(assigned)}\n`), testHash))).toContain("schema");
	});

	// (4) strict plain-data / exact-key validation at every writer trust boundary.
	it("rejects array, accessor-bearing, and extra-key inputs at writer trust boundaries", () => {
		expect(() => new RunJournal({ ...base, extra: "field" } as never)).toThrow("bounded fields");
		expect(() => new RunJournal([] as unknown as never)).toThrow("plain object");
		const journal = new RunJournal({ ...base });
		journal.finish({ termination: finishedTermination("run-1", SESSION, NOW2), sessionRevision: 0, timestamp: NOW2 });
		const accessorInput = { runId: "run-2", sessionRevision: 0, timestamp: NOW3 } as RunJournalStartInput;
		Object.defineProperty(accessorInput, "runId", { get: () => "run-2", enumerable: true, configurable: true });
		expect(() => journal.start(accessorInput)).toThrow("accessor");
		expect(() =>
			journal.recover({
				termination: recoveredTermination("run-1"),
				sessionRevision: 0,
				timestamp: NOW2,
				extra: 1,
			} as never),
		).toThrow("bounded fields");
	});

	// (5) classifier matrix coherence is enforced in the writer.
	it("rejects forged incoherent terminations in the writer (classifier matrix)", () => {
		const journal = new RunJournal({ ...base });
		const forged = (override: Partial<SessionTermination>): SessionTermination =>
			({ ...finishedTermination("run-1", SESSION, NOW2), ...override }) as SessionTermination;
		expect(() =>
			journal.finish({ termination: forged({ kind: "provider_network" }), sessionRevision: 0, timestamp: NOW2 }),
		).toThrow("incoherent");
		expect(() =>
			journal.finish({ termination: forged({ phase: "provider" }), sessionRevision: 0, timestamp: NOW2 }),
		).toThrow("incoherent");
		expect(() =>
			journal.finish({ termination: forged({ retryable: true }), sessionRevision: 0, timestamp: NOW2 }),
		).toThrow("incoherent");
		expect(() =>
			journal.finish({ termination: forged({ safeToAutoRetry: true }), sessionRevision: 0, timestamp: NOW2 }),
		).toThrow("incoherent");
		expect(() =>
			journal.finish({ termination: forged({ processSignal: "SIGTERM" }), sessionRevision: 0, timestamp: NOW2 }),
		).toThrow("processSignal");
		const ti = transcriptTermination("run-1", SESSION, NOW2);
		expect(() =>
			journal.finish({
				termination: { ...ti, transcriptIssue: "duplicate_result" } as SessionTermination,
				sessionRevision: 0,
				timestamp: NOW2,
			}),
		).toThrow("transcriptIssue");
		// safeToAutoRetry: observed + sideEffects none + provider rate_limit/network/refusal.
		expect(() =>
			journal.finish({
				termination: rateLimitTermination("run-1", SESSION, NOW2),
				sessionRevision: 0,
				timestamp: NOW2,
			}),
		).not.toThrow();
	});

	// (5) classifier matrix coherence is enforced by the inspector.
	it("rejects forged incoherent terminations as termination_mismatch in the inspector", () => {
		const forged = { ...finishedTermination("run-1"), kind: "provider_network" } as SessionTermination;
		const bytes = buildBytes([startedMaterial("run-1", 0), terminalMaterial("run_finished", "run-1", 1, forged)]);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("termination_mismatch");
		expect(report.records).toHaveLength(1);
	});

	// (6) run_recovered specifically requires a coherent process_crash termination.
	it("run_recovered requires a coherent process_crash termination", () => {
		const journal = new RunJournal({ ...base });
		expect(() =>
			journal.recover({
				termination: finishedTermination("run-1", SESSION, NOW2),
				sessionRevision: 0,
				timestamp: NOW2,
			}),
		).toThrow("run_recovered requires");
	});

	// (6) terminal event timestamp must equal the termination timestamp (writer).
	it("requires a terminal event timestamp to equal the termination timestamp in the writer", () => {
		const journal = new RunJournal({ ...base });
		expect(() =>
			journal.finish({
				termination: finishedTermination("run-1", SESSION, NOW),
				sessionRevision: 0,
				timestamp: NOW2,
			}),
		).toThrow("timestamp must equal");
	});

	// (6) terminal event timestamp must equal the termination timestamp (inspector).
	it("flags a terminal whose event timestamp differs from its termination timestamp", () => {
		const term = finishedTermination("run-1", SESSION, NOW2);
		const bytes = buildBytes([startedMaterial("run-1", 0), terminalMaterial("run_finished", "run-1", 1, term, NOW)]);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("termination_mismatch");
		expect(report.records).toHaveLength(1);
	});

	// (7) one sessionId per journal; a foreign sessionId is flagged.
	it("flags a session_mismatch when a record carries a different sessionId", () => {
		const foreignStart = { ...startedMaterial("run-2", 1), sessionId: "session-other" };
		const bytes = buildBytes([startedMaterial("run-1", 0), foreignStart]);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("session_mismatch");
		expect(report.records).toHaveLength(1);
	});

	// (7) nondecreasing sessionRevision; a regression is flagged.
	it("flags a session_revision_regression when a record regresses the revision", () => {
		const bytes = buildBytes([{ ...startedMaterial("run-1", 0, 3) }, { ...startedMaterial("run-2", 1, 1) }]);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("session_revision_regression");
		expect(report.records).toHaveLength(1);
	});

	// (7) writer enforces nondecreasing sessionRevision.
	it("enforces nondecreasing sessionRevision across the journal in the writer", () => {
		const journal = new RunJournal({ ...base, sessionRevision: 5 });
		journal.finish({ termination: finishedTermination("run-1", SESSION, NOW2), sessionRevision: 5, timestamp: NOW2 });
		expect(() => journal.start({ runId: "run-2", sessionRevision: 3, timestamp: NOW3 })).toThrow("regress");
	});

	// (7) trusted caller-supplied seq/prevHash continuation chain head is honored.
	it("continues from a trusted caller-supplied seq and prevHash chain head", () => {
		const prev = "a".repeat(64);
		const journal = new RunJournal({ ...base, sessionRevision: 7, prevHash: prev, seq: 42 });
		const started = journal.records[0];
		expect(started.seq).toBe(42);
		expect(started.prevHash).toBe(prev);
		expect(started.sessionRevision).toBe(7);
	});

	// (8) invalid records fail closed while later chain/seq discontinuity stays visible.
	it("invalid records fail closed while later chain/seq discontinuity stays visible", () => {
		const forged = { ...finishedTermination("run-1"), kind: "provider_network" } as SessionTermination;
		const bytes = buildBytes([
			startedMaterial("run-1", 0),
			terminalMaterial("run_finished", "run-1", 1, forged),
			terminalMaterial("run_finished", "run-1", 2, finishedTermination("run-1")),
		]);
		const report = inspectRunJournal(bytes, testHash);
		expect(codes(report)).toContain("termination_mismatch");
		expect(report.records).toHaveLength(2);
		expect(codes(report)).toContain("seq_gap");
		expect(codes(report)).toContain("hash_chain_break");
	});
});

describe("static forbidden API scan", () => {
	const sourceText = readFileSync(fileURLToPath(new URL("../src/core/run-journal.ts", import.meta.url)), "utf8");
	const forbidden: readonly RegExp[] = [
		/node:/,
		/require\(/,
		/\bfrom\s+["'](fs|path|crypto|child_process|os|stream|buffer|util|events|http|net|tls)["']/,
		/\bglobalThis\b/,
		/\bprocess\./,
		/\bDate\.now\b/,
		/\bMath\.random\b/,
		/\bcrypto\b/,
		/\bBuffer\b/,
		/\bsetTimeout\b/,
		/\bsetInterval\b/,
		/\bsetImmediate\b/,
		/\bfsync\b/,
	];

	it("does not use any nondeterministic, I/O, or Node-only primitives", () => {
		const hits = forbidden.filter((pattern) => pattern.test(sourceText));
		expect(hits, `forbidden tokens found: ${hits.map((pattern) => pattern.source).join(", ")}`).toEqual([]);
	});

	it("uses TextEncoder/TextDecoder and JSON only from the runtime globals", () => {
		expect(sourceText).toContain("TextEncoder");
		expect(sourceText).toContain("TextDecoder");
	});
});

describe("audit records (ALG004-A / ALG001-B vocabulary)", () => {
	function auditJournal() {
		return new RunJournal({
			hashFn: testHash,
			sessionId: SESSION,
			runId: "run-1",
			sessionRevision: 0,
			timestamp: NOW,
			openInitialRun: false,
		});
	}

	it("appends hash-chained audit records without opening or closing a run", () => {
		const journal = auditJournal();
		expect(journal.openRunId).toBeNull();
		expect(journal.records).toHaveLength(0);

		const timeout = journal.audit({
			event: "tool_timeout",
			details: { toolCallId: "call-1", toolName: "bash", timeoutMs: 300_000, executionStarted: true },
			sessionRevision: 0,
			timestamp: NOW,
		});
		const late = journal.audit({
			event: "tool_late_settlement",
			details: {
				toolCallId: "call-1",
				toolName: "bash",
				disposition: "timeout",
				outcome: "resolved",
				sessionRisk: "elevated",
			},
			sessionRevision: 0,
			timestamp: NOW2,
		});
		const repaired = journal.audit({
			event: "transcript_repaired",
			details: { insertedToolCallIds: ["call-9"], reason: "resume" },
			sessionRevision: 0,
			timestamp: NOW3,
		});

		expect(journal.openRunId).toBeNull();
		expect(timeout.seq).toBe(0);
		expect(timeout.prevHash).toBe(GENESIS_HASH);
		expect(late.prevHash).toBe(timeout.hash);
		expect(repaired.prevHash).toBe(late.hash);
		expect(journal.records).toHaveLength(3);

		// The serialized journal round-trips through the inspector with no findings.
		const report = inspectRunJournal(journal.toBytes(), testHash);
		expect(report.findings).toEqual([]);
		expect(report.ok).toBe(true);
		expect(report.records.map((record) => record.event)).toEqual([
			"tool_timeout",
			"tool_late_settlement",
			"transcript_repaired",
		]);
		expect(report.openRunId).toBeNull();
	});

	it("interleaves audit records with run lifecycle records", () => {
		const journal = new RunJournal({
			hashFn: testHash,
			sessionId: SESSION,
			runId: "run-1",
			sessionRevision: 0,
			timestamp: NOW,
		});
		journal.audit({
			event: "tool_timeout",
			details: { toolCallId: "call-1", toolName: "read", timeoutMs: 30_000, executionStarted: true },
			sessionRevision: 0,
			timestamp: NOW2,
		});
		journal.finish({ termination: finishedTermination("run-1", SESSION, NOW3), sessionRevision: 0, timestamp: NOW3 });

		const report = inspectRunJournal(journal.toBytes(), testHash);
		expect(report.ok).toBe(true);
		expect(report.records.map((record) => record.event)).toEqual(["run_started", "tool_timeout", "run_finished"]);
		expect(report.openRunId).toBeNull();
	});

	it("rejects out-of-bounds audit payloads fail-closed", () => {
		const journal = auditJournal();
		expect(() =>
			journal.audit({
				event: "tool_timeout",
				details: { toolCallId: "call-1", toolName: "bash", timeoutMs: -1 },
				sessionRevision: 0,
				timestamp: NOW,
			}),
		).toThrow();
		expect(() =>
			journal.audit({
				event: "tool_late_settlement",
				details: {
					toolCallId: "call-1",
					toolName: "bash",
					disposition: "sideways",
					outcome: "resolved",
				} as unknown as RunJournalAuditDetails,
				sessionRevision: 0,
				timestamp: NOW,
			}),
		).toThrow();
		expect(() =>
			journal.audit({
				event: "transcript_repaired",
				details: {
					insertedToolCallIds: ["x"],
					reason: "resume",
					extraField: true,
				} as unknown as RunJournalAuditDetails,
				sessionRevision: 0,
				timestamp: NOW,
			}),
		).toThrow();
		// Credential-shaped text never persists.
		expect(() =>
			journal.audit({
				event: "transcript_repaired",
				details: { insertedToolCallIds: ["sk-abcdefghijklmnopqrstuv"], reason: "resume" },
				sessionRevision: 0,
				timestamp: NOW,
			}),
		).toThrow();
		expect(journal.records).toHaveLength(0);
	});

	it("flags a tampered audit record hash on inspection", () => {
		const journal = auditJournal();
		journal.audit({
			event: "tool_timeout",
			details: { toolCallId: "call-1", toolName: "bash", timeoutMs: 1, executionStarted: false },
			sessionRevision: 0,
			timestamp: NOW,
		});
		const tampered = journal.serialize().replace('"toolName":"bash"', '"toolName":"edit"');
		const report = inspectRunJournal(enc(tampered), testHash);
		expect(report.ok).toBe(false);
		expect(report.findings.some((finding) => finding.code === "hash_mismatch")).toBe(true);
	});
});
