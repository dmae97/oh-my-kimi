/**
 * Unified Web Search Tool
 *
 * Single tool supporting Anthropic, Perplexity, Exa, Brave, Jina, Kimi, Gemini, Codex, Tavily, Kagi, Z.AI, SearXNG, and Synthetic
 * providers with provider-specific parameters exposed conditionally.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { settings } from "../../config/settings";
import type { CustomTool, CustomToolContext, RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import webSearchSystemPrompt from "../../prompts/system/web-search.md" with { type: "text" };
import webSearchDescription from "../../prompts/tools/web-search.md" with { type: "text" };
import { discoverAuthStorage } from "../../sdk";
import type { ToolSession } from "../../tools";
import { formatAge } from "../../tools/render-utils";
import { throwIfAborted } from "../../tools/tool-errors";
import {
	formatSearchProviderFailure,
	formatSearchProviderFailures,
	getSearchProvider,
	resolveProviderChain,
	type SearchProvider,
} from "./provider";
import { renderSearchCall, renderSearchResult, type SearchRenderDetails } from "./render";
import type { SearchProviderId, SearchResponse } from "./types";
import { SearchProviderError } from "./types";

/** Web search tool parameters schema */
export const webSearchSchema = type({
	query: "string",
	recency: "'day' | 'week' | 'month' | 'year'?",
	limit: "number?",
	max_tokens: "number?",
	temperature: "number?",
	num_search_results: "number?",
});

export type SearchToolParams = typeof webSearchSchema.infer;

export interface SearchQueryParams extends SearchToolParams {
	provider?: SearchProviderId | "auto";
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

function hasRenderableSearchContent(response: SearchResponse): boolean {
	if (response.answer?.trim()) return true;
	if (response.sources.length > 0) return true;
	if (response.citations?.length) return true;
	if (response.relatedQuestions?.some(question => question.trim())) return true;
	if (response.searchQueries?.some(query => query.trim())) return true;
	return false;
}

interface ExecuteSearchOptions {
	authStorage: AuthStorage;
	sessionId?: string;
	signal?: AbortSignal;
}

/** Execute web search */
async function executeSearch(
	_toolCallId: string,
	params: SearchQueryParams,
	options: ExecuteSearchOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	const { authStorage, sessionId, signal } = options;
	const explicitProvider = params.provider;
	let providers: SearchProvider[];
	if (explicitProvider && explicitProvider !== "auto") {
		const provider = await getSearchProvider(explicitProvider);
		providers = (await provider.isExplicitlyAvailable(authStorage))
			? [provider]
			: await resolveProviderChain(authStorage, "auto");
	} else if (explicitProvider === "auto") {
		// Explicit `--provider auto` bypasses the configured preferred provider
		// for this invocation; exclusions still apply.
		providers = await resolveProviderChain(authStorage, "auto");
	} else {
		providers = await resolveProviderChain(authStorage);
	}
	if (providers.length === 0) {
		const message = "No web search provider configured.";
		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			details: { response: { provider: "none", sources: [] }, error: message },
		};
	}

	// Invariant across providers; read once and tolerate an uninitialized
	// Settings singleton (e.g. `omp q ...` CLI path, unit tests) so the
	// provider-fallback loop never aborts before any provider runs.
	let antigravityEndpointMode: "auto" | "production" | "sandbox" | undefined;
	try {
		antigravityEndpointMode = settings.get("providers.antigravityEndpoint");
	} catch {
		antigravityEndpointMode = undefined;
	}

	let geminiModel: string | undefined;
	try {
		geminiModel = settings.get("providers.webSearchGeminiModel");
	} catch {
		geminiModel = undefined;
	}

