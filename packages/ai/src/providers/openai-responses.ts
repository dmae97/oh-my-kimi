import { $env, structuredCloneJSON } from "@oh-my-pi/pi-utils";
import OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
} from "openai/resources/responses/responses";
import { getEnvApiKey } from "../stream";
import {
	type Api,
	type AssistantMessage,
	type CacheRetention,
	type Context,
	type MessageAttribution,
	type Model,
	type ProviderSessionState,
	type ServiceTier,
	type StreamFunction,
	type StreamOptions,
	shouldSendServiceTier,
	type Tool,
	type ToolChoice,
} from "../types";
import {
	createOpenAIResponsesHistoryPayload,
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	resolveCacheRetention,
	sanitizeOpenAIResponsesHistoryItemsForReplay,
} from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { finalizeErrorMessage, type RawHttpRequestDump, rewriteCopilotError } from "../utils/http-inspector";
import {
	createWatchdog,
	getOpenAIStreamIdleTimeoutMs,
	getStreamFirstEventTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { parseGitHubCopilotApiKey } from "../utils/oauth/github-copilot";
import { notifyProviderResponse } from "../utils/provider-response";
import { callWithCopilotModelRetry } from "../utils/retry";
import { adaptSchemaForStrict, NO_STRICT, sanitizeSchemaForOpenAIResponses } from "../utils/schema";
import { mapToOpenAIResponsesToolChoice, type OpenAIResponsesToolChoice } from "../utils/tool-choice";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	resolveGitHubCopilotBaseUrl,
} from "./github-copilot-headers";
import { compactGrammarDefinition } from "./grammar";
import {
	appendResponsesToolResultMessages,
	collectCustomCallIds,
	collectKnownCallIds,
	convertResponsesAssistantMessage,
	convertResponsesInputContent,
	normalizeResponsesToolCallIdForTransform,
	processResponsesStream,
} from "./openai-responses-shared";
import { transformMessages } from "./transform-messages";

/**
 * Get prompt cache retention based on cacheRetention and base URL.
 * Only applies to direct OpenAI API calls (api.openai.com).
 */
function getPromptCacheRetention(baseUrl: string, cacheRetention: CacheRetention): "24h" | undefined {
	if (cacheRetention !== "long") {
		return undefined;
	}
	if (baseUrl.includes("api.openai.com")) {
		return "24h";
	}
	return undefined;
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ServiceTier;
	toolChoice?: ToolChoice;
	/**
	 * Enforce strict tool call/result pairing when building Responses API inputs.
	 * Azure OpenAI and GitHub Copilot Responses paths require tool results to match prior tool calls.
	 */
	strictResponsesPairing?: boolean;
}

const OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX = "openai-responses:";
const OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE =
	"OpenAI responses stream timed out while waiting for the first event";

interface OpenAIResponsesProviderSessionState extends ProviderSessionState {
	nativeHistoryReplayWarmed: boolean;
}

function createOpenAIResponsesProviderSessionState(): OpenAIResponsesProviderSessionState {
	const state: OpenAIResponsesProviderSessionState = {
		nativeHistoryReplayWarmed: false,
		close: () => {
			state.nativeHistoryReplayWarmed = false;
		},
	};
	return state;
}

function getOpenAIResponsesProviderSessionStateKey(model: Model<"openai-responses">): string {
	return `${OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX}${model.provider}`;
}

function getOpenAIResponsesProviderSessionState(
	model: Model<"openai-responses">,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): OpenAIResponsesProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = getOpenAIResponsesProviderSessionStateKey(model);
	const existing = providerSessionState.get(key) as OpenAIResponsesProviderSessionState | undefined;
	if (existing) return existing;
	const created = createOpenAIResponsesProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

function canReplayOpenAIResponsesNativeHistory(
	providerSessionState: OpenAIResponsesProviderSessionState | undefined,
): boolean {
	return providerSessionState?.nativeHistoryReplayWarmed ?? true;
}

type OpenAIResponsesSamplingParams = ResponseCreateParamsStreaming & {
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
};

/**
 * Generate function for OpenAI Responses API
 */
