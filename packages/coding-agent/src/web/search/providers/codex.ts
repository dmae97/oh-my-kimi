/**
 * OpenAI Codex Web Search Provider
 *
 * Uses Codex's built-in web_search tool via the Responses API.
 * Requires OAuth credentials stored in agent.db for provider "openai-codex".
 * Returns synthesized answers with web search sources.
 */
import * as os from "node:os";
import { decodeJwt } from "@oh-my-pi/pi-ai/utils/oauth/openai-codex";
import { $env, getAgentDbPath, readSseJson } from "@oh-my-pi/pi-utils";
import packageJson from "../../../../package.json" with { type: "json" };
import { AgentStorage } from "../../../session/agent-storage";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_RESPONSES_PATH = "/codex/responses";
const DEFAULT_MODEL = "gpt-5-codex-mini";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEFAULT_INSTRUCTIONS =
	"You are a helpful assistant with web search capabilities. Search the web to answer the user's question accurately and cite your sources.";

function getModel(): string {
	const configuredModel = $env.PI_CODEX_WEB_SEARCH_MODEL?.trim();
	return configuredModel ? configuredModel : DEFAULT_MODEL;
}

export interface CodexSearchParams {
	signal?: AbortSignal;
	query: string;
	system_prompt?: string;
	num_results?: number;
	/** Search context size: controls how much web content to include */
	search_context_size?: "low" | "medium" | "high";
}

/** OAuth credential stored in agent.db */
interface CodexOAuthCredential {
	type: "oauth";
	access: string;
	refresh?: string;
	expires: number;
	accountId?: string;
}

/** Codex API response structure */
interface CodexResponseItem {
	type: string;
	id?: string;
	role?: string;
	name?: string;
	call_id?: string;
	status?: string;
	arguments?: string;
	content?: CodexContentPart[];
	summary?: Array<{ type: string; text: string }>;
}

interface CodexContentPart {
	type: string;
	text?: string;
	annotations?: CodexAnnotation[];
}

interface CodexAnnotation {
	type: string;
	url?: string;
	title?: string;
	start_index?: number;
	end_index?: number;
}

interface CodexUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
}

interface CodexResponse {
	id?: string;
	model?: string;
	status?: string;
	usage?: CodexUsage;
}

function isImagePlaceholderAnswer(text: string): boolean {
	return text.trim().toLowerCase() === "(see attached image)";
}

/**
 * Extracts account ID from a Codex access token.
 * @param accessToken - JWT access token
 * @returns Account ID string, or null if not found
 */
