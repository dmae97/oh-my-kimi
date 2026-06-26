import { createHash } from "node:crypto";
import type { PlannedItemV2 } from "./context-budget-v2-scoring.ts";
import type { SelectedRepresentationV2, TierBudgetAllocationV2 } from "./context-budget-v2-types.ts";

export function contentHashOf(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function computePlanHash(input: {
	readonly policyVersion: string;
	readonly promptHash: string | undefined;
	readonly planned: readonly PlannedItemV2[];
	readonly selection: ReadonlyMap<string, SelectedRepresentationV2>;
	readonly allocations: readonly TierBudgetAllocationV2[];
	readonly omittedItemIds: readonly string[];
}): string {
	const itemsCanonical = input.planned
		.map((planned) => {
			const selected = input.selection.get(planned.item.id);
			return {
				id: planned.item.id,
				tier: planned.item.tier,
				contentHash: planned.contentHash,
				kind: selected?.kind ?? "omit",
				tokens: selected?.estimatedTokens ?? 0,
			};
		})
		.sort((a, b) => a.id.localeCompare(b.id));
	const tiersCanonical = [...input.allocations]
		.map((allocation) => [
			allocation.tier,
			allocation.floorTokens,
			allocation.ceilingTokens,
			allocation.allocatedTokens,
			allocation.usedTokens,
			allocation.hardTokens,
		])
		.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
	const omittedCanonical = [...input.omittedItemIds].sort();
	const canonical = {
		policyVersion: input.policyVersion,
		promptHash: input.promptHash ?? null,
		items: itemsCanonical,
		tiers: tiersCanonical,
		omitted: omittedCanonical,
	};
	return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
