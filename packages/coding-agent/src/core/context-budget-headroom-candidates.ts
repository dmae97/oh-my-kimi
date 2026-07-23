import {
	type ContextBudgetItemV2,
	type ContextRepresentationCandidateV2,
	type ContextSourceRefV2,
	DEFAULT_HEADROOM_QUALITY_POLICY,
	fnv1aHex,
	fullTextTokens,
	type HeadroomQualityPolicyV2,
	heuristicTokenCount,
} from "./context-budget-headroom-types.ts";

const SUMMARY_HEAD_CHARS = 160;
const HEADROOM_HEAD_CHARS = 120;

export function deriveRepresentationCandidates(
	item: ContextBudgetItemV2,
	policy: HeadroomQualityPolicyV2 = DEFAULT_HEADROOM_QUALITY_POLICY,
): readonly ContextRepresentationCandidateV2[] {
	const full = fullTextTokens(item);
	const sourceRef = item.sourceRef;
	const retrievable = sourceRef?.retrievable === true;
	const candidates: ContextRepresentationCandidateV2[] = [];

	candidates.push({
		kind: "full",
		text: item.text,
		estimatedTokens: full,
		fidelity: item.tokenEstimate !== undefined ? "exact" : "bounded",
		sourceRef,
	});

	if (retrievable && sourceRef) {
		const pointerText = formatPointer(sourceRef);
		candidates.push({
			kind: "pointer",
			text: pointerText,
			estimatedTokens: heuristicTokenCount(pointerText),
			fidelity: "bounded",
			sourceRef,
		});
	}

	const summaryTokens = Math.ceil(full * 0.15) + 8;
	if (isSummaryEligible(item, full, policy) && summaryTokens < full) {
		candidates.push({
			kind: "summary",
			text: summarizeText(item.text),
			estimatedTokens: summaryTokens,
			fidelity: "lossy",
			summaryHash: fnv1aHex(item.text),
		});
	}

	const headroomText = formatHeadroom(item.text, sourceRef);
	const headroomTokens = Math.max(Math.ceil(full * 0.35) + 16, heuristicTokenCount(headroomText));
	if (full > policy.headroomThresholdTokens && retrievable && headroomTokens < full) {
		candidates.push({
			kind: "headroom-compressed",
			text: headroomText,
			estimatedTokens: headroomTokens,
			fidelity: "reversible",
			sourceRef,
			compressorId: "headroom-shadow",
		});
	}

	if (policy.allowOmit) {
		candidates.push({
			kind: "omit",
			text: "",
			estimatedTokens: 0,
			fidelity: "lossy",
			sourceRef,
		});
	}

	return candidates;
}

function isSummaryEligible(item: ContextBudgetItemV2, fullTokens: number, policy: HeadroomQualityPolicyV2): boolean {
	return (
		item.tier === "history" ||
		item.tier === "evidence" ||
		item.tier === "scratch" ||
		(item.ageTurns ?? 0) >= policy.summaryMaxAgeTurns ||
		fullTokens > policy.headroomThresholdTokens
	);
}

function formatPointer(ref: ContextSourceRefV2): string {
	const parts: string[] = [`uri="${escapeMetadataValue(ref.uri)}"`];
	if (ref.symbol) parts.push(`symbol="${escapeMetadataValue(ref.symbol)}"`);
	if (ref.range) parts.push(`lines="${ref.range.startLine}-${ref.range.endLine}"`);
	parts.push(`hash="${escapeMetadataValue(ref.contentHash)}"`);
	return `<pointer ${parts.join(" ")} />`;
}

function summarizeText(text: string): string {
	if (text.length <= SUMMARY_HEAD_CHARS) {
		return text;
	}
	return `${text.slice(0, SUMMARY_HEAD_CHARS)} …[summary]`;
}

function formatHeadroom(text: string, ref?: ContextSourceRefV2): string {
	const head = text.slice(0, HEADROOM_HEAD_CHARS);
	const hash = fnv1aHex(text);
	const where = ref ? ` uri="${escapeMetadataValue(ref.uri)}"` : "";
	return `${head} …[headroom-compressed${where} hash="${hash}"]`;
}

function escapeMetadataValue(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
