import type { TranscriptIntegrityIssue, TranscriptIntegrityReport } from "omk-agent-core";
import { inspectTranscriptIntegrity } from "omk-agent-core";
import type {
	SessionIntegrityFinding,
	SessionIntegrityReasonCode,
	SessionIntegrityReport,
} from "../session-integrity.ts";

export const SESSION_REVISION_TOKEN_SCHEMA_VERSION = 1 as const;
export const COMPACTION_TRANSACTION_SCHEMA_VERSION = 1 as const;
export const COMPACTION_ENVELOPE_SCHEMA_VERSION = 2 as const;

const MAX_METADATA_LENGTH = 256;
const MAX_FILE_IDENTITY_LENGTH = 32;
const MAX_SOURCE_ENTRIES = 4096;
const MAX_PROVENANCE_IDS = 1024;
const MAX_LATEST_INTENT_LENGTH = 16_384;
const MAX_SUMMARY_LENGTH = 262_144;
const MAX_PROVENANCE_TEXT_LENGTH = 4096;
const MAX_NEXT_ACTION_LENGTH = 4096;
const MAX_MODEL_HISTORY_ENTRIES = 256;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DECIMAL_STRING_PATTERN = /^[0-9]+$/u;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const METADATA_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const CONTENT_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const CREDENTIAL_SHAPE_PATTERN =
	/-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:^|[\s"'`:])bearer\s+[A-Za-z0-9._~+/-]{8,}|(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|passwd|client[-_ ]?secret|secret[-_ ]?(?:key|token))\s*[:=]\s*["']?[^\s"',;]{3,}|(?:sk|ghp|gho|ghu|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/iu;

export interface SessionFileIdentity {
	readonly dev: string;
	readonly ino: string;
}

export interface SessionRevisionToken {
	readonly schemaVersion: typeof SESSION_REVISION_TOKEN_SCHEMA_VERSION;
	readonly sessionId: string;
	readonly completeBytes: number;
	readonly recordCount: number;
	readonly leafId: string | null;
	readonly lastEntryId: string | null;
	readonly completePrefixSha256: string;
	readonly fileIdentity?: SessionFileIdentity;
}

export interface SessionRevisionTokenInput {
	readonly schemaVersion?: typeof SESSION_REVISION_TOKEN_SCHEMA_VERSION;
	readonly sessionId: string;
	readonly completeBytes: number;
	readonly recordCount: number;
	readonly leafId: string | null;
	readonly lastEntryId: string | null;
	readonly completePrefixSha256: string;
	readonly fileIdentity?: SessionFileIdentity;
}

export interface CompactionSourceIdentity {
	readonly sessionId: string;
	readonly entryIds: readonly string[];
	readonly firstEntryId: string;
	readonly lastEntryId: string;
	readonly sourceSha256: string;
	readonly activeLeafId: string;
	readonly messageCount: number;
}

export interface CompactionSourceIdentityInput {
	readonly sessionId: string;
	readonly entryIds: readonly string[];
	readonly firstEntryId: string;
	readonly lastEntryId: string;
	readonly sourceSha256: string;
	readonly activeLeafId: string;
	readonly messageCount: number;
}

export interface CompactionModelIdentity {
	readonly provider: string;
	readonly id: string;
}

export interface CompactionModelHistoryEntry {
	readonly entryId: string;
	readonly provider: string;
	readonly modelId: string;
}

export interface CompactionPreservedProvenance {
	readonly latestIntent: string;
	readonly openTasks: readonly string[];
	readonly laneIds: readonly string[];
	readonly acceptancePredicateIds: readonly string[];
	readonly evidenceReceiptIds: readonly string[];
	readonly blockerReasons: readonly string[];
	readonly repairEventIds: readonly string[];
	readonly branch: string | null;
	readonly worktree: string | null;
	readonly modelHistory: readonly CompactionModelHistoryEntry[];
	readonly nextAction: string;
}

export interface CompactionPreservedProvenanceInput {
	readonly latestIntent: string;
	readonly openTasks: readonly string[];
	readonly laneIds: readonly string[];
	readonly acceptancePredicateIds: readonly string[];
	readonly evidenceReceiptIds: readonly string[];
	readonly blockerReasons: readonly string[];
	readonly repairEventIds: readonly string[];
	readonly branch: string | null;
	readonly worktree: string | null;
	readonly modelHistory: readonly CompactionModelHistoryEntry[];
	readonly nextAction: string;
}

export interface CompactionTransaction {
	readonly schemaVersion: typeof COMPACTION_TRANSACTION_SCHEMA_VERSION;
	readonly transactionId: string;
	readonly baseRevision: SessionRevisionToken;
	readonly source: CompactionSourceIdentity;
	readonly createdAt: string;
	readonly model: CompactionModelIdentity;
	readonly preserved: CompactionPreservedProvenance;
}

export interface CompactionTransactionInput {
	readonly schemaVersion?: typeof COMPACTION_TRANSACTION_SCHEMA_VERSION;
	readonly transactionId: string;
	readonly baseRevision: SessionRevisionTokenInput;
	readonly source: CompactionSourceIdentityInput;
	readonly createdAt: string;
	readonly model: CompactionModelIdentity;
	readonly preserved: CompactionPreservedProvenanceInput;
}

export type CompactionBarrierStatus = "ready" | "defer" | "fail_closed";
export type CompactionBarrierReason =
	| "closed_active_branch"
	| "pending_tool_calls"
	| "missing_active_tail_results"
	| "invalid_pending_tool_ids"
	| "inconsistent_integrity_report"
	| "structural_integrity_failure"
	| "unsafe_missing_tool_results";

export interface CompactionBarrierResult {
	readonly status: CompactionBarrierStatus;
	readonly reason: CompactionBarrierReason;
	readonly pendingToolCallIds: readonly string[];
	readonly missingToolCallIds: readonly string[];
}

export type CompactionCommitDecision =
	| {
			readonly decision: "commit";
			readonly reason: "exact_match";
			readonly transactionId: string;
			readonly revision: SessionRevisionToken;
			readonly source: CompactionSourceIdentity;
	  }
	| {
			readonly decision: "stale";
			readonly reason: "revision_mismatch" | "source_mismatch";
			readonly transactionId: string;
	  }
	| {
			readonly decision: "duplicate";
			readonly reason: "source_already_committed";
			readonly transactionId: string;
	  }
	| {
			readonly decision: "defer";
			readonly reason: "barrier_defer";
			readonly transactionId: string;
			readonly barrierReason: CompactionBarrierReason;
	  }
	| {
			readonly decision: "fail_closed";
			readonly reason: "barrier_fail_closed" | "invalid_transaction" | "invalid_commit_input";
			readonly transactionId?: string;
			readonly barrierReason?: CompactionBarrierReason;
	  };

export interface DecideCompactionCommitInput {
	readonly transaction: CompactionTransaction;
	readonly currentRevision: SessionRevisionToken;
	readonly currentSource: CompactionSourceIdentity;
	readonly barrier: CompactionBarrierResult;
	readonly priorCommittedSourceDigests: readonly string[];
}

export interface CompactionEnvelope {
	readonly schemaVersion: typeof COMPACTION_ENVELOPE_SCHEMA_VERSION;
	readonly transactionId: string;
	readonly baseRevision: SessionRevisionToken;
	readonly source: CompactionSourceIdentity;
	readonly createdAt: string;
	readonly model: CompactionModelIdentity;
	readonly summary: string;
	readonly summarySha256: string;
	readonly preserved: CompactionPreservedProvenance;
}

export interface CreateCompactionEnvelopeInput {
	readonly transaction: CompactionTransaction;
	readonly decision: CompactionCommitDecision;
	readonly summary: string;
	/** Caller-supplied lowercase 64-hex SHA-256 digest of `summary`. OMK does not compute or verify the digest here; the caller is responsible for computing and binding it. */
	readonly summarySha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
	const allowedKeys = new Set(allowed);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
		throw new TypeError(`${field} contains unsupported metadata`);
	}
}

