/**
 * Pure, browser-safe run-journal format and complete-prefix integrity inspector.
 *
 * Runtime purity: this module performs no I/O and uses no Node-specific
 * primitives. It relies only on `TextEncoder`/`TextDecoder`, `JSON`, the pure
 * `Date` string parser, and ordinary language built-ins. It consults no wall
 * clock, draws no entropy, invokes no cryptographic primitives, and mutates no
 * global state. Every record hash is recomputed from a caller-injected
 * synchronous `RunJournalHashFn`, both when records are constructed by
 * {@link RunJournal} and when raw bytes are inspected by
 * {@link inspectRunJournal}. There is no opaque mode that skips hashing.
 */
import {
	assertPreRedactedTerminationMessage,
	SESSION_TERMINATION_SCHEMA_VERSION,
	type SessionTermination,
} from "./session-termination.ts";

export const RUN_JOURNAL_SCHEMA_VERSION = 1 as const;
/** Sixty-four zero bits; the `prevHash` of the first record in every chain. */
export const GENESIS_HASH = "0".repeat(64);
export const MAX_RUN_JOURNAL_ID_LENGTH = 128;

/** Synchronous, pure hash function injected by the caller. Must return 64 lowercase hex chars. */
export type RunJournalHashFn = (bytes: Uint8Array) => string;

/** Audit-only journal events; they never open, close, or otherwise affect a run. */
export type RunJournalAuditEvent = "tool_timeout" | "tool_late_settlement" | "transcript_repaired";

export type RunJournalEvent = "run_started" | "run_finished" | "run_recovered" | "run_abandoned" | RunJournalAuditEvent;

export type RunJournalFindingCode =
	| "trailing_fragment"
	| "invalid_utf8"
	| "malformed_json"
	| "schema"
	| "seq_gap"
	| "seq_regression"
	| "hash_shape"
	| "hash_mismatch"
	| "hash_chain_break"
	| "orphan_terminal"
	| "duplicate_terminal"
	| "duplicate_start"
	| "interleaved_run"
	| "run_unclosed"
	| "recovered_source_invalid"
	| "termination_mismatch"
	| "session_mismatch"
	| "session_revision_regression";

export interface RunJournalRecordBase {
	readonly schemaVersion: typeof RUN_JOURNAL_SCHEMA_VERSION;
	readonly seq: number;
	readonly event: RunJournalEvent;
	readonly runId: string;
	readonly sessionId: string;
	readonly sessionRevision: number;
	/** Canonical caller-supplied ISO-8601 UTC instant. */
	readonly timestamp: string;
	/** Hash of the previous record (`GENESIS_HASH` for the first record). */
	readonly prevHash: string;
	/** Recomputed hash of this record's canonical material (without `hash`). */
	readonly hash: string;
}

export interface RunJournalStartedRecord extends RunJournalRecordBase {
	readonly event: "run_started";
}

export interface RunJournalTerminalRecord extends RunJournalRecordBase {
	readonly event: "run_finished" | "run_recovered" | "run_abandoned";
	readonly termination: SessionTermination;
}

/** Bounded structured payload persisted with an audit record. */
export interface RunJournalAuditDetails {
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly disposition?: "completed" | "failed" | "blocked" | "aborted" | "timeout" | "skipped";
	readonly outcome?: "resolved" | "rejected";
	readonly timeoutMs?: number;
	readonly executionStarted?: boolean;
	readonly insertedToolCallIds?: readonly string[];
	readonly reason?: string;
	readonly sessionRisk?: "elevated";
}

export interface RunJournalAuditRecord extends RunJournalRecordBase {
	readonly event: RunJournalAuditEvent;
	readonly details: RunJournalAuditDetails;
}

export type RunJournalRecord = RunJournalStartedRecord | RunJournalTerminalRecord | RunJournalAuditRecord;

export interface RunJournalFinding {
	readonly code: RunJournalFindingCode;
	readonly line?: number;
	readonly runId?: string;
}

export interface RunJournalCompletePrefix {
	readonly byteCount: number;
	readonly lineCount: number;
}

export interface RunJournalReport {
	readonly ok: boolean;
	readonly completePrefix: RunJournalCompletePrefix;
	readonly trailingByteCount: number;
	readonly records: readonly RunJournalRecord[];
	readonly openRunId: string | null;
	readonly findings: readonly RunJournalFinding[];
}

export interface RunJournalConstructorInit {
	readonly hashFn: RunJournalHashFn;
	readonly sessionId: string;
	readonly runId: string;
	readonly sessionRevision: number;
	readonly timestamp: string;
	/**
	 * When `false`, the constructor does not append the initial `run_started`
	 * record: the journal starts closed and accepts audit records (and later
	 * explicit `start()` calls). Default `true` preserves existing behavior.
	 */
	readonly openInitialRun?: boolean;
	/**
	 * Trusted caller-supplied continuation chain-head `prevHash`. Defaults to
	 * `GENESIS_HASH` for a new journal. The writer treats this as a trusted
	 * baseline that pins the first record to an external chain; it is never
	 * re-derived.
	 */
	readonly prevHash?: string;
	/**
	 * Trusted caller-supplied continuation chain-head `seq`. Defaults to `0` for
	 * a new journal. Treated as a trusted baseline; the writer advances from it
	 * but never re-derives it.
	 */
	readonly seq?: number;
}

export interface RunJournalStartInput {
	readonly runId: string;
	readonly sessionRevision: number;
	readonly timestamp: string;
}

export interface RunJournalTerminalInput {
	readonly termination: SessionTermination;
	readonly sessionRevision: number;
	readonly timestamp: string;
}

