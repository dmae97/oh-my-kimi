import type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	streamSimple,
	TextContent,
	Tool,
	ToolResultMessage,
} from "omk-ai";
import type { Static, TSchema } from "typebox";

/**
 * Stream function used by the agent loop.
 *
 * Contract:
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Must return an AssistantMessageEventStream.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
 */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

/**
 * Configuration for how tool calls from a single assistant message are executed.
 *
 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
 * - "parallel": tool calls are prepared sequentially, then allowed tools execute concurrently.
 *   `tool_execution_end` is emitted in tool completion order after each tool is finalized,
 *   while tool-result message artifacts are emitted later in assistant source order.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * Tool-call scheduler selection for a single assistant turn's tool batch.
 *
 * - `"waves-v1"` (default): the original contiguous-wave scheduler
 *   (`partitionToolBatchWaves`). Established behavior and the rollback target.
 * - `"dag-v2"`: the deterministic resource-claim DAG scheduler
 *   (`scheduleDagLevels`). Active only when explicitly selected. It resolves
 *   per-call resource claims and groups conflict-free calls into source-index
 *   DAG levels so a conflicting call no longer head-of-line-blocks independent
 *   later calls (e.g. `write x, write x, write y` schedules as `[[0, 2], [1]]`).
 *   Final tool results are buffered globally and emitted in original source
 *   order.
 */
export type ToolSchedulerKind = "waves-v1" | "dag-v2";

/**
 * Controls how many queued user messages are injected when the agent loop reaches a queue drain point.
 *
 * - "all": drain and inject every queued message at that point.
 * - "one-at-a-time": drain and inject only the oldest queued message, leaving the rest queued for later drain points.
 */
export type QueueMode = "all" | "one-at-a-time";

/** A single tool call content block emitted by an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * Result returned from `beforeToolCall`.
 *
 * Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead.
 * `reason` becomes the text shown in that error result. If omitted, a default blocked message is used.
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/**
 * Partial override returned from `afterToolCall`.
 *
 * Merge semantics are field-by-field:
 * - `content`: if provided, replaces the tool result content array in full
 * - `details`: if provided, replaces the tool result details value in full
 * - `isError`: if provided, replaces the tool result error flag
 * - `terminate`: if provided, replaces the early-termination hint
 *
 * Omitted fields keep the original executed tool result values.
 * There is no deep merge for `content` or `details`.
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	/** Current agent context at the time the tool call is prepared. */
	context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	args: unknown;
	/** The executed tool result before any `afterToolCall` overrides are applied. */
	result: AgentToolResult<any>;
	/** Whether the executed tool result is currently treated as an error. */
	isError: boolean;
	/** Current agent context at the time the tool call is finalized. */
	context: AgentContext;
}

/** Context passed to `shouldStopAfterTurn`. */
export interface ShouldStopAfterTurnContext {
	/** The assistant message that completed the turn. */
	message: AssistantMessage;
	/** Tool result messages passed to the preceding `turn_end` event. */
	toolResults: ToolResultMessage[];
	/** Current agent context after the turn's assistant message and tool results have been appended. */
	context: AgentContext;
	/** Messages that this loop invocation will return if it exits at this point. Prompt runs include the initial prompt messages; continuation runs do not include pre-existing context messages. */
	newMessages: AgentMessage[];
}

/** Replacement runtime state used by the agent loop before starting another provider request. */
export interface AgentLoopTurnUpdate {
	/** Context for the next provider request. */
	context?: AgentContext;
	/** Model for the next provider request. */
	model?: Model<any>;
	/** Thinking level for the next provider request. */
	thinkingLevel?: ThinkingLevel;
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * Contract: must not throw or reject. Return a safe fallback value instead.
	 * Throwing interrupts the low-level agent loop without producing a normal event sequence.
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
	 * Contract: must not throw or reject. Return the original messages or another
	 * safe fallback value instead.
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
	 *
	 * Contract: must not throw or reject. Return undefined when no key is available.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * Called after each turn fully completes and `turn_end` has been emitted.
	 *
	 * If it returns true, the loop emits `agent_end` and exits before polling steering or follow-up queues,
	 * without starting another LLM call. The current assistant response and any tool executions finish normally.
	 *
	 * Use this to request a graceful stop after the current turn, e.g. before context gets too full.
	 *
	 * Contract: must not throw or reject. Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

