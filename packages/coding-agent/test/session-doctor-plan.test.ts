/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vitest";
import * as currentAgentCore from "../../agent/src/index.ts";
import {
	type CompactionBarrierResult,
	createCompactionSourceIdentity,
	createCompactionTransaction,
	createSessionRevisionToken,
	decideCompactionCommit,
} from "../src/core/compaction/transaction.ts";
import {
	GENESIS_HASH,
	inspectRunJournal,
	RUN_JOURNAL_SCHEMA_VERSION,
	RunJournal,
	type RunJournalRecord,
	type RunJournalStartedRecord,
	type RunJournalTerminalRecord,
	serializeRunJournalLine,
	serializeRunJournalMaterial,
} from "../src/core/run-journal.ts";
import {
	planSessionDoctor,
	SESSION_DOCTOR_PLAN_SCHEMA_VERSION,
	type SessionDoctorPlan,
	type SessionDoctorPlanInput,
} from "../src/core/session-doctor-plan.ts";
import moduleSource from "../src/core/session-doctor-plan.ts?raw";
import { inspectSessionIntegrity } from "../src/core/session-integrity.ts";
import type { SessionPathAccessInput, SessionPathEvidence, SessionPathStat } from "../src/core/session-path-policy.ts";
import { classifySessionTermination, type SessionTermination } from "../src/core/session-termination.ts";

vi.mock("omk-agent-core", () => currentAgentCore);

// -------------------------------------------------------------------------------------------------
// Shared constants.
// -------------------------------------------------------------------------------------------------

const SESSION = "session-1";
const NOW = "2026-07-16T00:00:00.000Z";
const NOW2 = "2026-07-16T00:00:01.000Z";
const REPAIR_ID = "repair-1";
const TS = 123;

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

// -------------------------------------------------------------------------------------------------
// Session report fixtures.
// -------------------------------------------------------------------------------------------------

const header = {
	type: "session",
	version: 3,
	id: SESSION,
	timestamp: "2026-07-15T00:00:00.000Z",
	cwd: "/workspace",
};

