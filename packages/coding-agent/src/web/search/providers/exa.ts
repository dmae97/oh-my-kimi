/**
 * Exa Web Search Provider
 *
 * High-quality neural search via Exa Search API.
 * Returns structured search results with optional content extraction.
 * Requests per-result summaries via `contents.summary` and synthesizes
 * them into a combined `answer` string on the SearchResponse.
 */
import { type AuthStorage, getEnvApiKey } from "@oh-my-pi/pi-ai";
import { settings } from "../../../config/settings";
import { callExaTool, findApiKey, isSearchResponse } from "../../../exa/mcp-client";

import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const EXA_API_URL = "https://api.exa.ai/search";

type ExaSearchType = "neural" | "fast" | "auto" | "deep";

type ExaSearchParamType = ExaSearchType | "keyword";

export interface ExaSearchParams {
	query: string;
	num_results?: number;
	type?: ExaSearchParamType;
	include_domains?: string[];
	exclude_domains?: string[];
	start_published_date?: string;
	end_published_date?: string;
	signal?: AbortSignal;
	/**
	 * Credential source. Resolved before falling back to `EXA_API_KEY` so
	 * Exa works when the key is stored via the broker/auth pipeline.
	 */
	authStorage?: AuthStorage;
	sessionId?: string;
}

interface ExaSearchResult {
	title?: string | null;
	url?: string | null;
	author?: string | null;
	publishedDate?: string | null;
	text?: string | null;
	highlights?: string[] | null;
	summary?: string | null;
}

interface ExaSearchResponse {
	requestId?: string;
	resolvedSearchType?: string;
	results?: ExaSearchResult[];
	costDollars?: { total: number };
	searchTime?: number;
}
function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null) return null;
	return value as Record<string, unknown>;
}

function parseOptionalField(section: string, label: string): string | null | undefined {
	const regex = new RegExp(`(?:^|\\n)${label}:\\s*([^\\n]*)`);
	const match = section.match(regex);
	if (!match) return undefined;
	const value = match[1].trim();
	return value.length > 0 ? value : null;
}

function parseTextField(section: string): string | null | undefined {
	const match = section.match(/(?:^|\n)Text:\s*([\s\S]*)$/);
	if (!match) return undefined;
	const value = match[1].trim();
	return value.length > 0 ? value : null;
}

function parseExaMcpTextPayload(payload: unknown): ExaSearchResponse | null {
	const root = asRecord(payload);
	if (!root) return null;

	const content = root.content;
	if (!Array.isArray(content)) return null;

	const textBlocks = content
		.map(item => {
			const part = asRecord(item);
			const text = typeof part?.text === "string" ? part.text : "";
			return text.replace(/\r\n?/g, "\n").trim();
		})
		.filter(text => text.length > 0);

	if (textBlocks.length === 0) return null;

	const sections = textBlocks
		.join("\n\n")
		.split(/\n{2,}(?=Title:\s*[^\n]*(?:\n(?:URL|Author|Published Date|Text):))/)
		.map(section => section.trim())
		.filter(section => section.startsWith("Title:"));

	const results: ExaSearchResult[] = [];
	for (const section of sections) {
		const title = parseOptionalField(section, "Title");
		const url = parseOptionalField(section, "URL");
		const author = parseOptionalField(section, "Author");
		const publishedDate = parseOptionalField(section, "Published Date");
		const text = parseTextField(section);

		if (!title && !url && !text) continue;

		results.push({
			title: title ?? undefined,
			url: url ?? undefined,
			author: author ?? undefined,
			publishedDate: publishedDate ?? undefined,
			text: text ?? undefined,
		});
	}

	if (results.length === 0) return null;
	return { results };
}

export function normalizeSearchType(type: ExaSearchParamType | undefined): ExaSearchType {
	if (!type) return "auto";
	if (type === "keyword") return "fast";
	return type;
}

/** Maximum number of per-result summaries to include in the synthesized answer. */
const MAX_ANSWER_SUMMARIES = 3;

/**
 * Synthesize an answer string from per-result summaries returned by Exa.
 * Returns `undefined` when no non-empty summaries are available so callers
 * can leave `SearchResponse.answer` unset (matching other providers).
 */
