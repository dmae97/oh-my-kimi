/**
 * Minimal blocking cut: the smallest set of leaf claims whose closure would
 * unblock every blocking root, so a user sees "fix these two" instead of a
 * dump of every intermediate claim on the path.
 *
 * The graph is an all/any DAG, so the cut is computed by one memoized pass:
 * an `all` node needs every blocking required child's cut, an `any` node
 * needs only the cheapest child's cut (ties broken by claim id, so the
 * explanation is stable across runs), and a node that is blocked without any
 * blocking required child — a composite with its own counterexample — is its
 * own cut. Advisory children never enter a cut: they cannot block a parent.
 * Bounded by O(V + E); no general minimum-hitting-set search.
 */

import type { ClaimClosureEvaluation, ClaimNode, ClaimVerdict } from "./claim-types.ts";

const BLOCKING_VERDICTS: readonly ClaimVerdict[] = [
	"violated",
	"stale",
	"incomplete_scope",
	"insufficient_trust",
	"missing",
];

export function isBlockingVerdict(verdict: ClaimVerdict): boolean {
	return BLOCKING_VERDICTS.includes(verdict);
}

function compareCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

function compareCuts(left: readonly string[], right: readonly string[]): number {
	if (left.length !== right.length) return left.length - right.length;
	for (let index = 0; index < left.length; index++) {
		const order = compareCodeUnits(left[index], right[index]);
		if (order !== 0) return order;
	}
	return 0;
}

function unionSorted(sets: readonly (readonly string[])[]): string[] {
	return [...new Set(sets.flat())].sort(compareCodeUnits);
}

export function minimalBlockingCut(
	claims: ReadonlyMap<string, ClaimNode>,
	evaluations: ReadonlyMap<string, ClaimClosureEvaluation>,
	rootIds: readonly string[],
): readonly string[] {
	const memo = new Map<string, readonly string[]>();
	const cutFor = (claimId: string): readonly string[] => {
		const cached = memo.get(claimId);
		if (cached !== undefined) return cached;
		const evaluation = evaluations.get(claimId);
		const claim = claims.get(claimId);
		let cut: readonly string[] = [];
		if (claim !== undefined && evaluation !== undefined && isBlockingVerdict(evaluation.verdict)) {
			const childCuts = claim.satisfaction.inputs
				.filter((input) => claims.get(input)?.severity === "required")
				.map(cutFor)
				.filter((childCut) => childCut.length > 0);
			if (childCuts.length === 0) cut = [claimId];
			else if (claim.satisfaction.rule === "all") cut = unionSorted(childCuts);
			else cut = [...childCuts].sort(compareCuts)[0];
		}
		memo.set(claimId, cut);
		return cut;
	};
	return unionSorted(rootIds.map(cutFor));
}