export const streamOpenAIResponses: StreamFunction<"openai-responses"> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses" as Api,
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
		const firstEventTimeoutAbortError = new Error(OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE);
		const { requestAbortController, requestSignal } = abortTracker;

		try {
			// Keep request headers and prompt-cache routing on the same session-derived value.
			const cacheSessionId = getOpenAIResponsesCacheSessionId(options);
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const { client, copilotPremiumRequests, baseUrl } = createClient(
				model,
				context,
				apiKey,
				options?.headers,
				options?.initiatorOverride,
				cacheSessionId,
			);
			const providerSessionState = getOpenAIResponsesProviderSessionState(model, options?.providerSessionState);
			const { params } = buildParams(model, context, options, providerSessionState, baseUrl);
			const idleTimeoutMs = getOpenAIStreamIdleTimeoutMs();
			options?.onPayload?.(params);
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url: `${baseUrl ?? "https://api.openai.com/v1"}/responses`,
				body: params,
			};
			const openaiStream = await callWithCopilotModelRetry(
				async () => {
					const { data, response, request_id } = await client.responses
						.create(params, { signal: requestSignal })
						.withResponse();
					await notifyProviderResponse(options, response, model, request_id);
					return data;
				},
				{ provider: model.provider, signal: requestSignal },
			);
			const firstEventWatchdog = createWatchdog(
				options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs),
				() => abortTracker.abortLocally(firstEventTimeoutAbortError),
			);
			if (copilotPremiumRequests !== undefined) output.usage.premiumRequests = copilotPremiumRequests;
			stream.push({ type: "start", partial: output });

			const nativeOutputItems: Array<Record<string, unknown>> = [];
			await processResponsesStream(
				iterateWithIdleTimeout(openaiStream, {
					idleTimeoutMs,
					watchdog: firstEventWatchdog,
					errorMessage: "OpenAI responses stream stalled while waiting for the next event",
					onIdle: () => requestAbortController.abort(),
					abortSignal: options?.signal,
				}),
				output,
				stream,
				model,
				{
					onFirstToken: () => {
						if (!firstTokenTime) firstTokenTime = Date.now();
					},
					onOutputItemDone: item => {
						nativeOutputItems.push(structuredCloneJSON<unknown>(item) as unknown as Record<string, unknown>);
					},
				},
			);
			if (copilotPremiumRequests !== undefined) output.usage.premiumRequests = copilotPremiumRequests;

			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			if (firstEventTimeoutError) {
				throw firstEventTimeoutError;
			}
			if (abortTracker.wasCallerAbort()) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			output.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeOutputItems);
			if (providerSessionState) providerSessionState.nativeHistoryReplayWarmed = true;

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as { index?: number }).index;
			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			output.stopReason = abortTracker.wasCallerAbort() ? "aborted" : "error";
			output.errorMessage = firstEventTimeoutError?.message ?? (await finalizeErrorMessage(error, rawRequestDump));
			output.errorMessage = rewriteCopilotError(output.errorMessage, error, model.provider);
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function createClient(
	model: Model<"openai-responses">,
	context: Context,
	apiKey?: string,
	extraHeaders?: Record<string, string>,
	initiatorOverride?: MessageAttribution,
	sessionId?: string,
): {
	client: OpenAI;
	copilotPremiumRequests: number | undefined;
	baseUrl: string | undefined;
} {
	if (!apiKey) {
		if (!$env.OPENAI_API_KEY) {
			throw new Error(
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = $env.OPENAI_API_KEY;
	}
	const rawApiKey = apiKey;

	const headers = { ...(model.headers ?? {}), ...(extraHeaders ?? {}) };
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
	if (sessionId && model.provider === "openai" && (baseUrl ?? "").toLowerCase().includes("api.openai.com")) {
		headers.session_id ??= sessionId;
		headers["x-client-request-id"] ??= sessionId;
	}
	return {
		client: new OpenAI({
			apiKey,
			baseURL: baseUrl,
			dangerouslyAllowBrowser: true,
			maxRetries: 5,
			defaultHeaders: headers,
		}),
		copilotPremiumRequests,
		baseUrl,
	};
}

function getOpenAIResponsesCacheSessionId(
	options: Pick<OpenAIResponsesOptions, "cacheRetention" | "sessionId"> | undefined,
): string | undefined {
	return resolveCacheRetention(options?.cacheRetention) === "none" ? undefined : options?.sessionId;
}

function buildParams(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	providerSessionState: OpenAIResponsesProviderSessionState | undefined,
	resolvedBaseUrl?: string,
): { conversationMessages: ResponseInput; params: OpenAIResponsesSamplingParams } {
	const strictResponsesPairing =
		options?.strictResponsesPairing ??
		(isAzureOpenAIBaseUrl(model.baseUrl ?? "") || model.provider === "github-copilot");
	const conversationMessages = convertConversationMessages(
		model,
		context,
		strictResponsesPairing,
		providerSessionState,
	);
	const messages: ResponseInput = [...conversationMessages];

	if (context.systemPrompt) {
		const role = model.reasoning && supportsDeveloperRole(resolvedBaseUrl ?? model) ? "developer" : "system";
		messages.unshift({
			role,
			content: context.systemPrompt.toWellFormed(),
		});
	}

	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const promptCacheKey = getOpenAIResponsesCacheSessionId(options);
	const params: OpenAIResponsesSamplingParams = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: promptCacheKey,
		prompt_cache_retention: promptCacheKey ? getPromptCacheRetention(model.baseUrl, cacheRetention) : undefined,
		store: false,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = options?.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
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
		params.tools = convertTools(context.tools, supportsStrictMode(model), model);
		if (options?.toolChoice) {
			params.tool_choice = mapOpenAIResponsesToolChoiceForTools(options.toolChoice, context.tools, model);
		}
		// The apply_patch spec §1 marks only `apply_patch` itself as
		// `supports_parallel_tool_calls = false`. OpenAI's Responses API
		// exposes `parallel_tool_calls` as a request-scoped flag, not a
		// per-tool one, so when a custom grammar tool is in the list we
		// disable parallelism for the whole turn. Slightly coarser than
		// the spec requires — but the platform API offers no finer knob.
		if (params.tools.some(t => (t as { type?: string }).type === "custom")) {
			params.parallel_tool_calls = false;
		}
	}

	if (model.reasoning) {
		// Always request encrypted reasoning content so reasoning items can be
		// replayed in multi-turn conversations when store is false (items aren't
		// persisted server-side, so we must include the full content).
		// See: https://github.com/can1357/oh-my-pi/issues/41
		params.include = ["reasoning.encrypted_content"];

		if (options?.reasoning || options?.reasoningSummary) {
			params.reasoning = {
				effort: options?.reasoning || "medium",
				summary: options?.reasoningSummary || "auto",
			};
		} else if (model.name.startsWith("gpt-5")) {
			// Jesus Christ, see https://community.openai.com/t/need-reasoning-false-option-for-gpt-5/1351588/7
			messages.push({
				role: "developer",
				content: [
					{
						type: "input_text",
						text: "# Juice: 0 !important",
					},
				],
			});
		}
	}

	return { conversationMessages, params };
}

function isAzureOpenAIBaseUrl(baseUrl: string): boolean {
	return baseUrl.includes(".openai.azure.com") || baseUrl.includes("azure.com/openai");
}

function supportsStrictMode(model: Model<"openai-responses">): boolean {
	if (model.provider === "openai" || model.provider === "azure" || model.provider === "github-copilot") return true;

	const baseUrl = model.baseUrl.toLowerCase();
	return (
		baseUrl.includes("api.openai.com") ||
		baseUrl.includes(".openai.azure.com") ||
		baseUrl.includes("models.inference.ai.azure.com")
	);
}

export function supportsDeveloperRole(modelOrBaseUrl: Pick<Model, "provider" | "baseUrl"> | string): boolean {
	const baseUrl =
		typeof modelOrBaseUrl === "string" ? modelOrBaseUrl.toLowerCase() : (modelOrBaseUrl.baseUrl ?? "").toLowerCase();
	return (
		baseUrl.includes("api.openai.com") ||
		baseUrl.includes(".openai.azure.com") ||
		baseUrl.includes("azure.com/openai") ||
		baseUrl.includes("models.inference.ai.azure.com") ||
		baseUrl.includes("githubcopilot.com") ||
		baseUrl.includes("copilot-api.")
	);
}

function convertConversationMessages(
	model: Model<"openai-responses">,
	context: Context,
	strictResponsesPairing: boolean,
	providerSessionState: OpenAIResponsesProviderSessionState | undefined,
): ResponseInput {
	const messages: ResponseInput = [];
	let knownCallIds = new Set<string>();
	const customCallIds = new Set<string>();
	const shouldReplayNativeHistory = canReplayOpenAIResponsesNativeHistory(providerSessionState);
	const transformedMessages = transformMessages(context.messages, model, normalizeResponsesToolCallIdForTransform);

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user" || msg.role === "developer") {
			const providerPayload = (msg as { providerPayload?: AssistantMessage["providerPayload"] }).providerPayload;
			const historyItems = getOpenAIResponsesHistoryItems(providerPayload, model.provider);
			const shouldReplayPayloadItems =
				shouldReplayNativeHistory ||
				(historyItems?.some(item => {
					if (!item || typeof item !== "object") return false;
					const candidate = item as { type?: unknown };
					return candidate.type === "compaction" || candidate.type === "compaction_summary";
				}) ??
					false);
			if (historyItems && shouldReplayPayloadItems) {
				messages.push(...sanitizeOpenAIResponsesHistoryItemsForReplay(historyItems));
				knownCallIds = collectKnownCallIds(messages);
				for (const id of collectCustomCallIds(messages)) customCallIds.add(id);
				msgIndex++;
				continue;
			}
			const content = convertResponsesInputContent(msg.content, model.input.includes("image"));
			if (!content) continue;
			messages.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const providerPayload = shouldReplayNativeHistory
				? getOpenAIResponsesHistoryPayload(assistantMsg.providerPayload, model.provider, assistantMsg.provider)
				: undefined;
			const historyItems = providerPayload?.items;
			if (historyItems) {
				const sanitizedHistoryItems = sanitizeOpenAIResponsesHistoryItemsForReplay(historyItems);
				if (providerPayload?.dt) {
					messages.push(...sanitizedHistoryItems);
				} else {
					messages.splice(0, messages.length, ...sanitizedHistoryItems);
				}
				knownCallIds = collectKnownCallIds(messages);
				for (const id of collectCustomCallIds(messages)) customCallIds.add(id);
				msgIndex++;
				continue;
			}

			const outputItems = convertResponsesAssistantMessage(
				assistantMsg,
				model,
				msgIndex,
				knownCallIds,
				shouldReplayNativeHistory,
				customCallIds,
			);
			if (outputItems.length === 0) continue;
			messages.push(...outputItems);
		} else if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(messages, msg, model, strictResponsesPairing, knownCallIds, customCallIds);
		}
		msgIndex++;
	}

	return messages;
}