function assertSafeInteger(value: unknown, field: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new TypeError(`${field} must be a non-negative safe integer`);
	}
}

function assertMetadataText(value: unknown, field: string, maxLength = MAX_METADATA_LENGTH): asserts value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength ||
		METADATA_CONTROL_PATTERN.test(value)
	) {
		throw new TypeError(`${field} must be non-empty bounded metadata without control characters`);
	}
	if (CREDENTIAL_SHAPE_PATTERN.test(value)) {
		throw new TypeError(`${field} must not contain credential-shaped metadata`);
	}
}

function assertContentText(value: unknown, field: string, maxLength: number): asserts value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength ||
		CONTENT_CONTROL_PATTERN.test(value)
	) {
		throw new TypeError(`${field} must be non-empty bounded text without unsafe control characters`);
	}
	if (CREDENTIAL_SHAPE_PATTERN.test(value)) {
		throw new TypeError(`${field} must not contain credential-shaped content`);
	}
}

function assertSha256(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw new TypeError(`${field} must be a lowercase 64-hex SHA-256 digest`);
	}
}

function assertCanonicalTimestamp(value: unknown): asserts value is string {
	assertMetadataText(value, "createdAt");
	if (!CANONICAL_TIMESTAMP_PATTERN.test(value)) {
		throw new TypeError("createdAt must be a canonical UTC ISO-8601 timestamp");
	}
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
		throw new TypeError("createdAt must be a canonical UTC ISO-8601 timestamp");
	}
}

function copyFileIdentity(value: unknown): SessionFileIdentity | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new TypeError("fileIdentity must be an object");
	assertOnlyKeys(value, ["dev", "ino"], "fileIdentity");
	for (const field of ["dev", "ino"] as const) {
		const part = value[field];
		if (
			typeof part !== "string" ||
			part.length === 0 ||
			part.length > MAX_FILE_IDENTITY_LENGTH ||
			!DECIMAL_STRING_PATTERN.test(part)
		) {
			throw new TypeError(`fileIdentity.${field} must be a bounded decimal string`);
		}
	}
	return Object.freeze({ dev: value.dev as string, ino: value.ino as string });
}

function copyIdArray(value: unknown, field: string, maxItems: number): readonly string[] {
	if (!Array.isArray(value) || value.length > maxItems) {
		throw new TypeError(`${field} must be a bounded array`);
	}
	const copy = value.map((item, index) => {
		assertMetadataText(item, `${field}[${index}]`);
		return item;
	});
	if (new Set(copy).size !== copy.length) throw new TypeError(`${field} must contain unique IDs`);
	return Object.freeze(copy);
}

