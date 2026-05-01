/**
 * Google Gemini Web Search Provider
 *
 * Uses Gemini's Google Search grounding via Cloud Code Assist API.
 * Requires OAuth credentials stored in agent.db for provider "google-gemini-cli" or "google-antigravity".
 * Returns synthesized answers with citations and source metadata from grounding chunks.
 */
import {
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	extractRetryDelay,
	getAntigravityUserAgent,
	getGeminiCliHeaders,
} from "@oh-my-pi/pi-ai";
import { refreshAntigravityToken } from "@oh-my-pi/pi-ai/utils/oauth/google-antigravity";
import { refreshGoogleCloudToken } from "@oh-my-pi/pi-ai/utils/oauth/google-gemini-cli";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { AgentStorage } from "../../../session/agent-storage";
import type { SearchCitation, SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_ENDPOINT_FALLBACKS = [ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT] as const;
const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;

interface GeminiToolParams {
	google_search?: Record<string, unknown>;
	code_execution?: Record<string, unknown>;
	url_context?: Record<string, unknown>;
}

export interface GeminiSearchParams extends GeminiToolParams {
	query: string;
	system_prompt?: string;
	num_results?: number;
	/** Maximum output tokens. */
	max_output_tokens?: number;
	/** Sampling temperature (0–1). Lower = more focused/factual. */
	temperature?: number;
}

export function buildGeminiRequestTools(params: GeminiToolParams): Array<Record<string, Record<string, unknown>>> {
	const tools: Array<Record<string, Record<string, unknown>>> = [{ googleSearch: params.google_search ?? {} }];
	if (params.code_execution !== undefined) {
		tools.push({ codeExecution: params.code_execution });
	}
	if (params.url_context !== undefined) {
		tools.push({ urlContext: params.url_context });
	}
	return tools;
}

/** OAuth credential stored in agent.db */
interface GeminiOAuthCredential {
	type: "oauth";
	access: string;
	refresh?: string;
	expires: number;
	projectId?: string;
}

/** Auth info for Gemini API requests */
interface GeminiAuth {
	accessToken: string;
	refreshToken?: string;
	projectId: string;
	isAntigravity: boolean;
	storage: AgentStorage;
	credentialId: number;
	credential: GeminiOAuthCredential;
}

async function refreshGeminiAuth(auth: GeminiAuth): Promise<boolean> {
	if (!auth.refreshToken) return false;
	try {
		const refreshed = auth.isAntigravity
			? await refreshAntigravityToken(auth.refreshToken, auth.projectId)
			: await refreshGoogleCloudToken(auth.refreshToken, auth.projectId);
		auth.accessToken = refreshed.access;
		auth.refreshToken = refreshed.refresh ?? auth.refreshToken;
		auth.storage.updateAuthCredential(auth.credentialId, {
			...auth.credential,
			access: auth.accessToken,
			refresh: auth.refreshToken,
			expires: refreshed.expires,
		});
		auth.credential.access = auth.accessToken;
		auth.credential.refresh = auth.refreshToken;
		auth.credential.expires = refreshed.expires;
		return true;
	} catch {
		return false;
	}
}

/**
 * Finds valid Gemini OAuth credentials from agent.db.
 * Checks google-gemini-cli first (stable prod), then google-antigravity (daily sandbox).
 * @returns OAuth credential with access token and project ID, or null if none found
 */
export async function findGeminiAuth(): Promise<GeminiAuth | null> {
	const expiryBuffer = 5 * 60 * 1000; // 5 minutes
	const now = Date.now();

	// Try providers in deterministic order: gemini-cli first, then antigravity
	const providers = ["google-gemini-cli", "google-antigravity"] as const;

	try {
		const storage = await AgentStorage.open(getAgentDbPath());

		for (const provider of providers) {
			const records = storage.listAuthCredentials(provider);

			for (const record of records) {
				const credential = record.credential;
				if (credential.type !== "oauth") continue;

				const oauthCred = credential as GeminiOAuthCredential;
				if (!oauthCred.access) continue;

				// Get projectId from credential
				const projectId = oauthCred.projectId;
				if (!projectId) continue;

				// Check if token is expired (or about to expire)
				if (oauthCred.expires <= now + expiryBuffer) {
					// Try to refresh if we have a refresh token
					if (oauthCred.refresh) {
						try {
							const refreshed =
								provider === "google-antigravity"
									? await refreshAntigravityToken(oauthCred.refresh, projectId)
									: await refreshGoogleCloudToken(oauthCred.refresh, projectId);
							// Update the credential in storage
							const updated = {
								...oauthCred,
								access: refreshed.access,
								refresh: refreshed.refresh ?? oauthCred.refresh,
								expires: refreshed.expires,
							};
							storage.updateAuthCredential(record.id, updated);
							return {
								accessToken: refreshed.access,
								refreshToken: refreshed.refresh ?? oauthCred.refresh,
								projectId,
								isAntigravity: provider === "google-antigravity",
								storage,
								credentialId: record.id,
								credential: updated,
							};
						} catch {
							// Refresh failed, skip this credential
							continue;
						}
					}
					// No refresh token or refresh failed
					continue;
				}

				return {
					accessToken: oauthCred.access,
					refreshToken: oauthCred.refresh,
					projectId,
					isAntigravity: provider === "google-antigravity",
					storage,
					credentialId: record.id,
					credential: oauthCred,
				};
			}
		}
	} catch {
		return null;
	}

	return null;
}

/** Cloud Code Assist API response types */
interface GeminiGroundingChunk {
	web?: {
		uri?: string;
		title?: string;
	};
}

interface GeminiGroundingSupport {
	segment?: {
		startIndex?: number;
		endIndex?: number;
		text?: string;
	};
	groundingChunkIndices?: number[];
	confidenceScores?: number[];
}

interface GeminiGroundingMetadata {
	groundingChunks?: GeminiGroundingChunk[];
	groundingSupports?: GeminiGroundingSupport[];
	webSearchQueries?: string[];
}

interface CloudCodeResponseChunk {
	response?: {
		candidates?: Array<{
			content?: {
				role: string;
				parts?: Array<{ text?: string }>;
			};
			finishReason?: string;
			groundingMetadata?: GeminiGroundingMetadata;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			totalTokenCount?: number;
		};
		modelVersion?: string;
	};
}

/**
 * Calls the Cloud Code Assist API with Google Search grounding enabled.
 * @param auth - Authentication info (access token and project ID)
 * @param query - Search query from the user
 * @param systemPrompt - Optional system prompt
 * @returns Parsed response with answer, sources, and usage
 * @throws {SearchProviderError} If the API request fails
 */
async function callGeminiSearch(
	auth: GeminiAuth,
	query: string,
	systemPrompt?: string,
	maxOutputTokens?: number,
	temperature?: number,
	toolParams: GeminiToolParams = {},
): Promise<{
	answer: string;
	sources: SearchSource[];
	citations: SearchCitation[];
	searchQueries: string[];
	model: string;
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}> {
	const endpoints = auth.isAntigravity ? ANTIGRAVITY_ENDPOINT_FALLBACKS : [DEFAULT_ENDPOINT];
	const headers = auth.isAntigravity ? { "User-Agent": getAntigravityUserAgent() } : getGeminiCliHeaders();

	const requestMetadata = auth.isAntigravity
		? {
				requestType: "agent",
				userAgent: "antigravity",
				requestId: `agent-${crypto.randomUUID()}`,
			}
		: {
				userAgent: "pi-coding-agent",
				requestId: `pi-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
			};

	const normalizedSystemPrompt = systemPrompt?.toWellFormed();
	const systemInstructionParts: Array<{ text: string }> = [
		...(auth.isAntigravity
			? [
					{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
					{ text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
				]
			: []),
		...(normalizedSystemPrompt ? [{ text: normalizedSystemPrompt }] : []),
	];

	const requestBody: Record<string, unknown> = {
		project: auth.projectId,
		model: DEFAULT_MODEL,
		request: {
			contents: [
				{
					role: "user",
					parts: [{ text: query }],
				},
			],
			tools: buildGeminiRequestTools(toolParams),
			...(systemInstructionParts.length > 0 && {
				systemInstruction: {
					...(auth.isAntigravity ? { role: "user" } : {}),
					parts: systemInstructionParts,
				},
			}),
		},
		...requestMetadata,
	};

	if (maxOutputTokens !== undefined || temperature !== undefined) {
		const generationConfig: Record<string, number> = {};
		if (maxOutputTokens !== undefined) {
			generationConfig.maxOutputTokens = maxOutputTokens;
		}
		if (temperature !== undefined) {
			generationConfig.temperature = temperature;
		}
		(requestBody.request as Record<string, unknown>).generationConfig = generationConfig;
	}
	let response: Response | undefined;
	let rateLimitTimeSpent = 0;
	let lastError: Error | undefined;

	for (let endpointIndex = 0; endpointIndex < endpoints.length; endpointIndex++) {
		const url = `${endpoints[endpointIndex]}/v1internal:streamGenerateContent?alt=sse`;

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				response = await fetch(url, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${auth.accessToken}`,
						"Content-Type": "application/json",
						Accept: "text/event-stream",
						...headers,
					},
					body: JSON.stringify(requestBody),
				});
			} catch (error) {
				if (attempt < MAX_RETRIES) {
					await Bun.sleep(BASE_DELAY_MS * 2 ** attempt);
					continue;
				}

				if (auth.isAntigravity && endpointIndex < endpoints.length - 1) {
					break;
				}

				throw error;
			}

			if (response.ok) {
				break;
			}

			const errorText = await response.text();
			const canRefreshAuth =
				response.status === 401 ||
				response.status === 403 ||
				(response.status === 400 &&
					/api key not valid|invalid credentials|invalid authentication/i.test(errorText));
			if (canRefreshAuth && attempt === 0 && (await refreshGeminiAuth(auth))) {
				continue;
			}
			const isRetryableStatus =
				response.status === 429 ||
				response.status === 500 ||
				response.status === 502 ||
				response.status === 503 ||
				response.status === 504;

			if (isRetryableStatus && attempt < MAX_RETRIES) {
				const serverDelay = extractRetryDelay(errorText, response);
				if (response.status === 429) {
					if (serverDelay && rateLimitTimeSpent + serverDelay <= RATE_LIMIT_BUDGET_MS) {
						rateLimitTimeSpent += serverDelay;
						await Bun.sleep(serverDelay);
						continue;
					}
					if (!serverDelay) {
						await Bun.sleep(BASE_DELAY_MS * 2 ** attempt);
						continue;
					}
				} else {
					await Bun.sleep(serverDelay ?? BASE_DELAY_MS * 2 ** attempt);
					continue;
				}
			}

			lastError = new SearchProviderError(
				"gemini",
				`Gemini Cloud Code API error (${response.status}): ${errorText}`,
				response.status,
			);

			if (auth.isAntigravity && isRetryableStatus && endpointIndex < endpoints.length - 1) {
				break;
			}

			throw lastError;
		}

		if (response?.ok) {
			break;
		}
	}

	if (!response) {
		throw new SearchProviderError("gemini", "Gemini API request failed", 500);
	}

	if (!response.ok) {
		const errorText = await response.text();
		throw new SearchProviderError(
			"gemini",
			`Gemini Cloud Code API error (${response.status}): ${errorText}`,
			response.status,
		);
	}

	if (!response.body) {
		throw new SearchProviderError("gemini", "Gemini API returned no response body", 500);
	}

	// Parse SSE stream
	const answerParts: string[] = [];
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];
	const searchQueries: string[] = [];
	const seenUrls = new Set<string>();
	let model = DEFAULT_MODEL;
	let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.startsWith("data:")) continue;

				const jsonStr = line.slice(5).trim();
				if (!jsonStr) continue;

				let chunk: CloudCodeResponseChunk;
				try {
					chunk = JSON.parse(jsonStr) as CloudCodeResponseChunk;
				} catch {
					continue;
				}

				const responseData = chunk.response;
				if (!responseData) continue;

				const candidate = responseData.candidates?.[0];

				// Extract text content
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						if (part.text) {
							answerParts.push(part.text);
						}
					}
				}

				// Extract grounding metadata
				const groundingMetadata = candidate?.groundingMetadata;
				if (groundingMetadata) {
					// Extract sources from grounding chunks
					if (groundingMetadata.groundingChunks) {
						for (const grChunk of groundingMetadata.groundingChunks) {
							if (grChunk.web?.uri) {
								const sourceUrl = grChunk.web.uri;
								if (!seenUrls.has(sourceUrl)) {
									seenUrls.add(sourceUrl);
									sources.push({
										title: grChunk.web.title ?? sourceUrl,
										url: sourceUrl,
									});
								}
							}
						}
					}

					// Extract citations from grounding supports
					if (groundingMetadata.groundingSupports && groundingMetadata.groundingChunks) {
						for (const support of groundingMetadata.groundingSupports) {
							const citedText = support.segment?.text;
							const chunkIndices = support.groundingChunkIndices ?? [];

							for (const idx of chunkIndices) {
								const grChunk = groundingMetadata.groundingChunks[idx];
								if (grChunk?.web?.uri) {
									citations.push({
										url: grChunk.web.uri,
										title: grChunk.web.title ?? grChunk.web.uri,
										citedText,
									});
								}
							}
						}
					}

					// Extract search queries
					if (groundingMetadata.webSearchQueries) {
						for (const q of groundingMetadata.webSearchQueries) {
							if (!searchQueries.includes(q)) {
								searchQueries.push(q);
							}
						}
					}
				}

				// Extract usage metadata
				if (responseData.usageMetadata) {
					usage = {
						inputTokens: responseData.usageMetadata.promptTokenCount ?? 0,
						outputTokens: responseData.usageMetadata.candidatesTokenCount ?? 0,
						totalTokens: responseData.usageMetadata.totalTokenCount ?? 0,
					};
				}

				// Extract model version
				if (responseData.modelVersion) {
					model = responseData.modelVersion;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	return {
		answer: answerParts.join(""),
		sources,
		citations,
		searchQueries,
		model,
		usage,
	};
}

