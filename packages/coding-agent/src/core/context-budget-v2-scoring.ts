import type { ContextBudgetItemV2, ContextBudgetPriorityV2, ContextBudgetTierV2 } from "./context-budget-headroom.ts";

export interface PlannedItemV2 {
	readonly item: ContextBudgetItemV2;
	readonly fullTokens: number;
	readonly contentHash: string;
	readonly baseScore: number;
	redundancyPenalty: number;
	effectiveScore: number;
	readonly isHard: boolean;
}

const PRIORITY_WEIGHT_V2: Record<ContextBudgetPriorityV2, number> = {
	hard: 1_000_000,
	high: 120,
	medium: 60,
	low: 15,
};

const RECENCY_HALF_LIFE_BY_TIER: Readonly<Record<ContextBudgetTierV2, number>> = {
	system: 999,
	"active-goal": 12,
	"current-files": 8,
	tools: 4,
	skills: 6,
	mcp: 6,
	history: 3,
	evidence: 8,
	scratch: 2,
};

export function scoreContextBudgetItemV2(item: ContextBudgetItemV2, estimatedTokens: number): number {
	if (item.priority === "hard") {
		return Number.POSITIVE_INFINITY;
	}
	const priority = PRIORITY_WEIGHT_V2[item.priority];
	const relevance = clamp01(item.relevance) * 25;
	const recency = deriveRecency(item) * 15;
	const evidence = clamp01(item.evidenceValue) * 25;
	const cost = Math.sqrt(Math.max(0, estimatedTokens)) * 0.55;
	return priority + relevance + recency + evidence - cost;
}

export function applyRedundancyPenalties(items: readonly PlannedItemV2[]): Map<string, number> {
	const penalties = new Map<string, number>();
	const groups = new Map<string, PlannedItemV2[]>();
	for (const planned of items) {
		if (!planned.item.redundancyKey) {
			continue;
		}
		const group = groups.get(planned.item.redundancyKey);
		if (group) {
			group.push(planned);
		} else {
			groups.set(planned.item.redundancyKey, [planned]);
		}
	}
	for (const group of groups.values()) {
		if (group.length <= 1) {
			continue;
		}
		group.sort((a, b) => {
			if (b.baseScore !== a.baseScore) {
				return b.baseScore - a.baseScore;
			}
			return a.item.id.localeCompare(b.item.id);
		});
		for (let index = 1; index < group.length; index++) {
			const duplicate = group[index];
			penalties.set(duplicate.item.id, redundancyPenalty(duplicate.fullTokens) * index);
		}
	}
	return penalties;
}

export function compareOptionalForSelection(a: PlannedItemV2, b: PlannedItemV2): number {
	const priorityDelta = priorityRank(b.item.priority) - priorityRank(a.item.priority);
	if (priorityDelta !== 0) {
		return priorityDelta;
	}
	if (b.effectiveScore !== a.effectiveScore) {
		return b.effectiveScore - a.effectiveScore;
	}
	const aDensity = density(a);
	const bDensity = density(b);
	if (bDensity !== aDensity) {
		return bDensity - aDensity;
	}
	if (a.fullTokens !== b.fullTokens) {
		return a.fullTokens - b.fullTokens;
	}
	return a.item.id.localeCompare(b.item.id);
}

function priorityRank(priority: ContextBudgetPriorityV2): number {
	switch (priority) {
		case "hard":
			return 4;
		case "high":
			return 3;
		case "medium":
			return 2;
		case "low":
			return 1;
	}
}

function clamp01(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.min(1, value));
}

function deriveRecency(item: ContextBudgetItemV2): number {
	if (item.recency !== undefined) {
		return clamp01(item.recency);
	}
	const age = item.ageTurns ?? 0;
	const halfLife = RECENCY_HALF_LIFE_BY_TIER[item.tier] ?? 6;
	return clamp01(Math.exp(-age / halfLife));
}

function redundancyPenalty(tokens: number): number {
	return Math.max(10, Math.sqrt(Math.max(0, tokens)) * 0.8);
}

function density(planned: PlannedItemV2): number {
	if (!Number.isFinite(planned.effectiveScore) || planned.effectiveScore <= 0) {
		return planned.effectiveScore > 0 ? planned.effectiveScore : 0;
	}
	return planned.effectiveScore / Math.max(planned.fullTokens, 1);
}
