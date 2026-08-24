import { describe, expect, it } from "vitest";
import type { ContextBudgetItemV2 } from "../src/core/context-budget-headroom.ts";
import { compareOptionalForSelection, type PlannedItemV2 } from "../src/core/context-budget-v2-scoring.ts";
import { makeContextBudgetItem, planContextBudgetWith } from "./context-budget-test-helpers.ts";

/**
 * The optional-item selection is a budgeted 0/1 knapsack. Ordering it by
 * priority class first makes the greedy unbounded-bad: one expensive `high`
 * item can evict an arbitrary number of far denser `medium` items. These tests
 * pin value-density as the primary ordering key.
 */

function planned(over: Partial<PlannedItemV2> & Pick<PlannedItemV2, "item" | "fullTokens">): PlannedItemV2 {
	const { item, fullTokens, ...rest } = over;
	const baseScore = rest.baseScore ?? 0;
	return {
		admissibleTokens: rest.admissibleTokens ?? fullTokens,
		baseScore,
		contentHash: `hash-${item.id}`,
		effectiveScore: rest.effectiveScore ?? baseScore,
		fullTokens,
		isHard: false,
		item,
		redundancyPenalty: rest.redundancyPenalty ?? 0,
	};
}

function fullOnly(text: string, tokens: number): ContextBudgetItemV2["representations"] {
	return [
		{ estimatedTokens: tokens, fidelity: "exact", kind: "full", text },
		{ estimatedTokens: 0, fidelity: "lossy", kind: "omit", text: "" },
	];
}

describe("optional context-budget ordering is density-first", () => {
	it("prefers a dense low-priority item over a bulky high-priority item", () => {
		const bulky = planned({
			baseScore: 101,
			effectiveScore: 101,
			fullTokens: 3800,
			item: makeContextBudgetItem({ id: "bulky", priority: "high", text: "b", tier: "current-files" }),
		});
		const dense = planned({
			baseScore: 115,
			effectiveScore: 115,
			fullTokens: 300,
			item: makeContextBudgetItem({ id: "dense", priority: "medium", text: "d", tier: "current-files" }),
		});

		// 115/300 = 0.383 per token vs 101/3800 = 0.027 per token.
		expect(compareOptionalForSelection(bulky, dense)).toBeGreaterThan(0);
		expect([bulky, dense].sort(compareOptionalForSelection).map((entry) => entry.item.id)).toEqual([
			"dense",
			"bulky",
		]);
	});

	it("still prefers the higher-priority item at equal density", () => {
		const high = planned({
			baseScore: 100,
			effectiveScore: 100,
			fullTokens: 200,
			item: makeContextBudgetItem({ id: "high", priority: "high", text: "h", tier: "history" }),
		});
		const medium = planned({
			baseScore: 100,
			effectiveScore: 100,
			fullTokens: 200,
			item: makeContextBudgetItem({ id: "medium", priority: "medium", text: "m", tier: "history" }),
		});
		expect(compareOptionalForSelection(high, medium)).toBeLessThan(0);
	});

	it("is a deterministic total order", () => {
		const entries = [
			planned({
				baseScore: 50,
				effectiveScore: 50,
				fullTokens: 100,
				item: makeContextBudgetItem({ id: "a", priority: "low", text: "a", tier: "scratch" }),
			}),
			planned({
				baseScore: 50,
				effectiveScore: 50,
				fullTokens: 100,
				item: makeContextBudgetItem({ id: "b", priority: "low", text: "b", tier: "scratch" }),
			}),
		];
		expect(compareOptionalForSelection(entries[0], entries[1])).toBeLessThan(0);
		expect(compareOptionalForSelection(entries[1], entries[0])).toBeGreaterThan(0);
		expect(compareOptionalForSelection(entries[0], entries[0])).toBe(0);
	});

	it("does not let one bulky high-priority item evict the whole budget", () => {
		const items: ContextBudgetItemV2[] = [
			makeContextBudgetItem({
				id: "bulky",
				priority: "high",
				representations: fullOnly("bulky", 3800),
				text: "bulky",
				tier: "current-files",
				tokenEstimate: 3800,
			}),
		];
		for (let index = 0; index < 12; index++) {
			items.push(
				makeContextBudgetItem({
					evidenceValue: 1,
					id: `dense-${index}`,
					priority: "medium",
					relevance: 1,
					representations: fullOnly(`dense-${index}`, 300),
					text: `dense-${index}`,
					tier: "current-files",
					tokenEstimate: 300,
				}),
			);
		}

		const plan = planContextBudgetWith(items, {
			maxTokens: 4000,
			responseReserveTokens: 0,
			safetyMarginTokens: 0,
			tierPolicy: { "current-files": { ceilingPct: 1, floorPct: 0 } },
		});

		const selectedIds = plan.selectedRepresentations
			.filter((representation) => representation.kind !== "omit")
			.map((representation) => representation.itemId);

		expect(selectedIds).not.toContain("bulky");
		expect(selectedIds.length).toBe(12);
	});
});