function assertProvenanceText(value: unknown, field: string, maxLength: number): asserts value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength ||
		CONTENT_CONTROL_PATTERN.test(value)
	) {
		throw new TypeError(`${field} must be non-empty bounded text without unsafe control characters`);
	}
	if (CREDENTIAL_SHAPE_PATTERN.test(value)) {
		throw new TypeError(`${field} must not contain credential-shaped content`);
	}
}

function assertNullableMetadataText(
	value: unknown,
	field: string,
	maxLength = MAX_METADATA_LENGTH,
): asserts value is string | null {
	if (value === null) return;
	assertMetadataText(value, field, maxLength);
}

function copyTextArray(
	value: unknown,
	field: string,
	maxItems: number,
	maxLength: number,
	requireUnique: boolean,
): readonly string[] {
	if (!Array.isArray(value) || value.length > maxItems) {
		throw new TypeError(`${field} must be a bounded array`);
	}
	const copy = value.map((item, index) => {
		assertProvenanceText(item, `${field}[${index}]`, maxLength);
		return item;
	});
	if (requireUnique && new Set(copy).size !== copy.length) {
		throw new TypeError(`${field} must contain unique entries`);
	}
	return Object.freeze(copy);
}

function copyModelHistory(value: unknown): readonly CompactionModelHistoryEntry[] {
	if (!Array.isArray(value) || value.length > MAX_MODEL_HISTORY_ENTRIES) {
		throw new TypeError("preserved.modelHistory must be a bounded array");
	}
	const seenEntryIds = new Set<string>();
	const copy = value.map((item, index) => {
		if (!isRecord(item)) throw new TypeError(`preserved.modelHistory[${index}] must be an object`);
		assertOnlyKeys(item, ["entryId", "provider", "modelId"], `preserved.modelHistory[${index}]`);
		assertMetadataText(item.entryId, `preserved.modelHistory[${index}].entryId`);
		assertMetadataText(item.provider, `preserved.modelHistory[${index}].provider`);
		assertMetadataText(item.modelId, `preserved.modelHistory[${index}].modelId`);
		const entryId = item.entryId as string;
		if (seenEntryIds.has(entryId)) throw new TypeError("preserved.modelHistory must contain unique entryId values");
		seenEntryIds.add(entryId);
		return Object.freeze({ entryId, provider: item.provider as string, modelId: item.modelId as string });
	});
	return Object.freeze(copy);
}

function copyPreservedProvenance(input: unknown): CompactionPreservedProvenance {
	if (!isRecord(input)) throw new TypeError("preserved must be an object");
	assertOnlyKeys(
		input,
		[
			"latestIntent",
			"openTasks",
			"laneIds",
			"acceptancePredicateIds",
			"evidenceReceiptIds",
			"blockerReasons",
			"repairEventIds",
			"branch",
			"worktree",
			"modelHistory",
			"nextAction",
		],
		"preserved",
	);
	assertProvenanceText(input.latestIntent, "preserved.latestIntent", MAX_LATEST_INTENT_LENGTH);
	const openTasks = copyTextArray(
		input.openTasks,
		"preserved.openTasks",
		MAX_PROVENANCE_IDS,
		MAX_PROVENANCE_TEXT_LENGTH,
		false,
	);
	const laneIds = copyTextArray(input.laneIds, "preserved.laneIds", MAX_PROVENANCE_IDS, MAX_METADATA_LENGTH, true);
	const acceptancePredicateIds = copyTextArray(
		input.acceptancePredicateIds,
		"preserved.acceptancePredicateIds",
		MAX_PROVENANCE_IDS,
		MAX_METADATA_LENGTH,
		true,
	);
	const evidenceReceiptIds = copyTextArray(
		input.evidenceReceiptIds,
		"preserved.evidenceReceiptIds",
		MAX_PROVENANCE_IDS,
		MAX_METADATA_LENGTH,
		true,
	);
	const blockerReasons = copyTextArray(
		input.blockerReasons,
		"preserved.blockerReasons",
		MAX_PROVENANCE_IDS,
		MAX_PROVENANCE_TEXT_LENGTH,
		false,
	);
	const repairEventIds = copyTextArray(
		input.repairEventIds,
		"preserved.repairEventIds",
		MAX_PROVENANCE_IDS,
		MAX_METADATA_LENGTH,
		true,
	);
	assertNullableMetadataText(input.branch, "preserved.branch", MAX_PROVENANCE_TEXT_LENGTH);
	assertNullableMetadataText(input.worktree, "preserved.worktree", MAX_PROVENANCE_TEXT_LENGTH);
	const modelHistory = copyModelHistory(input.modelHistory);
	assertProvenanceText(input.nextAction, "preserved.nextAction", MAX_NEXT_ACTION_LENGTH);
	return Object.freeze({
		latestIntent: input.latestIntent,
		openTasks,
		laneIds,
		acceptancePredicateIds,
		evidenceReceiptIds,
		blockerReasons,
		repairEventIds,
		branch: input.branch,
		worktree: input.worktree,
		modelHistory,
		nextAction: input.nextAction,
	});
}

