import { $env } from "@oh-my-pi/pi-utils";
import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionMessageParam,
	ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import { calculateCost } from "../models";
import { getEnvApiKey } from "../stream";
import {
	type AssistantMessage,
	type Context,
	type Message,
	type MessageAttribution,
	type Model,
	type ProviderSessionState,
	type ServiceTier,
	type StopReason,
	type StreamFunction,
	type StreamOptions,
	shouldSendServiceTier,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolChoice,
	type ToolResultMessage,
} from "../types";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { toFireworksWireModelId } from "../utils/fireworks-model-id";
import {
	type CapturedHttpErrorResponse,
	finalizeErrorMessage,
	type RawHttpRequestDump,
	rewriteCopilotError,
} from "../utils/http-inspector";
import {
	createWatchdog,
	getOpenAIStreamIdleTimeoutMs,
	getStreamFirstEventTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { parseStreamingJson } from "../utils/json-parse";
import { parseGitHubCopilotApiKey } from "../utils/oauth/github-copilot";
import { getKimiCommonHeaders } from "../utils/oauth/kimi";
import { notifyProviderResponse } from "../utils/provider-response";
import { callWithCopilotModelRetry, extractHttpStatusFromError } from "../utils/retry";
import { adaptSchemaForStrict, NO_STRICT } from "../utils/schema";
import { isForcedToolChoice, mapToOpenAICompletionsToolChoice } from "../utils/tool-choice";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	resolveGitHubCopilotBaseUrl,
} from "./github-copilot-headers";
import { detectOpenAICompat, type ResolvedOpenAICompat, resolveOpenAICompat } from "./openai-completions-compat";
import { transformMessages } from "./transform-messages";

/**
 * Normalize tool call ID for Mistral.
 * Mistral requires tool IDs to be exactly 9 alphanumeric characters (a-z, A-Z, 0-9).
 */
function normalizeMistralToolId(id: string, isMistral: boolean): string {
	if (!isMistral) return id;
	// Remove non-alphanumeric characters
	let normalized = id.replace(/[^a-zA-Z0-9]/g, "");
	// Mistral requires exactly 9 characters
	if (normalized.length < 9) {
		// Pad with deterministic characters based on original ID to ensure matching
		const padding = "ABCDEFGHI";
		normalized = normalized + padding.slice(0, 9 - normalized.length);
	} else if (normalized.length > 9) {
		normalized = normalized.slice(0, 9);
	}
	return normalized;
}

function serializeToolArguments(value: unknown): string {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		try {
			return JSON.stringify(value);
		} catch {
			return "{}";
		}
	}

	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) return "{}";
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return JSON.stringify(parsed);
			}
		} catch {}
		return "{}";
	}

	return "{}";
}

/**
 * Check if conversation messages contain tool calls or tool results.
 * This is needed because Anthropic (via proxy) requires the tools param
 * to be present when messages include tool_calls or tool role messages.
 */
function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some(block => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: ToolChoice;
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
	serviceTier?: ServiceTier;
}

type OpenAICompletionsSamplingParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
	top_k?: number;
	min_p?: number;
	repetition_penalty?: number;
};

type AppliedToolStrictMode = "mixed" | "all_strict" | "none";
type ToolStrictModeOverride = Exclude<ResolvedOpenAICompat["toolStrictMode"], "mixed"> | undefined;

type BuiltOpenAICompletionTools = {
	tools: OpenAI.Chat.Completions.ChatCompletionTool[];
	toolStrictMode: AppliedToolStrictMode;
};

const OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX = "openai-completions:";

type OpenAICompletionsProviderSessionState = ProviderSessionState & {
	strictToolsDisabled: boolean;
};

function createOpenAICompletionsProviderSessionState(): OpenAICompletionsProviderSessionState {
	const state: OpenAICompletionsProviderSessionState = {
		strictToolsDisabled: false,
		close: () => {
			state.strictToolsDisabled = false;
		},
	};
	return state;
}

function getOpenAICompletionsProviderSessionState(
	model: Model<"openai-completions">,
	baseUrl: string | undefined,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): OpenAICompletionsProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = `${OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX}${model.provider}:${baseUrl ?? ""}:${model.id}`;
	const existing = providerSessionState.get(key) as OpenAICompletionsProviderSessionState | undefined;
	if (existing) return existing;
	const created = createOpenAICompletionsProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

function isOpenRouterAnthropicModel(model: Model<"openai-completions">): boolean {
	return model.provider === "openrouter" && model.id.toLowerCase().startsWith("anthropic/");
}

function isCompiledGrammarTooLargeStrictError(
	error: unknown,
	capturedErrorResponse: CapturedHttpErrorResponse | undefined,
): boolean {
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400) return false;
	const messageParts = [error instanceof Error ? error.message : undefined, capturedErrorResponse?.bodyText]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n");
	return (
		/invalid_request_error/i.test(messageParts) &&
		/compiled grammar/i.test(messageParts) &&
		/too large/i.test(messageParts)
	);
}

// LIMITATION: The think tag parser uses naive string matching for <think>/<thinking> tags.
// If MiniMax models output these literal strings in code blocks, XML examples, or explanations,
// they will be incorrectly consumed as thinking delimiters, truncating visible output.
// A streaming parser with arbitrary chunk boundaries cannot reliably detect code block context.
// This is acceptable because: (1) only enabled for minimax-code providers, (2) MiniMax models
// use these tags as their actual thinking format, and (3) false positives are rare in practice.
const MINIMAX_THINK_OPEN_TAGS = ["<think>", "<thinking>"] as const;
const MINIMAX_THINK_CLOSE_TAGS = ["</think>", "</thinking>"] as const;

function findFirstTag(text: string, tags: readonly string[]): { index: number; tag: string } | undefined {
	let earliestIndex = Number.POSITIVE_INFINITY;
	let earliestTag: string | undefined;
	for (const tag of tags) {
		const index = text.indexOf(tag);
		if (index !== -1 && index < earliestIndex) {
			earliestIndex = index;
			earliestTag = tag;
		}
	}
	if (!earliestTag) return undefined;
	return { index: earliestIndex, tag: earliestTag };
}

function getTrailingPartialTag(text: string, tags: readonly string[]): string {
	let maxLength = 0;
	for (const tag of tags) {
		const maxCandidateLength = Math.min(tag.length - 1, text.length);
		for (let length = maxCandidateLength; length > 0; length--) {
			if (text.endsWith(tag.slice(0, length))) {
				if (length > maxLength) maxLength = length;
				break;
			}
		}
	}
	if (maxLength === 0) return "";
	return text.slice(-maxLength);
}