	/**
	 * Called after `turn_end` and before the loop decides whether another provider request should start.
	 * Return replacement context/model/thinking state to affect the next turn in this run.
	 * Return undefined to keep using the current context/config.
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after the current assistant turn finishes executing its tool calls, unless `shouldStopAfterTurn` exits first.
	 * If messages are returned, they are added to the context before the next LLM call.
	 * Tool calls from the current assistant message are not skipped.
	 *
	 * Use this for "steering" the agent while it's working.
	 *
	 * Contract: must not throw or reject. Return [] when no steering messages are available.
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 *
	 * Use this for follow-up messages that should wait until the agent finishes.
	 *
	 * Contract: must not throw or reject. Return [] when no follow-up messages are available.
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Tool execution mode.
	 * - "sequential": execute tool calls one by one
	 * - "parallel": preflight tool calls sequentially, then execute allowed tools concurrently;
	 *   emit `tool_execution_end` in tool completion order after each tool is finalized,
	 *   then emit tool-result message artifacts later in assistant source order
	 *
	 * Default: "parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * Default per-tool execution timeout in milliseconds applied to every tool
	 * call that does not resolve a more specific timeout.
	 *
	 * This is deliberately named to avoid colliding with the inherited
	 * {@link SimpleStreamOptions.timeoutMs} (the provider request timeout).
	 * Absent, non-finite, or non-positive values disable the tool timeout and
	 * preserve the current unbounded execution behavior.
	 */
	toolTimeoutMs?: number;

	/**
	 * Per-tool-name execution timeouts in milliseconds. An entry here overrides
	 * {@link toolTimeoutMs} for that tool name, and is itself overridden by a
	 * per-tool {@link AgentTool.timeoutMs}. Absent, non-finite, or non-positive
	 * entries disable the timeout for that name.
	 */
	toolTimeouts?: Record<string, number>;

	/**
	 * Tool-call scheduler. Defaults to `"waves-v1"` (the established
	 * contiguous-wave scheduler). Set to `"dag-v2"` to opt into the
	 * deterministic resource-claim DAG scheduler. The v1 path and its exports
	 * are unchanged when this is unset or `"waves-v1"`.
	 */
	toolScheduler?: ToolSchedulerKind;

	/**
	 * dag-v2 only. Optional positive width cap. When set, each DAG level is
	 * split into deterministic contiguous chunks of at most this many calls
	 * (preserving source order) so a wide conflict-free level does not fan out
	 * unbounded. Absent, non-finite, or non-positive values leave each level
	 * whole. No effect on the default `"waves-v1"` scheduler.
	 */
	maxToolConcurrency?: number;

	/**
	 * dag-v2 only. When `false` (default), an extension/custom tool with
	 * `executionMode: "parallel"` and no resource claims is treated as freely
	 * parallel (compatibility). When `true`, such tools are treated as
	 * exclusive (run alone). Unknown tools and bash are always exclusive
	 * regardless of this flag. No effect on the default `"waves-v1"` scheduler.
	 */
	strictExtensionClaims?: boolean;

	/** Working directory for path-scoped parallel tool batch checks (read/write/edit). */
	cwd?: string;

	/**
	 * dag-v2 only. Optional platform identity resolver used to detect
	 * symlink/hardlink/drive/UNC path aliases when scheduling resource claims.
	 * Absent, the scheduler uses lexical canonicalization only (browser-safe).
	 * Resolver failure isolates the call as exclusive (fail closed).
	 */
	resourceKeyResolver?: ResourceKeyResolver;

