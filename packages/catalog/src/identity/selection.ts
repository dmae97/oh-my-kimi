/**
 * Canonical-variant selection: pick the preferred variant of a canonical
 * model record given caller-supplied provider and candidate orderings.
 */
import type { Api, Model } from "../types";
import { type CanonicalModelVariant, formatCanonicalVariantSelector } from "./equivalence";

export interface CanonicalVariantPreferences {
	/** Lowercased provider id → rank (lower wins). */
	providerRank: ReadonlyMap<string, number>;
	/** Variant selector (`provider/id`) → candidate-list position (lower wins). */
	modelOrder: ReadonlyMap<string, number>;
}

/** Selector → index map over an ordered candidate list, for `modelOrder` tiebreaks. */
export function buildCanonicalModelOrder(candidates: readonly Model<Api>[]): Map<string, number> {
	const modelOrder = new Map<string, number>();
	for (let index = 0; index < candidates.length; index += 1) {
		modelOrder.set(formatCanonicalVariantSelector(candidates[index]!), index);
	}
	return modelOrder;
}

const SOURCE_RANK: Record<CanonicalModelVariant["source"], number> = {
	override: 1,
	bundled: 1,
	heuristic: 2,
	fallback: 3,
};

/**
 * Pick the preferred variant. Sort order: configured provider rank →
 * exact-id match → variant source (override/bundled > heuristic > fallback)
 * → shorter id → candidate-list order.
 */
export function resolveCanonicalVariant(
	variants: readonly CanonicalModelVariant[],
	preferences: CanonicalVariantPreferences,
): CanonicalModelVariant | undefined {
	if (variants.length === 0) {
		return undefined;
	}
	const { providerRank, modelOrder } = preferences;
	return [...variants].sort((left, right) => {
		const leftProviderRank = providerRank.get(left.model.provider.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
		const rightProviderRank = providerRank.get(right.model.provider.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
		if (leftProviderRank !== rightProviderRank) {
			return leftProviderRank - rightProviderRank;
		}
		const leftExact = left.model.id === left.canonicalId ? 0 : 1;
		const rightExact = right.model.id === right.canonicalId ? 0 : 1;
		if (leftExact !== rightExact) {
			return leftExact - rightExact;
		}
		if (SOURCE_RANK[left.source] !== SOURCE_RANK[right.source]) {
			return SOURCE_RANK[left.source] - SOURCE_RANK[right.source];
		}
		if (left.model.id.length !== right.model.id.length) {
			return left.model.id.length - right.model.id.length;
		}
		const leftOrder = modelOrder.get(left.selector) ?? Number.MAX_SAFE_INTEGER;
		const rightOrder = modelOrder.get(right.selector) ?? Number.MAX_SAFE_INTEGER;
		return leftOrder - rightOrder;
	})[0];
}
