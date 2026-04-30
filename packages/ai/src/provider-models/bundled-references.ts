import { getBundledModels, getBundledProviders } from "../models";
import type { Api, Model } from "../types";

export function createBundledReferenceMap<TApi extends Api>(
	provider: Parameters<typeof getBundledModels>[0],
): Map<string, Model<TApi>> {
	const references = new Map<string, Model<TApi>>();
	for (const model of getBundledModels(provider)) {
		references.set(model.id, model as Model<TApi>);
	}
	return references;
}

export function createReferenceResolver<TApi extends Api>(
	providerRefs: Map<string, Model<TApi>>,
): (modelId: string) => Model<TApi> | undefined {
	const globalRefs = new Map<string, Model<Api>>();
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider as Parameters<typeof getBundledModels>[0])) {
			const candidate = model as Model<Api>;
			const existing = globalRefs.get(candidate.id);
			if (!existing) {
				globalRefs.set(candidate.id, candidate);
			} else if (candidate.contextWindow !== existing.contextWindow) {
				if (candidate.contextWindow > existing.contextWindow) {
					globalRefs.set(candidate.id, candidate);
				}
			} else if (candidate.maxTokens !== existing.maxTokens) {
				if (candidate.maxTokens > existing.maxTokens) {
					globalRefs.set(candidate.id, candidate);
				}
			} else if (existing.provider !== "openai" && candidate.provider === "openai") {
				globalRefs.set(candidate.id, candidate);
			}
		}
	}
	return (modelId: string) => providerRefs.get(modelId) ?? (globalRefs.get(modelId) as Model<TApi> | undefined);
}
