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

const DEFAULT_MAX_ENTRIES_PER_CACHE = 256;

function readLru<T>(store: Map<string, T>, key: string): T | undefined {
	const entry = store.get(key);
	if (entry === undefined) return undefined;
	store.delete(key);
	store.set(key, entry);
	return entry;
}

function writeLru<T>(store: Map<string, T>, key: string, entry: T, maxEntries: number): void {
	store.delete(key);
	store.set(key, entry);
	while (store.size > maxEntries) {
		const oldestKey = store.keys().next().value;
		if (oldestKey === undefined) return;
		store.delete(oldestKey);
	}
}

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
	private readonly maxEntries: number;
	private invalidationSnapshot: ContextCacheInvalidationSnapshot | undefined;

	constructor(layer: ContextBudgetCacheLayerV2, maxEntries = DEFAULT_MAX_ENTRIES_PER_CACHE) {
		this.layer = layer;
		this.maxEntries = maxEntries;
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
		const entry = readLru(this.representations, key);
		return entry ? { entry, layer: this.layer } : undefined;
	}

	writeRepresentation(input: { readonly key: string; readonly entry: ContextBudgetRepresentationCacheEntryV2 }): void {
		writeLru(this.representations, input.key, input.entry, this.maxEntries);
	}

	deleteRepresentation(key: string): void {
		this.representations.delete(key);
	}

	readNegativeRepresentation(key: string): ContextBudgetNegativeCacheEntryV2 | undefined {
		return readLru(this.negatives, key);
	}

	writeNegativeRepresentation(input: { readonly key: string; readonly reason: string }): void {
		writeLru(
			this.negatives,
			input.key,
			{ reason: input.reason, createdAtEpochMs: Date.now(), layer: this.layer },
			this.maxEntries,
		);
	}

	deleteNegativeRepresentation(key: string): void {
		this.negatives.delete(key);
	}

	readPlan(key: string): ContextBudgetPlanCacheReadV2 | undefined {
		const entry = readLru(this.plans, key);
		return entry ? { entry, layer: this.layer } : undefined;
	}

	writePlan(input: { readonly key: string; readonly entry: ContextBudgetPlanCacheEntryV2 }): void {
		writeLru(this.plans, input.key, input.entry, this.maxEntries);
	}

	deletePlan(key: string): void {
		this.plans.delete(key);
	}
}