/**
 * Whether this model should get the OpenAI custom-tool grammar variant
 * for `apply_patch`. The generated model catalog sets
 * `model.applyPatchToolType` for first-party GPT-5 Responses models; this
 * runtime path only consumes that metadata.
 * @internal Exported for tests.
 */
export function supportsFreeformApplyPatch(model: Model<"openai-responses">): boolean {
	return model.applyPatchToolType === "freeform";
}

/** @internal Exported for tests. */
export function mapOpenAIResponsesToolChoiceForTools(
	choice: ToolChoice | undefined,
	tools: Tool[],
	model: Model<"openai-responses">,
): OpenAIResponsesToolChoice {
	const mapped = mapToOpenAIResponsesToolChoice(choice);
	if (!mapped || typeof mapped === "string" || mapped.type !== "function" || !supportsFreeformApplyPatch(model)) {
		return mapped;
	}

	const customTool = tools.find(
		tool => tool.customFormat && (tool.name === mapped.name || tool.customWireName === mapped.name),
	);
	return customTool ? { type: "custom", name: customTool.customWireName ?? customTool.name } : mapped;
}

/** @internal Exported for tests. */
export function convertTools(tools: Tool[], strictMode: boolean, model: Model<"openai-responses">): OpenAITool[] {
	const allowFreeform = supportsFreeformApplyPatch(model);
	return tools.map(tool => {
		if (allowFreeform && tool.customFormat) {
			return {
				type: "custom",
				// Tool advertises its wire-level name (e.g. `apply_patch`) — the
				// agent-loop dispatcher will match incoming calls by either the
				// internal `name` or `customWireName`.
				name: tool.customWireName ?? tool.name,
				description: tool.description || "",
				format: {
					type: "grammar",
					syntax: tool.customFormat.syntax,
					definition: compactGrammarDefinition(tool.customFormat.syntax, tool.customFormat.definition),
				},
			} as unknown as OpenAITool;
		}
		const strict = !NO_STRICT && strictMode && tool.strict !== false;
		const baseParameters = tool.parameters as unknown as Record<string, unknown>;
		const responseParameters = sanitizeSchemaForOpenAIResponses(baseParameters);
		const { schema: parameters, strict: effectiveStrict } = adaptSchemaForStrict(responseParameters, strict);
		return {
			type: "function",
			name: tool.name,
			description: tool.description || "",
			parameters,
			...(effectiveStrict && { strict: true }),
		} as OpenAITool;
	});
}
