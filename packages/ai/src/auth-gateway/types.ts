import type { Effort } from "../model-thinking";
import type { AssistantMessage, AssistantMessageEventStream, CacheRetention, Context, ServiceTier } from "../types";

/**
 * Wire types for the omp auth-gateway.
 *
 * The gateway sits between unauthenticated clients (containerized omp,
 * llm-git, …) and the broker. It accepts provider-format HTTP requests
 * (OpenAI chat-completions / Anthropic messages / OpenAI Responses),
 * dispatches them through pi-ai's `streamSimple()`, and translates the
 * canonical event stream back to the matching wire format. The gateway
 * injects `Authorization` server-side so clients never see access tokens.
 */

/** Default bind. Loopback-only — front with reverse proxy for remote access. */
export const DEFAULT_AUTH_GATEWAY_BIND = "127.0.0.1:4000";

export type AuthGatewayToolChoice = "auto" | "none" | "required" | { name: string };

export interface AuthGatewayParsedRequestOptions {
	maxOutputTokens?: number;
	temperature?: number;
	topP?: number;
	topK?: number;
	stopSequences?: string[];
	toolChoice?: AuthGatewayToolChoice;
	/** Effort-level reasoning request (OpenAI Responses / Chat `reasoning_effort`). */
	reasoning?: Effort;
	/** Force-disable reasoning (Anthropic `thinking: { type: "disabled" }`). */
	disableReasoning?: boolean;
	/**
	 * Token budget for thinking (Anthropic `thinking.budget_tokens`). Bridged to
	 * pi-ai via `thinkingBudgets[high]` when the wire format only carries a
	 * single budget number with no effort label.
	 */
	thinkingBudget?: number;
	/** Suppress the provider's reasoning summary stream. */
	hideThinkingSummary?: boolean;
	/** OpenAI service tier (auto|default|flex|scale|priority). */
	serviceTier?: ServiceTier;
	/** Presence penalty (OpenAI). */
	presencePenalty?: number;
	/** Cache retention hint derived from inbound `cache_control` markers. */
	cacheRetention?: CacheRetention;
	/**
	 * Provider-specific request controls that need server-side routing support
	 * but aren't yet first-class on this interface.
	 */
	extra?: Record<string, unknown>;
}

export interface AuthGatewayParsedRequest {
	modelId: string;
	context: Context;
	stream: boolean;
	options: AuthGatewayParsedRequestOptions;
}

export interface AuthGatewayFormatModule {
	parseRequest(body: unknown): AuthGatewayParsedRequest;
	encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown>;
	encodeStream(
		events: AssistantMessageEventStream,
		requestedModelId: string,
		options?: AuthGatewayParsedRequestOptions,
	): ReadableStream<Uint8Array>;
}

export interface AuthGatewayServerOptions {
	/** Listen address. Default `127.0.0.1:4000`. */
	bind?: string;
	/** Accept any of these bearer tokens. Empty allows unauthenticated calls. */
	bearerTokens: string[];
	/** Version surfaced on `/healthz`. */
	version?: string;
}

export interface AuthGatewayServerHandle {
	url: string;
	port: number;
	hostname: string;
	close(): Promise<void>;
}