// DeepSeek models leak chat-template special tokens (e.g. `<｜tool_calls_begin｜>`,
// `<｜DSML｜tool_calls｜>`) into visible `content` deltas when hosted behind providers
// (such as NVIDIA NIM) that don't strip them server-side. The structured `tool_calls`
// payload is still emitted correctly — we only need to filter the leaked markers from
// user-visible text. Tokens use either fullwidth pipes (｜, U+FF5C) or ASCII pipes.
// Body is restricted to identifier-like chars (with the DeepSeek tokenizer's `▁`),
// capped at a sane length to avoid swallowing legitimate angle-bracket text.
const DEEPSEEK_SPECIAL_TOKEN_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/g;
const DEEPSEEK_OPEN_DELIMS = ["<｜", "<|"] as const;

function stripDeepseekSpecialTokens(text: string): string {
	return text.replace(DEEPSEEK_SPECIAL_TOKEN_REGEX, "");
}

// Find any trailing partial `<｜...` (or `<|...`) that has not yet been closed by a
// matching `｜>`/`|>`, so it can be held back until the next chunk arrives. A solo
// trailing `<` is also held in case it is the start of a new token.
function getTrailingPartialDeepseekToken(text: string): string {
	let bestIdx = -1;
	for (const delim of DEEPSEEK_OPEN_DELIMS) {
		const idx = text.lastIndexOf(delim);
		if (idx > bestIdx) bestIdx = idx;
	}
	if (bestIdx === -1) {
		return text.endsWith("<") ? "<" : "";
	}
	const tail = text.slice(bestIdx);
	if (tail.includes("｜>") || tail.includes("|>")) return "";
	// Cap the held-back length so a stray `<｜` in normal prose can't grow unboundedly.
	if (tail.length > 256) return "";
	return tail;
}

const OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE =
	"OpenAI completions stream timed out while waiting for the first event";

