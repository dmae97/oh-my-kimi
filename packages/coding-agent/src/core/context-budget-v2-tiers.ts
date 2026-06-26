import type { ContextBudgetTierV2 } from "./context-budget-headroom.ts";
import type { PlannedItemV2 } from "./context-budget-v2-scoring.ts";
import { ALL_TIERS_V2, type TierBudgetPolicyV2 } from "./context-budget-v2-types.ts";

export interface RawTierDemand {
	readonly demand: number;
	readonly hard: number;
}

export interface RawTierAllocation {
	readonly floor: number;
	readonly ceiling: number;
	readonly allocated: number;
}

export function computeTierDemand(plannedItems: readonly PlannedItemV2[]): Map<ContextBudgetTierV2, RawTierDemand> {
	const demand = new Map<ContextBudgetTierV2, RawTierDemand>();
	for (const tier of ALL_TIERS_V2) {
		demand.set(tier, { demand: 0, hard: 0 });
	}
	for (const planned of plannedItems) {
		const entry = demand.get(planned.item.tier) ?? { demand: 0, hard: 0 };
		demand.set(planned.item.tier, {
			demand: entry.demand + planned.fullTokens,
			hard: entry.hard + (planned.isHard ? planned.fullTokens : 0),
		});
	}
	return demand;
}

export function allocateTiers(
	available: number,
	policy: Readonly<Record<ContextBudgetTierV2, TierBudgetPolicyV2>>,
	demand: Map<ContextBudgetTierV2, RawTierDemand>,
): Map<ContextBudgetTierV2, RawTierAllocation> {
	const out = new Map<ContextBudgetTierV2, RawTierAllocation>();
	const floors = {} as Record<ContextBudgetTierV2, number>;
	const ceilings = {} as Record<ContextBudgetTierV2, number>;
	const wants = {} as Record<ContextBudgetTierV2, number>;

	for (const tier of ALL_TIERS_V2) {
		const floor = Math.max(0, Math.floor(policy[tier].floorPct * available));
		const ceiling = Math.max(floor, Math.floor(policy[tier].ceilingPct * available));
		const entry = demand.get(tier) ?? { demand: 0, hard: 0 };
		const want = Math.max(entry.demand, entry.hard);
		floors[tier] = floor;
		ceilings[tier] = ceiling;
		wants[tier] = want;
		out.set(tier, { floor, ceiling, allocated: Math.min(want, Math.max(ceiling, entry.hard)) });
	}

	let totalAllocated = 0;
	for (const tier of ALL_TIERS_V2) {
		totalAllocated += out.get(tier)?.allocated ?? 0;
	}
	let residual = available - totalAllocated;
	if (residual <= 0) {
		return out;
	}

	const shortfalls = collectShortfalls(out, wants);
	const totalGap = shortfalls.reduce((sum, shortfall) => sum + shortfall.gap, 0);
	if (totalGap <= 0) {
		return out;
	}
	for (const { tier, gap } of shortfalls) {
		const share = Math.min(gap, Math.floor((residual * gap) / totalGap));
		if (share <= 0) continue;
		const entry = out.get(tier);
		if (!entry) continue;
		out.set(tier, { ...entry, allocated: entry.allocated + share });
		residual -= share;
	}
	return out;
}

function collectShortfalls(
	allocations: ReadonlyMap<ContextBudgetTierV2, RawTierAllocation>,
	wants: Record<ContextBudgetTierV2, number>,
): { tier: ContextBudgetTierV2; gap: number }[] {
	const shortfalls: { tier: ContextBudgetTierV2; gap: number }[] = [];
	for (const tier of ALL_TIERS_V2) {
		const entry = allocations.get(tier);
		if (!entry) continue;
		const gap = Math.min(Math.max(0, wants[tier] - entry.allocated), Math.max(0, entry.ceiling - entry.allocated));
		if (gap > 0) shortfalls.push({ tier, gap });
	}
	return shortfalls;
}
