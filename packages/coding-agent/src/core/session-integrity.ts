import { createHash } from "node:crypto";
import {
	type AgentMessage,
	inspectTranscriptIntegrity,
	type TranscriptIntegrityIssueKind,
	type TranscriptIntegrityReport,
} from "omk-agent-core";
import {
	buildSessionContext,
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
} from "./session-manager.ts";

export type SessionIntegrityReasonCode =
	| "trailing_fragment"
	| "invalid_utf8"
	| "malformed_json"
	| "missing_header"
	| "invalid_header"
	| "unsupported_header"
	| "multiple_header"
	| "late_header"
	| "invalid_entry"
	| "unsupported_entry"
	| "duplicate_entry_id"
	| "missing_parent"
	| "self_cycle"
	| "parent_cycle"
	| "active_leaf_missing"
	| "compaction_first_kept_not_ancestor"
	| "active_branch_context_invalid"
	| "transcript_missing_result"
	| "transcript_duplicate_result"
	| "transcript_orphan_result"
	| "transcript_duplicate_call_id"
	| "transcript_interleaved_non_result";

export interface SessionIntegrityFinding {
	readonly reason: SessionIntegrityReasonCode;
	readonly line?: number;
	readonly entryId?: string;
	readonly parentId?: string;
	readonly cycleEntryIds?: readonly string[];
	readonly toolCallId?: string;
	readonly toolName?: string;
}

export interface SessionByteDigest {
	readonly byteCount: number;
	readonly sha256: string;
}

export interface SessionCompletePrefix extends SessionByteDigest {
	readonly lineCount: number;
}

export interface SessionIntegrityReport {
	readonly ok: boolean;
	readonly source: SessionByteDigest;
	readonly completePrefix: SessionCompletePrefix;
	readonly trailingFragment: SessionByteDigest | null;
	readonly header: Readonly<SessionHeader> | null;
	/** Valid session entries in their original complete-line order. */
	readonly entries: readonly Readonly<SessionEntry>[];
	readonly activeLeafId: string | null;
	readonly activeBranch: readonly Readonly<SessionEntry>[];
	readonly activeMessages: readonly AgentMessage[];
	readonly transcript: Readonly<TranscriptIntegrityReport> | null;
	readonly findings: readonly SessionIntegrityFinding[];
}

export interface InspectSessionIntegrityOptions {
	/** `undefined` selects the last complete entry; `null` selects the empty branch. */
	readonly activeLeafId?: string | null;
}

interface ParsedRecord {
	readonly line: number;
	readonly value: unknown;
}

interface ParsedEntry {
	readonly line: number;
	readonly entry: SessionEntry;
}

const SUPPORTED_ENTRY_TYPES = new Set([
	"message",
	"thinking_level_change",
	"model_change",
	"compaction",
	"branch_summary",
	"custom",
	"custom_message",
	"label",
	"session_info",
]);

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function finiteNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validEntryTimestamp(value: unknown): value is string {
	if (!nonEmptyString(value)) return false;
	const timestamp = new Date(value).getTime();
	return Number.isFinite(timestamp) && timestamp >= 0;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

function addFinding(findings: SessionIntegrityFinding[], finding: SessionIntegrityFinding): void {
	findings.push(Object.freeze(finding));
}

function validHeader(value: Record<string, unknown>, line: number, findings: SessionIntegrityFinding[]): boolean {
	if (value.version !== CURRENT_SESSION_VERSION) {
		addFinding(findings, { reason: "unsupported_header", line });
		return false;
	}
	if (
		!nonEmptyString(value.id) ||
		!nonEmptyString(value.timestamp) ||
		!nonEmptyString(value.cwd) ||
		(value.parentSession !== undefined && typeof value.parentSession !== "string")
	) {
		addFinding(findings, { reason: "invalid_header", line });
		return false;
	}
	return true;
}

function validTextContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.type === "text" &&
		typeof value.text === "string" &&
		(value.textSignature === undefined || typeof value.textSignature === "string")
	);
}

function validImageContent(value: unknown): boolean {
	return (
		isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string"
	);
}

function validThinkingContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.type === "thinking" &&
		typeof value.thinking === "string" &&
		(value.thinkingSignature === undefined || typeof value.thinkingSignature === "string") &&
		(value.redacted === undefined || typeof value.redacted === "boolean")
	);
}

function validToolCall(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.type === "toolCall" &&
		nonEmptyString(value.id) &&
		nonEmptyString(value.name) &&
		isRecord(value.arguments) &&
		(value.thoughtSignature === undefined || typeof value.thoughtSignature === "string")
	);
}