	const failures: Array<{ provider: SearchProvider; error: unknown }> = [];
	let lastProvider = providers[0];
	for (const provider of providers) {
		lastProvider = provider;
		try {
			const response = await provider.search({
				query: params.query,
				limit: params.limit,
				recency: params.recency,
				systemPrompt: webSearchSystemPrompt,
				maxOutputTokens: params.max_tokens,
				numSearchResults: params.num_search_results,
				temperature: params.temperature,
				signal,
				authStorage,
				sessionId,
				antigravityEndpointMode,
				geminiModel,
			});

			if (!hasRenderableSearchContent(response)) {
				throw new SearchProviderError(provider.id, `${provider.label} returned no renderable search content.`, 204);
			}

			const text = formatForLLM(response);

			return {
				content: [{ type: "text" as const, text }],
				details: { response },
			};
		} catch (error) {
			// Surface user-initiated cancellation immediately so the session sees
			// a clean abort instead of a generic "all providers failed" message.
			// Without this, an AbortError from `fetch()` is treated as a provider
			// failure and the loop falls through to the next provider (or to the
			// summary error), masking the cancellation.
			throwIfAborted(signal);
			failures.push({ provider, error });
		}
	}

	const lastFailure = failures[failures.length - 1];
	const baseMessage = lastFailure
		? formatSearchProviderFailure(lastFailure.error, lastFailure.provider)
		: `Unknown error from ${lastProvider.label}`;
	const message =
		providers.length > 1 ? `All web search providers failed: ${formatSearchProviderFailures(failures)}` : baseMessage;

	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { response: { provider: lastProvider.id, sources: [] }, error: message },
	};
}

/**
 * Execute a web search query for CLI/testing workflows.
 *
 * `authStorage` may be omitted; in that case we discover one via the standard
 * factory (`discoverAuthStorage`), which honours `OMP_AUTH_BROKER_URL` and
 * otherwise opens the local SQLite credential store.
 */
export async function runSearchQuery(
	params: SearchQueryParams,
	options: { authStorage?: AuthStorage; sessionId?: string; signal?: AbortSignal } = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	const createdAuthStorage = options.authStorage ? undefined : await discoverAuthStorage();
	const authStorage = options.authStorage ?? createdAuthStorage;
	if (!authStorage) {
		throw new Error("Failed to initialize authentication storage");
	}
	try {
		return await executeSearch("cli-web-search", params, {
			authStorage,
			sessionId: options.sessionId,
			signal: options.signal,
		});
	} finally {
		createdAuthStorage?.close();
	}
}

/**
 * Web search tool implementation.
 *
 * Supports the configured web-search provider chain with automatic fallback.
 */
export class WebSearchTool implements AgentTool<typeof webSearchSchema, SearchRenderDetails> {
	readonly name = "web_search";
	readonly approval = "read" as const;
	readonly label = "Web Search";
	readonly description: string;
	readonly parameters = webSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search the web for up-to-date information";

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = prompt.render(webSearchDescription);
	}

	async execute(
		_toolCallId: string,
		params: SearchToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchRenderDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchRenderDetails>> {
		const authStorage = this.#session.authStorage ?? (await discoverAuthStorage());
		const sessionId = this.#session.getSessionId?.() ?? undefined;
		return executeSearch(_toolCallId, params, { authStorage, sessionId, signal });
	}
}

/** Web search tool as CustomTool (for TUI rendering support) */
export const webSearchCustomTool: CustomTool<typeof webSearchSchema, SearchRenderDetails> = {
	name: "web_search",
	label: "Web Search",
	description: prompt.render(webSearchDescription),
	parameters: webSearchSchema,

	approval: "read",
	async execute(
		toolCallId: string,
		params: SearchToolParams,
		_onUpdate,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	) {
		const authStorage = ctx.modelRegistry?.authStorage ?? (await discoverAuthStorage());
		const sessionId = ctx.sessionManager.getSessionId();
		return executeSearch(toolCallId, params, { authStorage, sessionId, signal });
	},

	renderCall(args: SearchToolParams, options: RenderResultOptions, theme: Theme) {
		return renderSearchCall(args, options, theme);
	},

	renderResult(result, options: RenderResultOptions, theme: Theme, args) {
		return renderSearchResult(result, options, theme, args);
	},
};

export function getSearchTools(): CustomTool<any, any>[] {
	return [webSearchCustomTool];
}

export { getSearchProvider, setExcludedSearchProviders, setPreferredSearchProvider } from "./provider";
export type { SearchProviderId as SearchProvider, SearchResponse } from "./types";
export { isSearchProviderId, isSearchProviderPreference } from "./types";
