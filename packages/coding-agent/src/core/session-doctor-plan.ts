/**
 * Pure, browser-safe session doctor planner (task I38).
 *
 * The doctor rederives every repair decision from caller-attested,
 * accessor-free plain data plus four pure runtime dependencies:
 *   - {@link createSessionRepairPlan} (session transcript repair),
 *   - {@link inspectRunJournal} / {@link serializeRunJournalLine} (journal
 *     integrity and terminal-record serialization),
 *   - {@link decideSessionPathAccess} (per-artifact path authorization),
 *   - {@link decideCompactionCommit} (compaction commit authorization).
 *
 * Runtime purity: no I/O, no wall clock, no entropy, no cryptographic
 * primitives, and no Node-only APIs. Every journal hash is recomputed by a
 * caller-injected synchronous hash function; the doctor never mints a
 * termination or a hash. {@link SessionIntegrityReport} is imported as a type
 * only, so the session-integrity module is never on this planner's runtime
 * dependency graph. All inputs are validated strictly (plain data, exact keys,
 * accessor-free) and the returned plan is a deep-frozen copy.
 */

import type { ToolResultMessage } from "omk-ai";
import type {
	CompactionCommitDecision,
	DecideCompactionCommitInput,
	SessionRevisionToken,
} from "./compaction/transaction.ts";
import { decideCompactionCommit } from "./compaction/transaction.ts";
import type { RunJournalCompletePrefix, RunJournalHashFn, RunJournalTerminalRecord } from "./run-journal.ts";
import { GENESIS_HASH, inspectRunJournal, serializeRunJournalLine } from "./run-journal.ts";
import type { SessionByteDigest, SessionCompletePrefix, SessionIntegrityReport } from "./session-integrity.ts";
import type {
	SessionPathAccessInput,
	SessionPathDecision,
	SessionPathIntent,
	SessionPathPlatform,
} from "./session-path-policy.ts";
import { decideSessionPathAccess } from "./session-path-policy.ts";
import { createSessionRepairPlan } from "./session-repair-plan.ts";

export const SESSION_DOCTOR_PLAN_SCHEMA_VERSION = 1 as const;

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_NORMALIZED_CHECKS = 128;
const MAX_FINDING_IDS = 64;
const MAX_PLAIN_DATA_DEPTH = 64;
const MAX_PLAIN_DATA_NODES = 200_000;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
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

// -------------------------------------------------------------------------------------------------
// Public types.
// -------------------------------------------------------------------------------------------------

export type SessionDoctorMode = "inspect" | "repair_dry_run" | "repair";
export type SessionDoctorStatus = "healthy" | "issues" | "refused";
export type SessionDoctorExitCode = 0 | 1 | 2;

export type SessionDoctorArtifact = "session" | "journal" | "path" | "compaction" | "normalized";

export type SessionDoctorFindingSeverity = "advisory" | "blocked";

export type SessionDoctorFindingReason =
	| "session_trailing_fragment"
	| "session_missing_tool_result"
	| "session_blocked"
	| "session_inspection_incomplete"
	| "journal_trailing_fragment"
	| "journal_unclosed"
	| "journal_blocked"
	| "session_path_unauthorized"
	| "journal_path_unauthorized"
	| "compaction_stale"
	| "compaction_deferred"
	| "compaction_failed"
	| "compaction_committed"
	| "compaction_duplicate"
	| "normalized_check_unhealthy"
	| "contract_violation";

export interface SessionDoctorFinding {
	readonly artifact: SessionDoctorArtifact;
	readonly reason: SessionDoctorFindingReason;
	readonly severity: SessionDoctorFindingSeverity;
	/** Bounded upstream reason/code (e.g. an integrity reason, journal finding code, path decision reason). */
	readonly code?: string;
	/** Bounded identifiers (toolCallIds, runIds, ...). */
	readonly ids?: readonly string[];
}

export type SessionDoctorActionArtifact = "session" | "journal";

export type SessionDoctorActionSpec =
	| {
			readonly kind: "quarantine_session_trailing_fragment";
			readonly artifact: "session";
			readonly retainPrefix: SessionCompletePrefix;
			readonly fragment: SessionByteDigest;
	  }
	| {
			readonly kind: "append_synthetic_tool_result";
			readonly artifact: "session";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly repairSequence: number;
			readonly message: Readonly<ToolResultMessage>;
	  }
	| {
			readonly kind: "quarantine_journal_trailing_fragment";
			readonly artifact: "journal";
			readonly completePrefix: RunJournalCompletePrefix;
			readonly lastCompleteHash: string;
	  }
	| {
			readonly kind: "recover_run";
			readonly artifact: "journal";
			readonly runId: string;
			readonly terminalRecord: RunJournalTerminalRecord;
			readonly completePrefix: RunJournalCompletePrefix;
			readonly lastCompleteHash: string;
	  }
	| {
			readonly kind: "remove_stale_lock";
			readonly artifact: SessionDoctorActionArtifact;
			readonly platform: SessionPathPlatform;
			readonly targetLexical: string;
			readonly targetRealpath: string;
			readonly holderPid: string | null;
			readonly artifacts: readonly SessionDoctorActionArtifact[];
	  }
	| {
			readonly kind: "abandon_stale_compaction";
			readonly artifact: "session";
			readonly transactionId: string;
			readonly baseRevision: Readonly<SessionRevisionToken>;
			readonly sourceSha256: string;
			readonly staleReason: "revision_mismatch" | "source_mismatch";
	  };

export type SessionDoctorAction = SessionDoctorActionSpec & { readonly sequence: number };

