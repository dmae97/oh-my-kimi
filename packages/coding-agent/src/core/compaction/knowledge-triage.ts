import { createHash } from "node:crypto";
import type { AgentMessage } from "omk-agent-core";
import { redactSensitiveTextForced } from "../redaction.ts";
import type { CompactionEntry, SessionEntry } from "../session-manager.ts";
import {
	containsReservedRuleToken,
	renderPreservedRulesBlock,
	stripGeneratedRulesSection,
} from "./knowledge-triage-format.ts";
import type { PreservedRuleRecord } from "./knowledge-triage-types.ts";
import { redactCredentialShapedContent } from "./transaction.ts";

export {
	PRESERVED_RULES_END,
	PRESERVED_RULES_HEADER,
	PRESERVED_RULES_START,
	renderPreservedRulesBlock,
} from "./knowledge-triage-format.ts";
export type { PreservedRuleRecord } from "./knowledge-triage-types.ts";

const MAX_PRESERVED_RULES = 64;
const MAX_RULE_LENGTH = 1000;
const MAX_SOURCE_ID_LENGTH = 256;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029]/u;
const EXPLICIT_RULE_PREFIX =
	/^(?:[-*]\s*)?(?:(?:RULE|INVARIANT|CONSTRAINT|REQUIREMENT)\s*:|(?:MUST|NEVER|ALWAYS)\b|(?:규칙|불변식|제약|요구사항)\s*:|(?:반드시|절대)(?:\s|:))/u;

export interface CompactionKnowledgeTriageInput {
	readonly generatedSummary: string;
	readonly currentMessages: readonly AgentMessage[];
	readonly currentEntries?: readonly SessionEntry[];
	readonly previousRules?: unknown;
	readonly previousSummary?: string;
	readonly previousEntries?: readonly SessionEntry[];
}

export interface CompactionKnowledgeTriageResult {
	readonly summary: string;
	readonly preservedRules: readonly PreservedRuleRecord[];
}

export interface CompactionRuleHistory {
	readonly rules: readonly PreservedRuleRecord[];
	readonly entries: readonly SessionEntry[];
}

export function buildCompactionRuleHistory(
	previous: CompactionEntry,
	entries: readonly SessionEntry[],
): CompactionRuleHistory | undefined {
	if (previous.fromHook) return undefined;
	const details = previous.details as { readonly preservedRules?: unknown } | undefined;
	const rules = verifyPreservedRulesAgainstEntries(details?.preservedRules, previous.summary, entries);
	return rules.length > 0 ? { rules, entries } : undefined;
}

/** Extract canonical rule records from exact user session entries. */
export function extractCompactionRuleSources(entries: readonly SessionEntry[]): readonly PreservedRuleRecord[] {
	const records: PreservedRuleRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = directUserText(entry.message);
		if (text !== null) records.push(...extractRules(text, entry.id));
	}
	return deduplicateRules(records);
}

/** Parse untrusted persisted details into a bounded canonical record set. */
export function normalizePreservedRules(value: unknown): readonly PreservedRuleRecord[] {
	if (!Array.isArray(value)) return [];
	const records: PreservedRuleRecord[] = [];
	for (const candidate of value.slice(0, MAX_PRESERVED_RULES)) {
		const record = parseRuleRecord(candidate);
		if (record !== null) records.push(record);
	}
	return deduplicateRules(records);
}

/** Preserve explicit user rules outside the LLM-controlled summary body. */
export function applyCompactionKnowledgeTriage(input: CompactionKnowledgeTriageInput): CompactionKnowledgeTriageResult {
	const generatedSummary = stripGeneratedRulesSection(input.generatedSummary);
	const previous = verifyPreservedRulesAgainstEntries(
		input.previousRules,
		input.previousSummary,
		input.previousEntries,
	);
	const messageRuleKeys = extractRuleKeysFromMessages(input.currentMessages);
	const current =
		input.currentEntries !== undefined ? verifiedCurrentEntries(input.currentEntries, messageRuleKeys) : [];
	const preservedRules = deduplicateRules([...previous, ...current]);
	if (preservedRules.length === 0) return { summary: generatedSummary, preservedRules };
	return { summary: `${generatedSummary}\n\n${renderPreservedRulesBlock(preservedRules)}`, preservedRules };
}

function extractRuleKeysFromMessages(messages: readonly AgentMessage[]): ReadonlySet<string> {
	const keys = new Set<string>();
	for (const message of messages) {
		if (message.role !== "user") continue;
		const text = directUserText(message);
		if (text === null) continue;
		const lines = text.split(/\r?\n/u);
		for (let index = 0; index < lines.length; index++) {
			const canonical = canonicalRuleText(lines[index]);
			if (canonical !== null) keys.add(`${index + 1}\0${canonical}`);
		}
	}
	return keys;
}

