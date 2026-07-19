import { describe, expect, it } from "vitest";
import {
	buildContextBudgetMaterializedRepresentationCacheKeyV2,
	CONTEXT_BUDGET_POLICY_VERSION_V2,
	createContextBudgetCacheKeyBaseV2,
	createMemoryContextBudgetCacheProviderV2,
	planPromptContextBudgetV2,
} from "../src/core/context-budget-governor-v2.ts";
import {
	applyContextCacheInvalidation,
	type ContextCacheInvalidationEvent,
	createContextCacheInvalidationSnapshot,
} from "../src/core/context-budget-v2-cache-invalidation.ts";
import type { PromptContextBudgetInputV2 } from "../src/core/context-budget-v2-types.ts";
import { makeContextBudgetItem } from "./context-budget-test-helpers.ts";

const EVENTS: readonly ContextCacheInvalidationEvent[] = [
	{ type: "transcriptRepair" },
	{ type: "toolResultDisposition" },
	{ type: "evidenceReceipt" },
	{ type: "userSteering" },
	{ type: "settings" },
	{ type: "worktreeFingerprint", value: "worktree-b" },
	{ type: "activeModelId", value: "model-b" },
	{ type: "compactionModelId", value: "compact-b" },
];

function initialSnapshot() {
	return createContextCacheInvalidationSnapshot({
		forkId: "fork-a",
		worktreeFingerprint: "worktree-a",
		activeModelId: "model-a",
		compactionModelId: "compact-a",
	});
}

function planInput(
	snapshot: ReturnType<typeof initialSnapshot>,
	cacheProvider: ReturnType<typeof createMemoryContextBudgetCacheProviderV2>,
) {
	return {
		maxTokens: 4000,
		responseReserveTokens: 0,
		safetyMarginTokens: 0,
		modelId: "model-a",
		promptHash: "stable-prompt",
		query: "stable query",
		items: [
			makeContextBudgetItem({
				id: "history-a",
				tier: "history",
				text: "stable history source ".repeat(40),
			}),
		],
		cacheProvider,
		cacheNowEpochMs: 100,
		cacheInvalidationSnapshot: snapshot,
	} satisfies PromptContextBudgetInputV2;
}

describe("context-budget invalidation cache-key integration", () => {
	it("misses the actual plan cache after each of the eight invalidation events", () => {
		const cacheProvider = createMemoryContextBudgetCacheProviderV2("session");
		let snapshot = initialSnapshot();
		const initial = planPromptContextBudgetV2(planInput(snapshot, cacheProvider));
		const repeated = planPromptContextBudgetV2(planInput(snapshot, cacheProvider));
		expect(repeated.observability.cache.planCache.hit).toBe(true);

		const planKeys = new Set([initial.observability.cache.planCache.key]);
		for (const event of EVENTS) {
			snapshot = applyContextCacheInvalidation(snapshot, event).snapshot;
			const plan = planPromptContextBudgetV2(planInput(snapshot, cacheProvider));
			expect(plan.observability.cache.planCache.hit, event.type).toBe(false);
			planKeys.add(plan.observability.cache.planCache.key);
		}
		expect(planKeys.size).toBe(EVENTS.length + 1);
	});

	it("uses the memory provider snapshot as the production planner input", () => {
		const cacheProvider = createMemoryContextBudgetCacheProviderV2("session");
		const before = initialSnapshot();
		cacheProvider.setInvalidationSnapshot?.(before);
		const { cacheInvalidationSnapshot: _snapshot, ...withoutExplicitSnapshot } = planInput(before, cacheProvider);
		planPromptContextBudgetV2(withoutExplicitSnapshot);
		expect(planPromptContextBudgetV2(withoutExplicitSnapshot).observability.cache.planCache.hit).toBe(true);

		cacheProvider.setInvalidationSnapshot?.(applyContextCacheInvalidation(before, { type: "settings" }).snapshot);
		expect(planPromptContextBudgetV2(withoutExplicitSnapshot).observability.cache.planCache.hit).toBe(false);
	});

	it("changes materialized representation keys when invalidation provenance changes", () => {
		const before = initialSnapshot();
		const after = applyContextCacheInvalidation(before, { type: "settings" }).snapshot;
		const keyFor = (snapshot: typeof before) => {
			const keyBase = createContextBudgetCacheKeyBaseV2({
				budgetBucket: "100",
				modelId: "model-a",
				namespace: "context-budget-v2",
				policyVersion: CONTEXT_BUDGET_POLICY_VERSION_V2,
				query: "stable query",
				cacheInvalidationSnapshot: snapshot,
			});
			return buildContextBudgetMaterializedRepresentationCacheKeyV2({
				...keyBase,
				representationKind: "summary",
				sourceHash: "source-a",
				targetTokenBucket: 100,
			});
		};

		expect(keyFor(before)).not.toBe(keyFor(after));
	});
});
