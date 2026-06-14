import * as os from "node:os";
import { scheduler } from "node:timers/promises";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import {
	CODEX_BASE_URL,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import {
	$env,
	$flag,
	asRecord,
	extractHttpStatusFromError,
	fetchWithRetry,
	logger,
	readSseJson,
	structuredCloneJSON,
} from "@oh-my-pi/pi-utils";
import packageJson from "../../package.json" with { type: "json" };
import { getEnvApiKey } from "../stream";
import {
	type Api,
	type AssistantMessage,
	type Context,
	type FetchImpl,
	type Model,
	type ProviderSessionState,
	type RawSseEvent,
	resolveServiceTier,
	type ServiceTier,
	type StreamFunction,
	type StreamOptions,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolChoice,
} from "../types";
import {
	createOpenAIResponsesHistoryPayload,
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	normalizeSystemPrompts,
} from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { finalizeErrorMessage, type RawHttpRequestDump } from "../utils/http-inspector";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { parseStreamingJson, parseStreamingJsonThrottled } from "../utils/json-parse";
import { createRequestDebugSession, isRequestDebugEnabled, type RequestDebugResponseLog } from "../utils/request-debug";
import { adaptSchemaForStrict, NO_STRICT, sanitizeSchemaForOpenAIResponses, toolWireSchema } from "../utils/schema";
import { notifyRawSseEvent } from "../utils/sse-debug";
import { compactGrammarDefinition } from "./grammar";
import {
	type CodexReasoningContext,
	type CodexRequestOptions,
	type InputItem,
	type RequestBody,
	transformRequestBody,
} from "./openai-codex/request-transformer";
import { CodexApiError } from "./openai-codex/response-handler";
import { normalizeOpenAIResponsesPromptCacheKey } from "./openai-responses";
import {
	appendResponsesToolResultMessages,
	buildResponsesDeltaInput,
	convertResponsesAssistantMessage,
	convertResponsesInputContent,
	encodeResponsesToolCallId,
	encodeTextSignatureV1,
	isOpenAIResponsesProgressEvent,
	mapOpenAIResponsesStopReason,
	populateResponsesUsageFromResponse,
} from "./openai-responses-shared";
import type {
	ResponseCustomToolCall,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStatus,
} from "./openai-responses-wire";
import { transformMessages } from "./transform-messages";

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "concise" | "detailed" | null;
	/** `reasoning.context` replay scope. Defaults to `all_turns` under {@link OpenAICodexResponsesOptions.responsesLite}, otherwise omitted (server default is `current_turn`). */
	reasoningContext?: CodexReasoningContext;
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];
	codexMode?: boolean;
	toolChoice?: ToolChoice;
	preferWebsockets?: boolean;
	serviceTier?: ServiceTier;
	/**
	 * Opt into the Responses Lite transport contract. Sends
	 * `x-openai-internal-codex-responses-lite: true` on HTTP requests and on the
	 * WebSocket upgrade (the marker is connection-scoped there, so lite and
	 * non-lite turns never share a pooled socket), strips image detail from
	 * input, and defaults `reasoning.context` to `all_turns` — mirroring codex-rs.
	 */
	responsesLite?: boolean;
	/**
	 * Extra `client_metadata` to include in the request body on both transports.
	 * The canonical Codex envelope is `client_metadata["x-codex-turn-metadata"]`
	 * (JSON string of thread/turn identifiers); flat keys are also accepted.
	 */
	clientMetadata?: Record<string, string>;
	/**
	 * Invoked when the server streams a `response.metadata` event carrying
	 * ChatGPT moderation metadata (`metadata.openai_chatgpt_moderation_metadata`)
	 * for first-party presentation parity. Diagnostic observer: failures are
	 * swallowed and must not alter the stream.
	 */
	onModerationMetadata?: (metadata: unknown) => void;
}

const CODEX_DEBUG = $flag("PI_CODEX_DEBUG");
const CODEX_MAX_RETRIES = 5;
const CODEX_RETRY_DELAY_MS = 500;
const CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS = 10000;
const CODEX_WEBSOCKET_PING_INTERVAL_MS = 10_000;
const CODEX_WEBSOCKET_PONG_TIMEOUT_MS = 60_000;
const CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY = 4096;
/**
 * Maximum quiet period (no inbound frames AND no observed pong) we'll trust a
 * reused WebSocket for before forcing a fresh handshake. Codex backends and
 * intermediaries occasionally evict idle sockets server-side without sending a
 * FIN, leaving the local `readyState` as OPEN while the next `send()` becomes a
 * write into a half-open buffer. Reusing such a socket parks the next request
 * at `#nextMessage` until the first-event/idle timeout fires (issue #1450). The
 * heartbeat below also catches dead sockets, but only after `pongTimeoutMs`
 * (default 60s) and only while a request is active — this gate closes the door
 * earlier and even when the gap between requests is purely client-side (tool
 * execution, user typing, etc.). Set `PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS=0`
 * to disable.
 */
const CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS = 30_000;
/**
 * Steady-state liveness ceiling for the Codex WebSocket transport. Distinct from
 * the OMP-wide stream watchdog removed in #1392: a WebSocket can stay TCP-open
 * indefinitely without exchanging frames (server crash after upgrade, half-open
 * network path), so we still need a transport-internal cap to detect those
 * states and trigger the WS→SSE fallback. Only applies AFTER the first event
 * has arrived — slow first-token paths wait as long as the caller permits.
 */
const CODEX_WEBSOCKET_IDLE_TIMEOUT_MS = 300_000;
/**
 * Maximum wait for the first WebSocket event before falling back to SSE.
 * Unlike a stream watchdog, this triggers a transport switch (not a request
 * failure) — the outer retry loop catches the timeout error and re-runs on
 * SSE. Generous default so legitimately slow first-token providers still get
 * a chance on the WS transport before falling through.
 */
const CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS = 60_000;
const CODEX_WEBSOCKET_RETRY_BUDGET = CODEX_MAX_RETRIES;
const CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX = "Codex websocket transport error";
const CODEX_RETRYABLE_EVENT_CODES = new Set(["model_error", "server_error", "internal_error"]);
const CODEX_RETRYABLE_EVENT_MESSAGE =
	/processing your request|retry your request|temporar(?:y|ily)|overloaded|service.?unavailable|internal error|server error/i;
const CODEX_PROVIDER_SESSION_STATE_KEY = "openai-codex-responses";
const X_CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
const X_MODELS_ETAG_HEADER = "x-models-etag";
const X_OPENAI_INTERNAL_CODEX_RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
/** WebSocket frames cannot carry per-request HTTP headers; codex-rs mirrors the lite marker into `client_metadata` under this key. */
const CODEX_WS_RESPONSES_LITE_CLIENT_METADATA_KEY = "ws_request_header_x_openai_internal_codex_responses_lite";
/** `response.metadata` payload key carrying ChatGPT moderation metadata. */
const CODEX_MODERATION_METADATA_KEY = "openai_chatgpt_moderation_metadata";
/** Connection-level websocket failures that should immediately fall back to SSE without retrying. */
const CODEX_WEBSOCKET_FATAL_PATTERNS = ["websocket error:", "websocket closed before open", "connection timeout"];
/** Max total time to spend retrying 429s with server-provided delays (5 minutes). */
const CODEX_RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;
const CODEX_ADDITIONAL_PROGRESS_EVENT_TYPES = new Set(["response.done", "response.incomplete"]);
// Provider/model failure mode: Codex can keep a response alive by streaming
// whitespace-only function-call argument deltas forever. Those frames count as
// transport activity, so idle timers never fire; cap the run before raw debug
// buffers and partial JSON grow without semantic progress.
const CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT = 256;
const CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_CHAR_LIMIT = 16 * 1024;
const CODEX_WHITESPACE_LOOP_RETRY_LIMIT = 2;
const CODEX_WHITESPACE_LOOP_RETRY_DELAY_MS = 250;

function isCodexStreamProgressEvent(event: unknown): boolean {
	if (isOpenAIResponsesProgressEvent(event)) return true;
	if (!event || typeof event !== "object") return false;
	const type = (event as { type?: unknown }).type;
	return typeof type === "string" && CODEX_ADDITIONAL_PROGRESS_EVENT_TYPES.has(type);
}

type CodexWebSocketTimeoutDetails = {
	lastEventAt: number;
	lastEventType?: string;
	lastProgressAt: number;
	lastProgressEventType?: string;
};

function createCodexWebSocketTimeoutMessage(reason: string, details: CodexWebSocketTimeoutDetails): string {
	const now = Date.now();
	const lastEvent = details.lastEventType
		? `${details.lastEventType} ${Math.max(0, now - details.lastEventAt)}ms ago`
		: "none";
	const lastProgress = details.lastProgressEventType
		? `${details.lastProgressEventType} ${Math.max(0, now - details.lastProgressAt)}ms ago`
		: "none";
	return `${reason} (last event: ${lastEvent}; last progress: ${lastProgress})`;
}

type CodexTransport = "sse" | "websocket";
type CodexEventItem = ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | ResponseCustomToolCall;
type CodexOutputBlock = ThinkingContent | TextContent | (ToolCall & { partialJson: string; lastParseLen?: number });

/**
 * Per-session request-shape counters. Despite the name, these cover both
 * transports: once stateful SSE chaining is enabled, SSE requests are counted
 * too (the shared chained-request builder records every request it shapes).
 */
export interface OpenAICodexWebSocketDebugStats {
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
}

/**
 * Per-session transport state shared by BOTH transports: websocket turn
 * chaining (`previous_response_id` baseline), turn-state/models-etag headers,
 * websocket connection pooling, and debug stats. The name is historical — SSE-only
 * sessions use it too.
 */
type CodexWebSocketSessionState = {
	disableWebsocket: boolean;
	lastRequest?: RequestBody;
	lastResponseId?: string;
	lastResponseItems?: InputItem[];
	canAppend: boolean;
	turnState?: string;
	modelsEtag?: string;
	connection?: CodexWebSocketConnection;
	lastTransport?: CodexTransport;
	fallbackCount: number;
	lastFallbackAt?: number;
	prewarmed: boolean;
	stats: OpenAICodexWebSocketDebugStats;
};

interface CodexProviderSessionState extends ProviderSessionState {
	webSocketSessions: Map<string, CodexWebSocketSessionState>;
	webSocketPublicToPrivate: Map<string, string>;
}

interface CodexRequestContext {
	apiKey: string;
	accountId: string;
	baseUrl: string;
	url: string;
	requestHeaders: Record<string, string>;
	transportSessionId?: string;
	providerSessionState?: CodexProviderSessionState;
	websocketState?: CodexWebSocketSessionState;
	responsesLite: boolean;
	transformedBody: RequestBody;
	rawRequestDump: RawHttpRequestDump;
}

interface CodexRequestSetup {
	requestSignal: AbortSignal;
	wrapCodexSseStream: (source: AsyncGenerator<Record<string, unknown>>) => AsyncGenerator<Record<string, unknown>>;
	requestAbortController: AbortController;
	firstEventTimeoutMs: number | undefined;
	websocketIdleTimeoutMs: number | undefined;
	websocketFirstEventTimeoutMs: number | undefined;
}

interface CodexStreamRuntime {
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
	websocketState?: CodexWebSocketSessionState;
	currentItem: CodexEventItem | null;
	currentBlock: CodexOutputBlock | null;
	nativeOutputItems: Array<Record<string, unknown>>;
	websocketStreamRetries: number;
	providerRetryAttempt: number;
	sawTerminalEvent: boolean;
	canSafelyReplayWebsocketOverSse: boolean;
	whitespaceToolCallArgumentsDelta?: CodexWhitespaceToolCallArgumentsDeltaState;
	whitespaceLoopRetries: number;
}

interface CodexWhitespaceToolCallArgumentsDeltaState {
	itemId: string;
	outputIndex?: number;
	consecutiveEvents: number;
	consecutiveChars: number;
	firstSequenceNumber?: number;
	lastSequenceNumber?: number;
}

interface CodexWhitespaceToolCallArgumentsDeltaInterruption {
	message: string;
}

interface CodexStreamProcessingContext {
	model: Model<"openai-codex-responses">;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	options: OpenAICodexResponsesOptions | undefined;
	requestSetup: CodexRequestSetup;
	requestContext: CodexRequestContext;
	startTime: number;
	firstTokenTime?: number;
}

interface CodexStreamCompletion {
	firstTokenTime?: number;
}

function parseCodexNonNegativeInteger(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return Math.trunc(parsed);
}

function parseCodexPositiveInteger(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.trunc(parsed);
}

function isCodexWebSocketEnvEnabled(): boolean {
	return $flag("PI_CODEX_WEBSOCKET");
}

function getCodexWebSocketRetryBudget(): number {
	return parseCodexNonNegativeInteger($env.PI_CODEX_WEBSOCKET_RETRY_BUDGET, CODEX_WEBSOCKET_RETRY_BUDGET);
}

function getCodexWebSocketRetryDelayMs(retry: number): number {
	const baseDelay = parseCodexPositiveInteger($env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS, CODEX_RETRY_DELAY_MS);
	return baseDelay * Math.max(1, retry);
}

function getCodexWebSocketIdleTimeoutMs(): number {
	return parseCodexPositiveInteger($env.PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS, CODEX_WEBSOCKET_IDLE_TIMEOUT_MS);
}

function getCodexWebSocketFirstEventTimeoutMs(): number {
	return parseCodexPositiveInteger(
		$env.PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS,
		CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS,
	);
}

function getCodexWebSocketPingIntervalMs(): number {
	return parseCodexNonNegativeInteger($env.PI_CODEX_WEBSOCKET_PING_INTERVAL_MS, CODEX_WEBSOCKET_PING_INTERVAL_MS);
}

function getCodexWebSocketPongTimeoutMs(): number {
	return parseCodexNonNegativeInteger($env.PI_CODEX_WEBSOCKET_PONG_TIMEOUT_MS, CODEX_WEBSOCKET_PONG_TIMEOUT_MS);
}

function getCodexWebSocketMessageQueueCapacity(): number {
	return parseCodexPositiveInteger(
		$env.PI_CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY,
		CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY,
	);
}

function getCodexWebSocketMaxIdleReuseMs(): number {
	return parseCodexNonNegativeInteger($env.PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS, CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS);
}

function createCodexProviderSessionState(): CodexProviderSessionState {
	const state: CodexProviderSessionState = {
		webSocketSessions: new Map(),
		webSocketPublicToPrivate: new Map(),
		close: () => {
			for (const session of state.webSocketSessions.values()) {
				session.connection?.close("session_disposed");
			}
			state.webSocketSessions.clear();
			state.webSocketPublicToPrivate.clear();
		},
	};
	return state;
}

function getCodexProviderSessionState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): CodexProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const existing = providerSessionState.get(CODEX_PROVIDER_SESSION_STATE_KEY) as CodexProviderSessionState | undefined;
	if (existing) return existing;
	const created = createCodexProviderSessionState();
	providerSessionState.set(CODEX_PROVIDER_SESSION_STATE_KEY, created);
	return created;
}

