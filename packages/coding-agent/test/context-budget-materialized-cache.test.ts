import { describe, expect, it } from "vitest";
import {
	buildContextBudgetMaterializedRepresentationCacheKeyV2,
	CONTEXT_BUDGET_POLICY_VERSION_V2,
	CONTEXT_BUDGET_SELECTION_POLICY_V2,
	type ContextBudgetItemV2,
	computeContextBudgetOutputTextHashV2,
	computeContextBudgetQueryIntentHashV2,
	computeContextBudgetRepresentationFingerprintV2,
	contentHashOf,
	createMemoryContextBudgetCacheProviderV2,
} from "../src/core/context-budget-governor-v2.ts";
import { makeContextBudgetItem as makeItem, planContextBudgetWith as planWith } from "./context-budget-test-helpers.ts";

type CacheProvider = ReturnType<typeof createMemoryContextBudgetCacheProviderV2>;
type CachedSummary = {
	kind: "summary";
	text: string;
	estimatedTokens: number;
	fidelity: "lossy";
	summaryHash: string;
};

function materializedItem(id: string, sourcePrefix: string, priority: ContextBudgetItemV2["priority"] = "high") {
	return makeItem({
		id,
		tier: "history",
		priority,
		text: `${sourcePrefix} `.repeat(80),
		tokenEstimate: 320,
		ageTurns: 8,
	});
}

function cachedSummary(text: string, summaryHash: string): CachedSummary {
	return { kind: "summary", text, estimatedTokens: 40, fidelity: "lossy", summaryHash };
}

function materializedKeyFor(
	item: ContextBudgetItemV2,
	query: string,
	budgetBucket = "100",
): { key: string; sourceHash: string } {
	const sourceHash = contentHashOf(item.text);
	return {
		sourceHash,
		key: buildContextBudgetMaterializedRepresentationCacheKeyV2({
			budgetBucket,
			compressorId: "none",
			selectionPolicyVersion: CONTEXT_BUDGET_SELECTION_POLICY_V2,
			modelId: "gpt-cache-test",
			namespace: "context-budget-v2",
			policyVersion: CONTEXT_BUDGET_POLICY_VERSION_V2,
			queryIntentHash: computeContextBudgetQueryIntentHashV2(query),
			redactionPolicyHash: "none",
			representationKind: "summary",
			safetyProfileHash: "default",
			sourceHash,
			targetTokenBucket: 100,
			tokenizerId: "heuristic-v1",
		}),
	};
}

function writeMaterializedSummary(
	cacheProvider: CacheProvider,
	key: string,
	sourceHash: string,
	candidate: CachedSummary,
	overrides: Partial<{
		createdAtEpochMs: number;
		poisonScore: number;
		queryCoverage: number;
		secretLeakScore: number;
		sourceCoverage: number;
		sourceHash: string;
	}> = {},
): void {
	cacheProvider.writeRepresentation({
		key,
		entry: {
			createdAtEpochMs: overrides.createdAtEpochMs ?? 100,
			estimatedTokens: candidate.estimatedTokens,
			fidelity: candidate.fidelity,
			keyKind: "materialized",
			kind: candidate.kind,
			modelId: "gpt-cache-test",
			outputTextHash: computeContextBudgetOutputTextHashV2(candidate.text),
			policyVersion: CONTEXT_BUDGET_POLICY_VERSION_V2,
			representationFingerprint: computeContextBudgetRepresentationFingerprintV2(candidate),
			sourceHash: overrides.sourceHash ?? sourceHash,
			summaryHash: candidate.summaryHash,
			text: candidate.text,
			tokenizerId: "heuristic-v1",
			verification: {
				poisonScore: overrides.poisonScore ?? 0,
				queryCoverage: overrides.queryCoverage ?? 1,
				secretLeakScore: overrides.secretLeakScore ?? 0,
				sourceCoverage: overrides.sourceCoverage ?? 1,
				validatorVersion: "test",
			},
		},
	});
}

