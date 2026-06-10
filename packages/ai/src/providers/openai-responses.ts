import { parseGitHubCopilotApiKey } from "@oh-my-pi/pi-catalog/wire/github-copilot";
import { $env, extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import OpenAI, { APIConnectionTimeoutError as OpenAIConnectionTimeoutError } from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { getEnvApiKey } from "../stream";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	MessageAttribution,
	Model,
	OpenAICompat,
	ProviderSessionState,
	RawSseEvent,
	ServiceTier,
	StreamFunction,
	StreamOptions,
	Tool,
	ToolChoice,
} from "../types";
import {
	createOpenAIResponsesHistoryPayload,
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	normalizeSystemPrompts,
	resolveCacheRetention,
	sanitizeOpenAIResponsesHistoryItemsForReplay,
} from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { finalizeErrorMessage, type RawHttpRequestDump, rewriteCopilotError } from "../utils/http-inspector";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { notifyProviderResponse } from "../utils/provider-response";
import { callWithCopilotModelRetry } from "../utils/retry";
import { adaptSchemaForStrict, NO_STRICT, sanitizeSchemaForOpenAIResponses, toolWireSchema } from "../utils/schema";
import { createSdkStreamRequestOptions } from "../utils/sdk-stream-timeout";
import { notifyRawSseEvent } from "../utils/sse-debug";
import { mapToOpenAIResponsesToolChoice, type OpenAIResponsesToolChoice } from "../utils/tool-choice";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	resolveGitHubCopilotBaseUrl,
} from "./github-copilot-headers";
import { compactGrammarDefinition } from "./grammar";
import {
	appendResponsesToolResultMessages,
	applyCommonResponsesSamplingParams,
	applyResponsesReasoningParams,
	collectCustomCallIds,
	collectKnownCallIds,
	convertResponsesAssistantMessage,
	convertResponsesInputContent,
	createInitialResponsesAssistantMessage,
	isOpenAIResponsesProgressEvent,
	normalizeResponsesToolCallIdForTransform,
	processResponsesStream,
	repairOrphanResponsesToolCalls,
	repairOrphanResponsesToolOutputs,
} from "./openai-responses-shared";
import { transformMessages } from "./transform-messages";

export function normalizeOpenAIResponsesPromptCacheKey(sessionId: string | undefined): string | undefined {
	if (!sessionId || sessionId.length === 0) return undefined;
	const wellFormed = sessionId.toWellFormed();
	if (wellFormed.length <= 64) return wellFormed;
	return `pc_${Bun.hash(wellFormed).toString(36)}`;
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
	/**
	 * Pass `include: ["reasoning.encrypted_content"]` on requests when the
	 * model supports reasoning. Default: true (preserves current behavior).
	 * Set to false when the upstream Responses endpoint rejects replayed
	 * encrypted reasoning (e.g., xAI Grok under SuperGrok OAuth).
	 */
	includeEncryptedReasoning?: boolean;
	/**
	 * Strip `type: "reasoning"` items from replayed conversation history
	 * before they hit the wire. Default: false (preserves current behavior).
	 * Set to true when the upstream rejects replayed reasoning wrappers.
	 */
	filterReasoningHistory?: boolean;
	/**
	 * Suppress the `reasoning.effort` wire param when set, even if
	 * `options.reasoning` is requested. Default: false. xAI Grok models
	 * outside the effort-capable allowlist 400 with "Model X does not
	 * support parameter reasoningEffort" — the xAI Responses adapter sets
	 * this when the target model is not in GROK_EFFORT_CAPABLE_PREFIXES.
	 */
	omitReasoningEffort?: boolean;
	/**
	 * Extra request headers merged onto the underlying client's
	 * defaultHeaders. Used by adapter wrappers to inject provider-specific
	 * routing or cache hints.
	 */
	headers?: Record<string, string>;
	/**
	 * Extra body fields merged into the Responses request payload. Used by
	 * adapter wrappers to inject provider-specific body keys (e.g.,
	 * prompt_cache_key for prompt-cache routing).
	 */
	extraBody?: Record<string, unknown>;
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
	stream_options?: { include_obfuscation?: boolean };
};

