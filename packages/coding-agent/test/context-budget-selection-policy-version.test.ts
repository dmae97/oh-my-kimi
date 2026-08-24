import { describe, expect, it } from "vitest";
import {
	CONTEXT_BUDGET_POLICY_VERSION_V2,
	CONTEXT_BUDGET_SELECTION_POLICY_V2,
	createContextBudgetCacheKeyBaseV2,
	createMemoryContextBudgetCacheProviderV2,
} from "../src/core/context-budget-governor-v2.ts";
import { buildContextBudgetPlanCacheKeyV2 } from "../src/core/context-budget-v2-plan-cache-keys.ts";
import { makeContextBudgetItem, planContextBudgetWith } from "./context-budget-test-helpers.ts";

/**
 * `CONTEXT_BUDGET_POLICY_VERSION_V2` is a public identifier: it appears in the
 * system prompt and in cache namespaces, so it cannot be bumped just because
 * the optional-item selection ordering changed. Without a separate token, a
 * selection-policy change silently keeps serving plans built under the old
 * policy for the whole cache TTL, including from disk.
 */

const PLAN_INPUT = {
	availableTokens: 1000,
	maxTokens: 1000,
	planned: [],
	promptHash: "prompt",
	qualityPolicy: {
		allowOmit: true,
		headroomThresholdTokens: 400,
		preferFullForHighPriority: true,
		preferPointerForRetrievable: true,
		summaryMaxAgeTurns: 4,
	},
	responseReserveTokens: 0,
	safetyMarginTokens: 0,
	tierPolicy: {},
} as const;

function keyFor(selectionPolicyVersion?: string): string {
	return buildContextBudgetPlanCacheKeyV2({
		...PLAN_INPUT,
		keyBase: createContextBudgetCacheKeyBaseV2({
			modelId: "model-a",
			policyVersion: CONTEXT_BUDGET_POLICY_VERSION_V2,
			...(selectionPolicyVersion === undefined ? {} : { selectionPolicyVersion }),
		}),
	});
}

describe("context budget selection policy version", () => {
	it("keeps the public policy identifier stable", () => {
		expect(CONTEXT_BUDGET_POLICY_VERSION_V2).toBe("context-budget-v2");
	});

	it("exposes a selection policy token distinct from the public identifier", () => {
		expect(CONTEXT_BUDGET_SELECTION_POLICY_V2).not.toBe(CONTEXT_BUDGET_POLICY_VERSION_V2);
		expect(CONTEXT_BUDGET_SELECTION_POLICY_V2.length).toBeGreaterThan(0);
	});

	it("changes the plan cache key when only the selection policy changes", () => {
		expect(keyFor("selection-a")).not.toBe(keyFor("selection-b"));
	});

	it("defaults to the current selection policy", () => {
		expect(keyFor()).toBe(keyFor(CONTEXT_BUDGET_SELECTION_POLICY_V2));
	});

	it("does not let a plan cached under an older selection policy be served", () => {
		const cacheProvider = createMemoryContextBudgetCacheProviderV2();
		const items = [
			makeContextBudgetItem({
				ageTurns: 3,
				id: "history-1",
				priority: "medium",
				text: "history text ".repeat(40),
				tier: "history",
				tokenEstimate: 200,
			}),
		];
		const options = { cacheProvider, modelId: "model-a", promptHash: "prompt-a" };

		const first = planContextBudgetWith(items, options);
		expect(first.observability.cache.planCache.hit).toBe(false);

		// Same inputs and same policy: the cache is expected to answer.
		const second = planContextBudgetWith(items, options);
		expect(second.observability.cache.planCache.hit).toBe(true);

		// A different selection policy must miss rather than reuse the old plan.
		const rotated = planContextBudgetWith(items, { ...options, selectionPolicyVersion: "selection-next" });
		expect(rotated.observability.cache.planCache.hit).toBe(false);
	});

	it("still reports the public identifier in plan observability", () => {
		const plan = planContextBudgetWith([makeContextBudgetItem({ id: "a", text: "x", tier: "history" })], {
			selectionPolicyVersion: "selection-next",
		});
		expect(plan.policyVersion).toBe(CONTEXT_BUDGET_POLICY_VERSION_V2);
	});
});