function createCodexWebSocketTransportError(message: string): Error {
	return new Error(`${CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX}: ${message}`);
}

function isCodexWebSocketFatalError(error: Error): boolean {
	const msg = error.message.toLowerCase();
	return CODEX_WEBSOCKET_FATAL_PATTERNS.some(pattern => msg.includes(pattern.toLowerCase()));
}

function isCodexWebSocketTransportError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.message.startsWith(CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX);
}

function isCodexWebSocketRetryableStreamError(error: unknown): boolean {
	if (!(error instanceof Error) || !isCodexWebSocketTransportError(error)) return false;
	const message = error.message.toLowerCase();
	return (
		message.includes("websocket closed (") ||
		message.includes("websocket closed before response completion") ||
		message.includes("websocket connection is unavailable") ||
		message.includes("websocket send failed") ||
		message.includes("websocket ping failed") ||
		message.includes("websocket pong timeout") ||
		message.includes("websocket message queue exceeded") ||
		message.includes("websocket request already in progress") ||
		message.includes("idle timeout waiting for websocket") ||
		message.includes("timeout waiting for first websocket event") ||
		message.includes("syntaxerror") ||
		message.includes("json")
	);
}

function toCodexHeaderRecord(value: unknown): Record<string, string> | null {
	if (!value || typeof value !== "object") return null;
	const headers: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === "string") {
			headers[key] = entry;
		} else if (Array.isArray(entry) && entry.every(item => typeof item === "string")) {
			headers[key] = entry.join(",");
		} else if (typeof entry === "number" || typeof entry === "boolean") {
			headers[key] = String(entry);
		}
	}
	return Object.keys(headers).length > 0 ? headers : null;
}

function toCodexHeaders(value: unknown): Headers | undefined {
	if (!value) return undefined;
	if (value instanceof Headers) return value;
	if (Array.isArray(value)) {
		try {
			return new Headers(value as Array<[string, string]>);
		} catch {
			return undefined;
		}
	}
	const record = toCodexHeaderRecord(value);
	if (!record) return undefined;
	return new Headers(record);
}

function updateCodexSessionMetadataFromHeaders(
	state: CodexWebSocketSessionState | undefined,
	headers: Headers | Record<string, string> | null | undefined,
): void {
	if (!state || !headers) return;
	const resolvedHeaders = headers instanceof Headers ? headers : new Headers(headers);
	const turnState = resolvedHeaders.get(X_CODEX_TURN_STATE_HEADER);
	if (turnState && turnState.length > 0) {
		state.turnState = turnState;
	}
	const modelsEtag = resolvedHeaders.get(X_MODELS_ETAG_HEADER);
	if (modelsEtag && modelsEtag.length > 0) {
		state.modelsEtag = modelsEtag;
	}
}

function extractCodexWebSocketHandshakeHeaders(socket: Bun.WebSocket, openEvent?: Event): Headers | undefined {
	const eventRecord = openEvent as Record<string, unknown> | undefined;
	const eventResponse = eventRecord?.response as Record<string, unknown> | undefined;
	const socketRecord = socket as unknown as Record<string, unknown>;
	const socketResponse = socketRecord.response as Record<string, unknown> | undefined;
	const socketHandshake = socketRecord.handshake as Record<string, unknown> | undefined;
	return (
		toCodexHeaders(eventRecord?.responseHeaders) ??
		toCodexHeaders(eventRecord?.headers) ??
		toCodexHeaders(eventResponse?.headers) ??
		toCodexHeaders(socketRecord.responseHeaders) ??
		toCodexHeaders(socketRecord.handshakeHeaders) ??
		toCodexHeaders(socketResponse?.headers) ??
		toCodexHeaders(socketHandshake?.headers)
	);
}

// Synthesizes a `RawSseEvent` for a Codex WebSocket frame so the same debug
// pipeline used for HTTP SSE (`onSseEvent` → `RawSseDebugBuffer.recordEvent`)
// also captures WebSocket traffic. The `raw` array mirrors SSE wire format
// (one line per field) so the existing TUI viewer renders it identically:
//   : ws ← <type>
//   event: <type>
//   data: <json>
// Outbound (client → server) uses `: ws → <type>`. The viewer pretty-prints
// `data:` JSON lines, so we keep the wire JSON single-line here and let the
// renderer expand it.
function notifyCodexWebSocketInbound(
	observer: ((event: RawSseEvent) => void) | undefined,
	parsed: Record<string, unknown>,
	text: string,
): void {
	const type = typeof parsed.type === "string" ? parsed.type : null;
	const raw: string[] = [`: ws ← ${type ?? "(untyped)"}`];
	if (type) raw.push(`event: ${type}`);
	raw.push(`data: ${text}`);
	notifyRawSseEvent(observer, { event: type, data: text, raw });
}

function notifyCodexWebSocketOutbound(
	observer: ((event: RawSseEvent) => void) | undefined,
	request: Record<string, unknown>,
	payload: string,
): void {
	const type = typeof request.type === "string" ? request.type : null;
	const raw: string[] = [`: ws → ${type ?? "(untyped)"}`];
	if (type) raw.push(`event: ${type}`);
	raw.push(`data: ${payload}`);
	notifyRawSseEvent(observer, { event: type, data: payload, raw });
}

function notifyCodexWebSocketMalformed(
	observer: ((event: RawSseEvent) => void) | undefined,
	data: unknown,
	error: unknown,
): void {
	const text = typeof data === "string" ? data : "";
	const reason = error instanceof Error ? error.message : String(error);
	const raw: string[] = [`: ws ← (parse-error: ${reason})`];
	if (text) raw.push(`data: ${text}`);
	notifyRawSseEvent(observer, { event: "parse_error", data: text, raw });
}

/** @internal Exported for tests. */
export function normalizeCodexToolChoice(
	choice: ToolChoice | undefined,
	tools: Tool[] = [],
	model?: Model<"openai-codex-responses">,
): string | Record<string, unknown> | undefined {
	if (!choice) return undefined;
	if (typeof choice === "string") return choice;
	const allowFreeform = model ? supportsFreeformApplyPatchCodex(model) : false;
	const mapName = (name: string): Record<string, string> | undefined => {
		const directTool = tools.find(tool => tool.name === name);
		const customTool = allowFreeform
			? tools.find(tool => tool.customFormat && (tool.name === name || tool.customWireName === name))
			: undefined;
		const offeredTool = customTool ?? directTool;
		if (!offeredTool) return undefined;
		return customTool
			? { type: "custom", name: customTool.customWireName ?? customTool.name }
			: { type: "function", name: offeredTool.name };
	};
	if (choice.type === "function") {
		if ("function" in choice && choice.function?.name) {
			return mapName(choice.function.name);
		}
		if ("name" in choice && choice.name) {
			return mapName(choice.name);
		}
	}
	if (choice.type === "tool" && choice.name) {
		return mapName(choice.name);
	}
	return undefined;
}

function createEmptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function getCodexUserAgent(): string {
	return `pi/${packageJson.version} (${os.platform()} ${os.release()}; ${os.arch()})`;
}

function getCodexServiceTierCostMultiplier(
	model: Pick<Model<"openai-codex-responses">, "id">,
	serviceTier: ServiceTier | "default" | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function resolveCodexCostServiceTier(res: unknown, req?: unknown): ServiceTier | "default" | undefined {
	switch (res) {
		case "flex":
			return "flex";
		case "priority":
			return "priority";
		default:
			if (req === "flex" || req === "priority") {
				return req;
			}
			return "default";
	}
}

function applyCodexServiceTierPricing(
	model: Pick<Model<"openai-codex-responses">, "id">,
	usage: AssistantMessage["usage"],
	resTier: unknown,
	reqTier: unknown,
): void {
	const resolvedTier = resolveCodexCostServiceTier(resTier, reqTier);
	const multiplier = getCodexServiceTierCostMultiplier(model, resolvedTier);
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function createAssistantOutput(model: Model<"openai-codex-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses" as Api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function resetOutputState(output: AssistantMessage): void {
	output.content.length = 0;
	output.usage = createEmptyUsage();
	output.stopReason = "stop";
	output.stopDetails = undefined;
}

function removeTransientBlockIndices(output: AssistantMessage): void {
	for (const block of output.content) {
		delete (block as { index?: number }).index;
	}
}

function createRequestSetup(options: OpenAICodexResponsesOptions | undefined): CodexRequestSetup {
	const requestAbortController = new AbortController();
	const requestSignal = options?.signal
		? AbortSignal.any([options.signal, requestAbortController.signal])
		: requestAbortController.signal;
	const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs();
	const websocketIdleTimeoutMs = options?.streamIdleTimeoutMs ?? getCodexWebSocketIdleTimeoutMs();
	const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
	const websocketFirstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getCodexWebSocketFirstEventTimeoutMs();
	const wrapCodexSseStream = (
		source: AsyncGenerator<Record<string, unknown>>,
	): AsyncGenerator<Record<string, unknown>> =>
		iterateWithIdleTimeout(source, {
			idleTimeoutMs,
			firstItemTimeoutMs: firstEventTimeoutMs,
			firstItemErrorMessage: "OpenAI Codex SSE stream timed out while waiting for the first event",
			errorMessage: "OpenAI Codex SSE stream stalled while waiting for the next event",
			onIdle: () => requestAbortController.abort(),
			onFirstItemTimeout: () => requestAbortController.abort(),
			abortSignal: options?.signal,
			isProgressItem: isCodexStreamProgressEvent,
		});
	return {
		requestAbortController,
		requestSignal,
		wrapCodexSseStream,
		firstEventTimeoutMs,
		websocketIdleTimeoutMs,
		websocketFirstEventTimeoutMs,
	};
}

async function buildCodexRequestContext(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
	output: AssistantMessage,
): Promise<CodexRequestContext> {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const accountId = getAccountId(apiKey);
	const baseUrl = model.baseUrl || CODEX_BASE_URL;
	const url = resolveCodexResponsesUrl(baseUrl);
	const promptCacheKey = resolveCodexPromptCacheKey(options);
	const transportSessionId = resolveCodexTransportSessionId(options);
	let transformedBody = await buildTransformedCodexRequestBody(model, context, options, promptCacheKey);
	const replacementPayload = await options?.onPayload?.(transformedBody, model);
	if (replacementPayload !== undefined) {
		transformedBody = replacementPayload as typeof transformedBody;
	}

	const requestHeaders = { ...(model.headers ?? {}), ...(options?.headers ?? {}) };
	const rawRequestDump: RawHttpRequestDump = {
		provider: model.provider,
		api: output.api,
		model: model.id,
		method: "POST",
		url,
		body: transformedBody,
	};

	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const responsesLite = options?.responsesLite === true;
	const sessionKey = getCodexWebSocketSessionKey(transportSessionId, model, accountId, baseUrl, responsesLite);
	const publicSessionKey = getCodexPublicSessionKey(transportSessionId, model, baseUrl);
	if (sessionKey && publicSessionKey) {
		providerSessionState?.webSocketPublicToPrivate.set(publicSessionKey, sessionKey);
	}
	const websocketState =
		sessionKey && providerSessionState ? getCodexWebSocketSessionState(sessionKey, providerSessionState) : undefined;
	if (websocketState && !isCodexWithinTurnContinuation(context)) {
		// codex-rs scopes `x-codex-turn-state` to a single user turn: tool-loop
		// follow-ups echo it, a new user turn starts without it.
		websocketState.turnState = undefined;
	}
	return {
		apiKey,
		accountId,
		baseUrl,
		url,
		requestHeaders,
		transportSessionId,
		providerSessionState,
		websocketState,
		responsesLite,
		transformedBody,
		rawRequestDump,
	};
}

async function buildTransformedCodexRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
	promptCacheKey = resolveCodexPromptCacheKey(options),
): Promise<RequestBody> {
	const params: RequestBody = {
		model: model.id,
		input: convertMessages(model, context),
		stream: true,
		prompt_cache_key: promptCacheKey,
	};

	// `maxTokens` is intentionally not forwarded: transformRequestBody strips
	// `max_output_tokens`/`max_completion_tokens` (the Codex backend rejects
	// caller-supplied output caps).
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
	const resolvedServiceTier = resolveServiceTier(options?.serviceTier, model.provider);
	if (resolvedServiceTier === "flex" || resolvedServiceTier === "scale" || resolvedServiceTier === "priority") {
		params.service_tier = resolvedServiceTier;
	}
	if (context.tools && context.tools.length > 0) {
		params.tools = convertOpenAICodexResponsesTools(context.tools, model);
		if (options?.toolChoice) {
			const toolChoice = normalizeCodexToolChoice(options.toolChoice, context.tools, model);
			if (toolChoice) {
				params.tool_choice = toolChoice;
			}
		}
		// When a custom-tool is active, force serial tool-calling. OpenAI's
		// `parallel_tool_calls` is request-scoped — disabling it here affects
		// every tool in the turn, not just the custom one. That's coarser
		// than spec §1's "supports_parallel_tool_calls = false" (which
		// strictly targets `apply_patch`), but the platform API offers no
		// per-tool flag.
		const emittedTools = params.tools as CodexToolPayload[];
		if (emittedTools.some(t => t.type === "custom")) {
			params.parallel_tool_calls = false;
		}
	}

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	if (systemPrompts.length > 0) {
		params.instructions = systemPrompts[0];
	}
	const developerMessages = systemPrompts.slice(1);
	if (options?.clientMetadata && Object.keys(options.clientMetadata).length > 0) {
		params.client_metadata = { ...options.clientMetadata };
	}
	const codexOptions: CodexRequestOptions = {
		reasoningEffort: options?.reasoning,
		reasoningSummary: options?.reasoningSummary === undefined ? "auto" : options.reasoningSummary,
		reasoningContext: options?.reasoningContext,
		textVerbosity: options?.textVerbosity,
		include: options?.include,
		responsesLite: options?.responsesLite,
	};

	return transformRequestBody(params, model, codexOptions, { developerMessages });
}

async function openInitialCodexEventStream(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexResponsesOptions | undefined,
	requestSetup: CodexRequestSetup,
	requestContext: CodexRequestContext,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const { transformedBody, websocketState } = requestContext;
	if (websocketState && shouldUseCodexWebSocket(model, websocketState, options?.preferWebsockets)) {
		const websocketRetryBudget = getCodexWebSocketRetryBudget();
		let websocketRetries = 0;
		while (true) {
			try {
				return await openCodexWebSocketTransport(
					requestContext,
					requestSetup,
					websocketState,
					websocketRetries,
					options ? event => options.onSseEvent?.(event, model) : undefined,
				);
			} catch (error) {
				const websocketError = error instanceof Error ? error : new Error(String(error));
				const isFatal = isCodexWebSocketFatalError(websocketError);
				const activateFallback = isFatal || websocketRetries >= websocketRetryBudget;
				recordCodexWebSocketFailure(websocketState, activateFallback);
				logCodexDebug("codex websocket fallback", {
					error: websocketError.message,
					retry: websocketRetries,
					retryBudget: websocketRetryBudget,
					activated: activateFallback,
					fatal: isFatal,
				});
				if (!activateFallback) {
					websocketRetries += 1;
					await scheduler.wait(getCodexWebSocketRetryDelayMs(websocketRetries), {
						signal: requestSetup.requestSignal,
					});
					continue;
				}
				break;
			}
		}
	}
	return openCodexSseTransport(model, requestContext, requestSetup, options, websocketState, transformedBody);
}
async function openCodexWebSocketTransport(
	requestContext: CodexRequestContext,
	requestSetup: CodexRequestSetup,
	websocketState: CodexWebSocketSessionState,
	retry: number,
	onSseEvent?: (event: RawSseEvent) => void,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const chainedBody = buildCodexChainedRequestBody(requestContext.transformedBody, websocketState);
	// WebSocket frames cannot carry per-request HTTP headers, so the Responses
	// Lite marker rides in `client_metadata` on every `response.create`.
	const websocketRequest: Record<string, unknown> = {
		type: "response.create",
		...chainedBody,
		...(requestContext.responsesLite
			? {
					client_metadata: {
						...(chainedBody.client_metadata ?? {}),
						[CODEX_WS_RESPONSES_LITE_CLIENT_METADATA_KEY]: "true",
					},
				}
			: {}),
	};
	const websocketHeaders = createCodexHeaders(
		requestContext.requestHeaders,
		requestContext.accountId,
		requestContext.apiKey,
		requestContext.transportSessionId,
		"websocket",
		websocketState,
		requestContext.responsesLite,
	);
	const requestBodyForState = structuredCloneJSON(requestContext.transformedBody);
	logCodexDebug("codex websocket request", {
		url: toWebSocketUrl(requestContext.url),
		model: requestContext.transformedBody.model,
		reasoningEffort: requestContext.transformedBody.reasoning?.effort ?? null,
		headers: redactHeaders(websocketHeaders),
		sentTurnStateHeader: websocketHeaders.has(X_CODEX_TURN_STATE_HEADER),
		sentModelsEtagHeader: websocketHeaders.has(X_MODELS_ETAG_HEADER),
		requestType: websocketRequest.type,
		retry,
		retryBudget: getCodexWebSocketRetryBudget(),
	});
	const eventStream = await openCodexWebSocketEventStream(
		toWebSocketUrl(requestContext.url),
		websocketHeaders,
		websocketRequest,
		websocketState,
		{
			idleTimeoutMs: requestSetup.websocketIdleTimeoutMs,
			firstEventTimeoutMs: requestSetup.websocketFirstEventTimeoutMs,
		},
		requestSetup.requestSignal,
		onSseEvent,
	);
	return {
		eventStream,
		requestBodyForState,
		transport: "websocket",
	};
}

/**
 * True when the request continues the current turn (everything after the
 * last assistant message is tool results), false when a new user turn starts.
 * Mirrors codex-rs, which scopes `x-codex-turn-state` to a single turn and
 * clears it when the next one begins.
 */
function isCodexWithinTurnContinuation(context: Context): boolean {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const role = context.messages[i]?.role;
		if (role === "toolResult") continue;
		return role === "assistant";
	}
	return false;
}

async function openCodexSseTransport(
	model: Model<"openai-codex-responses">,
	requestContext: CodexRequestContext,
	requestSetup: CodexRequestSetup,
	options: OpenAICodexResponsesOptions | undefined,
	state: CodexWebSocketSessionState | undefined,
	body = requestContext.transformedBody,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const open = async (wireBody: RequestBody) => {
		// Keep the 400 dump honest: record the body actually sent on the wire.
		requestContext.rawRequestDump.body = wireBody;
		return requestSetup.wrapCodexSseStream(
			await openCodexSseEventStream(
				requestContext.url,
				requestContext.requestHeaders,
				requestContext.accountId,
				requestContext.apiKey,
				requestContext.transportSessionId,
				wireBody,
				state,
				requestContext.responsesLite,
				requestSetup.requestSignal,
				requestSetup.firstEventTimeoutMs,
				event => options?.onSseEvent?.(event, model),
				options?.fetch,
			),
		);
	};
	recordCodexWebSocketRequestStats(state, body);
	return { eventStream: await open(body), requestBodyForState: structuredCloneJSON(body), transport: "sse" };
}

async function reopenCodexWebSocketRuntimeStream(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	state: CodexWebSocketSessionState,
): Promise<void> {
	try {
		const next = await openCodexWebSocketTransport(
			context.requestContext,
			context.requestSetup,
			state,
			runtime.websocketStreamRetries,
			context.options ? event => context.options?.onSseEvent?.(event, context.model) : undefined,
		);
		runtime.eventStream = next.eventStream;
		runtime.requestBodyForState = next.requestBodyForState;
		runtime.transport = next.transport;
		state.lastTransport = next.transport;
	} catch (error) {
		const wsError = error instanceof Error ? error : new Error(String(error));
		if (!isCodexWebSocketTransportError(wsError)) throw error;
		// Reopen failed at the websocket layer (handshake refused, connect timeout, etc.).
		// Activate fallback so subsequent turns use SSE, and replay this turn over SSE
		// instead of surfacing a raw transport error to the caller.
		recordCodexWebSocketFailure(state, true);
		logCodexDebug("codex websocket reopen failed, falling back to SSE", {
			error: wsError.message,
			retry: runtime.websocketStreamRetries,
		});
		await reopenCodexSseRuntimeStream(context, runtime, state);
	}
}

async function reopenCodexSseRuntimeStream(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	state: CodexWebSocketSessionState | undefined,
): Promise<void> {
	const next = await openCodexSseTransport(
		context.model,
		context.requestContext,
		context.requestSetup,
		context.options,
		state,
	);
	runtime.eventStream = next.eventStream;
	runtime.requestBodyForState = next.requestBodyForState;
	runtime.transport = next.transport;
	if (state) {
		state.lastTransport = next.transport;
	}
}

function createCodexStreamRuntime(initial: {
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
	websocketState?: CodexWebSocketSessionState;
}): CodexStreamRuntime {
	return {
		eventStream: initial.eventStream,
		requestBodyForState: initial.requestBodyForState,
		transport: initial.transport,
		websocketState: initial.websocketState,
		currentItem: null,
		currentBlock: null,
		nativeOutputItems: [],
		websocketStreamRetries: 0,
		providerRetryAttempt: 0,
		whitespaceLoopRetries: 0,
		sawTerminalEvent: false,
		canSafelyReplayWebsocketOverSse: true,
		whitespaceToolCallArgumentsDelta: undefined,
	};
}

function resetWhitespaceToolCallArgumentsDelta(runtime: CodexStreamRuntime): void {
	runtime.whitespaceToolCallArgumentsDelta = undefined;
}

function isJsonWhitespaceOnly(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) {
			return false;
		}
	}
	return true;
}