export const streamOpenAICompletions: StreamFunction<"openai-completions"> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;
		let getCapturedErrorResponse: (() => CapturedHttpErrorResponse | undefined) | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
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
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new Error(OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE);
		const { requestAbortController, requestSignal } = abortTracker;

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const idleTimeoutMs = getOpenAIStreamIdleTimeoutMs();
			const {
				client,
				copilotPremiumRequests,
				baseUrl,
				requestHeaders,
				getCapturedErrorResponse: captureErrorResponse,
				clearCapturedErrorResponse,
			} = await createClient(model, context, apiKey, options?.headers, options?.initiatorOverride);
			getCapturedErrorResponse = captureErrorResponse;
			let appliedToolStrictMode: AppliedToolStrictMode = "mixed";
			const providerSessionState = getOpenAICompletionsProviderSessionState(
				model,
				baseUrl,
				options?.providerSessionState,
			);
			let disableStrictTools = providerSessionState?.strictToolsDisabled ?? false;
			let strictFallbackErrorMessage: string | undefined;
			const createCompletionsStream = async (toolStrictModeOverride?: ToolStrictModeOverride) => {
				clearCapturedErrorResponse();
				const effectiveToolStrictModeOverride = disableStrictTools ? "none" : toolStrictModeOverride;
				const { params, toolStrictMode } = buildParams(
					model,
					context,
					options,
					baseUrl,
					effectiveToolStrictModeOverride,
				);
				appliedToolStrictMode = toolStrictMode;
				options?.onPayload?.(params);
				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url: `${baseUrl}/chat/completions`,
					headers: requestHeaders,
					body: params,
				};
				const { data, response, request_id } = await client.chat.completions
					.create(params, { signal: requestSignal })
					.withResponse();
				await notifyProviderResponse(options, response, model, request_id);
				return data;
			};
			let openaiStream: AsyncIterable<ChatCompletionChunk>;
			try {
				openaiStream = await callWithCopilotModelRetry(() => createCompletionsStream(), {
					provider: model.provider,
					signal: requestSignal,
				});
			} catch (error) {
				const capturedErrorResponse = getCapturedErrorResponse();
				if (
					isOpenRouterAnthropicModel(model) &&
					!disableStrictTools &&
					isCompiledGrammarTooLargeStrictError(error, capturedErrorResponse)
				) {
					strictFallbackErrorMessage = await finalizeErrorMessage(error, rawRequestDump, capturedErrorResponse);
					output.errorMessage = strictFallbackErrorMessage;
					if (providerSessionState) {
						providerSessionState.strictToolsDisabled = true;
					}
					disableStrictTools = true;
					openaiStream = await createCompletionsStream("none");
				} else {
					if (!shouldRetryWithoutStrictTools(error, capturedErrorResponse, appliedToolStrictMode, context.tools)) {
						throw error;
					}
					openaiStream = await createCompletionsStream("none");
				}
			}
			const firstEventWatchdog = createWatchdog(
				options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs),
				() => abortTracker.abortLocally(firstEventTimeoutAbortError),
			);
			if (copilotPremiumRequests !== undefined) output.usage.premiumRequests = copilotPremiumRequests;
			stream.push({ type: "start", partial: output });

			const parseMiniMaxThinkTags = model.provider === "minimax-code";
			// NVIDIA NIM and similar OpenAI-compatible hosts return DeepSeek's chat-template
			// tool-call markers in `delta.content` even though tool calls are also surfaced
			// structurally. Strip the leaked markers so users don't see raw `<｜...｜>` tokens.
			const stripDeepseekChatTemplateTokens = model.provider === "nvidia" && /deepseek/i.test(model.id);
			type OpenAIStreamBlock = TextContent | ThinkingContent | (ToolCall & { partialArgs: string });
			let currentBlock: OpenAIStreamBlock | undefined;
			const blockIndex = (block: OpenAIStreamBlock | undefined): number => {
				if (!block) return Math.max(0, output.content.length - 1);
				return output.content.indexOf(block);
			};
			const finishCurrentBlock = (block: OpenAIStreamBlock | undefined): void => {
				if (!block) return;
				const contentIndex = blockIndex(block);
				if (contentIndex < 0) return;
				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
					return;
				}
				if (block.type === "thinking") {
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
					return;
				}
				block.arguments = parseStreamingJson(block.partialArgs);
				delete (block as { partialArgs?: string }).partialArgs;
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
			};
			const appendText = (
				message: AssistantMessage,
				eventStream: AssistantMessageEventStream,
				text: string,
			): void => {
				if (!currentBlock || currentBlock.type !== "text") {
					finishCurrentBlock(currentBlock);
					currentBlock = { type: "text", text: "" };
					message.content.push(currentBlock);
					eventStream.push({ type: "text_start", contentIndex: blockIndex(currentBlock), partial: message });
				}
				currentBlock.text += text;
				eventStream.push({
					type: "text_delta",
					contentIndex: blockIndex(currentBlock),
					delta: text,
					partial: message,
				});
			};
			const appendThinking = (
				message: AssistantMessage,
				eventStream: AssistantMessageEventStream,
				thinking: string,
				signature?: string,
			): void => {
				if (
					!currentBlock ||
					currentBlock.type !== "thinking" ||
					(signature !== undefined && currentBlock.thinkingSignature !== signature)
				) {
					finishCurrentBlock(currentBlock);
					currentBlock = { type: "thinking", thinking: "", thinkingSignature: signature };
					message.content.push(currentBlock);
					eventStream.push({
						type: "thinking_start",
						contentIndex: blockIndex(currentBlock),
						partial: message,
					});
				}
				if (signature !== undefined && !currentBlock.thinkingSignature) {
					currentBlock.thinkingSignature = signature;
				}
				currentBlock.thinking += thinking;
				eventStream.push({
					type: "thinking_delta",
					contentIndex: blockIndex(currentBlock),
					delta: thinking,
					partial: message,
				});
			};

			let taggedTextBuffer = "";
			let insideTaggedThinking = false;
			const appendTextDelta = (text: string) => {
				if (!text) return;
				if (!firstTokenTime) firstTokenTime = Date.now();
				appendText(output, stream, text);
			};
			const appendThinkingDelta = (thinking: string, signature?: string) => {
				if (!thinking) return;
				if (!firstTokenTime) firstTokenTime = Date.now();
				appendThinking(output, stream, thinking, signature);
			};

			const flushTaggedTextBuffer = () => {
				while (taggedTextBuffer.length > 0) {
					if (insideTaggedThinking) {
						const closingTag = findFirstTag(taggedTextBuffer, MINIMAX_THINK_CLOSE_TAGS);
						if (closingTag) {
							appendThinkingDelta(taggedTextBuffer.slice(0, closingTag.index));
							taggedTextBuffer = taggedTextBuffer.slice(closingTag.index + closingTag.tag.length);
							insideTaggedThinking = false;
							continue;
						}

						const trailingPartialTag = getTrailingPartialTag(taggedTextBuffer, MINIMAX_THINK_CLOSE_TAGS);
						const flushLength = taggedTextBuffer.length - trailingPartialTag.length;
						appendThinkingDelta(taggedTextBuffer.slice(0, flushLength));
						taggedTextBuffer = trailingPartialTag;
						break;
					}

					const openingTag = findFirstTag(taggedTextBuffer, MINIMAX_THINK_OPEN_TAGS);
					if (openingTag) {
						appendTextDelta(taggedTextBuffer.slice(0, openingTag.index));
						taggedTextBuffer = taggedTextBuffer.slice(openingTag.index + openingTag.tag.length);
						insideTaggedThinking = true;
						continue;
					}

					const trailingPartialTag = getTrailingPartialTag(taggedTextBuffer, MINIMAX_THINK_OPEN_TAGS);
					const flushLength = taggedTextBuffer.length - trailingPartialTag.length;
					appendTextDelta(taggedTextBuffer.slice(0, flushLength));
					taggedTextBuffer = trailingPartialTag;
					break;
				}
			};

			let deepseekStripBuffer = "";
			const flushDeepseekStripBuffer = (final: boolean): void => {
				if (deepseekStripBuffer.length === 0) return;
				let flushable: string;
				if (final) {
					flushable = deepseekStripBuffer;
					deepseekStripBuffer = "";
				} else {
					const trailing = getTrailingPartialDeepseekToken(deepseekStripBuffer);
					flushable = deepseekStripBuffer.slice(0, deepseekStripBuffer.length - trailing.length);
					deepseekStripBuffer = trailing;
				}
				const stripped = stripDeepseekSpecialTokens(flushable);
				if (stripped) appendTextDelta(stripped);
			};

			for await (const chunk of iterateWithIdleTimeout(openaiStream, {
				watchdog: firstEventWatchdog,
				idleTimeoutMs,
				errorMessage: "OpenAI completions stream stalled while waiting for the next event",
				onIdle: () => requestAbortController.abort(),
			})) {
				if (!chunk || typeof chunk !== "object") continue;

				// OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
				// and each chunk in a streamed completion carries the same id.
				output.responseId ||= chunk.id;

				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage, model, copilotPremiumRequests);
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;

				if (!chunk.usage) {
					const choiceUsage = getChoiceUsage(choice);
					if (choiceUsage) {
						output.usage = parseChunkUsage(choiceUsage, model, copilotPremiumRequests);
					}
				}

				if (choice.finish_reason) {
					const finishReasonResult = mapStopReason(choice.finish_reason);
					output.stopReason = finishReasonResult.stopReason;
					if (finishReasonResult.errorMessage) {
						output.errorMessage = finishReasonResult.errorMessage;
					}
				}

				if (choice.delta) {
					if (
						choice.delta.content !== null &&
						choice.delta.content !== undefined &&
						choice.delta.content.length > 0
					) {
						if (!firstTokenTime) firstTokenTime = Date.now();
						if (parseMiniMaxThinkTags) {
							taggedTextBuffer += choice.delta.content;
							flushTaggedTextBuffer();
						} else if (stripDeepseekChatTemplateTokens) {
							deepseekStripBuffer += choice.delta.content;
							flushDeepseekStripBuffer(false);
						} else {
							appendTextDelta(choice.delta.content);
						}
					}

					// Some endpoints return reasoning in reasoning_content (llama.cpp),
					// or reasoning (other openai compatible endpoints)
					// Use the first non-empty reasoning field to avoid duplication
					// (e.g., chutes.ai returns both reasoning_content and reasoning with same content)
					const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
					let foundReasoningField: string | null = null;
					for (const field of reasoningFields) {
						if (
							(choice.delta as any)[field] !== null &&
							(choice.delta as any)[field] !== undefined &&
							(choice.delta as any)[field].length > 0
						) {
							if (!foundReasoningField) {
								foundReasoningField = field;
								break;
							}
						}
					}

					if (foundReasoningField) {
						const delta = (choice.delta as any)[foundReasoningField];
						appendThinkingDelta(delta, foundReasoningField);
					}

					if (choice?.delta?.tool_calls) {
						for (const toolCall of choice.delta.tool_calls) {
							if (
								!currentBlock ||
								currentBlock.type !== "toolCall" ||
								(toolCall.id && currentBlock.id !== toolCall.id)
							) {
								finishCurrentBlock(currentBlock);
								currentBlock = {
									type: "toolCall",
									id: toolCall.id || "",
									name: toolCall.function?.name || "",
									arguments: {},
									partialArgs: "",
								};
								output.content.push(currentBlock);
								stream.push({
									type: "toolcall_start",
									contentIndex: blockIndex(currentBlock),
									partial: output,
								});
							}

							if (currentBlock.type === "toolCall") {
								if (toolCall.id) currentBlock.id = toolCall.id;
								if (toolCall.function?.name) currentBlock.name = toolCall.function.name;
								let delta = "";
								if (toolCall.function?.arguments) {
									delta = toolCall.function.arguments;
									currentBlock.partialArgs += toolCall.function.arguments;
									currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
								}
								stream.push({
									type: "toolcall_delta",
									contentIndex: blockIndex(currentBlock),
									delta,
									partial: output,
								});
							}
						}
					}

					const reasoningDetails = (choice.delta as any).reasoning_details;
					if (reasoningDetails && Array.isArray(reasoningDetails)) {
						for (const detail of reasoningDetails) {
							if (detail.type === "reasoning.encrypted" && detail.id && detail.data) {
								const matchingToolCall = output.content.find(
									b => b.type === "toolCall" && b.id === detail.id,
								) as ToolCall | undefined;
								if (matchingToolCall) {
									matchingToolCall.thoughtSignature = JSON.stringify(detail);
								}
							}
						}
					}
				}
			}

			if (parseMiniMaxThinkTags && taggedTextBuffer.length > 0) {
				if (insideTaggedThinking) {
					appendThinkingDelta(taggedTextBuffer);
				} else {
					appendTextDelta(taggedTextBuffer);
				}
				taggedTextBuffer = "";
			}

			if (stripDeepseekChatTemplateTokens) {
				flushDeepseekStripBuffer(true);
			}

			finishCurrentBlock(currentBlock);

			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			if (firstEventTimeoutError) {
				throw firstEventTimeoutError;
			}
			if (abortTracker.wasCallerAbort()) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted") {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}

			output.errorMessage = strictFallbackErrorMessage;
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as any).index;
			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			output.stopReason = abortTracker.wasCallerAbort() ? "aborted" : "error";
			output.errorMessage =
				firstEventTimeoutError?.message ??
				(await finalizeErrorMessage(error, rawRequestDump, getCapturedErrorResponse?.()));
			// Some providers via OpenRouter include extra details here.
			const rawMetadata = (error as { error?: { metadata?: { raw?: string } } })?.error?.metadata?.raw;
			if (rawMetadata) output.errorMessage += `\n${rawMetadata}`;
			output.errorMessage = rewriteCopilotError(output.errorMessage, error, model.provider);
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

