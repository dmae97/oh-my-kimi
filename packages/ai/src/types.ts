export * from "@oh-my-pi/pi-catalog/effort";
export * from "@oh-my-pi/pi-catalog/types";

import type {
	DeleteArgs,
	DeleteResult,
	DiagnosticsArgs,
	DiagnosticsResult,
	GrepArgs,
	GrepResult,
	LsArgs,
	LsResult,
	McpResult,
	ReadArgs,
	ReadResult,
	ShellArgs,
	ShellResult,
	WriteArgs,
	WriteResult,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Api, FetchImpl, KnownApi, Model, Provider, ThinkingBudgets, Usage } from "@oh-my-pi/pi-catalog/types";
import type { Type } from "arktype";
import type { ZodType, z } from "zod/v4";
import type { ApiKey } from "./auth-retry";
import type { BedrockOptions } from "./providers/amazon-bedrock";
import type { AnthropicOptions } from "./providers/anthropic";
import type { StopDetails } from "./providers/anthropic-wire";
import type { AzureOpenAIResponsesOptions } from "./providers/azure-openai-responses";
import type { CursorOptions } from "./providers/cursor";
import type { DevinOptions } from "./providers/devin";
import type { GitLabDuoWorkflowOptions } from "./providers/gitlab-duo-workflow";
import type { GoogleOptions } from "./providers/google";
import type { GoogleGeminiCliOptions } from "./providers/google-gemini-cli";
import type { GoogleVertexOptions } from "./providers/google-vertex";
import type { OllamaChatOptions } from "./providers/ollama";
import type { OpenAICodexResponsesOptions } from "./providers/openai-codex-responses";
import type { OpenAICompletionsOptions } from "./providers/openai-completions";
import type { OpenAIResponsesOptions } from "./providers/openai-responses";
import type { kStreamingPartialJson } from "./utils/block-symbols";
import type { AssistantMessageEventStream } from "./utils/event-stream";

export type { StopDetails } from "./providers/anthropic-wire";
export type { AssistantMessageEventStream } from "./utils/event-stream";

/**
 * Ceiling on the output-token count omp requests from any OpenAI-family endpoint
 * (openai-responses, azure/xai responses, and openai-completions). Mirrors
 * Anthropic's {@link CLAUDE_CODE_MAX_OUTPUT_TOKENS}.
 *
 * Catalog `maxTokens` frequently reflects a model's context window rather than a
 * given upstream's real per-request output cap. OpenRouter, for instance,
 * advertises 131072 output tokens for `z-ai/glm-4.7`, but the Cerebras upstream
 * only allows ~131072 tokens total — so requesting the full ceiling overflows
 * with a 400. Requested output is clamped to this value (and to `model.maxTokens`).
 */
export const OPENAI_MAX_OUTPUT_TOKENS = 64000;

export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"bedrock-converse-stream": BedrockOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	openrouter: OpenAIResponsesOptions | OpenAICompletionsOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-gemini-cli": GoogleGeminiCliOptions;
	"google-vertex": GoogleVertexOptions;
	"ollama-chat": OllamaChatOptions;
	"cursor-agent": CursorOptions;
	"gitlab-duo-agent": GitLabDuoWorkflowOptions;
	"devin-agent": DevinOptions;
}
// Compile-time exhaustiveness check - this will fail if ApiOptionsMap doesn't have all KnownApi keys
type _CheckExhaustive =
	ApiOptionsMap extends Record<KnownApi, StreamOptions>
		? Record<KnownApi, StreamOptions> extends ApiOptionsMap
			? true
			: ["ApiOptionsMap is missing some KnownApi values", Exclude<KnownApi, keyof ApiOptionsMap>]
		: ["ApiOptionsMap doesn't extend Record<KnownApi, StreamOptions>"];
true satisfies _CheckExhaustive;
export type OptionsForApi<TApi extends Api> =
	| StreamOptions
	| (TApi extends keyof ApiOptionsMap ? ApiOptionsMap[TApi] : never);

export interface TokenTaskBudget {
	type: "tokens";
	total: number;
	remaining?: number;
}

export type MessageAttribution = "user" | "agent";

export type ToolChoice =
	| "auto"
	| "none"
	| "any"
	| "required"
	| { type: "function"; name: string }
	| { type: "function"; function: { name: string } }
	| { type: "tool"; name: string };

