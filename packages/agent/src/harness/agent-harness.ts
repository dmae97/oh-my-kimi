import {
	type AssistantMessage,
	type Context,
	type ImageContent,
	isContextOverflow,
	type Model,
	streamSimple,
	type UserMessage,
} from "omk-ai";
import { runAgentLoop, runAgentLoopContinue } from "../agent-loop.ts";
import type { ModelContract } from "../run-model-contract.ts";
import { assertModelContract } from "../run-model-contract.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	QueueMode,
	StreamFn,
	ThinkingLevel,
} from "../types.ts";
import { collectEntriesForBranchSummary } from "./compaction/branch-summarization.ts";
import {
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	prepareCompaction,
	shouldCompact,
} from "./compaction/compaction.ts";
import type { HarnessCompactionRunOptions } from "./compaction/operation.ts";
import { HarnessSessionFacade } from "./harness-session.ts";
import { convertToLlm, createFailureMessage, createUserMessage } from "./messages.ts";
import { findDuplicateNames } from "./name-validation.ts";
import {
	type AttemptLease,
	type OperationLease,
	OperationLifecycleController,
} from "./operation-lifecycle-controller.ts";
import {
	type HarnessAttemptOutcome,
	type HarnessAttemptReason,
	type HarnessOperationKind,
	type HarnessOperationOutcome,
	PROMPT_FAMILY_KINDS,
} from "./operation-lifecycle-types.ts";
import {
	classifyAssistantOutcome,
	classifyAttemptFailure,
	classifyAttemptOutcome,
	classifyNavigateTreeOutcome,
	combineBoundaryErrors,
	normalizeHarnessError,
	resolveOperationFailure,
	resolveOperationOutcome,
} from "./operation-outcome.ts";
import { formatPromptTemplateInvocation } from "./prompt-templates.ts";
import { uuidv7 } from "./session/uuid.ts";
import { type QueuedSessionWrite, SessionWriteCoordinator } from "./session-write-coordinator.ts";
import { formatSkillInvocation } from "./skills.ts";
import { applyStreamOptionsPatch, cloneStreamOptions, mergeHeaders } from "./stream-options.ts";
import { SubscriberFanout } from "./subscriber-fanout.ts";
import { createSummarizationRetry } from "./summarization-retry.ts";
import { resolveNavigationTarget, runBranchSummary } from "./tree-navigation.ts";
import type {
	AbortResult,
	AgentHarnessEvent,
	AgentHarnessEventResultMap,
	AgentHarnessOptions,
	AgentHarnessOwnEvent,
	AgentHarnessPhase,
	AgentHarnessResources,
	AgentHarnessStreamOptions,
	CompactionSettings,
	CompactResult,
	ExecutionEnv,
	HarnessSession,
	NavigateTreeResult,
	PromptTemplate,
	Session,
	Skill,
} from "./types.ts";
import { AgentHarnessError, toError } from "./types.ts";

type AgentHarnessHandler = (event: any, signal?: AbortSignal) => Promise<any> | any;

interface AgentHarnessTurnState<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	messages: AgentMessage[];
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	streamOptions: AgentHarnessStreamOptions;
	sessionId: string;
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: TTool[];
	activeTools: TTool[];
}

