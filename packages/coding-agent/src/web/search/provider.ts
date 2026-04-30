import { AnthropicProvider } from "./providers/anthropic";
import type { SearchProvider } from "./providers/base";
import { BraveProvider } from "./providers/brave";
import { CodexProvider } from "./providers/codex";
import { ExaProvider } from "./providers/exa";
import { GeminiProvider } from "./providers/gemini";
import { JinaProvider } from "./providers/jina";
import { KagiProvider } from "./providers/kagi";
import { KimiProvider } from "./providers/kimi";
import { ParallelProvider } from "./providers/parallel";
import { PerplexityProvider } from "./providers/perplexity";
import { SearXNGProvider } from "./providers/searxng";
import { SyntheticProvider } from "./providers/synthetic";
import { TavilyProvider } from "./providers/tavily";
import { ZaiProvider } from "./providers/zai";
import type { SearchProviderId } from "./types";

export type { SearchParams } from "./providers/base";
export { SearchProvider } from "./providers/base";

const SEARCH_PROVIDERS: Record<SearchProviderId, SearchProvider> = {
	exa: new ExaProvider(),
	brave: new BraveProvider(),
	jina: new JinaProvider(),
	perplexity: new PerplexityProvider(),
	kimi: new KimiProvider(),
	zai: new ZaiProvider(),
	anthropic: new AnthropicProvider(),
	gemini: new GeminiProvider(),
	codex: new CodexProvider(),
	tavily: new TavilyProvider(),
	parallel: new ParallelProvider(),
	kagi: new KagiProvider(),
	synthetic: new SyntheticProvider(),
	searxng: new SearXNGProvider(),
} as const;

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

export function getSearchProvider(provider: SearchProviderId): SearchProvider {
	return SEARCH_PROVIDERS[provider];
}

/** Preferred provider set via settings (default: auto) */
let preferredProvId: SearchProviderId | "auto" = "auto";

/** Set the preferred web search provider from settings */
export function setPreferredSearchProvider(provider: SearchProviderId | "auto"): void {
	preferredProvId = provider;
}

/** Determine which providers are configured  */
export async function resolveProviderChain(
	preferredProvider: SearchProviderId | "auto" = preferredProvId,
): Promise<SearchProvider[]> {
	const providers: SearchProvider[] = [];

	if (preferredProvider !== "auto") {
		if (await getSearchProvider(preferredProvider).isAvailable()) {
			providers.push(getSearchProvider(preferredProvider));
		}
	}

	for (const id of SEARCH_PROVIDER_ORDER) {
		if (id === preferredProvider) continue;

		const provider = getSearchProvider(id);
		if (await provider.isAvailable()) {
			providers.push(provider);
		}
	}

	return providers;
}
