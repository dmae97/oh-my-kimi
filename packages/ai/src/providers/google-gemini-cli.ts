/**
 * Google Gemini CLI / Antigravity provider.
 * Shared implementation for both google-gemini-cli and google-antigravity providers.
 * Uses the Cloud Code Assist API endpoint to access Gemini and Claude models.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Content, FunctionCallingConfigMode, ThinkingConfig } from "@google/genai";
import { abortableSleep, readSseJson } from "@oh-my-pi/pi-utils";
import { calculateCost } from "../models";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { appendRawHttpRequestDumpFor400, type RawHttpRequestDump, withHttpStatus } from "../utils/http-inspector";
import { refreshAntigravityToken } from "../utils/oauth/google-antigravity";
import { refreshGoogleCloudToken } from "../utils/oauth/google-gemini-cli";
import { extractHttpStatusFromError } from "../utils/retry";
import { sanitizeSchemaForCCA } from "../utils/schema";
import {
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	extractRetryDelay,
	getAntigravityHeaders,
	getGeminiCliHeaders,
} from "./google-gemini-headers";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapStopReasonString,
	mapToolChoice,
	retainThoughtSignature,
} from "./google-shared";

/**
 * Thinking level for Gemini 3 models.
 * Mirrors Google's ThinkingLevel enum values.
 */
export type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export interface GoogleGeminiCliOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	/**
	 * Thinking/reasoning configuration.
	 * - Gemini 2.x models: use `budgetTokens` to set the thinking budget
	 * - Gemini 3 models (gemini-3-pro-*, gemini-3-flash-*): use `level` instead
	 *
	 * When using `streamSimple`, this is handled automatically based on the model.
	 */
	thinking?: {
		enabled: boolean;
		/** Thinking budget in tokens. Use for Gemini 2.x models. */
		budgetTokens?: number;
		/** Thinking level. Use for Gemini 3 models (LOW/HIGH for Pro, MINIMAL/LOW/MEDIUM/HIGH for Flash). */
		level?: GoogleThinkingLevel;
	};
	projectId?: string;
}

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_ENDPOINT_FALLBACKS = [ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT] as const;

export { getAntigravityUserAgent } from "./antigravity-user-agent";
export {
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	extractRetryDelay,
	getAntigravityHeaders as getAntigravityAuthHeaders,
	getAntigravityHeaders,
	getGeminiCliHeaders,
	getGeminiCliUserAgent,
	getGeminiCliUserAgentValue,
} from "./google-gemini-headers";

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

// Retry configuration
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_EMPTY_STREAM_RETRIES = 2;
const EMPTY_STREAM_BASE_DELAY_MS = 500;
const RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;
const CLAUDE_THINKING_BETA_HEADER = "interleaved-thinking-2025-05-14";
const GOOGLE_GEMINI_REFRESH_SKEW_MS = 60_000;
const ANTIGRAVITY_REFRESH_SKEW_MS = 60_000;

function isClaudeModel(modelId: string): boolean {
	return modelId.toLowerCase().includes("claude");
}

function needsClaudeThinkingBetaHeader(model: Model<"google-gemini-cli">): boolean {
	return model.provider === "google-antigravity" && model.id.startsWith("claude-") && model.reasoning;
}

function shouldInjectAntigravitySystemInstruction(modelId: string): boolean {
	const normalized = modelId.toLowerCase();
	return normalized.includes("claude") || normalized.includes("gemini-3-pro-high");
}

/**
 * Check if an error is retryable (rate limit, server error, network error, etc.)
 */
function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	return /resource.?exhausted|rate.?limit|overloaded|service.?unavailable|other.?side.?closed/i.test(errorText);
}

/**
 * Extract a clean, user-friendly error message from Google API error response.
 * Parses JSON error responses and returns just the message field.
 */
function extractErrorMessage(errorText: string): string {
	try {
		const parsed = JSON.parse(errorText) as { error?: { message?: string } };
		if (parsed.error?.message) {
			return parsed.error.message;
		}
	} catch {
		// Not JSON, return as-is
	}
	return errorText;
}

interface GeminiCliApiKeyPayload {
	token?: unknown;
	projectId?: unknown;
	project_id?: unknown;
	refreshToken?: unknown;
	expiresAt?: unknown;
	refresh?: unknown;
	expires?: unknown;
}
interface ParsedGeminiCliCredentials {
	accessToken: string;
	projectId: string;
	refreshToken?: string;
	expiresAt?: number;
}