export interface SessionDoctorPlan {
	readonly schemaVersion: typeof SESSION_DOCTOR_PLAN_SCHEMA_VERSION;
	readonly mode: SessionDoctorMode;
	readonly sessionId: string;
	readonly repairId: string;
	readonly status: SessionDoctorStatus;
	readonly exitCode: SessionDoctorExitCode;
	readonly repairable: boolean;
	readonly requiresReinspection: boolean;
	readonly scheduledWrites: number;
	readonly findings: readonly SessionDoctorFinding[];
	readonly actions: readonly SessionDoctorAction[];
}

export type SessionDoctorNormalizedCheckArtifact =
	| "compaction_envelope"
	| "evidence_link"
	| "workspace"
	| "provider_model";

export interface SessionDoctorNormalizedCheck {
	readonly artifact: SessionDoctorNormalizedCheckArtifact;
	readonly id: string;
	readonly status: "ok" | "missing" | "invalid" | "unavailable";
}

export interface SessionDoctorJournalObservation {
	readonly bytes: Uint8Array;
	readonly hashFn: RunJournalHashFn;
	/** Caller-supplied terminal record for unclosed-run recovery. The doctor never mints it. */
	readonly terminalRecord?: RunJournalTerminalRecord;
}

export interface SessionDoctorPathObservation {
	readonly session?: Omit<SessionPathAccessInput, "intent">;
	readonly journal?: Omit<SessionPathAccessInput, "intent">;
}

export interface SessionDoctorPlanInput {
	readonly schemaVersion?: typeof SESSION_DOCTOR_PLAN_SCHEMA_VERSION;
	readonly mode: SessionDoctorMode;
	readonly sessionId: string;
	readonly repairId: string;
	/** Deterministic caller-provided epoch milliseconds. */
	readonly timestamp: number;
	readonly report: SessionIntegrityReport;
	readonly journal?: SessionDoctorJournalObservation;
	readonly paths?: SessionDoctorPathObservation;
	readonly compaction?: DecideCompactionCommitInput;
	readonly normalizedChecks?: readonly SessionDoctorNormalizedCheck[];
}

// -------------------------------------------------------------------------------------------------
// Generic plain-data / exact-key / accessor-free guards (fail closed).
// -------------------------------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	if (Object.getPrototypeOf(value) !== null && Object.getPrototypeOf(value) !== Object.prototype) return false;
	if (Object.getOwnPropertySymbols(value).length > 0) return false;
	for (const key of Object.keys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (
			descriptor === undefined ||
			descriptor.get !== undefined ||
			descriptor.set !== undefined ||
			!("value" in descriptor)
		) {
			return false;
		}
	}
	return true;
}

/**
 * Strictly validate a plain dense array before any indexed value access: it
 * must be a real Array whose prototype is exactly Array.prototype, carry no
 * symbol properties or extra own properties, and expose every index 0..length-1
 * as an own data descriptor (no holes, no getters/setters). Accessor indices are
 * rejected without their getters ever executing. The length is captured once.
 */
function assertStrictPlainArray(value: unknown, label: string): asserts value is unknown[] {
	if (typeof value !== "object" || value === null || !Array.isArray(value)) {
		throw new TypeError(`${label} must be an array`);
	}
	if (Object.getPrototypeOf(value) !== Array.prototype) {
		throw new TypeError(`${label} must use the Array prototype`);
	}
	if (Object.getOwnPropertySymbols(value).length > 0) {
		throw new TypeError(`${label} must not carry symbol properties`);
	}
	const length = value.length;
	for (const name of Object.getOwnPropertyNames(value)) {
		if (name === "length") continue;
		const index = Number(name);
		if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== name) {
			throw new TypeError(`${label} must not carry extra own properties`);
		}
	}
	for (let i = 0; i < length; i += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
		if (descriptor === undefined) throw new TypeError(`${label} must be dense (no holes)`);
		if (descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor)) {
			throw new TypeError(`${label} must not expose accessor or non-data element descriptors`);
		}
	}
}

function looksLikeCredential(value: string): boolean {
	return CREDENTIAL_SHAPES.some((pattern) => pattern.test(value));
}

function assertPlainData(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!isPlainDataObject(value)) {
		throw new TypeError(`${label} must be a plain data object without accessors or a foreign prototype`);
	}
}

/**
 * Bounded recursive plain-data validator for trust boundaries. Walks the full
 * value tree (plain objects and dense arrays) and rejects any accessor
 * property, symbol property, foreign prototype, or sparse array slot without
 * ever executing a getter (descriptors are inspected, never read). Guards
 * SessionIntegrityReport / journal terminalRecord / compaction before any of
 * their fields are read. Primitives pass; Uint8Array and functions are not
 * validated here (callers handle those explicitly).
 */