// Base options all providers share
export type CacheRetention = "none" | "short" | "long";

/**
 * Service tier hint for processing priority / cost control. These are the
 * values providers consume on the wire:
 *
 * - OpenAI / OpenAI-Codex: sent verbatim as the `service_tier` field
 *   (`flex`/`scale`/`priority`).
 * - Google (Gemini API + Vertex AI): sent as the top-level `serviceTier`
 *   field (`flex`/`priority`).
 * - OpenRouter: passed through as `service_tier`; OpenRouter realizes it for
 *   the OpenAI- and Google-family upstreams it supports and ignores it
 *   otherwise.
 * - Direct Anthropic: `"priority"` is translated into `speed: "fast"` plus the
 *   fast-mode beta on supported Opus models. Other tiers are ignored.
 *
 * Per-family scoping is expressed by {@link ServiceTierByFamily}, not by
 * scoped sentinel values — see {@link serviceTierFamily}.
 */
export type ServiceTier = "auto" | "default" | "flex" | "scale" | "priority";

/** Provider families that expose an independent service-tier knob. */
export type ServiceTierFamily = "openai" | "anthropic" | "google";

/**
 * Per-family service-tier selection. A request consults only the entry for the
 * family its model belongs to (see {@link resolveModelServiceTier}), so a user
 * can opt one family into priority without affecting the others when switching
 * models mid-session.
 */
export type ServiceTierByFamily = Partial<Record<ServiceTierFamily, ServiceTier>>;

/**
 * Classify a model into the service-tier family whose knob governs it, or
 * `undefined` when the model exposes no serving-priority control.
 *
 * OpenRouter models are classified by id namespace (`anthropic/`, `google/`,
 * `openai/`); Claude on Bedrock/Vertex (api `anthropic-messages`) is the
 * anthropic family even though its provider is `amazon-bedrock`/`google-vertex`.
 */
export function serviceTierFamily(model: Pick<Model, "provider" | "api" | "id">): ServiceTierFamily | undefined {
	const provider = model.provider;
	if (provider === "openrouter") {
		const id = model.id.toLowerCase();
		if (id.startsWith("anthropic/")) return "anthropic";
		if (id.startsWith("google/")) return "google";
		if (id.startsWith("openai/")) return "openai";
		return undefined;
	}
	if (provider === "openai" || provider === "openai-codex") return "openai";
	if (model.api === "anthropic-messages") return "anthropic";
	if (provider === "google" || provider === "google-vertex") return "google";
	return undefined;
}

/**
 * Reduce a per-family tier map to the single wire tier for `model` — the entry
 * for the model's family, or `undefined` when the model has no family.
 */
export function resolveModelServiceTier(
	tiers: ServiceTierByFamily | null | undefined,
	model: Pick<Model, "provider" | "api" | "id">,
): ServiceTier | undefined {
	if (!tiers) return undefined;
	const family = serviceTierFamily(model);
	return family ? tiers[family] : undefined;
}

/**
 * True when the tier should be sent on the wire as the provider's service-tier
 * request field. OpenAI / OpenAI-Codex accept `flex`/`scale`/`priority`; Google
 * (Gemini API + Vertex) and OpenRouter accept `flex`/`priority`; Fireworks
 * Serverless realizes only its Priority serving path. Anthropic is absent — it
 * realizes `priority` via `speed: "fast"`, not a service-tier field.
 */
export function shouldSendServiceTier(
	serviceTier: ServiceTier | null | undefined,
	provider: Provider | undefined,
): boolean {
	if (!serviceTier) return false;
	if (provider === "openai" || provider === "openai-codex" || provider === "openrouter") {
		return serviceTier === "flex" || serviceTier === "scale" || serviceTier === "priority";
	}
	if (provider === "google") {
		return serviceTier === "flex" || serviceTier === "priority";
	}
	// Vertex realizes only priority (via header); flex has no documented control.
	if (provider === "google-vertex" || provider === "fireworks") {
		return serviceTier === "priority";
	}
	return false;
}

/**
 * True when `priority` will actually be realized on the wire for `model`.
 * Direct Anthropic realizes fast mode; OpenAI/Google/Fireworks emit the
 * service-tier field; OpenRouter realizes it only for its OpenAI- and
 * Google-family upstreams. Bedrock/Vertex Claude and OpenRouter Anthropic
 * models do not realize priority and return `false`.
 */
