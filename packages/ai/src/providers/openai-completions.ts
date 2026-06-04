import { $env, extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import OpenAI, { APIConnectionTimeoutError as OpenAIConnectionTimeoutError } from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionMessageParam,
	ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import packageJson from "../../package.json" with { type: "json" };
import { type Effort, getSupportedEfforts } from "../model-thinking";
import { calculateCost } from "../models";
import { getEnvApiKey } from "../stream";
import {
	type AssistantMessage,
	type Context,
	type FetchImpl,
	type Message,
	type MessageAttribution,
	type Model,
	type OpenAICompat,
	type ProviderSessionState,
	resolveServiceTier,
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
import { normalizeSystemPrompts } from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { toFirepassWireModelId, toFireworksWireModelId } from "../utils/fireworks-model-id";
import {
	type CapturedHttpErrorResponse,
	finalizeErrorMessage,
	type RawHttpRequestDump,
	rewriteCopilotError,
} from "../utils/http-inspector";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { parseStreamingJson, parseStreamingJsonThrottled } from "../utils/json-parse";
import { parseGitHubCopilotApiKey } from "../utils/oauth/github-copilot";
import { getKimiCommonHeaders } from "../utils/oauth/kimi";
import { notifyProviderResponse } from "../utils/provider-response";
import { callWithCopilotModelRetry } from "../utils/retry";
import { adaptSchemaForStrict, NO_STRICT, toolWireSchema } from "../utils/schema";
import { wrapFetchForSseDebug } from "../utils/sse-debug";
import {
	getStreamMarkupHealingPattern,
	type HealedToolCall,
	StreamMarkupHealing,
	type StreamMarkupHealingEvent,
} from "../utils/stream-markup-healing";
import { isForcedToolChoice, mapToOpenAICompletionsToolChoice } from "../utils/tool-choice";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	resolveGitHubCopilotBaseUrl,
} from "./github-copilot-headers";
import { detectOpenAICompat, type ResolvedOpenAICompat, resolveOpenAICompat } from "./openai-completions-compat";
import { createInitialResponsesAssistantMessage } from "./openai-responses-shared";
import { transformMessages } from "./transform-messages";
import { joinTextWithImagePlaceholder, NON_VISION_IMAGE_PLACEHOLDER } from "./vision-guard";

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
// Direct DeepSeek model ids on NanoGPT are routed via the default tools-capable
// path. We deliberately do NOT append `:tools` here: with `:tools`, NanoGPT
// performs server-side tool-call parsing on the upstream DeepSeek stream and
// 502s with `code: "malformed_tool_call"` on more complex tool schemas (issue
// #1488). The default route forwards `delta.content` (including any DSML
// envelope leaks) which `StreamMarkupHealing` heals into a structured call
// client-side.
function resolveOpenAICompletionsModelId(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): string {
	if (model.provider === "firepass") return toFirepassWireModelId(model.id);
	if (model.provider === "fireworks") return toFireworksWireModelId(model.id);
	if (model.provider === "openrouter") return applyOpenRouterRoutingVariant(model.id, options?.openrouterVariant);
	return model.id;
}

/**
 * Normalize OpenAI-compatible streaming `delta.content` into plain text.
 * Most providers stream `delta.content` as a string, but some (notably Mistral
 * Medium 3.5 / `mistral-medium-2604`) return an array of typed content parts
 * — e.g. `[{ type: "text", text: "Hello" }]`. Without normalization those
 * parts get string-coerced via `text += array`, producing the literal
 * `[object Object]` sequences observed in issue #911.
 *
 * Returns the joined text. Non-text parts and unknown shapes are skipped so
 * we never emit JS object sigils as visible output.
 */
function normalizeStreamingContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		let out = "";
		for (const part of content) {
			if (typeof part === "string") {
				out += part;
			} else if (part && typeof part === "object") {
				const obj = part as { type?: unknown; text?: unknown };
				if ((obj.type === undefined || obj.type === "text") && typeof obj.text === "string") {
					out += obj.text;
				}
			}
		}
		return out;
	}
	if (content && typeof content === "object") {
		const obj = content as { type?: unknown; text?: unknown };
		if ((obj.type === undefined || obj.type === "text") && typeof obj.text === "string") {
			return obj.text;
		}
	}
	return "";
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
/**
 * Identify "real progress" stream chunks vs. keepalives, role-only preambles,
 * and empty `{choices:[]}` no-ops emitted by some OpenAI-compatible endpoints.
 * Without this filter, every keepalive resets `iterateWithIdleTimeout`'s
 * deadline, so a provider that streams nothing but pings keeps the watchdog
 * asleep indefinitely — observed against z.ai/GLM via OpenRouter where a
 * subagent stalled for hours with no error surfaced.
 *
 * A chunk counts as progress when it carries terminal usage, a finish reason,
 * or any model-produced delta (content / tool calls / reasoning / refusal).
 * Role-only `delta: { role: "assistant" }` preambles do NOT count; we want the
 * (longer) first-event timeout to keep governing until real output appears.
 */
