import type {
	ContextBudgetItemV2,
	ContextBudgetTierV2,
	ContextRepresentationCandidateV2,
	ContextRepresentationKindV2,
	ContextSourceRefV2,
	HeadroomQualityPolicyV2,
} from "./context-budget-headroom.ts";
import type { TokenCounterAdapter } from "./context-budget-token-counter.ts";

export const CONTEXT_BUDGET_POLICY_VERSION_V2 = "context-budget-v2";

export interface TierBudgetPolicyV2 {
	readonly floorPct: number;
	readonly ceilingPct: number;
}

export const DEFAULT_TIER_POLICY_V2: Readonly<Record<ContextBudgetTierV2, TierBudgetPolicyV2>> = {
	system: { floorPct: 0.25, ceilingPct: 0.45 },
	"active-goal": { floorPct: 0.1, ceilingPct: 0.25 },
	"current-files": { floorPct: 0.08, ceilingPct: 0.2 },
	tools: { floorPct: 0.04, ceilingPct: 0.12 },
	skills: { floorPct: 0.03, ceilingPct: 0.12 },
	mcp: { floorPct: 0.02, ceilingPct: 0.08 },
	history: { floorPct: 0.1, ceilingPct: 0.3 },
	evidence: { floorPct: 0.08, ceilingPct: 0.25 },
	scratch: { floorPct: 0, ceilingPct: 0.05 },
};

export const ALL_TIERS_V2: readonly ContextBudgetTierV2[] = [
	"system",
	"active-goal",
	"current-files",
	"tools",
	"skills",
	"mcp",
	"history",
	"evidence",
	"scratch",
];

export interface PromptContextBudgetInputV2 {
	readonly maxTokens: number;
	readonly responseReserveTokens?: number;
	readonly safetyMarginTokens?: number;
	readonly modelId?: string;
	readonly policyVersion?: string;
	readonly promptHash?: string;
	readonly query?: string;
	readonly items: readonly ContextBudgetItemV2[];
	readonly tokenCounter?: TokenCounterAdapter;
	readonly tierPolicy?: Partial<Record<ContextBudgetTierV2, TierBudgetPolicyV2>>;
	readonly qualityPolicy?: HeadroomQualityPolicyV2;
}

export interface SelectedRepresentationV2 {
	readonly itemId: string;
	readonly kind: ContextRepresentationKindV2;
	readonly text: string;
	readonly estimatedTokens: number;
	readonly fidelity: ContextRepresentationCandidateV2["fidelity"];
	readonly sourceRef?: ContextSourceRefV2;
	readonly summaryHash?: string;
	readonly compressorId?: string;
}

export interface TierBudgetAllocationV2 {
	readonly tier: ContextBudgetTierV2;
	readonly floorTokens: number;
	readonly ceilingTokens: number;
	readonly allocatedTokens: number;
	readonly usedTokens: number;
	readonly hardTokens: number;
}

export type QualityDiagnosticReasonV2 =
	| "omitted_high_priority"
	| "retrieval_miss_risk"
	| "restore_on_demand_hint"
	| "hard_pin_over_capacity"
	| "coverage_gap"
	| "tier_ceiling_exceeded"
	| "invalid_budget";

export interface QualityDiagnosticV2 {
	readonly reason: QualityDiagnosticReasonV2;
	readonly itemId?: string;
	readonly detail: string;
}

export interface PromptContextBudgetPlanV2 {
	readonly policyVersion: string;
	readonly promptHash?: string;
	readonly planHash: string;
	readonly maxTokens: number;
	readonly responseReserveTokens: number;
	readonly safetyMarginTokens: number;
	readonly availableTokens: number;
	readonly usedTokens: number;
	readonly omittedTokens: number;
	readonly rawTokens: number;
	readonly tokenSavingsRatio: number;
	readonly emergency: boolean;
	readonly omittedHighPriority: boolean;
	readonly tierAllocations: readonly TierBudgetAllocationV2[];
	readonly selectedRepresentations: readonly SelectedRepresentationV2[];
	readonly includedItemIds: readonly string[];
	readonly omittedItemIds: readonly string[];
	readonly diagnostics: readonly QualityDiagnosticV2[];
	readonly retrievalFallbacks: readonly ContextSourceRefV2[];
}
