// Lazy registry of web search providers.
//
// Each provider is loaded on first use; importing this module loads zero
// provider implementations. Provider modules are heavy (each pulls in
// fetch/parse/format helpers) and only one — at most — is needed per session,
// so eager construction was wasted work at startup.
//
// Provider modules are loaded lazily; display metadata lives in types.ts so UI
// listings can share it without importing provider implementations.

import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { SearchProvider } from "./providers/base";
import { SEARCH_PROVIDER_LABELS, SEARCH_PROVIDER_ORDER, SearchProviderError, type SearchProviderId } from "./types";

export type { SearchParams } from "./providers/base";
export { SearchProvider } from "./providers/base";
export { SEARCH_PROVIDER_ORDER } from "./types";

interface ProviderMeta {
	id: SearchProviderId;
	label: string;
	load: () => Promise<SearchProvider>;
}

/** Lazy factories. Each `load()` dynamic-imports its provider module on first call. */
const PROVIDER_META: Record<SearchProviderId, ProviderMeta> = {
	perplexity: {
		id: "perplexity",
		label: SEARCH_PROVIDER_LABELS.perplexity,
		load: async () => new (await import("./providers/perplexity")).PerplexityProvider(),
	},
	gemini: {
		id: "gemini",
		label: SEARCH_PROVIDER_LABELS.gemini,
		load: async () => new (await import("./providers/gemini")).GeminiProvider(),
	},
	anthropic: {
		id: "anthropic",
		label: SEARCH_PROVIDER_LABELS.anthropic,
		load: async () => new (await import("./providers/anthropic")).AnthropicProvider(),
	},
	codex: {
		id: "codex",
		label: SEARCH_PROVIDER_LABELS.codex,
		load: async () => new (await import("./providers/codex")).CodexProvider(),
	},
	xai: {
		id: "xai",
		label: SEARCH_PROVIDER_LABELS.xai,
		load: async () => new (await import("./providers/xai")).XAIProvider(),
	},
	zai: {
		id: "zai",
		label: SEARCH_PROVIDER_LABELS.zai,
		load: async () => new (await import("./providers/zai")).ZaiProvider(),
	},
	exa: {
		id: "exa",
		label: SEARCH_PROVIDER_LABELS.exa,
		load: async () => new (await import("./providers/exa")).ExaProvider(),
	},
	tinyfish: {
		id: "tinyfish",
		label: SEARCH_PROVIDER_LABELS.tinyfish,
		load: async () => new (await import("./providers/tinyfish")).TinyFishProvider(),
	},
	jina: {
		id: "jina",
		label: SEARCH_PROVIDER_LABELS.jina,
		load: async () => new (await import("./providers/jina")).JinaProvider(),
	},
	kagi: {
		id: "kagi",
		label: SEARCH_PROVIDER_LABELS.kagi,
		load: async () => new (await import("./providers/kagi")).KagiProvider(),
	},
	tavily: {
		id: "tavily",
		label: SEARCH_PROVIDER_LABELS.tavily,
		load: async () => new (await import("./providers/tavily")).TavilyProvider(),
	},
	firecrawl: {
		id: "firecrawl",
		label: SEARCH_PROVIDER_LABELS.firecrawl,
		load: async () => new (await import("./providers/firecrawl")).FirecrawlProvider(),
	},
	brave: {
		id: "brave",
		label: SEARCH_PROVIDER_LABELS.brave,
		load: async () => new (await import("./providers/brave")).BraveProvider(),
	},
	kimi: {
		id: "kimi",
		label: SEARCH_PROVIDER_LABELS.kimi,
		load: async () => new (await import("./providers/kimi")).KimiProvider(),
	},
	parallel: {
		id: "parallel",
		label: SEARCH_PROVIDER_LABELS.parallel,
		load: async () => new (await import("./providers/parallel")).ParallelProvider(),
	},
	synthetic: {
		id: "synthetic",
		label: SEARCH_PROVIDER_LABELS.synthetic,
		load: async () => new (await import("./providers/synthetic")).SyntheticProvider(),
	},
	searxng: {
		id: "searxng",
		label: SEARCH_PROVIDER_LABELS.searxng,
		load: async () => new (await import("./providers/searxng")).SearXNGProvider(),
	},
	duckduckgo: {
		id: "duckduckgo",
		label: SEARCH_PROVIDER_LABELS.duckduckgo,
		load: async () => new (await import("./providers/duckduckgo")).DuckDuckGoProvider(),
	},
};

const instanceCache = new Map<SearchProviderId, SearchProvider>();

/** Cheap, sync metadata accessor — never triggers a provider load. */
export function getSearchProviderLabel(id: SearchProviderId): string {
	return PROVIDER_META[id]?.label ?? id;
}

/** Format one provider failure for the user-facing fallback summary. */
export function formatSearchProviderFailure(error: unknown, provider: Pick<SearchProvider, "id" | "label">): string {
	if (error instanceof SearchProviderError) {
		if (error.provider === "anthropic" && error.status === 404) {
			return "Anthropic web search returned 404 (model or endpoint not found).";
		}
		if (error.status === 401 || error.status === 403) {
			if (error.provider === "zai") {
				return error.message;
			}
			return `${getSearchProviderLabel(error.provider)} authorization failed (${error.status}). Check API key or base URL.`;
		}
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return `Unknown error from ${provider.label}`;
}

/** Format the ordered provider fallback failures for terminal/tool output. */
export function formatSearchProviderFailures(
	failures: readonly { provider: Pick<SearchProvider, "id" | "label">; error: unknown }[],
): string {
	return failures.map(f => `${f.provider.id}: ${formatSearchProviderFailure(f.error, f.provider)}`).join("; ");
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

/** Preferred provider set via settings (default: auto) */
let preferredProvId: SearchProviderId | "auto" = "auto";

/** Set the preferred web search provider from settings */
export function setPreferredSearchProvider(provider: SearchProviderId | "auto"): void {
	preferredProvId = provider;
}

/** Providers excluded from web search resolution via settings. */
let excludedProvIds = new Set<SearchProviderId>();

/** Set providers that web search should never use, including fallbacks. */
export function setExcludedSearchProviders(providers: readonly SearchProviderId[]): void {
	excludedProvIds = new Set(providers);
}

function isSearchProviderExcluded(id: SearchProviderId): boolean {
	return excludedProvIds.has(id);
}

/**
 * Determine which providers are configured and currently available.
 * Each candidate is loaded (and its `isAvailable()` called) only as the chain
 * is walked, so unconfigured providers never pay the load cost.
 */
export async function resolveProviderChain(
	authStorage: AuthStorage,
	preferredProvider: SearchProviderId | "auto" = preferredProvId,
): Promise<SearchProvider[]> {
	const providers: SearchProvider[] = [];

	if (preferredProvider !== "auto" && !isSearchProviderExcluded(preferredProvider)) {
		const provider = await getSearchProvider(preferredProvider);
		if (await provider.isExplicitlyAvailable(authStorage)) {
			providers.push(provider);
		}
	}

	for (const id of SEARCH_PROVIDER_ORDER) {
		if (id === preferredProvider || isSearchProviderExcluded(id)) continue;
		const provider = await getSearchProvider(id);
		if (await provider.isAvailable(authStorage)) {
			providers.push(provider);
		}
	}

	return providers;
}