function readOptionalInteger(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.trunc(value);
}

function observeWhitespaceToolCallArgumentsDelta(
	runtime: CodexStreamRuntime,
	rawEvent: Record<string, unknown>,
	delta: string,
): CodexWhitespaceToolCallArgumentsDeltaInterruption | undefined {
	if (!isJsonWhitespaceOnly(delta)) {
		resetWhitespaceToolCallArgumentsDelta(runtime);
		return undefined;
	}

	const itemId =
		typeof rawEvent.item_id === "string" && rawEvent.item_id.length > 0
			? rawEvent.item_id
			: (runtime.currentItem?.id ?? "");
	const outputIndex = readOptionalInteger(rawEvent.output_index);
	const sequenceNumber = readOptionalInteger(rawEvent.sequence_number);
	let state = runtime.whitespaceToolCallArgumentsDelta;
	if (!state || state.itemId !== itemId || state.outputIndex !== outputIndex) {
		state = {
			itemId,
			outputIndex,
			consecutiveEvents: 0,
			consecutiveChars: 0,
			firstSequenceNumber: sequenceNumber,
		};
		runtime.whitespaceToolCallArgumentsDelta = state;
	}

	state.consecutiveEvents += 1;
	state.consecutiveChars += delta.length;
	state.lastSequenceNumber = sequenceNumber;
	if (
		state.consecutiveEvents < CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT &&
		state.consecutiveChars < CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_CHAR_LIMIT
	) {
		return undefined;
	}

	const itemLabel = itemId ? ` for item ${itemId}` : "";
	const sequenceLabel =
		state.firstSequenceNumber === undefined || state.lastSequenceNumber === undefined
			? ""
			: `, sequence ${state.firstSequenceNumber}..${state.lastSequenceNumber}`;
	return {
		message: `Interrupted OpenAI Codex response after ${state.consecutiveEvents} consecutive whitespace-only tool-call argument delta events (${state.consecutiveChars} chars${sequenceLabel})${itemLabel}.`,
	};
}

function interruptWhitespaceToolCallArgumentsDelta(
	runtime: CodexStreamRuntime,
	interruption: CodexWhitespaceToolCallArgumentsDeltaInterruption,
): never {
	// Close the degenerate websocket so the server stops streaming whitespace
	// frames. Do NOT abort requestSetup.requestAbortController: reopen*RuntimeStream
	// reuses the same setup across retries, and requestSignal is an AbortSignal.any
	// over that controller — aborting it stays latched and makes recovery
	// impossible. Throwing unwinds the for-await, which returns the SSE generator
	// and cancels its underlying body.
	runtime.websocketState?.connection?.close("degenerate-tool-call");
	throw new CodexWhitespaceToolCallLoopError(interruption.message);
}

async function processCodexResponseStream(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
): Promise<CodexStreamCompletion> {
	const { output, stream } = context;
	stream.push({ type: "start", partial: output });

	while (true) {
		try {
			let firstTokenTime = context.firstTokenTime;
			for await (const rawEvent of runtime.eventStream) {
				firstTokenTime = handleCodexStreamEvent(context, runtime, rawEvent, firstTokenTime);
				if (runtime.sawTerminalEvent) break;
			}
			return { firstTokenTime };
		} catch (error) {
			const recovered = await recoverCodexStreamError(context, runtime, error);
			if (!recovered) {
				throw error;
			}
		}
	}
}

function handleCodexStreamEvent(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	rawEvent: Record<string, unknown>,
	firstTokenTime: number | undefined,
): number | undefined {
	const { model, output, stream } = context;
	const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
	if (!eventType) return firstTokenTime;

	if (eventType === "response.output_item.added") {
		resetWhitespaceToolCallArgumentsDelta(runtime);
		if (!firstTokenTime) firstTokenTime = Date.now();
		const item = rawEvent.item as CodexEventItem;
		runtime.currentItem = item;
		runtime.currentBlock = createOutputBlockForItem(item);
		if (!runtime.currentBlock) return firstTokenTime;
		output.content.push(runtime.currentBlock);
		stream.push({
			type: getOutputBlockStartEventType(runtime.currentBlock),
			contentIndex: output.content.length - 1,
			partial: output,
		});
		return firstTokenTime;
	}

	if (eventType === "response.reasoning_summary_part.added") {
		handleReasoningSummaryPartAdded(runtime.currentItem, rawEvent);
		return firstTokenTime;
	}

	if (eventType === "response.reasoning_summary_text.delta") {
		handleReasoningSummaryTextDelta(runtime.currentItem, runtime.currentBlock, rawEvent, stream, output);
		return firstTokenTime;
	}

	if (eventType === "response.reasoning_summary_part.done") {
		handleReasoningSummaryPartDone(runtime.currentItem, runtime.currentBlock, stream, output);
		return firstTokenTime;
	}

	if (eventType === "response.content_part.added") {
		handleContentPartAdded(runtime.currentItem, rawEvent);
		return firstTokenTime;
	}

	if (eventType === "response.output_text.delta") {
		handleMessageTextDelta(runtime.currentItem, runtime.currentBlock, rawEvent, stream, output, "output_text");
		return firstTokenTime;
	}

	if (eventType === "response.refusal.delta") {
		handleMessageTextDelta(runtime.currentItem, runtime.currentBlock, rawEvent, stream, output, "refusal");
		return firstTokenTime;
	}

	if (eventType === "response.function_call_arguments.delta") {
		const interruption = handleToolCallArgumentsDelta(runtime, rawEvent, stream, output);
		if (interruption) interruptWhitespaceToolCallArgumentsDelta(runtime, interruption);
		return firstTokenTime;
	}

	if (eventType === "response.function_call_arguments.done") {
		resetWhitespaceToolCallArgumentsDelta(runtime);
		handleToolCallArgumentsDone(runtime.currentItem, runtime.currentBlock, rawEvent);
		return firstTokenTime;
	}

	if (eventType === "response.custom_tool_call_input.delta") {
		const interruption = handleCustomToolCallInputDelta(runtime, rawEvent, stream, output);
		if (interruption) interruptWhitespaceToolCallArgumentsDelta(runtime, interruption);
		return firstTokenTime;
	}

	if (eventType === "response.custom_tool_call_input.done") {
		resetWhitespaceToolCallArgumentsDelta(runtime);
		handleCustomToolCallInputDone(runtime.currentItem, runtime.currentBlock, rawEvent);
		return firstTokenTime;
	}

	if (eventType === "response.output_item.done") {
		resetWhitespaceToolCallArgumentsDelta(runtime);
		handleOutputItemDone(model, output, stream, runtime, rawEvent);
		return firstTokenTime;
	}

	if (eventType === "response.created") {
		handleResponseCreated(runtime, rawEvent);
		return firstTokenTime;
	}

	if (eventType === "response.completed" || eventType === "response.done" || eventType === "response.incomplete") {
		handleResponseCompleted(model, output, runtime, rawEvent);
		return firstTokenTime;
	}

	if (eventType === "response.metadata") {
		const moderation = asRecord(rawEvent.metadata)?.[CODEX_MODERATION_METADATA_KEY];
		if (moderation !== undefined) {
			try {
				context.options?.onModerationMetadata?.(moderation);
			} catch {
				// Diagnostic observer: failures must not disturb the stream.
			}
		}
		return firstTokenTime;
	}

	if (eventType === "error" || eventType === "response.failed") {
		throw createCodexProviderStreamError(rawEvent);
	}

	return firstTokenTime;
}

function createOutputBlockForItem(item: CodexEventItem): CodexOutputBlock | null {
	if (item.type === "reasoning") {
		return { type: "thinking", thinking: "" };
	}
	if (item.type === "message") {
		return { type: "text", text: "" };
	}
	if (item.type === "function_call") {
		return {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: item.name,
			arguments: {},
			partialJson: item.arguments || "",
		};
	}
	if (item.type === "custom_tool_call") {
		// Wire name flows through unchanged; the agent-loop dispatcher also
		// matches `Tool.customWireName`. Reuse `partialJson` as the
		// accumulation buffer for the raw input string.
		return {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: item.name,
			arguments: { input: item.input ?? "" },
			customWireName: item.name,
			partialJson: item.input ?? "",
		};
	}
	return null;
}

function getOutputBlockStartEventType(block: CodexOutputBlock): "thinking_start" | "text_start" | "toolcall_start" {
	if (block.type === "thinking") return "thinking_start";
	if (block.type === "text") return "text_start";
	return "toolcall_start";
}

