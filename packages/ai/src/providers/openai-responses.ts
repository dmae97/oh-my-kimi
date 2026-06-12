import { hostMatchesUrl } from "@oh-my-pi/pi-catalog/hosts";
import { parseGitHubCopilotApiKey } from "@oh-my-pi/pi-catalog/wire/github-copilot";
import { $env, $flag, extractHttpStatusFromError, logger, structuredCloneJSON } from "@oh-my-pi/pi-utils";
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
	buildResponsesDeltaInput,
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
	 * Stateful turns: chain via `previous_response_id` + delta input instead of
	 * replaying the full transcript. Forces `store: true` (the platform only
	 * resolves stored responses). Defaults ON against the official OpenAI API
	 * and OFF for other Responses endpoints; `PI_OPENAI_STATEFUL` overrides the
	 * default, and `false` here vetoes everything. Requires `sessionId` +
	 * `providerSessionState`. Falls back to a full replay whenever history
	 * mutates or the server reports a stale id.
	 */
	statefulResponses?: boolean;
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
/** Consecutive stale-previous-response failures before chaining is disabled for the session. */
const OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMIT = 3;

interface OpenAIResponsesProviderSessionState extends ProviderSessionState {
	nativeHistoryReplayWarmed: boolean;
	/** Stateful `previous_response_id` chain baselines, keyed by baseUrl/model/session. */
	chains: Map<string, OpenAIResponsesChainState>;
}

interface OpenAIResponsesChainState {
	/**
	 * Wire params of the last successful turn, with per-turn trailing
	 * scaffolding stripped from `input` (never carries previous_response_id).
	 */
	lastParams?: OpenAIResponsesSamplingParams;
	lastResponseId?: string;
	/** Output items of the last response, in replay-sanitized form (matches next-turn input). */
	lastResponseItems?: ResponseInput;
	canAppend: boolean;
	/** Consecutive stale-previous-response failures; reset on a successful chained completion. */
	staleFailures: number;
	/** Set once chaining is judged unsupported for this session (circuit breaker). */
	disabled: boolean;
}

