/**
 * Anthropic Web Search Provider
 *
 * Uses Claude's built-in web_search_20250305 tool to search the web.
 * Returns synthesized answers with citations and source metadata.
 */
import {
	type AnthropicAuthConfig,
	type AnthropicSystemBlock,
	buildAnthropicSearchHeaders,
	buildAnthropicSystemBlocks,
	buildAnthropicUrl,
	findAnthropicAuth,
	stripClaudeToolPrefix,
} from "@oh-my-pi/pi-ai";
import { $env } from "@oh-my-pi/pi-utils";
import type {
	AnthropicApiResponse,
	AnthropicCitation,
	SearchCitation,
	SearchResponse,
	SearchSource,
} from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TOKENS = 4096;
const WEB_SEARCH_TOOL_NAME = "web_search";
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";

export interface AnthropicSearchParams {
	query: string;
	system_prompt?: string;
	num_results?: number;
	/** Maximum output tokens. Defaults to 4096. */
	max_tokens?: number;
	/** Sampling temperature (0–1). Lower = more focused/factual. */
	temperature?: number;
}

/**
 * Gets the model to use for web search from environment or default.
 * @returns Model identifier string
 */
function getModel(): string {
	return $env.ANTHROPIC_SEARCH_MODEL ?? DEFAULT_MODEL;
}

/**
 * Builds system instruction blocks for the Anthropic API request.
 * @param auth - Authentication configuration
 * @param model - Model identifier (affects whether Claude Code instruction is included)
 * @param systemPrompt - Optional system prompt for guiding response style
 * @returns Array of system blocks for the API request
 */
function buildSystemBlocks(
	auth: AnthropicAuthConfig,
	model: string,
	systemPrompt?: string,
): AnthropicSystemBlock[] | undefined {
	const includeClaudeCode = !model.startsWith("claude-3-5-haiku");
	const extraInstructions = auth.isOAuth ? ["You are a helpful AI assistant with web search capabilities."] : [];

	return buildAnthropicSystemBlocks(systemPrompt ? [systemPrompt] : undefined, {
		includeClaudeCodeInstruction: includeClaudeCode,
		extraInstructions,
		cacheControl: { type: "ephemeral" },
	});
}

/**
 * Calls the Anthropic API with web search tool enabled.
 * @param auth - Authentication configuration (API key or OAuth)
 * @param model - Model identifier to use
 * @param query - Search query from the user
 * @param systemPrompt - Optional system prompt for guiding response style
 * @returns Raw API response from Anthropic
 * @throws {SearchProviderError} If the API request fails
 */