function assertPlainDataTree(value: unknown, label: string): void {
	let nodes = 0;
	const stack: Array<{ value: unknown; label: string; depth: number }> = [{ value, label, depth: 0 }];
	while (stack.length > 0) {
		const frame = stack.pop() as { value: unknown; label: string; depth: number };
		nodes += 1;
		if (nodes > MAX_PLAIN_DATA_NODES) {
			throw new TypeError(`${label}: plain-data tree exceeds the maximum node budget`);
		}
		const { value: current, label: currentLabel, depth } = frame;
		if (depth > MAX_PLAIN_DATA_DEPTH) {
			throw new TypeError(`${currentLabel}: plain-data tree exceeds the maximum depth`);
		}
		if (current === null || typeof current !== "object") continue;
		if (Array.isArray(current)) {
			assertStrictPlainArray(current, currentLabel);
			for (let index = 0; index < current.length; index += 1) {
				stack.push({ value: current[index], label: `${currentLabel}[${index}]`, depth: depth + 1 });
			}
			continue;
		}
		const prototype = Object.getPrototypeOf(current);
		if (prototype !== null && prototype !== Object.prototype) {
			throw new TypeError(`${currentLabel} must be a plain data object without a foreign prototype`);
		}
		if (Object.getOwnPropertySymbols(current).length > 0) {
			throw new TypeError(`${currentLabel} must be a plain data object without symbol properties`);
		}
		for (const key of Object.keys(current)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (descriptor === undefined || !("value" in descriptor)) {
				throw new TypeError(`${currentLabel}.${key} must be a plain data property without accessors`);
			}
			stack.push({ value: descriptor.value, label: `${currentLabel}.${key}`, depth: depth + 1 });
		}
	}
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
		throw new TypeError(`${label} must be 1-${MAX_IDENTIFIER_LENGTH} characters of bounded text`);
	}
	if (CONTROL_CHAR_RE.test(value)) {
		throw new TypeError(`${label} must not contain C0 or DEL control characters`);
	}
	if (looksLikeCredential(value)) {
		throw new TypeError(`${label} must not contain a credential-shaped literal`);
	}
}