	/**
	 * Execution policy defaults for every tool call in this run. Only
	 * `lateSettlement` is consumed today; it defaults to `"audit"`.
	 */
	toolExecutionPolicy?: Partial<ToolExecutionPolicy>;

	/**
	 * Called before a tool is executed, after arguments have been validated.
	 *
	 * Return `{ block: true }` to prevent execution. The loop emits an error tool result instead.
	 * The runtime bounds the hook by the parent abort signal and ignores a late settlement.
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * Called after execution but skipped for an immutable committed timeout/abort terminal.
	 *
	 * Return an `AfterToolCallResult` to override parts of the executed tool result:
	 * - `content` replaces the full content array
	 * - `details` replaces the full details payload
	 * - `isError` replaces the error flag
	 * - `terminate` replaces the early-termination hint
	 *
	 * Any omitted fields keep their original values. No deep merge is performed.
	 * The runtime bounds the hook by the parent abort signal and ignores a late settlement.
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh", "max", and "ultra" are only supported by selected model families. Use model thinking-level
 * metadata from omk-ai to detect support for a concrete model.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
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
 * Public agent state.
 *
 * `tools` and `messages` use accessor properties so implementations can copy
 * assigned arrays before storing them.
 */
export interface AgentState {
	/** System prompt sent with each model request. */
	systemPrompt: string;
	/** Active model used for future turns. */
	model: Model<any>;
	/** Requested reasoning level for future turns. */
	thinkingLevel: ThinkingLevel;
	/** Available tools. Assigning a new array copies the top-level array. */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/** Conversation transcript. Assigning a new array copies the top-level array. */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * True while the agent is processing a prompt or continuation.
	 *
	 * This remains true until awaited `agent_end` listeners settle.
	 */
	readonly isStreaming: boolean;
	/** Partial assistant message for the current streamed response, if any. */
	readonly streamingMessage?: AgentMessage;
	/** Tool call ids currently executing. */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** Error message from the most recent failed or aborted assistant turn, if any. */
	readonly errorMessage?: string;
}

/** Final or partial result produced by a tool. */
export interface AgentToolResult<T> {
	/** Text or image content returned to the model. */
	content: (TextContent | ImageContent)[];
	/** Arbitrary structured details for logs or UI rendering. */
	details: T;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 */
	terminate?: boolean;
}

/** Callback used by tools to stream partial execution updates. */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** Access mode used by a tool resource claim. */
export type ResourceAccess = "read" | "write" | "exclusive";

/** Access modes valid for path claims and built-in read/write resources. */
export type ToolResourceAccess = Extract<ResourceAccess, "read" | "write">;

/**
 * A resource touched by one tool call.
 *
 * Path claims conflict on lexical parent/child overlap. Other claim kinds
 * conflict when their keys are equal. `exclusive` access conflicts with every
 * call, regardless of resource kind or key.
 */
export type ToolResourceClaim =
	| {
			kind: "path";
			key: string;
			access: ToolResourceAccess;
			/** Canonical real-path identity (symlink-resolved), when a resolver is injected. */
			realKey?: string;
			/** `dev:ino` identity for an existing file, when a resolver is injected. */
			inodeKey?: string;
	  }
	| {
			kind: "session" | "terminal" | "network" | "global";
			key: string;
			access: ResourceAccess;
	  };

/**
 * Resource contract returned by {@link AgentTool.resourceClaims}.
 *
 * Return `"exclusive"` when the call must run alone, or a non-empty claim
 * list. The dag-v2 scheduler fails closed to exclusive when a resolver throws,
 * rejects, or returns an empty or malformed claim list.
 */
export type ToolResourceClaims = readonly ToolResourceClaim[] | "exclusive";

/** Context passed to {@link AgentTool.resourceClaims}. */
export interface ToolResourceClaimsContext {
	/** Working directory used by the scheduler for this call batch. */
	cwd: string;
	/** Provider-supplied id of the tool call being scheduled. */
	toolCallId: string;
}

/** Tool definition used by the agent runtime. */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	/** Human-readable label for UI display. */
	label: string;
	/**
	 * Optional compatibility shim for raw tool-call arguments before schema validation.
	 * Must return an object that matches `TParameters`.
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/** Execute the tool call. Throw on failure instead of encoding errors in `content`. */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls.
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the default execution mode applies.
	 */
	executionMode?: ToolExecutionMode;
	/**
	 * dag-v2 resource contract for this tool call.
	 *
	 * The resolver receives the raw call arguments and scheduler context before
	 * execution starts. It may return synchronously or asynchronously. Throwing,
	 * rejecting, returning malformed data, or returning no usable claim fails
	 * closed to exclusive scheduling. This field has no effect on waves-v1.
	 */
	resourceClaims?: (
		args: unknown,
		context: ToolResourceClaimsContext,
	) => ToolResourceClaims | Promise<ToolResourceClaims>;
	/**
	 * Optional per-call execution timeout in milliseconds.
	 *
	 * When positive, the tool's `execute` promise is raced against this timeout at
	 * the shared execution chokepoint. If the timeout elapses first, the loop
	 * commits an immediate terminal timeout result and aborts the tool's child
	 * `AbortSignal`, so a tool that ignores the signal cannot stall the run.
	 *
	 * Precedence: this value overrides `AgentLoopConfig.toolTimeouts[name]`, which
	 * overrides `AgentLoopConfig.toolTimeoutMs`. Absent, non-finite, or
	 * non-positive values disable the timeout and preserve current behavior.
	 */
	timeoutMs?: number;
}

