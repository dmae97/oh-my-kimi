import {
	type AgentMessage,
	createSyntheticToolResult,
	inspectTranscriptIntegrity,
	type TranscriptIntegrityIssueKind,
} from "omk-agent-core";
import type { ToolCall, ToolResultMessage } from "omk-ai";
import type {
	SessionByteDigest,
	SessionCompletePrefix,
	SessionIntegrityFinding,
	SessionIntegrityReasonCode,
	SessionIntegrityReport,
} from "./session-integrity.ts";

export const SESSION_REPAIR_PLAN_SCHEMA_VERSION = 1 as const;

export type SessionRepairReason = "resume_recovery" | "doctor_repair";
export type SessionRepairPlanStatus = "not_needed" | "repairable" | "blocked";
export type SessionRepairBlockerReason =
	| "integrity_finding"
	| "inspection_incomplete"
	| "ambiguous_transcript"
	| "inconsistent_report";

export interface CreateSessionRepairPlanOptions {
	readonly repairId: string;
	readonly reason: SessionRepairReason;
	/** Deterministic caller-provided epoch milliseconds for synthetic messages. */
	readonly timestamp: number;
}

export interface SessionRepairPrecondition {
	readonly source: SessionByteDigest;
	readonly completePrefix: SessionCompletePrefix;
	readonly activeLeafId: string | null;
}

export interface SessionRepairBlocker {
	readonly reason: SessionRepairBlockerReason;
	readonly findingReason?: SessionIntegrityReasonCode;
	readonly entryId?: string;
	readonly toolCallId?: string;
}

export type SessionRepairAction =
	| {
			readonly kind: "quarantine_trailing_fragment";
			readonly fragment: SessionByteDigest;
			readonly retainPrefix: SessionCompletePrefix;
	  }
	| {
			readonly kind: "append_synthetic_tool_result";
			readonly sequence: number;
			readonly toolCallId: string;
			readonly toolName: string;
			readonly message: Readonly<ToolResultMessage>;
	  };

export interface SessionRepairPlan {
	readonly schemaVersion: typeof SESSION_REPAIR_PLAN_SCHEMA_VERSION;
	readonly repairId: string;
	readonly reason: SessionRepairReason;
	readonly status: SessionRepairPlanStatus;
	readonly precondition: SessionRepairPrecondition;
	readonly actions: readonly SessionRepairAction[];
	readonly blockers: readonly SessionRepairBlocker[];
}