export function createSessionRevisionToken(input: unknown): SessionRevisionToken {
	if (!isRecord(input)) throw new TypeError("session revision token must be an object");
	assertOnlyKeys(
		input,
		[
			"schemaVersion",
			"sessionId",
			"completeBytes",
			"recordCount",
			"leafId",
			"lastEntryId",
			"completePrefixSha256",
			"fileIdentity",
		],
		"session revision token",
	);
	if (input.schemaVersion !== undefined && input.schemaVersion !== SESSION_REVISION_TOKEN_SCHEMA_VERSION) {
		throw new TypeError("unsupported session revision token schema version");
	}
	assertMetadataText(input.sessionId, "sessionId");
	assertSafeInteger(input.completeBytes, "completeBytes");
	assertSafeInteger(input.recordCount, "recordCount");
	if (input.leafId !== null) assertMetadataText(input.leafId, "leafId");
	if (input.lastEntryId !== null) assertMetadataText(input.lastEntryId, "lastEntryId");
	assertSha256(input.completePrefixSha256, "completePrefixSha256");

	if ((input.completeBytes === 0) !== (input.recordCount === 0)) {
		throw new TypeError("completeBytes and recordCount must both be empty or both be non-empty");
	}
	if (input.recordCount === 0 && (input.leafId !== null || input.lastEntryId !== null)) {
		throw new TypeError("an empty revision cannot identify entries");
	}
	if (input.leafId !== null && input.lastEntryId === null) {
		throw new TypeError("leafId requires a lastEntryId");
	}
	if (input.completeBytes === 0 && input.completePrefixSha256 !== EMPTY_SHA256) {
		throw new TypeError("an empty revision must use the SHA-256 digest of empty bytes");
	}

	const fileIdentity = copyFileIdentity(input.fileIdentity);
	return Object.freeze({
		schemaVersion: SESSION_REVISION_TOKEN_SCHEMA_VERSION,
		sessionId: input.sessionId,
		completeBytes: input.completeBytes,
		recordCount: input.recordCount,
		leafId: input.leafId,
		lastEntryId: input.lastEntryId,
		completePrefixSha256: input.completePrefixSha256,
		...(fileIdentity === undefined ? {} : { fileIdentity }),
	});
}

export function createCompactionSourceIdentity(input: unknown): CompactionSourceIdentity {
	if (!isRecord(input)) throw new TypeError("compaction source identity must be an object");
	assertOnlyKeys(
		input,
		["sessionId", "entryIds", "firstEntryId", "lastEntryId", "sourceSha256", "activeLeafId", "messageCount"],
		"compaction source identity",
	);
	assertMetadataText(input.sessionId, "source.sessionId");
	const entryIds = copyIdArray(input.entryIds, "source.entryIds", MAX_SOURCE_ENTRIES);
	if (entryIds.length === 0) throw new TypeError("source.entryIds must be non-empty");
	assertMetadataText(input.firstEntryId, "source.firstEntryId");
	assertMetadataText(input.lastEntryId, "source.lastEntryId");
	assertMetadataText(input.activeLeafId, "source.activeLeafId");
	assertSha256(input.sourceSha256, "source.sourceSha256");
	assertSafeInteger(input.messageCount, "source.messageCount");
	if (input.messageCount > entryIds.length) {
		throw new TypeError("source.messageCount cannot exceed source.entryIds length");
	}
	if (input.firstEntryId !== entryIds[0] || input.lastEntryId !== entryIds.at(-1)) {
		throw new TypeError("source first/last IDs must match the ordered entry IDs");
	}
	// R30 P2: active leaf must be the last entry in the source range
	if (input.activeLeafId !== input.lastEntryId) {
		throw new TypeError("source.activeLeafId must match source.lastEntryId");
	}
	return Object.freeze({
		sessionId: input.sessionId,
		entryIds,
		firstEntryId: input.firstEntryId,
		lastEntryId: input.lastEntryId,
		sourceSha256: input.sourceSha256,
		activeLeafId: input.activeLeafId,
		messageCount: input.messageCount,
	});
}

function copyModelIdentity(value: unknown): CompactionModelIdentity {
	if (!isRecord(value)) throw new TypeError("model must be an object");
	assertOnlyKeys(value, ["provider", "id"], "model");
	assertMetadataText(value.provider, "model.provider");
	assertMetadataText(value.id, "model.id");
	return Object.freeze({ provider: value.provider, id: value.id });
}

export function createCompactionTransaction(input: CompactionTransactionInput): CompactionTransaction {
	if (!isRecord(input)) throw new TypeError("compaction transaction must be an object");
	assertOnlyKeys(
		input,
		["schemaVersion", "transactionId", "baseRevision", "source", "createdAt", "model", "preserved"],
		"compaction transaction",
	);
	if (input.schemaVersion !== undefined && input.schemaVersion !== COMPACTION_TRANSACTION_SCHEMA_VERSION) {
		throw new TypeError("unsupported compaction transaction schema version");
	}
	assertMetadataText(input.transactionId, "transactionId");
	assertCanonicalTimestamp(input.createdAt);
	const baseRevision = createSessionRevisionToken(input.baseRevision);
	const source = createCompactionSourceIdentity(input.source);
	if (baseRevision.sessionId !== source.sessionId || baseRevision.leafId !== source.activeLeafId) {
		throw new TypeError("transaction revision and source must identify the same session and active leaf");
	}
	const model = copyModelIdentity(input.model);
	const preserved = copyPreservedProvenance(input.preserved);
	return Object.freeze({
		schemaVersion: COMPACTION_TRANSACTION_SCHEMA_VERSION,
		transactionId: input.transactionId,
		baseRevision,
		source,
		createdAt: input.createdAt,
		model,
		preserved,
	});
}