export function realizesPriorityServiceTier(
	serviceTier: ServiceTier | null | undefined,
	model: Pick<Model, "provider" | "api" | "id">,
): boolean {
	if (serviceTier !== "priority") return false;
	if (model.provider === "anthropic") return true;
	if (model.provider === "openrouter") {
		const family = serviceTierFamily(model);
		return family === "openai" || family === "google";
	}
	if (model.api === "anthropic-messages") return false;
	return shouldSendServiceTier(serviceTier, model.provider);
}

/**
 * Premium-request weight contributed by a priority request to a provider that
 * realizes it and bills extra. Mirrors GitHub Copilot's `premiumRequests`
 * accounting so the "premium requests" stat aggregates priority traffic across
 * the OpenAI family, direct Anthropic fast mode, and Google priority.
 *
 * Returns 1 only when priority is actually realized on the wire for `model`
 * (see {@link realizesPriorityServiceTier}) and the provider bills it as a
 * premium request. OpenRouter is excluded — it bills per its own pricing, not
 * Copilot-premium semantics — as are Bedrock/Vertex Claude, where priority is
 * silently dropped.
 */
export function getPriorityPremiumRequests(
	serviceTier: ServiceTier | null | undefined,
	model: Pick<Model, "provider" | "api" | "id">,
): number {
	if (!realizesPriorityServiceTier(serviceTier, model)) return 0;
	const provider = model.provider;
	return provider === "openai" ||
		provider === "openai-codex" ||
		provider === "anthropic" ||
		provider === "google" ||
		provider === "google-vertex"
		? 1
		: 0;
}

/**
 * Coerce a persisted service-tier value to a {@link ServiceTierByFamily}. Newer
 * sessions store the family map directly; legacy sessions stored a single
 * scalar — `"priority"` applied everywhere, `"openai-only"`/`"claude-only"`
 * scoped to one family, and the remaining values were OpenAI-only semantics.
 */
export function coerceServiceTierByFamily(value: unknown): ServiceTierByFamily | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value === "object") {
		const src = value as Record<string, unknown>;
		const out: ServiceTierByFamily = {};
		for (const family of ["openai", "anthropic", "google"] as const) {
			const tier = src[family];
			if (tier === "auto" || tier === "default" || tier === "flex" || tier === "scale" || tier === "priority") {
				out[family] = tier;
			}
		}
		return Object.keys(out).length > 0 ? out : undefined;
	}
	switch (value) {
		case "priority":
			return { openai: "priority", anthropic: "priority", google: "priority" };
		case "openai-only":
			return { openai: "priority" };
		case "claude-only":
			return { anthropic: "priority" };
		case "auto":
			return { openai: "auto" };
		case "default":
			return { openai: "default" };
		case "flex":
			return { openai: "flex" };
		case "scale":
			return { openai: "scale" };
		default:
			return undefined;
	}
}

export interface ProviderSessionState {
	close(): void;
}

export interface ProviderResponseMetadata {
	status: number;
	headers: Record<string, string>;
	requestId?: string | null;
	metadata?: Record<string, unknown>;
}

export interface RawSseEvent {
	event: string | null;
	data: string;
	raw: string[];
}