function validUserContent(value: unknown): boolean {
	return (
		typeof value === "string" ||
		(Array.isArray(value) && value.every((block) => validTextContent(block) || validImageContent(block)))
	);
}

function validUsage(value: unknown): boolean {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	const cost = value.cost;
	return (
		["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) =>
			finiteNonNegativeNumber(value[key]),
		) && ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => finiteNonNegativeNumber(cost[key]))
	);
}

function validDiagnostic(value: unknown): boolean {
	if (!isRecord(value) || typeof value.type !== "string" || !finiteNonNegativeNumber(value.timestamp)) return false;
	if (value.details !== undefined && !isRecord(value.details)) return false;
	if (value.error === undefined) return true;
	if (!isRecord(value.error) || typeof value.error.message !== "string") return false;
	return (
		(value.error.name === undefined || typeof value.error.name === "string") &&
		(value.error.stack === undefined || typeof value.error.stack === "string") &&
		(value.error.code === undefined || typeof value.error.code === "string" || typeof value.error.code === "number")
	);
}

function validAgentMessage(value: unknown): value is AgentMessage {
	if (!isRecord(value) || !finiteNonNegativeNumber(value.timestamp)) return false;
	switch (value.role) {
		case "user":
			return validUserContent(value.content);
		case "assistant":
			return (
				Array.isArray(value.content) &&
				value.content.every(
					(block) => validTextContent(block) || validThinkingContent(block) || validToolCall(block),
				) &&
				nonEmptyString(value.api) &&
				nonEmptyString(value.provider) &&
				nonEmptyString(value.model) &&
				(value.responseModel === undefined || typeof value.responseModel === "string") &&
				(value.responseId === undefined || typeof value.responseId === "string") &&
				(value.diagnostics === undefined ||
					(Array.isArray(value.diagnostics) && value.diagnostics.every(validDiagnostic))) &&
				validUsage(value.usage) &&
				(value.stopReason === "stop" ||
					value.stopReason === "length" ||
					value.stopReason === "toolUse" ||
					value.stopReason === "error" ||
					value.stopReason === "aborted") &&
				(value.errorMessage === undefined || typeof value.errorMessage === "string")
			);
		case "toolResult":
			return (
				nonEmptyString(value.toolCallId) &&
				nonEmptyString(value.toolName) &&
				Array.isArray(value.content) &&
				value.content.every((block) => validTextContent(block) || validImageContent(block)) &&
				typeof value.isError === "boolean"
			);
		case "bashExecution":
			return (
				typeof value.command === "string" &&
				typeof value.output === "string" &&
				(value.exitCode === undefined || finiteNonNegativeNumber(value.exitCode)) &&
				typeof value.cancelled === "boolean" &&
				typeof value.truncated === "boolean" &&
				(value.fullOutputPath === undefined || typeof value.fullOutputPath === "string") &&
				(value.excludeFromContext === undefined || typeof value.excludeFromContext === "boolean")
			);
		case "custom":
			return (
				nonEmptyString(value.customType) && validUserContent(value.content) && typeof value.display === "boolean"
			);
		case "branchSummary":
			return typeof value.summary === "string" && nonEmptyString(value.fromId);
		case "compactionSummary":
			return typeof value.summary === "string" && finiteNonNegativeNumber(value.tokensBefore);
		default:
			return false;
	}
}

function validEntryShape(value: Record<string, unknown>): value is Record<string, unknown> & SessionEntry {
	if (
		!nonEmptyString(value.type) ||
		!SUPPORTED_ENTRY_TYPES.has(value.type) ||
		!nonEmptyString(value.id) ||
		(value.parentId !== null && !nonEmptyString(value.parentId)) ||
		!validEntryTimestamp(value.timestamp)
	) {
		return false;
	}

	switch (value.type) {
		case "message":
			return validAgentMessage(value.message);
		case "thinking_level_change":
			return typeof value.thinkingLevel === "string";
		case "model_change":
			return nonEmptyString(value.provider) && nonEmptyString(value.modelId);
		case "compaction":
			return (
				typeof value.summary === "string" &&
				nonEmptyString(value.firstKeptEntryId) &&
				finiteNonNegativeNumber(value.tokensBefore)
			);
		case "branch_summary":
			return nonEmptyString(value.fromId) && typeof value.summary === "string";
		case "custom":
			return nonEmptyString(value.customType);
		case "custom_message":
			return (
				nonEmptyString(value.customType) && validUserContent(value.content) && typeof value.display === "boolean"
			);
		case "label":
			return nonEmptyString(value.targetId) && (value.label === undefined || typeof value.label === "string");
		case "session_info":
			return value.name === undefined || typeof value.name === "string";
		default:
			return false;
	}
}