async function createClient(
	model: Model<"openai-completions">,
	context: Context,
	apiKey?: string,
	extraHeaders?: Record<string, string>,
	initiatorOverride?: MessageAttribution,
): Promise<{
	client: OpenAI;
	copilotPremiumRequests: number | undefined;
	baseUrl: string | undefined;
	requestHeaders: Record<string, string>;
	getCapturedErrorResponse: () => CapturedHttpErrorResponse | undefined;
	clearCapturedErrorResponse: () => void;
}> {
	if (!apiKey) {
		if (!$env.OPENAI_API_KEY) {
			throw new Error(
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = $env.OPENAI_API_KEY;
	}
	const rawApiKey = apiKey;

	let headers = { ...(model.headers ?? {}), ...(extraHeaders ?? {}) };
	if (model.provider === "openrouter") {
		headers["X-Title"] = "Oh-My-Pi";
	}
	if (model.provider === "kimi-code") {
		headers = { ...getKimiCommonHeaders(), ...headers };
	}
	let copilotPremiumRequests: number | undefined;

	let baseUrl = model.baseUrl;
	if (model.provider === "github-copilot") {
		apiKey = parseGitHubCopilotApiKey(rawApiKey).accessToken;
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilot = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
			premiumMultiplier: model.premiumMultiplier,
			headers,
			initiatorOverride,
		});
		Object.assign(headers, copilot.headers);
		copilotPremiumRequests = copilot.premiumRequests;
		baseUrl = resolveGitHubCopilotBaseUrl(model.baseUrl, rawApiKey) ?? model.baseUrl;
	}
	// Azure OpenAI requires /deployments/{id}/chat/completions?api-version=YYYY-MM-DD.
	// The generic openai-completions path adds neither, producing silent 404s.
	let azureDefaultQuery: Record<string, string> | undefined;
	if (baseUrl?.includes(".openai.azure.com")) {
		const apiVersion = $env.AZURE_OPENAI_API_VERSION || "2024-10-21";
		if (!baseUrl.includes("/deployments/")) {
			baseUrl = `${baseUrl}/deployments/${model.id}`;
		}
		azureDefaultQuery = { "api-version": apiVersion };
	}
	let capturedErrorResponse: CapturedHttpErrorResponse | undefined;
	const wrappedFetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const response = await fetch(input, init);
			if (response.ok) {
				capturedErrorResponse = undefined;
				return response;
			}
			let bodyText: string | undefined;
			let bodyJson: unknown;
			try {
				bodyText = await response.clone().text();
				if (bodyText.trim().length > 0) {
					try {
						bodyJson = JSON.parse(bodyText);
					} catch {}
				}
			} catch {}
			capturedErrorResponse = {
				status: response.status,
				headers: response.headers,
				bodyText,
				bodyJson,
			};
			return response;
		},
		{ preconnect: fetch.preconnect },
	);
	return {
		client: new OpenAI({
			apiKey,
			baseURL: baseUrl,
			dangerouslyAllowBrowser: true,
			maxRetries: 5,
			defaultHeaders: headers,
			defaultQuery: azureDefaultQuery,
			fetch: wrappedFetch,
		}),
		copilotPremiumRequests,
		baseUrl,
		requestHeaders: headers,
		getCapturedErrorResponse: () => capturedErrorResponse,
		clearCapturedErrorResponse: () => {
			capturedErrorResponse = undefined;
		},
	};
}