export interface StreamOptions {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
	/**
	 * Stop sequences. Anthropic encodes as `stop_sequences` (array, max 4);
	 * OpenAI chat-completions encodes as `stop` (string or array of up to 4);
	 * OpenAI Responses API has no `stop` field today (silently dropped by the
	 * provider when present).
	 */
	stopSequences?: string[];
	/**
	 * Frequency penalty (OpenAI). Penalizes new tokens based on existing frequency
	 * in the text so far. Range -2.0 to 2.0. Parallel to {@link presencePenalty}.
	 */
	frequencyPenalty?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	cacheRetention?: CacheRetention;
	/**
	 * Additional headers to include in provider requests.
	 * These are merged on top of model-defined headers.
	 */
	headers?: Record<string, string>;
	/**
	 * Optional explicit request attribution override for providers that support it.
	 */
	initiatorOverride?: MessageAttribution;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
	 */
	metadata?: Record<string, unknown>;
	/**
	 * Config options for the thinking/response loop guard.
	 */
	loopGuard?: {
		enabled?: boolean;
		checkAssistantContent?: boolean;
	};
	/**
	 * Advisory token budget for a full agentic loop. Anthropic encodes this as
	 * `output_config.task_budget` with the `task-budgets-2026-03-13` beta header.
	 */
	taskBudget?: TokenTaskBudget;
	/**
	 * Optional session identifier for providers that support session-based
	 * routing, request affinity, or transport reuse. Providers may also use this
	 * as the prompt-cache key when `promptCacheKey` is not set.
	 */
	sessionId?: string;
	/**
	 * Optional prompt-cache identity. When set, OpenAI Responses-compatible
	 * providers use this for `prompt_cache_key` while keeping `sessionId` for
	 * provider routing / conversation headers.
	 */
	promptCacheKey?: string;
	/**
	 * Provider-scoped mutable state store for this agent session.
	 * Providers can use this to persist transport/session state between turns.
	 */
	providerSessionState?: Map<string, ProviderSessionState>;
	/**
	 * Optional per-provider concurrent request cap for LLM stream calls. Keys are
	 * provider ids (`model.provider`); positive numeric values cap in-flight
	 * requests across local OMP processes that share the same config root. Omitted
	 * providers are unlimited. Non-chat provider APIs that bypass stream helpers
	 * are not covered.
	 */
	maxInFlightRequests?: Record<string, number>;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	onPayload?: (payload: unknown, model?: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback for provider response metadata after headers are received.
	 */
	onResponse?: (response: ProviderResponseMetadata, model?: Model<Api>) => void | Promise<void>;
	/**
	 * Optional callback for raw Server-Sent Events as they arrive from HTTP streaming providers,
	 * plus synthesized SSE-shaped frames for the Codex WebSocket transport (one synthetic frame
	 * per JSON request/response message). WebSocket frames are tagged with a leading
	 * `: ws → <type>` (outbound) or `: ws ← <type>` (inbound) comment line in `RawSseEvent.raw`.
	 *
	 * Diagnostic only: provider implementations must ignore callback failures and must not
	 * let observers alter stream contents.
	 */
	onSseEvent?: (event: RawSseEvent, model?: Model<Api>) => void;
	/**
	 * Optional override for the first-event watchdog in milliseconds. Built-in
	 * providers apply this budget twice when they can: once to the underlying
	 * SDK/request while waiting for the HTTP stream object to exist, then again
	 * in the iterator while waiting for the first semantic stream event. Set to
	 * `0` to disable both layers for this request. After the first semantic
	 * event arrives, `streamIdleTimeoutMs` governs inter-event stalls. Falls
	 * back to `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` and then to a 100s default.
	 * OpenAI-family transports additionally honor
	 * `PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS` as the most-specific override and
	 * floor the first-event budget at the resolved idle (per-call
	 * `streamIdleTimeoutMs` or `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS`) so slow local
	 * OpenAI-compatible servers are not undercut during prompt processing.
	 *
	 * Iterator-level honored by: every built-in provider (via the lazy-stream
	 * forwarder in `register-builtins`). SDK-request honored by:
	 * `openai-completions`, `openai-responses`, `azure-openai-responses`,
	 * `anthropic-messages`.
	 */
	streamFirstEventTimeoutMs?: number;
	/**
	 * Optional override for the maximum idle gap between streamed events in
	 * milliseconds. Once the first event arrives, this guards against silent
	 * mid-stream stalls (broker dies, half-open socket, model produces no real
	 * progress for too long). Set to `0` to disable. Falls back to
	 * `PI_STREAM_IDLE_TIMEOUT_MS` (alias: `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS`)
	 * and then to a 120s default.
	 */
	streamIdleTimeoutMs?: number;
	/**
	 * Optional retry delay hook for tests and transports that need custom scheduling.
	 */
	providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	/**
	 * Optional `fetch` implementation override. Providers route every HTTP
	 * request — direct calls, SDK clients, and retry helpers — through this
	 * implementation when set. Defaults to `globalThis.fetch`. Providers that
	 * do not use `fetch` (Bedrock's AWS SDK transport, Cursor's HTTP/2
	 * channel) silently ignore the override.
	 */
	fetch?: FetchImpl;
	/** Current session working directory for providers that need workspace-scoped discovery. */
	cwd?: string;

	/** Cursor exec/MCP tool handlers (cursor-agent only). */
	execHandlers?: CursorExecHandlers;
}

// Unified options with reasoning passed to streamSimple() and completeSimple()
export interface SimpleStreamOptions extends Omit<StreamOptions, "apiKey"> {
	/**
	 * API key for the request: either a static bearer string, or an
	 * {@link ApiKeyResolver} that mints/rotates the key across the central
	 * a/b/c auth-retry policy. `streamSimple`/`completeSimple` resolve a
	 * resolver to a string before per-provider dispatch, so providers only
	 * ever see the resolved {@link StreamOptions.apiKey} string.
	 */
	apiKey?: ApiKey;
	reasoning?: Effort;
	/**
	 * Force-disable reasoning for the request even when the model supports it.
	 * Takes precedence over `reasoning`. Useful for fast utility calls
	 * (e.g. title generation) where the model would otherwise burn the entire
	 * output budget on internal thinking. Provider support is format-specific:
	 * some transports can disable reasoning directly, while generic
	 * effort-based OpenAI-compatible endpoints use the lowest supported effort.
	 */
	disableReasoning?: boolean;
	/**
	 * If true, request that the provider omit thinking/reasoning summaries
	 * from the response (e.g. Anthropic `thinking.display = "omitted"`,
	 * OpenAI Responses `reasoning.summary` left unset). The model still
	 * reasons internally; only the human-readable summary stream is dropped.
	 * Useful when the UI hides thinking blocks anyway and the summary is wasted bandwidth.
	 */
	hideThinkingSummary?: boolean;
	/** OpenAI Responses/Codex `text.verbosity` response detail level. */
	textVerbosity?: "low" | "medium" | "high";
	/** Custom token budgets for thinking levels (token-based providers only) */
	thinkingBudgets?: ThinkingBudgets;
	/** Cursor exec handlers for local tool execution */
	cursorExecHandlers?: CursorExecHandlers;
	/** Hook to handle tool results from Cursor exec */
	cursorOnToolResult?: CursorToolResultHandler;
	/** Optional tool choice override for compatible providers */
	toolChoice?: ToolChoice;
	/** OpenAI service tier for processing priority/cost control. Ignored by non-OpenAI providers. */
	serviceTier?: ServiceTier;
	/** API format for Kimi Code provider: "openai" or "anthropic" (default: "anthropic") */
	kimiApiFormat?: "openai" | "anthropic";
	/** API format for Synthetic provider: "openai" or "anthropic" (default: "openai") */
	syntheticApiFormat?: "openai" | "anthropic";
	/** Hint that websocket transport should be preferred when supported by the provider implementation. */
	preferWebsockets?: boolean;
	/**
	 * OpenRouter routing-variant suffix automatically appended to model IDs when
	 * the request targets OpenRouter (`model.provider === "openrouter"`). Common
	 * values: `"nitro"` (throughput), `"floor"` (cheapest), `"online"` (web
	 * search plugin), `"exacto"` (cherry-picked high-quality providers, only
	 * defined for some models). Ignored when the resolved model id already
	 * contains a `:<variant>` suffix (e.g. the user typed `:nitro` explicitly
	 * or the catalog entry already names the variant).
	 */
	openrouterVariant?: string;
	/** Antigravity endpoint routing mode: "auto" (default with failover), "production", "sandbox". */
	antigravityEndpointMode?: "auto" | "production" | "sandbox";
}

// Generic StreamFunction with typed options
export type StreamFunction<TApi extends Api> = (
	model: Model<TApi>,
	context: Context,
	options: OptionsForApi<TApi>,
) => AssistantMessageEventStream;

export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string; // e.g., for OpenAI responses, message metadata (legacy id string or TextSignatureV1 JSON)
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // e.g., for OpenAI responses, the reasoning item ID
	itemId?: string; // item.id from output_item.added, used to match output_item.done
}