async function* observeDecodedOpenAIResponsesEvents(
	events: AsyncIterable<ResponseStreamEvent>,
	observer: (event: RawSseEvent) => void,
): AsyncGenerator<ResponseStreamEvent> {
	for await (const event of events) {
		const data = JSON.stringify(event);
		// Reconstructed from decoded SDK event; not literal wire bytes.
		notifyRawSseEvent(observer, { event: event.type, data, raw: [`event: ${event.type}`, `data: ${data}`] });
		yield event;
	}
}

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

		const output: AssistantMessage = createInitialResponsesAssistantMessage(
			"openai-responses",
			model.provider,
			model.id,
		);
		let rawRequestDump: RawHttpRequestDump | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new Error(OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE);
		const { requestAbortController, requestSignal } = abortTracker;
		const onSseEvent = options?.onSseEvent;
		const rawSseObserver = onSseEvent ? (event: RawSseEvent) => onSseEvent(event, model) : undefined;

		try {
			// Keep request routing on `sessionId` while allowing callers to pin a
			// stable prompt-cache key independently. Side-channel calls use this to
			// avoid perturbing provider conversation state without cold-starting the cache.
			const routingSessionId = getOpenAIResponsesRoutingSessionId(options);
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const { client, copilotPremiumRequests, baseUrl } = createClient(
				model,
				context,
				apiKey,
				options?.headers,
				options?.initiatorOverride,
				routingSessionId,
				options?.fetch,
			);
			const premiumRequestsTotal = copilotPremiumRequests;
			const providerSessionState = getOpenAIResponsesProviderSessionState(model, options?.providerSessionState);
			const params = buildParams(model, context, options, providerSessionState);
			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs();
			const firstEventTimeoutMs =
				options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
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
					const requestOptions = createSdkStreamRequestOptions(requestSignal, requestTimeoutMs);
					let requestTimeout: NodeJS.Timeout | undefined;
					if (requestTimeoutMs !== undefined) {
						requestTimeout = setTimeout(
							() => abortTracker.abortLocally(firstEventTimeoutAbortError),
							requestTimeoutMs,
						);
					}
					try {
						const { data, response, request_id } = await client.responses
							.create(params, requestOptions)
							.withResponse();
						// Disarm the first-event watchdog as soon as headers arrive — a slow
						// onResponse callback must not abort an already-connected stream.
						if (requestTimeout !== undefined) {
							clearTimeout(requestTimeout);
							requestTimeout = undefined;
						}
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
				},
				{ provider: model.provider, signal: requestSignal },
			);
			if (premiumRequestsTotal !== undefined) output.usage.premiumRequests = premiumRequestsTotal;
			stream.push({ type: "start", partial: output });

			const nativeOutputItems: Array<Record<string, unknown>> = [];
			let sawCompleted = false;
			const timedOpenaiStream = iterateWithIdleTimeout(openaiStream, {
				idleTimeoutMs,
				firstItemTimeoutMs: firstEventTimeoutMs,
				firstItemErrorMessage: OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE,
				errorMessage: "OpenAI responses stream stalled while waiting for the next event",
				onFirstItemTimeout: () => abortTracker.abortLocally(firstEventTimeoutAbortError),
				onIdle: () => requestAbortController.abort(),
				abortSignal: options?.signal,
				isProgressItem: isOpenAIResponsesProgressEvent,
			});
			const observedOpenaiStream = rawSseObserver
				? observeDecodedOpenAIResponsesEvents(timedOpenaiStream, rawSseObserver)
				: timedOpenaiStream;
			await processResponsesStream(observedOpenaiStream, output, stream, model, {
				onFirstToken: () => {
					if (!firstTokenTime) firstTokenTime = Date.now();
				},
				onOutputItemDone: item => {
					// `processResponsesStream` hands over a private clone already; no
					// second deep copy needed (reasoning items carry multi-KB blobs).
					nativeOutputItems.push(item as unknown as Record<string, unknown>);
				},
				onCompleted: () => {
					sawCompleted = true;
				},
			});

			const firstEventTimeoutError = abortTracker.getLocalAbortReason();
			if (firstEventTimeoutError) {
				throw firstEventTimeoutError;
			}
			if (abortTracker.wasCallerAbort()) {
				throw new Error("Request was aborted");
			}

			// Detect premature stream closure: the HTTP stream ended without the
			// provider sending `response.completed`. Custom/proxy providers may
			// drop the connection mid-stream; without this guard the incomplete
			// output is silently surfaced as a successful "stop".
			if (!sawCompleted) {
				throw new Error("OpenAI responses stream closed before response.completed was received");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage ?? "An unknown error occurred");
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
			output.errorStatus = extractHttpStatusFromError(error);
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
	fetchOverride?: FetchImpl,
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
	if (sessionId && model.provider === "openai") {
		headers.session_id ??= sessionId;
		headers["x-client-request-id"] ??= sessionId;
	}
	const baseFetch = fetchOverride ?? fetch;
	return {
		client: new OpenAI({
			apiKey,
			baseURL: baseUrl,
			dangerouslyAllowBrowser: true,
			maxRetries: 5,
			defaultHeaders: headers,
			fetch: baseFetch,
		}),
		copilotPremiumRequests,
		baseUrl,
	};
}

function getOpenAIResponsesPromptCacheKey(
	options: Pick<OpenAIResponsesOptions, "cacheRetention" | "promptCacheKey" | "sessionId"> | undefined,
): string | undefined {
	if (resolveCacheRetention(options?.cacheRetention) === "none") return undefined;
	return normalizeOpenAIResponsesPromptCacheKey(options?.promptCacheKey ?? options?.sessionId);
}