function handleReasoningSummaryPartAdded(currentItem: CodexEventItem | null, rawEvent: Record<string, unknown>): void {
	if (currentItem?.type !== "reasoning") return;
	currentItem.summary = currentItem.summary || [];
	currentItem.summary.push((rawEvent as { part: ResponseReasoningItem["summary"][number] }).part);
}

function handleReasoningSummaryTextDelta(
	currentItem: CodexEventItem | null,
	currentBlock: CodexOutputBlock | null,
	rawEvent: Record<string, unknown>,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
): void {
	if (currentItem?.type !== "reasoning" || currentBlock?.type !== "thinking") return;
	currentItem.summary = currentItem.summary || [];
	const lastPart = currentItem.summary[currentItem.summary.length - 1];
	if (!lastPart) return;
	const delta = (rawEvent as { delta?: string }).delta || "";
	currentBlock.thinking += delta;
	lastPart.text += delta;
	stream.push({ type: "thinking_delta", contentIndex: output.content.length - 1, delta, partial: output });
}

function handleReasoningSummaryPartDone(
	currentItem: CodexEventItem | null,
	currentBlock: CodexOutputBlock | null,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
): void {
	if (currentItem?.type !== "reasoning" || currentBlock?.type !== "thinking") return;
	currentItem.summary = currentItem.summary || [];
	const lastPart = currentItem.summary[currentItem.summary.length - 1];
	if (!lastPart) return;
	currentBlock.thinking += "\n\n";
	lastPart.text += "\n\n";
	stream.push({ type: "thinking_delta", contentIndex: output.content.length - 1, delta: "\n\n", partial: output });
}

function handleContentPartAdded(currentItem: CodexEventItem | null, rawEvent: Record<string, unknown>): void {
	if (currentItem?.type !== "message") return;
	currentItem.content = currentItem.content || [];
	const part = (rawEvent as { part?: ResponseOutputMessage["content"][number] }).part;
	if (part && (part.type === "output_text" || part.type === "refusal")) {
		currentItem.content.push(part);
	}
}

function handleMessageTextDelta(
	currentItem: CodexEventItem | null,
	currentBlock: CodexOutputBlock | null,
	rawEvent: Record<string, unknown>,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	partType: "output_text" | "refusal",
): void {
	if (currentItem?.type !== "message" || currentBlock?.type !== "text") return;
	currentItem.content = currentItem.content || [];
	let lastPart = currentItem.content[currentItem.content.length - 1];
	if (lastPart?.type !== partType) {
		// `content_part.added` never arrived (lossy proxy) — synthesize the part
		// so live text still streams instead of freezing until output_item.done.
		lastPart =
			partType === "output_text"
				? { type: "output_text", text: "", annotations: [] }
				: { type: "refusal", refusal: "" };
		currentItem.content.push(lastPart);
	}
	const delta = (rawEvent as { delta?: string }).delta || "";
	currentBlock.text += delta;
	if (lastPart.type === "output_text") {
		lastPart.text += delta;
	} else {
		lastPart.refusal += delta;
	}
	stream.push({ type: "text_delta", contentIndex: output.content.length - 1, delta, partial: output });
}

function handleToolCallArgumentsDelta(
	runtime: CodexStreamRuntime,
	rawEvent: Record<string, unknown>,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
): CodexWhitespaceToolCallArgumentsDeltaInterruption | undefined {
	const delta = (rawEvent as { delta?: string }).delta || "";
	// Observe BEFORE the item/block guard: degenerate whitespace frames can keep
	// arriving after the item closed (currentBlock detached) and still count as
	// progress for the idle watchdogs — dropping them unobserved would reopen
	// the infinite-loop hole the breaker exists for.
	const interruption = observeWhitespaceToolCallArgumentsDelta(runtime, rawEvent, delta);
	if (interruption) return interruption;
	const currentItem = runtime.currentItem;
	const currentBlock = runtime.currentBlock;
	if (currentItem?.type !== "function_call" || currentBlock?.type !== "toolCall") return undefined;
	currentBlock.partialJson += delta;
	const throttled = parseStreamingJsonThrottled(currentBlock.partialJson, currentBlock.lastParseLen ?? 0);
	if (throttled) {
		currentBlock.arguments = throttled.value;
		currentBlock.lastParseLen = throttled.parsedLen;
	}
	stream.push({ type: "toolcall_delta", contentIndex: output.content.length - 1, delta, partial: output });
	return undefined;
}

function handleToolCallArgumentsDone(
	currentItem: CodexEventItem | null,
	currentBlock: CodexOutputBlock | null,
	rawEvent: Record<string, unknown>,
): void {
	if (currentItem?.type !== "function_call" || currentBlock?.type !== "toolCall") return;
	const args = (rawEvent as { arguments?: string }).arguments;
	if (typeof args === "string") {
		currentBlock.partialJson = args;
		currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
		delete (currentBlock as { partialJson?: string }).partialJson;
		delete (currentBlock as { lastParseLen?: number }).lastParseLen;
	}
}

function handleCustomToolCallInputDelta(
	runtime: CodexStreamRuntime,
	rawEvent: Record<string, unknown>,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
): CodexWhitespaceToolCallArgumentsDeltaInterruption | undefined {
	const delta = (rawEvent as { delta?: string }).delta || "";
	// Observe BEFORE the item/block guard — see handleToolCallArgumentsDelta.
	const interruption = observeWhitespaceToolCallArgumentsDelta(runtime, rawEvent, delta);
	if (interruption) return interruption;
	const currentItem = runtime.currentItem;
	const currentBlock = runtime.currentBlock;
	if (currentItem?.type !== "custom_tool_call" || currentBlock?.type !== "toolCall") return undefined;
	currentBlock.partialJson += delta;
	(currentBlock.arguments as { input?: string }).input = currentBlock.partialJson;
	stream.push({ type: "toolcall_delta", contentIndex: output.content.length - 1, delta, partial: output });
	return undefined;
}

function handleCustomToolCallInputDone(
	currentItem: CodexEventItem | null,
	currentBlock: CodexOutputBlock | null,
	rawEvent: Record<string, unknown>,
): void {
	if (currentItem?.type !== "custom_tool_call" || currentBlock?.type !== "toolCall") return;
	const input = (rawEvent as { input?: string }).input;
	if (typeof input === "string") {
		currentBlock.partialJson = input;
		currentBlock.arguments = { input };
	}
}

function handleOutputItemDone(
	model: Model<"openai-codex-responses">,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	runtime: CodexStreamRuntime,
	rawEvent: Record<string, unknown>,
): void {
	const rawItem = rawEvent.item;
	if (!rawItem || typeof rawItem !== "object") return;
	const item = structuredCloneJSON(rawItem) as CodexEventItem;
	runtime.nativeOutputItems.push(item as unknown as Record<string, unknown>);

	if (item.type === "reasoning" && runtime.currentBlock?.type === "thinking") {
		runtime.currentBlock.thinking = item.summary?.map(summary => summary.text).join("\n\n") || "";
		runtime.currentBlock.thinkingSignature = JSON.stringify(item);
		stream.push({
			type: "thinking_end",
			contentIndex: output.content.length - 1,
			content: runtime.currentBlock.thinking,
			partial: output,
		});
		runtime.currentBlock = null;
		return;
	}

	if (item.type === "message" && runtime.currentBlock?.type === "text") {
		runtime.currentBlock.text = item.content
			.map(content => (content.type === "output_text" ? content.text : content.refusal))
			.join("");
		const phase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
		runtime.currentBlock.textSignature = encodeTextSignatureV1(item.id, phase);
		stream.push({
			type: "text_end",
			contentIndex: output.content.length - 1,
			content: runtime.currentBlock.text,
			partial: output,
		});
		runtime.currentBlock = null;
		return;
	}

	if (item.type === "function_call") {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: item.name,
			arguments: parseStreamingJson(item.arguments || "{}"),
		};
		if (runtime.currentBlock?.type === "toolCall") {
			// Persist the authoritative final args on the stored block; the throttled
			// delta parser may have left currentBlock.arguments stale (often `{}`).
			runtime.currentBlock.arguments = toolCall.arguments;
			delete (runtime.currentBlock as { partialJson?: string }).partialJson;
			delete (runtime.currentBlock as { lastParseLen?: number }).lastParseLen;
			// Detach so a late/duplicate arguments.delta cannot append to the
			// finished block or trip the whitespace-loop guard against it.
			runtime.currentBlock = null;
		}
		runtime.canSafelyReplayWebsocketOverSse = false;
		stream.push({ type: "toolcall_end", contentIndex: output.content.length - 1, toolCall, partial: output });
		return;
	}

	if (item.type === "custom_tool_call") {
		const rawInput =
			runtime.currentBlock?.type === "toolCall" && runtime.currentBlock.partialJson
				? runtime.currentBlock.partialJson
				: (item.input ?? "");
		const toolCall: ToolCall = {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: item.name,
			arguments: { input: rawInput },
			customWireName: item.name,
		};
		if (runtime.currentBlock?.type === "toolCall") {
			runtime.currentBlock.arguments = { input: rawInput };
			delete (runtime.currentBlock as { partialJson?: string }).partialJson;
			runtime.currentBlock = null;
		}
		runtime.canSafelyReplayWebsocketOverSse = false;
		stream.push({ type: "toolcall_end", contentIndex: output.content.length - 1, toolCall, partial: output });
		return;
	}

	void model;
}

function handleResponseCreated(runtime: CodexStreamRuntime, rawEvent: Record<string, unknown>): void {
	const response = (rawEvent as { response?: { id?: string } }).response;
	const state = runtime.websocketState;
	if (state && runtime.transport === "websocket" && typeof response?.id === "string" && response.id.length > 0) {
		state.lastResponseId = response.id;
	}
}

function handleResponseCompleted(
	model: Model<"openai-codex-responses">,
	output: AssistantMessage,
	runtime: CodexStreamRuntime,
	rawEvent: Record<string, unknown>,
): void {
	runtime.sawTerminalEvent = true;
	const response = (
		rawEvent as {
			response?: {
				id?: string;
				usage?: {
					input_tokens?: number;
					output_tokens?: number;
					total_tokens?: number;
					input_tokens_details?: { cached_tokens?: number };
					output_tokens_details?: { reasoning_tokens?: number };
				};
				status?: string;
				service_tier?: ServiceTier | "default";
				end_turn?: boolean;
			};
		}
	).response;

	populateResponsesUsageFromResponse(output, response?.usage);
	if (typeof response?.id === "string" && response.id.length > 0) {
		output.responseId = response.id;
	}

	const state = runtime.websocketState;
	if (state) {
		if (runtime.transport !== "websocket") {
			// SSE turns never chain (previous_response_id is websocket-only on this
			// endpoint); a completed SSE turn also invalidates any websocket append
			// baseline, which no longer matches the transcript.
			resetCodexWebSocketAppendState(state);
		} else {
			state.lastRequest = structuredCloneJSON(runtime.requestBodyForState);
			if (typeof response?.id === "string" && response.id.length > 0) {
				state.lastResponseId = response.id;
				state.lastResponseItems = stripInputItemIds(structuredCloneJSON(runtime.nativeOutputItems));
				state.canAppend = rawEvent.type === "response.done" || rawEvent.type === "response.completed";
			} else {
				// Without a response id the append baseline cannot be trusted.
				state.canAppend = false;
			}
		}
	}

	// Finalize any toolCall block whose output_item.done never arrived: the
	// throttled delta parser may have left block.arguments stale, and the
	// toolUse promotion below would hand the agent incomplete arguments.
	// Mirrors the shared decoder's response.completed sweep; also strips the
	// transient partialJson/lastParseLen fields so they never persist.
	for (const block of output.content) {
		if (block.type !== "toolCall") continue;
		const pending = block as ToolCall & { partialJson?: string; lastParseLen?: number };
		if (pending.partialJson) {
			pending.arguments =
				pending.customWireName !== undefined
					? { input: pending.partialJson }
					: parseStreamingJson(pending.partialJson);
		}
		delete pending.partialJson;
		delete pending.lastParseLen;
	}

	calculateCost(model, output.usage);
	applyCodexServiceTierPricing(model, output.usage, response?.service_tier, runtime.requestBodyForState.service_tier);
	output.stopReason = mapOpenAIResponsesStopReason(response?.status as ResponseStatus | undefined);
	if (output.content.some(block => block.type === "toolCall") && output.stopReason === "stop") {
		output.stopReason = "toolUse";
	}
	// The Codex backend marks an unfinished turn with `end_turn: false` on the
	// terminal event: this response ended on commentary only and the model
	// expects to be sampled again (mirrors codex-rs `needs_follow_up`). Surface
	// it as a non-terminal stop so the agent loop replays history and
	// re-samples instead of ending the turn. Gated on "stop": with tool calls
	// present the loop continues through tool execution anyway.
	if (response?.end_turn === false && output.stopReason === "stop") {
		output.stopDetails = { type: "pause_turn" };
	}
}

async function recoverCodexStreamError(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	error: unknown,
): Promise<boolean> {
	if (await tryRecoverCodexWhitespaceToolCallLoop(context, runtime, error)) {
		return true;
	}
	if (await tryReconnectCodexWebSocketOnConnectionLimit(context, runtime, error)) {
		return true;
	}
	if (await tryRecoverCodexPreviousResponseNotFound(context, runtime, error)) {
		return true;
	}
	if (await tryReplayWebsocketFailureOverSse(context, runtime, error)) {
		return true;
	}
	if (await tryRetryCodexProviderError(context, runtime, error)) {
		return true;
	}
	return false;
}

/**
 * Pop the half-built degenerate tool-call block (the one whose arguments were
 * nothing but whitespace) off the output accumulator so it never surfaces in the
 * caller's message. Any legitimate content produced before it is preserved.
 */
function dropTrailingDegenerateToolCall(output: AssistantMessage, runtime: CodexStreamRuntime): void {
	const block = runtime.currentBlock;
	if (block && block.type === "toolCall" && output.content[output.content.length - 1] === block) {
		output.content.pop();
	}
	runtime.currentItem = null;
	runtime.currentBlock = null;
}

/**
 * Recover from the degenerate whitespace-only tool-call argument loop
 * ({@link CodexWhitespaceToolCallLoopError}). The interrupted function call has
 * no usable arguments, so drop the partial turn and replay the request from
 * scratch — bounded by {@link CODEX_WHITESPACE_LOOP_RETRY_LIMIT}. Sampling
 * nondeterminism usually breaks the loop on a fresh attempt; once the budget is
 * exhausted the original error is surfaced (now without the junk tool call
 * polluting the message). Replay is refused once a toolcall_end was already
 * delivered to the consumer (`canSafelyReplayWebsocketOverSse`) — it would
 * re-emit the same tool calls.
 */