export interface RedactedThinkingContent {
	type: "redactedThinking";
	data: string;
}

export interface ImageContent {
	type: "image";
	data: string; // base64 encoded image data
	mimeType: string; // e.g., "image/jpeg", "image/png"
	/**
	 * OpenAI-only resolution hint. `"original"` preserves native resolution
	 * (required for snapcompact frames, whose glyphs do not survive the
	 * default `auto` downscale). Providers without a detail knob ignore it.
	 */
	detail?: "auto" | "low" | "high" | "original";
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	[kStreamingPartialJson]?: string;
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
	intent?: string; // Harness-level intent metadata extracted from traced tool arguments
	/**
	 * Verbatim in-band syntax block that produced this synthetic `ptc_*` call.
	 * Present only for owned prompt/tool-call formats; provider-native calls omit it.
	 */
	rawBlock?: string;
	/**
	 * Original wire-level name when the tool was invoked via OpenAI's custom-tool
	 * mechanism (e.g., `apply_patch`). Set by `openai-responses` on receive so
	 * the history-replay path can re-emit the call as `custom_tool_call` with
	 * its paired tool-result as `custom_tool_call_output`. Absent for regular
	 * JSON function tools.
	 */
	customWireName?: string;
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface OpenAIResponsesHistoryPayload {
	type: "openaiResponsesHistory";
	provider?: string;
	dt?: boolean;
	items: Array<Record<string, unknown>>;
}

export type ProviderPayload = OpenAIResponsesHistoryPayload;

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** True if the message was injected by the system (e.g., auto-continue). */
	synthetic?: boolean;
	/** True when injected mid-turn as a steer; consumed by the agent's pre-LLM transform to wrap it for emphasis. Never rendered. */
	steering?: boolean;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface DeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface ContextSnapshot {
	promptTokens: number; // authoritative provider prompt/input tokens
	nonMessageTokens: number; // estimated non-message total at send time
	lastMessageTimestamp?: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | RedactedThinkingContent | ToolCall)[];
	api: Api;
	provider: Provider;
	model: string;
	contextSnapshot?: ContextSnapshot;
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	/**
	 * Name of the upstream provider an aggregator routed this request to, as
	 * reported in the response (e.g. OpenRouter's top-level `provider` field:
	 * `"OpenAI"`, `"Anthropic"`, `"Together"`). Distinct from `provider`, which
	 * is the configured gateway we called (`"openrouter"`). Undefined for direct
	 * providers that expose no such field.
	 */
	upstreamProvider?: string;
	usage: Usage;
	stopReason: StopReason;
	stopDetails?: StopDetails | null;
	errorMessage?: string;
	/** HTTP status surfaced by the provider when the request failed. Populated by every provider's catch block alongside `errorMessage` so consumers (auth retry, telemetry, UI) can branch without regex-scraping the message. */
	errorStatus?: number;
	/** Structured machine-readable error classifier; see `utils/error-id.ts` for bit layout and helpers. */
	errorId?: number;
	/**
	 * Stable identifiers for request features the provider silently dropped
	 * during this turn (e.g. `"priority"`). Set when a server-side rejection
	 * triggered an in-provider fallback retry that succeeded without the
	 * feature. Callers can use this to sync user-facing toggles back to the
	 * server's actual state.
	 */
	disabledFeatures?: string[];
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
	duration?: number; // Request duration in milliseconds
	ttft?: number; // Time to first token in milliseconds
}