function transcriptFindingReason(kind: TranscriptIntegrityIssueKind): SessionIntegrityReasonCode {
	switch (kind) {
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

function findCycles(
	entries: readonly ParsedEntry[],
	byId: ReadonlyMap<string, SessionEntry>,
): SessionIntegrityFinding[] {
	const findings: SessionIntegrityFinding[] = [];
	const finished = new Set<string>();

	for (const { entry } of entries) {
		if (finished.has(entry.id)) continue;
		const path: string[] = [];
		const pathIndex = new Map<string, number>();
		let current: SessionEntry | undefined = byId.get(entry.id);

		while (current && !finished.has(current.id)) {
			const seenAt = pathIndex.get(current.id);
			if (seenAt !== undefined) {
				const cycleEntryIds = path.slice(seenAt);
				addFinding(findings, {
					reason: cycleEntryIds.length === 1 ? "self_cycle" : "parent_cycle",
					entryId: cycleEntryIds[0],
					cycleEntryIds: Object.freeze(cycleEntryIds),
				});
				break;
			}
			pathIndex.set(current.id, path.length);
			path.push(current.id);
			current = current.parentId === null ? undefined : byId.get(current.parentId);
		}
		for (const id of path) finished.add(id);
	}
	return findings;
}

function freezeTranscript(report: TranscriptIntegrityReport): Readonly<TranscriptIntegrityReport> {
	return Object.freeze({
		ok: report.ok,
		issues: Object.freeze(report.issues.map((issue) => Object.freeze({ ...issue }))),
	});
}

/**
 * Inspect the exact complete-line prefix of a session JSONL byte sequence.
 * Newline-free final bytes are reported as a fragment and are never parsed.
 */
export function inspectSessionIntegrity(
	bytes: Uint8Array,
	options: InspectSessionIntegrityOptions = {},
): SessionIntegrityReport {
	const findings: SessionIntegrityFinding[] = [];
	let lastNewline = -1;
	for (let index = bytes.byteLength - 1; index >= 0; index--) {
		if (bytes[index] === 0x0a) {
			lastNewline = index;
			break;
		}
	}

	const completeByteCount = lastNewline + 1;
	const completeBytes = bytes.subarray(0, completeByteCount);
	const fragmentBytes = bytes.subarray(completeByteCount);
	const source = Object.freeze({ byteCount: bytes.byteLength, sha256: sha256(bytes) });
	const trailingFragment =
		fragmentBytes.byteLength === 0
			? null
			: Object.freeze({ byteCount: fragmentBytes.byteLength, sha256: sha256(fragmentBytes) });
	if (trailingFragment) addFinding(findings, { reason: "trailing_fragment" });

	const records: ParsedRecord[] = [];
	let lineCount = 0;
	if (completeBytes.byteLength > 0) {
		let text: string | undefined;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(completeBytes);
		} catch {
			addFinding(findings, { reason: "invalid_utf8" });
		}
		if (text !== undefined) {
			const lines = text.slice(0, -1).split("\n");
			lineCount = lines.length;
			for (let index = 0; index < lines.length; index++) {
				const lineNumber = index + 1;
				const line = lines[index];
				if (line.trim().length === 0) {
					addFinding(findings, { reason: "malformed_json", line: lineNumber });
					continue;
				}
				try {
					records.push({ line: lineNumber, value: JSON.parse(line) });
				} catch {
					addFinding(findings, { reason: "malformed_json", line: lineNumber });
				}
			}
		}
	}

	const headerRecords = records.filter(
		(record): record is ParsedRecord & { value: Record<string, unknown> } =>
			isRecord(record.value) && record.value.type === "session",
	);
	const firstRecord = records.find((record) => record.line === 1);
	let header: SessionHeader | null = null;
	if (!firstRecord || !isRecord(firstRecord.value) || firstRecord.value.type !== "session") {
		addFinding(findings, { reason: "missing_header", line: 1 });
	} else if (validHeader(firstRecord.value, 1, findings)) {
		header = firstRecord.value as unknown as SessionHeader;
	}
	if (headerRecords.length > 1) {
		addFinding(findings, { reason: "multiple_header", line: headerRecords[1].line });
	}
	for (const record of headerRecords) {
		if (record.line !== 1) {
			addFinding(findings, { reason: "late_header", line: record.line });
			if (record.value.version !== CURRENT_SESSION_VERSION) {
				addFinding(findings, { reason: "unsupported_header", line: record.line });
			}
		}
	}

	const parsedEntries: ParsedEntry[] = [];
	for (const record of records) {
		if (isRecord(record.value) && record.value.type === "session") continue;
		if (!isRecord(record.value)) {
			addFinding(findings, { reason: "invalid_entry", line: record.line });
			continue;
		}
		if (typeof record.value.type === "string" && !SUPPORTED_ENTRY_TYPES.has(record.value.type)) {
			addFinding(findings, { reason: "unsupported_entry", line: record.line });
			continue;
		}
		if (!validEntryShape(record.value)) {
			addFinding(findings, {
				reason: "invalid_entry",
				line: record.line,
				...(typeof record.value.id === "string" ? { entryId: record.value.id } : {}),
			});
			continue;
		}
		parsedEntries.push({ line: record.line, entry: record.value });
	}

	const byId = new Map<string, SessionEntry>();
	for (const parsed of parsedEntries) {
		if (byId.has(parsed.entry.id)) {
			addFinding(findings, {
				reason: "duplicate_entry_id",
				line: parsed.line,
				entryId: parsed.entry.id,
			});
		} else {
			byId.set(parsed.entry.id, parsed.entry);
		}
	}
	for (const parsed of parsedEntries) {
		const { entry } = parsed;
		if (entry.parentId !== null && !byId.has(entry.parentId)) {
			addFinding(findings, {
				reason: "missing_parent",
				line: parsed.line,
				entryId: entry.id,
				parentId: entry.parentId,
			});
		}
	}
	for (const cycle of findCycles(parsedEntries, byId)) findings.push(cycle);

	const selectedLeaf =
		options.activeLeafId === undefined ? (parsedEntries.at(-1)?.entry.id ?? null) : options.activeLeafId;
	let activeBranch: SessionEntry[] = [];
	let activeMessages: AgentMessage[] = [];
	let transcript: Readonly<TranscriptIntegrityReport> | null = null;
	const hasStructuralBlocker = findings.some((finding) => finding.reason !== "trailing_fragment");

	if (selectedLeaf !== null && !byId.has(selectedLeaf)) {
		addFinding(findings, { reason: "active_leaf_missing", entryId: selectedLeaf });
	} else if (!hasStructuralBlocker) {
		if (selectedLeaf !== null) {
			let current = byId.get(selectedLeaf);
			while (current) {
				activeBranch.unshift(current);
				current = current.parentId === null ? undefined : byId.get(current.parentId);
			}
		}
		const ancestorIds = new Set<string>();
		for (const entry of activeBranch) {
			if (entry.type === "compaction" && !ancestorIds.has(entry.firstKeptEntryId)) {
				addFinding(findings, {
					reason: "compaction_first_kept_not_ancestor",
					entryId: entry.id,
				});
			}
			ancestorIds.add(entry.id);
		}
		if (!findings.some((finding) => finding.reason === "compaction_first_kept_not_ancestor")) {
			try {
				activeMessages = buildSessionContext(
					parsedEntries.map((parsed) => parsed.entry),
					selectedLeaf,
					byId,
				).messages;
				const inspected = inspectTranscriptIntegrity(activeMessages);
				transcript = freezeTranscript(inspected);
				for (const issue of inspected.issues) {
					addFinding(findings, {
						reason: transcriptFindingReason(issue.kind),
						toolCallId: issue.toolCallId,
						...(issue.toolName === undefined ? {} : { toolName: issue.toolName }),
					});
				}
			} catch {
				addFinding(findings, { reason: "active_branch_context_invalid", entryId: selectedLeaf ?? undefined });
				activeBranch = [];
				activeMessages = [];
				transcript = null;
			}
		}
	}

	const frozenEntries = Object.freeze(parsedEntries.map((parsed) => deepFreeze(parsed.entry)));
	const frozenBranch = Object.freeze(activeBranch.map((entry) => deepFreeze(entry)));
	const frozenMessages = Object.freeze(activeMessages.map((message) => deepFreeze(message)));
	return Object.freeze({
		ok: findings.length === 0,
		source,
		completePrefix: Object.freeze({
			byteCount: completeByteCount,
			sha256: sha256(completeBytes),
			lineCount,
		}),
		trailingFragment,
		header: header === null ? null : deepFreeze(header),
		entries: frozenEntries,
		activeLeafId: selectedLeaf,
		activeBranch: frozenBranch,
		activeMessages: frozenMessages,
		transcript,
		findings: Object.freeze(findings),
	});
}