function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions | undefined,
	resolvedBaseUrl?: string,
	toolStrictModeOverride?: ToolStrictModeOverride,
): { params: OpenAICompletionsSamplingParams; toolStrictMode: AppliedToolStrictMode } {
	const compat = getCompat(model, resolvedBaseUrl);
	const messages = convertMessages(model, context, compat);
	maybeAddOpenRouterAnthropicCacheControl(model, messages);
	const supportsReasoningParams = model.provider !== "github-copilot";

	// Kimi (including via OpenRouter) calculates TPM rate limits based on max_tokens, not actual output.
	// Always send max_tokens to avoid their high default causing rate limit issues.
	// Note: Direct kimi-code provider is handled by the dedicated Kimi provider in kimi.ts.
	const isKimi = model.id.includes("moonshotai/kimi");
	const effectiveMaxTokens = options?.maxTokens ?? (isKimi ? model.maxTokens : undefined);

	const requestModelId = model.provider === "fireworks" ? toFireworksWireModelId(model.id) : model.id;
	const params: OpenAICompletionsSamplingParams = {
		model: requestModelId,
		messages,
		stream: true,
	};
	let toolStrictMode: AppliedToolStrictMode = "none";

	if (compat.supportsUsageInStreaming !== false) {
		(params as { stream_options?: { include_usage: boolean } }).stream_options = { include_usage: true };
	}

	if (compat.supportsStore) {
		params.store = false;
	}

	if (effectiveMaxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			(params as any).max_tokens = effectiveMaxTokens;
		} else {
			params.max_completion_tokens = effectiveMaxTokens;
		}
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}
	if (options?.topP !== undefined) {
		params.top_p = options.topP;
	}
	if (options?.topK !== undefined) {
		params.top_k = options.topK;
	}
	if (options?.minP !== undefined) {
		params.min_p = options.minP;
	}
	if (options?.presencePenalty !== undefined) {
		params.presence_penalty = options.presencePenalty;
	}
	if (options?.repetitionPenalty !== undefined) {
		params.repetition_penalty = options.repetitionPenalty;
	}
	if (shouldSendServiceTier(options?.serviceTier, model.provider)) {
		params.service_tier = options.serviceTier;
	}

	if (context.tools) {
		const builtTools = convertTools(context.tools, compat, toolStrictModeOverride);
		params.tools = builtTools.tools;
		toolStrictMode = builtTools.toolStrictMode;
	} else if (hasToolHistory(context.messages)) {
		// Anthropic (via LiteLLM/proxy) requires tools param when conversation has tool_calls/tool_results
		params.tools = [];
	}

	if (options?.toolChoice && compat.supportsToolChoice) {
		params.tool_choice = mapToOpenAICompletionsToolChoice(options.toolChoice);
	}

	if (supportsReasoningParams && compat.thinkingFormat === "zai" && model.reasoning) {
		// Z.ai uses binary thinking: { type: "enabled" | "disabled" }
		// Must explicitly disable since z.ai defaults to thinking enabled
		Reflect.set(params, "thinking", { type: options?.reasoning ? "enabled" : "disabled" });
	} else if (supportsReasoningParams && compat.thinkingFormat === "qwen" && model.reasoning) {
		// Qwen uses top-level enable_thinking: boolean
		Reflect.set(params, "enable_thinking", !!options?.reasoning);
	} else if (supportsReasoningParams && compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
		Reflect.set(params, "chat_template_kwargs", { enable_thinking: !!options?.reasoning });
	} else if (
		supportsReasoningParams &&
		compat.thinkingFormat === "openrouter" &&
		options?.reasoning &&
		model.reasoning
	) {
		// OpenRouter normalizes reasoning across providers via a nested reasoning object.
		const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
		openRouterParams.reasoning = {
			effort: mapReasoningEffort(options.reasoning, compat.reasoningEffortMap),
		};
	} else if (supportsReasoningParams && options?.reasoning && model.reasoning && compat.supportsReasoningEffort) {
		// OpenAI-style reasoning_effort
		Reflect.set(params, "reasoning_effort", mapReasoningEffort(options.reasoning, compat.reasoningEffortMap));
	}

	if (compat.disableReasoningOnForcedToolChoice && isForcedToolChoice(params.tool_choice)) {
		// Mirrors anthropic.ts:disableThinkingIfToolChoiceForced — backends like
		// Kimi 400 with `tool_choice 'specified' is incompatible with thinking
		// enabled`. Drop reasoning for this turn instead of dropping tool_choice;
		// the agent still gets the forced tool call, just without thinking.
		delete (params as { reasoning_effort?: unknown }).reasoning_effort;
		delete (params as { reasoning?: unknown }).reasoning;
	}

	// OpenRouter provider routing preferences
	if (model.baseUrl.includes("openrouter.ai") && compat.openRouterRouting) {
		Reflect.set(params, "provider", compat.openRouterRouting);
	}

	// Vercel AI Gateway provider routing preferences
	if (model.baseUrl.includes("ai-gateway.vercel.sh") && model.compat?.vercelGatewayRouting) {
		const routing = model.compat.vercelGatewayRouting;
		if (routing.only || routing.order) {
			const gatewayOptions: Record<string, string[]> = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			Reflect.set(params, "providerOptions", { gateway: gatewayOptions });
		}
	}

	if (compat.extraBody) {
		Object.assign(params, compat.extraBody);
	}

	return buildParamsResult(params, toolStrictMode);
}

function buildParamsResult(
	params: OpenAICompletionsSamplingParams,
	toolStrictMode: AppliedToolStrictMode,
): { params: OpenAICompletionsSamplingParams; toolStrictMode: AppliedToolStrictMode } {
	return { params, toolStrictMode };
}

function getOptionalNumberProperty(value: object, key: string): number | undefined {
	const property = Reflect.get(value, key);
	return typeof property === "number" ? property : undefined;
}

function getOptionalObjectProperty(value: object, key: string): object | undefined {
	const property = Reflect.get(value, key);
	return typeof property === "object" && property !== null ? property : undefined;
}

function getChoiceUsage(choice: ChatCompletionChunk.Choice): object | undefined {
	return getOptionalObjectProperty(choice, "usage");
}