export interface ToolResultMessage<TDetails = unknown> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // Supports text and images
	details?: TDetails;
	isError: boolean;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Timestamp when output was pruned (ms since epoch). Undefined if unpruned. */
	prunedAt?: number;
	/**
	 * Tool-declared: this result carried no information worth retaining once
	 * consumed (zero matches, elapsed wait). Compaction passes may elide it.
	 * Never set together with isError.
	 */
	useless?: boolean;
	timestamp: number; // Unix timestamp in milliseconds
}

export type Message = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;

export type CursorExecHandlerResult<T> = { result: T; toolResult?: ToolResultMessage } | T | ToolResultMessage;

export type CursorToolResultHandler = (
	result: ToolResultMessage,
) => ToolResultMessage | undefined | Promise<ToolResultMessage | undefined>;

export interface CursorMcpCall {
	name: string;
	providerIdentifier: string;
	toolName: string;
	toolCallId: string;
	args: Record<string, unknown>;
	rawArgs: Record<string, Uint8Array>;
}

export interface CursorShellStreamCallbacks {
	onStdout(data: string): void;
	onStderr(data: string): void;
}

export interface CursorExecHandlers {
	read?: (args: ReadArgs) => Promise<CursorExecHandlerResult<ReadResult>>;
	ls?: (args: LsArgs) => Promise<CursorExecHandlerResult<LsResult>>;
	grep?: (args: GrepArgs) => Promise<CursorExecHandlerResult<GrepResult>>;
	write?: (args: WriteArgs) => Promise<CursorExecHandlerResult<WriteResult>>;
	delete?: (args: DeleteArgs) => Promise<CursorExecHandlerResult<DeleteResult>>;
	shell?: (args: ShellArgs) => Promise<CursorExecHandlerResult<ShellResult>>;
	shellStream?: (
		args: ShellArgs,
		callbacks: CursorShellStreamCallbacks,
	) => Promise<CursorExecHandlerResult<ShellResult>>;
	diagnostics?: (args: DiagnosticsArgs) => Promise<CursorExecHandlerResult<DiagnosticsResult>>;
	mcp?: (call: CursorMcpCall) => Promise<CursorExecHandlerResult<McpResult>>;
	onToolResult?: CursorToolResultHandler;
}