function normalizeExpiryMs(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	return value < 10_000_000_000 ? value * 1000 : value;
}

export function parseGeminiCliCredentials(apiKeyRaw: string): ParsedGeminiCliCredentials {
	const invalidCredentialsMessage = "Invalid Google Cloud Code Assist credentials. Use /login to re-authenticate.";
	const missingCredentialsMessage =
		"Missing token or projectId in Google Cloud credentials. Use /login to re-authenticate.";

	let parsed: GeminiCliApiKeyPayload;
	try {
		parsed = JSON.parse(apiKeyRaw) as GeminiCliApiKeyPayload;
	} catch {
		throw new Error(invalidCredentialsMessage);
	}

	const projectId =
		typeof parsed.projectId === "string"
			? parsed.projectId
			: typeof parsed.project_id === "string"
				? parsed.project_id
				: undefined;

	if (typeof parsed.token !== "string" || typeof projectId !== "string") {
		throw new Error(missingCredentialsMessage);
	}

	const refreshToken =
		typeof parsed.refreshToken === "string"
			? parsed.refreshToken
			: typeof parsed.refresh === "string"
				? parsed.refresh
				: undefined;
	const expiresAt = normalizeExpiryMs(parsed.expiresAt ?? parsed.expires);

	return {
		accessToken: parsed.token,
		projectId,
		refreshToken,
		expiresAt,
	};
}

export function shouldRefreshGeminiCliCredentials(
	expiresAt: number | undefined,
	isAntigravity: boolean,
	nowMs = Date.now(),
): boolean {
	if (expiresAt === undefined) {
		return false;
	}

	const skewMs = isAntigravity ? ANTIGRAVITY_REFRESH_SKEW_MS : GOOGLE_GEMINI_REFRESH_SKEW_MS;
	return nowMs + skewMs >= expiresAt;
}