/**
 * Terminal disposition of one tool call in a transcript (six-state model).
 *
 * - `completed`: the tool ran and returned a result.
 * - `failed`: the tool ran and threw/rejected, or could not be prepared.
 * - `blocked`: a policy hook prevented execution.
 * - `aborted`: the run's abort terminated the call (started or unstarted).
 * - `timeout`: the per-call timeout terminated the call.
 * - `skipped`: the scheduler closed the call without ever starting it.
 */
export type ToolCallDisposition = "completed" | "failed" | "blocked" | "aborted" | "timeout" | "skipped";

/** Schema tag for the {@link ToolResultEnvelope} attached to terminal tool results. */
export const TOOL_RESULT_ENVELOPE_SCHEMA = "tool-result/v2" as const;

/**
 * Model-invisible disposition envelope stamped at `details.omk` on every
 * terminal tool result. `synthetic` means the result artifact was fabricated
 * by the runtime and does not represent the tool's returned details;
 * `executionStarted` records whether `AgentTool.execute` actually began.
 */
export interface ToolResultEnvelope {
	schema: typeof TOOL_RESULT_ENVELOPE_SCHEMA;
	synthetic: boolean;
	disposition: ToolCallDisposition;
	reason?: string;
	timeoutMs?: number;
	executionStarted: boolean;
}

/** Input accepted by the executor-owned {@link createToolResultEnvelope} boundary. */
export type ToolResultEnvelopeInput = Omit<ToolResultEnvelope, "schema">;

