/**
 * Provider descriptors and the default-model map, derived from the single-source
 * provider registry (`../registry`).
 *
 * The descriptor/catalog types and guards now live in the registry; they are
 * re-exported here for back-compat with `generate-models.ts` and existing
 * `@oh-my-pi/pi-ai/provider-models` consumers.
 */
import { PROVIDER_REGISTRY } from "../registry";
import type { ProviderDescriptor } from "../registry/types";
import type { KnownProvider } from "../types";

export * from "../registry/types";

/**
 * Runtime model-discovery descriptors: every registry provider that exposes a
 * standard model-manager factory. Special-managed providers
 * (`google-antigravity`/`google-gemini-cli`/`openai-codex`) are built bespoke in
 * the coding-agent runtime and are excluded here.
 */
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = PROVIDER_REGISTRY.flatMap(provider => {
	const { createModelManagerOptions } = provider;
	if (!createModelManagerOptions || provider.specialModelManager) {
		return [];
	}
	return [
		{
			providerId: provider.id,
			defaultModel: provider.defaultModel ?? "",
			createModelManagerOptions,
			allowUnauthenticated: provider.allowUnauthenticated,
			dynamicModelsAuthoritative: provider.dynamicModelsAuthoritative,
			catalogDiscovery: provider.catalogDiscovery,
		},
	];
});

/** Default model IDs for all known providers, derived from the registry. */
export const DEFAULT_MODEL_PER_PROVIDER: Record<KnownProvider, string> = Object.fromEntries(
	PROVIDER_REGISTRY.filter(provider => provider.defaultModel != null).map(
		provider => [provider.id, provider.defaultModel] as [string, string],
	),
) as Record<KnownProvider, string>;
