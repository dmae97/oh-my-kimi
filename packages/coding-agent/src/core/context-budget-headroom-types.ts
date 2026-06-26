export type ContextBudgetTierV2 =
	| "system"
	| "active-goal"
	| "current-files"
	| "tools"
	| "skills"
	| "mcp"
	| "history"
	| "evidence"
	| "scratch";

export type ContextBudgetPriorityV2 = "hard" | "high" | "medium" | "low";

export type ContextEvidenceKindV2 = "test" | "command" | "file" | "decision" | "lane" | "user" | "none";

export type ContextRepresentationKindV2 = "full" | "pointer" | "summary" | "headroom-compressed" | "omit";

export interface ContextSourceRefV2 {
	readonly uri: string;
	readonly symbol?: string;
	readonly range?: { readonly startLine: number; readonly endLine: number };
	readonly contentHash: string;
	readonly retrievable: boolean;
}

export type ContextRepresentationFidelityV2 = "exact" | "bounded" | "lossy" | "reversible";

export interface ContextRepresentationCandidateV2 {
	readonly kind: ContextRepresentationKindV2;
	readonly text: string;
	readonly estimatedTokens: number;
	readonly fidelity: ContextRepresentationFidelityV2;
	readonly sourceRef?: ContextSourceRefV2;
	readonly summaryHash?: string;
	readonly compressorId?: string;
}

export interface ContextBudgetItemV2 {
	readonly id: string;
	readonly tier: ContextBudgetTierV2;
	readonly priority: ContextBudgetPriorityV2;
	readonly text: string;
	readonly tokenEstimate?: number;
	readonly relevance?: number;
	readonly recency?: number;
	readonly evidenceValue?: number;
	readonly evidenceKind?: ContextEvidenceKindV2;
	readonly ageTurns?: number;
	readonly redundancyKey?: string;
	readonly required?: boolean;
	readonly pinReason?: string;
	readonly sourceRef?: ContextSourceRefV2;
	readonly representations?: readonly ContextRepresentationCandidateV2[];
}

export interface HeadroomQualityPolicyV2 {
	readonly preferFullForHighPriority: boolean;
	readonly preferPointerForRetrievable: boolean;
	readonly summaryMaxAgeTurns: number;
	readonly headroomThresholdTokens: number;
	readonly allowOmit: boolean;
}

export const DEFAULT_HEADROOM_QUALITY_POLICY: HeadroomQualityPolicyV2 = {
	preferFullForHighPriority: true,
	preferPointerForRetrievable: true,
	summaryMaxAgeTurns: 4,
	headroomThresholdTokens: 400,
	allowOmit: true,
};

export interface HeadroomRuntimeStatusV2 {
	readonly policyId: string;
	readonly selector: string;
	readonly headroomThresholdTokens: number;
	readonly summaryMaxAgeTurns: number;
	readonly representations: readonly ContextRepresentationKindV2[];
}

export function getHeadroomRuntimeStatus(
	policy: HeadroomQualityPolicyV2 = DEFAULT_HEADROOM_QUALITY_POLICY,
): HeadroomRuntimeStatusV2 {
	return {
		policyId: "context-budget-v2",
		selector: "headroom-selector",
		headroomThresholdTokens: policy.headroomThresholdTokens,
		summaryMaxAgeTurns: policy.summaryMaxAgeTurns,
		representations: ["full", "pointer", "summary", "headroom-compressed", "omit"],
	};
}

export interface RepresentationBudgetContext {
	readonly tierUsedTokens: number;
	readonly tierCeilingTokens: number;
	readonly remainingGlobalTokens: number;
}

const CHARS_PER_TOKEN_HEURISTIC = 4;

export function heuristicTokenCount(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN_HEURISTIC));
}

export function fullTextTokens(item: ContextBudgetItemV2): number {
	if (item.tokenEstimate !== undefined) {
		return Math.max(0, Math.floor(item.tokenEstimate));
	}
	return heuristicTokenCount(item.text);
}

export function estimatePointerTokens(ref: ContextSourceRefV2): number {
	let total = ref.uri.length + (ref.contentHash?.length ?? 0) + 16;
	if (ref.symbol) total += ref.symbol.length;
	if (ref.range) total += 8;
	return Math.max(8, Math.ceil(total / CHARS_PER_TOKEN_HEURISTIC));
}

export function fnv1aHex(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