async function tryRecoverCodexWhitespaceToolCallLoop(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	error: unknown,
): Promise<boolean> {
	if (!(error instanceof CodexWhitespaceToolCallLoopError)) {
		return false;
	}
	// Drop the half-built degenerate tool call whether or not we retry, so it
	// never reaches the caller's message.
	dropTrailingDegenerateToolCall(context.output, runtime);
	if (
		runtime.whitespaceLoopRetries >= CODEX_WHITESPACE_LOOP_RETRY_LIMIT ||
		!runtime.canSafelyReplayWebsocketOverSse ||
		context.options?.signal?.aborted
	) {
		return false;
	}

	runtime.whitespaceLoopRetries += 1;
	const websocketState = context.requestContext.websocketState;
	if (websocketState) {
		resetCodexWebSocketAppendState(websocketState);
		resetCodexSessionMetadata(websocketState);
	}

	logCodexDebug("retrying codex turn after whitespace-only tool-call argument loop", {
		retry: runtime.whitespaceLoopRetries,
		retryBudget: CODEX_WHITESPACE_LOOP_RETRY_LIMIT,
		transport: runtime.transport,
	});

	runtime.currentItem = null;
	runtime.currentBlock = null;
	runtime.sawTerminalEvent = false;
	runtime.nativeOutputItems.length = 0;
	resetWhitespaceToolCallArgumentsDelta(runtime);
	resetOutputState(context.output);
	context.firstTokenTime = undefined;
	await scheduler.wait(CODEX_WHITESPACE_LOOP_RETRY_DELAY_MS * runtime.whitespaceLoopRetries, {
		signal: context.requestSetup.requestSignal,
	});

	if (runtime.transport === "websocket" && websocketState) {
		await reopenCodexWebSocketRuntimeStream(context, runtime, websocketState);
		return true;
	}

	await reopenCodexSseRuntimeStream(context, runtime, websocketState);
	return true;
}

/**
 * Handles `websocket_connection_limit_reached` errors by closing the stale connection
 * and opening a fresh websocket. If content has already been emitted to the caller,
 * falls back to SSE replay (same as other WS failures) since we cannot safely
 * continue a partial response on a new connection. If a tool call was already
 * delivered (`canSafelyReplayWebsocketOverSse` is false), the error surfaces
 * instead — replaying would re-emit the same tool calls.
 */
async function tryReconnectCodexWebSocketOnConnectionLimit(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	error: unknown,
): Promise<boolean> {
	if (!(error instanceof CodexProviderStreamError) || error.code !== "websocket_connection_limit_reached") {
		return false;
	}
	const websocketState = context.requestContext.websocketState;
	if (!websocketState || runtime.transport !== "websocket" || context.options?.signal?.aborted) {
		return false;
	}

	// Close the stale connection so getOrCreateCodexWebSocketConnection creates a fresh one.
	websocketState.connection?.close("connection_limit");
	websocketState.connection = undefined;
	resetCodexWebSocketAppendState(websocketState);

	if (context.output.content.length > 0 && !runtime.canSafelyReplayWebsocketOverSse) {
		// A toolcall_end already reached the consumer; a full replay would emit
		// the same tool calls a second time. Let the error surface instead.
		return false;
	}

	logCodexDebug("codex websocket connection limit reached, reconnecting", {
		hadContent: context.output.content.length > 0,
		retry: runtime.websocketStreamRetries,
	});

	if (context.output.content.length > 0) {
		// Content already emitted to the caller — cannot safely continue on a new WS.
		// Reset and replay the full request over SSE.
		runtime.currentItem = null;
		runtime.currentBlock = null;
		runtime.nativeOutputItems.length = 0;
		resetOutputState(context.output);
		context.firstTokenTime = undefined;
		recordCodexWebSocketFailure(websocketState, true);
		await reopenCodexSseRuntimeStream(context, runtime, websocketState);
		return true;
	}

	// No content emitted yet — clear accumulator state from the failed attempt
	// (blockless native items can exist even with empty content) and reconnect
	// over websocket, bounded by the shared retry budget: an account-scoped
	// limit can reject every fresh connection, and an unbounded loop would
	// hammer the endpoint with zero backoff.
	runtime.currentItem = null;
	runtime.currentBlock = null;
	runtime.nativeOutputItems.length = 0;
	context.firstTokenTime = undefined;
	if (runtime.websocketStreamRetries >= getCodexWebSocketRetryBudget()) {
		recordCodexWebSocketFailure(websocketState, true);
		await reopenCodexSseRuntimeStream(context, runtime, websocketState);
		return true;
	}
	runtime.websocketStreamRetries += 1;
	await scheduler.wait(getCodexWebSocketRetryDelayMs(runtime.websocketStreamRetries), {
		signal: context.requestSetup.requestSignal,
	});
	await reopenCodexWebSocketRuntimeStream(context, runtime, websocketState);
	return true;
}

function isCodexStalePreviousResponseError(error: unknown): boolean {
	if (error instanceof CodexProviderStreamError) return error.code === "previous_response_not_found";
	if (!(error instanceof Error)) return false;
	if ((error as { code?: string }).code === "previous_response_not_found") return true;
	// "unsupported": the backend intermittently rejects the parameter outright
	// with `{"detail":"Unsupported parameter: previous_response_id"}` (no
	// `error.code`); treat it like a stale chain so the turn replays with full
	// context instead of surfacing the 400.
	return (
		/previous[ _]?response/i.test(error.message) &&
		/not[ _]?found|invalid|expired|stale|unsupported/i.test(error.message)
	);
}

async function tryRecoverCodexPreviousResponseNotFound(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	error: unknown,
): Promise<boolean> {
	const websocketState = context.requestContext.websocketState;
	if (
		!isCodexStalePreviousResponseError(error) ||
		!websocketState ||
		context.output.content.length > 0 ||
		context.options?.signal?.aborted ||
		runtime.providerRetryAttempt >= CODEX_MAX_RETRIES
	) {
		return false;
	}
	if (runtime.transport !== "websocket") {
		// SSE never sends previous_response_id; let other recovery handle it.
		return false;
	}

	runtime.providerRetryAttempt += 1;
	resetCodexWebSocketAppendState(websocketState);
	resetCodexSessionMetadata(websocketState);
	runtime.currentItem = null;
	runtime.currentBlock = null;
	runtime.sawTerminalEvent = false;
	runtime.nativeOutputItems.length = 0;
	resetOutputState(context.output);
	context.firstTokenTime = undefined;

	logCodexDebug("codex previous_response_id expired; retrying with full context", {
		retry: runtime.providerRetryAttempt,
	});
	await reopenCodexWebSocketRuntimeStream(context, runtime, websocketState);
	return true;
}

async function tryReplayWebsocketFailureOverSse(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	error: unknown,
): Promise<boolean> {
	const websocketState = context.requestContext.websocketState;
	const canReplay =
		runtime.transport === "websocket" &&
		websocketState &&
		isCodexWebSocketRetryableStreamError(error) &&
		runtime.canSafelyReplayWebsocketOverSse &&
		!runtime.sawTerminalEvent &&
		!context.options?.signal?.aborted;
	if (!canReplay) return false;

	const state = websocketState;
	const streamError = error instanceof Error ? error : new Error(String(error));
	const replayingBufferedOutputOverSse = context.output.content.length > 0;
	const isFatal = isCodexWebSocketFatalError(streamError);
	const activateFallback =
		replayingBufferedOutputOverSse || isFatal || runtime.websocketStreamRetries >= getCodexWebSocketRetryBudget();
	recordCodexWebSocketFailure(state, activateFallback);
	logCodexDebug("codex websocket stream fallback", {
		error: streamError.message,
		retry: runtime.websocketStreamRetries,
		retryBudget: getCodexWebSocketRetryBudget(),
		activated: activateFallback,
		fatal: isFatal,
		replayedBufferedOutput: replayingBufferedOutputOverSse,
	});

	if (!activateFallback) {
		runtime.websocketStreamRetries += 1;
		// Full re-send on a fresh socket: clear accumulator state from the failed
		// attempt. Content is empty here, but blockless native items (e.g.
		// web_search_call) may already have accumulated.
		runtime.currentItem = null;
		runtime.currentBlock = null;
		runtime.nativeOutputItems.length = 0;
		context.firstTokenTime = undefined;
		await scheduler.wait(getCodexWebSocketRetryDelayMs(runtime.websocketStreamRetries), {
			signal: context.requestSetup.requestSignal,
		});
		await reopenCodexWebSocketRuntimeStream(context, runtime, state);
		return true;
	}

	runtime.currentItem = null;
	runtime.currentBlock = null;
	runtime.nativeOutputItems.length = 0;
	resetOutputState(context.output);
	context.firstTokenTime = undefined;

	await reopenCodexSseRuntimeStream(context, runtime, state);
	return true;
}

async function tryRetryCodexProviderError(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	error: unknown,
): Promise<boolean> {
	if (
		!isRetryableCodexProviderError(error) ||
		context.output.content.length > 0 ||
		runtime.providerRetryAttempt >= CODEX_MAX_RETRIES ||
		context.options?.signal?.aborted
	) {
		return false;
	}

	runtime.providerRetryAttempt += 1;
	const websocketState = context.requestContext.websocketState;
	if (websocketState) {
		resetCodexWebSocketAppendState(websocketState);
		resetCodexSessionMetadata(websocketState);
	}

	logCodexDebug("retrying codex provider stream error", {
		error: error instanceof Error ? error.message : String(error),
		retry: runtime.providerRetryAttempt,
		retryBudget: CODEX_MAX_RETRIES,
		transport: runtime.transport,
	});

	runtime.currentItem = null;
	runtime.currentBlock = null;
	runtime.sawTerminalEvent = false;
	runtime.nativeOutputItems.length = 0;
	resetOutputState(context.output);
	context.firstTokenTime = undefined;
	await scheduler.wait(CODEX_RETRY_DELAY_MS * runtime.providerRetryAttempt, {
		signal: context.requestSetup.requestSignal,
	});

	if (runtime.transport === "websocket" && websocketState) {
		await reopenCodexWebSocketRuntimeStream(context, runtime, websocketState);
		return true;
	}

	await reopenCodexSseRuntimeStream(context, runtime, websocketState);
	return true;
}

function finalizeCodexResponse(
	context: CodexStreamProcessingContext,
	runtime: CodexStreamRuntime,
	completion: CodexStreamCompletion,
): AssistantMessage {
	const { output } = context;
	if (context.options?.signal?.aborted) {
		throw new Error("Request was aborted");
	}
	if (!runtime.sawTerminalEvent) {
		if (context.requestContext.websocketState) {
			resetCodexWebSocketAppendState(context.requestContext.websocketState);
			resetCodexSessionMetadata(context.requestContext.websocketState);
		}
		logCodexDebug("codex stream ended unexpectedly", {
			transport: runtime.transport,
			terminalEventSeen: runtime.sawTerminalEvent,
			unexpectedStreamEnd: true,
			sentTurnStateHeader: Boolean(context.requestContext.websocketState?.turnState),
			sentModelsEtagHeader: Boolean(context.requestContext.websocketState?.modelsEtag),
		});
		throw new Error("Codex stream ended before terminal completion event");
	}
	if (output.stopReason === "aborted" || output.stopReason === "error") {
		throw new Error("Codex response failed");
	}

	output.providerPayload = createOpenAIResponsesHistoryPayload(context.model.provider, runtime.nativeOutputItems);
	output.duration = Date.now() - context.startTime;
	if (completion.firstTokenTime) {
		output.ttft = completion.firstTokenTime - context.startTime;
	}
	return output;
}

async function handleCodexStreamFailure(
	context: CodexStreamProcessingContext,
	error: unknown,
): Promise<AssistantMessage> {
	const { output } = context;
	removeTransientBlockIndices(output);
	if (context.requestContext.websocketState) {
		resetCodexWebSocketAppendState(context.requestContext.websocketState);
		resetCodexSessionMetadata(context.requestContext.websocketState);
	}
	output.stopReason = context.options?.signal?.aborted ? "aborted" : "error";
	output.errorStatus = extractHttpStatusFromError(error);
	output.errorMessage = await finalizeErrorMessage(error, context.requestContext.rawRequestDump);
	output.duration = Date.now() - context.startTime;
	if (context.firstTokenTime) {
		output.ttft = context.firstTokenTime - context.startTime;
	}
	return output;
}

export const streamOpenAICodexResponses: StreamFunction<"openai-codex-responses"> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		const output = createAssistantOutput(model);
		const requestSetup = createRequestSetup(options);
		let processingContext: CodexStreamProcessingContext | undefined;
		let requestContext: CodexRequestContext | undefined;

		try {
			requestContext = await buildCodexRequestContext(model, context, options, output);
			const initialTransport = await openInitialCodexEventStream(model, options, requestSetup, requestContext);
			const runtime = createCodexStreamRuntime({
				...initialTransport,
				websocketState: requestContext.websocketState,
			});
			if (requestContext.websocketState) {
				requestContext.websocketState.lastTransport = initialTransport.transport;
			}

			processingContext = {
				model,
				output,
				stream,
				options,
				requestSetup,
				requestContext,
				startTime,
			};

			const completion = await processCodexResponseStream(processingContext, runtime);
			processingContext.firstTokenTime = completion.firstTokenTime;
			const message = finalizeCodexResponse(processingContext, runtime, completion);
			stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
			stream.end();
		} catch (error) {
			const failureContext =
				processingContext ??
				({
					model,
					output,
					stream,
					options,
					requestSetup,
					requestContext: requestContext ?? {
						apiKey: "",
						accountId: "",
						baseUrl: model.baseUrl || CODEX_BASE_URL,
						url: "",
						requestHeaders: {},
						responsesLite: options?.responsesLite === true,
						transformedBody: { model: model.id },
						rawRequestDump: {
							provider: model.provider,
							api: output.api,
							model: model.id,
							method: "POST",
							url: "",
							body: { model: model.id },
						},
					},
					startTime,
				} satisfies CodexStreamProcessingContext);
			try {
				const failure = await handleCodexStreamFailure(failureContext, error);
				stream.push({ type: "error", reason: failure.stopReason as "error" | "aborted", error: failure });
			} catch (failureError) {
				// Last resort — the failure handler itself threw (exotic error object or
				// request-dump formatting). Never leave the stream un-ended.
				logger.error("Codex stream failure handler threw", {
					error: failureError instanceof Error ? failureError.message : String(failureError),
				});
				output.stopReason = "error";
				output.errorMessage ??= error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: "error", error: output });
			}
			stream.end();
		}
	})();

	return stream;
};