export function isOpenAICompletionsProgressChunk(chunk: unknown): boolean {
	if (!chunk || typeof chunk !== "object") return false;
	const record = chunk as {
		usage?: unknown;
		choices?: ReadonlyArray<{
			finish_reason?: unknown;
			usage?: unknown;
			delta?: {
				content?: unknown;
				tool_calls?: unknown;
				reasoning?: unknown;
				reasoning_content?: unknown;
				reasoning_text?: unknown;
				refusal?: unknown;
			};
		}>;
	};
	if (record.usage) return true;
	const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
	if (!choice) return false;
	if (choice.finish_reason) return true;
	if (choice.usage) return true;
	const delta = choice.delta;
	if (!delta) return false;
	const content = delta.content;
	if (typeof content === "string" ? content.length > 0 : Array.isArray(content) && content.length > 0) return true;
	if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
	if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) return true;
	if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
	if (typeof delta.reasoning_text === "string" && delta.reasoning_text.length > 0) return true;
	if (typeof delta.refusal === "string" && delta.refusal.length > 0) return true;
	return false;
}

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: ToolChoice;
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
	/** Force-disable reasoning where supported, or request the lowest effort on generic effort endpoints. */
	disableReasoning?: boolean;
	serviceTier?: ServiceTier;
	/**
	 * Routing-variant suffix appended to OpenRouter model IDs when none is
	 * already present (`anthropic/claude-haiku-latest` → `…:nitro`). Common
	 * values: `"nitro"`, `"floor"`, `"online"`, `"exacto"`. Ignored when the
	 * resolved `model.id` already contains a colon-suffix after the last
	 * provider segment (explicit `:nitro` in the selector or a catalog entry
	 * with the variant baked in).
	 */
	openrouterVariant?: string;
}

type OpenAICompletionsParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
	top_k?: number;
	min_p?: number;
	repetition_penalty?: number;
	thinking?: { type: "enabled" | "disabled" };
	enable_thinking?: boolean;
	chat_template_kwargs?: { enable_thinking: boolean };
	reasoning?: { effort?: string } | { enabled: false };
	provider?: OpenAICompat["openRouterRouting"];
	providerOptions?: { gateway?: { only?: string[]; order?: string[] } };
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

/**
 * Append an OpenRouter routing-variant suffix (e.g. `:nitro`, `:floor`, `:online`, `:exacto`)
 * to a model id when no explicit variant is already present. A variant is considered
 * "already present" when `modelId` contains a colon after the last `/` separator —
 * which covers both user-typed selectors (`anthropic/claude-haiku:nitro`) and catalog
 * entries that bake the variant in (`deepseek/deepseek-v3.1-terminus:exacto`).
 *
 * Exported for unit testing.
 */