function assertSafeNonNegativeInt(value: unknown, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${label} must be a non-negative safe integer`);
	}
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			throw new TypeError(`${label} contains an unsupported field: ${key}`);
		}
	}
}

// -------------------------------------------------------------------------------------------------
// Input validation.
// -------------------------------------------------------------------------------------------------

const INPUT_ALLOWED_KEYS = [
	"schemaVersion",
	"mode",
	"sessionId",
	"repairId",
	"timestamp",
	"report",
	"journal",
	"paths",
	"compaction",
	"normalizedChecks",
];
const MODES = new Set<SessionDoctorMode>(["inspect", "repair_dry_run", "repair"]);
const JOURNAL_KEYS = ["bytes", "hashFn", "terminalRecord"];
const PATHS_KEYS = ["session", "journal"];
const PATH_INPUT_KEYS = ["platform", "root", "target", "identity", "evidence", "lock"];
const COMPACTION_KEYS = ["transaction", "currentRevision", "currentSource", "barrier", "priorCommittedSourceDigests"];
const NORMALIZED_KEYS = ["artifact", "id", "status"];
const NORMALIZED_ARTIFACTS = new Set<SessionDoctorNormalizedCheckArtifact>([
	"compaction_envelope",
	"evidence_link",
	"workspace",
	"provider_model",
]);
const NORMALIZED_STATUSES = new Set(["ok", "missing", "invalid", "unavailable"]);

function validateNormalizedChecks(value: unknown): readonly SessionDoctorNormalizedCheck[] {
	assertStrictPlainArray(value, "normalizedChecks");
	if (value.length > MAX_NORMALIZED_CHECKS) {
		throw new TypeError(`normalizedChecks must contain at most ${MAX_NORMALIZED_CHECKS} entries`);
	}
	const checks: SessionDoctorNormalizedCheck[] = [];
	for (let index = 0; index < value.length; index++) {
		const entry = value[index];
		assertPlainData(entry, `normalizedChecks[${index}]`);
		assertOnlyKeys(entry, NORMALIZED_KEYS, `normalizedChecks[${index}]`);
		if (!NORMALIZED_ARTIFACTS.has(entry.artifact as SessionDoctorNormalizedCheckArtifact)) {
			throw new TypeError(`normalizedChecks[${index}].artifact is out of bounds`);
		}
		assertIdentifier(entry.id, `normalizedChecks[${index}].id`);
		if (!NORMALIZED_STATUSES.has(entry.status as string)) {
			throw new TypeError(`normalizedChecks[${index}].status is out of bounds`);
		}
		checks.push({
			artifact: entry.artifact as SessionDoctorNormalizedCheckArtifact,
			id: entry.id,
			status: entry.status as SessionDoctorNormalizedCheck["status"],
		});
	}
	return Object.freeze(checks);
}

function validatePathSubject(value: unknown, label: string): Omit<SessionPathAccessInput, "intent"> {
	assertPlainData(value, label);
	assertOnlyKeys(value, PATH_INPUT_KEYS, label);
	if (typeof value.platform !== "string" || (value.platform !== "posix" && value.platform !== "win32")) {
		throw new TypeError(`${label}.platform must be posix|win32`);
	}
	if (typeof value.root !== "string") throw new TypeError(`${label}.root must be a string`);
	if (typeof value.target !== "string") throw new TypeError(`${label}.target must be a string`);
	if (!Object.hasOwn(value, "evidence")) throw new TypeError(`${label}.evidence is required`);
	return value as unknown as Omit<SessionPathAccessInput, "intent">;
}

interface ValidatedInput {
	readonly mode: SessionDoctorMode;
	readonly sessionId: string;
	readonly repairId: string;
	readonly timestamp: number;
	readonly report: SessionIntegrityReport;
	readonly journal: SessionDoctorJournalObservation | null;
	readonly paths: {
		readonly session: Omit<SessionPathAccessInput, "intent"> | null;
		readonly journal: Omit<SessionPathAccessInput, "intent"> | null;
	};
	readonly compaction: DecideCompactionCommitInput | null;
	readonly normalizedChecks: readonly SessionDoctorNormalizedCheck[];
}

function validateInput(rawInput: unknown): ValidatedInput {
	assertPlainData(rawInput, "input");
	assertOnlyKeys(rawInput, INPUT_ALLOWED_KEYS, "input");
	if (rawInput.schemaVersion !== undefined && rawInput.schemaVersion !== SESSION_DOCTOR_PLAN_SCHEMA_VERSION) {
		throw new TypeError("unsupported session doctor plan schema version");
	}
	if (!MODES.has(rawInput.mode as SessionDoctorMode)) {
		throw new TypeError("mode must be inspect|repair_dry_run|repair");
	}
	assertIdentifier(rawInput.sessionId, "sessionId");
	assertIdentifier(rawInput.repairId, "repairId");
	assertSafeNonNegativeInt(rawInput.timestamp, "timestamp");
	assertPlainData(rawInput.report, "report");
	assertPlainDataTree(rawInput.report, "report");

	let journal: SessionDoctorJournalObservation | null = null;
	if (Object.hasOwn(rawInput, "journal") && rawInput.journal !== undefined) {
		assertPlainData(rawInput.journal, "journal");
		assertOnlyKeys(rawInput.journal, JOURNAL_KEYS, "journal");
		const sourceBytes = rawInput.journal.bytes;
		if (!(sourceBytes instanceof Uint8Array)) {
			throw new TypeError("journal.bytes must be a Uint8Array");
		}
		// Defensive copy: isolate the plan from caller buffer aliasing and from
		// hashFn closures that mutate the caller's bytes. The plan inspects and
		// re-inspects this stable private copy.
		const bytes = new Uint8Array(sourceBytes);
		if (typeof rawInput.journal.hashFn !== "function") {
			throw new TypeError("journal.hashFn must be a function");
		}
		let terminalRecord: RunJournalTerminalRecord | undefined;
		if (Object.hasOwn(rawInput.journal, "terminalRecord") && rawInput.journal.terminalRecord !== undefined) {
			assertPlainData(rawInput.journal.terminalRecord, "journal.terminalRecord");
			assertPlainDataTree(rawInput.journal.terminalRecord, "journal.terminalRecord");
			terminalRecord = rawInput.journal.terminalRecord as unknown as RunJournalTerminalRecord;
		}
		journal = Object.freeze({
			bytes,
			hashFn: rawInput.journal.hashFn as RunJournalHashFn,
			...(terminalRecord === undefined ? {} : { terminalRecord }),
		});
	}

	let pathsSession: Omit<SessionPathAccessInput, "intent"> | null = null;
	let pathsJournal: Omit<SessionPathAccessInput, "intent"> | null = null;
	if (Object.hasOwn(rawInput, "paths") && rawInput.paths !== undefined) {
		assertPlainData(rawInput.paths, "paths");
		assertOnlyKeys(rawInput.paths, PATHS_KEYS, "paths");
		if (Object.hasOwn(rawInput.paths, "session") && rawInput.paths.session !== undefined) {
			pathsSession = validatePathSubject(rawInput.paths.session, "paths.session");
		}
		if (Object.hasOwn(rawInput.paths, "journal") && rawInput.paths.journal !== undefined) {
			pathsJournal = validatePathSubject(rawInput.paths.journal, "paths.journal");
		}
	}

	let compaction: DecideCompactionCommitInput | null = null;
	if (Object.hasOwn(rawInput, "compaction") && rawInput.compaction !== undefined) {
		assertPlainData(rawInput.compaction, "compaction");
		assertOnlyKeys(rawInput.compaction, COMPACTION_KEYS, "compaction");
		assertPlainDataTree(rawInput.compaction, "compaction");
		compaction = rawInput.compaction as unknown as DecideCompactionCommitInput;
	}

	const normalizedChecks =
		Object.hasOwn(rawInput, "normalizedChecks") && rawInput.normalizedChecks !== undefined
			? validateNormalizedChecks(rawInput.normalizedChecks)
			: Object.freeze([] as readonly SessionDoctorNormalizedCheck[]);

	return {
		mode: rawInput.mode as SessionDoctorMode,
		sessionId: rawInput.sessionId,
		repairId: rawInput.repairId,
		timestamp: rawInput.timestamp,
		report: rawInput.report as unknown as SessionIntegrityReport,
		journal,
		paths: Object.freeze({ session: pathsSession, journal: pathsJournal }),
		compaction,
		normalizedChecks,
	};
}

// -------------------------------------------------------------------------------------------------
// Pure helpers.
// -------------------------------------------------------------------------------------------------

function intentForMode(mode: SessionDoctorMode): SessionPathIntent {
	if (mode === "inspect") return "inspect_content";
	if (mode === "repair_dry_run") return "repair_dry_run";
	return "repair";
}

function finding(
	artifact: SessionDoctorArtifact,
	reason: SessionDoctorFindingReason,
	severity: SessionDoctorFindingSeverity,
	code?: string,
	ids?: readonly string[],
): SessionDoctorFinding {
	const result: {
		artifact: SessionDoctorArtifact;
		reason: SessionDoctorFindingReason;
		severity: SessionDoctorFindingSeverity;
		code?: string;
		ids?: readonly string[];
	} = { artifact, reason, severity };
	if (code !== undefined && code.length > 0) {
		if (code.length > MAX_IDENTIFIER_LENGTH) {
			throw new TypeError("finding code exceeds the bounded length");
		}
		result.code = code;
	}
	if (ids !== undefined && ids.length > 0) {
		if (ids.length > MAX_FINDING_IDS) {
			throw new TypeError(`finding ids exceed the bounded limit of ${MAX_FINDING_IDS}; failing closed`);
		}
		for (const id of ids) assertIdentifier(id, "finding id");
		result.ids = Object.freeze([...ids]);
	}
	return Object.freeze(result) as SessionDoctorFinding;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	if (Array.isArray(value)) {
		for (const item of value) deepFreeze(item);
	} else {
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return Object.freeze(value);
}

function deepCopy<T>(value: T): T {
	if (typeof value !== "object" || value === null) return value;
	if (Array.isArray(value)) return deepFreeze(value.map(deepCopy)) as T;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>)) {
		out[key] = deepCopy((value as Record<string, unknown>)[key]);
	}
	return deepFreeze(out) as T;
}

function appendRecoveryRecord(
	bytes: Uint8Array,
	completePrefix: RunJournalCompletePrefix,
	record: RunJournalTerminalRecord,
): Uint8Array {
	const suffix = TEXT_ENCODER.encode(`${serializeRunJournalLine(record)}\n`);
	const out = new Uint8Array(completePrefix.byteCount + suffix.byteLength);
	out.set(bytes.subarray(0, completePrefix.byteCount));
	out.set(suffix, completePrefix.byteCount);
	return out;
}

function dedupPreserveOrder(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (!seen.has(value)) {
			seen.add(value);
			out.push(value);
		}
	}
	return out;
}

/** The remove_stale_lock variant of {@link SessionDoctorActionSpec}. */
type StaleLockActionSpec = Extract<SessionDoctorActionSpec, { kind: "remove_stale_lock" }>;

const STALE_LOCK_ARTIFACT_RANK: Record<SessionDoctorActionArtifact, number> = {
	session: 0,
	journal: 1,
};

/**
 * Canonical physical target key for stale-lock dedup. Win32 compares
 * case-insensitively (lower-cased); POSIX is exact. The platform is intentionally
 * not part of the key, so a target described under conflicting platforms is
 * surfaced as a contract violation rather than silently duplicated.
 */
function canonicalStaleLockTargetKey(
	platform: SessionPathPlatform,
	targetLexical: string,
	targetRealpath: string,
): string {
	const lexical = platform === "win32" ? targetLexical.toLowerCase() : targetLexical;
	const realpath = platform === "win32" ? targetRealpath.toLowerCase() : targetRealpath;
	return JSON.stringify([lexical, realpath]);
}

/**
 * Deduplicate stale-lock actions from the session and journal paths by their
 * canonical physical target, merging the contributing artifacts deterministically
 * (sorted by artifact rank). A target described under conflicting platforms or
 * conflicting holder pids is a contract violation: the plan is refused and no
 * actions are reported for that target.
 */
function dedupStaleLockActions(specs: readonly StaleLockActionSpec[], acc: Accumulators): StaleLockActionSpec[] {
	if (specs.length <= 1) return [...specs];
	const groups = new Map<string, StaleLockActionSpec[]>();
	for (const spec of specs) {
		const key = canonicalStaleLockTargetKey(spec.platform, spec.targetLexical, spec.targetRealpath);
		const group = groups.get(key);
		if (group === undefined) {
			groups.set(key, [spec]);
		} else {
			group.push(spec);
		}
	}
	const out: StaleLockActionSpec[] = [];
	for (const group of groups.values()) {
		if (group.length === 1) {
			out.push(group[0]);
			continue;
		}
		const platforms = new Set(group.map((spec) => spec.platform));
		const holders = new Set(group.map((spec) => spec.holderPid));
		if (platforms.size > 1 || holders.size > 1) {
			acc.findings.push(finding("path", "contract_violation", "blocked", "stale_lock_target_conflict"));
			acc.refused = true;
			continue;
		}
		const mergedArtifacts = Array.from(new Set(group.flatMap((spec) => spec.artifacts))).sort(
			(a, b) => STALE_LOCK_ARTIFACT_RANK[a] - STALE_LOCK_ARTIFACT_RANK[b],
		);
		out.push({ ...group[0], artifacts: Object.freeze(mergedArtifacts) });
	}
	return out;
}

// Finding sort: stable total ordering by artifact, reason, code, then ids.
const ARTIFACT_RANK: Record<SessionDoctorArtifact, number> = {
	session: 0,
	journal: 1,
	path: 2,
	compaction: 3,
	normalized: 4,
};

function findingSortKey(value: SessionDoctorFinding): string {
	return `${ARTIFACT_RANK[value.artifact]}|${value.reason}|${value.code ?? ""}|${(value.ids ?? []).join(",")}`;
}

function sortFindings(findings: SessionDoctorFinding[]): SessionDoctorFinding[] {
	return [...findings].sort((a, b) => {
		const left = findingSortKey(a);
		const right = findingSortKey(b);
		return left < right ? -1 : left > right ? 1 : 0;
	});
}

// -------------------------------------------------------------------------------------------------
// Artifact derivations. Each mutates the shared accumulators and the refused flag.
// -------------------------------------------------------------------------------------------------

interface Accumulators {
	readonly findings: SessionDoctorFinding[];
	readonly sessionSpecs: SessionDoctorActionSpec[];
	readonly journalSpecs: SessionDoctorActionSpec[];
	readonly pathSpecs: StaleLockActionSpec[];
	readonly compactionSpecs: SessionDoctorActionSpec[];
	refused: boolean;
}

const REPAIRABLE_SESSION_BLOCKER_REASONS = new Set([
	"integrity_finding",
	"inspection_incomplete",
	"ambiguous_transcript",
	"inconsistent_report",
]);

function deriveSession(input: ValidatedInput, acc: Accumulators): void {
	const report = input.report;

	// Cross-bind the session header identity to the doctored session id.
	const header = report.header;
	if (header !== null && isRecord(header) && typeof header.id === "string" && header.id !== input.sessionId) {
		acc.findings.push(finding("session", "contract_violation", "blocked", "session_identity_mismatch"));
		acc.refused = true;
	}

	// Ignore report.ok: createSessionRepairPlan rederives consistency and the
	// repairable action set with a fixed doctor_repair reason.
	const sessionPlan = createSessionRepairPlan(report, {
		repairId: input.repairId,
		reason: "doctor_repair",
		timestamp: input.timestamp,
	});

	if (sessionPlan.status === "repairable") {
		let quarantined = false;
		const missingIds: string[] = [];
		const appendSpecs: {
			readonly kind: "append_synthetic_tool_result";
			readonly artifact: "session";
			readonly toolCallId: string;
			readonly toolName: string;
			readonly repairSequence: number;
			readonly message: Readonly<ToolResultMessage>;
		}[] = [];
		for (const action of sessionPlan.actions) {
			if (action.kind === "quarantine_trailing_fragment") {
				quarantined = true;
				acc.sessionSpecs.push({
					kind: "quarantine_session_trailing_fragment",
					artifact: "session",
					retainPrefix: { ...action.retainPrefix },
					fragment: { ...action.fragment },
				});
			} else if (action.kind === "append_synthetic_tool_result") {
				missingIds.push(action.toolCallId);
				// Prevalidate the synthetic message as plain data before deep-copying
				// it into the action, so a non-plain runtime payload fails closed.
				assertPlainDataTree(action.message, "session synthetic tool result message");
				appendSpecs.push({
					kind: "append_synthetic_tool_result",
					artifact: "session",
					toolCallId: action.toolCallId,
					toolName: action.toolName,
					repairSequence: action.sequence,
					message: deepCopy(action.message),
				});
			}
		}
		// Normalize session action order regardless of upstream: quarantine first,
		// then synthetic appends sorted by their upstream repair sequence.
		appendSpecs.sort((a, b) => a.repairSequence - b.repairSequence);
		for (const spec of appendSpecs) acc.sessionSpecs.push(spec);
		if (quarantined) {
			acc.findings.push(finding("session", "session_trailing_fragment", "blocked"));
		}
		if (missingIds.length > 0) {
			acc.findings.push(finding("session", "session_missing_tool_result", "blocked", undefined, missingIds));
		}
		return;
	}

	if (sessionPlan.status === "blocked") {
		for (const blocker of sessionPlan.blockers) {
			if (!REPAIRABLE_SESSION_BLOCKER_REASONS.has(blocker.reason)) {
				acc.findings.push(finding("session", "contract_violation", "blocked", "unknown_blocker"));
				acc.refused = true;
				continue;
			}
			switch (blocker.reason) {
				case "inconsistent_report":
					acc.findings.push(finding("session", "contract_violation", "blocked", "inconsistent_report"));
					acc.refused = true;
					break;
				case "inspection_incomplete":
					acc.findings.push(finding("session", "session_inspection_incomplete", "blocked"));
					break;
				case "ambiguous_transcript":
					acc.findings.push(finding("session", "session_blocked", "blocked", "ambiguous_transcript"));
					break;
				case "integrity_finding": {
					const ids: string[] = [];
					if (blocker.entryId !== undefined) ids.push(blocker.entryId);
					if (blocker.toolCallId !== undefined) ids.push(blocker.toolCallId);
					acc.findings.push(
						finding(
							"session",
							"session_blocked",
							"blocked",
							blocker.findingReason,
							ids.length > 0 ? ids : undefined,
						),
					);
					break;
				}
				default:
					acc.findings.push(finding("session", "contract_violation", "blocked", "unknown_blocker"));
					acc.refused = true;
					break;
			}
		}
	}
	// status "not_needed": nothing to observe for the session artifact.
}

function deriveJournal(input: ValidatedInput, acc: Accumulators): void {
	const observation = input.journal;
	if (observation === null) return;

	const report = inspectRunJournal(observation.bytes, observation.hashFn);
	const records = report.records;
	const findingCodes = report.findings.map((f) => f.code);
	const codeSet = new Set(findingCodes);
	const hasSessionMismatch = codeSet.has("session_mismatch");
	const allBound = records.length === 0 || records.every((record) => record.sessionId === input.sessionId);

	// Cross-bind every journal record session id to the doctored session id.
	if (!allBound || hasSessionMismatch) {
		acc.findings.push(finding("journal", "contract_violation", "blocked", "session_identity_mismatch"));
		acc.refused = true;
	}

	const trailing = codeSet.has("trailing_fragment");
	const unclosed = codeSet.has("run_unclosed");
	const hardCodes = dedupPreserveOrder(
		findingCodes.filter(
			(code) => code !== "trailing_fragment" && code !== "run_unclosed" && code !== "session_mismatch",
		),
	);
	const journalCanAct = hardCodes.length === 0 && allBound && !hasSessionMismatch;

	for (const code of hardCodes) {
		acc.findings.push(finding("journal", "journal_blocked", "blocked", code));
	}

	// Unclosed-run recovery: only when findings are a subset of {run_unclosed, trailing_fragment}.
	const recoverableState = unclosed && journalCanAct;
	let recoverySucceeded = false;
	if (unclosed) {
		const runIds = report.openRunId !== null ? [report.openRunId] : undefined;
		acc.findings.push(finding("journal", "journal_unclosed", "blocked", undefined, runIds));
		const supplied = Object.hasOwn(observation, "terminalRecord") ? observation.terminalRecord : undefined;
		if (supplied !== undefined) {
			if (!recoverableState) {
				// Spurious: a recovery record was supplied for a journal that is not in the recoverable state.
				acc.findings.push(finding("journal", "contract_violation", "blocked", "spurious_terminal_record"));
				acc.refused = true;
			} else {
				const recheck = inspectRunJournal(
					appendRecoveryRecord(observation.bytes, report.completePrefix, supplied),
					observation.hashFn,
				);
				const last = recheck.records.length > 0 ? recheck.records[recheck.records.length - 1] : null;
				const identityOk = last !== null && serializeRunJournalLine(last) === serializeRunJournalLine(supplied);
				if (
					recheck.ok &&
					recheck.openRunId === null &&
					last !== null &&
					last.event === "run_recovered" &&
					identityOk
				) {
					recoverySucceeded = true;
					const lastCompleteHash = records.length > 0 ? records[records.length - 1].hash : GENESIS_HASH;
					acc.journalSpecs.push({
						kind: "recover_run",
						artifact: "journal",
						runId: last.runId,
						terminalRecord: deepCopy(supplied),
						completePrefix: {
							byteCount: report.completePrefix.byteCount,
							lineCount: report.completePrefix.lineCount,
						},
						lastCompleteHash,
					});
				} else {
					acc.findings.push(finding("journal", "contract_violation", "blocked", "forged_terminal_record"));
					acc.refused = true;
				}
			}
		}
	} else {
		const supplied = Object.hasOwn(observation, "terminalRecord") ? observation.terminalRecord : undefined;
		if (supplied !== undefined) {
			// Spurious: a recovery record was supplied with no unclosed run to recover.
			acc.findings.push(finding("journal", "contract_violation", "blocked", "spurious_terminal_record"));
			acc.refused = true;
		}
	}

	// Trailing fragment: quarantine the journal tail, anchored on the complete
	// prefix and the last complete hash (genesis if none). When recovery
	// succeeded the recover_run action carries completePrefix + lastCompleteHash,
	// explicitly anchoring a truncate-to-prefix-then-append that already discards
	// the trailing fragment, so it subsumes the quarantine action.
	if (trailing && journalCanAct && !recoverySucceeded) {
		acc.findings.push(finding("journal", "journal_trailing_fragment", "blocked"));
		const lastCompleteHash = records.length > 0 ? records[records.length - 1].hash : GENESIS_HASH;
		acc.journalSpecs.push({
			kind: "quarantine_journal_trailing_fragment",
			artifact: "journal",
			completePrefix: { byteCount: report.completePrefix.byteCount, lineCount: report.completePrefix.lineCount },
			lastCompleteHash,
		});
	}
}

function deriveCompaction(input: ValidatedInput, acc: Accumulators): void {
	const observation = input.compaction;
	if (observation === null) return;

	// Cross-bind the transaction base/source session id before rederiving.
	const tx = observation.transaction;
	const baseSessionId =
		isRecord(tx) && isRecord(tx.baseRevision) && typeof tx.baseRevision.sessionId === "string"
			? (tx.baseRevision.sessionId as string)
			: null;
	const sourceSessionId =
		isRecord(tx) && isRecord(tx.source) && typeof tx.source.sessionId === "string"
			? (tx.source.sessionId as string)
			: null;
	if (baseSessionId !== input.sessionId || sourceSessionId !== input.sessionId) {
		acc.findings.push(finding("compaction", "contract_violation", "blocked", "session_identity_mismatch"));
		acc.refused = true;
		return;
	}

	const decision: CompactionCommitDecision = decideCompactionCommit(observation);
	switch (decision.decision) {
		case "stale":
			acc.findings.push(finding("compaction", "compaction_stale", "blocked"));
			acc.compactionSpecs.push({
				kind: "abandon_stale_compaction",
				artifact: "session",
				transactionId: decision.transactionId,
				baseRevision: deepCopy(tx.baseRevision),
				sourceSha256: tx.source.sourceSha256,
				staleReason: decision.reason,
			});
			break;
		case "defer":
			acc.findings.push(finding("compaction", "compaction_deferred", "blocked", decision.barrierReason));
			break;
		case "fail_closed":
			if (decision.reason === "barrier_fail_closed") {
				acc.findings.push(finding("compaction", "compaction_failed", "blocked", decision.barrierReason));
			} else {
				acc.findings.push(finding("compaction", "contract_violation", "blocked", decision.reason));
				acc.refused = true;
			}
			break;
		case "commit":
			acc.findings.push(finding("compaction", "compaction_committed", "advisory"));
			break;
		case "duplicate":
			acc.findings.push(finding("compaction", "compaction_duplicate", "advisory"));
			break;
		default:
			acc.findings.push(finding("compaction", "contract_violation", "blocked", "unknown_decision"));
			acc.refused = true;
			break;
	}
}

interface StaleLockTarget {
	readonly platform: SessionPathPlatform;
	readonly targetLexical: string;
	readonly targetRealpath: string;
	readonly holderPid: string | null;
}

interface PathAuthorization {
	readonly decision: SessionPathDecision | null;
	readonly authorized: boolean;
	readonly staleLock: StaleLockTarget | null;
}

function evaluatePath(
	subject: Omit<SessionPathAccessInput, "intent"> | null,
	intent: SessionPathIntent,
): PathAuthorization {
	if (subject === null) {
		return { decision: null, authorized: false, staleLock: null };
	}
	const decision = decideSessionPathAccess({ ...subject, intent });
	if (decision.status === "authorized") {
		const stale = decision.plannedActions.find((action) => action.kind === "remove_stale_lock");
		if (stale !== undefined && stale.kind === "remove_stale_lock") {
			return {
				decision,
				authorized: true,
				staleLock: {
					platform: decision.platform,
					targetLexical: decision.targetLexical,
					targetRealpath: decision.targetRealpath,
					holderPid: stale.holderPid,
				},
			};
		}
		return { decision, authorized: true, staleLock: null };
	}
	return { decision, authorized: false, staleLock: null };
}

function derivePaths(
	input: ValidatedInput,
	acc: Accumulators,
	sessionPathNeeded: boolean,
	journalPathNeeded: boolean,
): void {
	const intent = intentForMode(input.mode);
	const requiresAuthorized = input.mode === "repair" || input.mode === "repair_dry_run";

	const sessionAuth = evaluatePath(input.paths.session, intent);
	authorizeArtifact(acc, sessionAuth, sessionPathNeeded, "session", "session_path_unauthorized", requiresAuthorized);
	const journalAuth = evaluatePath(input.paths.journal, intent);
	authorizeArtifact(acc, journalAuth, journalPathNeeded, "journal", "journal_path_unauthorized", requiresAuthorized);
}

function authorizeArtifact(
	acc: Accumulators,
	auth: PathAuthorization,
	needed: boolean,
	artifact: SessionDoctorActionArtifact,
	reason: SessionDoctorFindingReason,
	requiresAuthorized: boolean,
): void {
	if (auth.authorized) {
		// Eligible stale-lock cleanup from this path decision only.
		if (auth.staleLock !== null) {
			acc.pathSpecs.push({
				kind: "remove_stale_lock",
				artifact,
				platform: auth.staleLock.platform,
				targetLexical: auth.staleLock.targetLexical,
				targetRealpath: auth.staleLock.targetRealpath,
				holderPid: auth.staleLock.holderPid,
				artifacts: [artifact],
			});
		}
		return;
	}
	// Not authorized (rejected, blocked, or not provided).
	if (needed && requiresAuthorized) {
		acc.findings.push(finding("path", reason, "blocked", auth.decision?.reason ?? "missing"));
		acc.refused = true;
	} else if (auth.decision !== null) {
		// Provided but rejected/blocked: always a diagnostic issue.
		acc.findings.push(finding("path", reason, "blocked", auth.decision.reason));
	}
	// Not provided and not needed (or inspect mode): nothing to report.
}

function deriveNormalizedChecks(input: ValidatedInput, acc: Accumulators): void {
	for (const check of input.normalizedChecks) {
		if (check.status !== "ok") {
			acc.findings.push(
				finding("normalized", "normalized_check_unhealthy", "blocked", `${check.artifact}:${check.status}`),
			);
		}
	}
}

// -------------------------------------------------------------------------------------------------
// Plan assembly.
// -------------------------------------------------------------------------------------------------

export function planSessionDoctor(rawInput: unknown): SessionDoctorPlan {
	const input = validateInput(rawInput);
	const acc: Accumulators = {
		findings: [],
		sessionSpecs: [],
		journalSpecs: [],
		pathSpecs: [],
		compactionSpecs: [],
		refused: false,
	};

	deriveSession(input, acc);
	deriveJournal(input, acc);
	deriveCompaction(input, acc);

	// Paths gate prospective repair actions. Session actions and compaction
	// abandon require an authorized session path; journal actions require an
	// authorized journal path. Inspect mode never performs writes, so paths are
	// only gating in dry/repair.
	const writesPlanned = input.mode !== "inspect";
	const sessionPathNeeded = writesPlanned && (acc.sessionSpecs.length > 0 || acc.compactionSpecs.length > 0);
	const journalPathNeeded = writesPlanned && acc.journalSpecs.length > 0;
	derivePaths(input, acc, sessionPathNeeded, journalPathNeeded);

	deriveNormalizedChecks(input, acc);

	// Deduplicate stale-lock actions (session + journal paths may target the same
	// physical file) before sequence assignment so reported actions stay contiguous.
	const dedupedPathSpecs = dedupStaleLockActions(acc.pathSpecs, acc);
	const orderedSpecs: SessionDoctorActionSpec[] = [
		...acc.sessionSpecs,
		...acc.journalSpecs,
		...dedupedPathSpecs,
		...acc.compactionSpecs,
	];
	const eligibleActions: SessionDoctorAction[] = orderedSpecs.map((spec, index) =>
		deepFreeze({ ...spec, sequence: index }),
	);
	const sortedFindings = Object.freeze(sortFindings(acc.findings).map((f) => deepCopy(f)));

	const refused = acc.refused;
	const reportedActions = refused || input.mode === "inspect" ? ([] as SessionDoctorAction[]) : eligibleActions;
	const scheduledWrites = input.mode === "repair" && !refused ? eligibleActions.length : 0;
	const requiresReinspection = scheduledWrites > 0;

	// "healthy" permits advisory findings (e.g. compaction_committed /
	// compaction_duplicate); only a blocked finding or an eligible action
	// downgrades the status to "issues".
	const hasBlockingFinding = sortedFindings.some((f) => f.severity === "blocked");
	const clean = !hasBlockingFinding && eligibleActions.length === 0;
	const status: SessionDoctorStatus = refused ? "refused" : clean ? "healthy" : "issues";
	const exitCode: SessionDoctorExitCode = refused ? 2 : clean ? 0 : 1;

	return deepFreeze({
		schemaVersion: SESSION_DOCTOR_PLAN_SCHEMA_VERSION,
		mode: input.mode,
		sessionId: input.sessionId,
		repairId: input.repairId,
		status,
		exitCode,
		repairable: !refused && eligibleActions.length > 0,
		requiresReinspection,
		scheduledWrites,
		findings: sortedFindings,
		actions: Object.freeze([...reportedActions]),
	}) as SessionDoctorPlan;
}