export async function prewarmOpenAICodexResponses(
	model: Model<"openai-codex-responses">,
	options?: Pick<
		OpenAICodexResponsesOptions,
		"apiKey" | "headers" | "sessionId" | "signal" | "preferWebsockets" | "providerSessionState" | "responsesLite"
	>,
): Promise<void> {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
	if (!apiKey) return;
	const accountId = getAccountId(apiKey);
	const baseUrl = model.baseUrl || CODEX_BASE_URL;
	const url = resolveCodexResponsesUrl(baseUrl);
	const promptCacheKey = normalizeOpenAIResponsesPromptCacheKey(options?.sessionId);
	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const responsesLite = options?.responsesLite === true;
	const sessionKey = getCodexWebSocketSessionKey(promptCacheKey, model, accountId, baseUrl, responsesLite);
	const publicSessionKey = getCodexPublicSessionKey(promptCacheKey, model, baseUrl);
	if (publicSessionKey && sessionKey) {
		providerSessionState?.webSocketPublicToPrivate.set(publicSessionKey, sessionKey);
	}
	if (!sessionKey || !providerSessionState) return;
	const state = getCodexWebSocketSessionState(sessionKey, providerSessionState);
	if (!shouldUseCodexWebSocket(model, state, options?.preferWebsockets)) return;
	const headers = logger.time(
		"prewarmCodex:createHeaders",
		createCodexHeaders,
		{ ...(model.headers ?? {}), ...(options?.headers ?? {}) },
		accountId,
		apiKey,
		promptCacheKey,
		"websocket",
		state,
		responsesLite,
	);
	await logger.time(
		"prewarmCodex:establishWs",
		getOrCreateCodexWebSocketConnection,
		state,
		toWebSocketUrl(url),
		headers,
		options?.signal,
	);
	state.prewarmed = true;
}

function resolveCodexPromptCacheKey(
	options: Pick<OpenAICodexResponsesOptions, "promptCacheKey" | "sessionId"> | undefined,
): string | undefined {
	return normalizeOpenAIResponsesPromptCacheKey(options?.promptCacheKey ?? options?.sessionId);
}

function resolveCodexTransportSessionId(
	options: Pick<OpenAICodexResponsesOptions, "sessionId"> | undefined,
): string | undefined {
	return normalizeOpenAIResponsesPromptCacheKey(options?.sessionId);
}

function getCodexWebSocketSessionKey(
	sessionId: string | undefined,
	model: Model<"openai-codex-responses">,
	accountId: string,
	baseUrl: string,
	responsesLite: boolean,
): string | undefined {
	const promptCacheKey = normalizeOpenAIResponsesPromptCacheKey(sessionId);
	if (!promptCacheKey) return undefined;
	// Responses Lite is connection-scoped on the WebSocket upgrade, so lite and
	// non-lite turns must never share a pooled socket or append state.
	const liteSuffix = responsesLite ? ":lite" : "";
	return `${accountId}:${baseUrl}:${model.id}:${promptCacheKey}${liteSuffix}`;
}

function getCodexPublicSessionKey(
	sessionId: string | undefined,
	model: Model<"openai-codex-responses">,
	baseUrl: string,
): string | undefined {
	const promptCacheKey = normalizeOpenAIResponsesPromptCacheKey(sessionId);
	if (!promptCacheKey) return undefined;
	return `${baseUrl}:${model.id}:${promptCacheKey}`;
}

function getCodexWebSocketSessionState(
	sessionKey: string,
	providerSessionState: CodexProviderSessionState,
): CodexWebSocketSessionState {
	const existing = providerSessionState.webSocketSessions.get(sessionKey);
	if (existing) return existing;
	const created: CodexWebSocketSessionState = {
		disableWebsocket: false,
		canAppend: false,
		fallbackCount: 0,
		prewarmed: false,
		stats: {
			fullContextRequests: 0,
			deltaRequests: 0,
			lastInputItems: 0,
		},
	};
	providerSessionState.webSocketSessions.set(sessionKey, created);
	return created;
}

function resetCodexWebSocketAppendState(state: CodexWebSocketSessionState): void {
	state.canAppend = false;
	state.lastRequest = undefined;
	state.lastResponseId = undefined;
	state.lastResponseItems = undefined;
}

function resetCodexSessionMetadata(state: CodexWebSocketSessionState): void {
	state.turnState = undefined;
	state.modelsEtag = undefined;
}

function recordCodexWebSocketFailure(state: CodexWebSocketSessionState, activateFallback: boolean): void {
	resetCodexWebSocketAppendState(state);
	// Never tear down a CONNECTING socket: it belongs to a concurrent caller's
	// in-flight handshake (prewarm/request race); closing it would reject that
	// caller with a fatal "websocket closed before open" and disable websockets
	// for the whole session.
	if (state.connection && !state.connection.isConnecting()) {
		state.connection.close("fallback");
		state.connection = undefined;
	}
	state.lastFallbackAt = Date.now();
	if (activateFallback && !state.disableWebsocket) {
		state.disableWebsocket = true;
		state.fallbackCount += 1;
	}
}

function shouldUseCodexWebSocket(
	model: Model<"openai-codex-responses">,
	state: CodexWebSocketSessionState | undefined,
	preferWebsockets?: boolean,
): boolean {
	if (!state || state.disableWebsocket) return false;
	if (preferWebsockets === false) return false;
	return isCodexWebSocketEnvEnabled() || preferWebsockets === true || model.preferWebsockets === true;
}

export interface OpenAICodexTransportDetails {
	websocketPreferred: boolean;
	lastTransport?: CodexTransport;
	websocketDisabled: boolean;
	websocketConnected: boolean;
	fallbackCount: number;
	canAppend: boolean;
	prewarmed: boolean;
	hasSessionState: boolean;
	lastFallbackAt?: number;
}

function getCodexWebSocketStateForPublicSession(
	model: Model<"openai-codex-responses">,
	options:
		| {
				sessionId?: string;
				baseUrl?: string;
				providerSessionState?: Map<string, ProviderSessionState>;
		  }
		| undefined,
): CodexWebSocketSessionState | undefined {
	const baseUrl = options?.baseUrl || model.baseUrl || CODEX_BASE_URL;
	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const publicSessionKey = getCodexPublicSessionKey(options?.sessionId, model, baseUrl);
	const privateSessionKey = publicSessionKey
		? providerSessionState?.webSocketPublicToPrivate.get(publicSessionKey)
		: undefined;
	return privateSessionKey ? providerSessionState?.webSocketSessions.get(privateSessionKey) : undefined;
}

export function getOpenAICodexWebSocketDebugStats(
	model: Model<"openai-codex-responses">,
	options?: {
		sessionId?: string;
		baseUrl?: string;
		providerSessionState?: Map<string, ProviderSessionState>;
	},
): OpenAICodexWebSocketDebugStats | undefined {
	const stats = getCodexWebSocketStateForPublicSession(model, options)?.stats;
	return stats ? { ...stats } : undefined;
}

export function getOpenAICodexTransportDetails(
	model: Model<"openai-codex-responses">,
	options?: {
		sessionId?: string;
		baseUrl?: string;
		preferWebsockets?: boolean;
		providerSessionState?: Map<string, ProviderSessionState>;
	},
): OpenAICodexTransportDetails {
	const websocketPreferred =
		options?.preferWebsockets === false
			? false
			: isCodexWebSocketEnvEnabled() || options?.preferWebsockets === true || model.preferWebsockets === true;
	const state = getCodexWebSocketStateForPublicSession(model, options);

	return {
		websocketPreferred,
		lastTransport: state?.lastTransport,
		websocketDisabled: state?.disableWebsocket ?? false,
		websocketConnected: state?.connection?.isOpen() ?? false,
		fallbackCount: state?.fallbackCount ?? 0,
		canAppend: state?.canAppend ?? false,
		prewarmed: state?.prewarmed ?? false,
		hasSessionState: state !== undefined,
		lastFallbackAt: state?.lastFallbackAt,
	};
}

function stripInputItemIds(items: Array<Record<string, unknown>>): InputItem[] {
	return items.map(item => {
		if (item.id == null) return item as InputItem;
		const { id: _id, ...rest } = item;
		return rest as InputItem;
	});
}

function recordCodexWebSocketRequestStats(
	state: CodexWebSocketSessionState | undefined,
	request: Record<string, unknown>,
): void {
	if (!state) return;
	const input = request.input;
	state.stats.lastInputItems = Array.isArray(input) ? input.length : 0;
	if (typeof request.previous_response_id === "string" && request.previous_response_id.length > 0) {
		state.stats.deltaRequests += 1;
		state.stats.lastDeltaInputItems = state.stats.lastInputItems;
		state.stats.lastPreviousResponseId = request.previous_response_id;
		return;
	}
	state.stats.fullContextRequests += 1;
	state.stats.lastDeltaInputItems = undefined;
	state.stats.lastPreviousResponseId = undefined;
}

/**
 * Shape the next websocket turn's request body: when the session's append
 * baseline is intact (same options, strict history prefix), chain via
 * `previous_response_id` + delta-only `input`; otherwise break the chain and
 * replay the full transcript. SSE requests never chain — the HTTP endpoint's
 * request schema has no `previous_response_id` (codex-rs carries it only on
 * websocket `response.create` frames) and strict gateway validators 400 it
 * with `{"detail":"Unsupported parameter: previous_response_id"}`.
 */
function buildCodexChainedRequestBody(
	requestBody: RequestBody,
	state: CodexWebSocketSessionState | undefined,
): RequestBody {
	const chainable = state?.canAppend === true;
	const appendInput = chainable
		? buildResponsesDeltaInput<InputItem>(state.lastRequest, state.lastResponseItems, requestBody)
		: null;
	if (appendInput && appendInput.length > 0 && state?.lastResponseId) {
		const body: RequestBody = { ...requestBody, previous_response_id: state.lastResponseId, input: appendInput };
		recordCodexWebSocketRequestStats(state, body);
		return body;
	}
	if (chainable && state) {
		// Chaining was eligible but the prefix/options check failed: history
		// mutated or options changed — break the chain.
		logCodexDebug("codex append reset", {
			hadTurnStateHeader: Boolean(state.turnState),
			hadModelsEtagHeader: Boolean(state.modelsEtag),
		});
		resetCodexWebSocketAppendState(state);
		resetCodexSessionMetadata(state);
	}
	recordCodexWebSocketRequestStats(state, requestBody);
	return requestBody;
}

function toWebSocketUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol === "https:") {
		parsed.protocol = "wss:";
	} else if (parsed.protocol === "http:") {
		parsed.protocol = "ws:";
	}
	return parsed.toString();
}

function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

interface CodexWebSocketRequestTimeouts {
	idleTimeoutMs?: number;
	firstEventTimeoutMs?: number;
}

interface CodexWebSocketConnectionOptions {
	onHandshakeHeaders?: (headers: Headers) => void;
}

class CodexWebSocketConnection {
	#url: string;
	#headers: Record<string, string>;
	#onHandshakeHeaders?: (headers: Headers) => void;
	#socket: Bun.WebSocket | null = null;
	#queue: Array<Record<string, unknown> | Error | null> = [];
	#waiters: Array<() => void> = [];
	#connectPromise?: Promise<void>;
	#activeRequest = false;
	#streamObserver?: (event: RawSseEvent) => void;
	#heartbeatInterval: NodeJS.Timeout | undefined;
	#removePongListener?: () => void;
	#handshakeHeaders?: Headers;
	#debugResponseLog?: RequestDebugResponseLog;
	/**
	 * Wall-clock of the most recent inbound activity on this socket — any
	 * decoded message, any pong, or the moment the handshake completed. Used
	 * by {@link isHealthyForReuse} so we don't write a continuation frame into
	 * a TCP-open-but-server-evicted socket whose `readyState` still says OPEN.
	 */
	#lastInboundAt = 0;
	/** Wall-clock of the last heartbeat ping we issued; 0 if none yet. */
	#lastPingAt = 0;

	constructor(url: string, headers: Record<string, string>, options: CodexWebSocketConnectionOptions) {
		this.#url = url;
		this.#headers = headers;
		this.#onHandshakeHeaders = options.onHandshakeHeaders;
	}

	isOpen(): boolean {
		return this.#socket?.readyState === WebSocket.OPEN;
	}

	/** True while a handshake (possibly started by another caller) is still in flight. */
	isConnecting(): boolean {
		return this.#connectPromise !== undefined;
	}

