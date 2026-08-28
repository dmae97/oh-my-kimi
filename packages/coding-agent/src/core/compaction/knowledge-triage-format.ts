import type { PreservedRuleRecord } from "./knowledge-triage-types.ts";

export const PRESERVED_RULES_HEADER = "## Preserved Rules & Invariants (verbatim)";
export const PRESERVED_RULES_START = "<!-- omk:verbatim-rules-v1 -->";
export const PRESERVED_RULES_END = "<!-- /omk:verbatim-rules-v1 -->";
export const PRESERVED_RULE_SOURCE_MARKER = "omk:rule-source-v1";

export function renderPreservedRulesBlock(records: readonly PreservedRuleRecord[]): string {
	return [
		PRESERVED_RULES_HEADER,
		PRESERVED_RULES_START,
		...records.flatMap((record) => [
			`- ${record.text}`,
			`  <!-- ${PRESERVED_RULE_SOURCE_MARKER} ${sourceMetadata(record)} -->`,
		]),
		PRESERVED_RULES_END,
	].join("\n");
}

export function containsReservedRuleToken(value: string): boolean {
	const lower = value.toLowerCase();
	return [PRESERVED_RULES_HEADER, PRESERVED_RULES_START, PRESERVED_RULES_END, PRESERVED_RULE_SOURCE_MARKER].some(
		(token) => lower.includes(token.toLowerCase()),
	);
}

export function stripGeneratedRulesSection(summary: string): string {
	let output = summary.trimEnd();
	output = stripDelimitedBlocks(output, PRESERVED_RULES_START, PRESERVED_RULES_END);
	output = stripHeaderSections(output, PRESERVED_RULES_HEADER);
	for (const token of [PRESERVED_RULES_START, PRESERVED_RULES_END, PRESERVED_RULE_SOURCE_MARKER]) {
		output = removeTokenCaseInsensitive(output, token);
	}
	return output.trimEnd();
}

function sourceMetadata(record: PreservedRuleRecord): string {
	return Buffer.from(
		JSON.stringify({ id: record.sourceEntryId, line: record.sourceLine, digest: record.sourceDigest }),
		"utf8",
	).toString("base64url");
}

function stripDelimitedBlocks(value: string, startToken: string, endToken: string): string {
	let output = value;
	while (true) {
		const lower = output.toLowerCase();
		const start = lower.indexOf(startToken.toLowerCase());
		if (start < 0) return output;
		const end = lower.indexOf(endToken.toLowerCase(), start + startToken.length);
		const stop = end < 0 ? nextSectionOrEnd(output, start) : end + endToken.length;
		output = removeRange(output, start, stop);
	}
}

function stripHeaderSections(value: string, header: string): string {
	let output = value;
	while (true) {
		const start = output.toLowerCase().indexOf(header.toLowerCase());
		if (start < 0) return output;
		output = removeRange(output, start, nextSectionOrEnd(output, start + header.length));
	}
}

function removeTokenCaseInsensitive(value: string, token: string): string {
	let output = value;
	while (true) {
		const start = output.toLowerCase().indexOf(token.toLowerCase());
		if (start < 0) return output;
		output = removeRange(output, start, start + token.length);
	}
}

function nextSectionOrEnd(value: string, from: number): number {
	const next = value.indexOf("\n## ", from);
	return next < 0 ? value.length : next + 1;
}

function removeRange(value: string, start: number, end: number): string {
	const before = value.slice(0, start).trimEnd();
	const after = value.slice(end).trimStart();
	return [before, after].filter((part) => part.length > 0).join("\n\n");
}