export function applyOpenRouterRoutingVariant(modelId: string, variant: string | undefined): string {
	if (!variant) return modelId;
	const lastSlash = modelId.lastIndexOf("/");
	const lastColon = modelId.lastIndexOf(":");
	// Existing `:suffix` after the last path segment — leave the id untouched.
	if (lastColon > lastSlash) return modelId;
	return `${modelId}:${variant}`;
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

// DeepSeek models leak chat-template special tokens (e.g. `<｜tool_calls_begin｜>`,
// `<｜DSML｜tool_calls｜>`) into visible `content` deltas when hosted behind providers
// (such as NVIDIA NIM) that don't strip them server-side. The structured `tool_calls`
// payload is still emitted correctly — we only need to filter the leaked markers from
// user-visible text. Tokens use either fullwidth pipes (｜, U+FF5C) or ASCII pipes.
// Body is restricted to identifier-like chars (with the DeepSeek tokenizer's `▁`),
// capped at a sane length to avoid swallowing legitimate angle-bracket text.
const DEEPSEEK_SPECIAL_TOKEN_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/g;
const DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX = /^\s*<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/;
const DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>\s*$/;
const DEEPSEEK_OPEN_DELIMS = ["<｜", "<|"] as const;

function stripDeepseekSpecialTokens(text: string): string {
	const stripped = text.replace(DEEPSEEK_SPECIAL_TOKEN_REGEX, "");
	if (stripped === text) return text;

	let normalized = stripped;
	if (DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX.test(text)) normalized = normalized.replace(/^\s+/u, "");
	if (DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX.test(text)) normalized = normalized.replace(/\s+$/u, "");
	return normalized;
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

const GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000;
const GLM_CODING_PLAN_MODEL_PATTERN = /^glm-5(?:[.-]|$)/i;

/** Returns the widened OpenAI stream watchdog floor for slow GLM coding-plan reasoning models. */
export function getOpenAICompletionsStreamIdleTimeoutFallbackMs(
	model: Model<"openai-completions">,
): number | undefined {
	if (!GLM_CODING_PLAN_MODEL_PATTERN.test(model.id)) return undefined;
	if (model.provider === "zhipu-coding-plan" || model.provider === "zai")
		return GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS;

	const baseUrl = model.baseUrl.toLowerCase();
	if (baseUrl.includes("open.bigmodel.cn") || baseUrl.includes("api.z.ai")) {
		return GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS;
	}

	return undefined;
}

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

		const output: AssistantMessage = createInitialResponsesAssistantMessage(model.api, model.provider, model.id);
		let rawRequestDump: RawHttpRequestDump | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new Error(OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE);
		const { requestAbortController, requestSignal } = abortTracker;

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const idleTimeoutFallbackMs = getOpenAICompletionsStreamIdleTimeoutFallbackMs(model);
			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs(idleTimeoutFallbackMs);
			const firstEventTimeoutMs =
				options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
			const {
				client,
				copilotPremiumRequests,
				baseUrl,
				requestHeaders,
				getCapturedErrorResponse: captureErrorResponse,
				clearCapturedErrorResponse,
			} = await createClient(
				model,
				context,
				apiKey,
				options?.headers,
				options?.initiatorOverride,
				options?.onSseEvent,
				options?.fetch,
			);
			const premiumRequestsTotal = copilotPremiumRequests;
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
				const requestOptions =
					requestTimeoutMs === undefined
						? { signal: requestSignal }
						: { signal: requestSignal, timeout: requestTimeoutMs };
				let requestTimeout: NodeJS.Timeout | undefined;
				if (requestTimeoutMs !== undefined) {
					requestTimeout = setTimeout(
						() => abortTracker.abortLocally(firstEventTimeoutAbortError),
						requestTimeoutMs,
					);
				}
				try {
					const { data, response, request_id } = await client.chat.completions
						.create(params, requestOptions)
						.withResponse();
					await notifyProviderResponse(options, response, model, request_id);
					return data;
				} catch (error) {
					if (error instanceof OpenAIConnectionTimeoutError && !abortTracker.wasCallerAbort()) {
						throw firstEventTimeoutAbortError;
					}
					throw error;
				} finally {
					if (requestTimeout !== undefined) clearTimeout(requestTimeout);
				}
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
			if (premiumRequestsTotal !== undefined) {
				output.usage.premiumRequests = premiumRequestsTotal;
			}
			stream.push({ type: "start", partial: output });

			const parseMiniMaxThinkTags = model.provider === "minimax-code" || model.provider === "minimax-code-cn";
			// Some OpenAI-compatible DeepSeek hosts (including NVIDIA NIM and DeepSeek's
			// native API) leak chat-template tool-call markers in `delta.content` even
			// though tool calls are also surfaced structurally. Strip the leaked markers
			// so users don't see raw `<｜...｜>` tokens.
			const stripDeepseekChatTemplateTokens =
				/deepseek/i.test(model.id) && (model.provider === "nvidia" || model.provider === "deepseek");
			type ToolCallStreamBlock = ToolCall & {
				partialArgs?: string | Record<string, unknown>;
				streamIndex?: number;
				lastParseLen?: number;
			};
			type OpenAIStreamBlock = TextContent | ThinkingContent | ToolCallStreamBlock;
			const pendingToolCallBlocks: ToolCallStreamBlock[] = [];
			const toolCallBlockByIndex = new Map<number, ToolCallStreamBlock>();
			let currentBlock: OpenAIStreamBlock | undefined;
			const blockIndex = (block: OpenAIStreamBlock | undefined): number => {
				if (!block) return Math.max(0, output.content.length - 1);
				return output.content.indexOf(block);
			};
			const finishToolCallBlock = (block: ToolCallStreamBlock): void => {
				if (block.partialArgs === undefined) return;
				const contentIndex = blockIndex(block);
				if (contentIndex < 0) return;
				block.arguments =
					typeof block.partialArgs === "string" ? parseStreamingJson(block.partialArgs) : block.partialArgs;
				delete block.partialArgs;
				delete block.lastParseLen;
				if (block.streamIndex !== undefined) {
					toolCallBlockByIndex.delete(block.streamIndex);
					delete block.streamIndex;
				}
				const pendingIndex = pendingToolCallBlocks.indexOf(block);
				if (pendingIndex >= 0) pendingToolCallBlocks.splice(pendingIndex, 1);
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
			};
			const finishPendingToolCallBlocks = (): void => {
				for (const block of [...pendingToolCallBlocks]) {
					finishToolCallBlock(block);
				}
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
				finishToolCallBlock(block);
			};
			const appendText = (
				message: AssistantMessage,
				eventStream: AssistantMessageEventStream,
				text: string,
			): void => {
				if (currentBlock?.type !== "text") {
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
					currentBlock?.type !== "thinking" ||
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

			const appendTextDelta = (text: string): void => {
				if (!text) return;
				if (!firstTokenTime) firstTokenTime = Date.now();
				appendText(output, stream, text);
			};
			const appendThinkingDelta = (thinking: string, signature?: string): void => {
				if (!thinking) return;
				if (!firstTokenTime) firstTokenTime = Date.now();
				appendThinking(output, stream, thinking, signature);
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
				if (stripped && (stripped === flushable || stripped.trim().length > 0)) appendTextDelta(stripped);
			};
			const appendProcessedText = (processedText: string): void => {
				if (processedText.length === 0) return;
				if (stripDeepseekChatTemplateTokens) {
					deepseekStripBuffer += processedText;
					flushDeepseekStripBuffer(false);
				} else {
					appendTextDelta(processedText);
				}
			};

			const streamMarkupHealingPattern = getStreamMarkupHealingPattern(model.provider, model.id, {
				parseThinkingTags: parseMiniMaxThinkTags,
			});
			const streamMarkupHealing = streamMarkupHealingPattern
				? new StreamMarkupHealing({ pattern: streamMarkupHealingPattern })
				: undefined;
			let healedToolCallEmitted = false;
			const emitHealedToolCall = (call: HealedToolCall): void => {
				finishCurrentBlock(currentBlock);
				const block: ToolCall & { partialArgs: string } = {
					type: "toolCall",
					id: call.id,
					name: call.name,
					arguments: {},
					partialArgs: call.arguments,
				};
				block.arguments = parseStreamingJson(call.arguments);
				currentBlock = block;
				output.content.push(block);
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(block), partial: output });
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(block),
					delta: call.arguments,
					partial: output,
				});
				finishCurrentBlock(block);
				currentBlock = undefined;
				healedToolCallEmitted = true;
			};
			const emitHealingEvent = (event: StreamMarkupHealingEvent): void => {
				if (event.type === "text") {
					appendProcessedText(event.text);
				} else if (event.type === "thinking") {
					appendThinkingDelta(event.thinking);
				} else {
					emitHealedToolCall(event.call);
				}
			};
			const flushHealedToolCalls = (): void => {
				if (!streamMarkupHealing) return;
				const calls = streamMarkupHealing.drainCompleted();
				for (const call of calls) emitHealedToolCall(call);
			};

			for await (const chunk of iterateWithIdleTimeout(openaiStream, {
				idleTimeoutMs,
				firstItemTimeoutMs: firstEventTimeoutMs,
				firstItemErrorMessage: OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE,
				errorMessage: "OpenAI completions stream stalled while waiting for the next event",
				onIdle: () => requestAbortController.abort(),
				onFirstItemTimeout: () => abortTracker.abortLocally(firstEventTimeoutAbortError),
				abortSignal: options?.signal,
				isProgressItem: isOpenAICompletionsProgressChunk,
			})) {
				if (!chunk || typeof chunk !== "object") continue;

				// OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
				// and each chunk in a streamed completion carries the same id.
				output.responseId ||= chunk.id;

				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage, model, premiumRequestsTotal);
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;

				if (!chunk.usage) {
					const choiceUsage = getChoiceUsage(choice);
					if (choiceUsage) {
						output.usage = parseChunkUsage(choiceUsage, model, premiumRequestsTotal);
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
					const normalizedDeltaText = normalizeStreamingContentText(choice.delta.content);
					if (normalizedDeltaText.length > 0) {
						if (!firstTokenTime) firstTokenTime = Date.now();
						const hasStructuredToolCalls =
							Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length > 0;

						if (streamMarkupHealing) {
							if (hasStructuredToolCalls) {
								// Same chunk leaks markers AND carries structured tool_calls.
								// Strip the marker text from visible output, but drop any
								// synthesized calls so the structured payload stays the
								// single source of truth (avoids double-dispatch).
								appendProcessedText(streamMarkupHealing.consumeWithoutCalls(normalizedDeltaText));
							} else {
								for (const event of streamMarkupHealing.feedEvents(normalizedDeltaText)) {
									emitHealingEvent(event);
								}
							}
						} else {
							appendProcessedText(normalizedDeltaText);
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

					if (choice?.delta?.tool_calls && choice.delta.tool_calls.length > 0) {
						for (const toolCall of choice.delta.tool_calls) {
							const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
							let block = streamIndex !== undefined ? toolCallBlockByIndex.get(streamIndex) : undefined;
							if (!block && toolCall.id) {
								block = pendingToolCallBlocks.find(candidate => candidate.id === toolCall.id);
							}
							if (
								!block &&
								currentBlock?.type === "toolCall" &&
								(!toolCall.id || currentBlock.id === toolCall.id)
							) {
								block = currentBlock;
							}

							if (!block) {
								if (currentBlock?.type !== "toolCall") {
									finishCurrentBlock(currentBlock);
								}
								block = {
									type: "toolCall",
									id: toolCall.id || "",
									name: toolCall.function?.name || "",
									arguments: {},
									partialArgs: "",
									streamIndex,
								};
								if (streamIndex !== undefined) toolCallBlockByIndex.set(streamIndex, block);
								pendingToolCallBlocks.push(block);
								currentBlock = block;
								output.content.push(block);
								stream.push({
									type: "toolcall_start",
									contentIndex: blockIndex(block),
									partial: output,
								});
							} else {
								currentBlock = block;
								if (streamIndex !== undefined && block.streamIndex === undefined) {
									block.streamIndex = streamIndex;
									toolCallBlockByIndex.set(streamIndex, block);
								}
							}

							if (toolCall.id) block.id = toolCall.id;
							if (toolCall.function?.name) block.name = toolCall.function.name;
							let delta = "";
							// The OpenAI SDK types `function.arguments` as a JSON string, but MiniMax-compatible
							// hosts stream a fully-formed object instead. Model both shapes so the branches below
							// narrow honestly rather than widening through `unknown`.
							const rawArgs = toolCall.function?.arguments as string | Record<string, unknown> | undefined;
							if (typeof rawArgs === "string") {
								if (rawArgs.length > 0) {
									delta = rawArgs;
									const prev = typeof block.partialArgs === "string" ? block.partialArgs : "";
									block.partialArgs = prev + rawArgs;
									const throttled = parseStreamingJsonThrottled(block.partialArgs, block.lastParseLen ?? 0);
									if (throttled) {
										block.arguments = throttled.value;
										block.lastParseLen = throttled.parsedLen;
									}
								}
							} else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
								// MiniMax-compatible hosts stream `function.arguments` as a complete object in a
								// single delta instead of the OpenAI JSON-string contract. Hold the object directly
								// — no `[object Object]` round-trip through the string buffer — and serialize once for
								// the wire delta that proxy servers forward verbatim as `input_json_delta`.
								block.partialArgs = rawArgs;
								block.arguments = rawArgs;
								delta = JSON.stringify(rawArgs);
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(block),
								delta,
								partial: output,
							});
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

			if (streamMarkupHealing) {
				for (const event of streamMarkupHealing.flushEvents()) {
					emitHealingEvent(event);
				}
				flushHealedToolCalls();
				if (healedToolCallEmitted && output.stopReason === "stop") {
					// Hosts that leak tool-call templates often still report
					// `finish_reason: stop` for the surrounding turn. Promote
					// only that natural-completion finish — leave `error`,
					// `length`, `aborted`, etc. untouched.
					output.stopReason = "toolUse";
				}
			}

			if (stripDeepseekChatTemplateTokens) {
				flushDeepseekStripBuffer(true);
			}

			if (currentBlock?.type === "toolCall") {
				finishPendingToolCallBlocks();
			} else {
				finishCurrentBlock(currentBlock);
				finishPendingToolCallBlocks();
			}

			// Some OpenAI-compatible hosts stream structured `tool_calls` but report
			// `finish_reason: "stop"` instead of `"tool_calls"`. In the OpenAI contract a
			// tool call always means "execute and continue", so promote that
			// natural-completion finish to `toolUse` whenever the turn produced tool-call
			// blocks — the agent loop gates execution on the stop reason. `error`,
			// `length`, and `aborted` are intentionally left untouched. (Anthropic's
			// distinct `end_turn`-with-tool-calls "abandon" semantics live in its own
			// provider and correctly keep `stop`.)
			if (output.stopReason === "stop" && output.content.some(b => b.type === "toolCall")) {
				output.stopReason = "toolUse";
			}

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
			output.errorStatus = extractHttpStatusFromError(error) ?? getCapturedErrorResponse?.()?.status;
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
	onSseEvent?: OpenAICompletionsOptions["onSseEvent"],
	fetchOverride?: FetchImpl,
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

	let headers = { ...model.headers };
	if (model.provider === "openrouter") {
		// App attribution — opts the agent into OpenRouter's public rankings and per-app
		// analytics. `HTTP-Referer` is the unique app identifier; without it nothing is
		// tracked. `X-OpenRouter-Title` is the display name (`X-Title` is the legacy
		// alias kept for back-compat). `X-OpenRouter-Categories` slots us into the
		// `cli-agent` marketplace category. `User-Agent` overrides the default OpenAI
		// SDK UA so traffic is identifiable in upstream provider logs.
		// https://openrouter.ai/docs/app-attribution
		headers["User-Agent"] = `Oh-My-Pi/${packageJson.version}`;
		headers["HTTP-Referer"] = "https://omp.sh/";
		headers["X-OpenRouter-Title"] = "Oh-My-Pi";
		headers["X-OpenRouter-Categories"] = "cli-agent";
		// Always-on response caching: identical requests return cached responses for free.
		// TTL 1h; first call hits the provider, every identical call within the window
		// replays from OpenRouter's edge cache. https://openrouter.ai/docs/features/response-caching
		headers["X-OpenRouter-Cache"] = "true";
		headers["X-OpenRouter-Cache-TTL"] = "3600";
	}
	Object.assign(headers, extraHeaders);
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
	const baseFetch = fetchOverride ?? fetch;
	const wrappedFetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const response = await baseFetch(input, init);
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
		baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {},
	);
	const debugFetch = onSseEvent ? wrapFetchForSseDebug(wrappedFetch, event => onSseEvent(event, model)) : wrappedFetch;
	return {
		client: new OpenAI({
			apiKey,
			baseURL: baseUrl,
			dangerouslyAllowBrowser: true,
			maxRetries: 5,
			defaultHeaders: headers,
			defaultQuery: azureDefaultQuery,
			fetch: debugFetch,
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
): { params: OpenAICompletionsParams; toolStrictMode: AppliedToolStrictMode } {
	const compat = getCompat(model, resolvedBaseUrl);
	// Opencode Zen's gateway (https://opencode.ai/zen/go/v1) gates
	// `reasoning_content` on the request's thinking state for every model it
	// fronts (Kimi K2.x, DeepSeek V4, GLM-5.x, Qwen3.x, MiMo, MiniMax, …): it
	// 400s with `Extra inputs are not permitted` when thinking is off but the
	// field is supplied (#1071), and 400s with `thinking is enabled but
	// reasoning_content is missing in assistant tool call message at index N`
	// (#1484) when thinking is on and the field is absent. `detectOpenAICompat`
	// only set `requiresReasoningContentForToolCalls` for the DeepSeek family
	// (and previously for Kimi until #1071 carved out opencode); reactivate it
	// per request for every opencode model whenever this turn is in thinking
	// mode so prior tool-call turns replay reasoning_content. Forced-tool
	// turns are excluded because the later `disableReasoningOnForcedToolChoice`
	// guard at the bottom of `buildParams` strips thinking from the wire body
	// for Kimi-style models — keeping the replay on under those conditions
	// would resurrect the #1071 failure.
	//
	// `allowsSyntheticReasoningContentForToolCalls` is forced to `false` on
	// the same path: the gateway specifically requires `reasoning_content`,
	// and the default synthetic-friendly behavior would echo whichever field
	// the upstream streamed (e.g. `reasoning` for many opencode turns),
	// landing the replay in the wrong key and re-triggering the 400.
	const isOpenCodeProvider = model.provider === "opencode-go" || model.provider === "opencode-zen";
	const thinkingEnabledForRequest =
		Boolean(options?.reasoning) && !options?.disableReasoning && Boolean(model.reasoning);
	const forcedToolChoiceSuppressesThinking =
		compat.disableReasoningOnForcedToolChoice &&
		isForcedToolChoice(mapToOpenAICompletionsToolChoice(options?.toolChoice));
	if (isOpenCodeProvider && thinkingEnabledForRequest && !forcedToolChoiceSuppressesThinking) {
		compat.requiresReasoningContentForToolCalls = true;
		compat.allowsSyntheticReasoningContentForToolCalls = false;
		compat.reasoningContentField = "reasoning_content";
	}
	const isKimiModelId = model.id.includes("moonshotai/kimi") || /(^|\/)kimi[-.]/i.test(model.id);
	const messages = convertMessages(model, context, compat);
	maybeAddAnthropicCacheControl(compat, messages);
	const supportsReasoningParams = model.provider !== "github-copilot";

	// Kimi (including via OpenRouter and Fireworks router-form IDs such as
	// `accounts/fireworks/routers/kimi-*`) calculates TPM rate limits based on
	// max_tokens, not actual output. The official Kimi K2 model guidance
	// (https://docs.fireworks.ai/models/kimi-k2) also requires `max_tokens` for
	// every call since the family can otherwise emit very long reasoning traces
	// before the final answer. Always send max_tokens — match the same
	// Kimi-family regex used by the compat detector.
	// Note: Direct kimi-code provider is handled by the dedicated Kimi provider in kimi.ts.
	const effectiveMaxTokens = options?.maxTokens ?? (isKimiModelId ? model.maxTokens : undefined);

	const requestModelId = resolveOpenAICompletionsModelId(model, options);
	const params: OpenAICompletionsParams = {
		model: requestModelId,
		messages,
		stream: true,
	};
	let toolStrictMode: AppliedToolStrictMode = "none";

	if (compat.supportsUsageInStreaming !== false) {
		params.stream_options = { include_usage: true };
	}

	if (compat.supportsStore) {
		params.store = false;
	}

	if (effectiveMaxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			params.max_tokens = effectiveMaxTokens;
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
	if (options?.stopSequences?.length) {
		const seqs = options.stopSequences;
		params.stop = seqs.length === 1 ? seqs[0] : seqs.slice(0, 4);
	}
	if (options?.frequencyPenalty !== undefined) {
		params.frequency_penalty = options.frequencyPenalty;
	}
	if (shouldSendServiceTier(options?.serviceTier, model.provider)) {
		const resolved = resolveServiceTier(options?.serviceTier, model.provider);
		if (resolved === "flex" || resolved === "scale" || resolved === "priority") {
			params.service_tier = resolved;
		}
	}

	if (context.tools?.length) {
		const builtTools = convertTools(context.tools, compat, toolStrictModeOverride);
		params.tools = builtTools.tools;
		toolStrictMode = builtTools.toolStrictMode;
	} else if (context.tools === undefined && hasToolHistory(context.messages)) {
		// Anthropic (via LiteLLM/proxy) requires the `tools` param when the conversation
		// contains tool_calls/tool_results, even when no tools are offered this turn.
		// Only inject the sentinel when the caller passed `context.tools = undefined`
		// (i.e. tools were not specified at all). An explicit `context.tools = []` means
		// the caller opted out of tools for this turn (as /btw and IRC background replies
		// do via AgentSession.runEphemeralTurn) — honour that intent and emit nothing,
		// so LiteLLM → Bedrock never sees an empty `toolConfig` block.
		params.tools = [];
	}

	if (options?.toolChoice && compat.supportsToolChoice) {
		params.tool_choice = mapToOpenAICompletionsToolChoice(options.toolChoice);
	}

	if (params.tool_choice === "none" && (!Array.isArray(params.tools) || params.tools.length === 0)) {
		// `tool_choice: "none"` with no tools to gate is redundant and also
		// trips LiteLLM → Bedrock: the proxy serializes the directive into a
		// `toolConfig` block, and Bedrock requires `toolConfig.tools` to be
		// non-empty whenever the conversation already holds `toolUse`/`toolResult`
		// content. Drop it whenever the resolved tools list is missing or empty.
		// Side-channel turns hit this: `/btw` and IRC background replies route
		// through `AgentSession.runEphemeralTurn`, which sets `context.tools = []`
		// and `toolChoice: "none"` (see packages/coding-agent/src/session/agent-session.ts).
		delete params.tool_choice;
	}

	if (supportsReasoningParams && compat.thinkingFormat === "zai" && model.reasoning) {
		// Z.ai uses binary thinking: { type: "enabled" | "disabled" }
		// Must explicitly disable since z.ai defaults to thinking enabled.
		const enabled = options?.reasoning && !options?.disableReasoning;
		params.thinking = { type: enabled ? "enabled" : "disabled" };
	} else if (supportsReasoningParams && compat.thinkingFormat === "qwen" && model.reasoning) {
		// Qwen uses top-level enable_thinking: boolean
		params.enable_thinking = !!options?.reasoning && !options?.disableReasoning;
	} else if (supportsReasoningParams && compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
		params.chat_template_kwargs = {
			enable_thinking: !!options?.reasoning && !options?.disableReasoning,
		};
	} else if (supportsReasoningParams && compat.thinkingFormat === "openrouter" && model.reasoning) {
		// OpenRouter normalizes reasoning across providers via a nested reasoning object.
		// Without an explicit signal, OpenRouter defaults reasoning models to thinking, which
		// silently consumes the entire output budget on small `max_tokens` requests (e.g.
		// title generation). Honor `disableReasoning` to opt out cleanly.
		const openRouterParams = params as typeof params & {
			reasoning?: { effort?: string } | { enabled: false };
		};
		if (options?.disableReasoning) {
			openRouterParams.reasoning = { enabled: false };
		} else if (options?.reasoning) {
			openRouterParams.reasoning = {
				effort: mapReasoningEffort(options.reasoning, compat.reasoningEffortMap),
			};
		}
	} else if (
		supportsReasoningParams &&
		options?.reasoning &&
		!options?.disableReasoning &&
		model.reasoning &&
		compat.supportsReasoningEffort
	) {
		// OpenAI-style reasoning_effort
		params.reasoning_effort = mapReasoningEffort(options.reasoning, compat.reasoningEffortMap) as Effort;
	} else if (
		supportsReasoningParams &&
		options?.disableReasoning &&
		!options?.reasoning &&
		model.reasoning &&
		compat.supportsReasoningEffort
	) {
		// Generic OpenAI-compatible effort endpoints do not expose a true off
		// switch. Use the model's lowest supported effort as the closest
		// transport-level approximation when callers request disabled reasoning.
		const minEffort = getSupportedEfforts(model)[0];
		if (minEffort === undefined) {
			throw new Error(`Model ${model.provider}/${model.id} has no supported reasoning efforts`);
		}
		params.reasoning_effort = mapReasoningEffort(minEffort, compat.reasoningEffortMap) as Effort;
	}

	if (compat.disableReasoningOnToolChoice && params.tool_choice !== undefined) {
		// DeepSeek reasoning models accept tools/tool_choice, but reject that
		// control field while thinking is enabled. Keep the tool-selection
		// contract and suppress reasoning for this single request.
		delete params.reasoning_effort;
		delete params.reasoning;
	}

	if (compat.disableReasoningOnForcedToolChoice && isForcedToolChoice(params.tool_choice)) {
		// Backends like Kimi 400 with `tool_choice 'specified' is incompatible
		// with thinking enabled`. Suppress thinking for this single forced-tool
		// turn while keeping the tool-selection contract intact.
		delete params.reasoning_effort;
		delete params.reasoning;
		if (compat.thinkingFormat === "zai") {
			params.thinking = { type: "disabled" };
		}
	}

	// OpenRouter provider routing preferences
	if (model.baseUrl.includes("openrouter.ai") && compat.openRouterRouting) {
		params.provider = compat.openRouterRouting;
	}

	// Vercel AI Gateway provider routing preferences
	if (model.baseUrl.includes("ai-gateway.vercel.sh") && model.compat?.vercelGatewayRouting) {
		const routing = model.compat.vercelGatewayRouting;
		if (routing.only || routing.order) {
			const gatewayOptions: Record<string, string[]> = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			params.providerOptions = { gateway: gatewayOptions };
		}
	}

	if (compat.extraBody) {
		Object.assign(params, compat.extraBody);
	}

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
	premiumRequests: number | undefined,
): AssistantMessage["usage"] {
	const promptTokenDetails = getOptionalObjectProperty(rawUsage, "prompt_tokens_details");
	const completionTokenDetails = getOptionalObjectProperty(rawUsage, "completion_tokens_details");
	const cachedTokens =
		getOptionalNumberProperty(rawUsage, "cached_tokens") ??
		getOptionalNumberProperty(rawUsage, "prompt_cache_hit_tokens") ??
		(promptTokenDetails ? getOptionalNumberProperty(promptTokenDetails, "cached_tokens") : undefined) ??
		0;
	// OpenRouter exposes cache writes via `prompt_tokens_details.cache_write_tokens`
	// and INCLUDES them in `prompt_tokens` — they are billed on top of the input, so
	// we subtract them to get the real billed input.
	// DeepSeek exposes cache hit/miss via `prompt_cache_hit_tokens` /
	// `prompt_cache_miss_tokens` at the top level where `prompt_tokens` equals their
	// sum. The miss portion IS the billed input — we must NOT subtract it.
	// Ref: https://openrouter.ai/docs/guides/best-practices/prompt-caching
	// Ref: https://api-docs.deepseek.com/api/create-chat-completion
	//
	// Resolve cacheWrite from both possible sources separately.
	// They have different billing semantics: OpenRouter's cache_write is billed
	// on top of prompt_tokens, while DeepSeek's miss IS the billed input.
	const cacheWriteOpenRouter = promptTokenDetails
		? getOptionalNumberProperty(promptTokenDetails, "cache_write_tokens")
		: undefined;
	const cacheWriteDeepSeek = getOptionalNumberProperty(rawUsage, "prompt_cache_miss_tokens");
	// Prefer OpenRouter's value for the input subtraction; fall back to DeepSeek.
	const cacheWriteTokens = cacheWriteOpenRouter ?? cacheWriteDeepSeek ?? 0;

	const reasoningTokens =
		(completionTokenDetails ? getOptionalNumberProperty(completionTokenDetails, "reasoning_tokens") : undefined) ?? 0;
	const promptTokens = getOptionalNumberProperty(rawUsage, "prompt_tokens") ?? 0;

	const isDeepSeekNative =
		getOptionalNumberProperty(rawUsage, "prompt_cache_hit_tokens") !== undefined && cacheWriteDeepSeek !== undefined;
	// Only use the DeepSeek input path when cacheWrite came from DeepSeek's
	// miss field, not from prompt_tokens_details. Avoids false positives when
	// DeepSeek models route through OpenRouter (which may pass through native
	// fields alongside its own cache_write_tokens).
	const isDeepSeekUsage = isDeepSeekNative && cacheWriteOpenRouter === undefined && cacheWriteDeepSeek > 0;
	const input = isDeepSeekUsage
		? Math.max(0, promptTokens - cachedTokens)
		: Math.max(0, promptTokens - cachedTokens - cacheWriteTokens);
	// Per OpenAI's CompletionUsage spec, `reasoning_tokens` is a subset of
	// `completion_tokens` (which is the total billed output). Adding them would
	// double-count.
	const outputTokens = getOptionalNumberProperty(rawUsage, "completion_tokens") ?? 0;
	// DeepSeek only exposes cache hit/miss (no cache-write data).
	// Emitting miss tokens as cacheWrite would make downstream consumers
	// double-count them (input already equals miss for DeepSeek).
	const emittedCacheWrite = isDeepSeekUsage ? 0 : cacheWriteTokens;
	const usage: AssistantMessage["usage"] = {
		input,
		output: outputTokens,
		cacheRead: cachedTokens,
		cacheWrite: emittedCacheWrite,
		totalTokens: input + outputTokens + cachedTokens + emittedCacheWrite,
		...(reasoningTokens > 0 ? { reasoningTokens } : {}),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...(premiumRequests !== undefined ? { premiumRequests } : {}),
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

function maybeAddAnthropicCacheControl(compat: ResolvedOpenAICompat, messages: ChatCompletionMessageParam[]): void {
	if (compat.cacheControlFormat !== "anthropic") return;
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

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	if (systemPrompts.length > 0) {
		const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
		const role = useDeveloperRole ? "developer" : "system";
		// Default to one block per ordered system prompt so the leading prefix
		// stays byte-identical between turns and the provider's KV cache can
		// reuse it. Hosts whose chat templates reject follow-up system messages
		// (Qwen via vLLM, MiniMax, Alibaba Dashscope, Qwen Portal, …) opt out
		// via `compat.supportsMultipleSystemMessages = false`; in that mode we
		// coalesce into a single message joined by `\n\n`.
		if (compat.supportsMultipleSystemMessages) {
			for (const systemPrompt of systemPrompts) {
				params.push({ role, content: systemPrompt });
			}
		} else {
			params.push({ role, content: systemPrompts.join("\n\n") });
		}
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
				const supportsImages = model.input.includes("image");
				const content: ChatCompletionContentPart[] = [];
				let omittedImages = false;
				for (const item of msg.content) {
					if (item.type === "text") {
						const text = item.text.toWellFormed();
						if (text.trim().length === 0) continue;
						content.push({
							type: "text",
							text,
						} satisfies ChatCompletionContentPartText);
					} else if (supportsImages) {
						content.push({
							type: "image_url",
							image_url: {
								url: `data:${item.mimeType};base64,${item.data}`,
							},
						} satisfies ChatCompletionContentPartImage);
					} else {
						omittedImages = true;
					}
				}
				if (omittedImages) {
					content.push({
						type: "text",
						text: NON_VISION_IMAGE_PLACEHOLDER,
					} satisfies ChatCompletionContentPartText);
				}
				if (content.length === 0) continue;
				params.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			const assistantMsg: ChatCompletionAssistantMessageParam = {
				role: "assistant",
				content: null,
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
				} else if (compat.requiresReasoningContentForToolCalls) {
					// Use the streamed signature when the backend accepts whichever
					// recognized field name was emitted (allowsSynthetic=true). Backends
					// like opencode-kimi-with-thinking and DeepSeek demand the exact
					// configured `reasoningContentField` instead, so honor that here
					// rather than echoing the upstream field name.
					const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
					const recognizedFields = ["reasoning_content", "reasoning", "reasoning_text"];
					const wireField =
						compat.allowsSyntheticReasoningContentForToolCalls &&
						signature &&
						recognizedFields.includes(signature)
							? signature
							: signature && recognizedFields.includes(signature)
								? (compat.reasoningContentField ?? "reasoning_content")
								: undefined;
					if (wireField) {
						(assistantMsg as any)[wireField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
					}
				}
			}

			if (compat.requiresReasoningContentForToolCalls) {
				const streamedReasoningField = nonEmptyThinkingBlocks[0]?.thinkingSignature;
				const reasoningField =
					compat.allowsSyntheticReasoningContentForToolCalls &&
					(streamedReasoningField === "reasoning_content" ||
						streamedReasoningField === "reasoning" ||
						streamedReasoningField === "reasoning_text")
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
			// Replay reasoning_content on assistant turns for backends that validate
			// thinking-mode history. DeepSeek V4 requires reasoning_content on EVERY
			// assistant turn once any prior turn included it — not just tool-call turns.
			// The replay logic has three tiers:
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
				(compat.thinkingFormat === "openai" ||
					compat.thinkingFormat === "openrouter" ||
					compat.thinkingFormat === "zai");
			// DeepSeek-compatible reasoning models require reasoning_content on all
			// assistant turns. Providers that allow placeholders only need it on
			// tool-call turns.
			const needsReasoningOnAllTurns =
				compat.requiresReasoningContentForToolCalls && !compat.allowsSyntheticReasoningContentForToolCalls;
			const needsReasoningField = needsReasoningOnAllTurns || toolCalls.length > 0;
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
				needsReasoningField &&
				!hasReasoningField &&
				compat.requiresReasoningContentForToolCalls &&
				!compat.allowsSyntheticReasoningContentForToolCalls
			) {
				const allThinkingBlocks = msg.content.filter(b => b.type === "thinking") as ThinkingContent[];
				if (allThinkingBlocks.length > 0) {
					const signature = allThinkingBlocks[0].thinkingSignature;
					const recognizedFields = ["reasoning_content", "reasoning", "reasoning_text"];
					if (signature && recognizedFields.includes(signature)) {
						const reasoningField = compat.reasoningContentField ?? "reasoning_content";
						(assistantMsg as any)[reasoningField] = allThinkingBlocks.map(b => b.thinking).join("\n");
						hasReasoningField = true;
					}
				}
			}
			// Tier 2: When the provider requires reasoning_content but there are genuinely no
			// thinking blocks at all (e.g. proxy stripped reasoning_content from the response),
			// emit an empty string. The field must be present; an empty string is the most honest
			// representation of "no reasoning was captured."
			if (
				needsReasoningField &&
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
			// Some OpenAI-compatible backends concatenate assistant content as a
			// string even for tool-call replay. OpenAI accepts an empty string here;
			// null trips strict/proxy implementations before the tool result is read.
			if (assistantMsg.content === null && (hasReasoningField || assistantMsg.tool_calls)) {
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
					.map(c => (c as TextContent).text)
					.join("\n");
				const supportsImages = model.input.includes("image");
				const hasImages = toolMsg.content.some(c => c.type === "image");
				const omittedImages = hasImages && !supportsImages;

				// Always send tool result with text (or placeholder if only images)
				const hasText = textResult.length > 0;
				const remappedToolCallId = consumeToolCallId(toolMsg.toolCallId);
				const resolvedToolCallId =
					remappedToolCallId ?? ensureToolCallId(toolMsg.toolCallId, `${j}:${toolMsg.toolName ?? "tool"}`);
				const toolResultContent = omittedImages
					? joinTextWithImagePlaceholder(textResult, true)
					: hasText
						? textResult
						: hasImages
							? "(see attached image)"
							: "";
				const toolResultMsg: ChatCompletionToolMessageParam = {
					role: "tool",
					content: toolResultContent.toWellFormed(),
					tool_call_id: normalizeMistralToolId(resolvedToolCallId, compat.requiresMistralToolIds),
				};
				if (compat.requiresToolResultName && toolMsg.toolName) {
					(toolResultMsg as any).name = toolMsg.toolName;
				}
				params.push(toolResultMsg);

				if (hasImages && supportsImages) {
					for (const block of toolMsg.content) {
						if (block.type === "image") {
							imageBlocks.push({
								type: "image_url",
								image_url: {
									url: `data:${block.mimeType};base64,${block.data}`,
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
		const baseParameters = toolWireSchema(tool);
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