	/**
	 * Stricter variant of {@link isOpen} for the connection-pool reuse gate.
	 * Refuses sockets that have been silent past {@link CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS}.
	 *
	 * Bun's `WebSocket` does not always surface server-side eviction (no
	 * `onclose`, no `onerror`), so a socket can sit in readyState OPEN long
	 * after the upstream has dropped it. Reusing such a socket sends the next
	 * `response.create` into a half-open write buffer and parks the reader
	 * until the first-event / idle timeout fires (issue #1450). Forcing a
	 * reconnect on any suspect socket trades a sub-second handshake for a
	 * 60–300 s stall.
	 */
	isHealthyForReuse(): boolean {
		if (!this.isOpen()) return false;
		const maxIdleMs = getCodexWebSocketMaxIdleReuseMs();
		if (maxIdleMs <= 0) return true;
		// Initial connect sets #lastInboundAt; any later message or pong refreshes
		// it. A zero value means the field was never initialized, which itself is
		// a desync — treat as unhealthy.
		if (this.#lastInboundAt === 0) return false;
		return Date.now() - this.#lastInboundAt <= maxIdleMs;
	}

	matchesAuth(headers: Record<string, string>): boolean {
		return this.#headers.authorization === headers.authorization;
	}

	close(reason = "done"): void {
		if (
			this.#socket &&
			(this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING)
		) {
			this.#socket.close(1000, reason);
		}
		this.#socket = null;
		this.#stopHeartbeat();
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.isOpen()) return;
		if (this.#connectPromise) {
			logger.time("codexWs:awaitSharedHandshake");
			await this.#connectPromise;
			return;
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#connectPromise = promise;
		const socket = new (WebSocket as unknown as new (url: string, opts: Bun.WebSocketOptions) => Bun.WebSocket)(
			this.#url,
			{ headers: this.#headers },
		);
		socket.binaryType = "nodebuffer";
		this.#socket = socket;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const clearPending = () => {
			if (timeout !== undefined) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			socket.close(1000, "aborted");
			if (!settled) {
				settled = true;
				clearPending();
				reject(createCodexWebSocketTransportError("request was aborted"));
			}
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		if (!settled) {
			timeout = setTimeout(() => {
				socket.close(1000, "connect-timeout");
				if (!settled) {
					settled = true;
					clearPending();
					reject(createCodexWebSocketTransportError("connection timeout"));
				}
			}, CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS);
		}

		socket.onopen = event => {
			if (!settled) {
				settled = true;
				clearPending();
				this.#lastInboundAt = Date.now();
				this.#captureHandshakeHeaders(socket, event);
				this.#startHeartbeat(socket);
				resolve();
			}
		};
		socket.onerror = event => {
			const eventRecord = event as unknown as Record<string, unknown>;
			const detail =
				(typeof eventRecord.message === "string" && eventRecord.message) ||
				(eventRecord.error instanceof Error && eventRecord.error.message) ||
				String(event.type);
			const error = createCodexWebSocketTransportError(`websocket error: ${detail}`);
			if (!settled) {
				settled = true;
				clearPending();
				reject(error);
				return;
			}
			this.#push(error);
		};
		socket.onclose = event => {
			this.#socket = null;
			this.#stopHeartbeat();
			if (!settled) {
				settled = true;
				clearPending();
				reject(createCodexWebSocketTransportError(`websocket closed before open (${event.code})`));
				return;
			}
			this.#push(createCodexWebSocketTransportError(`websocket closed (${event.code})`));
			this.#push(null);
		};
		socket.onmessage = event => {
			// Stamp inbound activity before parsing so even malformed frames refresh
			// the liveness clock — what matters for reuse health is that the upstream
			// is still talking to us, not that every frame is well-formed.
			this.#lastInboundAt = Date.now();
			this.#writeDebugWebSocketFrame(event.data);
			try {
				const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf-8");
				if (!text) return;
				const parsed = JSON.parse(text) as Record<string, unknown>;
				if (parsed.type === "error" && typeof parsed.error === "object" && parsed.error) {
					const inner = parsed.error as Record<string, unknown>;
					if (typeof parsed.code !== "string" && typeof inner.code === "string") {
						parsed.code = inner.code;
					}
					if (typeof parsed.message !== "string" && typeof inner.message === "string") {
						parsed.message = inner.message;
					}
				}
				notifyCodexWebSocketInbound(this.#streamObserver, parsed, text);
				this.#push(parsed);
			} catch (error) {
				notifyCodexWebSocketMalformed(this.#streamObserver, event.data, error);
				this.#push(createCodexWebSocketTransportError(String(error)));
			}
		};

		logger.time("codexWs:awaitTcpHandshake");
		try {
			await promise;
		} finally {
			this.#connectPromise = undefined;
		}
	}

	async *streamRequest(
		request: Record<string, unknown>,
		timeouts: CodexWebSocketRequestTimeouts,
		signal?: AbortSignal,
		onSseEvent?: (event: RawSseEvent) => void,
	): AsyncGenerator<Record<string, unknown>> {
		if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
			throw createCodexWebSocketTransportError("websocket connection is unavailable");
		}
		if (this.#activeRequest) {
			throw createCodexWebSocketTransportError("websocket request already in progress");
		}
		if (signal?.aborted) {
			throw createCodexWebSocketTransportError("request was aborted");
		}
		this.#activeRequest = true;
		this.#streamObserver = onSseEvent;
		// Drain any non-error frames left over from a prior request before sending.
		// `processCodexResponseStream` breaks its `for-await` on the terminal event,
		// which interrupts our generator at `yield next` (the post-yield `break`
		// never runs). Any frame that landed between the consumer's break and the
		// generator's `finally` lingers in `#queue` and would otherwise become the
		// first frame of THIS request — a stale `response.completed` would end the
		// turn immediately with empty output, and a stale non-progress frame would
		// flip `sawFirstEvent` and silently downgrade the first-event timeout to
		// the longer idle timeout. Transport errors are preserved so we surface
		// the death signal instead of writing into a dead socket.
		this.#dropStaleFrames();
		const onAbort = () => {
			this.close("aborted");
			this.#push(createCodexWebSocketTransportError("request was aborted"));
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });

		try {
			const debugSession = isRequestDebugEnabled()
				? await createRequestDebugSession({
						protocol: "websocket",
						method: "POST",
						url: this.#url,
						headers: this.#headers,
						body: request,
					})
				: undefined;
			this.#debugResponseLog = debugSession
				? await debugSession.openResponseLog("WebSocket 101 Switching Protocols", this.#handshakeHeaders)
				: undefined;

			const requestPayload = JSON.stringify(request);
			notifyCodexWebSocketOutbound(onSseEvent, request, requestPayload);
			// Re-check liveness: the debug-session await above can outlive the socket.
			const socket = this.#socket;
			if (!socket || socket.readyState !== WebSocket.OPEN) {
				throw createCodexWebSocketTransportError("websocket connection is unavailable");
			}
			try {
				socket.send(requestPayload);
			} catch (error) {
				throw createCodexWebSocketTransportError(
					`websocket send failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			let sawFirstEvent = false;
			const { idleTimeoutMs, firstEventTimeoutMs } = timeouts;
			let lastProgressAt = Date.now();
			let lastProgressEventType: string | undefined;
			let lastEventAt = lastProgressAt;
			let lastEventType: string | undefined;
			while (true) {
				let timeoutMs: number | undefined;
				let timeoutReason: string;
				if (sawFirstEvent) {
					timeoutReason = createCodexWebSocketTimeoutMessage("idle timeout waiting for websocket", {
						lastEventAt,
						lastEventType,
						lastProgressAt,
						lastProgressEventType,
					});
					if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
						timeoutMs = idleTimeoutMs - (Date.now() - lastProgressAt);
						if (timeoutMs <= 0) {
							logCodexDebug("codex websocket idle timeout", {
								lastEventType,
								lastProgressEventType,
								msSinceLastEvent: Date.now() - lastEventAt,
								msSinceLastProgress: Date.now() - lastProgressAt,
							});
							throw createCodexWebSocketTransportError(timeoutReason);
						}
					}
				} else {
					timeoutReason = createCodexWebSocketTimeoutMessage("timeout waiting for first websocket event", {
						lastEventAt,
						lastEventType,
						lastProgressAt,
						lastProgressEventType,
					});
					if (firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0) {
						timeoutMs = firstEventTimeoutMs;
					}
				}
				const next = await this.#nextMessage(timeoutMs, timeoutReason);
				if (next instanceof Error) {
					throw next;
				}
				if (next === null) {
					throw createCodexWebSocketTransportError("websocket closed before response completion");
				}
				sawFirstEvent = true;
				const eventType = typeof next.type === "string" ? next.type : "";
				lastEventAt = Date.now();
				lastEventType = eventType || undefined;
				if (isCodexStreamProgressEvent(next)) {
					lastProgressAt = lastEventAt;
					lastProgressEventType = lastEventType;
				}
				yield next;
				if (
					eventType === "response.completed" ||
					eventType === "response.done" ||
					eventType === "response.incomplete" ||
					eventType === "response.failed" ||
					eventType === "error"
				) {
					break;
				}
			}
		} finally {
			this.#activeRequest = false;
			this.#streamObserver = undefined;
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			const debugResponseLog = this.#debugResponseLog;
			this.#debugResponseLog = undefined;
			await debugResponseLog?.close();
		}
	}

	#captureHandshakeHeaders(socket: Bun.WebSocket, openEvent?: Event): void {
		const headers = extractCodexWebSocketHandshakeHeaders(socket, openEvent);
		if (!headers) return;
		this.#handshakeHeaders = headers;
		this.#onHandshakeHeaders?.(headers);
	}

	#writeDebugWebSocketFrame(data: unknown): void {
		const log = this.#debugResponseLog;
		if (!log) return;
		if (typeof data === "string") {
			log.write(data);
			return;
		}
		if (data instanceof Uint8Array) {
			log.write(data);
			return;
		}
		if (data instanceof ArrayBuffer) {
			log.write(new Uint8Array(data));
			return;
		}
		log.write(String(data));
	}

	#startHeartbeat(socket: Bun.WebSocket): void {
		this.#stopHeartbeat();
		const intervalMs = getCodexWebSocketPingIntervalMs();
		if (intervalMs <= 0) return;

		this.#lastPingAt = 0;
		const socketEventTarget = socket as EventTarget;
		const onPong = () => {
			// Pongs are inbound activity — refresh the reuse-health clock so a quiet
			// but ping-responsive socket stays trustworthy across requests.
			this.#lastInboundAt = Date.now();
		};
		if (
			typeof socketEventTarget.addEventListener === "function" &&
			typeof socketEventTarget.removeEventListener === "function"
		) {
			socketEventTarget.addEventListener("pong", onPong);
			this.#removePongListener = () => socketEventTarget.removeEventListener("pong", onPong);
		}

		this.#heartbeatInterval = setInterval(() => {
			if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) {
				this.#stopHeartbeat();
				return;
			}
			// Fail-closed on missing pongs even when no pong has ever been observed.
			// The previous `#observedPong &&` guard disabled the timeout entirely on
			// runtimes where Bun does not surface a `pong` event for our outgoing
			// pings (issue #1450) — letting truly dead sockets sail through the
			// pool until the per-request first-event / idle timeout (60–300 s)
			// finally fired. Instead, trigger on inbound silence: if we sent a
			// ping at least `pongTimeoutMs` ago and have received no traffic of
			// any kind (data frame or pong) since, the socket is unhealthy.
			const pongTimeoutMs = getCodexWebSocketPongTimeoutMs();
			if (
				pongTimeoutMs > 0 &&
				this.#lastPingAt > 0 &&
				this.#lastPingAt > this.#lastInboundAt &&
				Date.now() - this.#lastPingAt > pongTimeoutMs
			) {
				this.#failQueue(createCodexWebSocketTransportError("websocket pong timeout"), "pong-timeout");
				return;
			}
			if (typeof socket.ping !== "function") {
				this.#stopHeartbeat();
				return;
			}
			try {
				socket.ping();
				this.#lastPingAt = Date.now();
			} catch (error) {
				this.#failQueue(
					createCodexWebSocketTransportError(
						`websocket ping failed: ${error instanceof Error ? error.message : String(error)}`,
					),
					"ping-failed",
				);
			}
		}, intervalMs);
		this.#heartbeatInterval.unref();
	}

	#stopHeartbeat(): void {
		if (this.#heartbeatInterval) {
			clearInterval(this.#heartbeatInterval);
			this.#heartbeatInterval = undefined;
		}
		if (this.#removePongListener) {
			this.#removePongListener();
			this.#removePongListener = undefined;
		}
		this.#lastPingAt = 0;
	}

	#failQueue(error: Error, closeReason: string): void {
		logCodexDebug("codex websocket transport failure", { error: error.message, closeReason });
		this.#queue.length = 0;
		this.#queue.push(error);
		this.close(closeReason);
		this.#wakeWaiters();
	}

	/**
	 * Discard data frames from a previous request that remained in `#queue`
	 * after the consumer broke out on the terminal event. Preserves any queued
	 * transport error (from `onerror` / `onclose` / `#failQueue`) so the next
	 * `#nextMessage` surfaces the death signal instead of waiting it out.
	 *
	 * Returns the number of frames dropped (test/debug visibility only).
	 */
	#dropStaleFrames(): number {
		if (this.#queue.length === 0) return 0;
		const surviving = this.#queue.filter(item => item instanceof Error);
		const dropped = this.#queue.length - surviving.length;
		if (dropped === 0) return 0;
		this.#queue.length = 0;
		for (const item of surviving) this.#queue.push(item);
		logCodexDebug("codex websocket dropped stale frames before request", { dropped });
		return dropped;
	}

	#wakeWaiters(): void {
		for (;;) {
			const waiter = this.#waiters.shift();
			if (!waiter) break;
			waiter();
		}
	}

	#push(item: Record<string, unknown> | Error | null): void {
		if (item instanceof Error) {
			// Append after frames already received instead of wiping them: a queued
			// terminal event (e.g. `response.completed` followed by an eager server
			// close) must still reach the consumer rather than morph into a spurious
			// transport failure. `#dropStaleFrames` keeps errors across requests, so
			// the death signal still surfaces if the data frames go unconsumed.
			this.#queue.push(item);
			this.#wakeWaiters();
			return;
		}
		if (item !== null && this.#queue.length >= getCodexWebSocketMessageQueueCapacity()) {
			this.#failQueue(
				createCodexWebSocketTransportError(
					`websocket message queue exceeded ${getCodexWebSocketMessageQueueCapacity()} items`,
				),
				"queue-overflow",
			);
			return;
		}
		this.#queue.push(item);
		const waiter = this.#waiters.shift();
		if (waiter) waiter();
	}

	async #nextMessage(
		timeoutMs: number | undefined,
		timeoutReason: string,
	): Promise<Record<string, unknown> | Error | null> {
		while (this.#queue.length === 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.push(resolve);
			let timedOut = false;
			let timeout: NodeJS.Timeout | undefined;
			if (timeoutMs !== undefined && timeoutMs > 0) {
				timeout = setTimeout(() => {
					timedOut = true;
					const waiterIndex = this.#waiters.indexOf(resolve);
					if (waiterIndex >= 0) {
						this.#waiters.splice(waiterIndex, 1);
					}
					resolve();
				}, timeoutMs);
			}
			await promise;
			if (timeout) clearTimeout(timeout);
			if (timedOut && this.#queue.length === 0) {
				return createCodexWebSocketTransportError(timeoutReason);
			}
		}
		return this.#queue.shift() ?? null;
	}
}

async function getOrCreateCodexWebSocketConnection(
	state: CodexWebSocketSessionState,
	url: string,
	headers: Headers,
	signal?: AbortSignal,
): Promise<CodexWebSocketConnection> {
	const headerRecord = headersToRecord(headers);
	// Join an in-flight handshake instead of tearing it down: closing a
	// CONNECTING socket rejects the concurrent caller (prewarm racing the first
	// request) with a fatal "websocket closed before open", which would disable
	// websockets for the entire session.
	// Bounded re-join: a fresh handshake may have been started by yet another
	// caller while we awaited the previous one.
	for (let joinAttempt = 0; joinAttempt < 3; joinAttempt += 1) {
		const pending = state.connection;
		if (!pending || pending.isOpen() || !pending.isConnecting()) break;
		try {
			await pending.connect(signal);
		} catch {
			// The handshake owner surfaces its own failure; re-evaluate below
			// (state.connection may have been replaced or cleared).
		}
	}
	if (state.connection?.isOpen()) {
		if (!state.connection.matchesAuth(headerRecord)) {
			state.connection.close("token-refresh");
			resetCodexWebSocketAppendState(state);
		} else if (state.connection.isHealthyForReuse()) {
			logger.time("codexWs:reuseOpenSocket");
			return state.connection;
		} else {
			// Open in readyState but no inbound traffic recently — likely server-
			// evicted (issue #1450). Force a fresh handshake instead of writing
			// `response.create` into a half-open buffer and waiting out the
			// first-event timeout. Drop append state because the new socket
			// won't carry the prior `previous_response_id` context.
			logCodexDebug("codex websocket reuse rejected by health check", {});
			state.connection.close("stale-reuse");
			resetCodexWebSocketAppendState(state);
		}
	}
	state.connection?.close("reconnect");
	resetCodexWebSocketAppendState(state);
	logger.time("codexWs:newSocket");
	state.connection = new CodexWebSocketConnection(url, headerRecord, {
		onHandshakeHeaders: handshakeHeaders => {
			updateCodexSessionMetadataFromHeaders(state, handshakeHeaders);
		},
	});
	await state.connection.connect(signal);
	return state.connection;
}