const KNOWN_FINDING_REASONS = new Set<SessionIntegrityReasonCode>([
	"trailing_fragment",
	"invalid_utf8",
	"malformed_json",
	"missing_header",
	"invalid_header",
	"unsupported_header",
	"multiple_header",
	"late_header",
	"invalid_entry",
	"unsupported_entry",
	"duplicate_entry_id",
	"missing_parent",
	"self_cycle",
	"parent_cycle",
	"active_leaf_missing",
	"compaction_first_kept_not_ancestor",
	"active_branch_context_invalid",
	"transcript_missing_result",
	"transcript_duplicate_result",
	"transcript_orphan_result",
	"transcript_duplicate_call_id",
	"transcript_interleaved_non_result",
]);
const TRANSCRIPT_FINDING_REASONS = new Set<SessionIntegrityReasonCode>([
	"transcript_missing_result",
	"transcript_duplicate_result",
	"transcript_orphan_result",
	"transcript_duplicate_call_id",
	"transcript_interleaved_non_result",
]);
const HEADER_FINDING_REASONS = new Set<SessionIntegrityReasonCode>([
	"missing_header",
	"invalid_header",
	"unsupported_header",
	"multiple_header",
	"late_header",
]);
const TRANSCRIPT_ISSUE_KINDS = new Set<string>([
	"missing_result",
	"duplicate_result",
	"orphan_result",
	"duplicate_call_id",
	"interleaved_non_result",
]);

function messageToolCalls(message: SessionIntegrityReport["activeMessages"][number]): readonly {
	readonly id: string;
	readonly name: string;
}[] {
	if (message.role !== "assistant") return [];
	return message.content.flatMap((block) => (block.type === "toolCall" ? [{ id: block.id, name: block.name }] : []));
}

function transcriptFindingReason(issue: TranscriptIntegrityIssue): SessionIntegrityReasonCode {
	switch (issue.kind) {
		case "missing_result":
			return "transcript_missing_result";
		case "duplicate_result":
			return "transcript_duplicate_result";
		case "orphan_result":
			return "transcript_orphan_result";
		case "duplicate_call_id":
			return "transcript_duplicate_call_id";
		case "interleaved_non_result":
			return "transcript_interleaved_non_result";
	}
}

function issueIdentity(issue: {
	readonly kind: string;
	readonly toolCallId: string;
	readonly toolName?: string;
}): string {
	return JSON.stringify([issue.kind, issue.toolCallId, issue.toolName ?? null]);
}

function findingIdentity(finding: SessionIntegrityFinding): string {
	return JSON.stringify([
		finding.reason,
		finding.line ?? null,
		finding.entryId ?? null,
		finding.parentId ?? null,
		finding.cycleEntryIds ?? null,
		finding.toolCallId ?? null,
		finding.toolName ?? null,
	]);
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const counts = new Map<string, number>();
	for (const item of left) counts.set(item, (counts.get(item) ?? 0) + 1);
	for (const item of right) {
		const count = counts.get(item);
		if (count === undefined) return false;
		if (count === 1) counts.delete(item);
		else counts.set(item, count - 1);
	}
	return counts.size === 0;
}

function validByteDigest(value: unknown, completePrefix: boolean): boolean {
	if (!isRecord(value)) return false;
	const keys = completePrefix ? ["byteCount", "sha256", "lineCount"] : ["byteCount", "sha256"];
	if (Object.keys(value).some((key) => !keys.includes(key))) return false;
	if (!Number.isSafeInteger(value.byteCount) || (value.byteCount as number) < 0) return false;
	if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) return false;
	if (!completePrefix) return true;
	return Number.isSafeInteger(value.lineCount) && (value.lineCount as number) >= 0;
}

function validFinding(value: unknown): value is SessionIntegrityFinding {
	if (!isRecord(value) || typeof value.reason !== "string") return false;
	if (!KNOWN_FINDING_REASONS.has(value.reason as SessionIntegrityReasonCode)) return false;
	const allowed = ["reason", "line", "entryId", "parentId", "cycleEntryIds", "toolCallId", "toolName"];
	if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
	if (value.line !== undefined && (!Number.isSafeInteger(value.line) || (value.line as number) < 1)) return false;
	for (const field of ["entryId", "parentId", "toolCallId", "toolName"] as const) {
		if (value[field] !== undefined && typeof value[field] !== "string") return false;
	}
	return (
		value.cycleEntryIds === undefined ||
		(Array.isArray(value.cycleEntryIds) && value.cycleEntryIds.every((item) => typeof item === "string"))
	);
}

function validTranscriptIssue(value: unknown): value is TranscriptIntegrityIssue {
	if (!isRecord(value) || !TRANSCRIPT_ISSUE_KINDS.has(value.kind as string)) return false;
	if (typeof value.toolCallId !== "string" || value.toolCallId.length === 0) return false;
	if (value.toolName !== undefined && typeof value.toolName !== "string") return false;
	return Object.keys(value).every((key) => ["kind", "toolCallId", "toolName"].includes(key));
}

