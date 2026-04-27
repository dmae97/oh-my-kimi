/** Agent class that uses the agent-loop directly.
 * No transport abstraction - calls streamSimple via the loop.
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type CursorExecHandlers,
	type CursorToolResultHandler,
	type Effort,
	getBundledModel,
	type ImageContent,
	type Message,
	type Model,
	type ProviderSessionState,
	type ServiceTier,
	type SimpleStreamOptions,
	streamSimple,
	type TextContent,
	type ThinkingBudgets,
	type ToolChoice,
	type ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { agentLoop, agentLoopContinue } from "./agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentState,
	AgentTool,
	AgentToolContext,
	StreamFn,
	ToolCallContext,
} from "./types";

/**
 * Default convertToLlm: Keep only LLM-compatible messages, convert attachments.
 */
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}

function refreshToolChoiceForActiveTools(
	toolChoice: ToolChoice | undefined,
	tools: AgentContext["tools"] = [],
): ToolChoice | undefined {
	if (!toolChoice || typeof toolChoice === "string") {
		return toolChoice;
	}

	const toolName =
		toolChoice.type === "tool"
			? toolChoice.name
			: "function" in toolChoice
				? toolChoice.function.name
				: toolChoice.name;

	return tools.some(tool => tool.name === toolName) ? toolChoice : undefined;
}

export class AgentBusyError extends Error {
	constructor(
		message: string = "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.",
	) {
		super(message);
		this.name = "AgentBusyError";
	}
}
export interface AgentOptions {
	initialState?: Partial<AgentState>;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 * Default filters to user/assistant/toolResult and converts attachments.
	 */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to context before convertToLlm.
	 * Use for context pruning, injecting external context, etc.
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Steering mode: "all" = send all steering messages at once, "one-at-a-time" = one per turn
	 */
	steeringMode?: "all" | "one-at-a-time";

	/**
	 * Follow-up mode: "all" = send all follow-up messages at once, "one-at-a-time" = one per turn
	 */
	followUpMode?: "all" | "one-at-a-time";

	/**
	 * When to interrupt tool execution for steering messages.
	 * - "immediate": check after each tool call (default)
	 * - "wait": defer steering until the current turn completes
	 */
	interruptMode?: "immediate" | "wait";

	/**
	 * API format for Kimi Code provider: "openai" or "anthropic" (default: "anthropic")
	 */
	kimiApiFormat?: "openai" | "anthropic";

	/** Hint that websocket transport should be preferred when supported by the provider implementation. */
	preferWebsockets?: boolean;

	/**
	 * Custom stream function (for proxy backends, etc.). Default uses streamSimple.
	 */
	streamFn?: StreamFn;

	/**
	 * Optional session identifier forwarded to LLM providers.
	 * Used by providers that support session-based caching (e.g., OpenAI Codex).
	 */
	sessionId?: string;
	/**
	 * Shared provider state map for session-scoped transport/session caches.
	 */
	providerSessionState?: Map<string, ProviderSessionState>;

	/**
	 * Resolves an API key dynamically for each LLM call.
	 * Useful for expiring tokens (e.g., GitHub Copilot OAuth).
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * Inspect or replace provider payloads before they are sent.
	 */
	onPayload?: SimpleStreamOptions["onPayload"];
	/**
	 * Inspect provider response metadata after headers arrive and before streaming body consumption.
	 */
	onResponse?: SimpleStreamOptions["onResponse"];
	/**
	 * Inspect assistant streaming events before they are emitted to subscribers.
	 * Use this when abort decisions must happen before buffered events continue flowing.
	 */
	onAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;
	/**
	 * Custom token budgets for thinking levels (token-based providers only).
	 */
	thinkingBudgets?: ThinkingBudgets;

	/**
	 * Sampling temperature for LLM calls. `undefined` uses provider default.
	 */
	temperature?: number;

	/** Additional sampling controls for providers that support them. */
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
	serviceTier?: ServiceTier;

	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately,
	 * allowing higher-level retry logic to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;

	/**
	 * Provides tool execution context, resolved per tool call.
	 * Use for late-bound UI or session state access.
	 */
	getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;