export function parseChunkUsage(
	rawUsage: object,
	model: Model<"openai-completions">,
	copilotPremiumRequests: number | undefined,
): AssistantMessage["usage"] {
	const promptTokenDetails = getOptionalObjectProperty(rawUsage, "prompt_tokens_details");
	const completionTokenDetails = getOptionalObjectProperty(rawUsage, "completion_tokens_details");
	const cachedTokens =
		getOptionalNumberProperty(rawUsage, "cached_tokens") ??
		(promptTokenDetails ? getOptionalNumberProperty(promptTokenDetails, "cached_tokens") : undefined) ??
		0;
	// OpenRouter exposes cache writes via `prompt_tokens_details.cache_write_tokens`
	// and INCLUDES them in `prompt_tokens`. Without subtracting, cache-write tokens
	// leak into `input` (e.g. GLM/Anthropic via OpenRouter on a fresh cache).
	// Ref: https://openrouter.ai/docs/guides/best-practices/prompt-caching
	const cacheWriteTokens = promptTokenDetails
		? (getOptionalNumberProperty(promptTokenDetails, "cache_write_tokens") ?? 0)
		: 0;
	const reasoningTokens =
		(completionTokenDetails ? getOptionalNumberProperty(completionTokenDetails, "reasoning_tokens") : undefined) ?? 0;
	const promptTokens = getOptionalNumberProperty(rawUsage, "prompt_tokens") ?? 0;
	const input = Math.max(0, promptTokens - cachedTokens - cacheWriteTokens);
	// Per OpenAI's CompletionUsage spec, `reasoning_tokens` is a subset of
	// `completion_tokens` (which is the total billed output). Adding them would
	// double-count.
	const outputTokens = getOptionalNumberProperty(rawUsage, "completion_tokens") ?? 0;
	const usage: AssistantMessage["usage"] = {
		input,
		output: outputTokens,
		cacheRead: cachedTokens,
		cacheWrite: cacheWriteTokens,
		totalTokens: input + outputTokens + cachedTokens + cacheWriteTokens,
		...(reasoningTokens > 0 ? { reasoningTokens } : {}),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...(copilotPremiumRequests !== undefined ? { premiumRequests: copilotPremiumRequests } : {}),
	};
	calculateCost(model, usage);
	return usage;
}

function mapReasoningEffort(
	effort: NonNullable<OpenAICompletionsOptions["reasoning"]>,
	reasoningEffortMap: Partial<Record<NonNullable<OpenAICompletionsOptions["reasoning"]>, string>>,
): string {
	return reasoningEffortMap[effort] ?? effort;
}

