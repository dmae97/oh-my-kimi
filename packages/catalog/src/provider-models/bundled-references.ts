import { isZeroCostXaiOAuthReference } from "../identity/reference";
import { getBundledModels, getBundledProviders } from "../models";
import type { Api, Model, ModelSpec } from "../types";

/**
 * Project a built `Model` back to spec stage: `compat` becomes the verbatim
 * sparse override record (`compatConfig`), never the resolved view. Discovery
 * mappers spread these references into the specs they hand to the model
 * manager, which rebuilds via `buildModel`.
 */
export function toModelSpec<TApi extends Api>(model: Model<TApi>): ModelSpec<TApi> {
	const { compat: _compat, compatConfig, ...rest } = model;
	return { ...rest, compat: compatConfig } as ModelSpec<TApi>;
}

export function createBundledReferenceMap<TApi extends Api>(
	provider: Parameters<typeof getBundledModels>[0],
): Map<string, ModelSpec<TApi>> {
	const references = new Map<string, ModelSpec<TApi>>();
	for (const model of getBundledModels(provider)) {
		references.set(model.id, toModelSpec(model as Model<TApi>));
	}
	return references;
}

export function createReferenceResolver<TApi extends Api>(
	providerRefs: Map<string, ModelSpec<TApi>>,
): (modelId: string) => ModelSpec<TApi> | undefined {
	const globalRefs = new Map<string, Model<Api>>();
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider as Parameters<typeof getBundledModels>[0])) {
			const candidate = model as Model<Api>;
			if (isZeroCostXaiOAuthReference(candidate)) {
				continue;
			}
			const existing = globalRefs.get(candidate.id);
			if (!existing) {
				globalRefs.set(candidate.id, candidate);
			} else if (candidate.contextWindow !== existing.contextWindow) {
				if ((candidate.contextWindow ?? 0) > (existing.contextWindow ?? 0)) {
					globalRefs.set(candidate.id, candidate);
				}
			} else if (candidate.maxTokens !== existing.maxTokens) {
				if ((candidate.maxTokens ?? 0) > (existing.maxTokens ?? 0)) {
					globalRefs.set(candidate.id, candidate);
				}
			} else if (existing.provider !== "openai" && candidate.provider === "openai") {
				globalRefs.set(candidate.id, candidate);
			}
		}
	}
	return (modelId: string) => {
		const providerRef = providerRefs.get(modelId);
		if (providerRef) return providerRef;
		const globalRef = globalRefs.get(modelId);
		return globalRef ? toModelSpec(globalRef as Model<TApi>) : undefined;
	};
}