export class AgentHarness<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	readonly env: ExecutionEnv;
	private session: Session;
	private readonly sessionFacade: HarnessSession;
	private readonly lifecycle: OperationLifecycleController;
	private readonly sessionWrites: SessionWriteCoordinator<AgentMessage>;
	private model: Model<any>;
	private thinkingLevel: ThinkingLevel;
	private readonly modelContract: ModelContract | undefined;
	private systemPrompt: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["systemPrompt"];
	private streamOptions: AgentHarnessStreamOptions;
	private compactionSettings: CompactionSettings;
	private getApiKeyAndHeaders?: AgentHarnessOptions["getApiKeyAndHeaders"];
	private resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	private tools = new Map<string, TTool>();
	private activeToolNames: string[];
	private steerQueue: UserMessage[] = [];
	private steeringQueueMode: QueueMode;
	private followUpQueue: UserMessage[] = [];
	private followUpQueueMode: QueueMode;
	private nextTurnQueue: AgentMessage[] = [];
	private handlers = new Map<string, Set<AgentHarnessHandler>>();
	private readonly subscribers = new SubscriberFanout<AgentHarnessEvent<TSkill, TPromptTemplate>>();

	constructor(options: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>) {
		this.env = options.env;
		this.session = options.session;
		this.sessionWrites = new SessionWriteCoordinator(this.session);
		this.lifecycle = new OperationLifecycleController({
			createOperationId: () => uuidv7(),
			now: () => Date.now(),
		});
		this.sessionFacade = new HarnessSessionFacade(this.session, () => this.currentPhase(), this.sessionWrites);
		this.resources = options.resources ?? {};
		this.streamOptions = cloneStreamOptions(options.streamOptions);
		this.compactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.compaction };
		this.systemPrompt = options.systemPrompt;
		this.getApiKeyAndHeaders = options.getApiKeyAndHeaders;
		this.validateUniqueNames(
			(options.tools ?? []).map((tool) => tool.name),
			"Duplicate tool name(s)",
		);
		for (const tool of options.tools ?? []) {
			this.tools.set(tool.name, tool);
		}
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.modelContract = options.modelContract;
		this.activeToolNames = options.activeToolNames
			? [...options.activeToolNames]
			: (options.tools ?? []).map((tool) => tool.name);
		this.validateUniqueNames(this.activeToolNames, "Duplicate active tool name(s)");
		this.validateToolNames(this.activeToolNames);
		this.steeringQueueMode = options.steeringMode ?? "one-at-a-time";
		this.followUpQueueMode = options.followUpMode ?? "one-at-a-time";
	}

	private async emitOwn(event: AgentHarnessOwnEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		await this.emitAny(event as AgentHarnessEvent<TSkill, TPromptTemplate>, signal);
	}

	/** Subscriber fan-out; the self-wait barrier lives in `SubscriberFanout`. */
	private async emitAny(event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		await this.subscribers.emit(event, this.lifecycle.getCurrentOperation()?.operationId, signal);
	}

	/** Fail closed when an awaited listener tries to wait on its own operation. */
	private rejectCurrentOperationSelfWait(api: string): void {
		this.subscribers.assertNotSelfWait(api, this.lifecycle.getCurrentOperation()?.operationId);
	}

	private async emitHook<TType extends keyof AgentHarnessEventResultMap>(
		event: Extract<AgentHarnessOwnEvent, { type: TType }>,
	): Promise<AgentHarnessEventResultMap[TType] | undefined> {
		const handlers = this.handlers.get(event.type as TType);
		if (!handlers || handlers.size === 0) return undefined;
		let lastResult: AgentHarnessEventResultMap[TType] | undefined;
		for (const handler of handlers) {
			try {
				const result = await handler(event);
				if (result !== undefined) {
					lastResult = result;
				}
			} catch (error) {
				throw normalizeHarnessError(error, "hook");
			}
		}
		return lastResult;
	}

	private async emitBeforeProviderRequest(
		model: Model<any>,
		sessionId: string,
		streamOptions: AgentHarnessStreamOptions,
	): Promise<AgentHarnessStreamOptions> {
		const handlers = this.handlers.get("before_provider_request");
		let current = cloneStreamOptions(streamOptions);
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			try {
				const result = await handler({
					type: "before_provider_request",
					model,
					sessionId,
					streamOptions: cloneStreamOptions(current),
				});
				if (result?.streamOptions) {
					current = applyStreamOptionsPatch(current, result.streamOptions);
				}
			} catch (error) {
				throw normalizeHarnessError(error, "hook");
			}
		}
		return current;
	}

	private async emitBeforeProviderPayload(model: Model<any>, payload: unknown): Promise<unknown> {
		const handlers = this.handlers.get("before_provider_payload");
		let current = payload;
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			try {
				const result = await handler({ type: "before_provider_payload", model, payload: current });
				if (result !== undefined) {
					current = result.payload;
				}
			} catch (error) {
				throw normalizeHarnessError(error, "hook");
			}
		}
		return current;
	}

	private async emitQueueUpdate(): Promise<void> {
		await this.emitOwn({
			type: "queue_update",
			steer: [...this.steerQueue],
			followUp: [...this.followUpQueue],
			nextTurn: [...this.nextTurnQueue],
		});
	}

	/**
	 * Facade write-gate vocabulary mapped from lifecycle state. `settling` maps
	 * to "idle": the queue is drained by the settlement finalizer first, and
	 * listener writes persist after it through the coordinator tail.
	 */
	private currentPhase(): AgentHarnessPhase {
		const snapshot = this.lifecycle.getSnapshot();
		if (snapshot.tag !== "active") return "idle";
		switch (snapshot.operation.kind) {
			case "manual_compaction":
				return "compaction";
			case "tree_navigation":
				return "branch_summary";
			default:
				return "turn";
		}
	}

	/** Config writes persist immediately outside an active operation and queue during one. */
	private async persistConfigChange(write: QueuedSessionWrite<AgentMessage>): Promise<void> {
		if (this.lifecycle.getSnapshot().tag !== "active") {
			await this.sessionWrites.persistAfterPending(write);
		} else {
			this.sessionWrites.enqueue(write);
		}
	}

	/**
	 * Single wrapper for every public operation: begin a lease, run the body,
	 * then settle exactly once. The final flush and the `settled` event happen
	 * inside the settling barrier; a finalizer failure never reports success.
	 */
	private async runOperation<T>(
		kind: HarnessOperationKind,
		fallbackCode: AgentHarnessError["code"],
		body: (lease: OperationLease) => Promise<T>,
		classifyResult?: (result: T) => HarnessOperationOutcome | undefined,
	): Promise<T> {
		const lease = this.lifecycle.begin(kind);
		let result: T | undefined;
		let bodyError: unknown;
		// Everything after a successful begin() runs inside one capture region. A
		// throwing `operation_started` listener must not escape before settle(),
		// or the lifecycle would stay active and wedge the harness at "busy".
		try {
			await this.emitOwn({ type: "operation_started", operation: lease.operation });
			result = await body(lease);
		} catch (error) {
			bodyError = error;
		}
		// The final flush precedes classification: a persistence failure after a
		// provider success must never record or report a completed operation.
		let flushError: unknown;
		try {
			await this.sessionWrites.flush();
		} catch (error) {
			flushError = error;
		}
		const outcome = resolveOperationOutcome({
			signalAborted: lease.signal.aborted,
			result,
			bodyError,
			flushError,
			classifyResult,
			fallbackCode,
		});
		let settleError: unknown;
		try {
			await this.lifecycle.settle(lease, outcome, async () => {
				await this.emitOwn(
					{
						type: "settled",
						nextTurnCount: this.nextTurnQueue.length,
						operationId: lease.operation.operationId,
						outcome,
						attemptCount: this.lifecycle.getAttemptSummaries(lease).length,
					},
					lease.signal,
				);
			});
		} catch (error) {
			settleError = error;
		}
		const failure = resolveOperationFailure({ bodyError, flushError, settleError, fallbackCode });
		if (failure !== undefined) throw failure;
		return result as T;
	}

	private async createTurnState(): Promise<AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>> {
		const context = await this.session.buildContext();
		const resources = this.getResources();
		const sessionMetadata = await this.session.getMetadata();
		const tools = [...this.tools.values()];
		const activeTools = this.activeToolNames
			.map((name) => this.tools.get(name))
			.filter((tool): tool is TTool => tool !== undefined);
		let systemPrompt = "You are a helpful assistant.";
		if (typeof this.systemPrompt === "string") {
			systemPrompt = this.systemPrompt;
		} else if (this.systemPrompt) {
			systemPrompt = await this.systemPrompt({
				env: this.env,
				session: this.session,
				model: this.model,
				thinkingLevel: this.thinkingLevel,
				activeTools,
				resources,
			});
		}
		return {
			messages: context.messages,
			resources,
			streamOptions: cloneStreamOptions(this.streamOptions),
			sessionId: sessionMetadata.id,
			systemPrompt,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			tools,
			activeTools,
		};
	}

	private createContext(
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		systemPrompt?: string,
	): AgentContext {
		return {
			systemPrompt: systemPrompt ?? turnState.systemPrompt,
			messages: turnState.messages.slice(),
			tools: turnState.activeTools.slice(),
		};
	}

	private createStreamFn(getTurnState: () => AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>): StreamFn {
		return async (model, context, streamOptions) => {
			const turnState = getTurnState();
			const requestContext = await this.maybeAutoCompact(model, context, streamOptions?.signal);
			const auth = await this.getApiKeyAndHeaders?.(model);
			const snapshotOptions: AgentHarnessStreamOptions = {
				...turnState.streamOptions,
				headers: mergeHeaders(turnState.streamOptions.headers, auth?.headers),
			};
			const requestOptions = await this.emitBeforeProviderRequest(model, turnState.sessionId, snapshotOptions);
			return streamSimple(model, requestContext, {
				cacheRetention: requestOptions.cacheRetention,
				headers: requestOptions.headers,
				maxRetries: requestOptions.maxRetries,
				maxRetryDelayMs: requestOptions.maxRetryDelayMs,
				metadata: requestOptions.metadata,
				onPayload: async (payload) => await this.emitBeforeProviderPayload(model, payload),
				onResponse: async (response) => {
					const headers = { ...(response.headers as Record<string, string>) };
					await this.emitOwn(
						{ type: "after_provider_response", status: response.status, headers },
						streamOptions?.signal,
					);
				},
				reasoning: streamOptions?.reasoning,
				signal: streamOptions?.signal,
				sessionId: turnState.sessionId,
				timeoutMs: requestOptions.timeoutMs,
				transport: requestOptions.transport,
				apiKey: auth?.apiKey,
			});
		};
	}

	private async drainQueuedMessages(queue: AgentMessage[], mode: QueueMode): Promise<AgentMessage[]> {
		const messages = mode === "all" ? queue.splice(0) : queue.splice(0, 1);
		if (messages.length === 0) return messages;
		try {
			await this.emitQueueUpdate();
			return messages;
		} catch (error) {
			queue.unshift(...messages);
			throw normalizeHarnessError(error, "hook");
		}
	}

	private createLoopConfig(
		getTurnState: () => AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		setTurnState: (turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => void,
		lease?: OperationLease,
	): AgentLoopConfig {
		const turnState = getTurnState();
		return {
			model: turnState.model,
			reasoning: turnState.thinkingLevel === "off" ? undefined : turnState.thinkingLevel,
			// Single-model boundary (TB21 §7): unset preserves legacy routing.
			...(this.modelContract !== undefined ? { modelContract: this.modelContract } : {}),
			convertToLlm,
			transformContext: async (messages) => {
				const result = await this.emitHook({ type: "context", messages: [...messages] });
				return result?.messages ?? messages;
			},
			beforeToolCall: async ({ toolCall, args }) => {
				const result = await this.emitHook({
					type: "tool_call",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args as Record<string, unknown>,
				});
				return result ? { block: result.block, reason: result.reason } : undefined;
			},
			afterToolCall: async ({ toolCall, args, result, isError }) => {
				const patch = await this.emitHook({
					type: "tool_result",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					isError,
				});
				return patch
					? { content: patch.content, details: patch.details, isError: patch.isError, terminate: patch.terminate }
					: undefined;
			},
			prepareNextTurn: async () => {
				await this.sessionWrites.flush();
				if (lease) {
					const snapshot = this.lifecycle.getSnapshot();
					if (snapshot.tag === "active" && snapshot.stage === "save_point") {
						this.lifecycle.setStage(lease, "attempt_running");
					}
				}
				const nextTurnState = await this.createTurnState();
				setTurnState(nextTurnState);
				return {
					context: this.createContext(nextTurnState),
					model: nextTurnState.model,
					thinkingLevel: nextTurnState.thinkingLevel,
				};
			},
			getSteeringMessages: async () => this.drainQueuedMessages(this.steerQueue, this.steeringQueueMode),
			getFollowUpMessages: async () => this.drainQueuedMessages(this.followUpQueue, this.followUpQueueMode),
		};
	}

	private validateUniqueNames(names: string[], message: string): void {
		const duplicates = findDuplicateNames(names);
		if (duplicates.length > 0)
			throw new AgentHarnessError("invalid_argument", `${message}: ${duplicates.join(", ")}`);
	}

	private validateToolNames(toolNames: string[], tools: Map<string, TTool> = this.tools): void {
		this.validateUniqueNames(toolNames, "Duplicate active tool name(s)");
		const missing = toolNames.filter((name) => !tools.has(name));
		if (missing.length > 0) throw new AgentHarnessError("invalid_argument", `Unknown tool(s): ${missing.join(", ")}`);
	}

	private async handleAgentEvent(event: AgentEvent, signal?: AbortSignal, lease?: OperationLease): Promise<void> {
		if (event.type === "message_end") {
			await this.session.appendMessage(event.message);
			await this.emitAny(event, signal);
			return;
		}
		if (event.type === "turn_end") {
			let eventError: unknown;
			try {
				await this.emitAny(event, signal);
			} catch (error) {
				eventError = error;
			}
			// The flush runs even after a failing listener so accepted writes are
			// not stranded; a failing flush must then report next to that listener
			// error, not in place of it.
			const hadPendingMutations = this.sessionWrites.hasPending();
			let flushError: unknown;
			try {
				await this.sessionWrites.flush();
			} catch (error) {
				flushError = error;
			}
			if (lease) {
				const snapshot = this.lifecycle.getSnapshot();
				if (snapshot.tag === "active" && snapshot.stage === "attempt_running") {
					this.lifecycle.setStage(lease, "save_point");
				}
			}
			const failure = combineBoundaryErrors(
				[eventError, flushError],
				"turn_end listener failed and the save-point flush failed",
				"hook",
			);
			if (failure !== undefined) throw failure;
			await this.emitOwn({ type: "save_point", hadPendingMutations });
			return;
		}
		if (event.type === "agent_end") {
			// agent_end is an attempt event: flush its accepted writes, but lifecycle
			// settlement and the settled event belong to OperationLease.settle().
			await this.sessionWrites.flush();
			await this.emitAny(event, signal);
			return;
		}
		await this.emitAny(event, signal);
	}

	private async emitRunFailure(
		model: Model<any>,
		error: unknown,
		aborted: boolean,
		signal: AbortSignal,
		completedMessages: readonly AgentMessage[],
		lease?: OperationLease,
	): Promise<AgentMessage[]> {
		const failureMessage = createFailureMessage(model, error, aborted);
		const messages = [...completedMessages, failureMessage];
		await this.handleAgentEvent({ type: "message_start", message: failureMessage }, signal, lease);
		await this.handleAgentEvent({ type: "message_end", message: failureMessage }, signal, lease);
		await this.handleAgentEvent({ type: "turn_end", message: failureMessage, toolResults: [] }, signal, lease);
		await this.handleAgentEvent({ type: "agent_end", messages }, signal, lease);
		return messages;
	}

	private async executeTurn(
		lease: OperationLease,
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		text: string,
		options?: { images?: ImageContent[] },
	): Promise<AssistantMessage> {
		let messages: AgentMessage[] = [createUserMessage(text, options?.images)];
		if (this.nextTurnQueue.length > 0) {
			const queuedMessages = this.nextTurnQueue.splice(0);
			try {
				await this.emitQueueUpdate();
			} catch (error) {
				this.nextTurnQueue.unshift(...queuedMessages);
				throw normalizeHarnessError(error, "hook");
			}
			messages = [...queuedMessages, messages[0]!];
		}
		const beforeResult = await this.emitHook({
			type: "before_agent_start",
			prompt: text,
			images: options?.images,
			systemPrompt: turnState.systemPrompt,
			resources: turnState.resources,
		});
		if (beforeResult?.messages) messages = [...messages, ...beforeResult.messages];

		const result = await this.executeAgentRun(
			lease,
			"initial",
			turnState,
			this.createContext(turnState, beforeResult?.systemPrompt),
			messages,
		);
		return await this.recoverContextOverflow(lease, result);
	}

	/**
	 * Sole attempt boundary: begin, announce, run, classify, close, announce, flush.
	 *
	 * Once `beginAttempt()` succeeds the attempt is closed exactly once on every
	 * path, so `count(attempt_started) == count(attempt_finished)` holds even when
	 * the `attempt_started` observer throws. `attempt_finished` is emitted only
	 * after the attempt is already closed, so a throwing observer can fail the
	 * operation but can never reopen committed attempt state. The closing flush
	 * is not a `finally`: a `finally` that awaits a throwing flush would replace
	 * the body error, hiding the provider or listener failure from the audit trail.
	 */
	private async runAttempt<T>(
		lease: OperationLease,
		reason: HarnessAttemptReason,
		body: (attempt: AttemptLease) => Promise<T>,
		classify: (result: T) => HarnessAttemptOutcome,
	): Promise<T> {
		const attemptLease = this.lifecycle.beginAttempt(lease, reason);
		let result: T | undefined;
		let bodyError: unknown;
		try {
			await this.emitOwn({ type: "attempt_started", attempt: attemptLease.attempt }, lease.signal);
			result = await body(attemptLease);
		} catch (error) {
			bodyError = error;
		}
		const outcome: HarnessAttemptOutcome =
			bodyError === undefined ? classify(result as T) : classifyAttemptFailure(bodyError);
		this.lifecycle.finishAttempt(lease, attemptLease, outcome);
		let observerError: unknown;
		try {
			await this.emitOwn(
				{ type: "attempt_finished", summary: this.lifecycle.getAttemptSummary(lease, attemptLease) },
				lease.signal,
			);
		} catch (error) {
			observerError = error;
		}
		let flushError: unknown;
		try {
			await this.sessionWrites.flush();
		} catch (error) {
			flushError = error;
		}
		const failure = combineBoundaryErrors(
			[bodyError, observerError, flushError],
			"Attempt failed and its attempt_finished reporting or closing flush failed",
			"unknown",
		);
		if (failure !== undefined) throw failure;
		return result as T;
	}

	private async executeAgentRun(
		lease: OperationLease,
		reason: HarnessAttemptReason,
		turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
		context: AgentContext,
		initialMessages?: AgentMessage[],
	): Promise<AssistantMessage> {
		let activeTurnState = turnState;
		return await this.runAttempt(
			lease,
			reason,
			async (attemptLease) => {
				const signal = attemptLease.signal;
				const getTurnState = () => activeTurnState;
				const setTurnState = (nextTurnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => {
					activeTurnState = nextTurnState;
				};
				const completedMessages: AgentMessage[] = [];
				const emit = async (event: AgentEvent): Promise<void> => {
					if (event.type === "message_end") completedMessages.push(event.message);
					await this.handleAgentEvent(event, signal, lease);
				};
				let newMessages: AgentMessage[];
				try {
					const loopConfig = this.createLoopConfig(getTurnState, setTurnState, lease);
					const streamFn = this.createStreamFn(getTurnState);
					newMessages = initialMessages
						? await runAgentLoop(initialMessages, context, loopConfig, emit, signal, streamFn)
						: await runAgentLoopContinue(context, loopConfig, emit, signal, streamFn);
				} catch (error) {
					try {
						newMessages = await this.emitRunFailure(
							activeTurnState.model,
							error,
							signal.aborted,
							signal,
							completedMessages,
							lease,
						);
					} catch (failureError) {
						const cause = new AggregateError(
							[toError(error), toError(failureError)],
							"Agent run failed and failure reporting failed",
						);
						throw new AgentHarnessError("unknown", cause.message, cause);
					}
				}
				for (let i = newMessages.length - 1; i >= 0; i--) {
					const message = newMessages[i]!;
					if (message.role === "assistant") return message;
				}
				throw new AgentHarnessError("invalid_state", "AgentHarness prompt completed without an assistant message");
			},
			(message) => classifyAttemptOutcome(message, activeTurnState.model.contextWindow),
		);
	}

	/**
	 * One-shot overflow recovery inside the originating operation. The lease is
	 * proof that this operation still owns the harness, so no run-ownership or
	 * phase re-check is needed; a strict lifecycle makes a newer operation
	 * starting mid-recovery impossible.
	 */
	private async recoverContextOverflow(lease: OperationLease, message: AssistantMessage): Promise<AssistantMessage> {
		if (!this.compactionSettings.enabled || !isContextOverflow(message, this.model.contextWindow)) {
			return message;
		}
		if (!this.getApiKeyAndHeaders) return message;
		const leafId = await this.session.getLeafId();
		if (!leafId) return message;
		const leaf = await this.session.getEntry(leafId);
		if (
			leaf?.type !== "message" ||
			leaf.message.role !== "assistant" ||
			leaf.message.timestamp !== message.timestamp ||
			!isContextOverflow(leaf.message, this.model.contextWindow)
		) {
			return message;
		}

		await this.session.moveTo(leaf.parentId);
		this.lifecycle.setStage(lease, "recovering_overflow");
		try {
			const compacted = await this.runCompaction({ automatic: true, signal: lease.signal });
			if (!compacted) {
				await this.session.moveTo(leafId);
				return message;
			}
			const turnState = await this.createTurnState();
			return await this.executeAgentRun(
				lease,
				"context_overflow_recovery",
				turnState,
				this.createContext(turnState),
			);
		} catch (error) {
			await this.session.moveTo(leafId);
			throw error;
		}
	}

	async prompt(text: string, options?: { images?: ImageContent[] }): Promise<AssistantMessage> {
		return this.runOperation(
			"prompt",
			"unknown",
			async (lease) => {
				const turnState = await this.createTurnState();
				return await this.executeTurn(lease, turnState, text, options);
			},
			classifyAssistantOutcome,
		);
	}

	async skill(name: string, additionalInstructions?: string): Promise<AssistantMessage> {
		return this.runOperation(
			"skill",
			"unknown",
			async (lease) => {
				const turnState = await this.createTurnState();
				const skill = (turnState.resources.skills ?? []).find((candidate) => candidate.name === name);
				if (!skill) throw new AgentHarnessError("invalid_argument", `Unknown skill: ${name}`);
				return await this.executeTurn(lease, turnState, formatSkillInvocation(skill, additionalInstructions));
			},
			classifyAssistantOutcome,
		);
	}

	async promptFromTemplate(name: string, args: string[] = []): Promise<AssistantMessage> {
		return this.runOperation(
			"prompt_template",
			"unknown",
			async (lease) => {
				const turnState = await this.createTurnState();
				const template = (turnState.resources.promptTemplates ?? []).find((candidate) => candidate.name === name);
				if (!template) throw new AgentHarnessError("invalid_argument", `Unknown prompt template: ${name}`);
				return await this.executeTurn(lease, turnState, formatPromptTemplateInvocation(template, args));
			},
			classifyAssistantOutcome,
		);
	}

	/**
	 * Steering and follow-up input is consumed only by a running agent attempt.
	 * A structural operation (`compact`, `navigateTree`) runs none, so accepting
	 * input there would silently inject it into an unrelated later prompt.
	 */
	private expectQueueConsumer(action: string): void {
		const snapshot = this.lifecycle.getSnapshot();
		if (snapshot.tag !== "active") throw new AgentHarnessError("invalid_state", `Cannot ${action} while idle`);
		if (!PROMPT_FAMILY_KINDS.includes(snapshot.operation.kind)) {
			throw new AgentHarnessError(
				"invalid_state",
				`Cannot ${action} during ${snapshot.operation.kind}: no agent attempt can consume it`,
			);
		}
	}

	async steer(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		this.expectQueueConsumer("steer");
		this.steerQueue.push(createUserMessage(text, options?.images));
		await this.emitQueueUpdate();
	}

	async followUp(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		this.expectQueueConsumer("follow up");
		this.followUpQueue.push(createUserMessage(text, options?.images));
		await this.emitQueueUpdate();
	}

	async nextTurn(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		this.nextTurnQueue.push(createUserMessage(text, options?.images));
		await this.emitQueueUpdate();
	}

	getSession(): HarnessSession {
		return this.sessionFacade;
	}

	async appendMessage(message: AgentMessage): Promise<void> {
		await this.sessionFacade.appendMessage(message);
	}

	private async runCompaction(options: HarnessCompactionRunOptions): Promise<CompactResult | undefined> {
		const model = this.model;
		// B2: compaction summary requests pass the same send boundary.
		// A violation fails the compaction (automatic degrades to skipping)
		// instead of sending an out-of-contract provider request.
		if (this.modelContract !== undefined) {
			try {
				assertModelContract(this.modelContract, {
					model: { provider: model.provider, id: model.id },
					provider: model.provider,
					authOrigin: model.provider,
					thinking: this.thinkingLevel !== "off",
				});
			} catch (error) {
				if (options.automatic) return undefined;
				throw error;
			}
		}
		const auth = await this.getApiKeyAndHeaders?.(model);
		if (!auth) {
			if (options.automatic) return undefined;
			throw new AgentHarnessError("auth", "No auth available for compaction");
		}
		const branchEntries = await this.session.getBranch();
		const preparationResult = prepareCompaction(branchEntries, this.compactionSettings);
		if (!preparationResult.ok) throw preparationResult.error;
		const preparation = preparationResult.value;
		if (!preparation) {
			if (options.automatic) return undefined;
			throw new AgentHarnessError("compaction", "Nothing to compact");
		}
		const signal = options.signal ?? new AbortController().signal;
		const hookResult = await this.emitHook({
			type: "session_before_compact",
			preparation,
			branchEntries,
			customInstructions: options.customInstructions,
			signal,
		});
		if (hookResult?.cancel) {
			if (options.automatic) return undefined;
			throw new AgentHarnessError("compaction", "Compaction cancelled");
		}
		const provided = hookResult?.compaction;
		const compactResult = provided
			? { ok: true as const, value: provided }
			: await compact(
					preparation,
					model,
					auth.apiKey,
					auth.headers,
					options.customInstructions,
					signal,
					this.thinkingLevel,
					createSummarizationRetry("compaction", this.streamOptions.summarizationRetry, (event) =>
						this.emitOwn(event),
					),
				);
		if (!compactResult.ok) throw compactResult.error;
		const result = compactResult.value;
		options.beforeCommit?.();
		const entryId = await this.session.appendCompaction(
			result.summary,
			result.firstKeptEntryId,
			result.tokensBefore,
			result.details,
			provided !== undefined,
		);
		const entry = await this.session.getEntry(entryId);
		if (entry?.type === "compaction") {
			await this.emitOwn({ type: "session_compact", compactionEntry: entry, fromHook: provided !== undefined });
		}
		return result;
	}

	private async maybeAutoCompact(model: Model<any>, context: Context, signal?: AbortSignal): Promise<Context> {
		const projected = estimateContextTokens(context.messages).tokens;
		if (!shouldCompact(projected, model.contextWindow ?? 0, this.compactionSettings)) return context;
		const result = await this.runCompaction({ automatic: true, signal });
		if (!result) return context;
		const persisted = await this.session.buildContext();
		return { ...context, messages: convertToLlm(persisted.messages) };
	}

	async compact(customInstructions?: string): Promise<CompactResult> {
		return this.runOperation("manual_compaction", "compaction", async (lease) => {
			this.lifecycle.setStage(lease, "structural_running");
			const result = await this.runCompaction({
				automatic: false,
				customInstructions,
				beforeCommit: () => {
					this.lifecycle.setStage(lease, "committing");
				},
			});
			if (!result) throw new AgentHarnessError("compaction", "Nothing to compact");
			return result;
		});
	}

	async navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<NavigateTreeResult> {
		return this.runOperation(
			"tree_navigation",
			"branch_summary",
			async (lease) => {
				this.lifecycle.setStage(lease, "structural_running");
				const oldLeafId = await this.session.getLeafId();
				// No-op navigation mutates nothing, so it completes without ever
				// entering the `committing` stage.
				if (oldLeafId === targetId) return { cancelled: false };
				const targetEntry = await this.session.getEntry(targetId);
				if (!targetEntry) throw new AgentHarnessError("invalid_argument", `Entry ${targetId} not found`);
				const { entries, commonAncestorId } = await collectEntriesForBranchSummary(
					this.session,
					oldLeafId,
					targetId,
				);
				const preparation = {
					targetId,
					oldLeafId,
					commonAncestorId,
					entriesToSummarize: entries,
					userWantsSummary: options?.summarize ?? false,
					customInstructions: options?.customInstructions,
					replaceInstructions: options?.replaceInstructions,
					label: options?.label,
				};
				const signal = new AbortController().signal;
				const hookResult = await this.emitHook({ type: "session_before_tree", preparation, signal });
				if (hookResult?.cancel) return { cancelled: true };
				let summaryEntry: NavigateTreeResult["summaryEntry"];
				let summaryText: string | undefined = hookResult?.summary?.summary;
				let summaryDetails: unknown = hookResult?.summary?.details;
				if (!summaryText && options?.summarize && entries.length > 0) {
					const model = this.model;
					if (!model) throw new AgentHarnessError("invalid_state", "No model set for branch summary");
					const auth = await this.getApiKeyAndHeaders?.(model);
					if (!auth) throw new AgentHarnessError("auth", "No auth available for branch summary");
					const branchSummary = await runBranchSummary({
						entries,
						model,
						apiKey: auth.apiKey,
						headers: auth.headers,
						customInstructions: hookResult?.customInstructions ?? options?.customInstructions,
						replaceInstructions: hookResult?.replaceInstructions ?? options?.replaceInstructions,
						summarizationRetry: this.streamOptions.summarizationRetry,
						emit: (event) => this.emitOwn(event),
					});
					if (branchSummary.cancelled) return { cancelled: true };
					summaryText = branchSummary.summary;
					summaryDetails = branchSummary.details;
				}
				const { newLeafId, editorText } = resolveNavigationTarget(targetEntry, targetId);
				// Single declared commit point of a tree navigation.
				this.lifecycle.setStage(lease, "committing");
				const summaryId = await this.session.moveTo(
					newLeafId,
					summaryText
						? { summary: summaryText, details: summaryDetails, fromHook: hookResult?.summary !== undefined }
						: undefined,
				);
				if (summaryId) {
					const entry = await this.session.getEntry(summaryId);
					if (entry?.type === "branch_summary") summaryEntry = entry;
				}
				await this.emitOwn({
					type: "session_tree",
					newLeafId: await this.session.getLeafId(),
					oldLeafId,
					summaryEntry,
					fromHook: hookResult?.summary !== undefined,
				});
				return { cancelled: false, editorText, summaryEntry };
			},
			classifyNavigateTreeOutcome,
		);
	}

	getModel(): Model<any> {
		return this.model;
	}

	async setModel(model: Model<any>): Promise<void> {
		try {
			const previousModel = this.model;
			const nextProvider = model.provider;
			const nextModelId = model.id;
			await this.persistConfigChange({ type: "model_change", provider: nextProvider, modelId: nextModelId });
			this.model = model;
			await this.emitOwn({ type: "model_update", model, previousModel, source: "set" });
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	getThinkingLevel(): ThinkingLevel {
		return this.thinkingLevel;
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		try {
			const previousLevel = this.thinkingLevel;
			await this.persistConfigChange({ type: "thinking_level_change", thinkingLevel: level });
			this.thinkingLevel = level;
			await this.emitOwn({ type: "thinking_level_update", level, previousLevel });
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	getTools(): TTool[] {
		return [...this.tools.values()];
	}

	async setTools(tools: TTool[], activeToolNames?: string[]): Promise<void> {
		try {
			this.validateUniqueNames(
				tools.map((tool) => tool.name),
				"Duplicate tool name(s)",
			);
			const nextTools = new Map(tools.map((tool) => [tool.name, tool]));
			const nextActiveToolNames = activeToolNames ? [...activeToolNames] : this.activeToolNames;
			this.validateToolNames(nextActiveToolNames, nextTools);
			const previousToolNames = [...this.tools.keys()];
			const previousActiveToolNames = [...this.activeToolNames];
			await this.persistConfigChange({ type: "active_tools_change", activeToolNames: [...nextActiveToolNames] });
			this.tools = nextTools;
			this.activeToolNames = [...nextActiveToolNames];
			await this.emitOwn({
				type: "tools_update",
				toolNames: [...this.tools.keys()],
				previousToolNames,
				activeToolNames: [...this.activeToolNames],
				previousActiveToolNames,
				source: "set",
			});
		} catch (error) {
			throw normalizeHarnessError(error, "invalid_argument");
		}
	}

	getActiveTools(): TTool[] {
		return this.activeToolNames.map((name) => this.tools.get(name)!);
	}

	async setActiveTools(toolNames: string[]): Promise<void> {
		try {
			const nextActiveToolNames = [...toolNames];
			this.validateToolNames(nextActiveToolNames);
			const previousToolNames = [...this.tools.keys()];
			const previousActiveToolNames = [...this.activeToolNames];
			await this.persistConfigChange({ type: "active_tools_change", activeToolNames: [...nextActiveToolNames] });
			this.activeToolNames = [...nextActiveToolNames];
			await this.emitOwn({
				type: "tools_update",
				toolNames: [...this.tools.keys()],
				previousToolNames,
				activeToolNames: [...this.activeToolNames],
				previousActiveToolNames,
				source: "set",
			});
		} catch (error) {
			throw normalizeHarnessError(error, "invalid_argument");
		}
	}

	getSteeringMode(): QueueMode {
		return this.steeringQueueMode;
	}

	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.steeringQueueMode = mode;
	}

	getFollowUpMode(): QueueMode {
		return this.followUpQueueMode;
	}

	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.followUpQueueMode = mode;
	}

	getResources(): AgentHarnessResources<TSkill, TPromptTemplate> {
		return {
			skills: this.resources.skills?.slice(),
			promptTemplates: this.resources.promptTemplates?.slice(),
		};
	}

	async setResources(resources: AgentHarnessResources<TSkill, TPromptTemplate>): Promise<void> {
		const previousResources = this.getResources();
		this.resources = {
			skills: resources.skills?.slice(),
			promptTemplates: resources.promptTemplates?.slice(),
		};
		await this.emitOwn({ type: "resources_update", resources: this.getResources(), previousResources });
	}

	getStreamOptions(): AgentHarnessStreamOptions {
		return cloneStreamOptions(this.streamOptions);
	}

	async setStreamOptions(streamOptions: AgentHarnessStreamOptions): Promise<void> {
		this.streamOptions = cloneStreamOptions(streamOptions);
	}

	async abort(): Promise<AbortResult> {
		// Aborting awaits the captured operation's settlement, so a listener of that
		// same operation must never reach the wait below.
		this.rejectCurrentOperationSelfWait("abort()");
		const snapshot = this.lifecycle.getSnapshot();
		if (snapshot.tag === "active" && snapshot.operation.kind === "manual_compaction") {
			throw new AgentHarnessError("invalid_state", "Cannot abort during compaction");
		}
		if (snapshot.tag === "active" && snapshot.operation.kind === "tree_navigation") {
			throw new AgentHarnessError("invalid_state", "Cannot abort during branch_summary");
		}
		// Capture the current operation before delivering any signal: an operation
		// started later by a settlement listener is never this call's target.
		const capture = this.lifecycle.requestAbort();
		const clearedSteer = this.steerQueue.splice(0);
		const clearedFollowUp = this.followUpQueue.splice(0);
		const errors: Error[] = [];
		try {
			await this.emitQueueUpdate();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			if (capture.target) await capture.target.settled;
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await this.emitOwn({ type: "abort", clearedSteer, clearedFollowUp });
		} catch (error) {
			errors.push(toError(error));
		}
		if (errors.length > 0) {
			const cause = errors.length === 1 ? errors[0]! : new AggregateError(errors, "Abort completed with errors");
			throw normalizeHarnessError(cause, "hook");
		}
		return { clearedSteer, clearedFollowUp };
	}

	async waitForIdle(): Promise<void> {
		this.rejectCurrentOperationSelfWait("waitForIdle()");
		// Delegates to the lifecycle: resolves once no operation is active or settling.
		await this.lifecycle.waitForIdle();
	}

	subscribe(
		listener: (event: AgentHarnessEvent<TSkill, TPromptTemplate>, signal?: AbortSignal) => Promise<void> | void,
	): () => void {
		return this.subscribers.subscribe(listener);
	}

	on<TType extends keyof AgentHarnessEventResultMap>(
		type: TType,
		handler: (
			event: Extract<AgentHarnessOwnEvent, { type: TType }>,
		) => Promise<AgentHarnessEventResultMap[TType]> | AgentHarnessEventResultMap[TType],
	): () => void {
		let handlers = this.handlers.get(type);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(type, handlers);
		}
		handlers.add(handler as AgentHarnessHandler);
		return () => handlers!.delete(handler as AgentHarnessHandler);
	}
}