function maybeAddOpenRouterAnthropicCacheControl(
	model: Model<"openai-completions">,
	messages: ChatCompletionMessageParam[],
): void {
	if (model.provider !== "openrouter" || !model.id.startsWith("anthropic/")) return;

	// Anthropic-style caching requires cache_control on a text part. Add a breakpoint
	// on the last user/assistant message (walking backwards until we find text content).
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "developer") continue;

		const content = msg.content;
		if (typeof content === "string") {
			msg.content = [
				Object.assign({ type: "text" as const, text: content }, { cache_control: { type: "ephemeral" } }),
			];
			return;
		}

		if (!Array.isArray(content)) continue;

		// Find last text part and add cache_control
		for (let j = content.length - 1; j >= 0; j--) {
			const part = content[j];
			if (part?.type === "text") {
				Object.assign(part, { cache_control: { type: "ephemeral" } });
				return;
			}
		}
	}
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: ResolvedOpenAICompat,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];

	const normalizeToolCallId = (id: string): string => {
		if (compat.requiresMistralToolIds) return normalizeMistralToolId(id, true);

		// Handle pipe-separated IDs from OpenAI Responses API
		// Format: {call_id}|{id} where {id} can be 400+ chars with special chars (+, /, =)
		// These come from providers like github-copilot, openai-codex, opencode
		// Extract just the call_id part and normalize it
		if (id.includes("|")) {
			const [callId] = id.split("|");
			// Sanitize to allowed chars and truncate to 40 chars (OpenAI limit)
			return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
		}

		if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
		return id;
	};
	const transformedMessages = transformMessages(context.messages, model, id => normalizeToolCallId(id));

	const remappedToolCallIds = new Map<string, string[]>();
	let generatedToolCallIdCounter = 0;

	const generateFallbackToolCallId = (seed: string): string => {
		generatedToolCallIdCounter += 1;
		const hash = Bun.hash(`${model.provider}:${model.id}:${seed}:${generatedToolCallIdCounter}`).toString(36);
		return `call_${hash}`;
	};

	const rememberToolCallId = (originalId: string, normalizedId: string): void => {
		const queue = remappedToolCallIds.get(originalId);
		if (queue) {
			queue.push(normalizedId);
			return;
		}
		remappedToolCallIds.set(originalId, [normalizedId]);
	};

	const consumeToolCallId = (originalId: string): string | null => {
		const queue = remappedToolCallIds.get(originalId);
		if (!queue || queue.length === 0) return null;
		const nextId = queue.shift() ?? null;
		if (queue.length === 0) remappedToolCallIds.delete(originalId);
		return nextId;
	};

	const ensureToolCallId = (rawId: string, seed: string): string => {
		const normalized = normalizeToolCallId(rawId);
		if (normalized.trim().length > 0) return normalized;
		return generateFallbackToolCallId(seed);
	};

	if (context.systemPrompt) {
		const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
		const role = useDeveloperRole ? "developer" : "system";
		params.push({ role: role, content: context.systemPrompt.toWellFormed() });
	}

	let lastRole: string | null = null;

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		// Some providers (e.g. Mistral/Devstral) don't allow user messages directly after tool results
		// Insert a synthetic assistant message to bridge the gap
		if (
			compat.requiresAssistantAfterToolResult &&
			lastRole === "toolResult" &&
			(msg.role === "user" || msg.role === "developer")
		) {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

		const devAsUser = !compat.supportsDeveloperRole;
		if (msg.role === "user" || msg.role === "developer") {
			const role = !devAsUser && msg.role === "developer" ? "developer" : "user";
			if (typeof msg.content === "string") {
				const text = msg.content.toWellFormed();
				if (text.trim().length === 0) continue;
				params.push({
					role: role,
					content: text,
				});
			} else {
				const content: ChatCompletionContentPart[] = [];
				for (const item of msg.content) {
					if (item.type === "text") {
						const text = item.text.toWellFormed();
						if (text.trim().length === 0) continue;
						content.push({
							type: "text",
							text,
						} satisfies ChatCompletionContentPartText);
					} else {
						content.push({
							type: "image_url",
							image_url: {
								url: `data:${item.mimeType};base64,${item.data}`,
							},
						} satisfies ChatCompletionContentPartImage);
					}
				}
				const filteredContent = !model.input.includes("image")
					? content.filter(c => c.type !== "image_url")
					: content;
				if (filteredContent.length === 0) continue;
				params.push({
					role: "user",
					content: filteredContent,
				});
			}
		} else if (msg.role === "assistant") {
			// Some providers (e.g. Mistral) don't accept null content, use empty string instead
			const assistantMsg: ChatCompletionAssistantMessageParam = {
				role: "assistant",
				content: compat.requiresAssistantAfterToolResult ? "" : null,
			};

			const textBlocks = msg.content.filter(b => b.type === "text") as TextContent[];
			// Filter out empty text blocks to avoid API validation errors
			const nonEmptyTextBlocks = textBlocks.filter(b => b.text && b.text.trim().length > 0);
			if (nonEmptyTextBlocks.length > 0) {
				// Always send assistant content as a plain string. Some OpenAI-compatible
				// backends mirror array-of-text-block payloads back to the model literally,
				// causing recursive nested content in subsequent turns.
				assistantMsg.content = nonEmptyTextBlocks.map(b => b.text.toWellFormed()).join("");
			}

			// Handle thinking blocks
			const thinkingBlocks = msg.content.filter(b => b.type === "thinking") as ThinkingContent[];
			// Filter out empty thinking blocks to avoid API validation errors
			const nonEmptyThinkingBlocks = thinkingBlocks.filter(b => b.thinking && b.thinking.trim().length > 0);
			if (nonEmptyThinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) {
					// Convert thinking blocks to plain text (no tags to avoid model mimicking them)
					const thinkingText = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n\n");
					const textContent = assistantMsg.content as Array<{ type: "text"; text: string }> | null;
					if (textContent) {
						textContent.unshift({ type: "text", text: thinkingText });
					} else {
						assistantMsg.content = [{ type: "text", text: thinkingText }];
					}
				} else {
					// Use the signature from the first thinking block if available, but only for
					// recognized OpenAI-compat reasoning field names. Opaque signatures from other
					// providers (Anthropic encrypted, OpenAI Responses JSON) are not valid property names.
					const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
					const recognizedFields = ["reasoning_content", "reasoning", "reasoning_text"];
					if (signature && recognizedFields.includes(signature)) {
						(assistantMsg as any)[signature] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
					}
				}
			}

			if (compat.thinkingFormat === "openai") {
				const streamedReasoningField = nonEmptyThinkingBlocks[0]?.thinkingSignature;
				const reasoningField =
					streamedReasoningField === "reasoning_content" ||
					streamedReasoningField === "reasoning" ||
					streamedReasoningField === "reasoning_text"
						? streamedReasoningField
						: (compat.reasoningContentField ?? "reasoning_content");
				const reasoningContent = (assistantMsg as any)[reasoningField];
				if (!reasoningContent) {
					const reasoning = (assistantMsg as any).reasoning;
					const reasoningText = (assistantMsg as any).reasoning_text;
					if (reasoning && reasoningField !== "reasoning") {
						(assistantMsg as any)[reasoningField] = reasoning;
					} else if (reasoningText && reasoningField !== "reasoning_text") {
						(assistantMsg as any)[reasoningField] = reasoningText;
					} else if (nonEmptyThinkingBlocks.length > 0) {
						(assistantMsg as any)[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
					}
				}
			}

			const toolCalls = msg.content.filter(b => b.type === "toolCall") as ToolCall[];
			// Replay reasoning_content on assistant tool-call turns for backends that validate
			// thinking-mode history. The replay logic has three tiers:
			//   1. Recover from thinking blocks with valid signatures (covers same-model replay
			//      where nonEmptyThinkingBlocks may have filtered out empty-text blocks)
			//   2. For providers that require the field but returned no reasoning at all
			//      (e.g. proxy-stripped reasoning_content), emit an empty string
			//   3. For providers that accept synthetic placeholders (Kimi, OpenRouter), emit "."
			// DeepSeek V4 rejects synthetic "." placeholders — it validates the exact value —
			// so the allowsSyntheticReasoningContentForToolCalls flag controls tier 3.
			const canUseSyntheticReasoningContent =
				compat.requiresReasoningContentForToolCalls &&
				compat.allowsSyntheticReasoningContentForToolCalls &&
				(compat.thinkingFormat === "openai" || compat.thinkingFormat === "openrouter");
			let hasReasoningField =
				(assistantMsg as any).reasoning_content !== undefined ||
				(assistantMsg as any).reasoning !== undefined ||
				(assistantMsg as any).reasoning_text !== undefined;
			// Tier 1: Recover reasoning_content from ALL thinking blocks (including empty-text
			// ones) when the provider requires exact replay and rejects synthetic placeholders.
			// This covers the case where thinking blocks have valid signatures but were excluded
			// by the nonEmptyThinkingBlocks filter above, or where thinking text is empty but
			// the signature identifies the correct field name for replay.
			// Only recognized OpenAI-compat reasoning field names qualify — opaque signatures
			// from other providers (Anthropic encrypted, OpenAI Responses JSON, etc.) are not
			// valid property names for the wire message.
			if (
				toolCalls.length > 0 &&
				!hasReasoningField &&
				compat.requiresReasoningContentForToolCalls &&
				!compat.allowsSyntheticReasoningContentForToolCalls
			) {
				const allThinkingBlocks = msg.content.filter(b => b.type === "thinking") as ThinkingContent[];
				if (allThinkingBlocks.length > 0) {
					const signature = allThinkingBlocks[0].thinkingSignature;
					const recognizedFields = ["reasoning_content", "reasoning", "reasoning_text"];
					if (signature && recognizedFields.includes(signature)) {
						(assistantMsg as any)[signature] = allThinkingBlocks.map(b => b.thinking).join("\n");
						hasReasoningField = true;
					}
				}
			}
			// Tier 2: When the provider requires reasoning_content but there are genuinely no
			// thinking blocks at all (e.g. proxy stripped reasoning_content from the response),
			// emit an empty string. The field must be present; an empty string is the most honest
			// representation of "no reasoning was captured."
			if (
				toolCalls.length > 0 &&
				!hasReasoningField &&
				compat.requiresReasoningContentForToolCalls &&
				!compat.allowsSyntheticReasoningContentForToolCalls
			) {
				const reasoningField = compat.reasoningContentField ?? "reasoning_content";
				(assistantMsg as any)[reasoningField] = "";
				hasReasoningField = true;
			}
			// Tier 3: For providers that accept synthetic placeholders (Kimi, OpenRouter).
			if (toolCalls.length > 0 && canUseSyntheticReasoningContent && !hasReasoningField) {
				const reasoningField = compat.reasoningContentField ?? "reasoning_content";
				(assistantMsg as any)[reasoningField] = ".";
				hasReasoningField = true;
			}
			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc, toolCallIndex) => {
					const toolCallId = ensureToolCallId(tc.id, `${i}:${toolCallIndex}:${tc.name}`);
					rememberToolCallId(tc.id, toolCallId);
					return {
						id: normalizeMistralToolId(toolCallId, compat.requiresMistralToolIds),
						type: "function" as const,
						function: {
							name: tc.name,
							arguments: serializeToolArguments(tc.arguments),
						},
					};
				});
				const reasoningDetails = toolCalls
					.filter(tc => tc.thoughtSignature)
					.map(tc => {
						try {
							return JSON.parse(tc.thoughtSignature!);
						} catch {
							return null;
						}
					})
					.filter(Boolean);
				if (reasoningDetails.length > 0) {
					(assistantMsg as any).reasoning_details = reasoningDetails;
				}
			}
			// DeepSeek requires non-null content when reasoning_content is present
			if (assistantMsg.content === null && hasReasoningField) {
				assistantMsg.content = "";
			}
			// Skip assistant messages that have no content, no tool calls, and no reasoning payload.
			// Some OpenAI-compatible backends require replaying reasoning-only assistant turns
			// so follow-up requests preserve the provider-specific reasoning field name.
			const content = assistantMsg.content;
			const hasContent =
				content !== null &&
				content !== undefined &&
				(typeof content === "string" ? content.length > 0 : content.length > 0);
			if (!hasContent && assistantMsg.tool_calls && compat.requiresAssistantContentForToolCalls) {
				assistantMsg.content = ".";
			}
			if (!hasContent && !assistantMsg.tool_calls && !hasReasoningField) {
				continue;
			}
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			// Batch consecutive tool results and collect all images
			const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
			let j = i;

			for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
				const toolMsg = transformedMessages[j] as ToolResultMessage;

				// Extract text and image content
				const textResult = toolMsg.content
					.filter(c => c.type === "text")
					.map(c => (c as any).text)
					.join("\n");
				const hasImages = toolMsg.content.some(c => c.type === "image");

				// Always send tool result with text (or placeholder if only images)
				const hasText = textResult.length > 0;
				// Some providers (e.g. Mistral) require the 'name' field in tool results
				const remappedToolCallId = consumeToolCallId(toolMsg.toolCallId);
				const resolvedToolCallId =
					remappedToolCallId ?? ensureToolCallId(toolMsg.toolCallId, `${j}:${toolMsg.toolName ?? "tool"}`);
				const toolResultMsg: ChatCompletionToolMessageParam = {
					role: "tool",
					content: (hasText ? textResult : "(see attached image)").toWellFormed(),
					tool_call_id: normalizeMistralToolId(resolvedToolCallId, compat.requiresMistralToolIds),
				};
				if (compat.requiresToolResultName && toolMsg.toolName) {
					(toolResultMsg as any).name = toolMsg.toolName;
				}
				params.push(toolResultMsg);

				if (hasImages && model.input.includes("image")) {
					for (const block of toolMsg.content) {
						if (block.type === "image") {
							imageBlocks.push({
								type: "image_url",
								image_url: {
									url: `data:${(block as any).mimeType};base64,${(block as any).data}`,
								},
							});
						}
					}
				}
			}

			i = j - 1;

			// After all consecutive tool results, add a single user message with all images
			if (imageBlocks.length > 0) {
				if (compat.requiresAssistantAfterToolResult) {
					params.push({
						role: "assistant",
						content: "I have processed the tool results.",
					});
				}

				params.push({
					role: "user",
					content: [
						{
							type: "text",
							text: "Attached image(s) from tool result:",
						},
						...imageBlocks,
					],
				});
				lastRole = "user";
			} else {
				lastRole = "toolResult";
			}
			continue;
		}

		lastRole =
			msg.role === "developer"
				? model.reasoning && compat.supportsDeveloperRole
					? "developer"
					: "system"
				: msg.role;
	}

	return params;
}

