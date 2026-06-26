/**
 * TinyFish Web Search Provider
 *
 * Calls TinyFish's search API and maps results into the unified
 * SearchResponse shape used by the web search tool.
 */
import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

const RECENCY_MINUTES: Record<NonNullable<SearchParams["recency"]>, number> = {
	day: 1440,
	week: 10080,
	month: 43200,
	year: 525600,
};

export interface TinyFishSearchParams {
	query: string;
	num_results?: number;
	recency?: SearchParams["recency"];
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

interface TinyFishSearchResult {
	title?: string | null;
	url?: string | null;
	snippet?: string | null;
	site_name?: string | null;
}

interface TinyFishSearchResponse {
	results?: TinyFishSearchResult[] | null;
}

/** Resolve TinyFish API key through the shared auth storage pipeline. */
export function findApiKey(
	authStorage: AuthStorage,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return authStorage.getApiKey("tinyfish", sessionId, { signal });
}

async function callTinyFishSearch(apiKey: string, params: TinyFishSearchParams): Promise<TinyFishSearchResponse> {
	const url = new URL(TINYFISH_SEARCH_URL);
	url.searchParams.set("query", params.query);
	if (params.recency) {
		url.searchParams.set("recency_minutes", String(RECENCY_MINUTES[params.recency]));
	}

	const response = await (params.fetch ?? fetch)(url, {
		method: "GET",
		headers: {
			Accept: "application/json",
			"X-API-Key": apiKey,
		},
		signal: withHardTimeout(params.signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("tinyfish", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError(
			"tinyfish",
			`TinyFish API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	return (await response.json()) as TinyFishSearchResponse;
}

/** Execute TinyFish web search. */
export async function searchTinyFish(params: SearchParams): Promise<SearchResponse> {
	const tinyFishParams: TinyFishSearchParams = {
		query: params.query,
		num_results: params.numSearchResults ?? params.limit,
		recency: params.recency,
		signal: params.signal,
		fetch: params.fetch,
	};
	const keyOrResolver: ApiKey = params.authStorage.resolver("tinyfish", {
		sessionId: params.sessionId,
	});
	const numResults = clampNumResults(tinyFishParams.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	const data = await withAuth(keyOrResolver, key => callTinyFishSearch(key, tinyFishParams), {
		signal: params.signal,
		missingKeyMessage:
			'TinyFish credentials not found. Set TINYFISH_API_KEY or configure an API key for provider "tinyfish".',
	});
	const sources: SearchSource[] = [];

	for (const result of data.results ?? []) {
		if (!result.url) continue;
		sources.push({
			title: result.title ?? result.site_name ?? result.url,
			url: result.url,
			snippet: result.snippet ?? undefined,
			author: result.site_name ?? undefined,
		});
	}

	return {
		provider: "tinyfish",
		sources: sources.slice(0, numResults),
		authMode: "api_key",
	};
}

/** Search provider for TinyFish web search. */
export class TinyFishProvider extends SearchProvider {
	readonly id = "tinyfish";
	readonly label = "TinyFish";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("tinyfish") || !!getEnvApiKey("tinyfish");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchTinyFish(params);
	}
}