async function callSearch(
	auth: AnthropicAuthConfig,
	model: string,
	query: string,
	systemPrompt?: string,
	maxTokens?: number,
	temperature?: number,
): Promise<AnthropicApiResponse> {
	const url = buildAnthropicUrl(auth);
	const headers = buildAnthropicSearchHeaders(auth);

	const systemBlocks = buildSystemBlocks(auth, model, systemPrompt);

	const body: Record<string, unknown> = {
		model,
		max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
		messages: [{ role: "user", content: query }],
		tools: [
			{
				type: WEB_SEARCH_TOOL_TYPE,
				name: WEB_SEARCH_TOOL_NAME,
			},
		],
	};

	if (temperature !== undefined) {
		body.temperature = temperature;
	}

	if (systemBlocks && systemBlocks.length > 0) {
		body.system = systemBlocks;
	}

	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new SearchProviderError(
			"anthropic",
			`Anthropic API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	return response.json() as Promise<AnthropicApiResponse>;
}

/**
 * Parses a human-readable page age string into seconds.
 * @param pageAge - Age string like "2 days ago", "3h ago", "1 week ago"
 * @returns Age in seconds, or undefined if parsing fails
 */
function parsePageAge(pageAge: string | null | undefined): number | undefined {
	if (!pageAge) return undefined;

	const match = pageAge.match(/^(\d+)\s*(s|sec|second|m|min|minute|h|hour|d|day|w|week|mo|month|y|year)s?\s*(ago)?$/i);
	if (!match) return undefined;

	const value = parseInt(match[1], 10);
	const unit = match[2].toLowerCase();

	const multipliers: Record<string, number> = {
		s: 1,
		sec: 1,
		second: 1,
		m: 60,
		min: 60,
		minute: 60,
		h: 3600,
		hour: 3600,
		d: 86400,
		day: 86400,
		w: 604800,
		week: 604800,
		mo: 2592000,
		month: 2592000,
		y: 31536000,
		year: 31536000,
	};

	return value * (multipliers[unit] ?? 86400);
}

/**
 * Parses the Anthropic API response into a unified SearchResponse.
 * @param response - Raw API response containing content blocks
 * @returns Normalized response with answer, sources, citations, and usage
 */
function parseResponse(response: AnthropicApiResponse): SearchResponse {
	const answerParts: string[] = [];
	const searchQueries: string[] = [];
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];

	for (const block of response.content) {
		if (
			block.type === "server_tool_use" &&
			block.name &&
			stripClaudeToolPrefix(block.name) === WEB_SEARCH_TOOL_NAME
		) {
			// Intermediate search query
			if (block.input?.query) {
				searchQueries.push(block.input.query);
			}
		} else if (block.type === "web_search_tool_result" && block.content) {
			// Search results
			for (const result of block.content) {
				if (result.type === "web_search_result") {
					sources.push({
						title: result.title,
						url: result.url,
						snippet: undefined,
						publishedDate: result.page_age ?? undefined,
						ageSeconds: parsePageAge(result.page_age),
					});
				}
			}
		} else if (block.type === "text" && block.text) {
			// Synthesized answer with citations
			answerParts.push(block.text);
			if (block.citations) {
				for (const c of block.citations as AnthropicCitation[]) {
					citations.push({
						url: c.url,
						title: c.title,
						citedText: c.cited_text,
					});
				}
			}
		}
	}

	return {
		provider: "anthropic",
		answer: answerParts.join("\n\n") || undefined,
		sources,
		citations: citations.length > 0 ? citations : undefined,
		searchQueries: searchQueries.length > 0 ? searchQueries : undefined,
		usage: {
			inputTokens: response.usage.input_tokens,
			outputTokens: response.usage.output_tokens,
			searchRequests: response.usage.server_tool_use?.web_search_requests,
		},
		model: response.model,
		requestId: response.id,
	};
}

/**
 * Executes a web search using Anthropic's Claude with built-in web search tool.
 * @param params - Search parameters including query and optional settings
 * @returns Search response with synthesized answer, sources, and citations
 * @throws {Error} If no Anthropic credentials are configured
 */
export async function searchAnthropic(params: AnthropicSearchParams): Promise<SearchResponse> {
	const auth = await findAnthropicAuth();
	if (!auth) {
		throw new Error(
			"No Anthropic credentials found. Set ANTHROPIC_API_KEY or configure OAuth in ~/.omp/agent/agent.db",
		);
	}

	const model = getModel();
	const response = await callSearch(
		auth,
		model,
		params.query,
		params.system_prompt,
		params.max_tokens,
		params.temperature,
	);

	const result = parseResponse(response);

	// Apply num_results limit if specified
	if (params.num_results && result.sources.length > params.num_results) {
		result.sources = result.sources.slice(0, params.num_results);
	}

	return result;
}

/** Search provider for Anthropic Claude web search. */
export class AnthropicProvider extends SearchProvider {
	readonly id = "anthropic";
	readonly label = "Anthropic";

	isAvailable() {
		return findAnthropicAuth().then(Boolean);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchAnthropic({
			query: params.query,
			system_prompt: params.systemPrompt,
			num_results: params.numSearchResults ?? params.limit,
			max_tokens: params.maxOutputTokens,
			temperature: params.temperature,
		});
	}
}
