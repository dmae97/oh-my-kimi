import { describe, expect, it } from "vitest";
import {
	buildContextBudgetRepresentationCacheKeyV2,
	CONTEXT_BUDGET_POLICY_VERSION_V2,
	computeContextBudgetQueryIntentHashV2,
	computeContextBudgetRepresentationFingerprintV2,
	contentHashOf,
	createMemoryContextBudgetCacheProviderV2,
} from "../src/core/context-budget-governor-v2.ts";
import { makeContextBudgetItem as makeItem, planContextBudgetWith as planWith } from "./context-budget-test-helpers.ts";

describe("context budget v2 exact cache", () => {
	it("records plan and representation cache hits on active context-budget planning", () => {
		const cacheProvider = createMemoryContextBudgetCacheProviderV2();
		const items = [
			makeItem({
				id: "cached-history",
				tier: "history",
				priority: "medium",
				text: "cacheable history ".repeat(80),
				tokenEstimate: 300,
				ageTurns: 8,
			}),
		];
		const first = planWith(items, {
			cacheProvider,
			modelId: "gpt-cache-test",
			promptHash: "prompt-a",
			query: "cacheable history",
		});
		const planHit = planWith(items, {
			cacheProvider,
			modelId: "gpt-cache-test",
			promptHash: "prompt-a",
			query: "cacheable history",
		});
		const representationHit = planWith(items, {
			cacheProvider,
			modelId: "gpt-cache-test",
			promptHash: "prompt-b",
			query: "cacheable history",
		});

		expect(first.observability.cache.planCache.hit).toBe(false);
		expect(first.observability.cache.representationCache.misses).toBeGreaterThan(0);
		expect(first.observability.cache.representationCache.writes).toBeGreaterThan(0);
		expect(planHit.observability.cache.planCache.hit).toBe(true);
		expect(planHit.observability.cache.tokens.savedByCache).toBeGreaterThan(0);
		expect(planHit.planHash).toBe(first.planHash);
		expect(representationHit.observability.cache.planCache.hit).toBe(false);
		expect(representationHit.observability.cache.representationCache.exactHits).toBe(1);
		expect(representationHit.observability.cache.tokens.savedByCache).toBeGreaterThan(0);
		expect(representationHit.selectedRepresentations[0]?.cache?.hit).toBe(true);
	});

	it("bounds the in-memory cache", () => {
		const cacheProvider = createMemoryContextBudgetCacheProviderV2();
		for (let index = 0; index <= 256; index++) {
			cacheProvider.writeNegativeRepresentation({ key: `negative-${index}`, reason: "test" });
		}

		expect(cacheProvider.readNegativeRepresentation("negative-0")).toBeUndefined();
		expect(cacheProvider.readNegativeRepresentation("negative-256")).toBeDefined();
	});

	it("rejects stale and negative representation cache entries before selection", () => {
		const cacheProvider = createMemoryContextBudgetCacheProviderV2();
		const freshSummary = {
			kind: "summary" as const,
			text: "fresh summary",
			estimatedTokens: 18,
			fidelity: "lossy" as const,
		};
		const item = makeItem({
			id: "stale-summary",
			tier: "history",
			priority: "medium",
			text: "fresh source body ".repeat(80),
			tokenEstimate: 320,
			ageTurns: 8,
			representations: [
				freshSummary,
				{
					kind: "omit",
					text: "",
					estimatedTokens: 0,
					fidelity: "lossy",
				},
			],
		});
		const summaryKey = buildContextBudgetRepresentationCacheKeyV2({
			budgetBucket: "4000",
			compressorId: "none",
			modelId: "gpt-cache-test",
			namespace: "context-budget-v2",
			policyVersion: CONTEXT_BUDGET_POLICY_VERSION_V2,
			queryIntentHash: computeContextBudgetQueryIntentHashV2("fresh source"),
			redactionPolicyHash: "none",
			representationFingerprint: computeContextBudgetRepresentationFingerprintV2(freshSummary),
			representationKind: "summary",
			safetyProfileHash: "default",
			sourceHash: contentHashOf(item.text),
			tokenizerId: "heuristic-v1",
		});
		cacheProvider.writeRepresentation({
			key: summaryKey,
			entry: {
				createdAtEpochMs: 0,
				estimatedTokens: 1,
				fidelity: "lossy",
				kind: "summary",
				modelId: "gpt-cache-test",
				policyVersion: CONTEXT_BUDGET_POLICY_VERSION_V2,
				representationFingerprint: computeContextBudgetRepresentationFingerprintV2(freshSummary),
				sourceHash: contentHashOf(item.text),
				text: "STALE SUMMARY",
				tokenizerId: "heuristic-v1",
			},
		});
		const stalePlan = planWith([item], {
			cacheNowEpochMs: 1_000,
			cacheProvider,
			cacheTtlMs: 1,
			modelId: "gpt-cache-test",
			query: "fresh source",
		});

		expect(stalePlan.observability.cache.representationCache.staleRejects).toBe(1);
		expect(stalePlan.selectedRepresentations[0]?.text).toBe("fresh summary");

		const negativeProvider = createMemoryContextBudgetCacheProviderV2();
		negativeProvider.writeNegativeRepresentation({ key: summaryKey, reason: "verifier_failed" });
		const negativePlan = planWith([item], {
			cacheProvider: negativeProvider,
			modelId: "gpt-cache-test",
			query: "fresh source",
		});

		expect(negativePlan.observability.cache.representationCache.negativeHits).toBe(1);
		expect(negativePlan.omittedItemIds).toContain("stale-summary");
	});

	it("misses plan cache when decision-affecting item fields change", () => {
		const cacheProvider = createMemoryContextBudgetCacheProviderV2();
		const base = makeItem({
			id: "decision-sensitive",
			tier: "history",
			priority: "medium",
			text: "decision source ".repeat(80),
			tokenEstimate: 320,
			ageTurns: 8,
			representations: [
				{
					kind: "summary",
					text: "decision summary",
					estimatedTokens: 18,
					fidelity: "lossy",
				},
			],
		});
		const first = planWith([base], {
			cacheProvider,
			modelId: "gpt-cache-test",
			promptHash: "decision-plan",
			query: "decision source",
		});
		const changed = planWith([{ ...base, required: true }], {
			cacheProvider,
			modelId: "gpt-cache-test",
			promptHash: "decision-plan",
			query: "decision source",
		});

		expect(first.observability.cache.planCache.hit).toBe(false);
		expect(changed.observability.cache.planCache.hit).toBe(false);
		expect(changed.selectedRepresentations[0]?.kind).toBe("full");
	});

	it("does not let cached representations overwrite changed explicit representation text", () => {
		const cacheProvider = createMemoryContextBudgetCacheProviderV2();
		const base = makeItem({
			id: "explicit-summary",
			tier: "history",
			priority: "medium",
			text: "same source body ".repeat(80),
			tokenEstimate: 320,
			ageTurns: 8,
			representations: [
				{
					kind: "summary",
					text: "old explicit summary",
					estimatedTokens: 18,
					fidelity: "lossy",
				},
			],
		});
		const first = planWith([base], {
			cacheProvider,
			modelId: "gpt-cache-test",
			promptHash: "explicit-a",
			query: "same source",
		});
		const changed = planWith(
			[
				{
					...base,
					representations: [
						{
							kind: "summary" as const,
							text: "new explicit summary",
							estimatedTokens: 18,
							fidelity: "lossy" as const,
						},
					],
				},
			],
			{
				cacheProvider,
				modelId: "gpt-cache-test",
				promptHash: "explicit-b",
				query: "same source",
			},
		);

		expect(first.selectedRepresentations[0]?.text).toBe("old explicit summary");
		expect(changed.observability.cache.representationCache.exactHits).toBe(0);
		expect(changed.selectedRepresentations[0]?.text).toBe("new explicit summary");
	});

	it("still hits the plan cache when age advances by one turn within the same recency bucket", () => {
		// Regression test: ageTurns/baseScore/effectiveScore are recomputed on every planning
		// pass (recency decays continuously via deriveRecency), so hashing their raw values used
		// to change the plan cache key on every single turn even when the same items would be
		// selected -- the cache could never hit past the first call in a session. See
		// bucketAgeTurnsForCacheKeyV2 in context-budget-v2-plan-cache-keys.ts. Ages are chosen far
		// past any plausible recency half-life so the one-turn recency delta is negligible
		// regardless of the exact half-life constant, and both still fall in the same log2 bucket.
		const cacheProvider = createMemoryContextBudgetCacheProviderV2();
		const historyItem = (ageTurns: number) =>
			makeItem({
				id: "cached-history",
				tier: "history",
				priority: "medium",
				text: "cacheable history ".repeat(80),
				tokenEstimate: 300,
				ageTurns,
			});

		const first = planWith([historyItem(200)], {
			cacheProvider,
			modelId: "gpt-cache-test",
			query: "cacheable history",
		});
		// Simulate the next turn: the same item is legitimately one turn older, as it always is
		// in production. This must still be served from the plan cache.
		const second = planWith([historyItem(201)], {
			cacheProvider,
			modelId: "gpt-cache-test",
			query: "cacheable history",
		});

		expect(first.observability.cache.planCache.hit).toBe(false);
		expect(second.observability.cache.planCache.hit).toBe(true);
		expect(second.observability.cache.tokens.savedByCache).toBeGreaterThan(0);
	});

	it("misses the plan cache once age crosses into a materially different recency bucket", () => {
		const cacheProvider = createMemoryContextBudgetCacheProviderV2();
		const historyItem = (ageTurns: number) =>
			makeItem({
				id: "cached-history",
				tier: "history",
				priority: "medium",
				text: "cacheable history ".repeat(80),
				tokenEstimate: 300,
				ageTurns,
			});

		const first = planWith([historyItem(8)], {
			cacheProvider,
			modelId: "gpt-cache-test",
			query: "cacheable history",
		});
		const muchOlder = planWith([historyItem(400)], {
			cacheProvider,
			modelId: "gpt-cache-test",
			query: "cacheable history",
		});

		expect(first.observability.cache.planCache.hit).toBe(false);
		expect(muchOlder.observability.cache.planCache.hit).toBe(false);
	});
});