export function getOpenAIResponsesCacheSessionId(
	options: Pick<OpenAIResponsesOptions, "cacheRetention" | "sessionId" | "promptCacheKey"> | undefined,
): string | undefined {
	return getOpenAIResponsesPromptCacheKey(options);
}
function getOpenAIResponsesRoutingSessionId(
	options: Pick<OpenAIResponsesOptions, "cacheRetention" | "sessionId"> | undefined,
): string | undefined {
	if (resolveCacheRetention(options?.cacheRetention) === "none") return undefined;
	return normalizeOpenAIResponsesPromptCacheKey(options?.sessionId);
}

function buildParams(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	providerSessionState: OpenAIResponsesProviderSessionState | undefined,
): OpenAIResponsesSamplingParams {
	const strictResponsesPairing = options?.strictResponsesPairing ?? model.compat.strictResponsesPairing;
	const messages = convertConversationMessages(model, context, strictResponsesPairing, providerSessionState, options);

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	let systemInstructions: string | undefined;
	if (systemPrompts.length > 0) {
		const needsDeveloperRole = model.reasoning && model.compat.supportsDeveloperRole;
		if (needsDeveloperRole) {
			// Reasoning models on known OpenAI-compatible endpoints require the
			// `developer` role. Send all system prompts inline in `input`.
			messages.unshift(
				...systemPrompts.map(systemPrompt => ({ role: "developer" as const, content: systemPrompt })),
			);
		} else {
			// All other endpoints (including third-party /v1/responses proxies) use
			// the canonical top-level `instructions` field so that proxies that
			// reject `input[{role:"system"}]` work out of the box.
			systemInstructions = systemPrompts.join("\n\n");
		}
	}

	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const promptCacheKey = getOpenAIResponsesPromptCacheKey(options);
	const params: OpenAIResponsesSamplingParams = {
		model: model.id,
		input: messages,
		instructions: systemInstructions,
		stream: true,
		prompt_cache_key: promptCacheKey,
		prompt_cache_retention: promptCacheKey
			? cacheRetention === "long" && model.compat.supportsLongPromptCacheRetention
				? "24h"
				: undefined
			: undefined,
		store: false,
		stream_options: model.provider === "openai" ? { include_obfuscation: false } : undefined,
	};

	applyCommonResponsesSamplingParams(params, options, model);
	// TODO: openai responses has no top-level `stop`/`stop_sequences`; surface via reasoning.stop?
	// `StreamOptions.stopSequences` is intentionally dropped for this provider.
	// TODO: openai responses has no top-level `frequency_penalty` field as of the current SDK;
	// `StreamOptions.frequencyPenalty` is intentionally dropped for this provider.

	if (context.tools) {
		params.tools = convertTools(context.tools, model.compat.supportsStrictMode, model);
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

	applyResponsesReasoningParams(
		params,
		model,
		options,
		messages,
		effort =>
			mapReasoningEffort(
				effort as NonNullable<OpenAIResponsesOptions["reasoning"]>,
				model.compat.reasoningEffortMap,
			),
		options?.includeEncryptedReasoning ?? true,
		options?.omitReasoningEffort ?? false,
	);

	if (options?.extraBody) {
		Object.assign(params, options.extraBody);
	}

	return params;
}

function mapReasoningEffort(
	effort: NonNullable<OpenAIResponsesOptions["reasoning"]>,
	reasoningEffortMap: OpenAICompat["reasoningEffortMap"] | undefined,
): string {
	return reasoningEffortMap?.[effort] ?? effort;
}

function convertConversationMessages(
	model: Model<"openai-responses">,
	context: Context,
	strictResponsesPairing: boolean,
	providerSessionState: OpenAIResponsesProviderSessionState | undefined,
	options?: OpenAIResponsesOptions,
): ResponseInput {
	const filterReasoning = <T extends { type?: string }>(items: T[]): T[] =>
		options?.filterReasoningHistory ? items.filter(i => i?.type !== "reasoning") : items;
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
				messages.push(...sanitizeOpenAIResponsesHistoryItemsForReplay(filterReasoning(historyItems)));
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
			// Native items are model-bound (reasoning carries encrypted content minted
			// by the producing model); after a mid-session model switch fall back to
			// block re-encode, which strips foreign signatures.
			const providerPayload =
				shouldReplayNativeHistory && assistantMsg.api === model.api && assistantMsg.model === model.id
					? getOpenAIResponsesHistoryPayload(assistantMsg.providerPayload, model.provider, assistantMsg.provider)
					: undefined;
			const historyItems = providerPayload?.items;
			if (historyItems) {
				const sanitizedHistoryItems = sanitizeOpenAIResponsesHistoryItemsForReplay(filterReasoning(historyItems));
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

	return repairOrphanResponsesToolCalls(repairOrphanResponsesToolOutputs(messages));
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
		const baseParameters = toolWireSchema(tool);
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