async function refreshGeminiCliCredentialsIfNeeded(
	credentials: ParsedGeminiCliCredentials,
	isAntigravity: boolean,
): Promise<ParsedGeminiCliCredentials> {
	if (!credentials.refreshToken || !shouldRefreshGeminiCliCredentials(credentials.expiresAt, isAntigravity)) {
		return credentials;
	}

	try {
		const refreshed = isAntigravity
			? await refreshAntigravityToken(credentials.refreshToken, credentials.projectId)
			: await refreshGoogleCloudToken(credentials.refreshToken, credentials.projectId);
		return {
			accessToken: refreshed.access,
			projectId: credentials.projectId,
			refreshToken: refreshed.refresh,
			expiresAt: refreshed.expires,
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		// Permanent auth failure (revoked/invalid token) — re-authentication required.
		// Google returns 400 invalid_grant when a token is revoked or expired server-side.
		if (/invalid_grant|invalid_token|token.*revoked|account.*disabled/i.test(reason)) {
			throw new Error(`OAuth token has been revoked or invalidated. Use /login to re-authenticate. (${reason})`);
		}
		// Transient failure (network, 5xx) — fall back to existing token if not yet expired.
		if (credentials.expiresAt !== undefined && Date.now() >= credentials.expiresAt) {
			throw new Error(`OAuth token refresh failed before request: ${reason}`);
		}
		return credentials;
	}
}
interface CloudCodeAssistRequest {
	project: string;
	model: string;
	request: {
		contents: Content[];
		sessionId?: string;
		systemInstruction?: { role?: string; parts: { text: string }[] };
		generationConfig?: {
			maxOutputTokens?: number;
			temperature?: number;
			topP?: number;
			topK?: number;
			minP?: number;
			presencePenalty?: number;
			repetitionPenalty?: number;
			thinkingConfig?: ThinkingConfig;
		};
		tools?: { functionDeclarations: Record<string, unknown>[] }[] | undefined;
		toolConfig?: {
			functionCallingConfig: {
				mode: FunctionCallingConfigMode;
			};
		};
	};
	requestType?: string;
	userAgent?: string;
	requestId?: string;
}

interface CloudCodeAssistResponseChunk {
	response?: {
		candidates?: Array<{
			content?: {
				role: string;
				parts?: Array<{
					text?: string;
					thought?: boolean;
					thoughtSignature?: string;
					functionCall?: {
						name: string;
						args: Record<string, unknown>;
						id?: string;
					};
				}>;
			};
			finishReason?: string;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
			cachedContentTokenCount?: number;
		};
		modelVersion?: string;
		responseId?: string;
	};
	traceId?: string;
}

export const streamGoogleGeminiCli: StreamFunction<"google-gemini-cli"> = (
	model: Model<"google-gemini-cli">,
	context: Context,
	options?: GoogleGeminiCliOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-gemini-cli" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let rawRequestDump: RawHttpRequestDump | undefined;

		try {
			const apiKeyRaw = options?.apiKey;
			if (!apiKeyRaw) {
				throw new Error("Google Cloud Code Assist requires OAuth authentication. Use /login to authenticate.");
			}

			const isAntigravity = model.provider === "google-antigravity";
			const parsedCredentials = parseGeminiCliCredentials(apiKeyRaw);
			const activeCredentials = await refreshGeminiCliCredentialsIfNeeded(parsedCredentials, isAntigravity);
			const { accessToken, projectId } = activeCredentials;

			const baseUrl = model.baseUrl?.trim();
			const endpoints = baseUrl ? [baseUrl] : isAntigravity ? ANTIGRAVITY_ENDPOINT_FALLBACKS : [DEFAULT_ENDPOINT];

			let requestBody = buildRequest(model, context, projectId, options, isAntigravity);
			const replacementPayload = await options?.onPayload?.(requestBody, model);
			if (replacementPayload !== undefined) {
				requestBody = replacementPayload as typeof requestBody;
			}
			const headers = isAntigravity ? getAntigravityHeaders() : getGeminiCliHeaders(model.id);

			const requestHeaders = {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				...headers,
				...(needsClaudeThinkingBetaHeader(model) ? { "anthropic-beta": CLAUDE_THINKING_BETA_HEADER } : {}),
				...(options?.headers ?? {}),
			};
			const requestBodyJson = JSON.stringify(requestBody);
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				body: requestBody,
				headers: requestHeaders,
			};

			// Fetch with retry logic for rate limits and transient errors
			let response: Response | undefined;
			let lastError: Error | undefined;
			let requestUrl: string | undefined;
			let rateLimitTimeSpent = 0;

			for (let attempt = 0; ; attempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				try {
					const endpoint = endpoints[Math.min(attempt, endpoints.length - 1)];
					requestUrl = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;
					response = await fetch(requestUrl, {
						method: "POST",
						headers: requestHeaders,
						body: requestBodyJson,
						signal: options?.signal,
					});

					if (response.ok) {
						break; // Success, exit retry loop
					}

					const errorText = await response.text();

					// Handle 429 rate limits with time budget
					if (response.status === 429) {
						if (/quota|exhausted/i.test(errorText)) {
							throw withHttpStatus(
								new Error(`Cloud Code Assist API error (429): ${extractErrorMessage(errorText)}`),
								429,
							);
						}
						const serverDelay = extractRetryDelay(errorText, response);
						if (serverDelay && rateLimitTimeSpent + serverDelay <= RATE_LIMIT_BUDGET_MS) {
							rateLimitTimeSpent += serverDelay;
							await abortableSleep(serverDelay, options?.signal);
							continue;
						}
						// Fallback: use exponential backoff if no server delay, up to MAX_RETRIES
						if (!serverDelay && attempt < MAX_RETRIES) {
							await abortableSleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
							continue;
						}
					} else if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
						// Non-429 retryable errors use standard attempt cap
						const serverDelay = extractRetryDelay(errorText, response);
						const delayMs = serverDelay ?? BASE_DELAY_MS * 2 ** attempt;

						// Check if server delay exceeds max allowed (default: 60s) for non-429 errors
						const maxDelayMs = options?.maxRetryDelayMs ?? 60000;
						if (maxDelayMs > 0 && serverDelay && serverDelay > maxDelayMs) {
							const delaySeconds = Math.ceil(serverDelay / 1000);
							throw withHttpStatus(
								new Error(
									`Server requested ${delaySeconds}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${extractErrorMessage(errorText)}`,
								),
								response.status,
							);
						}

						await abortableSleep(delayMs, options?.signal);
						continue;
					}

					// Not retryable or budget exceeded
					throw withHttpStatus(
						new Error(`Cloud Code Assist API error (${response.status}): ${extractErrorMessage(errorText)}`),
						response.status,
					);
				} catch (error) {
					// Check for abort - fetch throws AbortError, our code throws "Request was aborted"
					if (error instanceof Error) {
						if (error.name === "AbortError" || error.message === "Request was aborted") {
							throw new Error("Request was aborted");
						}
					}

					// HTTP responses are handled inside the try block.
					// If we intentionally throw with status metadata, don't convert it into a network retry.
					if (extractHttpStatusFromError(error) !== undefined) {
						throw error;
					}
					// Extract detailed error message from fetch errors (Node includes cause)
					lastError = error instanceof Error ? error : new Error(String(error));
					if (lastError.message === "fetch failed" && lastError.cause instanceof Error) {
						lastError = new Error(`Network error: ${lastError.cause.message}`);
					}
					// Network errors are retryable
					if (attempt < MAX_RETRIES) {
						const delayMs = BASE_DELAY_MS * 2 ** attempt;
						await abortableSleep(delayMs, options?.signal);
						continue;
					}
					throw lastError;
				}
			}

			if (!response?.ok) {
				throw lastError ?? new Error("Failed to get response after retries");
			}

			let started = false;
			const ensureStarted = () => {
				if (!started) {
					if (!firstTokenTime) firstTokenTime = Date.now();
					stream.push({ type: "start", partial: output });
					started = true;
				}
			};

			const resetOutput = () => {
				output.content = [];
				output.usage = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				output.stopReason = "stop";
				output.errorMessage = undefined;
				output.timestamp = Date.now();
				started = false;
			};

			const streamResponse = async (activeResponse: Response): Promise<boolean> => {
				if (!activeResponse.body) {
					throw new Error("No response body");
				}

				let hasContent = false;
				let currentBlock: TextContent | ThinkingContent | null = null;
				const blocks = output.content;
				const blockIndex = () => blocks.length - 1;

				for await (const chunk of readSseJson<CloudCodeAssistResponseChunk>(
					activeResponse.body!,
					options?.signal,
				)) {
					const responseData = chunk.response;
					if (!responseData) continue;

					const candidate = responseData.candidates?.[0];
					if (candidate?.content?.parts) {
						for (const part of candidate.content.parts) {
							if (part.text !== undefined) {
								hasContent = true;
								const isThinking = isThinkingPart(part);
								if (
									!currentBlock ||
									(isThinking && currentBlock.type !== "thinking") ||
									(!isThinking && currentBlock.type !== "text")
								) {
									if (currentBlock) {
										if (currentBlock.type === "text") {
											stream.push({
												type: "text_end",
												contentIndex: blocks.length - 1,
												content: currentBlock.text,
												partial: output,
											});
										} else {
											stream.push({
												type: "thinking_end",
												contentIndex: blockIndex(),
												content: currentBlock.thinking,
												partial: output,
											});
										}
									}
									if (isThinking) {
										currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
										output.content.push(currentBlock);
										ensureStarted();
										stream.push({
											type: "thinking_start",
											contentIndex: blockIndex(),
											partial: output,
										});
									} else {
										currentBlock = { type: "text", text: "" };
										output.content.push(currentBlock);
										ensureStarted();
										stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
									}
								}
								if (currentBlock.type === "thinking") {
									currentBlock.thinking += part.text;
									currentBlock.thinkingSignature = retainThoughtSignature(
										currentBlock.thinkingSignature,
										part.thoughtSignature,
									);
									stream.push({
										type: "thinking_delta",
										contentIndex: blockIndex(),
										delta: part.text,
										partial: output,
									});
								} else {
									currentBlock.text += part.text;
									currentBlock.textSignature = retainThoughtSignature(
										currentBlock.textSignature,
										part.thoughtSignature,
									);
									stream.push({
										type: "text_delta",
										contentIndex: blockIndex(),
										delta: part.text,
										partial: output,
									});
								}
							}

							if (part.functionCall) {
								hasContent = true;
								if (currentBlock) {
									if (currentBlock.type === "text") {
										stream.push({
											type: "text_end",
											contentIndex: blockIndex(),
											content: currentBlock.text,
											partial: output,
										});
									} else {
										stream.push({
											type: "thinking_end",
											contentIndex: blockIndex(),
											content: currentBlock.thinking,
											partial: output,
										});
									}
									currentBlock = null;
								}

								const providedId = part.functionCall.id;
								const needsNewId =
									!providedId || output.content.some(b => b.type === "toolCall" && b.id === providedId);
								const toolCallId = needsNewId
									? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
									: providedId;

								const toolCall: ToolCall = {
									type: "toolCall",
									id: toolCallId,
									name: part.functionCall.name || "",
									arguments: part.functionCall.args as Record<string, unknown>,
									...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
								};

								output.content.push(toolCall);
								ensureStarted();
								stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
								stream.push({
									type: "toolcall_delta",
									contentIndex: blockIndex(),
									delta: JSON.stringify(toolCall.arguments),
									partial: output,
								});
								stream.push({
									type: "toolcall_end",
									contentIndex: blockIndex(),
									toolCall,
									partial: output,
								});
							}
						}
					}

					if (candidate?.finishReason) {
						output.stopReason = mapStopReasonString(candidate.finishReason);
						if (output.content.some(b => b.type === "toolCall")) {
							output.stopReason = "toolUse";
						}
					}

					if (responseData.usageMetadata) {
						// promptTokenCount includes cachedContentTokenCount, so subtract to get fresh input
						const promptTokens = responseData.usageMetadata.promptTokenCount || 0;
						const cacheReadTokens = responseData.usageMetadata.cachedContentTokenCount || 0;
						const thinkingTokens = responseData.usageMetadata.thoughtsTokenCount || 0;
						output.usage = {
							input: promptTokens - cacheReadTokens,
							output: (responseData.usageMetadata.candidatesTokenCount || 0) + thinkingTokens,
							cacheRead: cacheReadTokens,
							cacheWrite: 0,
							totalTokens: responseData.usageMetadata.totalTokenCount || 0,
							...(thinkingTokens > 0 ? { reasoningTokens: thinkingTokens } : {}),
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						};
						calculateCost(model, output.usage);
					}
				}

				if (currentBlock) {
					if (currentBlock.type === "text") {
						stream.push({
							type: "text_end",
							contentIndex: blockIndex(),
							content: currentBlock.text,
							partial: output,
						});
					} else {
						stream.push({
							type: "thinking_end",
							contentIndex: blockIndex(),
							content: currentBlock.thinking,
							partial: output,
						});
					}
				}

				return hasContent;
			};

			let receivedContent = false;
			let currentResponse = response;

			for (let emptyAttempt = 0; emptyAttempt <= MAX_EMPTY_STREAM_RETRIES; emptyAttempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				if (emptyAttempt > 0) {
					const backoffMs = EMPTY_STREAM_BASE_DELAY_MS * 2 ** (emptyAttempt - 1);
					try {
						await abortableSleep(backoffMs, options?.signal);
					} catch {
						// Normalize AbortError to expected message for consistent error handling
						throw new Error("Request was aborted");
					}

					if (!requestUrl) {
						throw new Error("Missing request URL");
					}

					currentResponse = await fetch(requestUrl, {
						method: "POST",
						headers: requestHeaders,
						body: requestBodyJson,
						signal: options?.signal,
					});

					if (!currentResponse.ok) {
						const retryErrorText = await currentResponse.text();
						throw withHttpStatus(
							new Error(`Cloud Code Assist API error (${currentResponse.status}): ${retryErrorText}`),
							currentResponse.status,
						);
					}
				}

				const streamed = await streamResponse(currentResponse);
				if (streamed) {
					receivedContent = true;
					break;
				}

				if (emptyAttempt < MAX_EMPTY_STREAM_RETRIES) {
					resetOutput();
				}
			}

			if (!receivedContent) {
				throw new Error("Cloud Code Assist API returned an empty response");
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if ("index" in block) {
					delete (block as { index?: number }).index;
				}
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = await appendRawHttpRequestDumpFor400(
				error instanceof Error ? error.message : JSON.stringify(error),
				error,
				rawRequestDump,
			);
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

const INT63_MASK = (1n << 63n) - 1n;
const ANTIGRAVITY_RANDOM_BOUND = 9_000_000_000_000_000_000n;

function formatSignedDecimalSessionId(value: bigint): string {
	return `-${value.toString()}`;
}

function deriveSignedDecimalFromHash(text: string): string {
	const digest = createHash("sha256").update(text).digest();
	let value = 0n;
	for (let index = 0; index < 8; index += 1) {
		value = (value << 8n) | BigInt(digest[index] ?? 0);
	}
	return formatSignedDecimalSessionId(value & INT63_MASK);
}

function randomBoundedInt63(maxExclusive: bigint): bigint {
	while (true) {
		const bytes = randomBytes(8);
		let value = 0n;
		for (const byte of bytes) {
			value = (value << 8n) | BigInt(byte);
		}
		value &= INT63_MASK;
		if (value < maxExclusive) {
			return value;
		}
	}
}

function randomSignedDecimalSessionId(): string {
	return formatSignedDecimalSessionId(randomBoundedInt63(ANTIGRAVITY_RANDOM_BOUND));
}

function getFirstUserTextForAntigravitySession(context: Context): string | undefined {
	for (const message of context.messages) {
		if (message.role !== "user") {
			continue;
		}

		if (typeof message.content === "string") {
			return message.content;
		}

		if (Array.isArray(message.content)) {
			const firstTextPart = message.content.find((item): item is TextContent => item.type === "text");
			return firstTextPart?.text;
		}

		return undefined;
	}

	return undefined;
}

function deriveAntigravitySessionId(context: Context): string {
	const text = getFirstUserTextForAntigravitySession(context);
	if (text && text.trim().length > 0) {
		return deriveSignedDecimalFromHash(text);
	}

	return randomSignedDecimalSessionId();
}

function normalizeAntigravityTools(
	tools: CloudCodeAssistRequest["request"]["tools"],
): CloudCodeAssistRequest["request"]["tools"] {
	return tools?.map(tool => ({
		...tool,
		functionDeclarations: tool.functionDeclarations.map(declaration => {
			if ("parameters" in declaration) {
				return declaration;
			}

			const { parametersJsonSchema, ...rest } = declaration;
			return {
				...rest,
				parameters: sanitizeSchemaForCCA(parametersJsonSchema),
			};
		}),
	}));
}

export function buildRequest(
	model: Model<"google-gemini-cli">,
	context: Context,
	projectId: string,
	options: GoogleGeminiCliOptions = {},
	isAntigravity = false,
): CloudCodeAssistRequest {
	const contents = convertMessages(model, context);

	const generationConfig: CloudCodeAssistRequest["request"]["generationConfig"] = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}
	if (options.topP !== undefined) {
		generationConfig.topP = options.topP;
	}
	if (options.topK !== undefined) {
		generationConfig.topK = options.topK;
	}
	if (options.minP !== undefined) {
		generationConfig.minP = options.minP;
	}
	if (options.presencePenalty !== undefined) {
		generationConfig.presencePenalty = options.presencePenalty;
	}
	if (options.repetitionPenalty !== undefined) {
		generationConfig.repetitionPenalty = options.repetitionPenalty;
	}

	// Thinking config
	if (options.thinking?.enabled && model.reasoning) {
		generationConfig.thinkingConfig = {
			includeThoughts: true,
		};
		// Gemini 3 models use thinkingLevel, older models use thinkingBudget
		if (options.thinking.level !== undefined) {
			// Cast to any since our GoogleThinkingLevel mirrors Google's ThinkingLevel enum values
			generationConfig.thinkingConfig.thinkingLevel = options.thinking.level as any;
		} else if (options.thinking.budgetTokens !== undefined) {
			generationConfig.thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
	}

	const request: CloudCodeAssistRequest["request"] = {
		contents,
	};

	if (isAntigravity) {
		request.sessionId = deriveAntigravitySessionId(context);
	}

	// System instruction must be object with parts, not plain string
	if (context.systemPrompt) {
		request.systemInstruction = {
			parts: [{ text: context.systemPrompt.toWellFormed() }],
		};
	}

	if (Object.keys(generationConfig).length > 0) {
		request.generationConfig = generationConfig;
	}

	if (context.tools && context.tools.length > 0) {
		const convertedTools = convertTools(context.tools, model);
		request.tools = isAntigravity ? normalizeAntigravityTools(convertedTools) : convertedTools;
		if (options.toolChoice) {
			request.toolConfig = {
				functionCallingConfig: {
					mode: mapToolChoice(options.toolChoice),
				},
			};
		}
	}

	if (isAntigravity && !isClaudeModel(model.id) && request.generationConfig?.maxOutputTokens !== undefined) {
		delete request.generationConfig.maxOutputTokens;
		if (Object.keys(request.generationConfig).length === 0) {
			delete request.generationConfig;
		}
	}

	if (isAntigravity && isClaudeModel(model.id)) {
		request.toolConfig = {
			functionCallingConfig: {
				mode: "VALIDATED" as FunctionCallingConfigMode,
			},
		};
	}

	if (isAntigravity && shouldInjectAntigravitySystemInstruction(model.id)) {
		const existingParts = request.systemInstruction?.parts ?? [];
		request.systemInstruction = {
			role: "user",
			parts: [
				{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
				{ text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
				...existingParts,
			],
		};
	}

	return {
		project: projectId,
		model: model.id,
		request,
		...(isAntigravity
			? {
					requestType: "agent",
					userAgent: "antigravity",
					requestId: `agent-${randomUUID()}`,
				}
			: {}),
	};
}
