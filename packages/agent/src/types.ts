import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Effort,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	streamSimple,
	TextContent,
	Tool,
	ToolChoice,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";

/** Stream function - can return sync or Promise for async config lookup */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * Configuration for the agent loop.
 */
export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model;

	/**
	 * When to interrupt tool execution for steering messages.
	 * - "immediate" = check after each tool call (default)
	 * - "wait" = defer steering until the current turn completes
	 */
	interruptMode?: "immediate" | "wait";

	/**
	 * Optional session identifier forwarded to LLM providers.
	 * Used by providers that support session-based caching (e.g., OpenAI Codex).
	 */
	sessionId?: string;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after each tool execution to check for user interruptions unless interruptMode is "wait".
	 * If messages are returned, remaining tool calls are skipped and
	 * these messages are added to the context before the next LLM call.
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Provides tool execution context, resolved per tool call.
	 * Use for late-bound UI or session state access.
	 */
	getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;

	/**
	 * Refreshes prompt/tool context from live session state before each model call.
	 * Use this when tool availability or the system prompt can change mid-turn.
	 */
	syncContextBeforeModelCall?: (context: AgentContext) => void | Promise<void>;

	/**
	 * Optional transform applied to tool call arguments before execution.
	 * Use for deobfuscating secrets or rewriting arguments.
	 */
	transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => Record<string, unknown>;

	/**
	 * Enable intent tracing for tool calls.
	 * When enabled, the harness injects a `string` field into tool schemas sent to the model,
	 * then strips from arguments before executing tools.
	 */
	intentTracing?: boolean;

	/**
	 * Inspect assistant streaming events before they are published to the outer agent event stream.
	 * Callers may abort synchronously to stop consuming buffered provider events.
	 */
	onAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;

	/**
	 * Dynamic tool choice override, resolved per LLM call.
	 * When set and returns a value, overrides the static `toolChoice`.
	 */
	getToolChoice?: () => ToolChoice | undefined;
}

export interface ToolCallContext {
	batchId: string;
	index: number;
	total: number;
	toolCalls: Array<{ id: string; name: string }>;
}

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@oh-my-pi/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Agent state containing all configuration and conversation data.
 */
export interface AgentState {
	systemPrompt: string;
	model: Model;
	thinkingLevel?: Effort;
	tools: AgentTool<any>[];
	messages: AgentMessage[]; // Can include attachments + custom message types
	isStreaming: boolean;
	streamMessage: AgentMessage | null;
	pendingToolCalls: Set<string>;
	error?: string;
}

export interface AgentToolResult<T = any, _TInput = unknown> {
	// Content blocks supporting text and images
	content: (TextContent | ImageContent)[];
	// Details to be displayed in a UI or logged
	details?: T;
}

// Callback for streaming tool execution updates
export type AgentToolUpdateCallback<T = any, TInput = unknown> = (partialResult: AgentToolResult<T, TInput>) => void;

/** Options passed to renderResult */
export interface RenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
	/** Current spinner frame index for animated elements (optional) */
	spinnerFrame?: number;
}

/**
 * Context passed to tool execution.
 * Apps can extend via declaration merging.
 */
export interface AgentToolContext {
	// Empty by default - apps extend via declaration merging
}

export type AgentToolExecFn<TParameters extends TSchema = TSchema, TDetails = any, TTheme = unknown> = (
	this: AgentTool<TParameters, TDetails, TTheme>,
	toolCallId: string,
	params: Static<TParameters>,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
	context?: AgentToolContext,
) => Promise<AgentToolResult<TDetails, TParameters>>;

// AgentTool extends Tool but adds the execute function
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any, TTheme = unknown>
	extends Tool<TParameters> {
	// A human-readable label for the tool to be displayed in UI
	label: string;
	/** If true, tool is excluded unless explicitly listed in --tools or agent's tools field */
	hidden?: boolean;
	/** If true, tool can stage a pending action that requires explicit resolution via the resolve tool. */
	deferrable?: boolean;
	/** If true, tool execution ignores abort signals (runs to completion) */
	nonAbortable?: boolean;
	/**
	 * Concurrency mode for tool scheduling when multiple calls are in one turn.
	 * - "shared": can run alongside other shared tools (default)
	 * - "exclusive": runs alone; other tools wait until it finishes
	 */
	concurrency?: "shared" | "exclusive";
	/** If true, argument validation errors are non-fatal: raw args are passed to execute() instead of returning an error to the LLM. */
	lenientArgValidation?: boolean;
	/**
	 * If true, the INTENT_FIELD (`_i`) is NOT injected into this tool's parameter schema.
	 * Use for tools where intent is obvious from the call itself (yield, resolve, todo_write, …).
	 * Pair with `deriveIntent` if the UI should still surface a working-message intent.
	 */
	nointent?: boolean;
	/**
	 * Optional callback that derives a short intent string from (potentially partial / streaming) args.
	 * Used as a fallback when no `_i` field is present on the tool call (typically because `nointent` is set).
	 */
	deriveIntent?: (args: Partial<Static<TParameters>>) => string | undefined;

	/** The main execution callback for this tool. */
	execute: AgentToolExecFn<TParameters, TDetails, TTheme>;

	/** Optional custom rendering for tool call display (returns UI component) */
	renderCall?: (args: Static<TParameters>, options: RenderResultOptions, theme: TTheme) => unknown;

	/** Optional custom rendering for tool result display (returns UI component) */
	renderResult?: (
		result: AgentToolResult<TDetails, TParameters>,
		options: RenderResultOptions,
		theme: TTheme,
	) => unknown;
}

// AgentContext is like Context but uses AgentTool
export interface AgentContext {
	systemPrompt: string;
	messages: AgentMessage[];
	tools?: AgentTool<any>[];
}

/**
 * Events emitted by the Agent for UI updates.
 * These events provide fine-grained lifecycle information for messages, turns, and tool executions.
 */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage }
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any; intent?: string }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError?: boolean };