function assistant(calls: readonly string[]) {
	return {
		role: "assistant",
		content: calls.map((id) => ({ type: "toolCall", id, name: `tool-${id}`, arguments: {} })),
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}
function result(toolCallId: string) {
	return {
		role: "toolResult",
		toolCallId,
		toolName: `tool-${toolCallId}`,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 1,
	};
}
function entry(id: string, parentId: string | null, message: unknown) {
	return { type: "message", id, parentId, timestamp: "2026-07-15T00:00:00.000Z", message };
}
function jsonl(records: readonly unknown[]): Uint8Array {
	return encoder.encode(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}
function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function cleanReport() {
	return inspectSessionIntegrity(jsonl([header]));
}
function trailingMissingReport() {
	const complete = jsonl([header, entry("call", null, assistant(["a", "b"]))]);
	return inspectSessionIntegrity(concatBytes(complete, enc('{"type":"message"')));
}
function missingReport() {
	return inspectSessionIntegrity(jsonl([header, entry("call", null, assistant(["a", "b"]))]));
}
function ambiguousReport() {
	return inspectSessionIntegrity(
		jsonl([
			header,
			entry("call-ab", null, assistant(["a", "b"])),
			entry("result-b", "call-ab", result("b")),
			entry("call-c", "result-b", assistant(["c"])),
			entry("result-c", "call-c", result("c")),
		]),
	);
}

// -------------------------------------------------------------------------------------------------
// Journal fixtures.
// -------------------------------------------------------------------------------------------------

type Material = Omit<RunJournalStartedRecord, "hash"> | Omit<RunJournalTerminalRecord, "hash">;

function rehash(material: Material): RunJournalRecord {
	const hash = testHash(enc(serializeRunJournalMaterial(material)));
	return { ...material, hash } as RunJournalRecord;
}
function buildJournalBytes(materials: readonly Material[], trailing = ""): Uint8Array {
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
function startedMaterial(runId: string, seq: number): Material {
	return {
		schemaVersion: RUN_JOURNAL_SCHEMA_VERSION,
		seq,
		event: "run_started",
		runId,
		sessionId: SESSION,
		sessionRevision: 0,
		timestamp: NOW,
		prevHash: GENESIS_HASH,
	};
}
function finishedTermination(runId: string): SessionTermination {
	return classifySessionTermination({
		sessionId: SESSION,
		runId,
		timestamp: NOW2,
		source: "observed",
		message: "run completed",
		cause: { area: "completed" },
		sideEffects: "none",
	});
}
function recoveredTermination(runId: string): SessionTermination {
	return classifySessionTermination({
		sessionId: SESSION,
		runId,
		timestamp: NOW2,
		source: "inferred_on_resume",
		message: "prior run crash inferred on resume",
		cause: { area: "process", code: "crash" },
		sideEffects: "possible",
	});
}
function terminalMaterial(
	event: "run_finished" | "run_recovered",
	runId: string,
	seq: number,
	termination: SessionTermination,
): Material {
	return {
		schemaVersion: RUN_JOURNAL_SCHEMA_VERSION,
		seq,
		event,
		runId,
		sessionId: SESSION,
		sessionRevision: 0,
		timestamp: NOW2,
		prevHash: GENESIS_HASH,
		termination,
	};
}

/** Build the started bytes (unclosed run) plus a coherent run_recovered terminal record. */
function unclosedRunAndRecovery(): { bytes: Uint8Array; terminal: RunJournalTerminalRecord } {
	const journal = new RunJournal({
		hashFn: testHash,
		sessionId: SESSION,
		runId: "run-1",
		sessionRevision: 0,
		timestamp: NOW,
	});
	const started = journal.records[0];
	const recovered = journal.recover({
		termination: recoveredTermination("run-1"),
		sessionRevision: 0,
		timestamp: NOW2,
	});
	return { bytes: enc(`${serializeRunJournalLine(started)}\n`), terminal: recovered };
}

// -------------------------------------------------------------------------------------------------
// Path fixtures.
// -------------------------------------------------------------------------------------------------

const SESSION_FILE = "/sessions/session-1.json";
const JOURNAL_FILE = "/sessions/session-1.journal";

function pathStat(): SessionPathStat {
	return { dev: "11", ino: "22", nlink: 1, size: 64, mtime: 1000, regular: true, owner: "1000" };
}
function pathEvidence(root: string, target: string, chainLinkKind: "none" | "symlink" = "none"): SessionPathEvidence {
	return {
		schemaVersion: 1,
		platform: "posix" as const,
		trustedRootLexical: root,
		trustedRootRealpath: root,
		target: { lexical: target, realpath: target },
		chain: [
			{ lexical: root, realpath: root, linkKind: "none" as const },
			{ lexical: target, realpath: target, linkKind: chainLinkKind },
		],
		statBefore: pathStat(),
		statAfter: pathStat(),
		opened: { dev: "11", ino: "22" },
	};
}
function authorizedSessionPath(stale = false): Omit<SessionPathAccessInput, "intent"> {
	return {
		platform: "posix" as const,
		root: "/sessions",
		target: SESSION_FILE,
		identity: { owner: "1000" },
		evidence: pathEvidence("/sessions", SESSION_FILE),
		lock: stale
			? { state: "stale" as const, sameHost: true, pidDefinitelyAbsent: true, holderPid: "1234" }
			: { state: "absent" as const, sameHost: true, pidDefinitelyAbsent: true, holderPid: null },
	};
}
function authorizedJournalPath(): Omit<SessionPathAccessInput, "intent"> {
	return {
		platform: "posix" as const,
		root: "/sessions",
		target: JOURNAL_FILE,
		identity: { owner: "1000" },
		evidence: pathEvidence("/sessions", JOURNAL_FILE),
		lock: { state: "absent" as const, sameHost: true, pidDefinitelyAbsent: true, holderPid: null },
	};
}
/** A posix authorized path with a stale lock on an arbitrary target and holder pid. */
function staleLockPath(target: string, holderPid: string): Omit<SessionPathAccessInput, "intent"> {
	return {
		platform: "posix" as const,
		root: "/sessions",
		target,
		identity: { owner: "1000" },
		evidence: pathEvidence("/sessions", target),
		lock: { state: "stale" as const, sameHost: true, pidDefinitelyAbsent: true, holderPid },
	};
}
function externalSessionPath(): Omit<SessionPathAccessInput, "intent"> {
	return {
		platform: "posix" as const,
		root: "/sessions",
		target: "/etc/passwd",
		identity: { owner: "1000" },
		evidence: pathEvidence("/sessions", "/etc/passwd"),
		lock: { state: "absent" as const, sameHost: true, pidDefinitelyAbsent: true, holderPid: null },
	};
}
function symlinkSessionPath(): Omit<SessionPathAccessInput, "intent"> {
	return {
		platform: "posix" as const,
		root: "/sessions",
		target: SESSION_FILE,
		identity: { owner: "1000" },
		evidence: pathEvidence("/sessions", SESSION_FILE, "symlink"),
		lock: { state: "absent" as const, sameHost: true, pidDefinitelyAbsent: true, holderPid: null },
	};
}

// -------------------------------------------------------------------------------------------------
// Compaction fixtures.
// -------------------------------------------------------------------------------------------------

function validSha256() {
	return "a".repeat(64);
}
function revisionToken(overrides: Record<string, unknown> = {}) {
	return createSessionRevisionToken({
		sessionId: SESSION,
		completeBytes: 100,
		recordCount: 3,
		leafId: "leaf-1",
		lastEntryId: "entry-3",
		completePrefixSha256: validSha256(),
		...overrides,
	});
}
function sourceIdentity(overrides: Record<string, unknown> = {}) {
	const leafId = (overrides.activeLeafId as string) ?? (overrides.lastEntryId as string) ?? "leaf-1";
	const input: Record<string, unknown> = {
		sessionId: SESSION,
		entryIds: ["entry-1", "entry-2", leafId],
		firstEntryId: "entry-1",
		lastEntryId: leafId,
		sourceSha256: validSha256(),
		activeLeafId: leafId,
		messageCount: 2,
	};
	Object.assign(input, overrides);
	return createCompactionSourceIdentity(input as never);
}
function compactionTransaction(overrides: Record<string, unknown> = {}) {
	const rev = revisionToken();
	const src = sourceIdentity({ sessionId: SESSION, activeLeafId: rev.leafId, lastEntryId: rev.leafId });
	return createCompactionTransaction({
		transactionId: "txn-1",
		baseRevision: rev,
		source: src,
		createdAt: "2026-07-16T00:00:00.000Z",
		model: { provider: "test", id: "model-1" },
		preserved: {
			latestIntent: "intent",
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
		...overrides,
	});
}
function readyBarrier(): CompactionBarrierResult {
	return {
		status: "ready",
		reason: "closed_active_branch",
		pendingToolCallIds: Object.freeze([]),
		missingToolCallIds: Object.freeze([]),
	};
}
function staleCompaction() {
	const txn = compactionTransaction();
	return {
		transaction: txn,
		currentRevision: revisionToken({ completeBytes: 999, sessionId: SESSION }),
		currentSource: txn.source,
		barrier: readyBarrier(),
		priorCommittedSourceDigests: [] as readonly string[],
	};
}
/** A stale compaction whose source digest differs (source_mismatch). */
function staleSourceCompaction() {
	const txn = compactionTransaction();
	const foreignSource = sourceIdentity({
		sessionId: SESSION,
		activeLeafId: "leaf-1",
		lastEntryId: "leaf-1",
		sourceSha256: "b".repeat(64),
	});
	return {
		transaction: txn,
		currentRevision: txn.baseRevision,
		currentSource: foreignSource,
		barrier: readyBarrier(),
		priorCommittedSourceDigests: [] as readonly string[],
	};
}
function commitCompaction() {
	const txn = compactionTransaction();
	return {
		transaction: txn,
		currentRevision: txn.baseRevision,
		currentSource: txn.source,
		barrier: readyBarrier(),
		priorCommittedSourceDigests: [] as readonly string[],
	};
}

// -------------------------------------------------------------------------------------------------
// Plan helper.
// -------------------------------------------------------------------------------------------------

function plan(overrides: Partial<SessionDoctorPlanInput> & object = {}): SessionDoctorPlan {
	const base: SessionDoctorPlanInput = {
		mode: "inspect",
		sessionId: SESSION,
		repairId: REPAIR_ID,
		timestamp: TS,
		report: cleanReport(),
	};
	return planSessionDoctor({ ...base, ...overrides });
}

function reasons(planResult: SessionDoctorPlan): string[] {
	return planResult.findings.map((f) => f.reason);
}

// =================================================================================================
// Clean plans across all modes.
// =================================================================================================

describe("clean plans", () => {
	it("is healthy exit 0 with no actions in inspect mode", () => {
		for (const result of [plan({ mode: "inspect" }), plan({ mode: "repair_dry_run" }), plan({ mode: "repair" })]) {
			expect(result.schemaVersion).toBe(SESSION_DOCTOR_PLAN_SCHEMA_VERSION);
			expect(result.sessionId).toBe(SESSION);
			expect(result.repairId).toBe(REPAIR_ID);
			expect(result.status).toBe("healthy");
			expect(result.exitCode).toBe(0);
			expect(result.repairable).toBe(false);
			expect(result.requiresReinspection).toBe(false);
			expect(result.scheduledWrites).toBe(0);
			expect(result.actions).toEqual([]);
			expect(result.findings).toEqual([]);
		}
	});

	it("reports an advisory compaction commit as clean exit 0", () => {
		const result = plan({ mode: "inspect", compaction: commitCompaction() });
		expect(result.status).toBe("healthy");
		expect(result.exitCode).toBe(0);
		expect(reasons(result)).toEqual(["compaction_committed"]);
		expect(result.findings[0]?.severity).toBe("advisory");
		expect(result.actions).toEqual([]);
	});
});

// =================================================================================================
// Session artifact.
// =================================================================================================

describe("session artifact", () => {
	it("surfaces trailing fragment and missing results as findings and actions", () => {
		const dry = plan({
			mode: "repair_dry_run",
			report: trailingMissingReport(),
			paths: { session: authorizedSessionPath() },
		});
		expect(reasons(dry)).toEqual(
			expect.arrayContaining(["session_trailing_fragment", "session_missing_tool_result"]),
		);
		expect(dry.status).toBe("issues");
		expect(dry.exitCode).toBe(1);
		expect(dry.repairable).toBe(true);
		expect(dry.actions.map((a) => a.kind)).toEqual([
			"quarantine_session_trailing_fragment",
			"append_synthetic_tool_result",
			"append_synthetic_tool_result",
		]);
		expect(dry.scheduledWrites).toBe(0);
		expect(dry.requiresReinspection).toBe(false);
	});

	it("plans synthetic results without a trailing fragment", () => {
		const dry = plan({
			mode: "repair_dry_run",
			report: missingReport(),
			paths: { session: authorizedSessionPath() },
		});
		expect(dry.actions.map((a) => a.kind)).toEqual(["append_synthetic_tool_result", "append_synthetic_tool_result"]);
		expect(
			dry.actions
				.filter((a) => a.kind === "append_synthetic_tool_result")
				.map((a) => (a.kind === "append_synthetic_tool_result" ? a.toolCallId : null)),
		).toEqual(["a", "b"]);
	});

	it("blocks ambiguous transcripts with no actions", () => {
		const result = plan({ mode: "repair_dry_run", report: ambiguousReport() });
		expect(result.status).toBe("issues");
		expect(result.exitCode).toBe(1);
		expect(result.actions).toEqual([]);
		expect(reasons(result)).toEqual(["session_blocked"]);
		expect(result.findings[0]?.code).toBe("transcript_interleaved_non_result");
	});

	it("requires a session path for session actions in dry/repair", () => {
		const dry = plan({ mode: "repair_dry_run", report: missingReport() });
		expect(dry.status).toBe("refused");
		expect(dry.exitCode).toBe(2);
		expect(dry.actions).toEqual([]);
		expect(reasons(dry)).toEqual(expect.arrayContaining(["session_path_unauthorized"]));
	});

	it("fails closed when a single finding would carry more than 64 ids (no silent truncation)", () => {
		const callIds = Array.from({ length: 65 }, (_, index) => `call-${index}`);
		const report = inspectSessionIntegrity(jsonl([header, entry("block", null, assistant(callIds))]));
		expect(() => plan({ mode: "inspect", report })).toThrow("failing closed");
	});

	it("synthetic tool-result actions carry a deep-copied frozen message anchored to the doctor reason and timestamp", () => {
		const dry = plan({
			mode: "repair_dry_run",
			report: missingReport(),
			paths: { session: authorizedSessionPath() },
		});
		const actions = dry.actions.filter((a) => a.kind === "append_synthetic_tool_result");
		expect(actions.length).toBe(2);
		for (const action of actions) {
			if (action.kind !== "append_synthetic_tool_result") continue;
			expect(action.message.role).toBe("toolResult");
			expect(action.message.toolCallId).toBe(action.toolCallId);
			expect(action.message.toolName).toBe(action.toolName);
			expect(action.message.isError).toBe(true);
			expect(action.message.timestamp).toBe(TS);
			expect(action.message.content).toEqual([
				{ type: "text", text: "Tool result missing; synthesized by session doctor repair" },
			]);
			expect(Object.isFrozen(action.message)).toBe(true);
			expect(Object.isFrozen(action.message.content)).toBe(true);
		}
	});

	it("normalizes session action order to quarantine first then appends sorted by repair sequence", () => {
		const dry = plan({
			mode: "repair_dry_run",
			report: trailingMissingReport(),
			paths: { session: authorizedSessionPath() },
		});
		expect(dry.actions.map((a) => a.kind)).toEqual([
			"quarantine_session_trailing_fragment",
			"append_synthetic_tool_result",
			"append_synthetic_tool_result",
		]);
		const sequences = dry.actions
			.filter((a) => a.kind === "append_synthetic_tool_result")
			.map((a) => (a.kind === "append_synthetic_tool_result" ? a.repairSequence : null));
		expect(sequences).toEqual([0, 1]);
		// Reported action sequence numbers stay contiguous from zero after normalization.
		expect(dry.actions.map((a) => a.sequence)).toEqual([0, 1, 2]);
	});
});

// =================================================================================================
// Journal artifact.
// =================================================================================================

describe("journal artifact", () => {
	it("observes a clean journal with no findings or actions", () => {
		const bytes = buildJournalBytes([
			startedMaterial("run-1", 0),
			terminalMaterial("run_finished", "run-1", 1, finishedTermination("run-1")),
		]);
		const result = plan({ mode: "inspect", journal: { bytes, hashFn: testHash } });
		expect(result.status).toBe("healthy");
		expect(result.exitCode).toBe(0);
		expect(result.findings).toEqual([]);
		expect(result.actions).toEqual([]);
	});

	it("quarantines a trailing fragment in dry/repair with an authorized journal path", () => {
		const bytes = buildJournalBytes([startedMaterial("run-1", 0)], '{"event":"run_started"');
		const dry = plan({
			mode: "repair_dry_run",
			journal: { bytes, hashFn: testHash },
			paths: { journal: authorizedJournalPath() },
		});
		expect(reasons(dry)).toEqual(expect.arrayContaining(["journal_trailing_fragment"]));
		expect(dry.actions.map((a) => a.kind)).toEqual(["quarantine_journal_trailing_fragment"]);
		const action = dry.actions[0];
		if (action?.kind !== "quarantine_journal_trailing_fragment") throw new Error("expected quarantine action");
		expect(action.lastCompleteHash).toMatch(/^[0-9a-f]{64}$/);
		expect(action.completePrefix.lineCount).toBe(1);
		expect(dry.scheduledWrites).toBe(0);
	});

	it("blocks hard journal findings (hash mismatch, malformed) with no actions", () => {
		const clean = buildJournalBytes([
			startedMaterial("run-1", 0),
			terminalMaterial("run_finished", "run-1", 1, finishedTermination("run-1")),
		]);
		const report = inspectRunJournal(clean, testHash);
		const tampered = { ...report.records[1], sessionRevision: 9 } as RunJournalRecord;
		const bytes = enc(`${[report.records[0], tampered].map(serializeRunJournalLine).join("\n")}\n`);
		const result = plan({ mode: "inspect", journal: { bytes, hashFn: testHash } });
		expect(result.status).toBe("issues");
		expect(result.exitCode).toBe(1);
		expect(result.actions).toEqual([]);
		expect(reasons(result)).toEqual(expect.arrayContaining(["journal_blocked"]));
		expect(result.findings.some((f) => f.code === "hash_mismatch")).toBe(true);

		const malformed = enc("{not json}\n");
		const malformedResult = plan({ mode: "inspect", journal: { bytes: malformed, hashFn: testHash } });
		expect(malformedResult.findings.some((f) => f.code === "malformed_json")).toBe(true);
	});

	it("recovers an unclosed run when the caller supplies a coherent run_recovered record", () => {
		const { bytes, terminal } = unclosedRunAndRecovery();
		const dry = plan({
			mode: "repair_dry_run",
			journal: { bytes, hashFn: testHash, terminalRecord: terminal },
			paths: { journal: authorizedJournalPath() },
		});
		expect(reasons(dry)).toEqual(expect.arrayContaining(["journal_unclosed"]));
		expect(dry.actions.map((a) => a.kind)).toEqual(["recover_run"]);
		const action = dry.actions[0];
		if (action?.kind !== "recover_run") throw new Error("expected recover_run");
		expect(action.runId).toBe("run-1");
		expect(action.terminalRecord.event).toBe("run_recovered");
		expect(dry.scheduledWrites).toBe(0);
	});

	it("recover_run is self-contained and subsumes quarantine for unclosed+trailing", () => {
		const { bytes: startedBytes, terminal } = unclosedRunAndRecovery();
		const bytes = concatBytes(startedBytes, enc('{"event":"run_started"'));
		const dry = plan({
			mode: "repair_dry_run",
			journal: { bytes, hashFn: testHash, terminalRecord: terminal },
			paths: { journal: authorizedJournalPath() },
		});
		// A single recover_run action subsumes the quarantine action.
		expect(dry.actions.map((a) => a.kind)).toEqual(["recover_run"]);
		const action = dry.actions[0];
		if (action?.kind !== "recover_run") throw new Error("expected recover_run");
		// Anchored fields copied verbatim from the authoritative first inspection.
		const first = inspectRunJournal(bytes, testHash);
		expect(action.completePrefix).toEqual({
			byteCount: first.completePrefix.byteCount,
			lineCount: first.completePrefix.lineCount,
		});
		const expectedHash = first.records.length > 0 ? first.records[first.records.length - 1].hash : GENESIS_HASH;
		expect(action.lastCompleteHash).toBe(expectedHash);
		// Raw append (no truncate-to-prefix) is invalid: the trailing fragment
		// fuses with the appended record and corrupts JSON parsing.
		const rawAppended = concatBytes(bytes, enc(`${serializeRunJournalLine(terminal)}\n`));
		expect(inspectRunJournal(rawAppended, testHash).ok).toBe(false);
	});

	it("uses a defensive byte copy so a mutating hashFn closure cannot destabilize recovery", () => {
		const { bytes, terminal } = unclosedRunAndRecovery();
		let mutationCount = 0;
		const mutatingHash = (input: Uint8Array): string => {
			mutationCount += 1;
			// Mutate the caller's bytes on every hash invocation.
			bytes[0] = 0xff;
			return testHash(input);
		};
		const result = plan({
			mode: "repair_dry_run",
			journal: { bytes, hashFn: mutatingHash, terminalRecord: terminal },
			paths: { journal: authorizedJournalPath() },
		});
		// The plan operated on its own stable copy, so recovery still succeeds.
		expect(result.actions.map((a) => a.kind)).toEqual(["recover_run"]);
		expect(result.status).toBe("issues");
		expect(mutationCount).toBeGreaterThan(0);
		// The closure did mutate the caller's original bytes (expected); the plan's
		// deterministic result came from the private copy, not the caller's buffer.
		expect(bytes[0]).toBe(0xff);
	});

	it("blocks an unclosed run when no terminal record is supplied", () => {
		const { bytes } = unclosedRunAndRecovery();
		const result = plan({ mode: "inspect", journal: { bytes, hashFn: testHash } });
		expect(reasons(result)).toEqual(expect.arrayContaining(["journal_unclosed"]));
		expect(result.status).toBe("issues");
		expect(result.exitCode).toBe(1);
		expect(result.actions).toEqual([]);
	});

	it("refuses (exit 2) a forged terminal record that fails re-inspection", () => {
		const { bytes, terminal } = unclosedRunAndRecovery();
		const forged = { ...terminal, hash: "f".repeat(64) } as RunJournalTerminalRecord;
		const result = plan({
			mode: "repair_dry_run",
			journal: { bytes, hashFn: testHash, terminalRecord: forged },
			paths: { journal: authorizedJournalPath() },
		});
		expect(result.status).toBe("refused");
		expect(result.exitCode).toBe(2);
		expect(result.findings.some((f) => f.code === "forged_terminal_record")).toBe(true);
		expect(result.actions).toEqual([]);
	});

	it("refuses (exit 2) a spurious terminal record on a journal with no unclosed run", () => {
		const bytes = buildJournalBytes([
			startedMaterial("run-1", 0),
			terminalMaterial("run_finished", "run-1", 1, finishedTermination("run-1")),
		]);
		const { terminal } = unclosedRunAndRecovery();
		const result = plan({
			mode: "repair_dry_run",
			journal: { bytes, hashFn: testHash, terminalRecord: terminal },
		});
		expect(result.status).toBe("refused");
		expect(result.exitCode).toBe(2);
		expect(result.findings.some((f) => f.code === "spurious_terminal_record")).toBe(true);
	});

	it("does not mint a termination or hash (re-inspection recomputes via hashFn)", () => {
		// A run_finished record cannot satisfy run_recovered recovery -> forged.
		const journal = new RunJournal({
			hashFn: testHash,
			sessionId: SESSION,
			runId: "run-1",
			sessionRevision: 0,
			timestamp: NOW,
		});
		const finished = journal.finish({
			termination: finishedTermination("run-1"),
			sessionRevision: 0,
			timestamp: NOW2,
		});
		const startedOnly = enc(`${serializeRunJournalLine(journal.records[0])}\n`);
		const result = plan({
			mode: "repair_dry_run",
			journal: { bytes: startedOnly, hashFn: testHash, terminalRecord: finished },
			paths: { journal: authorizedJournalPath() },
		});
		expect(result.status).toBe("refused");
		expect(result.exitCode).toBe(2);
	});
});

// =================================================================================================
// Path authorization per artifact.
// =================================================================================================

describe("path authorization", () => {
	it("refuses (exit 2) when a needed session path is missing in dry/repair", () => {
		const result = plan({ mode: "repair", report: missingReport() });
		expect(result.status).toBe("refused");
		expect(result.exitCode).toBe(2);
		expect(result.findings.some((f) => f.reason === "session_path_unauthorized" && f.code === "missing")).toBe(true);
	});

	it("reports an external target as an issue in inspect and refuses in dry", () => {
		const inspectResult = plan({
			mode: "inspect",
			report: missingReport(),
			paths: { session: externalSessionPath() },
		});
		expect(inspectResult.status).toBe("issues");
		expect(inspectResult.exitCode).toBe(1);
		expect(inspectResult.findings.some((f) => f.code === "target_external")).toBe(true);

		const dry = plan({
			mode: "repair_dry_run",
			report: missingReport(),
			paths: { session: externalSessionPath() },
		});
		expect(dry.status).toBe("refused");
		expect(dry.exitCode).toBe(2);
	});

	it("reports a symlink-in-chain path as blocked", () => {
		const inspectResult = plan({
			mode: "inspect",
			report: missingReport(),
			paths: { session: symlinkSessionPath() },
		});
		expect(inspectResult.findings.some((f) => f.code === "symlink_in_chain")).toBe(true);
		expect(inspectResult.status).toBe("issues");
	});

	it("derives an eligible stale-lock action from an authorized stale-lock path", () => {
		const dry = plan({
			mode: "repair_dry_run",
			paths: { session: authorizedSessionPath(true) },
		});
		expect(dry.actions.map((a) => a.kind)).toEqual(["remove_stale_lock"]);
		expect(dry.actions[0]?.artifact).toBe("session");
		expect(dry.scheduledWrites).toBe(0);
		expect(dry.repairable).toBe(true);
	});

	it("keeps session and journal path authorizations separate", () => {
		// Session action with an authorized session path but no journal path: journal not needed.
		const dry = plan({
			mode: "repair_dry_run",
			report: missingReport(),
			paths: { session: authorizedSessionPath() },
		});
		expect(dry.status).toBe("issues");
		expect(dry.exitCode).toBe(1);
		expect(dry.actions.every((a) => a.artifact === "session")).toBe(true);
	});

	it("marks refused plans as not repairable even when underlying actions exist", () => {
		// Missing required path -> refused, repairable false.
		const missing = plan({ mode: "repair", report: missingReport() });
		expect(missing.status).toBe("refused");
		expect(missing.exitCode).toBe(2);
		expect(missing.repairable).toBe(false);
		expect(missing.actions).toEqual([]);
		// External target -> refused, repairable false.
		const external = plan({
			mode: "repair_dry_run",
			report: missingReport(),
			paths: { session: externalSessionPath() },
		});
		expect(external.status).toBe("refused");
		expect(external.exitCode).toBe(2);
		expect(external.repairable).toBe(false);
		expect(external.actions).toEqual([]);
		// Inspect with eligible underlying actions stays repairable while actions stay hidden.
		const inspectEligible = plan({
			mode: "inspect",
			report: missingReport(),
			paths: { session: authorizedSessionPath() },
		});
		expect(inspectEligible.status).toBe("issues");
		expect(inspectEligible.actions).toEqual([]);
		expect(inspectEligible.repairable).toBe(true);
	});

	it("stale-lock actions carry the canonical physical target fields and a readonly artifacts array", () => {
		const dry = plan({
			mode: "repair_dry_run",
			paths: { session: authorizedSessionPath(true) },
		});
		const action = dry.actions[0];
		if (action?.kind !== "remove_stale_lock") throw new Error("expected remove_stale_lock");
		expect(action.platform).toBe("posix");
		expect(action.targetLexical).toBe(SESSION_FILE);
		expect(action.targetRealpath).toBe(SESSION_FILE);
		expect(action.holderPid).toBe("1234");
		expect(action.artifacts).toEqual(["session"]);
		expect(Object.isFrozen(action.artifacts)).toBe(true);
		expect(action.sequence).toBe(0);
	});

	it("deduplicates session+journal stale locks on the same physical target, merging artifacts deterministically", () => {
		const dry = plan({
			mode: "repair_dry_run",
			paths: {
				session: authorizedSessionPath(true),
				journal: staleLockPath(SESSION_FILE, "1234"),
			},
		});
		expect(dry.actions.map((a) => a.kind)).toEqual(["remove_stale_lock"]);
		const action = dry.actions[0];
		if (action?.kind !== "remove_stale_lock") throw new Error("expected remove_stale_lock");
		expect(action.artifacts).toEqual(["session", "journal"]);
		expect(action.holderPid).toBe("1234");
		expect(action.targetRealpath).toBe(SESSION_FILE);
		// Contiguous sequence after dedup.
		expect(dry.actions.map((a) => a.sequence)).toEqual([0]);
	});

	it("refuses when session+journal stale locks conflict on holderPid for the same target", () => {
		const dry = plan({
			mode: "repair_dry_run",
			paths: {
				session: authorizedSessionPath(true),
				journal: staleLockPath(SESSION_FILE, "5678"),
			},
		});
		expect(dry.status).toBe("refused");
		expect(dry.exitCode).toBe(2);
		expect(dry.actions).toEqual([]);
		expect(dry.findings.some((f) => f.code === "stale_lock_target_conflict")).toBe(true);
	});
});

// =================================================================================================
// Compaction artifact.
// =================================================================================================

describe("compaction artifact", () => {
	it("plans an abandon action for a stale compaction with an authorized session path", () => {
		const dry = plan({
			mode: "repair_dry_run",
			compaction: staleCompaction(),
			paths: { session: authorizedSessionPath() },
		});
		expect(reasons(dry)).toEqual(expect.arrayContaining(["compaction_stale"]));
		expect(dry.actions.map((a) => a.kind)).toEqual(["abandon_stale_compaction"]);
		expect(dry.actions[0]?.artifact).toBe("session");
	});

	it("refuses (exit 2) a stale compaction without an authorized session path", () => {
		const result = plan({ mode: "repair", compaction: staleCompaction() });
		expect(result.status).toBe("refused");
		expect(result.exitCode).toBe(2);
		expect(result.findings.some((f) => f.reason === "session_path_unauthorized")).toBe(true);
	});

	it("reports a commit as advisory clean info", () => {
		const result = plan({ mode: "inspect", compaction: commitCompaction() });
		expect(result.status).toBe("healthy");
		expect(result.exitCode).toBe(0);
		expect(reasons(result)).toEqual(["compaction_committed"]);
		expect(result.findings[0]?.severity).toBe("advisory");
	});

	it("refuses (exit 2) an invalid compaction input", () => {
		const txn = compactionTransaction();
		const result = plan({
			mode: "inspect",
			compaction: {
				transaction: txn,
				currentRevision: null as never,
				currentSource: txn.source,
				barrier: readyBarrier(),
				priorCommittedSourceDigests: [],
			},
		});
		expect(result.status).toBe("refused");
		expect(result.exitCode).toBe(2);
		expect(result.findings.some((f) => f.code === "invalid_commit_input")).toBe(true);
	});

	it("cross-checks the planner against direct decideCompactionCommit", () => {
		const txn = compactionTransaction();
		const direct = decideCompactionCommit({
			transaction: txn,
			currentRevision: txn.baseRevision,
			currentSource: txn.source,
			barrier: readyBarrier(),
			priorCommittedSourceDigests: [],
		});
		expect(direct.decision).toBe("commit");
		const planned = plan({ mode: "inspect", compaction: commitCompaction() });
		expect(planned.findings.some((f) => f.reason === "compaction_committed")).toBe(true);
	});

	it("abandon action carries a deep-copied frozen baseRevision, sourceSha256, and staleReason", () => {
		const stale = staleCompaction();
		const dry = plan({
			mode: "repair_dry_run",
			compaction: stale,
			paths: { session: authorizedSessionPath() },
		});
		const action = dry.actions[0];
		if (action?.kind !== "abandon_stale_compaction") throw new Error("expected abandon_stale_compaction");
		expect(action.transactionId).toBe("txn-1");
		expect(action.staleReason).toBe("revision_mismatch");
		expect(action.sourceSha256).toBe(stale.transaction.source.sourceSha256);
		expect(action.baseRevision).toEqual(stale.transaction.baseRevision);
		expect(action.baseRevision).not.toBe(stale.transaction.baseRevision);
		expect(Object.isFrozen(action.baseRevision)).toBe(true);
	});

	it("abandon action reports source_mismatch when the current source digest differs", () => {
		const stale = staleSourceCompaction();
		const dry = plan({
			mode: "repair_dry_run",
			compaction: stale,
			paths: { session: authorizedSessionPath() },
		});
		const action = dry.actions[0];
		if (action?.kind !== "abandon_stale_compaction") throw new Error("expected abandon_stale_compaction");
		expect(action.staleReason).toBe("source_mismatch");
		expect(action.sourceSha256).toBe(stale.transaction.source.sourceSha256);
		expect(action.baseRevision).toEqual(stale.transaction.baseRevision);
	});
});

// =================================================================================================
// Identity cross-binding.
// =================================================================================================

describe("sessionId cross-binding", () => {
	it("refuses (exit 2) when report header id differs from the input sessionId", () => {
		const result = plan({ mode: "inspect", sessionId: "session-other", report: cleanReport() });
		expect(result.status).toBe("refused");
		expect(result.exitCode).toBe(2);
		expect(result.findings.some((f) => f.code === "session_identity_mismatch")).toBe(true);
	});

	it("refuses (exit 2) when a journal record references a different session", () => {
		const foreign = {
			...startedMaterial("run-1", 0),
			sessionId: "session-other",
		};
		const bytes = buildJournalBytes([foreign]);
		const result = plan({ mode: "inspect", journal: { bytes, hashFn: testHash } });
		expect(result.status).toBe("refused");
		expect(result.exitCode).toBe(2);
		expect(result.findings.some((f) => f.code === "session_identity_mismatch")).toBe(true);
	});

	it("refuses (exit 2) when the compaction transaction session differs", () => {
		// Build a transaction explicitly bound to a foreign session.
		const foreign = createCompactionTransaction({
			transactionId: "txn-x",
			baseRevision: revisionToken({ sessionId: "session-other" }),
			source: sourceIdentity({ sessionId: "session-other" }),
			createdAt: "2026-07-16T00:00:00.000Z",
			model: { provider: "test", id: "model-1" },
			preserved: {
				latestIntent: "intent",
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
		const result = plan({
			mode: "inspect",
			compaction: {
				transaction: foreign,
				currentRevision: foreign.baseRevision,
				currentSource: foreign.source,
				barrier: readyBarrier(),
				priorCommittedSourceDigests: [],
			},
		});
		expect(result.status).toBe("refused");
		expect(result.exitCode).toBe(2);
		expect(result.findings.some((f) => f.code === "session_identity_mismatch")).toBe(true);
	});
});

// =================================================================================================
// Normalized checks (advisory block, never authorizes actions).
// =================================================================================================

describe("normalized checks", () => {
	it("adds a blocked finding for a non-ok check without authorizing actions", () => {
		const result = plan({
			mode: "inspect",
			normalizedChecks: [{ artifact: "evidence_link", id: "ev-1", status: "unavailable" }],
		});
		expect(result.status).toBe("issues");
		expect(result.exitCode).toBe(1);
		expect(result.actions).toEqual([]);
		expect(reasons(result)).toEqual(["normalized_check_unhealthy"]);
		expect(result.findings[0]?.code).toBe("evidence_link:unavailable");
	});

	it("stays healthy when all normalized checks are ok", () => {
		const result = plan({
			mode: "inspect",
			normalizedChecks: [
				{ artifact: "workspace", id: "ws-1", status: "ok" },
				{ artifact: "provider_model", id: "pm-1", status: "ok" },
			],
		});
		expect(result.status).toBe("healthy");
		expect(result.exitCode).toBe(0);
		expect(result.findings).toEqual([]);
	});
});

// =================================================================================================
// Mode parity and inspect behavior.
// =================================================================================================

describe("mode parity", () => {
	function trailingDryAndRepair() {
		const report = trailingMissingReport();
		const paths = { session: authorizedSessionPath() };
		return {
			inspect: plan({ mode: "inspect", report, paths }),
			dry: plan({ mode: "repair_dry_run", report, paths }),
			repair: plan({ mode: "repair", report, paths }),
		};
	}

	it("inspect never lists actions even when eligible", () => {
		const { inspect: inspectResult } = trailingDryAndRepair();
		expect(inspectResult.actions).toEqual([]);
		expect(inspectResult.scheduledWrites).toBe(0);
		expect(inspectResult.repairable).toBe(true);
		expect(inspectResult.requiresReinspection).toBe(false);
		expect(inspectResult.status).toBe("issues");
		expect(inspectResult.exitCode).toBe(1);
	});

	it("dry and repair list the same eligible actions with differing scheduled writes", () => {
		const { dry, repair } = trailingDryAndRepair();
		expect(dry.actions).toEqual(repair.actions);
		expect(dry.scheduledWrites).toBe(0);
		expect(dry.requiresReinspection).toBe(false);
		expect(repair.scheduledWrites).toBe(repair.actions.length);
		expect(repair.requiresReinspection).toBe(true);
		expect(repair.exitCode).toBe(1);
		expect(repair.status).toBe("issues");
	});
});

// =================================================================================================
// Anti-forgery: inconsistent report.
// =================================================================================================

describe("anti-forgery", () => {
	it("refuses (exit 2) a forged inconsistent session report", () => {
		// A clean report has ok=true with zero findings; flipping ok makes it inconsistent.
		const inconsistent = { ...cleanReport(), ok: false } as SessionDoctorPlanInput["report"];
		const result = plan({ mode: "inspect", report: inconsistent });
		expect(result.status).toBe("refused");
		expect(result.exitCode).toBe(2);
		expect(result.findings.some((f) => f.code === "inconsistent_report")).toBe(true);
	});
});

// =================================================================================================
// Determinism, freeze, and deep copy.
// =================================================================================================

describe("determinism and immutability", () => {
	it("produces identical plans for identical inputs", () => {
		const report = trailingMissingReport();
		const paths = { session: authorizedSessionPath() };
		const a = plan({ mode: "repair", report, paths });
		const b = plan({ mode: "repair", report, paths });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("sorts findings into a stable total ordering", () => {
		const result = plan({
			mode: "inspect",
			report: trailingMissingReport(),
			journal: { bytes: buildJournalBytes([startedMaterial("run-1", 0)], "x"), hashFn: testHash },
			normalizedChecks: [{ artifact: "workspace", id: "w", status: "missing" }],
		});
		const rank: Record<string, number> = { session: 0, journal: 1, path: 2, compaction: 3, normalized: 4 };
		const artifacts = result.findings.map((f) => f.artifact);
		const ranks = artifacts.map((a) => rank[a] ?? 99);
		expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
		expect(artifacts).toEqual(["session", "session", "journal", "journal", "normalized"]);
		// No duplicate finding keys.
		const keys = result.findings.map((f) => `${f.artifact}|${f.reason}|${f.code ?? ""}|${(f.ids ?? []).join(",")}`);
		expect(keys).toEqual([...new Set(keys)]);
	});

	it("returns a deeply frozen plan", () => {
		const result = plan({
			mode: "repair",
			report: trailingMissingReport(),
			paths: { session: authorizedSessionPath() },
		});
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.findings)).toBe(true);
		expect(Object.isFrozen(result.actions)).toBe(true);
		for (const finding of result.findings) expect(Object.isFrozen(finding)).toBe(true);
		for (const action of result.actions) {
			expect(Object.isFrozen(action)).toBe(true);
			if (action.kind === "quarantine_session_trailing_fragment") {
				expect(Object.isFrozen(action.fragment)).toBe(true);
				expect(Object.isFrozen(action.retainPrefix)).toBe(true);
			}
		}
		expect(() => {
			(result as { exitCode: number }).exitCode = 0;
		}).toThrow(TypeError);
	});

	it("deep-copies caller input so later mutation cannot affect the plan", () => {
		const { bytes, terminal } = unclosedRunAndRecovery();
		const mutableTerminal = { ...terminal } as Record<string, unknown>;
		const nested = terminal.termination;
		(mutableTerminal as { termination: unknown }).termination = { ...nested };
		const result = plan({
			mode: "repair_dry_run",
			journal: {
				bytes,
				hashFn: testHash,
				terminalRecord: mutableTerminal as unknown as RunJournalTerminalRecord,
			},
			paths: { journal: authorizedJournalPath() },
		});
		const action = result.actions.find((a) => a.kind === "recover_run");
		if (action?.kind !== "recover_run") throw new Error("expected recover_run");
		(mutableTerminal as { runId: string }).runId = "tampered";
		expect(action.terminalRecord.runId).toBe("run-1");
		expect(Object.isFrozen(action.terminalRecord)).toBe(true);
	});
});

// =================================================================================================
// Strict input validation.
// =================================================================================================

describe("strict input validation", () => {
	it("rejects non-plain, accessor-bearing, and extra-key inputs", () => {
		expect(() => planSessionDoctor(null)).toThrow("plain data object");
		expect(() => planSessionDoctor([])).toThrow("plain data object");
		const accessorInput = {
			mode: "inspect",
			sessionId: SESSION,
			repairId: REPAIR_ID,
			timestamp: TS,
			report: cleanReport(),
		};
		Object.defineProperty(accessorInput, "mode", { get: () => "inspect", enumerable: true, configurable: true });
		expect(() => planSessionDoctor(accessorInput)).toThrow("plain data object");
		expect(() =>
			planSessionDoctor({
				mode: "inspect",
				sessionId: SESSION,
				repairId: REPAIR_ID,
				timestamp: TS,
				report: cleanReport(),
				extra: 1,
			} as never),
		).toThrow("unsupported field");
	});

	it("rejects invalid mode, identifiers, and timestamp", () => {
		const base: Partial<SessionDoctorPlanInput> = {
			sessionId: SESSION,
			repairId: REPAIR_ID,
			timestamp: TS,
			report: cleanReport(),
		};
		expect(() => plan({ ...base, mode: "raw" as never })).toThrow("mode");
		expect(() => plan({ ...base, mode: "inspect", sessionId: "" })).toThrow("bounded text");
		expect(() => plan({ ...base, mode: "inspect", sessionId: "bad\u0000id" })).toThrow("C0 or DEL");
		expect(() => plan({ ...base, mode: "inspect", sessionId: "sk-abcdefghijklmnopqrstuvwxyz123456" })).toThrow(
			"credential",
		);
		expect(() => plan({ ...base, mode: "inspect", sessionId: "x".repeat(129) })).toThrow("bounded text");
		expect(() => plan({ ...base, mode: "inspect", repairId: "bad\u007f" })).toThrow("C0 or DEL");
		expect(() => plan({ ...base, mode: "inspect", timestamp: -1 })).toThrow("non-negative safe integer");
		expect(() => plan({ ...base, mode: "inspect", timestamp: 1.5 })).toThrow("non-negative safe integer");
	});

	it("rejects malformed journal, paths, compaction, and normalizedChecks", () => {
		const base: Partial<SessionDoctorPlanInput> = {
			mode: "inspect",
			sessionId: SESSION,
			repairId: REPAIR_ID,
			timestamp: TS,
		};
		expect(() =>
			plan({ ...base, report: cleanReport(), journal: { bytes: "nope" as never, hashFn: testHash } }),
		).toThrow("Uint8Array");
		expect(() =>
			plan({ ...base, report: cleanReport(), journal: { bytes: new Uint8Array(0), hashFn: "nope" as never } }),
		).toThrow("function");
		expect(() =>
			plan({
				...base,
				report: cleanReport(),
				paths: { session: { ...authorizedSessionPath(), extra: 1 } as never },
			}),
		).toThrow("unsupported field");
		expect(() => plan({ ...base, report: cleanReport(), normalizedChecks: "nope" as never })).toThrow("array");
		expect(() =>
			plan({
				...base,
				report: cleanReport(),
				normalizedChecks: [{ artifact: "unknown" as never, id: "x", status: "ok" }],
			}),
		).toThrow("artifact");
		expect(() =>
			plan({
				...base,
				report: cleanReport(),
				normalizedChecks: [{ artifact: "workspace", id: "x", status: "weird" as never }],
			}),
		).toThrow("status");
		expect(() =>
			plan({
				...base,
				report: cleanReport(),
				normalizedChecks: Array.from({ length: 129 }, (_, i) => ({
					artifact: "workspace" as const,
					id: `id-${i}`,
					status: "ok" as const,
				})),
			}),
		).toThrow("at most 128");
	});

	it("rejects a nested accessor in the report without executing the getter", () => {
		const report = cleanReport();
		const headerCopy = { ...(report.header as object) };
		let calls = 0;
		Object.defineProperty(headerCopy, "id", {
			get() {
				calls += 1;
				return SESSION;
			},
			enumerable: true,
			configurable: true,
		});
		const forged = { ...report, header: headerCopy };
		expect(() => plan({ mode: "inspect", report: forged as never })).toThrow("plain data");
		expect(calls).toBe(0);
	});

	it("rejects a nested accessor in the compaction observation without executing the getter", () => {
		const observation = staleCompaction();
		const txnCopy = { ...(observation.transaction as object) };
		let calls = 0;
		Object.defineProperty(txnCopy, "transactionId", {
			get() {
				calls += 1;
				return "txn-1";
			},
			enumerable: true,
			configurable: true,
		});
		const forged = { ...observation, transaction: txnCopy };
		expect(() => plan({ mode: "inspect", compaction: forged as never })).toThrow("plain data");
		expect(calls).toBe(0);
	});

	it("rejects a normalizedChecks accessor index without executing the getter", () => {
		const checks = [{ artifact: "workspace" as const, id: "w", status: "ok" as const }];
		let calls = 0;
		Object.defineProperty(checks, 0, {
			get() {
				calls += 1;
				return { artifact: "workspace" as const, id: "w", status: "ok" as const };
			},
			enumerable: true,
			configurable: true,
		});
		expect(() => plan({ mode: "inspect", normalizedChecks: checks as never })).toThrow("accessor");
		expect(calls).toBe(0);
	});

	it("rejects a normalizedChecks array with holes", () => {
		const checks: unknown[] = [];
		checks[1] = { artifact: "workspace", id: "x", status: "ok" };
		expect(() => plan({ mode: "inspect", normalizedChecks: checks as never })).toThrow("dense");
	});

	it("rejects a normalizedChecks array with extra own properties", () => {
		const checks = [{ artifact: "workspace" as const, id: "w", status: "ok" as const }];
		Object.defineProperty(checks, "extra", {
			value: 1,
			enumerable: true,
			configurable: true,
			writable: true,
		});
		expect(() => plan({ mode: "inspect", normalizedChecks: checks as never })).toThrow("extra own properties");
	});

	it("rejects a nested accessor in a report array without executing the getter (assertPlainDataTree)", () => {
		const report = trailingMissingReport();
		const clone = JSON.parse(JSON.stringify(report)) as SessionDoctorPlanInput["report"];
		const messages = clone.activeMessages as unknown[];
		const original = messages[0];
		let calls = 0;
		Object.defineProperty(messages, 0, {
			get() {
				calls += 1;
				return original;
			},
			enumerable: true,
			configurable: true,
		});
		expect(() => plan({ mode: "inspect", report: clone as never })).toThrow("accessor");
		expect(calls).toBe(0);
	});
});

// =================================================================================================
// Static forbidden API scan and import hygiene.
// =================================================================================================

describe("static forbidden API and import hygiene", () => {
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
		const hits = forbidden.filter((pattern) => pattern.test(moduleSource));
		expect(hits, `forbidden tokens found: ${hits.map((pattern) => pattern.source).join(", ")}`).toEqual([]);
	});

	it("imports SessionIntegrityReport as a type only (no runtime session-integrity import)", () => {
		const specifier = 'from "./session-integrity.ts"';
		const first = moduleSource.indexOf(specifier);
		expect(first).toBeGreaterThan(-1);
		expect(moduleSource.indexOf(specifier, first + 1)).toBe(-1); // exactly one import
		const statementStart = moduleSource.lastIndexOf("import", first);
		const head = moduleSource.slice(statementStart, first);
		expect(head.startsWith("import type")).toBe(true);
		expect(head.startsWith("import {")).toBe(false);
	});

	it("only depends on the four permitted pure runtime modules", () => {
		const targets = new Set([...moduleSource.matchAll(/from\s+["'](\.\/[^"']+\.ts)["']/g)].map((match) => match[1]));
		expect([...targets].sort()).toEqual([
			"./compaction/transaction.ts",
			"./run-journal.ts",
			"./session-integrity.ts",
			"./session-path-policy.ts",
			"./session-repair-plan.ts",
		]);
	});

	it("uses the permitted pure runtime functions", () => {
		expect(moduleSource).toContain("createSessionRepairPlan");
		expect(moduleSource).toContain("inspectRunJournal");
		expect(moduleSource).toContain("serializeRunJournalLine");
		expect(moduleSource).toContain("decideSessionPathAccess");
		expect(moduleSource).toContain("decideCompactionCommit");
	});

	it("imports GENESIS_HASH from the pure run-journal module instead of duplicating it", () => {
		expect(moduleSource).toMatch(/\bGENESIS_HASH\b/);
		expect(moduleSource).toMatch(/import\s*\{[^}]*\bGENESIS_HASH\b[^}]*\}\s*from\s*["']\.\/run-journal\.ts["']/);
		expect(moduleSource).not.toMatch(/const\s+GENESIS_HASH\s*=/);
	});
});