function createOpenAIResponsesProviderSessionState(): OpenAIResponsesProviderSessionState {
	const state: OpenAIResponsesProviderSessionState = {
		nativeHistoryReplayWarmed: false,
		chains: new Map(),
		close: () => {
			state.nativeHistoryReplayWarmed = false;
			state.chains.clear();
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

function isOpenAIResponsesStatefulEnabled(
	options: OpenAIResponsesOptions | undefined,
	baseUrl: string | undefined,
): boolean {
	if (options?.statefulResponses === false) return false;
	if (options?.statefulResponses === true) return true;
	// Default ON only against the official OpenAI API: chaining forces
	// `store: true`, and third-party /v1/responses proxies routinely ignore or
	// reject `previous_response_id`. An unset baseUrl means the SDK default
	// (api.openai.com).
	return $flag("PI_OPENAI_STATEFUL", !baseUrl || hostMatchesUrl(baseUrl, "openai"));
}

function getOpenAIResponsesChainState(
	providerSessionState: OpenAIResponsesProviderSessionState,
	model: Model<"openai-responses">,
	sessionId: string,
): OpenAIResponsesChainState {
	const key = `${model.baseUrl ?? ""}\u0000${model.id}\u0000${sessionId}`;
	const existing = providerSessionState.chains.get(key);
	if (existing) return existing;
	const created: OpenAIResponsesChainState = { canAppend: false, staleFailures: 0, disabled: false };
	providerSessionState.chains.set(key, created);
	return created;
}

function resetOpenAIResponsesChainState(state: OpenAIResponsesChainState): void {
	state.canAppend = false;
	state.lastParams = undefined;
	state.lastResponseId = undefined;
	state.lastResponseItems = undefined;
}

interface OpenAIResponsesChainedParams {
	params: OpenAIResponsesSamplingParams;
	/** Set iff the params carry previous_response_id (delta request). */
	previousResponseId?: string;
}

/**
 * Drop the per-turn trailing scaffolding (the GPT-5 "Juice: 0" developer item)
 * from `input`, yielding the wire form of the conversation arguments alone.
 */
function stripTrailingScaffolding(
	params: OpenAIResponsesSamplingParams,
	trailingScaffoldingItems: number,
): OpenAIResponsesSamplingParams {
	if (trailingScaffoldingItems <= 0 || !Array.isArray(params.input)) return params;
	return { ...params, input: params.input.slice(0, params.input.length - trailingScaffoldingItems) };
}

/**
 * Shape the next turn's request: when the session's append baseline is intact
 * (same options, strict history prefix), chain via `previous_response_id` +
 * delta-only `input`; otherwise break the chain and replay the full transcript.
 *
 * The prefix check runs on the wire form of the conversation arguments alone:
 * per-turn trailing scaffolding is excluded from both sides and re-appended to
 * the delta, so a decoration that trails every request can never masquerade as
 * a history mutation.
 */
function buildOpenAIResponsesChainedParams(
	params: OpenAIResponsesSamplingParams,
	trailingScaffoldingItems: number,
	chain: OpenAIResponsesChainState,
): OpenAIResponsesChainedParams {
	const historyParams = stripTrailingScaffolding(params, trailingScaffoldingItems);
	const deltaInput = chain.canAppend
		? buildResponsesDeltaInput<ResponseInput[number]>(chain.lastParams, chain.lastResponseItems, historyParams)
		: null;
	if (deltaInput && deltaInput.length > 0 && chain.lastResponseId) {
		const scaffolding =
			historyParams !== params && Array.isArray(params.input)
				? params.input.slice(params.input.length - trailingScaffoldingItems)
				: [];
		return {
			params: { ...params, previous_response_id: chain.lastResponseId, input: [...deltaInput, ...scaffolding] },
			previousResponseId: chain.lastResponseId,
		};
	}
	if (chain.canAppend) {
		// History mutated or options changed — break the chain and replay in full.
		resetOpenAIResponsesChainState(chain);
	}
	return { params };
}

function isOpenAIResponsesStalePreviousResponseError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if ((error as { code?: string }).code === "previous_response_not_found") return true;
	return /previous[ _]?response/i.test(error.message) && /not[ _]?found|invalid|expired|stale/i.test(error.message);
}

/**
 * Zero Data Retention orgs accept `store: true` but refuse to resolve any
 * `previous_response_id` — the prior response was never persisted server-side.
 * The 400 carries a fixed phrasing ("Zero Data Retention") that the generic
 * stale-id regex above does not match, so it is classified separately and
 * disables chaining categorically (one strike, not three).
 */
function isOpenAIResponsesZeroDataRetentionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /previous[ _]?response/i.test(error.message) && /zero[ _-]?data[ _-]?retention/i.test(error.message);
}

function registerOpenAIResponsesChainStaleFailure(chain: OpenAIResponsesChainState, error: unknown): void {
	resetOpenAIResponsesChainState(chain);
	chain.staleFailures += 1;
	if (chain.staleFailures >= OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMIT) {
		chain.disabled = true;
	}
	logger.debug("OpenAI responses previous_response_id rejected; falling back to full context", {
		error: error instanceof Error ? error.message : String(error),
		consecutiveFailures: chain.staleFailures,
		disabled: chain.disabled,
	});
}

/**
 * One-shot ZDR signal: the org will never resolve a stored response, so skip
 * the staleFailures counter and disable chaining immediately for this session.
 */
function markOpenAIResponsesChainZeroDataRetention(chain: OpenAIResponsesChainState, error: unknown): void {
	resetOpenAIResponsesChainState(chain);
	chain.disabled = true;
	chain.staleFailures = OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMIT;
	logger.debug("OpenAI responses chaining disabled (Zero Data Retention)", {
		error: error instanceof Error ? error.message : String(error),
	});
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
		let chainState: OpenAIResponsesChainState | undefined;
		let sentPreviousResponseId: string | undefined;
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
			const { params, trailingScaffoldingItems } = buildParams(model, context, options, providerSessionState);
			if (isOpenAIResponsesStatefulEnabled(options, baseUrl) && routingSessionId && providerSessionState) {
				chainState = getOpenAIResponsesChainState(providerSessionState, model, routingSessionId);
				if (!chainState.disabled) {
					// Platform `previous_response_id` chaining only resolves stored responses.
					params.store = true;
				}
			}
			const chained: OpenAIResponsesChainedParams =
				chainState && !chainState.disabled
					? buildOpenAIResponsesChainedParams(params, trailingScaffoldingItems, chainState)
					: { params };
			sentPreviousResponseId = chained.previousResponseId;
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
				body: chained.params,
			};
			const openResponsesStream = (requestParams: OpenAIResponsesSamplingParams) =>
				callWithCopilotModelRetry(
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
								.create(requestParams, requestOptions)
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
			let openaiStream: AsyncIterable<ResponseStreamEvent>;
			try {
				openaiStream = await openResponsesStream(chained.params);
			} catch (error) {
				if (!chainState || !sentPreviousResponseId || requestSignal.aborted) {
					throw error;
				}
				const zdrRejection = isOpenAIResponsesZeroDataRetentionError(error);
				if (!zdrRejection && !isOpenAIResponsesStalePreviousResponseError(error)) {
					throw error;
				}
				// Server rejected the chain baseline: reset, count the failure (or
				// disable categorically on ZDR), and retry once with the full
				// transcript. Structurally cannot loop — the retry carries no
				// previous_response_id.
				if (zdrRejection) {
					markOpenAIResponsesChainZeroDataRetention(chainState, error);
					// ZDR orgs cannot store responses; the original request forced
					// `store: true` for chaining, which is meaningless here and would
					// otherwise leave subsequent turns asking the server to retain
					// data it must discard.
					params.store = false;
				} else {
					registerOpenAIResponsesChainStaleFailure(chainState, error);
				}
				sentPreviousResponseId = undefined;
				rawRequestDump.body = params;
				openaiStream = await openResponsesStream(params);
			}
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
			if (chainState) {
				chainState.lastParams = structuredCloneJSON(stripTrailingScaffolding(params, trailingScaffoldingItems));
				if (output.responseId) {
					chainState.lastResponseId = output.responseId;
					chainState.lastResponseItems = sanitizeOpenAIResponsesHistoryItemsForReplay(
						structuredCloneJSON(nativeOutputItems),
					);
					chainState.canAppend = true;
					// Only a successful CHAINED completion clears the stale counter — a
					// full-context success must not mask categorical rejection.
					if (sentPreviousResponseId) chainState.staleFailures = 0;
				} else {
					// Without a response id the append baseline cannot be trusted.
					chainState.canAppend = false;
				}
			}

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as { index?: number }).index;
			if (chainState) resetOpenAIResponsesChainState(chainState);
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
): { params: OpenAIResponsesSamplingParams; trailingScaffoldingItems: number } {
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
		model: model.requestModelId ?? model.id,
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

	const trailingScaffoldingItems = applyResponsesReasoningParams(
		params,
		model,
		options,
		messages,
		effort =>
			model.compat.reasoningEffortMap?.[effort as NonNullable<OpenAIResponsesOptions["reasoning"]>] ??
			model.thinking?.effortMap?.[effort as NonNullable<OpenAIResponsesOptions["reasoning"]>] ??
			effort,
		options?.includeEncryptedReasoning ?? true,
		options?.omitReasoningEffort ?? false,
	);

	if (options?.extraBody) {
		Object.assign(params, options.extraBody);
	}

	return { params, trailingScaffoldingItems };
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