export interface RunJournalAuditInput {
	readonly event: RunJournalAuditEvent;
	readonly details: RunJournalAuditDetails;
	readonly sessionRevision: number;
	readonly timestamp: string;
}

const HASH64 = /^[0-9a-f]{64}$/;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

const RUN_JOURNAL_EVENTS: ReadonlySet<RunJournalEvent> = new Set<RunJournalEvent>([
	"run_started",
	"run_finished",
	"run_recovered",
	"run_abandoned",
	"tool_timeout",
	"tool_late_settlement",
	"transcript_repaired",
]);
const TERMINAL_EVENTS: ReadonlySet<RunJournalEvent> = new Set<RunJournalEvent>([
	"run_finished",
	"run_recovered",
	"run_abandoned",
]);
const AUDIT_EVENTS: ReadonlySet<RunJournalEvent> = new Set<RunJournalEvent>([
	"tool_timeout",
	"tool_late_settlement",
	"transcript_repaired",
]);
const AUDIT_DETAIL_KEYS = [
	"toolCallId",
	"toolName",
	"disposition",
	"outcome",
	"timeoutMs",
	"executionStarted",
	"insertedToolCallIds",
	"reason",
	"sessionRisk",
] as const;
const AUDIT_DISPOSITIONS: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"blocked",
	"aborted",
	"timeout",
	"skipped",
]);
const AUDIT_OUTCOMES: ReadonlySet<string> = new Set(["resolved", "rejected"]);
const MAX_AUDIT_INSERTED_IDS = 64;
const MAX_AUDIT_REASON_LENGTH = 512;
const COMMON_RECORD_KEYS = [
	"schemaVersion",
	"seq",
	"event",
	"runId",
	"sessionId",
	"sessionRevision",
	"timestamp",
	"prevHash",
	"hash",
] as const;

const SESSION_TERMINATION_KINDS: ReadonlySet<string> = new Set([
	"completed",
	"user_abort",
	"provider_abort",
	"provider_auth",
	"provider_rate_limit",
	"provider_network",
	"provider_protocol",
	"context_overflow",
	"tool_timeout",
	"tool_fatal",
	"compaction",
	"persistence",
	"process_signal",
	"process_crash",
	"transcript_invalid",
	"configuration",
	"internal_error",
]);
const SESSION_TERMINATION_PHASES: ReadonlySet<string> = new Set([
	"completed",
	"control",
	"preflight",
	"provider",
	"tool",
	"compaction",
	"persistence",
	"process",
	"resume",
]);
const SESSION_TERMINATION_SOURCES: ReadonlySet<string> = new Set(["observed", "inferred_on_resume"]);
const SESSION_SIDE_EFFECTS: ReadonlySet<string> = new Set(["none", "possible", "confirmed"]);
const SESSION_PROCESS_SIGNALS: ReadonlySet<string> = new Set(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);
const SESSION_TRANSCRIPT_ISSUES: ReadonlySet<string> = new Set([
	"missing_result",
	"duplicate_result",
	"orphan_result",
	"duplicate_call_id",
	"interleaved_non_result",
	"invalid_jsonl",
	"invalid_tree",
	"unsupported_version",
	"trailing_fragment",
]);
const TERMINATION_ALLOWED_KEYS = [
	"schemaVersion",
	"sessionId",
	"runId",
	"kind",
	"phase",
	"source",
	"message",
	"causeCode",
	"nextAction",
	"retryable",
	"safeToAutoRetry",
	"sideEffects",
	"timestamp",
	"retryAfterMs",
	"provider",
	"model",
	"toolCallId",
	"toolName",
	"processSignal",
	"transcriptIssue",
] as const;

/** High-confidence credential shapes; rejected at every trust boundary. */
const CREDENTIAL_SHAPES = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
	/\bsk-[A-Za-z0-9_-]{16,}\b/,
	/\bgh[pousr]_[A-Za-z0-9]{16,}\b/,
	/\bgithub_pat_[A-Za-z0-9_]{16,}\b/,
	/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
	/\bAKIA[A-Z0-9]{16}\b/,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
	/\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/i,
	/(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:authorization|api[-_ ]?key|access[-_ ]?token|token|password|secret(?:[-_ ]?key)?|private[-_ ]?key|cookie)["']?\s*[:=]/i,
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Asserts `value` is a plain data record: an object (never an array) with a
 * plain prototype, only data (non-accessor) own properties, and no keys outside
 * `allowedKeys`. Descriptors are inspected without ever executing a getter, so
 * raw accessor execution is never exposed at the trust boundary. Returns void;
 * it narrows nothing so typed callers keep their static field types.
 */
function assertPlainDataRecord(value: unknown, name: string, allowedKeys: readonly string[]): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${name} must be a plain object`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) {
		throw new TypeError(`${name} must be a plain object`);
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	for (const key of Object.keys(descriptors)) {
		const descriptor = descriptors[key];
		if (descriptor !== undefined && !("value" in descriptor)) {
			throw new TypeError(`${name} must not define accessor properties`);
		}
		if (!allowedKeys.includes(key)) {
			throw new TypeError(`${name} must contain only bounded fields`);
		}
	}
}

function looksLikeCredential(value: string): boolean {
	return CREDENTIAL_SHAPES.some((pattern) => pattern.test(value));
}

function isBoundedIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_RUN_JOURNAL_ID_LENGTH &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

function assertIdentifier(value: unknown, name: string, maxLength: number): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
		throw new TypeError(`${name} must be 1-${maxLength} characters of bounded text`);
	}
	if (/[\u0000-\u001f\u007f]/.test(value)) {
		throw new TypeError(`${name} must not contain C0 or DEL control characters`);
	}
}

function rejectCredential(value: string, name: string): void {
	if (looksLikeCredential(value)) {
		throw new TypeError(`${name} contains a credential-shaped literal`);
	}
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function assertCanonicalTimestamp(value: unknown, name: string): asserts value is string {
	if (!isCanonicalTimestamp(value)) {
		throw new TypeError(`${name} must be a canonical ISO-8601 UTC instant`);
	}
}

function assertSafeNonNegativeInt(value: unknown, name: string): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${name} must be a non-negative safe integer`);
	}
}