	/**
	 * Optional transform applied to tool call arguments before execution.
	 * Use for deobfuscating secrets or rewriting arguments.
	 */
	transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => Record<string, unknown>;

	/** Enable intent tracing schema injection/stripping in the harness. */
	intentTracing?: boolean;
	/** Dynamic tool choice override, resolved per LLM call. */
	getToolChoice?: () => ToolChoice | undefined;

	/**
	 * Cursor exec handlers for local tool execution.
	 */
	cursorExecHandlers?: CursorExecHandlers;

	/**
	 * Cursor tool result callback for exec tool responses.
	 */
	cursorOnToolResult?: CursorToolResultHandler;
}

export interface AgentPromptOptions {
	toolChoice?: ToolChoice;
}

/** Buffered Cursor tool result with text position at time of call */
interface CursorToolResultEntry {
	toolResult: ToolResultMessage;
	textLengthAtCall: number;
}

export class Agent {
	#state: AgentState = {
		systemPrompt: "",
		model: getBundledModel("google", "gemini-2.5-flash-lite-preview-06-17"),
		thinkingLevel: undefined,
		tools: [],
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
		error: undefined,
	};

	#listeners = new Set<(e: AgentEvent) => void>();
	#abortController?: AbortController;
	#convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	#transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	#steeringQueue: AgentMessage[] = [];
	#followUpQueue: AgentMessage[] = [];
	#steeringMode: "all" | "one-at-a-time";
	#followUpMode: "all" | "one-at-a-time";
	#interruptMode: "immediate" | "wait";
	#sessionId?: string;
	#providerSessionState?: Map<string, ProviderSessionState>;
	#thinkingBudgets?: ThinkingBudgets;
	#temperature?: number;
	#topP?: number;
	#topK?: number;
	#minP?: number;
	#presencePenalty?: number;
	#repetitionPenalty?: number;
	#serviceTier?: ServiceTier;
	#maxRetryDelayMs?: number;
	#getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;
	#cursorExecHandlers?: CursorExecHandlers;
	#cursorOnToolResult?: CursorToolResultHandler;
	#runningPrompt?: Promise<void>;
	#resolveRunningPrompt?: () => void;
	#kimiApiFormat?: "openai" | "anthropic";
	#preferWebsockets?: boolean;
	#transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => Record<string, unknown>;
	#intentTracing: boolean;
	#getToolChoice?: () => ToolChoice | undefined;
	#onPayload?: SimpleStreamOptions["onPayload"];
	#onResponse?: SimpleStreamOptions["onResponse"];
	#onAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;

	/** Buffered Cursor tool results with text length at time of call (for correct ordering) */
	#cursorToolResultBuffer: CursorToolResultEntry[] = [];

	streamFn: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	constructor(opts: AgentOptions = {}) {
		this.#state = { ...this.#state, ...opts.initialState };
		this.#convertToLlm = opts.convertToLlm || defaultConvertToLlm;
		this.#transformContext = opts.transformContext;
		this.#steeringMode = opts.steeringMode || "one-at-a-time";
		this.#followUpMode = opts.followUpMode || "one-at-a-time";
		this.#interruptMode = opts.interruptMode || "immediate";
		this.streamFn = opts.streamFn || streamSimple;
		this.#sessionId = opts.sessionId;
		this.#providerSessionState = opts.providerSessionState;
		this.#thinkingBudgets = opts.thinkingBudgets;
		this.#temperature = opts.temperature;
		this.#topP = opts.topP;
		this.#topK = opts.topK;
		this.#minP = opts.minP;
		this.#presencePenalty = opts.presencePenalty;
		this.#repetitionPenalty = opts.repetitionPenalty;
		this.#serviceTier = opts.serviceTier;
		this.#maxRetryDelayMs = opts.maxRetryDelayMs;
		this.getApiKey = opts.getApiKey;
		this.#onPayload = opts.onPayload;
		this.#onResponse = opts.onResponse;
		this.#getToolContext = opts.getToolContext;
		this.#cursorExecHandlers = opts.cursorExecHandlers;
		this.#cursorOnToolResult = opts.cursorOnToolResult;
		this.#kimiApiFormat = opts.kimiApiFormat;
		this.#preferWebsockets = opts.preferWebsockets;
		this.#transformToolCallArguments = opts.transformToolCallArguments;
		this.#intentTracing = opts.intentTracing === true;
		this.#getToolChoice = opts.getToolChoice;
		this.#onAssistantMessageEvent = opts.onAssistantMessageEvent;
	}

	/**
	 * Get the current session ID used for provider caching.
	 */
	get sessionId(): string | undefined {
		return this.#sessionId;
	}

	/**
	 * Set the session ID for provider caching.
	 * Call this when switching sessions (new session, branch, resume).
	 */
	set sessionId(value: string | undefined) {
		this.#sessionId = value;
	}

	/**
	 * Get provider-scoped mutable session state store.
	 */
	get providerSessionState(): Map<string, ProviderSessionState> | undefined {
		return this.#providerSessionState;
	}

	/**
	 * Set provider-scoped mutable session state store.
	 */
	set providerSessionState(value: Map<string, ProviderSessionState> | undefined) {
		this.#providerSessionState = value;
	}

	/**
	 * Get the current thinking budgets.
	 */
	get thinkingBudgets(): ThinkingBudgets | undefined {
		return this.#thinkingBudgets;
	}

	/**
	 * Set custom thinking budgets for token-based providers.
	 */
	set thinkingBudgets(value: ThinkingBudgets | undefined) {
		this.#thinkingBudgets = value;
	}

	/**
	 * Get the current sampling temperature.
	 */
	get temperature(): number | undefined {
		return this.#temperature;
	}

	/**
	 * Set sampling temperature for LLM calls. `undefined` uses provider default.
	 */
	set temperature(value: number | undefined) {
		this.#temperature = value;
	}

	get topP(): number | undefined {
		return this.#topP;
	}

	set topP(value: number | undefined) {
		this.#topP = value;
	}

	get topK(): number | undefined {
		return this.#topK;
	}

	set topK(value: number | undefined) {
		this.#topK = value;
	}

	get minP(): number | undefined {
		return this.#minP;
	}

	set minP(value: number | undefined) {
		this.#minP = value;
	}

	get presencePenalty(): number | undefined {
		return this.#presencePenalty;
	}

	set presencePenalty(value: number | undefined) {
		this.#presencePenalty = value;
	}

	get repetitionPenalty(): number | undefined {
		return this.#repetitionPenalty;
	}

	set repetitionPenalty(value: number | undefined) {
		this.#repetitionPenalty = value;
	}

	get serviceTier(): ServiceTier | undefined {
		return this.#serviceTier;
	}

	set serviceTier(value: ServiceTier | undefined) {
		this.#serviceTier = value;
	}

	/**
	 * Get the current max retry delay in milliseconds.
	 */
	get maxRetryDelayMs(): number | undefined {
		return this.#maxRetryDelayMs;
	}

	/**
	 * Set the maximum delay to wait for server-requested retries.
	 * Set to 0 to disable the cap.
	 */
	set maxRetryDelayMs(value: number | undefined) {
		this.#maxRetryDelayMs = value;
	}

	get state(): AgentState {
		return this.#state;
	}

	subscribe(fn: (e: AgentEvent) => void): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	setAssistantMessageEventInterceptor(
		fn: ((message: AssistantMessage, event: AssistantMessageEvent) => void) | undefined,
	): void {
		this.#onAssistantMessageEvent = fn;
	}

	emitExternalEvent(event: AgentEvent) {
		switch (event.type) {
			case "message_start":
			case "message_update":
				this.#state.streamMessage = event.message;
				break;
			case "message_end":
				this.#state.streamMessage = null;
				this.appendMessage(event.message);
				break;
			case "tool_execution_start": {
				const pending = new Set(this.#state.pendingToolCalls);
				pending.add(event.toolCallId);
				this.#state.pendingToolCalls = pending;
				break;
			}
			case "tool_execution_end": {
				const pending = new Set(this.#state.pendingToolCalls);
				pending.delete(event.toolCallId);
				this.#state.pendingToolCalls = pending;
				break;
			}
		}

		this.#emit(event);
	}

	// State mutators
	setSystemPrompt(v: string) {
		this.#state.systemPrompt = v;
	}

	setModel(m: Model) {
		this.#state.model = m;
	}

	setThinkingLevel(l: Effort | undefined) {
		this.#state.thinkingLevel = l;
	}

	setSteeringMode(mode: "all" | "one-at-a-time") {
		this.#steeringMode = mode;
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.#steeringMode;
	}

	setFollowUpMode(mode: "all" | "one-at-a-time") {
		this.#followUpMode = mode;
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.#followUpMode;
	}

	setInterruptMode(mode: "immediate" | "wait") {
		this.#interruptMode = mode;
	}

	getInterruptMode(): "immediate" | "wait" {
		return this.#interruptMode;
	}

	setTools(t: AgentTool<any>[]) {
		this.#state.tools = t;
	}

	replaceMessages(ms: AgentMessage[]) {
		this.#state.messages = ms.slice();
	}

	appendMessage(m: AgentMessage) {
		this.#state.messages = [...this.#state.messages, m];
	}

	popMessage(): AgentMessage | undefined {
		const messages = this.#state.messages.slice(0, -1);
		const removed = this.#state.messages.at(-1);
		this.#state.messages = messages;

		if (removed && this.#state.streamMessage === removed) {
			this.#state.streamMessage = null;
		}

		return removed;
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 * Delivered after current tool execution, skips remaining tools.
	 */
	steer(m: AgentMessage) {
		this.#steeringQueue.push(m);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 */
	followUp(m: AgentMessage) {
		this.#followUpQueue.push(m);
	}

	clearSteeringQueue() {
		this.#steeringQueue = [];
	}

	clearFollowUpQueue() {
		this.#followUpQueue = [];
	}

	clearAllQueues() {
		this.#steeringQueue = [];
		this.#followUpQueue = [];
	}

	hasQueuedMessages(): boolean {
		return this.#steeringQueue.length > 0 || this.#followUpQueue.length > 0;
	}

	#dequeueSteeringMessages(): AgentMessage[] {
		if (this.#steeringMode === "one-at-a-time") {
			if (this.#steeringQueue.length > 0) {
				const first = this.#steeringQueue[0];
				this.#steeringQueue = this.#steeringQueue.slice(1);
				return [first];
			}
			return [];
		}
		const steering = this.#steeringQueue.slice();
		this.#steeringQueue = [];
		return steering;
	}

	#dequeueFollowUpMessages(): AgentMessage[] {
		if (this.#followUpMode === "one-at-a-time") {
			if (this.#followUpQueue.length > 0) {
				const first = this.#followUpQueue[0];
				this.#followUpQueue = this.#followUpQueue.slice(1);
				return [first];
			}
			return [];
		}
		const followUp = this.#followUpQueue.slice();
		this.#followUpQueue = [];
		return followUp;
	}

	/**
	 * Remove and return the last steering message from the queue (LIFO).
	 * Used by dequeue keybinding.
	 */
	popLastSteer(): AgentMessage | undefined {
		return this.#steeringQueue.pop();
	}

	/**
	 * Remove and return the last follow-up message from the queue (LIFO).
	 * Used by dequeue keybinding.
	 */
	popLastFollowUp(): AgentMessage | undefined {
		return this.#followUpQueue.pop();
	}

	clearMessages() {
		this.#state.messages = [];
	}

	abort() {
		this.#abortController?.abort();
	}

	waitForIdle(): Promise<void> {
		return this.#runningPrompt ?? Promise.resolve();
	}

	reset() {
		this.#state.messages = [];
		this.#state.isStreaming = false;
		this.#state.streamMessage = null;
		this.#state.pendingToolCalls = new Set<string>();
		this.#state.error = undefined;
		this.#steeringQueue = [];
		this.#followUpQueue = [];
	}

	/** Send a prompt with an AgentMessage */
	async prompt(message: AgentMessage | AgentMessage[], options?: AgentPromptOptions): Promise<void>;
	async prompt(input: string, options?: AgentPromptOptions): Promise<void>;
	async prompt(input: string, images?: ImageContent[], options?: AgentPromptOptions): Promise<void>;
	async prompt(
		input: string | AgentMessage | AgentMessage[],
		imagesOrOptions?: ImageContent[] | AgentPromptOptions,
		options?: AgentPromptOptions,
	) {
		if (this.#state.isStreaming) {
			throw new AgentBusyError();
		}

		const model = this.#state.model;
		if (!model) throw new Error("No model configured");

		let msgs: AgentMessage[];
		let promptOptions: AgentPromptOptions | undefined;
		let images: ImageContent[] | undefined;

		if (Array.isArray(input)) {
			msgs = input;
			promptOptions = imagesOrOptions as AgentPromptOptions | undefined;
		} else if (typeof input === "string") {
			if (Array.isArray(imagesOrOptions)) {
				images = imagesOrOptions;
				promptOptions = options;
			} else {
				promptOptions = imagesOrOptions;
			}
			const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
			if (images && images.length > 0) {
				content.push(...images);
			}
			msgs = [
				{
					role: "user",
					content,
					timestamp: Date.now(),
				},
			];
		} else {
			msgs = [input];
			promptOptions = imagesOrOptions as AgentPromptOptions | undefined;
		}

		await this.#runLoop(msgs, promptOptions);
	}

	/**
	 * Continue from current context (used for retries and resuming queued messages).
	 */
	async continue() {
		if (this.#state.isStreaming) {
			throw new AgentBusyError();
		}

		const messages = this.#state.messages;
		if (messages.length === 0) {
			throw new Error("No messages to continue from");
		}
		if (messages[messages.length - 1].role === "assistant") {
			const queuedSteering = this.#dequeueSteeringMessages();
			if (queuedSteering.length > 0) {
				await this.#runLoop(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			const queuedFollowUp = this.#dequeueFollowUpMessages();
			if (queuedFollowUp.length > 0) {
				await this.#runLoop(queuedFollowUp);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this.#runLoop(undefined);
	}

	/**
	 * Run the agent loop.
	 * If messages are provided, starts a new conversation turn with those messages.
	 * Otherwise, continues from existing context.
	 */
	async #runLoop(messages?: AgentMessage[], options?: AgentPromptOptions & { skipInitialSteeringPoll?: boolean }) {
		const model = this.#state.model;
		if (!model) throw new Error("No model configured");

		let skipInitialSteeringPoll = options?.skipInitialSteeringPoll === true;

		const { promise, resolve } = Promise.withResolvers<void>();
		this.#runningPrompt = promise;
		this.#resolveRunningPrompt = resolve;

		this.#abortController = new AbortController();
		this.#state.isStreaming = true;
		this.#state.streamMessage = null;
		this.#state.error = undefined;

		// Clear Cursor tool result buffer at start of each run
		this.#cursorToolResultBuffer = [];

		const reasoning = this.#state.thinkingLevel;

		const context: AgentContext = {
			systemPrompt: this.#state.systemPrompt,
			messages: this.#state.messages.slice(),
			tools: this.#state.tools,
		};

		const cursorOnToolResult =
			this.#cursorExecHandlers || this.#cursorOnToolResult
				? async (message: ToolResultMessage) => {
						let finalMessage = message;
						if (this.#cursorOnToolResult) {
							try {
								const updated = await this.#cursorOnToolResult(message);
								if (updated) {
									finalMessage = updated;
								}
							} catch {}
						}
						// Buffer tool result with current text length for correct ordering later.
						// Cursor executes tools server-side during streaming, so the assistant message
						// already incorporates results. We buffer here and emit in correct order
						// when the assistant message ends.
						const textLength = this.#getAssistantTextLength(this.#state.streamMessage);
						this.#cursorToolResultBuffer.push({ toolResult: finalMessage, textLengthAtCall: textLength });
						return finalMessage;
					}
				: undefined;

		const getToolChoice = () =>
			this.#getToolChoice?.() ?? refreshToolChoiceForActiveTools(options?.toolChoice, this.#state.tools);

		const config: AgentLoopConfig = {
			model,
			reasoning,
			temperature: this.#temperature,
			topP: this.#topP,
			topK: this.#topK,
			minP: this.#minP,
			presencePenalty: this.#presencePenalty,
			repetitionPenalty: this.#repetitionPenalty,
			serviceTier: this.#serviceTier,
			interruptMode: this.#interruptMode,
			sessionId: this.#sessionId,
			providerSessionState: this.#providerSessionState,
			thinkingBudgets: this.#thinkingBudgets,
			maxRetryDelayMs: this.#maxRetryDelayMs,
			kimiApiFormat: this.#kimiApiFormat,
			preferWebsockets: this.#preferWebsockets,
			convertToLlm: this.#convertToLlm,
			transformContext: this.#transformContext,
			onPayload: this.#onPayload,
			onResponse: this.#onResponse,
			getApiKey: this.getApiKey,
			getToolContext: this.#getToolContext,
			syncContextBeforeModelCall: async context => {
				if (this.#listeners.size > 0) {
					await Bun.sleep(0);
				}
				context.systemPrompt = this.#state.systemPrompt;
				context.tools = this.#state.tools;
			},
			cursorExecHandlers: this.#cursorExecHandlers,
			cursorOnToolResult,
			transformToolCallArguments: this.#transformToolCallArguments,
			intentTracing: this.#intentTracing,
			onAssistantMessageEvent: this.#onAssistantMessageEvent,
			getToolChoice,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.#dequeueSteeringMessages();
			},
			getFollowUpMessages: async () => this.#dequeueFollowUpMessages(),
		};

		let partial: AgentMessage | null = null;

		try {
			const stream = messages
				? agentLoop(messages, context, config, this.#abortController.signal, this.streamFn)
				: agentLoopContinue(context, config, this.#abortController.signal, this.streamFn);

			for await (const event of stream) {
				// Update internal state based on events
				switch (event.type) {
					case "message_start":
						partial = event.message;
						this.#state.streamMessage = event.message;
						break;

					case "message_update":
						partial = event.message;
						this.#state.streamMessage = event.message;
						break;

					case "message_end":
						partial = null;
						// Check if this is an assistant message with buffered Cursor tool results.
						// If so, split the message to emit tool results at the correct position.
						if (event.message.role === "assistant" && this.#cursorToolResultBuffer.length > 0) {
							this.#emitCursorSplitAssistantMessage(event.message as AssistantMessage);
							continue; // Skip default emit - split method handles everything
						}
						this.#state.streamMessage = null;
						this.appendMessage(event.message);
						break;

					case "tool_execution_start": {
						const s = new Set(this.#state.pendingToolCalls);
						s.add(event.toolCallId);
						this.#state.pendingToolCalls = s;
						break;
					}

					case "tool_execution_end": {
						const s = new Set(this.#state.pendingToolCalls);
						s.delete(event.toolCallId);
						this.#state.pendingToolCalls = s;
						break;
					}

					case "turn_end":
						if (event.message.role === "assistant" && (event.message as any).errorMessage) {
							this.#state.error = (event.message as any).errorMessage;
						}
						break;

					case "agent_end":
						this.#state.isStreaming = false;
						this.#state.streamMessage = null;
						break;
				}

				// Emit to listeners
				this.#emit(event);
			}

			// Handle any remaining partial message
			if (partial && partial.role === "assistant" && partial.content.length > 0) {
				const onlyEmpty = !partial.content.some(
					c =>
						(c.type === "thinking" && c.thinking.trim().length > 0) ||
						(c.type === "text" && c.text.trim().length > 0) ||
						(c.type === "toolCall" && c.name.trim().length > 0),
				);
				if (!onlyEmpty) {
					this.appendMessage(partial);
				} else {
					if (this.#abortController?.signal.aborted) {
						throw new Error("Request was aborted");
					}
				}
			}
		} catch (err: any) {
			const errorMsg: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				api: model.api,
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
				stopReason: this.#abortController?.signal.aborted ? "aborted" : "error",
				errorMessage: err?.message || String(err),
				timestamp: Date.now(),
			} as AgentMessage;

			this.appendMessage(errorMsg);
			this.#state.error = err?.message || String(err);
			this.#emit({ type: "agent_end", messages: [errorMsg] });
		} finally {
			this.#state.isStreaming = false;
			this.#state.streamMessage = null;
			this.#state.pendingToolCalls = new Set<string>();
			this.#abortController = undefined;
			this.#resolveRunningPrompt?.();
			this.#runningPrompt = undefined;
			this.#resolveRunningPrompt = undefined;
		}
	}

	#emit(e: AgentEvent) {
		for (const listener of this.#listeners) {
			listener(e);
		}
	}

	/** Calculate total text length from an assistant message's content blocks */
	#getAssistantTextLength(message: AgentMessage | null): number {
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
			return 0;
		}
		let length = 0;
		for (const block of message.content) {
			if (block.type === "text") {
				length += (block as TextContent).text.length;
			}
		}
		return length;
	}

	/**
	 * Emit a Cursor assistant message split around tool results.
	 * This fixes the ordering issue where tool results appear after the full explanation.
	 *
	 * Output order: Assistant(preamble) -> ToolResults -> Assistant(continuation)
	 */
	#emitCursorSplitAssistantMessage(assistantMessage: AssistantMessage): void {
		const buffer = this.#cursorToolResultBuffer;
		this.#cursorToolResultBuffer = [];

		if (buffer.length === 0) {
			// No tool results, emit normally
			this.#state.streamMessage = null;
			this.appendMessage(assistantMessage);
			this.#emit({ type: "message_end", message: assistantMessage });
			return;
		}

		// Find the split point: minimum text length at first tool call
		const splitPoint = Math.min(...buffer.map(r => r.textLengthAtCall));

		// Extract text content from assistant message
		const content = assistantMessage.content;
		let fullText = "";
		for (const block of content) {
			if (block.type === "text") {
				fullText += block.text;
			}
		}

		// If no text or split point is 0 or at/past end, don't split
		if (fullText.length === 0 || splitPoint <= 0 || splitPoint >= fullText.length) {
			// Emit assistant message first, then tool results (original behavior but with buffered results)
			this.#state.streamMessage = null;
			this.appendMessage(assistantMessage);
			this.#emit({ type: "message_end", message: assistantMessage });

			// Emit buffered tool results
			for (const { toolResult } of buffer) {
				this.#emit({ type: "message_start", message: toolResult });
				this.appendMessage(toolResult);
				this.#emit({ type: "message_end", message: toolResult });
			}
			return;
		}

		// Split the text
		const preambleText = fullText.slice(0, splitPoint);
		const continuationText = fullText.slice(splitPoint);

		// Create preamble message (text before tools)
		const preambleContent = content.map(block => {
			if (block.type === "text") {
				return { ...block, text: preambleText };
			}
			return block;
		});
		const preambleMessage: AssistantMessage = {
			...assistantMessage,
			content: preambleContent,
		};

		// Emit preamble
		this.#state.streamMessage = null;
		this.appendMessage(preambleMessage);
		this.#emit({ type: "message_end", message: preambleMessage });

		// Emit buffered tool results
		for (const { toolResult } of buffer) {
			this.#emit({ type: "message_start", message: toolResult });
			this.appendMessage(toolResult);
			this.#emit({ type: "message_end", message: toolResult });
		}

		// Emit continuation message (text after tools) if non-empty
		const trimmedContinuation = continuationText.trim();
		if (trimmedContinuation.length > 0) {
			// Create continuation message with only text content (no thinking/toolCalls)
			const continuationContent: TextContent[] = [{ type: "text", text: continuationText }];
			const continuationMessage: AssistantMessage = {
				...assistantMessage,
				content: continuationContent,
				// Zero out usage for continuation since it's part of same response
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			this.#emit({ type: "message_start", message: continuationMessage });
			this.appendMessage(continuationMessage);
			this.#emit({ type: "message_end", message: continuationMessage });
		}
	}
}
