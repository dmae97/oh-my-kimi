import type { ContextRepresentationKindV2 } from "./context-budget-headroom.ts";
import type {
	ContextBudgetCacheLayerV2,
	ContextBudgetRepresentationCacheKeyKindV2,
	PromptContextBudgetPlanV2,
	TokenCacheTelemetryV2,
} from "./context-budget-v2-types.ts";

export interface MutableTokenCacheTelemetryV2 {
	planCache: {
		hit: boolean;
		key: string;
		layer?: ContextBudgetCacheLayerV2;
		rejectedReason?: string;
	};
	representationCache: {
		exactHits: number;
		semanticHits: number;
		pointerHits: number;
		misses: number;
		staleRejects: number;
		poisonRejects: number;
		negativeHits: number;
		writes: number;
	};
	tokens: {
		raw: number;
		rendered: number;
		savedByCache: number;
		savedByCompression: number;
		savedByOmission: number;
	};
}

export function createMutableContextBudgetCacheTelemetryV2(planKey: string): MutableTokenCacheTelemetryV2 {
	return {
		planCache: {
			hit: false,
			key: planKey,
		},
		representationCache: {
			exactHits: 0,
			semanticHits: 0,
			pointerHits: 0,
			misses: 0,
			staleRejects: 0,
			poisonRejects: 0,
			negativeHits: 0,
			writes: 0,
		},
		tokens: {
			raw: 0,
			rendered: 0,
			savedByCache: 0,
			savedByCompression: 0,
			savedByOmission: 0,
		},
	};
}

export function finalizeContextBudgetCacheTelemetryV2(
	telemetry: MutableTokenCacheTelemetryV2,
	input: {
		readonly rawTokens: number;
		readonly usedTokens: number;
		readonly omittedTokens: number;
	},
): TokenCacheTelemetryV2 {
	return {
		planCache: { ...telemetry.planCache },
		representationCache: { ...telemetry.representationCache },
		tokens: {
			raw: input.rawTokens,
			rendered: input.usedTokens,
			savedByCache: telemetry.tokens.savedByCache,
			savedByCompression: Math.max(0, input.rawTokens - input.usedTokens - input.omittedTokens),
			savedByOmission: input.omittedTokens,
		},
	};
}

export function withCacheTelemetry(
	plan: PromptContextBudgetPlanV2,
	telemetry: MutableTokenCacheTelemetryV2,
): PromptContextBudgetPlanV2 {
	const cache = finalizeContextBudgetCacheTelemetryV2(telemetry, {
		omittedTokens: plan.omittedTokens,
		rawTokens: plan.rawTokens,
		usedTokens: plan.usedTokens,
	});
	return {
		...plan,
		observability: {
			...plan.observability,
			cache,
		},
	};
}

export function recordContextBudgetRepresentationCacheHitV2(
	telemetry: MutableTokenCacheTelemetryV2,
	kind: ContextRepresentationKindV2,
	keyKind: ContextBudgetRepresentationCacheKeyKindV2 = "exact",
	savedTokens = 0,
): void {
	telemetry.tokens.savedByCache += Math.max(0, Math.floor(savedTokens));
	if (keyKind === "materialized") {
		telemetry.representationCache.semanticHits += 1;
		return;
	}
	if (kind === "pointer") {
		telemetry.representationCache.pointerHits += 1;
		return;
	}
	telemetry.representationCache.exactHits += 1;
}