/**
 * Plain JSON Schema document used by extension-authored tools (legacy TypeBox
 * emits this shape). Distinguished from arktype at runtime.
 */
export type TJsonSchema = Record<string, unknown>;

/**
 * Schema type accepted by the {@link Tool} interface.
 *
 * Canonical authoring uses Zod or ArkType. Extension compat may supply a JSON
 * Schema object (including TypeBox static schema objects).
 */
export type TSchema = ZodType | Type | TJsonSchema;

/** Resolve parameter types for tool execution / handlers. */
export type Static<S> = S extends ZodType
	? z.infer<S>
	: S extends Type
		? S["infer"]
		: S extends { static: infer T }
			? T
			: unknown;

export interface ToolCallExample<TArgs = Record<string, unknown>> {
	caption?: string;
	call: TArgs;
}
export interface ToolCompareExample<TArgs = Record<string, unknown>> {
	caption?: string;
	bad: TArgs;
	good: TArgs;
}
export interface ToolNoteExample {
	caption: string;
	note?: string;
}
export type ToolExample<TArgs = Record<string, unknown>> =
	| ToolCallExample<TArgs>
	| ToolCompareExample<TArgs>
	| ToolNoteExample;

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	/** If true, tool is strictly typed and validated against the parameters schema before execution */
	strict?: boolean;
	/**
	 * Optional grammar constraint for OpenAI custom-tool emission.
	 * When set, providers that support grammar-constrained tools (currently only
	 * `openai-responses` against models with the right capability flag) may emit
	 * this tool as `{type: "custom", format: {type: "grammar", …}}` instead of a
	 * JSON function tool. Other providers ignore the field.
	 */
	customFormat?: { syntax: "lark" | "regex"; definition: string };
	/**
	 * Optional wire-level name used when this tool is emitted as a custom tool
	 * (e.g. OpenAI's `{type: "custom"}` shape). Models trained on specific tool
	 * names — like GPT-5 on `apply_patch` — need to see that exact name on the
	 * wire, but it may differ from the harness-internal `name`. The agent-loop
	 * dispatcher matches both `name` and `customWireName` so returned tool
	 * calls route correctly. Absent for regular JSON function tools.
	 */
	customWireName?: string;
	/**
	 * Illustrative calls/notes; the AI layer renders them into an `<examples>`
	 * block in the model's native tool-call syntax and appends to the wire
	 * description. Author `call`/`bad`/`good` as plain argument objects WITHOUT
	 * `i` — when intent tracing injects `i` into the schema, the renderer adds
	 * a placeholder `i` automatically. Type each tool's `examples` against its
	 * own schema (e.g. `readonly ToolExample<typeof schema["type"]>[]`).
	 */
	examples?: readonly ToolExample[];
}

export interface Context {
	systemPrompt?: string[];
	messages: Message[];
	tools?: Tool[];
}

export type AssistantMessageEvent =
	| { type: "start"; contentIndex?: undefined; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			contentIndex?: undefined;
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			message: AssistantMessage;
	  }
	| {
			type: "error";
			contentIndex?: undefined;
			reason: Extract<StopReason, "aborted" | "error">;
			error: AssistantMessage;
	  };