describe("context budget v2 materialized cache", () => {
	it("reuses verified materialized summary cache when exact text fingerprints differ", () => {
		const cacheProvider = createMemoryContextBudgetCacheProviderV2();
		const query = "alpha omega";
		const item = materializedItem("materialized-history", "alpha omega reusable source");
		const { key, sourceHash } = materializedKeyFor(item, query);
		const candidate = cachedSummary("alpha omega cached materialized summary", "cached-materialized");
		writeMaterializedSummary(cacheProvider, key, sourceHash, candidate);

		const plan = planWith([item], {
			cacheNowEpochMs: 200,
			cacheProvider,
			maxTokens: 100,
			modelId: "gpt-cache-test",
			promptHash: "materialized-plan",
			query,
			tierPolicy: { history: { floorPct: 0, ceilingPct: 1 } },
		});

		expect(plan.selectedRepresentations[0]).toMatchObject({
			itemId: "materialized-history",
			kind: "summary",
			text: candidate.text,
			cache: { hit: true, key, keyKind: "materialized" },
		});
		expect(plan.observability.cache.representationCache.exactHits).toBe(0);
		expect(plan.observability.cache.representationCache.semanticHits).toBe(1);
	});

	it("rejects unsafe materialized representation cache entries before selection", () => {
		const query = "alpha omega";
		const item = materializedItem("materialized-reject", "alpha omega unsafe source", "medium");
		const { key, sourceHash } = materializedKeyFor(item, query, "4000");
		const candidate = cachedSummary("UNSAFE MATERIALIZED SUMMARY", "unsafe-materialized");
		const cases = [
			{
				label: "stale",
				createdAtEpochMs: 0,
				cacheNowEpochMs: 1_000,
				cacheTtlMs: 1,
				staleRejects: 1,
				poisonRejects: 0,
			},
			{ label: "low coverage", queryCoverage: 0.1, staleRejects: 0, poisonRejects: 1 },
			{ label: "secret leak", secretLeakScore: 0.01, staleRejects: 0, poisonRejects: 1 },
			{ label: "poison", poisonScore: 0.01, staleRejects: 0, poisonRejects: 1 },
		];

		for (const unsafe of cases) {
			const cacheProvider = createMemoryContextBudgetCacheProviderV2();
			writeMaterializedSummary(cacheProvider, key, sourceHash, candidate, {
				createdAtEpochMs: unsafe.createdAtEpochMs,
				poisonScore: unsafe.poisonScore,
				queryCoverage: unsafe.queryCoverage,
				secretLeakScore: unsafe.secretLeakScore,
			});
			const plan = planWith([item], {
				cacheNowEpochMs: unsafe.cacheNowEpochMs ?? 200,
				cacheProvider,
				cacheTtlMs: unsafe.cacheTtlMs ?? 1_000,
				modelId: "gpt-cache-test",
				promptHash: `materialized-reject-${unsafe.label}`,
				query,
			});

			expect(plan.selectedRepresentations[0]?.text, unsafe.label).not.toBe(candidate.text);
			expect(plan.observability.cache.representationCache.staleRejects, unsafe.label).toBe(unsafe.staleRejects);
			expect(plan.observability.cache.representationCache.poisonRejects, unsafe.label).toBe(unsafe.poisonRejects);
			expect(plan.observability.cache.representationCache.semanticHits, unsafe.label).toBe(0);
		}
	});

	it("does not replay materialized cache hits through plan cache after they become stale", () => {
		const cacheProvider = createMemoryContextBudgetCacheProviderV2();
		const query = "alpha omega";
		const item = materializedItem("materialized-plan-stale", "alpha omega plan cache stale source");
		const { key, sourceHash } = materializedKeyFor(item, query);
		const candidate = cachedSummary(
			"alpha omega cached plan-stale materialized summary",
			"cached-plan-stale-materialized",
		);
		writeMaterializedSummary(cacheProvider, key, sourceHash, candidate);

		const first = planWith([item], {
			cacheBudgetBucket: "100",
			cacheNowEpochMs: 200,
			cacheProvider,
			modelId: "gpt-cache-test",
			maxTokens: 100,
			promptHash: "materialized-stale-plan",
			query,
			tierPolicy: { history: { floorPct: 0, ceilingPct: 1 } },
		});
		const second = planWith([item], {
			cacheBudgetBucket: "100",
			cacheNowEpochMs: 1_000,
			cacheProvider,
			cacheTtlMs: 1,
			modelId: "gpt-cache-test",
			maxTokens: 100,
			promptHash: "materialized-stale-plan",
			query,
			tierPolicy: { history: { floorPct: 0, ceilingPct: 1 } },
		});

		expect(first.selectedRepresentations[0]?.cache?.keyKind).toBe("materialized");
		expect(first.observability.cache.planCache.hit).toBe(false);
		expect(second.observability.cache.planCache.hit).toBe(false);
		expect(second.observability.cache.representationCache.staleRejects).toBe(1);
		expect(second.selectedRepresentations[0]?.text).not.toBe(candidate.text);
	});

	it("rejects materialized cache entries whose source hash does not match the candidate", () => {
		const cacheProvider = createMemoryContextBudgetCacheProviderV2();
		const query = "alpha omega";
		const item = materializedItem("materialized-wrong-source", "alpha omega correct source");
		const { key, sourceHash } = materializedKeyFor(item, query);
		const candidate = cachedSummary("alpha omega wrong-source materialized summary", "wrong-source-materialized");
		writeMaterializedSummary(cacheProvider, key, sourceHash, candidate, {
			sourceHash: contentHashOf("wrong source"),
		});

		const plan = planWith([item], {
			cacheBudgetBucket: "100",
			cacheNowEpochMs: 200,
			cacheProvider,
			maxTokens: 100,
			modelId: "gpt-cache-test",
			promptHash: "materialized-wrong-source",
			query,
			tierPolicy: { history: { floorPct: 0, ceilingPct: 1 } },
		});

		expect(plan.selectedRepresentations[0]?.text).not.toBe(candidate.text);
		expect(plan.observability.cache.representationCache.poisonRejects).toBe(1);
		expect(plan.observability.cache.representationCache.semanticHits).toBe(0);
	});
});