function getAccountId(accessToken: string): string | null {
	const payload = decodeJwt(accessToken);
	const auth = payload?.[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
	const accountId = auth?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

/**
 * Finds valid Codex OAuth credentials from agent.db.
 * Checks agent credentials and returns the first non-expired credential.
 * @returns OAuth credential with access token and account ID, or null if none found
 */
async function findCodexAuth(): Promise<{ accessToken: string; accountId: string } | null> {
	const expiryBuffer = 5 * 60 * 1000; // 5 minutes
	const now = Date.now();

	try {
		const storage = await AgentStorage.open(getAgentDbPath());
		const records = storage.listAuthCredentials("openai-codex");

		for (const record of records) {
			const credential = record.credential;
			if (credential.type !== "oauth") continue;

			const oauthCred = credential as CodexOAuthCredential;
			if (!oauthCred.access) continue;
			if (oauthCred.expires <= now + expiryBuffer) continue;

			const accountId = oauthCred.accountId ?? getAccountId(oauthCred.access);
			if (!accountId) continue;

			return { accessToken: oauthCred.access, accountId };
		}
	} catch {
		return null;
	}

	return null;
}

/**
 * Builds HTTP headers for Codex API requests.
 * @param accessToken - OAuth access token
 * @param accountId - ChatGPT account ID
 * @returns Headers object for fetch requests
 */
function buildCodexHeaders(accessToken: string, accountId: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"chatgpt-account-id": accountId,
		"OpenAI-Beta": "responses=experimental",
		originator: "pi",
		"User-Agent": `pi/${packageJson.version} (${os.platform()} ${os.release()}; ${os.arch()})`,
		Accept: "text/event-stream",
		"Content-Type": "application/json",
	};
}

/**
 * Calls the Codex Responses API with web search tool enabled.
 * Streams the response and collects all events.
 * @param auth - Authentication info (access token and account ID)
 * @param query - Search query from the user
 * @param options - Search options including system prompt and context size
 * @returns Parsed response with answer, sources, and usage
 * @throws {SearchProviderError} If the API request fails
 */
async function callCodexSearch(
	auth: { accessToken: string; accountId: string },
	query: string,
	options: { signal?: AbortSignal; systemPrompt?: string; searchContextSize?: "low" | "medium" | "high" },
): Promise<{
	answer: string;
	sources: SearchSource[];
	model: string;
	requestId: string;
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}> {
	const url = `${CODEX_BASE_URL}${CODEX_RESPONSES_PATH}`;
	const headers = buildCodexHeaders(auth.accessToken, auth.accountId);

	const requestedModel = getModel();

	const body: Record<string, unknown> = {
		model: requestedModel,
		stream: true,
		store: false,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: query }],
			},
		],
		tools: [
			{
				type: "web_search",
				search_context_size: options.searchContextSize ?? "high",
			},
		],
		instructions: options.systemPrompt ?? DEFAULT_INSTRUCTIONS,
	};

	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new SearchProviderError("codex", `Codex API error (${response.status}): ${errorText}`, response.status);
	}

	if (!response.body) {
		throw new SearchProviderError("codex", "Codex API returned no response body", 500);
	}

	// Parse SSE stream
	const answerParts: string[] = [];
	const streamedAnswerParts: string[] = [];
	const sources: SearchSource[] = [];
	let model = requestedModel;
	let requestId = "";
	let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

	for await (const rawEvent of readSseJson<Record<string, unknown>>(response.body, options.signal)) {
		const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
		if (!eventType) continue;

		if (eventType === "response.output_text.delta") {
			const delta = typeof rawEvent.delta === "string" ? rawEvent.delta : "";
			if (delta) {
				streamedAnswerParts.push(delta);
			}
		} else if (eventType === "response.output_item.done") {
			const item = rawEvent.item as CodexResponseItem | undefined;
			if (!item) continue;

			// Handle text message content and extract sources from annotations
			if (item.type === "message" && item.content) {
				for (const part of item.content) {
					if (part.type === "output_text" && part.text) {
						answerParts.push(part.text);

						// Extract sources from url_citation annotations
						if (part.annotations) {
							for (const annotation of part.annotations) {
								if (annotation.type === "url_citation" && annotation.url) {
									// Deduplicate by URL
									if (!sources.some(s => s.url === annotation.url)) {
										sources.push({
											title: annotation.title ?? annotation.url,
											url: annotation.url,
										});
									}
								}
							}
						}
					}
				}
			}

			// Handle reasoning summary as part of answer
			if (item.type === "reasoning" && item.summary) {
				for (const part of item.summary) {
					if (part.type === "summary_text" && part.text) {
						answerParts.push(part.text);
					}
				}
			}
		} else if (eventType === "response.completed" || eventType === "response.done") {
			const resp = (rawEvent as { response?: CodexResponse }).response;
			if (resp) {
				if (resp.model) model = resp.model;
				if (resp.id) requestId = resp.id;
				if (resp.usage) {
					const cachedTokens = resp.usage.input_tokens_details?.cached_tokens ?? 0;
					usage = {
						inputTokens: (resp.usage.input_tokens ?? 0) - cachedTokens,
						outputTokens: resp.usage.output_tokens ?? 0,
						totalTokens: resp.usage.total_tokens ?? 0,
					};
				}
			}
		} else if (eventType === "error") {
			const code = (rawEvent as { code?: string }).code ?? "";
			const message = (rawEvent as { message?: string }).message ?? "Unknown error";
			throw new SearchProviderError("codex", `Codex error (${code}): ${message}`, 500);
		} else if (eventType === "response.failed") {
			const resp = (rawEvent as { response?: { error?: { message?: string } } }).response;
			const errorMessage = resp?.error?.message ?? "Request failed";
			throw new SearchProviderError("codex", `Codex request failed: ${errorMessage}`, 500);
		}
	}

	const finalAnswer = answerParts.join("\n\n").trim();
	const streamedAnswer = streamedAnswerParts.join("").trim();
	const answer =
		finalAnswer.length > 0 && !isImagePlaceholderAnswer(finalAnswer)
			? finalAnswer
			: streamedAnswer.length > 0
				? streamedAnswer
				: finalAnswer;

	return {
		answer,
		sources,
		model,
		requestId,
		usage,
	};
}

/**
 * Executes a web search using OpenAI Codex's built-in web search tool.
 * Requires OAuth credentials stored in agent.db for provider "openai-codex".
 * @param params - Search parameters including query and optional settings
 * @returns Search response with synthesized answer, sources, and usage
 * @throws {Error} If no Codex OAuth credentials are configured
 */
export async function searchCodex(params: CodexSearchParams): Promise<SearchResponse> {
	const auth = await findCodexAuth();
	if (!auth) {
		throw new Error(
			"No Codex OAuth credentials found. Login with 'omp /login openai-codex' to enable Codex web search.",
		);
	}

	const result = await callCodexSearch(auth, params.query, {
		systemPrompt: params.system_prompt,
		searchContextSize: params.search_context_size ?? "high",
	});

	let sources = result.sources;

	// Apply num_results limit if specified
	if (params.num_results && sources.length > params.num_results) {
		sources = sources.slice(0, params.num_results);
	}

	return {
		provider: "codex",
		answer: result.answer || undefined,
		sources,
		usage: result.usage
			? {
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
					totalTokens: result.usage.totalTokens,
				}
			: undefined,
		model: result.model,
		requestId: result.requestId,
	};
}

/**
 * Checks if Codex web search is available.
 * @returns True if valid OAuth credentials exist for openai-codex
 */
export async function hasCodexSearch(): Promise<boolean> {
	const auth = await findCodexAuth();
	return auth !== null;
}

/** Search provider for OpenAI Codex web search. */
export class CodexProvider extends SearchProvider {
	readonly id = "codex";
	readonly label = "Codex";

	isAvailable(): Promise<boolean> {
		return Promise.resolve(hasCodexSearch());
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchCodex({
			signal: params.signal,
			query: params.query,
			system_prompt: params.systemPrompt,
			num_results: params.numSearchResults ?? params.limit,
		});
	}
}