/** Compatibility wrapper used when original tool details are not a plain object. */
export interface WrappedToolResultDetails {
	readonly originalDetails: unknown;
	readonly omk: ToolResultEnvelope;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate both the v2 shape and disposition-specific executor invariants. */
export function isToolResultEnvelope(value: unknown): value is ToolResultEnvelope {
	if (
		!isUnknownRecord(value) ||
		value.schema !== TOOL_RESULT_ENVELOPE_SCHEMA ||
		typeof value.synthetic !== "boolean" ||
		typeof value.executionStarted !== "boolean" ||
		(value.reason !== undefined && typeof value.reason !== "string") ||
		(value.timeoutMs !== undefined &&
			(typeof value.timeoutMs !== "number" || !Number.isFinite(value.timeoutMs) || value.timeoutMs <= 0))
	) {
		return false;
	}

	switch (value.disposition) {
		case "completed":
			return value.synthetic === false && value.executionStarted && value.timeoutMs === undefined;
		case "failed":
			return (value.executionStarted || value.synthetic) && value.timeoutMs === undefined;
		case "blocked":
		case "skipped":
			return value.synthetic && !value.executionStarted && value.timeoutMs === undefined;
		case "aborted":
			return value.synthetic && value.timeoutMs === undefined;
		case "timeout":
			return value.synthetic && value.executionStarted && value.timeoutMs !== undefined;
		default:
			return false;
	}
}

/**
 * Construct and freeze a validated executor envelope. Invalid combinations
 * throw at the executor boundary instead of being persisted into a transcript.
 */
export function createToolResultEnvelope(input: ToolResultEnvelopeInput): ToolResultEnvelope {
	const envelope: ToolResultEnvelope = {
		schema: TOOL_RESULT_ENVELOPE_SCHEMA,
		synthetic: input.synthetic,
		disposition: input.disposition,
		...(input.reason === undefined ? {} : { reason: input.reason }),
		...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
		executionStarted: input.executionStarted,
	};
	if (!isToolResultEnvelope(envelope)) {
		throw new TypeError(`Invalid ${TOOL_RESULT_ENVELOPE_SCHEMA} ${input.disposition} envelope`);
	}
	return Object.freeze(envelope);
}

/**
 * Per-call execution policy (ALG-004 §6.2). `lateSettlement` controls whether
 * a real tool promise settling after its terminal cause is surfaced as an
 * audit-only event (`"audit"`, default) or silently dropped (`"ignore"`).
 * Terminal results are immutable either way.
 */
export interface ToolExecutionPolicy {
	timeoutMs?: number;
	cancelSiblingsOnFatal?: boolean;
	lateSettlement: "audit" | "ignore";
}

/** Committed disposition for a tool call terminated by timeout or parent abort. */
export type ToolTimeoutDisposition = "timeout" | "aborted";

/** Identity keys resolved for one raw path by a {@link ResourceKeyResolver}. */
export interface ResolvedResourceKeys {
	/** Canonical lexical key (slash-normalized, dot-collapsed, drive/UNC normalized). */
	lexicalKey: string;
	/** Canonical real path: nearest existing ancestor realpath + non-existing suffix. */
	realKey?: string;
	/** `dev:ino` identity for an existing file (symlink target/hardlink aware). */
	inodeKey?: string;
}

/**
 * Optional platform identity resolver injected into the dag-v2 scheduler
 * (§5.5 stage 2). The shared agent package stays browser-safe; a Node
 * implementation lives in `omk-agent-core/node`. The raw path reaches the
 * resolver before cwd-relative lexical canonicalization so Node-only tilde and
 * platform aliases remain visible. Returning `null`, throwing, rejecting, or
 * returning malformed keys isolates the call as exclusive.
 */
export interface ResourceKeyResolver {
	resolvePath(rawPath: string, cwd: string): Promise<ResolvedResourceKeys | null> | ResolvedResourceKeys | null;
}

/** How a tool's real promise eventually settled after its terminal cause won. */
export type ToolLateSettlementOutcome = "resolved" | "rejected";

/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
	/** System prompt included with the request. */
	systemPrompt: string;
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	/** Tools available for this run. */
	tools?: AgentTool<any>[];
}

/**
 * Events emitted by the Agent for UI updates.
 *
 * `agent_end` is the last event emitted for a run, and its subscribers remain
 * part of run settlement. `tool_execution_update` delivery is observation-only:
 * subscriber promises are detached and cannot delay timeout/abort terminality.
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
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
	// Audit-only: a tool's real promise settled *after* a timeout/abort terminal
	// result was already committed. Carries disposition-safe metadata only (no late
	// content/details/error). Never a second tool result or lifecycle end.
	| {
			type: "tool_execution_late_settlement";
			toolCallId: string;
			toolName: string;
			disposition: ToolTimeoutDisposition;
			outcome: ToolLateSettlementOutcome;
	  };
