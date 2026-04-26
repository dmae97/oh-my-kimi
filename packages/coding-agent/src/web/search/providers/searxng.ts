/**
 * SearXNG Web Search Provider
 *
 * Calls a SearXNG instance's JSON search API and maps results into the unified
 * SearchResponse shape used by the web search tool.
 *
 * SearXNG is a free, open-source metasearch engine that aggregates results from
 * multiple sources without tracking users. It supports self-hosted instances
 * and various authentication methods (bearer token, basic auth, or none).
 *
 * Configuration via settings:
 *   searxng.endpoint  - Base URL of the SearXNG instance (e.g. https://searx.example.org)
 *   searxng.token     - Optional bearer token for authentication
 *   searxng.categories - Optional comma-separated categories filter
 *   searxng.language  - Optional language code (e.g. en, zh-CN)
 *
 * Environment variable fallbacks:
 *   SEARXNG_ENDPOINT  - Base URL of the SearXNG instance
 *   SEARXNG_TOKEN     - Optional bearer token
 *
 * Reference: https://docs.searxng.org/dev/search_api.html
 */

import { settings } from "../../../config/settings";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

/** Map our recency filter to SearXNG time_range parameter.
 *  SearXNG only supports day/month/year, so week maps to month. */
const RECENCY_MAP: Record<"day" | "week" | "month" | "year", string> = {
	day: "day",
	week: "month",
	month: "month",
	year: "year",
};

/** SearXNG JSON API response types */
interface SearXNGResult {
	title?: string;
	url?: string;
	content?: string;
	engine?: string;
	publishedDate?: string;
	/** SearXNG sometimes uses publishedDate, sometimes just date */
	published_date?: string;
	score?: number;
}

interface SearXNGResponse {
	query?: string;
	number_of_results?: number;
	results?: SearXNGResult[];
	suggestions?: string[];
	corrections?: string[];
	unresponsive_engines?: Array<[string, string]>;
}

/** Find SearXNG endpoint from settings or environment. */
function findEndpoint(): string | null {
	try {
		const endpoint = settings.get("searxng.endpoint");
		if (endpoint) return endpoint;
	} catch {
		// Settings not initialized yet
	}
	return process.env.SEARXNG_ENDPOINT ?? null;
}

/** Find SearXNG bearer token from settings or environment. */
function findToken(): string | null {
	try {
		const token = settings.get("searxng.token");
		if (token) return token;
	} catch {
		// Settings not initialized yet
	}
	return process.env.SEARXNG_TOKEN ?? null;
}

/** Build the search URL and headers for a SearXNG request */
function buildRequest(
	endpoint: string,
	params: {
		query: string;
		num_results?: number;
		recency?: "day" | "week" | "month" | "year";
		categories?: string;
		language?: string;
		signal?: AbortSignal;
	},
	token: string | null,
): { url: URL; headers: Record<string, string> } {
	const base = endpoint.replace(/\/+$/, "");
	const url = new URL(`${base}/search`);

	url.searchParams.set("q", params.query);
	url.searchParams.set("format", "json");

	if (params.num_results) {
		url.searchParams.set("pageno", "1");
	}

	if (params.recency) {
		url.searchParams.set("time_range", RECENCY_MAP[params.recency]);
	}

	if (params.categories) {
		url.searchParams.set("categories", params.categories);
	}

	if (params.language) {
		url.searchParams.set("language", params.language);
	}

	const headers: Record<string, string> = {
		Accept: "application/json",
	};

	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	return { url, headers };
}

async function callSearXNGSearch(
	endpoint: string,
	params: {
		query: string;
		num_results?: number;
		recency?: "day" | "week" | "month" | "year";
		categories?: string;
		language?: string;
		signal?: AbortSignal;
	},
	token: string | null,
): Promise<SearXNGResponse> {
	const { url, headers } = buildRequest(endpoint, params, token);

	const response = await fetch(url, {
		headers,
		signal: params.signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new SearchProviderError("searxng", `SearXNG API error (${response.status}): ${errorText}`, response.status);
	}

	return (await response.json()) as SearXNGResponse;
}

/** Execute SearXNG web search. */
export async function searchSearXNG(params: {
	query: string;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
}): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	const endpoint = findEndpoint();
	if (!endpoint) {
		throw new Error(
			"SearXNG endpoint not configured. Set searxng.endpoint in settings or SEARXNG_ENDPOINT in environment.",
		);
	}

	const token = findToken();

	let categories: string | undefined;
	let language: string | undefined;
	try {
		categories = settings.get("searxng.categories") ?? undefined;
		language = settings.get("searxng.language") ?? undefined;
	} catch {
		// Settings not initialized yet
	}

	const response = await callSearXNGSearch(
		endpoint,
		{
			...params,
			categories,
			language,
		},
		token,
	);

	const sources: SearchSource[] = [];

	for (const result of response.results ?? []) {
		if (!result.url) continue;
		const publishedDate = result.publishedDate ?? result.published_date;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.content?.trim() || undefined,
			publishedDate: publishedDate ?? undefined,
			ageSeconds: dateToAgeSeconds(publishedDate),
		});
	}

	return {
		provider: "searxng",
		sources: sources.slice(0, numResults),
		relatedQuestions: response.suggestions?.length ? response.suggestions : undefined,
	};
}

/** Search provider for SearXNG web search. */
export class SearXNGProvider extends SearchProvider {
	readonly id = "searxng";
	readonly label = "SearXNG";

	isAvailable() {
		try {
			return !!findEndpoint();
		} catch {
			return false;
		}
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchSearXNG({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			recency: params.recency,
			signal: params.signal,
		});
	}
}