function activeBranchIsConsistent(report: SessionIntegrityReport): boolean {
	if (!Array.isArray(report.entries) || !Array.isArray(report.activeBranch) || !Array.isArray(report.activeMessages)) {
		return false;
	}
	const entryIds = new Set<string>();
	for (const entry of report.entries) {
		if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) return false;
		entryIds.add(entry.id);
	}
	if (report.activeLeafId === null) return report.activeBranch.length === 0;
	if (typeof report.activeLeafId !== "string" || report.activeBranch.length === 0) return false;
	const branchIds = new Set<string>();
	for (let index = 0; index < report.activeBranch.length; index++) {
		const entry = report.activeBranch[index];
		if (!isRecord(entry) || typeof entry.id !== "string" || branchIds.has(entry.id) || !entryIds.has(entry.id)) {
			return false;
		}
		branchIds.add(entry.id);
		const expectedParent = index === 0 ? null : report.activeBranch[index - 1]?.id;
		if (entry.parentId !== expectedParent) return false;
	}
	return report.activeBranch.at(-1)?.id === report.activeLeafId;
}

function reportIsConsistent(report: SessionIntegrityReport): boolean {
	if (!isRecord(report)) return false;
	if (!validByteDigest(report.source, false) || !validByteDigest(report.completePrefix, true)) return false;
	if (report.trailingFragment !== null && !validByteDigest(report.trailingFragment, false)) return false;
	const trailingBytes = report.trailingFragment?.byteCount ?? 0;
	if (report.source.byteCount !== report.completePrefix.byteCount + trailingBytes) return false;
	if (report.completePrefix.lineCount > report.completePrefix.byteCount) return false;
	if (report.completePrefix.byteCount === 0 && report.completePrefix.sha256 !== EMPTY_SHA256) return false;
	if (report.trailingFragment === null && report.source.sha256 !== report.completePrefix.sha256) return false;
	if (!Array.isArray(report.findings) || !report.findings.every(validFinding)) return false;
	if (typeof report.ok !== "boolean" || report.ok !== (report.findings.length === 0)) return false;

	const trailingFindings = report.findings.filter((finding) => finding.reason === "trailing_fragment");
	if (
		trailingFindings.length !== (report.trailingFragment === null ? 0 : 1) ||
		trailingFindings.some((finding) => Object.keys(finding).length !== 1)
	) {
		return false;
	}
	if (report.header === null) {
		if (!report.findings.some((finding) => HEADER_FINDING_REASONS.has(finding.reason))) return false;
	} else if (!isRecord(report.header) || typeof report.header.id !== "string" || report.header.id.length === 0) {
		return false;
	}
	if (!activeBranchIsConsistent(report)) return false;

	const transcriptFindings = report.findings.filter((finding) => TRANSCRIPT_FINDING_REASONS.has(finding.reason));
	if (report.transcript === null) {
		// R30 P1-2: null transcript can never produce ready.
		// A producer-consistent null transcript requires activeMessages to be empty
		// and a structural finding to explain why no transcript was produced.
		if (report.activeMessages.length > 0) return false;
		if (transcriptFindings.length !== 0) return false;
		const hasStructuralFinding = report.findings.some(
			(finding) => finding.reason !== "trailing_fragment" && !TRANSCRIPT_FINDING_REASONS.has(finding.reason),
		);
		return hasStructuralFinding;
	}
	if (!isRecord(report.transcript) || !Array.isArray(report.transcript.issues)) return false;
	if (!report.transcript.issues.every(validTranscriptIssue)) return false;
	if (report.transcript.ok !== (report.transcript.issues.length === 0)) return false;
	if (
		report.findings.some(
			(finding) => finding.reason !== "trailing_fragment" && !TRANSCRIPT_FINDING_REASONS.has(finding.reason),
		)
	) {
		return false;
	}

	let inspected: TranscriptIntegrityReport;
	try {
		inspected = inspectTranscriptIntegrity(report.activeMessages);
	} catch {
		return false;
	}
	if (
		inspected.ok !== report.transcript.ok ||
		!sameMultiset(inspected.issues.map(issueIdentity), report.transcript.issues.map(issueIdentity))
	) {
		return false;
	}
	return sameMultiset(
		transcriptFindings.map(findingIdentity),
		inspected.issues.map((issue) =>
			JSON.stringify([
				transcriptFindingReason(issue),
				null,
				null,
				null,
				null,
				issue.toolCallId,
				issue.toolName ?? null,
			]),
		),
	);
}

function missingCallsAreAtActiveTail(report: SessionIntegrityReport, missingIds: ReadonlySet<string>): boolean {
	let lastAssistantIndex = -1;
	for (let index = report.activeMessages.length - 1; index >= 0; index--) {
		if (report.activeMessages[index]?.role === "assistant") {
			lastAssistantIndex = index;
			break;
		}
	}
	if (lastAssistantIndex === -1) return false;
	const assistant = report.activeMessages[lastAssistantIndex];
	if (!assistant || assistant.role !== "assistant") return false;
	const tailCallIds = new Set(messageToolCalls(assistant).map((call) => call.id));
	if ([...missingIds].some((id) => !tailCallIds.has(id))) return false;
	for (let index = lastAssistantIndex + 1; index < report.activeMessages.length; index++) {
		const message = report.activeMessages[index];
		if (!message || message.role !== "toolResult" || !tailCallIds.has(message.toolCallId)) return false;
	}
	return true;
}