function extractRules(text: string, sourceEntryId: string): readonly PreservedRuleRecord[] {
	const records: PreservedRuleRecord[] = [];
	const lines = text.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index++) {
		const record = createRuleRecord(lines[index], sourceEntryId, index + 1);
		if (record !== null) records.push(record);
	}
	return records;
}

function createRuleRecord(text: string, sourceEntryId: string, sourceLine: number): PreservedRuleRecord | null {
	const sanitized = canonicalRuleText(text);
	if (sanitized === null || !isSourceLocation(sourceEntryId, sourceLine)) return null;
	return {
		text: sanitized,
		sourceEntryId,
		sourceLine,
		sourceDigest: sourceDigest(sanitized, sourceEntryId, sourceLine),
	};
}

function parseRuleRecord(value: unknown): PreservedRuleRecord | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join(",") !== "sourceDigest,sourceEntryId,sourceLine,text") return null;
	if (typeof record.text !== "string" || typeof record.sourceEntryId !== "string") return null;
	if (typeof record.sourceLine !== "number" || typeof record.sourceDigest !== "string") return null;
	const sanitized = redactCredentialShapedContent(redactSensitiveTextForced(record.text)).trim();
	if (sanitized !== record.text) return null;
	if (!isExplicitSafeRule(record.text) || !isSourceLocation(record.sourceEntryId, record.sourceLine)) return null;
	if (record.sourceDigest !== sourceDigest(record.text, record.sourceEntryId, record.sourceLine)) return null;
	return {
		text: record.text,
		sourceEntryId: record.sourceEntryId,
		sourceLine: record.sourceLine,
		sourceDigest: record.sourceDigest,
	};
}

function verifiedCurrentEntries(
	entries: readonly SessionEntry[],
	messageRuleKeys: ReadonlySet<string>,
): readonly PreservedRuleRecord[] {
	return extractCompactionRuleSources(entries).filter((rule) =>
		messageRuleKeys.has(`${rule.sourceLine}\0${rule.text}`),
	);
}

function verifyPreservedRulesAgainstEntries(
	value: unknown,
	previousSummary: string | undefined,
	entries: readonly SessionEntry[] | undefined,
): readonly PreservedRuleRecord[] {
	if (previousSummary === undefined || entries === undefined) return [];
	const records = normalizePreservedRules(value);
	if (records.length === 0 || !previousSummary.includes(renderPreservedRulesBlock(records))) return [];
	const sourceRecords = extractCompactionRuleSources(entries);
	const sourceKeys = new Set(sourceRecords.map(ruleRecordKey));
	return records.every((record) => sourceKeys.has(ruleRecordKey(record))) ? records : [];
}

function directUserText(message: Extract<AgentMessage, { role: "user" }>): string | null {
	const text = userText(message);
	return /<(?:file\b|stdin>)/iu.test(text) ? null : text;
}

function userText(message: Extract<AgentMessage, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function deduplicateRules(records: readonly PreservedRuleRecord[]): readonly PreservedRuleRecord[] {
	const unique: PreservedRuleRecord[] = [];
	const seen = new Set<string>();
	for (const record of records) {
		if (seen.has(record.text)) continue;
		seen.add(record.text);
		unique.push(record);
		if (unique.length >= MAX_PRESERVED_RULES) break;
	}
	return unique;
}

function canonicalRuleText(raw: string): string | null {
	if (
		raw.length === 0 ||
		raw.length > MAX_RULE_LENGTH ||
		CONTROL_CHARACTERS.test(raw) ||
		containsReservedRuleToken(raw)
	) {
		return null;
	}
	const trimmed = raw.trim();
	if (!EXPLICIT_RULE_PREFIX.test(trimmed)) return null;
	const sanitized = redactCredentialShapedContent(redactSensitiveTextForced(trimmed)).trim();
	return isExplicitSafeRule(sanitized) ? sanitized : null;
}

function isExplicitSafeRule(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= MAX_RULE_LENGTH &&
		EXPLICIT_RULE_PREFIX.test(value) &&
		!CONTROL_CHARACTERS.test(value) &&
		!containsReservedRuleToken(value)
	);
}

function isSourceLocation(sourceEntryId: string, sourceLine: number): boolean {
	return (
		sourceEntryId.length > 0 &&
		sourceEntryId.length <= MAX_SOURCE_ID_LENGTH &&
		SOURCE_ID_PATTERN.test(sourceEntryId) &&
		redactSensitiveTextForced(sourceEntryId) === sourceEntryId &&
		redactCredentialShapedContent(sourceEntryId) === sourceEntryId &&
		Number.isSafeInteger(sourceLine) &&
		sourceLine >= 1
	);
}

function ruleRecordKey(record: PreservedRuleRecord): string {
	return `${record.sourceEntryId}\0${record.sourceLine}\0${record.sourceDigest}\0${record.text}`;
}

function sourceDigest(text: string, sourceEntryId: string, sourceLine: number): string {
	return createHash("sha256").update(`${sourceEntryId}\0${sourceLine}\0${text}`).digest("hex");
}