export function synthesizeAnswer(results: ExaSearchResult[]): string | undefined {
	const parts: string[] = [];
	for (const r of results) {
		if (parts.length >= MAX_ANSWER_SUMMARIES) break;
		const summary = r.summary?.trim();
		if (!summary) continue;
		const title = r.title?.trim() || r.url || "Untitled";
		parts.push(`**${title}**: ${summary}`);
	}
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Build the request body for `callExaSearch`. Exported for testing. */
export function buildExaRequestBody(params: ExaSearchParams): Record<string, unknown> {
	const body: Record<string, unknown> = {
		query: params.query,
		numResults: params.num_results ?? 10,
		type: normalizeSearchType(params.type),
		contents: {
			summary: { query: params.query },
		},
	};

	if (params.include_domains?.length) {
		body.includeDomains = params.include_domains;
	}
	if (params.exclude_domains?.length) {
		body.excludeDomains = params.exclude_domains;
	}
	if (params.start_published_date) {
		body.startPublishedDate = params.start_published_date;
	}
	if (params.end_published_date) {
		body.endPublishedDate = params.end_published_date;
	}

	return body;
}

/** Call Exa Search API */
async function callExaSearch(apiKey: string, params: ExaSearchParams): Promise<ExaSearchResponse> {
	const body = buildExaRequestBody(params);

	const response = await fetch(EXA_API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
		},
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("exa", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("exa", `Exa API error (${response.status}): ${errorText}`, response.status);
	}

	return response.json() as Promise<ExaSearchResponse>;
}
function buildExaMcpArgs(params: ExaSearchParams): Record<string, unknown> {
	const args: Record<string, unknown> = { query: params.query };
	if (params.num_results !== undefined) args.num_results = params.num_results;
	if (params.type !== undefined) args.type = params.type;
	if (params.include_domains !== undefined) args.include_domains = params.include_domains;
	if (params.exclude_domains !== undefined) args.exclude_domains = params.exclude_domains;
	if (params.start_published_date !== undefined) args.start_published_date = params.start_published_date;
	if (params.end_published_date !== undefined) args.end_published_date = params.end_published_date;
	return args;
}

async function callExaMcpSearch(params: ExaSearchParams): Promise<ExaSearchResponse> {
	const response = await callExaTool("web_search_exa", buildExaMcpArgs(params), findApiKey(), {
		signal: withHardTimeout(params.signal),
	});
	if (isSearchResponse(response)) {
		return response as ExaSearchResponse;
	}

	const parsed = parseExaMcpTextPayload(response);
	if (parsed) {
		return parsed;
	}

	throw new Error("Exa MCP search returned unexpected response shape.");
}

/** Execute Exa web search */
export async function searchExa(params: ExaSearchParams): Promise<SearchResponse> {
	const storedKey = params.authStorage
		? await params.authStorage.getApiKey("exa", params.sessionId, { signal: params.signal })
		: undefined;
	const apiKey = storedKey ?? getEnvApiKey("exa");
	const response = apiKey ? await callExaSearch(apiKey, params) : await callExaMcpSearch(params);

	// Convert to unified SearchResponse
	const sources: SearchSource[] = [];

	if (response.results) {
		for (const result of response.results) {
			if (!result.url) continue;
			sources.push({
				title: result.title ?? result.url,
				url: result.url,
				snippet: result.summary || result.text || result.highlights?.join(" ") || undefined,
				publishedDate: result.publishedDate ?? undefined,
				ageSeconds: dateToAgeSeconds(result.publishedDate ?? undefined),
				author: result.author ?? undefined,
			});
		}
	}

	// Apply num_results limit if specified
	const limitedSources = params.num_results ? sources.slice(0, params.num_results) : sources;

	// Synthesize answer only from results that have a URL (same guard as sources loop)
	const answer = response.results ? synthesizeAnswer(response.results.filter(r => !!r.url)) : undefined;

	return {
		provider: "exa",
		answer,
		sources: limitedSources,
		requestId: response.requestId,
	};
}

/** Search provider for Exa. */
export class ExaProvider extends SearchProvider {
	readonly id = "exa";
	readonly label = "Exa";

	isAvailable(authStorage: AuthStorage): boolean {
		if (!this.#settingsAllowSearch()) return false;
		return !!getEnvApiKey("exa") || authStorage.hasAuth("exa");
	}

	/**
	 * Exa ships an unauthenticated public MCP fallback, so an explicit
	 * selection (programmatic or via `providers.webSearch: exa`) routes
	 * through MCP even when no credential is configured. The auto chain
	 * still uses {@link isAvailable} so an unrelated configured provider
	 * keeps priority over the public fallback.
	 */
	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return this.#settingsAllowSearch();
	}

	#settingsAllowSearch(): boolean {
		try {
			if (settings.get("exa.enabled") === false || settings.get("exa.enableSearch") === false) {
				return false;
			}
		} catch {
			// Settings may be unavailable before CLI initialization; assume not disabled.
		}
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchExa({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
		});
	}
}