function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompat,
	toolStrictModeOverride?: ToolStrictModeOverride,
): BuiltOpenAICompletionTools {
	const adaptedTools = tools.map(tool => {
		const strict = !NO_STRICT && compat.supportsStrictMode !== false && tool.strict !== false;
		const baseParameters = tool.parameters as unknown as Record<string, unknown>;
		const adapted = adaptSchemaForStrict(baseParameters, strict);
		return {
			tool,
			baseParameters,
			parameters: adapted.schema,
			strict: adapted.strict,
		};
	});

	const requestedStrictMode = toolStrictModeOverride ?? compat.toolStrictMode;
	const toolStrictMode =
		requestedStrictMode === "none"
			? "none"
			: requestedStrictMode === "all_strict"
				? adaptedTools.every(tool => tool.strict)
					? "all_strict"
					: "none"
				: "mixed";

	return {
		tools: adaptedTools.map(({ tool, baseParameters, parameters, strict }) => {
			const includeStrict = toolStrictMode === "all_strict" || (toolStrictMode === "mixed" && strict);
			return {
				type: "function",
				function: {
					name: tool.name,
					description: tool.description || "",
					parameters: includeStrict ? parameters : baseParameters,
					// Only include strict if provider supports it. Some reject unknown fields.
					...(includeStrict && { strict: true }),
				},
			};
		}),
		toolStrictMode,
	};
}

function shouldRetryWithoutStrictTools(
	error: unknown,
	capturedErrorResponse: CapturedHttpErrorResponse | undefined,
	toolStrictMode: AppliedToolStrictMode,
	tools: Tool[] | undefined,
): boolean {
	if (!tools || tools.length === 0 || toolStrictMode !== "all_strict") {
		return false;
	}
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400 && status !== 422) {
		return false;
	}
	const messageParts = [error instanceof Error ? error.message : undefined, capturedErrorResponse?.bodyText]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n");
	return /wrong_api_format|mixed values for 'strict'|tool[s]?\b.*strict|\bstrict\b.*tool/i.test(messageParts);
}

function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		default:
			return {
				stopReason: "error",
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

/**
 * Detect compatibility settings from provider and baseUrl for known providers.
 * Provider takes precedence over URL-based detection since it's explicitly configured.
 * Returns a fully resolved OpenAICompat object with all fields set.
 */
export function detectCompat(model: Model<"openai-completions">): ResolvedOpenAICompat {
	return detectOpenAICompat(model);
}

/**
 * Get resolved compatibility settings for a model.
 * Uses explicit model.compat if provided, otherwise auto-detects from provider/URL.
 * @param model - The model configuration
 * @param resolvedBaseUrl - Optional resolved base URL (e.g., after GitHub Copilot proxy-ep resolution).
 */
function getCompat(model: Model<"openai-completions">, resolvedBaseUrl?: string): ResolvedOpenAICompat {
	return resolveOpenAICompat(model, resolvedBaseUrl);
}