function barrierResult(
	status: CompactionBarrierStatus,
	reason: CompactionBarrierReason,
	pendingToolCallIds: readonly string[],
	missingToolCallIds: readonly string[] = [],
): CompactionBarrierResult {
	return Object.freeze({
		status,
		reason,
		pendingToolCallIds: Object.freeze([...pendingToolCallIds]),
		missingToolCallIds: Object.freeze([...missingToolCallIds]),
	});
}

/** Derive a closed-turn compaction barrier without repairing or mutating the report. */
export function evaluateCompactionBarrier(
	report: SessionIntegrityReport,
	pendingToolCallIds: readonly string[],
): CompactionBarrierResult {
	let pending: readonly string[];
	try {
		pending = copyIdArray(pendingToolCallIds, "pendingToolCallIds", MAX_PROVENANCE_IDS);
	} catch {
		return barrierResult("fail_closed", "invalid_pending_tool_ids", []);
	}
	if (!reportIsConsistent(report)) {
		return barrierResult("fail_closed", "inconsistent_integrity_report", pending);
	}
	const blockingFinding = report.findings.find((finding) => finding.reason !== "transcript_missing_result");
	const blockingIssue = report.transcript?.issues.find((issue) => issue.kind !== "missing_result");
	if (blockingFinding || blockingIssue) {
		return barrierResult("fail_closed", "structural_integrity_failure", pending);
	}

	const missing = Object.freeze(
		(report.transcript?.issues ?? [])
			.filter((issue) => issue.kind === "missing_result")
			.map((issue) => issue.toolCallId),
	);
	const missingSet = new Set(missing);
	const pendingSet = new Set(pending);
	if (
		missing.length > 0 &&
		(!missingCallsAreAtActiveTail(report, missingSet) || missing.some((toolCallId) => !pendingSet.has(toolCallId)))
	) {
		return barrierResult("fail_closed", "unsafe_missing_tool_results", pending, missing);
	}
	if (missing.length > 0) return barrierResult("defer", "missing_active_tail_results", pending, missing);
	if (pending.length > 0) return barrierResult("defer", "pending_tool_calls", pending);
	return barrierResult("ready", "closed_active_branch", []);
}

function sameRevision(left: SessionRevisionToken, right: SessionRevisionToken): boolean {
	return (
		left.schemaVersion === right.schemaVersion &&
		left.sessionId === right.sessionId &&
		left.completeBytes === right.completeBytes &&
		left.recordCount === right.recordCount &&
		left.leafId === right.leafId &&
		left.lastEntryId === right.lastEntryId &&
		left.completePrefixSha256 === right.completePrefixSha256 &&
		left.fileIdentity?.dev === right.fileIdentity?.dev &&
		left.fileIdentity?.ino === right.fileIdentity?.ino
	);
}

function sameSource(left: CompactionSourceIdentity, right: CompactionSourceIdentity): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.firstEntryId === right.firstEntryId &&
		left.lastEntryId === right.lastEntryId &&
		left.sourceSha256 === right.sourceSha256 &&
		left.activeLeafId === right.activeLeafId &&
		left.messageCount === right.messageCount &&
		left.entryIds.length === right.entryIds.length &&
		left.entryIds.every((id, index) => id === right.entryIds[index])
	);
}

function validBarrierResult(barrier: CompactionBarrierResult): boolean {
	if (!isRecord(barrier) || !Array.isArray(barrier.pendingToolCallIds) || !Array.isArray(barrier.missingToolCallIds)) {
		return false;
	}
	const pending = barrier.pendingToolCallIds;
	const missing = barrier.missingToolCallIds;
	// R30 P1-3: validate all IDs are bounded, unique, safe metadata text
	try {
		for (const ids of [pending, missing]) {
			if (ids.length > MAX_PROVENANCE_IDS) return false;
			if (new Set(ids).size !== ids.length) return false;
			for (const id of ids) assertMetadataText(id, "barrier toolCallId");
		}
	} catch {
		return false;
	}
	switch (barrier.status) {
		case "ready":
			return barrier.reason === "closed_active_branch" && pending.length === 0 && missing.length === 0;
		case "defer":
			if (barrier.reason === "pending_tool_calls") {
				return pending.length > 0 && missing.length === 0;
			}
			if (barrier.reason === "missing_active_tail_results") {
				return missing.length > 0 && missing.every((id) => pending.includes(id));
			}
			return false;
		case "fail_closed":
			return (
				barrier.reason === "invalid_pending_tool_ids" ||
				barrier.reason === "inconsistent_integrity_report" ||
				barrier.reason === "structural_integrity_failure" ||
				barrier.reason === "unsafe_missing_tool_results"
			);
		default:
			return false;
	}
}

/**
 * Authorize an in-memory commit attempt. A "commit" decision is not evidence of
 * durable persistence; the integration layer must still perform its own atomic CAS write.
 */
