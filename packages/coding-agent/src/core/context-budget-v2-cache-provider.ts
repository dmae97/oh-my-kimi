import {
	type ContextCacheInvalidationSnapshot,
	createContextCacheInvalidationSnapshot,
} from "./context-budget-v2-cache-invalidation.ts";
import type {
	ContextBudgetCacheLayerV2,
	ContextBudgetCacheProviderV2,
	ContextBudgetNegativeCacheEntryV2,
	ContextBudgetPlanCacheEntryV2,
	ContextBudgetPlanCacheReadV2,
	ContextBudgetRepresentationCacheEntryV2,
	ContextBudgetRepresentationCacheReadV2,
} from "./context-budget-v2-types.ts";

export function createMemoryContextBudgetCacheProviderV2(
	layer: ContextBudgetCacheLayerV2 = "turn",
): ContextBudgetCacheProviderV2 {
	return new MemoryContextBudgetCacheProviderV2(layer);
}

export class MemoryContextBudgetCacheProviderV2 implements ContextBudgetCacheProviderV2 {
	private readonly representations = new Map<string, ContextBudgetRepresentationCacheEntryV2>();
	private readonly negatives = new Map<string, ContextBudgetNegativeCacheEntryV2>();
	private readonly plans = new Map<string, ContextBudgetPlanCacheEntryV2>();
	private readonly layer: ContextBudgetCacheLayerV2;
	private invalidationSnapshot: ContextCacheInvalidationSnapshot | undefined;

	constructor(layer: ContextBudgetCacheLayerV2) {
		this.layer = layer;
	}

	getInvalidationSnapshot(): ContextCacheInvalidationSnapshot | undefined {
		return this.invalidationSnapshot;
	}

	setInvalidationSnapshot(snapshot: ContextCacheInvalidationSnapshot): void {
		this.invalidationSnapshot = createContextCacheInvalidationSnapshot({
			forkId: snapshot.forkId,
			worktreeFingerprint: snapshot.worktreeFingerprint,
			activeModelId: snapshot.activeModelId,
			compactionModelId: snapshot.compactionModelId,
			globalEpoch: snapshot.globalEpoch,
			transcriptRepair: snapshot.counters.transcriptRepair,
			toolResultDisposition: snapshot.counters.toolResultDisposition,
			evidenceReceipt: snapshot.counters.evidenceReceipt,
			userSteering: snapshot.counters.userSteering,
			settings: snapshot.counters.settings,
		});
	}

	readRepresentation(key: string): ContextBudgetRepresentationCacheReadV2 | undefined {
		const entry = this.representations.get(key);
		return entry ? { entry, layer: this.layer } : undefined;
	}

	writeRepresentation(input: { readonly key: string; readonly entry: ContextBudgetRepresentationCacheEntryV2 }): void {
		this.representations.set(input.key, input.entry);
	}

	readNegativeRepresentation(key: string): ContextBudgetNegativeCacheEntryV2 | undefined {
		return this.negatives.get(key);
	}

	writeNegativeRepresentation(input: { readonly key: string; readonly reason: string }): void {
		this.negatives.set(input.key, { reason: input.reason, layer: this.layer });
	}

	readPlan(key: string): ContextBudgetPlanCacheReadV2 | undefined {
		const entry = this.plans.get(key);
		return entry ? { entry, layer: this.layer } : undefined;
	}

	writePlan(input: { readonly key: string; readonly entry: ContextBudgetPlanCacheEntryV2 }): void {
		this.plans.set(input.key, input.entry);
	}
}
