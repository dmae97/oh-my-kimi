/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	type Model,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "omk-ai";
import { bindToolIdentity, isPlainArguments } from "./builtin-tool-resource-claims.ts";
import { partitionToolBatchWaves } from "./parallel-tool-batch.ts";
import { scheduleDagLevels } from "./tool-dag-scheduler.ts";
import {
	awaitWithAbort,
	createErrorToolResult,
	createImmutableJsonSnapshot,
	createImmutableSnapshot,
	type ExecutedToolCallOutcome,
	type FinalizedToolCallOutcome,
	finalizeExecutedToolCall,
	parseJsonValue,
	stampToolResultEnvelope,
} from "./tool-execution-boundary.ts";
import { resolveToolTimeoutMs, runToolCallWithTimeout } from "./tool-timeout.ts";
import {
	createSyntheticToolResult,
	inspectTranscriptIntegrity,
	repairTranscriptIntegrity,
} from "./tool-transcript-integrity.ts";
import {
	type AgentContext,
	type AgentEvent,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentTool,
	type AgentToolCall,
	type AgentToolResult,
	createToolResultEnvelope,
	type StreamFn,
	type ToolCallDisposition,
	type ToolResultEnvelope,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface FailureTerminationPlan {
	/** Messages to publish as the run result (closure results + optional failure). */
	messages: AgentMessage[];
	/** Synthetic assistant failure message, or `undefined` when fail-closed. */
	failureMessage: AgentMessage | undefined;
	/** Synthetic tool results used to close an open turn, in source order. */
	closureResults: ToolResultMessage[];
}

/**
 * Decide how to terminate a run after the underlying loop rejected.
 *
 * A synthetic assistant failure may only be appended on top of a transcript
 * whose tool turns are all closed. When `completedMessages` ends with an open
 * tool turn, a safe missing-only closure (synthetic results for the unambiguous
 * missing tail calls) is appended first so the failure assistant never creates
 * an `assistant(tool calls) -> assistant(failure)` interleaving.
 *
 * If the transcript is ambiguous (duplicate/orphan/interleave, or a
 * mid-transcript gap) it is never auto-repaired: the plan returns no failure
 * message so the caller ends the stream without fabricating a turn over
 * corruption. Pure apart from `Date.now()` on the failure message.
 */
export function planFailureTermination(
	completedMessages: readonly AgentMessage[],
	model: Model<any>,
	error: unknown,
	aborted: boolean,
): FailureTerminationPlan {
	const messages = [...completedMessages];
	const closureResults: ToolResultMessage[] = [];

	if (!inspectTranscriptIntegrity(messages).ok) {
		try {
			const repaired = repairTranscriptIntegrity(messages, "Tool result missing; run terminated by error");
			// repairTranscriptIntegrity appends synthetic results only for
			// unambiguous missing tail calls; anything ambiguous throws above.
			for (let i = messages.length; i < repaired.length; i++) {
				const result = createImmutableSnapshot(repaired[i] as ToolResultMessage);
				closureResults.push(result);
				messages.push(result);
			}
		} catch {
			// Ambiguous transcript: never auto-repair. Fail closed without a
			// synthetic assistant turn over a corrupt transcript.
			return { messages, failureMessage: undefined, closureResults: [] };
		}
	}

	const failureMessage: AgentMessage = createImmutableSnapshot({
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: EMPTY_USAGE,
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	});
	return { messages: [...messages, failureMessage], failureMessage, closureResults };
}

/**
 * Terminate the public event stream after the underlying loop rejected.
 *
 * Uses {@link planFailureTermination} so the disposition of any unresolved tool
 * calls matches transcript repair exactly: an unambiguous open turn is closed
 * with synthetic results before a coherent
 * message_start/message_end/turn_end/agent_end sequence for the failure
 * assistant, and an ambiguous transcript fails closed (agent_end only, no
 * fabricated assistant). The stream always settles for `for await` consumers
 * and `stream.result()`.
 */
function endStreamWithFailure(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
	completedMessages: AgentMessage[],
	error: unknown,
	signal?: AbortSignal,
): void {
	const plan = planFailureTermination(completedMessages, config.model, error, signal?.aborted ?? false);

	for (const result of plan.closureResults) {
		stream.push({ type: "message_start", message: result });
		stream.push({ type: "message_end", message: result });
	}

	if (plan.failureMessage) {
		stream.push({ type: "message_start", message: plan.failureMessage });
		stream.push({ type: "message_end", message: plan.failureMessage });
		stream.push({ type: "turn_end", message: plan.failureMessage, toolResults: [] });
	}

	stream.push({ type: "agent_end", messages: plan.messages });
	stream.end(plan.messages);
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();
	const completedMessages: AgentMessage[] = [];

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			if (event.type === "message_end") {
				completedMessages.push(event.message);
			}
			stream.push(event);
		},
		signal,
		streamFn,
	).then(
		(messages) => {
			stream.end(messages);
		},
		(error: unknown) => {
			endStreamWithFailure(stream, config, completedMessages, error, signal);
		},
	);

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	// Guard: the last message must be one the provider can build on. A plain
	// text/thinking assistant turn is acceptable (convertToLlm may merge or the
	// provider supports assistant pre-fill); only an assistant turn that still
	// carries unresolved tool calls is a hard error because the provider will
	// reject the request without matching tool results.
	assertContinuableTranscript(context.messages);

	const stream = createAgentStream();
	const completedMessages: AgentMessage[] = [];

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			if (event.type === "message_end") {
				completedMessages.push(event.message);
			}
			stream.push(event);
		},
		signal,
		streamFn,
	).then(
		(messages) => {
			stream.end(messages);
		},
		(error: unknown) => {
			endStreamWithFailure(stream, config, completedMessages, error, signal);
		},
	);

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = { ...context, messages: [...context.messages, ...prompts] };
	const publish: AgentEventSink = (event) => emit(createImmutableSnapshot(event));

	await publish({ type: "agent_start" });
	await publish({ type: "turn_start" });
	for (const prompt of prompts) {
		await publish({ type: "message_start", message: prompt });
		await publish({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, publish, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	assertContinuableTranscript(context.messages);

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };
	const publish: AgentEventSink = (event) => emit(createImmutableSnapshot(event));

	await publish({ type: "agent_start" });
	await publish({ type: "turn_start" });
	await runLoop(currentContext, newMessages, config, signal, publish, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Validate the full transcript before continuing. Replaces the earlier
 * last-message-only tail check: `assistant(A,B) -> result(A)` and any
 * duplicate/orphan/interleaved structure now fail before the first provider
 * request, not only a trailing assistant message that still carries tool calls.
 *
 * A trailing assistant turn with no tool calls (plain text/thinking) remains
 * continuable, so compaction, session resume, and explicit retries keep working.
 */
function assertContinuableTranscript(messages: AgentMessage[]): void {
	const report = inspectTranscriptIntegrity(messages);
	if (report.ok) {
		return;
	}
	const last = messages[messages.length - 1];
	if (last !== undefined && last.role === "assistant" && last.content.some((block) => block.type === "toolCall")) {
		throw new Error(
			"Cannot continue: the last assistant message has pending tool calls without matching results. " +
				"Add tool results or a new user message before continuing.",
		);
	}
	const summary = report.issues.map((issue) => `${issue.kind}:${issue.toolCallId}`).join(", ");
	throw new Error(
		`Cannot continue: invalid tool transcript (${summary}). ` +
			"Append terminal tool results or repair the transcript before continuing.",
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			// Provider output is untrusted protocol input. Reject duplicate call IDs
			// and every other ambiguous turn before any tool can execute.
			const emittedIntegrity = inspectTranscriptIntegrity(currentContext.messages);
			const emittedAmbiguities = emittedIntegrity.issues.filter((issue) => issue.kind !== "missing_result");
			if (emittedAmbiguities.length > 0) {
				const summary = emittedAmbiguities.map((issue) => `${issue.kind}:${issue.toolCallId}`).join(", ");
				throw new Error(`Refusing tool execution: invalid emitted tool transcript (${summary}).`);
			}

			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				const toolResults: ToolResultMessage[] = [];
				const reason =
					message.stopReason === "aborted"
						? "Operation aborted"
						: "Skipped because the provider terminated before tool execution";
				const disposition = message.stopReason === "aborted" ? "aborted" : "skipped";
				for (const toolCall of toolCalls) {
					const result = createImmutableSnapshot(
						createSyntheticToolResult(toolCall.id, toolCall.name, reason, Date.now(), disposition),
					);
					currentContext.messages.push(result);
					newMessages.push(result);
					toolResults.push(result);
					await emitToolResultMessage(result, emit);
				}
				await emit({ type: "turn_end", message, toolResults });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const toolResults: ToolResultMessage[] = [];
			let stopAfterToolBatch = false;
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				const executedToolBatch = await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;
				stopAfterToolBatch = executedToolBatch.stopRun ?? false;

				if (signal?.aborted) {
					// Close only unresolved calls, preserving finalized results, then stop
					// before hooks, queues, or another provider request.
					const synthesized = await closeAbortedToolBatch(currentContext, toolCalls, toolResults, emit);
					toolResults.push(...synthesized);
					for (const result of toolResults) newMessages.push(result);
					await emit({ type: "turn_end", message, toolResults });
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}

				for (const result of toolResults) newMessages.push(result);
			}

			await emit({ type: "turn_end", message, toolResults });
			if (stopAfterToolBatch) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
			}

			if (
				await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Validate the full transcript before every provider request. This fails
	// fast for `assistant(A,B) -> result(A)` and any duplicate/orphan/interleaved
	// structure that the provider would otherwise reject opaquely.
	const integrityReport = inspectTranscriptIntegrity(context.messages);
	if (!integrityReport.ok) {
		const summary = integrityReport.issues.map((issue) => `${issue.kind}:${issue.toolCallId}`).join(", ");
		throw new Error(
			`Refusing provider request: invalid tool transcript (${summary}). ` +
				"Append terminal tool results or repair the transcript before retrying.",
		);
	}

	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
		const transformedIntegrity = inspectTranscriptIntegrity(messages);
		if (!transformedIntegrity.ok) {
			const summary = transformedIntegrity.issues.map((issue) => `${issue.kind}:${issue.toolCallId}`).join(", ");
			throw new Error(`Refusing provider request: transformed context has an invalid tool transcript (${summary}).`);
		}
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	// dag-v2 is opt-in only. An explicit sequential execution mode takes
	// precedence and continues through the established waves-v1 path below.
	if (config.toolScheduler === "dag-v2" && config.toolExecution !== "sequential") {
		return executeToolCallsDagLevels(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	const toolPolicies = new Map<string, "sequential" | "parallel">();
	for (const tool of currentContext.tools ?? []) {
		if (tool.executionMode) {
			toolPolicies.set(tool.name, tool.executionMode);
		}
	}
	const batchWaves = partitionToolBatchWaves(
		toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments as Record<string, unknown> })),
		{
			cwd: config.cwd ?? process.cwd(),
			toolPolicies,
			allowUnknownParallel: (toolName) => toolPolicies.get(toolName) === "parallel",
		},
	);
	if (
		config.toolExecution === "sequential" ||
		hasSequentialToolCall ||
		batchWaves.every((wave) => wave.length === 1)
	) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	if (batchWaves.length === 1) {
		return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsInWaves(currentContext, assistantMessage, toolCalls, batchWaves, config, signal, emit);
}

/**
 * Execute a partitioned tool-call batch wave by wave: waves run in source
 * order, calls inside a multi-call wave run concurrently, and solo waves run
 * sequentially. Waves are contiguous index runs, so the returned tool result
 * messages keep the model's original tool-call order.
 */
async function executeToolCallsInWaves(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	waves: number[][],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	const waveTerminates: boolean[] = [];
	for (const wave of waves) {
		const waveCalls = wave.map((index) => toolCalls[index]);
		const executedWave =
			waveCalls.length === 1
				? await executeToolCallsSequential(currentContext, assistantMessage, waveCalls, config, signal, emit)
				: await executeToolCallsParallel(currentContext, assistantMessage, waveCalls, config, signal, emit);
		messages.push(...executedWave.messages);
		waveTerminates.push(executedWave.terminate);
		if (signal?.aborted) break;
	}
	return {
		messages,
		terminate: waveTerminates.length > 0 && waveTerminates.every(Boolean),
	};
}

/**
 * Execute a tool-call batch using the dag-v2 scheduler.
 *
 * Initial planning applies only the pure argument compatibility shim. Each
 * candidate level authorizes calls, re-resolves claims from exact final args,
 * and emits lifecycle starts only when a final safe sublevel begins. Results
 * remain globally buffered and are emitted in source order.
 */
async function executeToolCallsDagLevels(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const plans = toolCalls.map((toolCall) => planToolCall(currentContext, toolCall));
	const boundTools = plans.flatMap((plan) => (plan.kind === "planned" ? [plan.tool] : []));
	const toolPolicies = new Map<string, "sequential" | "parallel">();
	for (const tool of boundTools) {
		if (tool.executionMode && !toolPolicies.has(tool.name)) toolPolicies.set(tool.name, tool.executionMode);
	}

	const claimableCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
	for (const plan of plans) {
		if (plan.kind === "immediate" || !isPlainArguments(plan.args)) {
			claimableCalls.length = 0;
			break;
		}
		claimableCalls.push({ id: plan.toolCall.id, name: plan.toolCall.name, arguments: plan.args });
	}
	let levels: number[][];
	if (claimableCalls.length === toolCalls.length) {
		const scheduled = await awaitWithAbort(
			() =>
				scheduleDagLevels(claimableCalls, {
					cwd: config.cwd ?? process.cwd(),
					toolPolicies,
					registeredTools: boundTools,
					strictExtensionClaims: config.strictExtensionClaims,
					maxConcurrency: config.maxToolConcurrency,
					resourceKeyResolver: config.resourceKeyResolver,
				}),
			signal,
		);
		levels = scheduled.kind === "aborted" ? [] : scheduled.value.levels;
	} else {
		levels = toolCalls.map((_toolCall, sourceIndex) => [sourceIndex]);
	}

	const finalizedByIndex: Array<FinalizedToolCallOutcome | undefined> = new Array(toolCalls.length).fill(undefined);
	let skippedReason: string | undefined;
	let stoppedByUnsettledTimeout = false;

	for (const level of levels) {
		if (signal?.aborted) break;
		const executedLevel = await runDagLevelCalls(
			currentContext,
			assistantMessage,
			level,
			toolCalls,
			plans,
			toolPolicies,
			config,
			signal,
			emit,
		);
		for (const outcome of executedLevel.outcomes) finalizedByIndex[outcome.sourceIndex] = outcome.finalized;
		if (signal?.aborted) break;
		if (executedLevel.stoppedByUnsettledTimeout) {
			skippedReason = "Skipped because a preceding DAG tool timed out before its execution promise settled";
			stoppedByUnsettledTimeout = true;
			break;
		}
		if (shouldTerminateToolBatch(executedLevel.outcomes.map((outcome) => outcome.finalized))) {
			skippedReason = "Skipped because the preceding DAG level requested termination";
			break;
		}
	}

	const messages: ToolResultMessage[] = [];
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	for (let index = 0; index < toolCalls.length; index++) {
		const finalized = finalizedByIndex[index];
		if (finalized) {
			messages.push(createToolResultMessage(finalized));
			finalizedCalls.push(finalized);
		} else if (signal?.aborted) {
			const toolCall = toolCalls[index];
			messages.push(
				createImmutableSnapshot(createSyntheticToolResult(toolCall.id, toolCall.name, "Operation aborted")),
			);
		} else if (skippedReason !== undefined) {
			const toolCall = toolCalls[index];
			messages.push(
				createImmutableSnapshot(
					createSyntheticToolResult(toolCall.id, toolCall.name, skippedReason, Date.now(), "skipped"),
				),
			);
		}
	}
	// Close the full source-ordered batch before result notification; calls not
	// reached by a candidate level receive no execution lifecycle.
	for (const message of messages) {
		currentContext.messages.push(message);
		try {
			await emitToolResultMessage(message, emit);
		} finally {
			finalizedCalls.find(({ toolCall }) => toolCall.id === message.toolCallId)?.commitTerminal?.();
		}
	}

	return {
		messages,
		terminate: skippedReason !== undefined || shouldTerminateToolBatch(finalizedCalls),
		stopRun: stoppedByUnsettledTimeout,
	};
}

type DagLevelOutcome = { sourceIndex: number; finalized: FinalizedToolCallOutcome };

/** Authorize one candidate DAG level, re-plan final claims, and run its safe sublevels. */
async function runDagLevelCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	levelIndices: readonly number[],
	toolCalls: AgentToolCall[],
	plans: Array<PlannedToolCall | ImmediateToolCallOutcome>,
	toolPolicies: ReadonlyMap<string, "sequential" | "parallel">,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<{ outcomes: DagLevelOutcome[]; stoppedByUnsettledTimeout: boolean }> {
	const outcomes: DagLevelOutcome[] = [];
	const runnable: Array<{ sourceIndex: number; preparation: PreparedToolCall }> = [];

	for (const sourceIndex of levelIndices) {
		const toolCall = toolCalls[sourceIndex];
		const plan = plans[sourceIndex];
		const preparation =
			plan.kind === "immediate"
				? plan
				: await authorizePlannedToolCall(currentContext, assistantMessage, plan, config, signal);
		if (preparation.kind === "immediate") {
			outcomes.push({
				sourceIndex,
				finalized: {
					toolCall,
					result: preparation.result,
					isError: preparation.isError,
					envelope: preparation.envelope,
				},
			});
		} else {
			runnable.push({ sourceIndex, preparation });
		}
		if (signal?.aborted) return { outcomes, stoppedByUnsettledTimeout: false };
	}

	const finalClaimableCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
	for (const { preparation } of runnable) {
		if (!isPlainArguments(preparation.args)) {
			finalClaimableCalls.length = 0;
			break;
		}
		finalClaimableCalls.push({
			id: preparation.toolCall.id,
			name: preparation.toolCall.name,
			arguments: preparation.args,
		});
	}

	let executionLevels: number[][];
	if (finalClaimableCalls.length === runnable.length) {
		const scheduled = await awaitWithAbort(
			() =>
				scheduleDagLevels(finalClaimableCalls, {
					cwd: config.cwd ?? process.cwd(),
					toolPolicies,
					registeredTools: runnable.map(({ preparation }) => preparation.tool),
					strictExtensionClaims: config.strictExtensionClaims,
					maxConcurrency: config.maxToolConcurrency,
					resourceKeyResolver: config.resourceKeyResolver,
				}),
			signal,
		);
		if (scheduled.kind === "aborted") return { outcomes, stoppedByUnsettledTimeout: false };
		executionLevels = scheduled.value.levels;
	} else {
		executionLevels = runnable.map((_entry, index) => [index]);
	}

	for (const executionLevel of executionLevels) {
		if (signal?.aborted) break;
		for (const entryIndex of executionLevel) {
			await emitToolExecutionStart(runnable[entryIndex].preparation, emit);
		}
		const finalizedLevel = await Promise.all(
			executionLevel.map(async (entryIndex): Promise<DagLevelOutcome> => {
				const entry = runnable[entryIndex];
				const executed = await executePreparedToolCall(entry.preparation, config, signal, emit);
				const finalized = await finalizeExecutedToolCall({
					currentContext,
					assistantMessage,
					prepared: entry.preparation,
					executed,
					afterToolCall: config.afterToolCall,
					signal,
				});
				await emitToolExecutionEnd(finalized, emit);
				return { sourceIndex: entry.sourceIndex, finalized };
			}),
		);
		outcomes.push(...finalizedLevel);
		if (signal?.aborted) break;
		if (
			finalizedLevel.some(
				({ finalized }) =>
					finalized.envelope.disposition === "timeout" && finalized.isRealPromiseSettled?.() === false,
			)
		) {
			return { outcomes, stoppedByUnsettledTimeout: true };
		}
	}
	return { outcomes, stoppedByUnsettledTimeout: false };
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
	stopRun?: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
				envelope: preparation.envelope,
			};
		} else {
			await emitToolExecutionStart(preparation, emit);
			const executed = await executePreparedToolCall(preparation, config, signal, emit);
			finalized = await finalizeExecutedToolCall({
				currentContext,
				assistantMessage,
				prepared: preparation,
				executed,
				afterToolCall: config.afterToolCall,
				signal,
			});
		}

		const toolResultMessage = createToolResultMessage(finalized);
		currentContext.messages.push(toolResultMessage);
		if (preparation.kind === "prepared") await emitToolExecutionEnd(finalized, emit);
		try {
			await emitToolResultMessage(toolResultMessage, emit);
		} finally {
			finalized.commitTerminal?.();
		}
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
				envelope: preparation.envelope,
			} satisfies FinalizedToolCallOutcome;
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			await emitToolExecutionStart(preparation, emit);
			const executed = await executePreparedToolCall(preparation, config, signal, emit);
			const finalized = await finalizeExecutedToolCall({
				currentContext,
				assistantMessage,
				prepared: preparation,
				executed,
				afterToolCall: config.afterToolCall,
				signal,
			});
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		currentContext.messages.push(toolResultMessage);
		try {
			await emitToolResultMessage(toolResultMessage, emit);
		} finally {
			finalized.commitTerminal?.();
		}
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PlannedToolCall = {
	kind: "planned";
	toolCall: AgentToolCall;
	preparedToolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	/** Immutable scheduler/executor arguments fixed after the authorization hook. */
	args: unknown;
	/** Separate immutable public-event snapshot. */
	eventArgs: unknown;
	/** Effective per-call timeout in ms resolved by precedence; 0 disables it. */
	timeoutMs: number;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
	envelope: ToolResultEnvelope;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

function immediateOutcome(disposition: ToolCallDisposition, reason: string): ImmediateToolCallOutcome {
	return {
		kind: "immediate",
		result: createErrorToolResult(reason),
		isError: true,
		envelope: createToolResultEnvelope({ disposition, synthetic: true, executionStarted: false, reason }),
	};
}

function planToolCall(
	currentContext: AgentContext,
	untrustedToolCall: AgentToolCall,
): PlannedToolCall | ImmediateToolCallOutcome {
	try {
		const toolCall = createImmutableJsonSnapshot(untrustedToolCall);
		if (toolCall.id.length === 0 || toolCall.name.length === 0) throw new TypeError("Invalid empty tool identity");
		const candidate = currentContext.tools?.find((tool) => tool.name === toolCall.name);
		if (!candidate) return immediateOutcome("failed", `Tool ${toolCall.name} not found`);
		const tool = bindToolIdentity(candidate, toolCall.name);
		const prepared = prepareToolCallArguments(tool, toolCall);
		const args = createImmutableJsonSnapshot(prepared.arguments);
		const preparedToolCall = createImmutableSnapshot({ ...toolCall, arguments: args });
		return { kind: "planned", toolCall, preparedToolCall, tool, args };
	} catch (error) {
		return immediateOutcome("failed", error instanceof Error ? error.message : String(error));
	}
}

async function authorizePlannedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	plan: PlannedToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	try {
		const hookArgs = parseJsonValue(validateToolArguments(plan.tool, plan.preparedToolCall));
		const beforeToolCall = config.beforeToolCall;
		if (beforeToolCall) {
			const bounded = await awaitWithAbort(
				() =>
					beforeToolCall(
						{
							assistantMessage: createImmutableSnapshot(assistantMessage),
							toolCall: plan.toolCall,
							args: hookArgs,
							context: currentContext,
						},
						signal,
					),
				signal,
			);
			if (bounded.kind === "aborted" || signal?.aborted) return immediateOutcome("aborted", "Operation aborted");
			if (bounded.value?.block) {
				return immediateOutcome("blocked", bounded.value.reason || "Tool execution was blocked");
			}
		}
		if (signal?.aborted) return immediateOutcome("aborted", "Operation aborted");
		const args = createImmutableJsonSnapshot(hookArgs);
		return {
			kind: "prepared",
			toolCall: plan.toolCall,
			tool: plan.tool,
			args,
			eventArgs: createImmutableSnapshot(args),
			timeoutMs: resolveToolTimeoutMs(plan.tool, config, plan.toolCall.name),
		};
	} catch (error) {
		return immediateOutcome("failed", error instanceof Error ? error.message : String(error));
	}
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const plan = planToolCall(currentContext, toolCall);
	return plan.kind === "immediate"
		? plan
		: authorizePlannedToolCall(currentContext, assistantMessage, plan, config, signal);
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	let realPromiseSettled = false;
	let commitTerminal = (): void => {};
	const terminalCommitted = new Promise<void>((resolve) => {
		commitTerminal = resolve;
	});
	const executed = await runToolCallWithTimeout({
		toolCallId: prepared.toolCall.id,
		toolName: prepared.toolCall.name,
		timeoutMs: prepared.timeoutMs,
		lateSettlement: config.toolExecutionPolicy?.lateSettlement,
		signal,
		start: async (childSignal, onUpdate) => {
			try {
				return await prepared.tool.execute(prepared.toolCall.id, prepared.args as never, childSignal, onUpdate);
			} finally {
				realPromiseSettled = true;
			}
		},
		emitUpdate: (partialResult) =>
			emit({
				type: "tool_execution_update",
				toolCallId: prepared.toolCall.id,
				toolName: prepared.toolCall.name,
				args: prepared.eventArgs,
				partialResult: createImmutableSnapshot(partialResult),
			}),
		emitLateSettlement: async (settlement) => {
			await terminalCommitted;
			await emit({
				type: "tool_execution_late_settlement",
				toolCallId: settlement.toolCallId,
				toolName: settlement.toolName,
				disposition: settlement.disposition,
				outcome: settlement.outcome,
			});
		},
		toErrorResult: (error) => createErrorToolResult(error instanceof Error ? error.message : String(error)),
	});
	return { ...executed, isRealPromiseSettled: () => realPromiseSettled, commitTerminal };
}

async function emitToolExecutionStart(prepared: PreparedToolCall, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_start",
		toolCallId: prepared.toolCall.id,
		toolName: prepared.toolCall.name,
		args: prepared.eventArgs,
	});
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: createImmutableSnapshot(finalized.result),
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return createImmutableSnapshot({
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		details: stampToolResultEnvelope(finalized.result.details, finalized.envelope),
		isError: finalized.isError,
		timestamp: Date.now(),
	});
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}

/** Commit and notify one aborted terminal for each unresolved, unstarted call. */
async function closeAbortedToolBatch(
	currentContext: AgentContext,
	toolCalls: AgentToolCall[],
	existingResults: ToolResultMessage[],
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const resolvedIds = new Set(existingResults.map((result) => result.toolCallId));
	const synthesized: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		if (resolvedIds.has(toolCall.id)) {
			continue;
		}
		const result = createImmutableSnapshot(
			createSyntheticToolResult(toolCall.id, toolCall.name, "Operation aborted"),
		);
		currentContext.messages.push(result);
		await emit({ type: "message_start", message: result });
		await emit({ type: "message_end", message: result });
		synthesized.push(result);
		// Guard against a duplicated call id within the same assistant message.
		resolvedIds.add(toolCall.id);
	}
	return synthesized;
}