export function decideCompactionCommit(input: DecideCompactionCommitInput): CompactionCommitDecision {
	let transaction: CompactionTransaction;
	try {
		transaction = createCompactionTransaction(input.transaction);
	} catch {
		return Object.freeze({ decision: "fail_closed", reason: "invalid_transaction" });
	}
	if (!validBarrierResult(input.barrier)) {
		return Object.freeze({
			decision: "fail_closed",
			reason: "invalid_commit_input",
			transactionId: transaction.transactionId,
		});
	}
	if (input.barrier.status === "fail_closed") {
		return Object.freeze({
			decision: "fail_closed",
			reason: "barrier_fail_closed",
			transactionId: transaction.transactionId,
			barrierReason: input.barrier.reason,
		});
	}
	if (input.barrier.status === "defer") {
		return Object.freeze({
			decision: "defer",
			reason: "barrier_defer",
			transactionId: transaction.transactionId,
			barrierReason: input.barrier.reason,
		});
	}

	let currentRevision: SessionRevisionToken;
	let currentSource: CompactionSourceIdentity;
	let priorDigests: readonly string[];
	try {
		currentRevision = createSessionRevisionToken(input.currentRevision);
		currentSource = createCompactionSourceIdentity(input.currentSource);
		if (
			!Array.isArray(input.priorCommittedSourceDigests) ||
			input.priorCommittedSourceDigests.length > MAX_SOURCE_ENTRIES
		) {
			throw new TypeError("priorCommittedSourceDigests must be a bounded array");
		}
		priorDigests = input.priorCommittedSourceDigests.map((digest, index) => {
			assertSha256(digest, `priorCommittedSourceDigests[${index}]`);
			return digest;
		});
	} catch {
		return Object.freeze({
			decision: "fail_closed",
			reason: "invalid_commit_input",
			transactionId: transaction.transactionId,
		});
	}

	if (priorDigests.includes(transaction.source.sourceSha256)) {
		return Object.freeze({
			decision: "duplicate",
			reason: "source_already_committed",
			transactionId: transaction.transactionId,
		});
	}
	if (!sameRevision(transaction.baseRevision, currentRevision)) {
		return Object.freeze({
			decision: "stale",
			reason: "revision_mismatch",
			transactionId: transaction.transactionId,
		});
	}
	if (!sameSource(transaction.source, currentSource)) {
		return Object.freeze({
			decision: "stale",
			reason: "source_mismatch",
			transactionId: transaction.transactionId,
		});
	}
	return Object.freeze({
		decision: "commit",
		reason: "exact_match",
		transactionId: transaction.transactionId,
		revision: currentRevision,
		source: currentSource,
	});
}

const COMPACTION_ENVELOPE_KEYS = [
	"schemaVersion",
	"transactionId",
	"baseRevision",
	"source",
	"createdAt",
	"model",
	"summary",
	"summarySha256",
	"preserved",
] as const;

/** Parse and deep-freeze a persisted schema-v2 compaction envelope. */
export function validateCompactionEnvelope(input: unknown): CompactionEnvelope {
	if (!isRecord(input)) throw new TypeError("compaction envelope must be an object");
	assertOnlyKeys(input, COMPACTION_ENVELOPE_KEYS, "compaction envelope");
	if (input.schemaVersion !== COMPACTION_ENVELOPE_SCHEMA_VERSION) {
		throw new TypeError("unsupported compaction envelope schema version");
	}
	assertMetadataText(input.transactionId, "transactionId");
	assertCanonicalTimestamp(input.createdAt);
	assertContentText(input.summary, "summary", MAX_SUMMARY_LENGTH);
	assertSha256(input.summarySha256, "summarySha256");
	const baseRevision = createSessionRevisionToken(input.baseRevision);
	const source = createCompactionSourceIdentity(input.source);
	if (baseRevision.sessionId !== source.sessionId || baseRevision.leafId !== source.activeLeafId) {
		throw new TypeError("envelope revision and source must identify the same session and active leaf");
	}
	return Object.freeze({
		schemaVersion: COMPACTION_ENVELOPE_SCHEMA_VERSION,
		transactionId: input.transactionId,
		baseRevision,
		source,
		createdAt: input.createdAt,
		model: copyModelIdentity(input.model),
		summary: input.summary,
		summarySha256: input.summarySha256,
		preserved: copyPreservedProvenance(input.preserved),
	});
}

/** Create provenance-bearing summary data only from an exact commit authorization. */
export function createCompactionEnvelope(input: CreateCompactionEnvelopeInput): CompactionEnvelope {
	if (!isRecord(input)) throw new TypeError("compaction envelope input must be an object");
	assertOnlyKeys(input, ["transaction", "decision", "summary", "summarySha256"], "compaction envelope input");
	assertContentText(input.summary, "summary", MAX_SUMMARY_LENGTH);
	assertSha256(input.summarySha256, "summarySha256");
	if (input.decision.decision !== "commit" || input.decision.reason !== "exact_match") {
		throw new TypeError("a commit decision is required to create a compaction envelope");
	}
	const transaction = createCompactionTransaction(input.transaction);
	const decisionRevision = createSessionRevisionToken(input.decision.revision);
	const decisionSource = createCompactionSourceIdentity(input.decision.source);
	if (
		input.decision.transactionId !== transaction.transactionId ||
		!sameRevision(transaction.baseRevision, decisionRevision) ||
		!sameSource(transaction.source, decisionSource)
	) {
		throw new TypeError("commit decision does not match the compaction transaction");
	}

	return validateCompactionEnvelope({
		schemaVersion: COMPACTION_ENVELOPE_SCHEMA_VERSION,
		transactionId: transaction.transactionId,
		baseRevision: transaction.baseRevision,
		source: transaction.source,
		createdAt: transaction.createdAt,
		model: transaction.model,
		summary: input.summary,
		summarySha256: input.summarySha256,
		preserved: transaction.preserved,
	});
}
