import type { TSchema } from "@sinclair/typebox";
import type { BedrockOptions } from "./providers/amazon-bedrock";
import type { AnthropicOptions } from "./providers/anthropic";
import type { AzureOpenAIResponsesOptions } from "./providers/azure-openai-responses";
import type { CursorOptions } from "./providers/cursor";
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
} from "./providers/cursor/gen/agent_pb";
import type { GoogleOptions } from "./providers/google";
import type { GoogleGeminiCliOptions } from "./providers/google-gemini-cli";
import type { GoogleVertexOptions } from "./providers/google-vertex";
import type { OpenAICodexResponsesOptions } from "./providers/openai-codex-responses";
import type { OpenAICompletionsOptions } from "./providers/openai-completions";
import type { OpenAIResponsesOptions } from "./providers/openai-responses";
import type { AssistantMessageEventStream } from "./utils/event-stream";

export type { AssistantMessageEventStream } from "./utils/event-stream";

export type KnownApi =
	| "openai-completions"
	| "openai-responses"
	| "openai-codex-responses"
	| "azure-openai-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-gemini-cli"
	| "google-vertex"
	| "cursor-agent";
export type Api = KnownApi | (string & {});
export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"bedrock-converse-stream": BedrockOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-gemini-cli": GoogleGeminiCliOptions;
	"google-vertex": GoogleVertexOptions;
	"cursor-agent": CursorOptions;
}
// Compile-time exhaustiveness check - this will fail if ApiOptionsMap doesn't have all KnownApi keys
type _CheckExhaustive =
	ApiOptionsMap extends Record<KnownApi, StreamOptions>
		? Record<KnownApi, StreamOptions> extends ApiOptionsMap
			? true
			: ["ApiOptionsMap is missing some KnownApi values", Exclude<KnownApi, keyof ApiOptionsMap>]
		: ["ApiOptionsMap doesn't extend Record<KnownApi, StreamOptions>"];
const _exhaustive: _CheckExhaustive = true;
export type OptionsForApi<TApi extends Api> =
	| StreamOptions
	| (TApi extends keyof ApiOptionsMap ? ApiOptionsMap[TApi] : never);

/** Canonical thinking transport used by a model. */
export type ThinkingControlMode =
	| "effort"
	| "budget"
	| "google-level"
	| "anthropic-adaptive"
	| "anthropic-budget-effort";

/** Per-model thinking capabilities used to clamp and map user-facing effort levels. */
export interface ThinkingConfig {
	/** Least intensive supported user-facing effort level. */
	minLevel: Effort;
	/** Most intensive supported user-facing effort level. */
	maxLevel: Effort;
	/** Provider-specific transport used to encode the selected effort. */
	mode: ThinkingControlMode;
}

export type KnownProvider =
	| "alibaba-coding-plan"
	| "amazon-bedrock"
	| "anthropic"
	| "google"
	| "google-gemini-cli"
	| "google-antigravity"
	| "google-vertex"
	| "openai"
	| "openai-codex"
	| "kimi-code"
	| "minimax-code"
	| "minimax-code-cn"
	| "github-copilot"
	| "gitlab-duo"
	| "cursor"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "kilo"
	| "vercel-ai-gateway"
	| "zai"
	| "mistral"
	| "minimax"
	| "opencode-go"
	| "opencode-zen"
	| "synthetic"
	| "cloudflare-ai-gateway"
	| "huggingface"
	| "litellm"
	| "moonshot"
	| "nvidia"
	| "nanogpt"
	| "ollama"
	| "qianfan"
	| "qwen-portal"
	| "together"
	| "venice"
	| "vllm"
	| "xiaomi"
	| "zenmux"
	| "lm-studio";
export type Provider = KnownProvider | string;

import type { Effort } from "./model-thinking";

/** Token budgets for each thinking level (token-based providers only) */
export type ThinkingBudgets = { [key in Effort]?: number };

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

/** OpenAI service tier for processing priority. Only applies to OpenAI-compatible APIs. */
export type ServiceTier = "auto" | "default" | "flex" | "scale" | "priority";

export function isSpecialServiceTier(serviceTier?: ServiceTier | null): serviceTier is "flex" | "scale" | "priority" {
	return serviceTier === "flex" || serviceTier === "scale" || serviceTier === "priority";
}

export interface ProviderSessionState {
	close(): void;
}

export interface StreamOptions {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
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
	 * Optional session identifier for providers that support session-based caching.
	 * Providers can use this to enable prompt caching, request routing, or other
	 * session-aware features. Ignored by providers that don't support it.
	 */
	sessionId?: string;
	/**
	 * Provider-scoped mutable state store for this agent session.
	 * Providers can use this to persist transport/session state between turns.
	 */
	providerSessionState?: Map<string, ProviderSessionState>;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	onPayload?: (payload: unknown, model?: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional override for the first streamed event watchdog in milliseconds.
	 * Set to 0 to disable the first-event watchdog for this request.
	 */
	streamFirstEventTimeoutMs?: number;
	/** Cursor exec/MCP tool handlers (cursor-agent only). */
	execHandlers?: CursorExecHandlers;
}

// Unified options with reasoning passed to streamSimple() and completeSimple()
export interface SimpleStreamOptions extends StreamOptions {
	reasoning?: Effort;
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
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
	intent?: string; // Harness-level intent metadata extracted from traced tool arguments
	/**
	 * Original wire-level name when the tool was invoked via OpenAI's custom-tool
	 * mechanism (e.g., `apply_patch`). Set by `openai-responses` on receive so
	 * the history-replay path can re-emit the call as `custom_tool_call` with
	 * its paired tool-result as `custom_tool_call_output`. Absent for regular
	 * JSON function tools.
	 */
	customWireName?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	premiumRequests?: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
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

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | RedactedThinkingContent | ToolCall)[];
	api: Api;
	provider: Provider;
	model: string;
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
	duration?: number; // Request duration in milliseconds
	ttft?: number; // Time to first token in milliseconds
}

