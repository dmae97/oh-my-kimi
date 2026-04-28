/**
 * Unified Web Search Tool
 *
 * Single tool supporting Anthropic, Perplexity, Exa, Brave, Jina, Kimi, Gemini, Codex, Tavily, Kagi, Z.AI, SearXNG, and Synthetic
 * providers with provider-specific parameters exposed conditionally.
 *
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import type { CustomTool, CustomToolContext, RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import webSearchSystemPrompt from "../../prompts/system/web-search.md" with { type: "text" };
import webSearchDescription from "../../prompts/tools/web-search.md" with { type: "text" };
import type { ToolSession } from "../../tools";
import { formatAge } from "../../tools/render-utils";
import { getSearchProvider, resolveProviderChain, type SearchProvider } from "./provider";
import { renderSearchCall, renderSearchResult, type SearchRenderDetails } from "./render";
import type { SearchProviderId, SearchResponse } from "./types";
import { SearchProviderError } from "./types";

/** Web search tool parameters schema */
export const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	recency: Type.Optional(
		StringEnum(["day", "week", "month", "year"], {
			description: "Recency filter (Brave, Perplexity)",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Max results to return" })),
	max_tokens: Type.Optional(Type.Number({ description: "Maximum output tokens" })),
	temperature: Type.Optional(Type.Number({ description: "Sampling temperature" })),
	num_search_results: Type.Optional(Type.Number({ description: "Number of search results to retrieve" })),
});

export type SearchToolParams = {
	query: string;
	recency?: "day" | "week" | "month" | "year";
	limit?: number;
	/** Maximum output tokens. Defaults to 4096. */
	max_tokens?: number;
	/** Sampling temperature (0–1). Lower = more focused/factual. Defaults to 0.2. */
	temperature?: number;
	/** Number of search results to retrieve. Defaults to 10. */
	num_search_results?: number;
};

export interface SearchQueryParams extends SearchToolParams {
	provider?: SearchProviderId | "auto";
}

function formatProviderList(providers: SearchProvider[]): string {
	return providers.map(provider => provider.label).join(", ");
}

function formatProviderError(error: unknown, provider: SearchProvider): string {
	if (error instanceof SearchProviderError) {
		if (error.provider === "anthropic" && error.status === 404) {
			return "Anthropic web search returned 404 (model or endpoint not found).";
		}
		if (error.status === 401 || error.status === 403) {
			if (error.provider === "zai") {
				return error.message;
			}
			return `${getSearchProvider(error.provider).label} authorization failed (${error.status}). Check API key or base URL.`;
		}
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return `Unknown error from ${provider.label}`;
}

/** Truncate text for tool output */
function truncateText(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function formatCount(label: string, count: number): string {
	return `${count} ${label}${count === 1 ? "" : "s"}`;
}

/** Format response for LLM consumption */
function formatForLLM(response: SearchResponse): string {
	const parts: string[] = [];

	if (response.answer) {
		parts.push(response.answer);
		if (response.sources.length > 0) {
			parts.push("\n## Sources");
			parts.push(formatCount("source", response.sources.length));
		}
	}

	for (const [i, src] of response.sources.entries()) {
		const age = formatAge(src.ageSeconds) || src.publishedDate;
		const agePart = age ? ` (${age})` : "";
		parts.push(`[${i + 1}] ${src.title}${agePart}\n    ${src.url}`);
		if (src.snippet) {
			parts.push(`    ${truncateText(src.snippet, 240)}`);
		}
	}

	if (response.citations && response.citations.length > 0) {
		parts.push("\n## Citations");
		parts.push(formatCount("citation", response.citations.length));
		for (const [i, citation] of response.citations.entries()) {
			const title = citation.title || citation.url;
			parts.push(`[${i + 1}] ${title}\n    ${citation.url}`);
			if (citation.citedText) {
				parts.push(`    ${truncateText(citation.citedText, 240)}`);
			}
		}
	}

	if (response.relatedQuestions && response.relatedQuestions.length > 0) {
		parts.push("\n## Related");
		parts.push(formatCount("question", response.relatedQuestions.length));
		for (const q of response.relatedQuestions) {
			parts.push(`- ${q}`);
		}
	}

	if (response.searchQueries && response.searchQueries.length > 0) {
		parts.push(`Search queries: ${response.searchQueries.length}`);
		for (const query of response.searchQueries.slice(0, 3)) {
			parts.push(`- ${truncateText(query, 120)}`);
		}
	}

	return parts.join("\n");
}

/** Execute web search */
async function executeSearch(
	_toolCallId: string,
	params: SearchQueryParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	const providers =
		params.provider && params.provider !== "auto"
			? (await getSearchProvider(params.provider).isAvailable())
				? [getSearchProvider(params.provider)]
				: await resolveProviderChain("auto")
			: await resolveProviderChain();
	if (providers.length === 0) {
		const message = "No web search provider configured.";
		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			details: { response: { provider: "none", sources: [] }, error: message },
		};
	}

	let lastError: unknown;
	let lastProvider = providers[0];

	for (const provider of providers) {
		lastProvider = provider;
		try {
			const response = await provider.search({
				query: params.query.replace(/202\d/g, String(new Date().getFullYear())), // LUL
				limit: params.limit,
				recency: params.recency,
				systemPrompt: webSearchSystemPrompt,
				maxOutputTokens: params.max_tokens,
				numSearchResults: params.num_search_results,
				temperature: params.temperature,
			});

			const text = formatForLLM(response);

			return {
				content: [{ type: "text" as const, text }],
				details: { response },
			};
		} catch (error) {
			lastError = error;
		}
	}

	const baseMessage = formatProviderError(lastError, lastProvider);
	const message =
		providers.length > 1
			? `All web search providers failed (${formatProviderList(providers)}). Last error: ${baseMessage}`
			: baseMessage;

	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { response: { provider: lastProvider.id, sources: [] }, error: message },
	};
}

/**
 * Execute a web search query for CLI/testing workflows.
 */
export async function runSearchQuery(
	params: SearchQueryParams,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	return executeSearch("cli-web-search", params);
}

/**
 * Web search tool implementation.
 *
 * Supports Anthropic, Perplexity, Exa, Brave, Jina, Kimi, Gemini, Codex, Z.AI, SearXNG, and Synthetic providers with automatic fallback.
 * Session is accepted for interface consistency but not used.
 */
export class WebSearchTool implements AgentTool<typeof webSearchSchema, SearchRenderDetails> {
	readonly name = "web_search";
	readonly label = "Web Search";
	readonly description: string;
	readonly parameters = webSearchSchema;
	readonly strict = true;

	constructor(_session: ToolSession) {
		this.description = prompt.render(webSearchDescription);
	}

	async execute(
		_toolCallId: string,
		params: SearchToolParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchRenderDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchRenderDetails>> {
		return executeSearch(_toolCallId, params);
	}
}

/** Web search tool as CustomTool (for TUI rendering support) */
export const webSearchCustomTool: CustomTool<typeof webSearchSchema, SearchRenderDetails> = {
	name: "web_search",
	label: "Web Search",
	description: prompt.render(webSearchDescription),
	parameters: webSearchSchema,

	async execute(
		toolCallId: string,
		params: SearchToolParams,
		_onUpdate,
		_ctx: CustomToolContext,
		_signal?: AbortSignal,
	) {
		return executeSearch(toolCallId, params);
	},

	renderCall(args: SearchToolParams, options: RenderResultOptions, theme: Theme) {
		return renderSearchCall(args, options, theme);
	},

	renderResult(result, options: RenderResultOptions, theme: Theme) {
		return renderSearchResult(result, options, theme);
	},
};

export function getSearchTools(): CustomTool<any, any>[] {
	return [webSearchCustomTool];
}

export { getSearchProvider, setPreferredSearchProvider } from "./provider";
export type { SearchProviderId as SearchProvider, SearchResponse } from "./types";
export { isSearchProviderPreference } from "./types";