function isValidHashShape(value: unknown): value is string {
	return typeof value === "string" && HASH64.test(value);
}

function assertHashShape(value: unknown, name: string): asserts value is string {
	if (!isValidHashShape(value)) {
		throw new TypeError(`${name} must be 64 lowercase hex characters`);
	}
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return Object.freeze(value);
}

/** Recursively key-sorted JSON serialization. Deterministic across runtimes and key insertion order. */
export function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const object = value as Record<string, unknown>;
		const parts: string[] = [];
		for (const key of Object.keys(object).sort()) {
			const child = object[key];
			if (child === undefined) continue;
			parts.push(`${JSON.stringify(key)}:${canonicalJson(child)}`);
		}
		return `{${parts.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Defensively drop a stray `hash` key so the material never includes it, regardless of caller. */
function stripHashKey(record: unknown): Record<string, unknown> {
	if (typeof record !== "object" || record === null) return {};
	const clone: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key !== "hash") clone[key] = value;
	}
	return clone;
}

/** Canonical material of a record (everything except `hash`) over which the hash is computed. */
export function serializeRunJournalMaterial(record: Readonly<Omit<RunJournalRecord, "hash">>): string {
	return canonicalJson(stripHashKey(record));
}

/** Canonical, key-sorted serialization of a full record (including `hash`). */
export function serializeRunJournalLine(record: Readonly<RunJournalRecord>): string {
	return canonicalJson(record);
}

function assertBoundedSessionTermination(
	value: unknown,
	expectedRunId: string,
	expectedSessionId: string,
): asserts value is SessionTermination {
	assertPlainDataRecord(value, "termination", TERMINATION_ALLOWED_KEYS);
	const v = value as Record<string, unknown>;
	if (v.schemaVersion !== SESSION_TERMINATION_SCHEMA_VERSION) {
		throw new TypeError("termination schemaVersion must match the supported version");
	}
	if (typeof v.runId !== "string" || v.runId !== expectedRunId) {
		throw new TypeError("termination runId must match the record runId");
	}
	if (typeof v.sessionId !== "string" || v.sessionId !== expectedSessionId) {
		throw new TypeError("termination sessionId must match the record sessionId");
	}
	if (typeof v.kind !== "string" || !SESSION_TERMINATION_KINDS.has(v.kind)) {
		throw new TypeError("termination kind is out of bounds");
	}
	if (typeof v.phase !== "string" || !SESSION_TERMINATION_PHASES.has(v.phase)) {
		throw new TypeError("termination phase is out of bounds");
	}
	if (typeof v.source !== "string" || !SESSION_TERMINATION_SOURCES.has(v.source)) {
		throw new TypeError("termination source is out of bounds");
	}
	if (typeof v.message !== "string") {
		throw new TypeError("termination message must be a string");
	}
	assertPreRedactedTerminationMessage(v.message);
	if (typeof v.causeCode !== "string" || !/^[a-z_]+\.[a-z_]+$/.test(v.causeCode)) {
		throw new TypeError("termination causeCode is out of bounds");
	}
	if (typeof v.nextAction !== "string") {
		throw new TypeError("termination nextAction must be a string");
	}
	assertPreRedactedTerminationMessage(v.nextAction);
	if (typeof v.retryable !== "boolean" || typeof v.safeToAutoRetry !== "boolean") {
		throw new TypeError("termination retry flags must be booleans");
	}
	if (typeof v.sideEffects !== "string" || !SESSION_SIDE_EFFECTS.has(v.sideEffects)) {
		throw new TypeError("termination sideEffects is out of bounds");
	}
	assertCanonicalTimestamp(v.timestamp, "termination.timestamp");
	if (v.retryAfterMs !== undefined) assertSafeNonNegativeInt(v.retryAfterMs, "termination.retryAfterMs");
	if (v.provider !== undefined) {
		assertIdentifier(v.provider, "termination.provider", 128);
		rejectCredential(v.provider, "termination.provider");
	}
	if (v.model !== undefined) {
		assertIdentifier(v.model, "termination.model", 256);
		rejectCredential(v.model, "termination.model");
	}
	if (v.toolCallId !== undefined) {
		assertIdentifier(v.toolCallId, "termination.toolCallId", 512);
		rejectCredential(v.toolCallId, "termination.toolCallId");
	}
	if (v.toolName !== undefined) {
		assertIdentifier(v.toolName, "termination.toolName", 128);
		rejectCredential(v.toolName, "termination.toolName");
	}
	if (v.processSignal !== undefined) {
		if (typeof v.processSignal !== "string" || !SESSION_PROCESS_SIGNALS.has(v.processSignal)) {
			throw new TypeError("termination processSignal is out of bounds");
		}
	}
	if (v.transcriptIssue !== undefined) {
		if (typeof v.transcriptIssue !== "string" || !SESSION_TRANSCRIPT_ISSUES.has(v.transcriptIssue)) {
			throw new TypeError("termination transcriptIssue is out of bounds");
		}
	}
	assertTerminationCoherence(v as unknown as SessionTermination);
}

function assertTerminationCoherence(termination: SessionTermination): void {
	const dot = termination.causeCode.indexOf(".");
	const area = dot >= 0 ? termination.causeCode.slice(0, dot) : "";
	const suffix = dot >= 0 ? termination.causeCode.slice(dot + 1) : "";

	let expectedKind: string;
	let expectedPhase: string;
	let expectedRetryable: boolean;
	let processSignalRequired = false;
	let transcriptRequired = false;
	let transcriptSuffix: string | null = null;

	switch (area) {
		case "session":
			if (suffix === "completed") {
				expectedKind = "completed";
				expectedPhase = "completed";
				expectedRetryable = false;
			} else if (suffix === "user_abort") {
				expectedKind = "user_abort";
				expectedPhase = "control";
				expectedRetryable = false;
			} else {
				throw new TypeError("termination causeCode is incoherent");
			}
			break;
		case "provider":
			switch (suffix) {
				case "abort":
					expectedKind = "provider_abort";
					expectedPhase = "provider";
					expectedRetryable = true;
					break;
				case "auth":
					expectedKind = "provider_auth";
					expectedPhase = "provider";
					expectedRetryable = false;
					break;
				case "rate_limit":
					expectedKind = "provider_rate_limit";
					expectedPhase = "provider";
					expectedRetryable = true;
					break;
				case "network":
					expectedKind = "provider_network";
					expectedPhase = "provider";
					expectedRetryable = true;
					break;
				case "protocol":
					expectedKind = "provider_protocol";
					expectedPhase = "provider";
					expectedRetryable = false;
					break;
				case "context_overflow":
					expectedKind = "context_overflow";
					expectedPhase = "provider";
					expectedRetryable = true;
					break;
				default:
					throw new TypeError("termination causeCode is incoherent");
			}
			break;
		case "tool":
			if (suffix === "timeout") {
				expectedKind = "tool_timeout";
				expectedPhase = "tool";
				expectedRetryable = true;
			} else if (suffix === "fatal") {
				expectedKind = "tool_fatal";
				expectedPhase = "tool";
				expectedRetryable = false;
			} else {
				throw new TypeError("termination causeCode is incoherent");
			}
			break;
		case "compaction":
			if (suffix === "aborted" || suffix === "failed" || suffix === "stale") {
				expectedKind = "compaction";
				expectedPhase = "compaction";
				expectedRetryable = true;
			} else {
				throw new TypeError("termination causeCode is incoherent");
			}
			break;
		case "persistence":
			if (
				suffix === "read_failed" ||
				suffix === "append_failed" ||
				suffix === "replace_failed" ||
				suffix === "fsync_failed" ||
				suffix === "lock_failed"
			) {
				expectedKind = "persistence";
				expectedPhase = "persistence";
				expectedRetryable = true;
			} else {
				throw new TypeError("termination causeCode is incoherent");
			}
			break;
		case "process":
			if (suffix === "signal") {
				expectedKind = "process_signal";
				expectedPhase = "process";
				expectedRetryable = false;
				processSignalRequired = true;
			} else if (suffix === "crash") {
				expectedKind = "process_crash";
				expectedPhase = "resume";
				expectedRetryable = true;
			} else {
				throw new TypeError("termination causeCode is incoherent");
			}
			break;
		case "transcript":
			if (SESSION_TRANSCRIPT_ISSUES.has(suffix)) {
				expectedKind = "transcript_invalid";
				expectedPhase = termination.source === "inferred_on_resume" ? "resume" : "preflight";
				expectedRetryable = false;
				transcriptRequired = true;
				transcriptSuffix = suffix;
			} else {
				throw new TypeError("termination causeCode is incoherent");
			}
			break;
		case "configuration":
			if (suffix === "invalid") {
				expectedKind = "configuration";
				expectedPhase = "preflight";
				expectedRetryable = false;
			} else {
				throw new TypeError("termination causeCode is incoherent");
			}
			break;
		case "internal":
			if (suffix === "unclassified") {
				expectedKind = "internal_error";
				expectedPhase = "preflight";
				expectedRetryable = false;
			} else {
				throw new TypeError("termination causeCode is incoherent");
			}
			break;
		default:
			throw new TypeError("termination causeCode is incoherent");
	}

	if (termination.kind !== expectedKind) {
		throw new TypeError("termination kind is incoherent with causeCode");
	}
	if (termination.phase !== expectedPhase) {
		throw new TypeError("termination phase is incoherent with causeCode");
	}
	if (termination.retryable !== expectedRetryable) {
		throw new TypeError("termination retryable flag is incoherent with causeCode");
	}
	if (processSignalRequired) {
		if (termination.processSignal === undefined) {
			throw new TypeError("termination processSignal is required for signal causes");
		}
	} else if (termination.processSignal !== undefined) {
		throw new TypeError("termination processSignal is only valid for signal causes");
	}
	if (transcriptRequired) {
		if (termination.transcriptIssue === undefined) {
			throw new TypeError("termination transcriptIssue is required for transcript causes");
		} else if (termination.transcriptIssue !== transcriptSuffix) {
			throw new TypeError("termination transcriptIssue must match the transcript cause");
		}
	} else if (termination.transcriptIssue !== undefined) {
		throw new TypeError("termination transcriptIssue is only valid for transcript causes");
	}

	const expectedSafeToAutoRetry =
		termination.retryable &&
		termination.source === "observed" &&
		termination.sideEffects === "none" &&
		(termination.kind === "provider_rate_limit" || termination.kind === "provider_network");
	if (termination.safeToAutoRetry !== expectedSafeToAutoRetry) {
		throw new TypeError("termination safeToAutoRetry flag is incoherent");
	}
}

function assertBoundedAuditDetails(value: unknown): asserts value is RunJournalAuditDetails {
	assertPlainDataRecord(value, "audit details", AUDIT_DETAIL_KEYS);
	const v = value as Record<string, unknown>;
	if (v.toolCallId !== undefined) {
		assertIdentifier(v.toolCallId, "details.toolCallId", 512);
		rejectCredential(v.toolCallId, "details.toolCallId");
	}
	if (v.toolName !== undefined) {
		assertIdentifier(v.toolName, "details.toolName", 128);
		rejectCredential(v.toolName, "details.toolName");
	}
	if (v.disposition !== undefined && (typeof v.disposition !== "string" || !AUDIT_DISPOSITIONS.has(v.disposition))) {
		throw new TypeError("details.disposition is out of bounds");
	}
	if (v.outcome !== undefined && (typeof v.outcome !== "string" || !AUDIT_OUTCOMES.has(v.outcome))) {
		throw new TypeError("details.outcome is out of bounds");
	}
	if (v.timeoutMs !== undefined) {
		assertSafeNonNegativeInt(v.timeoutMs, "details.timeoutMs");
	}
	if (v.executionStarted !== undefined && typeof v.executionStarted !== "boolean") {
		throw new TypeError("details.executionStarted must be a boolean");
	}
	if (v.insertedToolCallIds !== undefined) {
		if (!Array.isArray(v.insertedToolCallIds) || v.insertedToolCallIds.length > MAX_AUDIT_INSERTED_IDS) {
			throw new TypeError("details.insertedToolCallIds must be a bounded array");
		}
		for (const id of v.insertedToolCallIds) {
			assertIdentifier(id, "details.insertedToolCallIds[]", 512);
			rejectCredential(id, "details.insertedToolCallIds[]");
		}
	}
	if (v.reason !== undefined) {
		assertIdentifier(v.reason, "details.reason", MAX_AUDIT_REASON_LENGTH);
		rejectCredential(v.reason, "details.reason");
	}
	if (v.sessionRisk !== undefined && v.sessionRisk !== "elevated") {
		throw new TypeError("details.sessionRisk is out of bounds");
	}
}

function isTerminalCoherentWithEvent(
	event: "run_finished" | "run_recovered" | "run_abandoned",
	termination: SessionTermination,
): boolean {
	if (event === "run_recovered") {
		return (
			termination.source === "inferred_on_resume" &&
			termination.kind === "process_crash" &&
			termination.phase === "resume"
		);
	}
	if (termination.source !== "observed") return false;
	// process_crash is only coherent with an inferred_on_resume (run_recovered) source.
	if (termination.kind === "process_crash") return false;
	return true;
}

function assertTerminalCoherentWithEvent(
	event: "run_finished" | "run_recovered" | "run_abandoned",
	termination: SessionTermination,
): void {
	if (isTerminalCoherentWithEvent(event, termination)) return;
	if (event === "run_recovered") {
		throw new TypeError(
			"run_recovered requires a coherent process_crash termination (source inferred_on_resume, phase resume)",
		);
	}
	if (termination.kind === "process_crash") {
		throw new TypeError("process_crash terminations may only appear on run_recovered events");
	}
	throw new TypeError("run_finished and run_abandoned require a termination source of observed");
}

/**
 * Append-only run-journal writer. The constructor records the first
 * `run_started` event (and recomputes its hash); {@link RunJournal.start} opens
 * subsequent runs after a terminal event, while {@link RunJournal.finish},
 * {@link RunJournal.abandon}, and {@link RunJournal.recover} close the currently
 * open run. Exactly one run is open at a time.
 */
export class RunJournal {
	private readonly hashFn: RunJournalHashFn;
	private readonly sessionId: string;
	private readonly startedRunIds: Set<string> = new Set();
	private readonly terminatedRunIds: Set<string> = new Set();
	private readonly mutableRecords: RunJournalRecord[] = [];
	private recordsSnapshot: readonly RunJournalRecord[] = Object.freeze([]) as readonly RunJournalRecord[];
	private lastSessionRevision = 0;
	private prevHash: string;
	private nextSeq: number;
	private openRun: { readonly runId: string; readonly sessionId: string } | null = null;

	constructor(init: RunJournalConstructorInit) {
		assertPlainDataRecord(init, "RunJournalConstructorInit", [
			"hashFn",
			"sessionId",
			"runId",
			"sessionRevision",
			"timestamp",
			"prevHash",
			"seq",
			"openInitialRun",
		]);
		if (init.openInitialRun !== undefined && typeof init.openInitialRun !== "boolean") {
			throw new TypeError("openInitialRun must be a boolean");
		}
		if (typeof init.hashFn !== "function") {
			throw new TypeError("hashFn must be a function");
		}
		this.hashFn = init.hashFn;
		assertIdentifier(init.sessionId, "sessionId", MAX_RUN_JOURNAL_ID_LENGTH);
		rejectCredential(init.sessionId, "sessionId");
		this.sessionId = init.sessionId;
		const startSeq = init.seq ?? 0;
		assertSafeNonNegativeInt(startSeq, "seq");
		const startPrevHash = init.prevHash ?? GENESIS_HASH;
		assertHashShape(startPrevHash, "prevHash");
		this.prevHash = startPrevHash;
		this.nextSeq = startSeq;
		if (init.openInitialRun !== false) {
			this.appendStarted({
				runId: init.runId,
				sessionRevision: init.sessionRevision,
				timestamp: init.timestamp,
			});
		} else {
			// Audit-first journal: validate the seed runId shape, append nothing.
			assertIdentifier(init.runId, "runId", MAX_RUN_JOURNAL_ID_LENGTH);
			rejectCredential(init.runId, "runId");
		}
	}

	start(input: RunJournalStartInput): RunJournalStartedRecord {
		return this.appendStarted(input);
	}

	finish(input: RunJournalTerminalInput): RunJournalTerminalRecord {
		return this.appendTerminal("run_finished", input);
	}

	abandon(input: RunJournalTerminalInput): RunJournalTerminalRecord {
		return this.appendTerminal("run_abandoned", input);
	}

	recover(input: RunJournalTerminalInput): RunJournalTerminalRecord {
		return this.appendTerminal("run_recovered", input);
	}

	/**
	 * Append an audit-only record. Allowed with or without an open run; never
	 * opens, closes, or otherwise mutates run state. The record joins the same
	 * seq/hash chain as lifecycle records.
	 */
	audit(input: RunJournalAuditInput): RunJournalAuditRecord {
		assertPlainDataRecord(input, "RunJournalAuditInput", ["event", "details", "sessionRevision", "timestamp"]);
		if (typeof input.event !== "string" || !AUDIT_EVENTS.has(input.event as RunJournalEvent)) {
			throw new TypeError("audit event is out of bounds");
		}
		assertSafeNonNegativeInt(input.sessionRevision, "sessionRevision");
		if (input.sessionRevision < this.lastSessionRevision) {
			throw new Error("sessionRevision must not regress across the journal");
		}
		assertCanonicalTimestamp(input.timestamp, "timestamp");
		assertBoundedAuditDetails(input.details);
		const base: Omit<RunJournalAuditRecord, "hash"> = {
			schemaVersion: RUN_JOURNAL_SCHEMA_VERSION,
			seq: this.nextSeq,
			event: input.event as RunJournalAuditEvent,
			runId: this.openRun === null ? "none" : this.openRun.runId,
			sessionId: this.sessionId,
			sessionRevision: input.sessionRevision,
			timestamp: input.timestamp,
			prevHash: this.prevHash,
			details: input.details,
		};
		const record = this.seal(base);
		this.mutableRecords.push(record);
		this.prevHash = record.hash;
		this.nextSeq += 1;
		this.lastSessionRevision = input.sessionRevision;
		this.refreshRecordsSnapshot();
		return record;
	}

	get records(): readonly RunJournalRecord[] {
		return this.recordsSnapshot;
	}

	get openRunId(): string | null {
		return this.openRun === null ? null : this.openRun.runId;
	}

	serialize(): string {
		if (this.mutableRecords.length === 0) return "";
		return `${this.mutableRecords.map((record) => serializeRunJournalLine(record)).join("\n")}\n`;
	}

	toBytes(): Uint8Array {
		return TEXT_ENCODER.encode(this.serialize());
	}

	private refreshRecordsSnapshot(): void {
		this.recordsSnapshot = Object.freeze([...this.mutableRecords]) as readonly RunJournalRecord[];
	}

	private appendStarted(input: RunJournalStartInput): RunJournalStartedRecord {
		assertPlainDataRecord(input, "RunJournalStartInput", ["runId", "sessionRevision", "timestamp"]);
		assertIdentifier(input.runId, "runId", MAX_RUN_JOURNAL_ID_LENGTH);
		rejectCredential(input.runId, "runId");
		assertSafeNonNegativeInt(input.sessionRevision, "sessionRevision");
		if (input.sessionRevision < this.lastSessionRevision) {
			throw new Error("sessionRevision must not regress across the journal");
		}
		assertCanonicalTimestamp(input.timestamp, "timestamp");
		if (this.openRun !== null) {
			throw new Error("a run is already open; terminate it before starting another");
		}
		if (this.startedRunIds.has(input.runId)) {
			throw new Error("runId was already started earlier in this journal");
		}
		const base: Omit<RunJournalStartedRecord, "hash"> = {
			schemaVersion: RUN_JOURNAL_SCHEMA_VERSION,
			seq: this.nextSeq,
			event: "run_started",
			runId: input.runId,
			sessionId: this.sessionId,
			sessionRevision: input.sessionRevision,
			timestamp: input.timestamp,
			prevHash: this.prevHash,
		};
		const record = this.seal(base);
		this.mutableRecords.push(record);
		this.startedRunIds.add(input.runId);
		this.openRun = Object.freeze({ runId: input.runId, sessionId: this.sessionId });
		this.prevHash = record.hash;
		this.nextSeq += 1;
		this.lastSessionRevision = input.sessionRevision;
		this.refreshRecordsSnapshot();
		return record;
	}

	private appendTerminal(
		event: "run_finished" | "run_recovered" | "run_abandoned",
		input: RunJournalTerminalInput,
	): RunJournalTerminalRecord {
		assertPlainDataRecord(input, "RunJournalTerminalInput", ["termination", "sessionRevision", "timestamp"]);
		if (this.openRun === null) {
			throw new Error("no run is open; start a run before terminating it");
		}
		assertSafeNonNegativeInt(input.sessionRevision, "sessionRevision");
		if (input.sessionRevision < this.lastSessionRevision) {
			throw new Error("sessionRevision must not regress across the journal");
		}
		assertCanonicalTimestamp(input.timestamp, "timestamp");
		assertBoundedSessionTermination(input.termination, this.openRun.runId, this.sessionId);
		assertTerminalCoherentWithEvent(event, input.termination);
		if (input.timestamp !== input.termination.timestamp) {
			throw new TypeError("terminal event timestamp must equal termination timestamp");
		}
		if (this.terminatedRunIds.has(this.openRun.runId)) {
			throw new Error("the open run was already terminated");
		}
		const base: Omit<RunJournalTerminalRecord, "hash"> = {
			schemaVersion: RUN_JOURNAL_SCHEMA_VERSION,
			seq: this.nextSeq,
			event,
			runId: this.openRun.runId,
			sessionId: this.sessionId,
			sessionRevision: input.sessionRevision,
			timestamp: input.timestamp,
			prevHash: this.prevHash,
			termination: input.termination,
		};
		const record = this.seal(base);
		this.mutableRecords.push(record);
		this.terminatedRunIds.add(this.openRun.runId);
		this.openRun = null;
		this.prevHash = record.hash;
		this.nextSeq += 1;
		this.lastSessionRevision = input.sessionRevision;
		this.refreshRecordsSnapshot();
		return record;
	}

	private seal<T extends Omit<RunJournalRecord, "hash">>(base: T): T & { readonly hash: string } {
		const material = serializeRunJournalMaterial(base);
		let hash: string;
		try {
			hash = this.hashFn(TEXT_ENCODER.encode(material));
		} catch (error) {
			throw new TypeError("hashFn threw while sealing a record; failing closed", { cause: error });
		}
		if (!isValidHashShape(hash)) {
			throw new TypeError("hashFn must return 64 lowercase hex characters");
		}
		return deepFreeze({ ...base, hash }) as T & { readonly hash: string };
	}
}

interface CommonShape {
	readonly schemaVersion: 1;
	readonly seq: number;
	readonly event: RunJournalEvent;
	readonly runId: string;
	readonly sessionId: string;
	readonly sessionRevision: number;
	readonly timestamp: string;
	readonly prevHash: string;
	readonly hash: string;
}

function validateCommonShape(value: unknown): CommonShape | null {
	if (!isPlainObject(value)) return null;
	const rawEvent = (value as { event?: unknown }).event;
	const isTerminal = typeof rawEvent === "string" && TERMINAL_EVENTS.has(rawEvent as RunJournalEvent);
	const isAudit = typeof rawEvent === "string" && AUDIT_EVENTS.has(rawEvent as RunJournalEvent);
	const allowed: readonly string[] = isTerminal
		? [...COMMON_RECORD_KEYS, "termination"]
		: isAudit
			? [...COMMON_RECORD_KEYS, "details"]
			: COMMON_RECORD_KEYS;
	if (Object.keys(value).some((key) => !allowed.includes(key))) {
		return null;
	}
	const hasTermination = "termination" in value;
	if (isTerminal !== hasTermination) return null;
	if (isAudit !== "details" in value) return null;
	if (value.schemaVersion !== RUN_JOURNAL_SCHEMA_VERSION) return null;
	if (typeof value.event !== "string" || !RUN_JOURNAL_EVENTS.has(value.event as RunJournalEvent)) return null;
	if (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 0) return null;
	if (!isBoundedIdentifier(value.runId) || looksLikeCredential(value.runId)) return null;
	if (!isBoundedIdentifier(value.sessionId) || looksLikeCredential(value.sessionId)) return null;
	if (
		typeof value.sessionRevision !== "number" ||
		!Number.isSafeInteger(value.sessionRevision) ||
		value.sessionRevision < 0
	) {
		return null;
	}
	if (!isCanonicalTimestamp(value.timestamp)) return null;
	if (typeof value.prevHash !== "string" || typeof value.hash !== "string") return null;
	return {
		schemaVersion: RUN_JOURNAL_SCHEMA_VERSION,
		seq: value.seq,
		event: value.event as RunJournalEvent,
		runId: value.runId,
		sessionId: value.sessionId,
		sessionRevision: value.sessionRevision,
		timestamp: value.timestamp,
		prevHash: value.prevHash,
		hash: value.hash,
	};
}

type TerminationProbe =
	| { readonly kind: "ok"; readonly termination: SessionTermination }
	| { readonly kind: "mismatch" }
	| {
			readonly kind: "source";
	  };

function probeTermination(
	rawTermination: unknown,
	runId: string,
	sessionId: string,
	event: RunJournalEvent,
): TerminationProbe {
	let termination: SessionTermination;
	try {
		assertBoundedSessionTermination(rawTermination, runId, sessionId);
		termination = rawTermination as SessionTermination;
	} catch {
		return { kind: "mismatch" };
	}
	if (!isTerminalCoherentWithEvent(event as RunJournalTerminalRecord["event"], termination)) {
		return { kind: "source" };
	}
	return { kind: "ok", termination };
}

function addFinding(findings: RunJournalFinding[], finding: RunJournalFinding): void {
	findings.push(Object.freeze({ ...finding }));
}

/**
 * Inspect the complete-line prefix of a run-journal byte sequence without
 * mutating or repairing it. Only bytes through the final newline are parsed;
 * trailing bytes are reported as a fragment and never parsed. Every hash is
 * recomputed with the injected `hashFn`. The returned report is deeply frozen.
 */
export function inspectRunJournal(bytes: Uint8Array, hashFn: RunJournalHashFn): RunJournalReport {
	const findings: RunJournalFinding[] = [];

	let lastNewline = -1;
	for (let index = bytes.byteLength - 1; index >= 0; index -= 1) {
		if (bytes[index] === 0x0a) {
			lastNewline = index;
			break;
		}
	}
	const completeByteCount = lastNewline + 1;
	const trailingByteCount = bytes.byteLength - completeByteCount;
	if (trailingByteCount > 0) addFinding(findings, { code: "trailing_fragment" });

	const completeBytes = bytes.subarray(0, completeByteCount);
	let lineCount = 0;
	const parsedLines: { readonly line: number; readonly value: unknown }[] = [];
	if (completeByteCount > 0) {
		let text: string | undefined;
		try {
			text = TEXT_DECODER.decode(completeBytes);
		} catch {
			addFinding(findings, { code: "invalid_utf8" });
		}
		if (text !== undefined) {
			const body = text.slice(0, -1);
			const lines = body.length === 0 ? [] : body.split("\n");
			lineCount = lines.length;
			for (let index = 0; index < lines.length; index += 1) {
				const lineNumber = index + 1;
				const line = lines[index];
				if (line.trim().length === 0) {
					addFinding(findings, { code: "malformed_json", line: lineNumber });
					continue;
				}
				try {
					parsedLines.push({ line: lineNumber, value: JSON.parse(line) });
				} catch {
					addFinding(findings, { code: "malformed_json", line: lineNumber });
				}
			}
		}
	}

	let openRun: { runId: string; sessionId: string } | null = null;
	const seenStarts = new Set<string>();
	const terminatedRuns = new Set<string>();
	let expectedSeq = 0;
	let lastHash = GENESIS_HASH;
	let journalSessionId: string | null = null;
	let lastRevision = 0;
	const validRecords: RunJournalRecord[] = [];

	for (const { line, value } of parsedLines) {
		const common = validateCommonShape(value);
		if (common === null) {
			addFinding(findings, { code: "schema", line });
			continue;
		}
		let auditDetails: RunJournalAuditDetails | null = null;
		if (AUDIT_EVENTS.has(common.event)) {
			try {
				assertBoundedAuditDetails((value as Record<string, unknown>).details);
				auditDetails = (value as { details: RunJournalAuditDetails }).details;
			} catch {
				addFinding(findings, { code: "schema", line });
				continue;
			}
		}
		let termination: SessionTermination | null = null;
		if (TERMINAL_EVENTS.has(common.event)) {
			const probe = probeTermination(
				(value as Record<string, unknown>).termination,
				common.runId,
				common.sessionId,
				common.event,
			);
			if (probe.kind === "mismatch") {
				addFinding(findings, { code: "termination_mismatch", line, runId: common.runId });
				continue;
			}
			if (probe.kind === "source") {
				addFinding(findings, { code: "recovered_source_invalid", line, runId: common.runId });
				continue;
			}
			termination = probe.termination;
			if (common.timestamp !== termination.timestamp) {
				addFinding(findings, { code: "termination_mismatch", line, runId: common.runId });
				continue;
			}
		}
		if (journalSessionId === null) {
			journalSessionId = common.sessionId;
		} else if (common.sessionId !== journalSessionId) {
			addFinding(findings, { code: "session_mismatch", line, runId: common.runId });
			continue;
		}
		if (common.sessionRevision < lastRevision) {
			addFinding(findings, { code: "session_revision_regression", line, runId: common.runId });
			continue;
		}
		lastRevision = common.sessionRevision;

		const baseRecord = {
			schemaVersion: RUN_JOURNAL_SCHEMA_VERSION,
			seq: common.seq,
			event: common.event,
			runId: common.runId,
			sessionId: common.sessionId,
			sessionRevision: common.sessionRevision,
			timestamp: common.timestamp,
			prevHash: common.prevHash,
		};
		const recordWithoutHash = (
			termination !== null
				? { ...baseRecord, termination }
				: auditDetails !== null
					? { ...baseRecord, details: auditDetails }
					: baseRecord
		) as Omit<RunJournalRecord, "hash">;

		if (common.seq > expectedSeq) addFinding(findings, { code: "seq_gap", line });
		else if (common.seq < expectedSeq) addFinding(findings, { code: "seq_regression", line });
		expectedSeq = common.seq + 1;

		const hashShapeOk = isValidHashShape(common.hash);
		const prevHashShapeOk = isValidHashShape(common.prevHash);
		if (!hashShapeOk || !prevHashShapeOk) addFinding(findings, { code: "hash_shape", line });

		const material = serializeRunJournalMaterial(recordWithoutHash);
		let recomputeOk = false;
		try {
			const recomputed = hashFn(TEXT_ENCODER.encode(material));
			recomputeOk = isValidHashShape(recomputed) && recomputed === common.hash;
		} catch {
			recomputeOk = false;
		}
		if (!recomputeOk) addFinding(findings, { code: "hash_mismatch", line });

		if (common.prevHash !== lastHash) addFinding(findings, { code: "hash_chain_break", line });
		if (hashShapeOk) lastHash = common.hash;

		if (AUDIT_EVENTS.has(common.event)) {
			// Audit records never affect the run-state machine.
		} else if (common.event === "run_started") {
			if (seenStarts.has(common.runId)) addFinding(findings, { code: "duplicate_start", line, runId: common.runId });
			if (openRun !== null && openRun.runId !== common.runId) {
				addFinding(findings, { code: "interleaved_run", line, runId: common.runId });
			} else if (openRun === null) {
				openRun = { runId: common.runId, sessionId: common.sessionId };
			}
			seenStarts.add(common.runId);
		} else {
			if (terminatedRuns.has(common.runId)) {
				addFinding(findings, { code: "duplicate_terminal", line, runId: common.runId });
			} else if (openRun === null || openRun.runId !== common.runId) {
				addFinding(findings, { code: "orphan_terminal", line, runId: common.runId });
			} else {
				terminatedRuns.add(common.runId);
				openRun = null;
			}
		}

		const record = { ...recordWithoutHash, hash: common.hash } as RunJournalRecord;
		validRecords.push(deepFreeze(record) as RunJournalRecord);
	}

	if (openRun !== null) addFinding(findings, { code: "run_unclosed", runId: openRun.runId });

	return deepFreeze({
		ok: findings.length === 0,
		completePrefix: Object.freeze({ byteCount: completeByteCount, lineCount }),
		trailingByteCount,
		records: Object.freeze(validRecords) as readonly RunJournalRecord[],
		openRunId: openRun === null ? null : openRun.runId,
		findings: Object.freeze(findings) as readonly RunJournalFinding[],
	}) as RunJournalReport;
}