export interface ToolResultMessage<TDetails = any> {
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
}

export interface Context {
	systemPrompt?: string;
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

/**
 * Compatibility settings for openai-completions API.
 * Use this to override URL-based auto-detection for custom providers.
 */
export interface OpenAICompat {
	/** Whether the provider supports the `store` field. Default: auto-detected from URL. */
	supportsStore?: boolean;
	/** Whether the provider supports the `developer` role (vs `system`). Default: auto-detected from URL. */
	supportsDeveloperRole?: boolean;
	/** Whether the provider supports `reasoning_effort`. Default: auto-detected from URL. */
	supportsReasoningEffort?: boolean;
	/** Optional mapping from pi-ai reasoning levels to provider/model-specific `reasoning_effort` values. */
	reasoningEffortMap?: Partial<Record<Effort, string>>;
	/** Whether the provider supports `stream_options: { include_usage: true }` for token usage in streaming responses. Default: true. */
	supportsUsageInStreaming?: boolean;
	/** Which field to use for max tokens. Default: auto-detected from URL. */
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** Whether tool results require the `name` field. Default: auto-detected from URL. */
	requiresToolResultName?: boolean;
	/** Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL. */
	requiresAssistantAfterToolResult?: boolean;
	/** Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL. */
	requiresThinkingAsText?: boolean;
	/** Whether tool call IDs must be normalized to Mistral format (exactly 9 alphanumeric chars). Default: auto-detected from URL. */
	requiresMistralToolIds?: boolean;
	/** Format for reasoning/thinking parameter. "openai" uses reasoning_effort, "openrouter" uses reasoning: { effort }, "zai" uses thinking: { type: "enabled" }, "qwen" uses top-level enable_thinking, and "qwen-chat-template" uses chat_template_kwargs.enable_thinking. Default: "openai". */
	thinkingFormat?: "openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template";
	/** Which reasoning content field to emit on assistant messages. Default: auto-detected. */
	reasoningContentField?: "reasoning_content" | "reasoning" | "reasoning_text";
	/** Whether assistant tool-call messages must include reasoning content. Default: false. */
	requiresReasoningContentForToolCalls?: boolean;
	/** Whether assistant tool-call messages must include non-empty content. Default: false. */
	requiresAssistantContentForToolCalls?: boolean;
	/** Whether the provider supports the `tool_choice` parameter. Default: true. */
	supportsToolChoice?: boolean;
	/** OpenRouter-specific routing preferences. Only used when baseUrl points to OpenRouter. */
	openRouterRouting?: OpenRouterRouting;
	/** Vercel AI Gateway routing preferences. Only used when baseUrl points to Vercel AI Gateway. */
	vercelGatewayRouting?: VercelGatewayRouting;
	/** Extra fields to include in request body (e.g. gateway routing hints for OpenClaw-style proxies). */
	extraBody?: Record<string, unknown>;
	/** Whether the provider supports the `strict` field in tool definitions. Default: auto-detected per provider/baseUrl (conservative for unknown providers). */
	supportsStrictMode?: boolean;
	/** Whether tool schemas must be sent either all strict or all non-strict. Undefined keeps the existing per-tool mixed behavior. */
	toolStrictMode?: "all_strict" | "none";
}

/**
 * OpenRouter provider routing preferences.
 * Controls which upstream providers OpenRouter routes requests to.
 * @see https://openrouter.ai/docs/provider-routing
 */
export interface OpenRouterRouting {
	/** List of provider slugs to exclusively use for this request (e.g., ["amazon-bedrock", "anthropic"]). */
	only?: string[];
	/** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
	order?: string[];
}

/**
 * Vercel AI Gateway routing preferences.
 * Controls which upstream providers the gateway routes requests to.
 * @see https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
export interface VercelGatewayRouting {
	/** List of provider slugs to exclusively use for this request (e.g., ["bedrock", "anthropic"]). */
	only?: string[];
	/** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
	order?: string[];
}

// Model interface for the unified model system
export interface Model<TApi extends Api = any> {
	id: string;
	name: string;
	api: TApi;
	provider: Provider;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number; // $/million tokens
		output: number; // $/million tokens
		cacheRead: number; // $/million tokens
		cacheWrite: number; // $/million tokens
	};
	/** Premium Copilot requests charged per user-initiated request (defaults to 1). */
	premiumMultiplier?: number;
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	/** Hint that websocket transport should be preferred when supported by the provider implementation. */
	preferWebsockets?: boolean;
	/** Preferred model to switch to when context promotion is triggered (model id or provider/id). */
	contextPromotionTarget?: string;
	/** Provider-assigned priority value (lower = higher priority). */
	priority?: number;
	/** Canonical thinking capability metadata for this model. */
	thinking?: ThinkingConfig;
	/** Compatibility overrides for openai-completions API. If not set, auto-detected from baseUrl. */
	compat?: TApi extends "openai-completions" ? OpenAICompat : never;
	/**
	 * Which shape to use when exposing the Codex `apply_patch` tool to this model.
	 * - `"freeform"`: OpenAI custom-tool with a Lark grammar (spec §1.1). Raw patch
	 *   string, no JSON envelope. Only honored by the `openai-responses` provider.
	 * - `"function"` or undefined: JSON function-tool with `{input: string}` (spec §1.2).
	 */
	applyPatchToolType?: "freeform" | "function";
}
