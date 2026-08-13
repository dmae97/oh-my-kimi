import { describe, expect, it } from "vitest";
import {
	buildContextBudgetExactRepresentationCacheKeyV2,
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

	// Representation keys are content-addressed on purpose. Folding the
	// invalidation snapshot (which carries a per-session forkId) into them made
	// every new session miss every persisted entry — reuse was structurally
	// unreachable, not merely cold. Staleness is still caught on read by
	// validateContextBudgetRepresentationCacheEntryV2, and a genuinely different
	// source/model/policy already moves the key through its own components.
	const representationKeyFor = (snapshot: ReturnType<typeof initialSnapshot>, overrides?: { modelId?: string }) => {
		const keyBase = createContextBudgetCacheKeyBaseV2({
			budgetBucket: "100",
			modelId: overrides?.modelId ?? "model-a",
			namespace: "context-budget-v2",
			policyVersion: CONTEXT_BUDGET_POLICY_VERSION_V2,
			query: "stable query",
			cacheInvalidationSnapshot: snapshot,
		});
		return {
			exact: buildContextBudgetExactRepresentationCacheKeyV2({
				...keyBase,
				representationKind: "summary",
				sourceHash: "source-a",
				representationFingerprint: "fingerprint-a",
			}),
			materialized: buildContextBudgetMaterializedRepresentationCacheKeyV2({
				...keyBase,
				representationKind: "summary",
				sourceHash: "source-a",
				targetTokenBucket: 100,
			}),
		};
	};

	it("keeps representation keys stable across every invalidation event", () => {
		const base = initialSnapshot();
		const expected = representationKeyFor(base);
		let snapshot = base;
		for (const event of EVENTS) {
			snapshot = applyContextCacheInvalidation(snapshot, event).snapshot;
			const actual = representationKeyFor(snapshot);
			expect(actual.exact, event.type).toBe(expected.exact);
			expect(actual.materialized, event.type).toBe(expected.materialized);
		}
	});

	it("keeps representation keys stable across a new session fork id", () => {
		const sessionA = createContextCacheInvalidationSnapshot({
			forkId: "session-a",
			worktreeFingerprint: "worktree-a",
			activeModelId: "model-a",
			compactionModelId: "compact-a",
		});
		const sessionB = createContextCacheInvalidationSnapshot({
			forkId: "session-b",
			worktreeFingerprint: "worktree-a",
			activeModelId: "model-a",
			compactionModelId: "compact-a",
		});
		expect(representationKeyFor(sessionB)).toEqual(representationKeyFor(sessionA));
	});

	it("still separates representation keys by model, the axis that actually changes output", () => {
		const snapshot = initialSnapshot();
		const a = representationKeyFor(snapshot);
		const b = representationKeyFor(snapshot, { modelId: "model-b" });
		expect(b.exact).not.toBe(a.exact);
		expect(b.materialized).not.toBe(a.materialized);
	});
});
