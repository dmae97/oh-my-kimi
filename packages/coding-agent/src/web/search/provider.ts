// Lazy registry of web search providers.
//
// Each provider is loaded on first use; importing this module loads zero
// provider implementations. Provider modules are heavy (each pulls in
// fetch/parse/format helpers) and only one — at most — is needed per session,
// so eager construction was wasted work at startup.
//
// The `label`/`id` metadata is kept inline so callers needing a display name
// (error formatting, UI listings) do not force a load.

import type { SearchProvider } from "./providers/base";
import type { SearchProviderId } from "./types";

export type { SearchParams } from "./providers/base";
export { SearchProvider } from "./providers/base";

interface ProviderMeta {
	id: SearchProviderId;
	label: string;
	load: () => Promise<SearchProvider>;
}

/** Lazy factories. Each `load()` dynamic-imports its provider module on first call. */
const PROVIDER_META: Record<SearchProviderId, ProviderMeta> = {
	exa: {
		id: "exa",
		label: "Exa",
		load: async () => new (await import("./providers/exa")).ExaProvider(),
	},
	brave: {
		id: "brave",
		label: "Brave",
		load: async () => new (await import("./providers/brave")).BraveProvider(),
	},
	jina: {
		id: "jina",
		label: "Jina",
		load: async () => new (await import("./providers/jina")).JinaProvider(),
	},
	perplexity: {
		id: "perplexity",
		label: "Perplexity",
		load: async () => new (await import("./providers/perplexity")).PerplexityProvider(),
	},
	kimi: {
		id: "kimi",
		label: "Kimi",
		load: async () => new (await import("./providers/kimi")).KimiProvider(),
	},
	zai: {
		id: "zai",
		label: "Z.AI",
		load: async () => new (await import("./providers/zai")).ZaiProvider(),
	},
	anthropic: {
		id: "anthropic",
		label: "Anthropic",
		load: async () => new (await import("./providers/anthropic")).AnthropicProvider(),
	},
	gemini: {
		id: "gemini",
		label: "Gemini",
		load: async () => new (await import("./providers/gemini")).GeminiProvider(),
	},
	codex: {
		id: "codex",
		label: "Codex",
		load: async () => new (await import("./providers/codex")).CodexProvider(),
	},
	tavily: {
		id: "tavily",
		label: "Tavily",
		load: async () => new (await import("./providers/tavily")).TavilyProvider(),
	},
	parallel: {
		id: "parallel",
		label: "Parallel",
		load: async () => new (await import("./providers/parallel")).ParallelProvider(),
	},
	kagi: {
		id: "kagi",
		label: "Kagi",
		load: async () => new (await import("./providers/kagi")).KagiProvider(),
	},
	synthetic: {
		id: "synthetic",
		label: "Synthetic",
		load: async () => new (await import("./providers/synthetic")).SyntheticProvider(),
	},
	searxng: {
		id: "searxng",
		label: "SearXNG",
		load: async () => new (await import("./providers/searxng")).SearXNGProvider(),
	},
};

const instanceCache = new Map<SearchProviderId, SearchProvider>();

/** Cheap, sync metadata accessor — never triggers a provider load. */
export function getSearchProviderLabel(id: SearchProviderId): string {
	return PROVIDER_META[id]?.label ?? id;
}

/**
 * Resolve and cache a provider instance. First call for a given id loads the
 * underlying module; subsequent calls return the cached singleton.
 */
export async function getSearchProvider(id: SearchProviderId): Promise<SearchProvider> {
	const cached = instanceCache.get(id);
	if (cached) return cached;
	const meta = PROVIDER_META[id];
	if (!meta) {
		throw new Error(`Unknown search provider: ${id}`);
	}
	const provider = await meta.load();
	instanceCache.set(id, provider);
	return provider;
}

export const SEARCH_PROVIDER_ORDER: SearchProviderId[] = [
	"tavily",
	"perplexity",
	"brave",
	"jina",
	"kimi",
	"anthropic",
	"gemini",
	"codex",
	"zai",
	"exa",
	"parallel",
	"kagi",
	"synthetic",
	"searxng",
];

/** Preferred provider set via settings (default: auto) */
let preferredProvId: SearchProviderId | "auto" = "auto";

/** Set the preferred web search provider from settings */
export function setPreferredSearchProvider(provider: SearchProviderId | "auto"): void {
	preferredProvId = provider;
}

/**
 * Determine which providers are configured and currently available.
 * Each candidate is loaded (and its `isAvailable()` called) only as the chain
 * is walked, so unconfigured providers never pay the load cost.
 */
export async function resolveProviderChain(
	preferredProvider: SearchProviderId | "auto" = preferredProvId,
): Promise<SearchProvider[]> {
	const providers: SearchProvider[] = [];

	if (preferredProvider !== "auto") {
		const provider = await getSearchProvider(preferredProvider);
		if (await provider.isAvailable()) {
			providers.push(provider);
		}
	}

	for (const id of SEARCH_PROVIDER_ORDER) {
		if (id === preferredProvider) continue;
		const provider = await getSearchProvider(id);
		if (await provider.isAvailable()) {
			providers.push(provider);
		}
	}

	return providers;
}