async function openCodexSseEventStream(
	url: string,
	requestHeaders: Record<string, string> | undefined,
	accountId: string,
	apiKey: string,
	sessionId: string | undefined,
	body: RequestBody,
	state: CodexWebSocketSessionState | undefined,
	responsesLite: boolean,
	signal: AbortSignal | undefined,
	firstEventTimeoutMs: number | undefined,
	onSseEvent?: OpenAICodexResponsesOptions["onSseEvent"],
	fetchOverride?: FetchImpl,
): Promise<AsyncGenerator<Record<string, unknown>>> {
	const headers = createCodexHeaders(requestHeaders, accountId, apiKey, sessionId, "sse", state, responsesLite);
	logCodexDebug("codex request", {
		url,
		model: body.model,
		headers: redactHeaders(headers),
		sentTurnStateHeader: headers.has(X_CODEX_TURN_STATE_HEADER),
		sentModelsEtagHeader: headers.has(X_MODELS_ETAG_HEADER),
	});
	// `wrapCodexSseStream` arms a first-event watchdog only after this fetch
	// resolves (it wraps the SSE generator). With `timeout: false` disabling
	// Bun's native 300s ceiling, a stalled pre-response request needs its own
	// watchdog — combine the caller signal with a fresh
	// `AbortSignal.timeout(firstEventTimeoutMs)` so headers must arrive
	// within the configured budget (issue #2422).
	const preResponseWatchdog =
		firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0
			? AbortSignal.timeout(firstEventTimeoutMs)
			: undefined;
	const fetchSignal = preResponseWatchdog
		? signal
			? AbortSignal.any([signal, preResponseWatchdog])
			: preResponseWatchdog
		: signal;
	const response = await fetchWithRetry(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: fetchSignal,
		maxAttempts: CODEX_MAX_RETRIES + 1,
		defaultDelayMs: attempt => CODEX_RETRY_DELAY_MS * (attempt + 1),
		maxDelayMs: CODEX_RATE_LIMIT_BUDGET_MS,
		fetch: fetchOverride,
		timeout: false,
	});
	logCodexDebug("codex response", {
		url: response.url,
		status: response.status,
		statusText: response.statusText,
		contentType: response.headers.get("content-type") || null,
		cfRay: response.headers.get("cf-ray") || null,
	});
	if (!response.ok) {
		throw await CodexApiError.fromResponse(response);
	}
	updateCodexSessionMetadataFromHeaders(state, response.headers);
	if (!response.body) {
		throw new Error("No response body");
	}
	return readSseJson<Record<string, unknown>>(response.body, signal, event =>
		onSseEvent?.({ event: event.event, data: event.data, raw: [...event.raw] }, undefined),
	);
}

async function openCodexWebSocketEventStream(
	url: string,
	headers: Headers,
	request: Record<string, unknown>,
	state: CodexWebSocketSessionState,
	timeouts: CodexWebSocketRequestTimeouts,
	signal?: AbortSignal,
	onSseEvent?: (event: RawSseEvent) => void,
): Promise<AsyncGenerator<Record<string, unknown>>> {
	const connection = await getOrCreateCodexWebSocketConnection(state, url, headers, signal);
	return connection.streamRequest(request, timeouts, signal, onSseEvent);
}

function createCodexHeaders(
	initHeaders: Record<string, string> | undefined,
	accountId: string,
	accessToken: string,
	sessionId?: string,
	transport: CodexTransport = "sse",
	state?: CodexWebSocketSessionState,
	responsesLite = false,
): Headers {
	const headers = new Headers(initHeaders ?? {});
	headers.delete("x-api-key");
	headers.set("Authorization", `Bearer ${accessToken}`);
	headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
	const betaHeader =
		transport === "websocket"
			? OPENAI_HEADER_VALUES.BETA_RESPONSES_WEBSOCKETS_V2
			: OPENAI_HEADER_VALUES.BETA_RESPONSES;
	headers.delete(OPENAI_HEADERS.BETA);
	headers.delete("openai-beta");
	headers.set(OPENAI_HEADERS.BETA, betaHeader);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	headers.set("User-Agent", getCodexUserAgent());
	if (sessionId) {
		headers.set(OPENAI_HEADERS.CONVERSATION_ID, sessionId);
		headers.set(OPENAI_HEADERS.SESSION_ID, sessionId);
		headers.set("x-client-request-id", sessionId);
	} else {
		headers.delete(OPENAI_HEADERS.CONVERSATION_ID);
		headers.delete(OPENAI_HEADERS.SESSION_ID);
		headers.delete("x-client-request-id");
	}
	if (state?.turnState) {
		headers.set(X_CODEX_TURN_STATE_HEADER, state.turnState);
	} else {
		headers.delete(X_CODEX_TURN_STATE_HEADER);
	}
	if (state?.modelsEtag) {
		headers.set(X_MODELS_ETAG_HEADER, state.modelsEtag);
	} else {
		headers.delete(X_MODELS_ETAG_HEADER);
	}
	if (responsesLite) {
		headers.set(X_OPENAI_INTERNAL_CODEX_RESPONSES_LITE_HEADER, "true");
	} else {
		headers.delete(X_OPENAI_INTERNAL_CODEX_RESPONSES_LITE_HEADER);
	}
	if (transport === "sse") {
		headers.set("accept", "text/event-stream");
		headers.set("content-type", "application/json");
	} else {
		headers.delete("accept");
		headers.delete("content-type");
	}
	return headers;
}

function logCodexDebug(message: string, details?: Record<string, unknown>): void {
	if (!CODEX_DEBUG) return;
	logger.debug(`[codex] ${message}`, details ?? {});
}

function redactHeaders(headers: Headers): Record<string, string> {
	const redacted: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		const lower = key.toLowerCase();
		if (lower === "authorization") {
			redacted[key] = "Bearer [redacted]";
			continue;
		}
		if (
			lower.includes("account") ||
			lower.includes("session") ||
			lower.includes("conversation") ||
			lower === "x-client-request-id" ||
			lower === "cookie"
		) {
			redacted[key] = "[redacted]";
			continue;
		}
		redacted[key] = value;
	}
	return redacted;
}

function resolveCodexResponsesUrl(baseUrl: string | undefined): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function getAccountId(accessToken: string): string {
	const accountId = getCodexAccountId(accessToken);
	if (!accountId) {
		throw new Error("Failed to extract accountId from token");
	}
	return accountId;
}

function convertMessages(model: Model<"openai-codex-responses">, context: Context): ResponseInput {
	const messages: ResponseInput = [];

	const normalizeToolCallId = (id: string): string => {
		if (!id.includes("|")) return id;
		const [callId, itemId] = id.split("|");
		const sanitizedCallId = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
		let sanitizedItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, "_");
		if (!sanitizedItemId.startsWith("fc")) {
			sanitizedItemId = `fc_${sanitizedItemId}`;
		}
		let normalizedCallId = sanitizedCallId.length > 64 ? sanitizedCallId.slice(0, 64) : sanitizedCallId;
		let normalizedItemId = sanitizedItemId.length > 64 ? sanitizedItemId.slice(0, 64) : sanitizedItemId;
		normalizedCallId = normalizedCallId.replace(/_+$/, "");
		normalizedItemId = normalizedItemId.replace(/_+$/, "");
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	let msgIndex = 0;
	// Track call_ids that originated as custom tool calls so paired tool-result
	// messages can be replayed as `custom_tool_call_output` rather than
	// `function_call_output` (OpenAI rejects mismatched pairs).
	const customCallIds = new Set<string>();
	const knownCallIds = new Set<string>();

	for (const msg of transformedMessages) {
		if (msg.role === "user" || msg.role === "developer") {
			const providerPayload = (msg as { providerPayload?: AssistantMessage["providerPayload"] }).providerPayload;
			const historyItems = getOpenAIResponsesHistoryItems(providerPayload, model.provider) as
				| Array<ResponseInput[number]>
				| undefined;
			if (historyItems) {
				for (const item of historyItems) {
					const maybe = item as { type?: string; call_id?: string };
					if (maybe.type === "custom_tool_call" && typeof maybe.call_id === "string") {
						customCallIds.add(maybe.call_id);
					}
				}
				messages.push(...historyItems);
				msgIndex += 1;
				continue;
			}

			const normalizedContent = normalizeInputMessageContent(model, msg.content);
			if (normalizedContent.length === 0) continue;
			messages.push({ role: msg.role, content: normalizedContent });
			msgIndex += 1;
			continue;
		}

		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			// Native items are model-bound (reasoning carries encrypted content
			// minted by the producing model); after a mid-session model switch fall
			// back to block re-encode, which strips foreign signatures.
			const providerPayload =
				assistantMsg.api === model.api && assistantMsg.model === model.id
					? getOpenAIResponsesHistoryPayload(assistantMsg.providerPayload, model.provider, assistantMsg.provider)
					: undefined;
			const historyItems = providerPayload?.items as Array<ResponseInput[number]> | undefined;
			if (historyItems) {
				for (const item of historyItems) {
					const maybe = item as { type?: string; call_id?: string };
					if (maybe.type === "custom_tool_call" && typeof maybe.call_id === "string") {
						customCallIds.add(maybe.call_id);
					}
				}
				if (providerPayload?.dt) {
					messages.push(...historyItems);
				} else {
					messages.splice(0, messages.length, ...historyItems);
					// Keep customCallIds from the pre-splice state since historyItems may re-introduce them.
				}
				msgIndex += 1;
				continue;
			}

			const outputItems = convertResponsesAssistantMessage(
				msg as AssistantMessage,
				model,
				msgIndex,
				knownCallIds,
				true,
				customCallIds,
			);
			if (outputItems.length > 0) {
				messages.push(...outputItems);
			}
			msgIndex += 1;
			continue;
		}

		if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(messages, msg, model, false, knownCallIds, customCallIds);
		}

		msgIndex += 1;
	}

	return messages;
}

function normalizeInputMessageContent(
	model: Model<"openai-codex-responses">,
	content: string | Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>,
): ResponseInputContent[] {
	if (typeof content === "string") {
		if (!content || content.trim() === "") return [];
		return [{ type: "input_text", text: content.toWellFormed() }];
	}

	return convertResponsesInputContent(content, model.input.includes("image")) ?? [];
}

/** @internal Exported for tests. */
export { convertMessages as convertCodexResponsesMessages };

/**
 * Whether this Codex-backend model should get the custom-tool grammar
 * variant for `apply_patch`. codex-rs uses a single serializer for both
 * the public Responses endpoint and `chatgpt.com/backend-api`, so the
 * backend already accepts `{type: "custom"}` tools in production. The
 * generated model catalog sets `applyPatchToolType` for first-party GPT-5
 * Codex models; this runtime path only consumes that metadata.
 */
function supportsFreeformApplyPatchCodex(model: Model<"openai-codex-responses">): boolean {
	return model.applyPatchToolType === "freeform";
}

type CodexToolPayload =
	| {
			type: "function";
			name: string;
			description: string;
			parameters: Record<string, unknown>;
			strict?: boolean;
	  }
	| {
			type: "custom";
			name: string;
			description: string;
			format: { type: "grammar"; syntax: "lark" | "regex"; definition: string };
	  };

/** @internal Exported for tests. */
export function convertOpenAICodexResponsesTools(
	tools: Tool[],
	model: Model<"openai-codex-responses">,
): CodexToolPayload[] {
	const allowFreeform = supportsFreeformApplyPatchCodex(model);
	return tools.map((tool): CodexToolPayload => {
		if (allowFreeform && tool.customFormat) {
			return {
				type: "custom",
				name: tool.customWireName ?? tool.name,
				description: tool.description || "",
				format: {
					type: "grammar",
					syntax: tool.customFormat.syntax,
					definition: compactGrammarDefinition(tool.customFormat.syntax, tool.customFormat.definition),
				},
			};
		}
		const strict = !!(!NO_STRICT && tool.strict);
		const baseParameters = sanitizeSchemaForOpenAIResponses(toolWireSchema(tool));
		const { schema: parameters, strict: effectiveStrict } = adaptSchemaForStrict(baseParameters, strict);
		return {
			type: "function",
			name: tool.name,
			description: tool.description || "",
			parameters,
			...(effectiveStrict && { strict: true }),
		};
	});
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

class CodexWhitespaceToolCallLoopError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexWhitespaceToolCallLoopError";
	}
}

class CodexProviderStreamError extends Error {
	readonly retryable: boolean;
	readonly code?: string;

	constructor(message: string, retryable: boolean, code?: string) {
		super(message);
		this.name = "CodexProviderStreamError";
		this.retryable = retryable;
		this.code = code;
	}
}

function isRetryableCodexFailureEvent(rawEvent: Record<string, unknown>): boolean {
	const response = asRecord(rawEvent.response);
	const error = asRecord(rawEvent.error) ?? (response ? asRecord(response.error) : null);
	const code = getString(error?.code) ?? getString(error?.type) ?? getString(rawEvent.code);
	if (code && CODEX_RETRYABLE_EVENT_CODES.has(code.toLowerCase())) {
		return true;
	}
	const message = getString(error?.message) ?? getString(rawEvent.message) ?? getString(response?.message);
	return !!message && CODEX_RETRYABLE_EVENT_MESSAGE.test(message);
}

function createCodexProviderStreamError(rawEvent: Record<string, unknown>): CodexProviderStreamError {
	const response = asRecord(rawEvent.response);
	const nestedError = asRecord(rawEvent.error) ?? (response ? asRecord(response.error) : null);
	const code = getString(rawEvent.code) ?? getString(nestedError?.code) ?? getString(nestedError?.type) ?? "";
	const message = getString(rawEvent.message) ?? "";
	const formattedMessage =
		typeof rawEvent.type === "string" && rawEvent.type === "error"
			? formatCodexErrorEvent(rawEvent, code, message)
			: (formatCodexFailure(rawEvent) ?? "Codex response failed");
	return new CodexProviderStreamError(formattedMessage, isRetryableCodexFailureEvent(rawEvent), code || undefined);
}

function isRetryableCodexProviderError(error: unknown): boolean {
	return error instanceof CodexProviderStreamError && error.retryable;
}

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}…[truncated ${text.length - limit}]`;
}

function formatCodexFailure(rawEvent: Record<string, unknown>): string | null {
	const response = asRecord(rawEvent.response);
	const error = asRecord(rawEvent.error) ?? (response ? asRecord(response.error) : null);
	const message = getString(error?.message) ?? getString(rawEvent.message) ?? getString(response?.message);
	const code = getString(error?.code) ?? getString(error?.type) ?? getString(rawEvent.code);
	const status = getString(response?.status) ?? getString(rawEvent.status);

	const meta: string[] = [];
	if (code) meta.push(`code=${code}`);
	if (status) meta.push(`status=${status}`);

	if (message) {
		const metaText = meta.length ? ` (${meta.join(", ")})` : "";
		return `Codex response failed: ${message}${metaText}`;
	}
	if (meta.length) {
		return `Codex response failed (${meta.join(", ")})`;
	}
	try {
		return `Codex response failed: ${truncate(JSON.stringify(rawEvent), 800)}`;
	} catch {
		return "Codex response failed";
	}
}

function formatCodexErrorEvent(rawEvent: Record<string, unknown>, code: string, message: string): string {
	const detail = formatCodexFailure(rawEvent);
	if (detail) {
		return detail.replace("response failed", "error event");
	}
	const meta: string[] = [];
	if (code) meta.push(`code=${code}`);
	if (message) meta.push(`message=${message}`);
	if (meta.length > 0) {
		return `Codex error event (${meta.join(", ")})`;
	}
	try {
		return `Codex error event: ${truncate(JSON.stringify(rawEvent), 800)}`;
	} catch {
		return "Codex error event";
	}
}