/**
 * Executes a web search using Google Gemini with Google Search grounding.
 * Requires OAuth credentials stored in agent.db for provider "google-gemini-cli" or "google-antigravity".
 * @param params - Search parameters including query and optional settings
 * @returns Search response with synthesized answer, sources, and citations
 * @throws {Error} If no Gemini OAuth credentials are configured
 */
export async function searchGemini(params: GeminiSearchParams): Promise<SearchResponse> {
	const auth = await findGeminiAuth();
	if (!auth) {
		throw new Error(
			"No Gemini OAuth credentials found. Login with 'omp /login google-gemini-cli' or 'omp /login google-antigravity' to enable Gemini web search.",
		);
	}

	const result = await callGeminiSearch(
		auth,
		params.query,
		params.system_prompt,
		params.max_output_tokens,
		params.temperature,
		{
			google_search: params.google_search,
			code_execution: params.code_execution,
			url_context: params.url_context,
		},
	);

	let sources = result.sources;

	// Apply num_results limit if specified
	if (params.num_results && sources.length > params.num_results) {
		sources = sources.slice(0, params.num_results);
	}

	return {
		provider: "gemini",
		answer: result.answer || undefined,
		sources,
		citations: result.citations.length > 0 ? result.citations : undefined,
		searchQueries: result.searchQueries.length > 0 ? result.searchQueries : undefined,
		usage: result.usage,
		model: result.model,
	};
}

/** Search provider for Google Gemini web search. */
export class GeminiProvider extends SearchProvider {
	readonly id = "gemini";
	readonly label = "Gemini";

	isAvailable() {
		return findGeminiAuth().then(Boolean);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchGemini({
			query: params.query,
			system_prompt: params.systemPrompt,
			num_results: params.numSearchResults ?? params.limit,
			max_output_tokens: params.maxOutputTokens,
			temperature: params.temperature,
			google_search: params.googleSearch,
			code_execution: params.codeExecution,
			url_context: params.urlContext,
		});
	}
}