const REPAIRABLE_FINDINGS = new Set<SessionIntegrityReasonCode>(["trailing_fragment", "transcript_missing_result"]);
const TRANSCRIPT_FINDING_REASONS = new Set<SessionIntegrityReasonCode>([
	"transcript_missing_result",
	"transcript_duplicate_result",
	"transcript_orphan_result",
	"transcript_duplicate_call_id",
	"transcript_interleaved_non_result",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isToolCall(value: unknown): value is ToolCall {
	return (
		isRecord(value) && value.type === "toolCall" && typeof value.id === "string" && typeof value.name === "string"
	);
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

function repairText(reason: SessionRepairReason): string {
	return reason === "resume_recovery"
		? "Tool result missing; synthesized during session resume recovery"
		: "Tool result missing; synthesized by session doctor repair";
}

function transcriptFindingReason(kind: TranscriptIntegrityIssueKind): SessionIntegrityReasonCode {
	return `transcript_${kind}`;
}

function sameIdentityMultiset(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const counts = new Map<string, number>();
	for (const key of left) counts.set(key, (counts.get(key) ?? 0) + 1);
	for (const key of right) {
		const count = counts.get(key);
		if (count === undefined) return false;
		if (count === 1) counts.delete(key);
		else counts.set(key, count - 1);
	}
	return counts.size === 0;
}

function reportIsConsistent(report: SessionIntegrityReport): boolean {
	if (report.ok !== (report.findings.length === 0)) return false;
	const trailingFindings = report.findings.filter((finding) => finding.reason === "trailing_fragment");
	if (
		trailingFindings.length !== (report.trailingFragment === null ? 0 : 1) ||
		trailingFindings.some((finding) => Object.keys(finding).length !== 1)
	) {
		return false;
	}

	const transcriptFindings = report.findings.filter((finding) => TRANSCRIPT_FINDING_REASONS.has(finding.reason));
	if (!report.transcript) return transcriptFindings.length === 0;
	if (
		report.findings.some(
			(finding) => finding.reason !== "trailing_fragment" && !TRANSCRIPT_FINDING_REASONS.has(finding.reason),
		)
	) {
		return false;
	}

	const inspected = inspectTranscriptIntegrity(report.activeMessages);
	if (
		report.transcript.ok !== inspected.ok ||
		report.transcript.ok !== (report.transcript.issues.length === 0) ||
		!sameIdentityMultiset(
			report.transcript.issues.map((issue) =>
				JSON.stringify([issue.kind, issue.toolCallId, issue.toolName ?? null]),
			),
			inspected.issues.map((issue) => JSON.stringify([issue.kind, issue.toolCallId, issue.toolName ?? null])),
		)
	) {
		return false;
	}

	return sameIdentityMultiset(
		transcriptFindings.map((finding) =>
			JSON.stringify([
				finding.reason,
				finding.line ?? null,
				finding.entryId ?? null,
				finding.parentId ?? null,
				finding.cycleEntryIds ?? null,
				finding.toolCallId ?? null,
				finding.toolName ?? null,
			]),
		),
		inspected.issues.map((issue) =>
			JSON.stringify([
				transcriptFindingReason(issue.kind),
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

function validateOptions(options: CreateSessionRepairPlanOptions): void {
	if (
		!isRecord(options) ||
		typeof options.repairId !== "string" ||
		options.repairId.length === 0 ||
		options.repairId.length > 128 ||
		/[\u0000-\u001f\u007f]/.test(options.repairId)
	) {
		throw new TypeError("repairId must be non-empty bounded text without C0 or DEL control characters");
	}
	if (options.reason !== "resume_recovery" && options.reason !== "doctor_repair") {
		throw new TypeError("reason must be resume_recovery or doctor_repair");
	}
	if (!Number.isSafeInteger(options.timestamp) || options.timestamp < 0) {
		throw new TypeError("timestamp must be a non-negative epoch-millisecond safe integer");
	}
}

function blockerForFinding(finding: SessionIntegrityFinding): SessionRepairBlocker {
	return Object.freeze({
		reason: "integrity_finding",
		findingReason: finding.reason,
		...(finding.entryId === undefined ? {} : { entryId: finding.entryId }),
		...(finding.toolCallId === undefined ? {} : { toolCallId: finding.toolCallId }),
	});
}

function missingTailCalls(report: SessionIntegrityReport): ToolCall[] | null {
	if (!report.transcript || report.transcript.issues.length === 0) return [];
	if (report.transcript.issues.some((issue) => issue.kind !== "missing_result")) return null;

	let lastAssistantIndex = -1;
	for (let index = report.activeMessages.length - 1; index >= 0; index--) {
		if (report.activeMessages[index]?.role === "assistant") {
			lastAssistantIndex = index;
			break;
		}
	}
	if (lastAssistantIndex === -1) return null;
	const assistant = report.activeMessages[lastAssistantIndex];
	if (!assistant || assistant.role !== "assistant") return null;
	const tailCalls = assistant.content.filter(isToolCall);
	const tailCallIds = new Set(tailCalls.map((call) => call.id));
	const missingIds = new Set(report.transcript.issues.map((issue) => issue.toolCallId));
	if ([...missingIds].some((id) => !tailCallIds.has(id))) return null;

	for (let index = lastAssistantIndex + 1; index < report.activeMessages.length; index++) {
		const message: AgentMessage | undefined = report.activeMessages[index];
		if (!message || message.role !== "toolResult" || !tailCallIds.has(message.toolCallId)) return null;
	}
	return tailCalls.filter((call) => missingIds.has(call.id));
}

function basePlan(
	report: SessionIntegrityReport,
	options: CreateSessionRepairPlanOptions,
	status: SessionRepairPlanStatus,
	actions: readonly SessionRepairAction[],
	blockers: readonly SessionRepairBlocker[],
): SessionRepairPlan {
	return Object.freeze({
		schemaVersion: SESSION_REPAIR_PLAN_SCHEMA_VERSION,
		repairId: options.repairId,
		reason: options.reason,
		status,
		precondition: Object.freeze({
			source: Object.freeze({ ...report.source }),
			completePrefix: Object.freeze({ ...report.completePrefix }),
			activeLeafId: report.activeLeafId,
		}),
		actions: Object.freeze(actions),
		blockers: Object.freeze(blockers),
	});
}

/**
 * Derive a deterministic repair plan without writing, truncating, quarantining,
 * or mutating the inspected session. Ambiguous integrity states fail closed.
 */
export function createSessionRepairPlan(
	report: SessionIntegrityReport,
	options: CreateSessionRepairPlanOptions,
): SessionRepairPlan {
	validateOptions(options);
	if (!reportIsConsistent(report)) {
		return basePlan(report, options, "blocked", [], [Object.freeze({ reason: "inconsistent_report" })]);
	}
	const blockers = report.findings
		.filter((finding) => !REPAIRABLE_FINDINGS.has(finding.reason))
		.map(blockerForFinding);
	if (blockers.length > 0) return basePlan(report, options, "blocked", [], blockers);
	if (!report.transcript) {
		return basePlan(report, options, "blocked", [], [Object.freeze({ reason: "inspection_incomplete" })]);
	}

	const missingFindings = report.findings.filter((finding) => finding.reason === "transcript_missing_result");
	const missingIssues = report.transcript.issues.filter((issue) => issue.kind === "missing_result");
	if (
		missingFindings.length !== missingIssues.length ||
		report.transcript.issues.some((issue) => issue.kind !== "missing_result")
	) {
		return basePlan(report, options, "blocked", [], [Object.freeze({ reason: "inconsistent_report" })]);
	}

	const missingCalls = missingTailCalls(report);
	if (missingCalls === null) {
		return basePlan(report, options, "blocked", [], [Object.freeze({ reason: "ambiguous_transcript" })]);
	}

	const actions: SessionRepairAction[] = [];
	if (report.trailingFragment) {
		actions.push(
			Object.freeze({
				kind: "quarantine_trailing_fragment",
				fragment: Object.freeze({ ...report.trailingFragment }),
				retainPrefix: Object.freeze({ ...report.completePrefix }),
			}),
		);
	}
	const text = repairText(options.reason);
	for (let index = 0; index < missingCalls.length; index++) {
		const call = missingCalls[index];
		actions.push(
			Object.freeze({
				kind: "append_synthetic_tool_result",
				sequence: index,
				toolCallId: call.id,
				toolName: call.name,
				message: deepFreeze(createSyntheticToolResult(call.id, call.name, text, options.timestamp)),
			}),
		);
	}

	return basePlan(report, options, actions.length === 0 ? "not_needed" : "repairable", actions, []);
}
