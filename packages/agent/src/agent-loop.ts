/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@oh-my-pi/pi-ai";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	StreamFn,
} from "./types";

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

	(async () => {
		const newMessages: AgentMessage[] = [...prompts];
		const currentContext: AgentContext = {
			...context,
			messages: [...context.messages, ...prompts],
		};

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });
		for (const prompt of prompts) {
			stream.push({ type: "message_start", message: prompt });
			stream.push({ type: "message_end", message: prompt });
		}

		await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
	})();

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

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [];
		const currentContext: AgentContext = { ...context };

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });

		await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
	})();

	return stream;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

function normalizeMessagesForProvider(
	messages: Context["messages"],
	model: AgentLoopConfig["model"],
): Context["messages"] {
	if (model.provider !== "cerebras") {
		return messages;
	}

	let changed = false;
	const normalized = messages.map(message => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			return message;
		}

		const filtered = message.content.filter(block => block.type !== "thinking");
		if (filtered.length === message.content.length) {
			return message;
		}

		changed = true;
		return { ...message, content: filtered };
	});

	return changed ? normalized : messages;
}

export const INTENT_FIELD = "_i";

function injectIntentIntoSchema(schema: unknown, mode: "require" | "optional" = "require"): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
	const schemaRecord = schema as Record<string, unknown>;
	const propertiesValue = schemaRecord.properties;
	const properties =
		propertiesValue && typeof propertiesValue === "object" && !Array.isArray(propertiesValue)
			? (propertiesValue as Record<string, unknown>)
			: {};
	const requiredValue = schemaRecord.required;
	const required = Array.isArray(requiredValue)
		? requiredValue.filter((item): item is string => typeof item === "string")
		: [];
	if (INTENT_FIELD in properties) {
		const { [INTENT_FIELD]: intentProp, ...rest } = properties;
		const needsReorder = Object.keys(properties)[0] !== INTENT_FIELD;
		const needsRequired = mode === "require" && !required.includes(INTENT_FIELD);
		if (!needsReorder && !needsRequired) return schema;
		return {
			...schemaRecord,
			...(needsReorder ? { properties: { [INTENT_FIELD]: intentProp, ...rest } } : {}),
			...(needsRequired ? { required: [...required, INTENT_FIELD] } : {}),
		};
	}
	return {
		...schemaRecord,
		properties: {
			[INTENT_FIELD]: {
				type: "string",
			},
			...properties,
		},
		...(mode === "require" ? { required: [...required, INTENT_FIELD] } : {}),
	};
}

function normalizeTools(tools: AgentContext["tools"], injectIntent: boolean): Context["tools"] {
	injectIntent = injectIntent && Bun.env.PI_NO_INTENT !== "1";
	return tools?.map(t => {
		const intentMode = resolveIntentMode(t.intent);
		const parameters =
			injectIntent && intentMode !== "omit"
				? (injectIntentIntoSchema(t.parameters, intentMode) as typeof t.parameters)
				: t.parameters;
		const description = t.description ?? "";
		return { ...t, parameters, description };
	});
}

function resolveIntentMode(intent: AgentTool["intent"]): "require" | "optional" | "omit" {
	if (typeof intent === "function") return "omit";
	if (intent === "optional" || intent === "omit") return intent;
	return "require";
}

function extractIntent(args: Record<string, unknown>): { intent?: string; strippedArgs: Record<string, unknown> } {
	const { [INTENT_FIELD]: intent, ...strippedArgs } = args;
	if (typeof intent !== "string") {
		return { strippedArgs };
	}
	const trimmed = intent.trim();
	return { intent: trimmed.length > 0 ? trimmed : undefined, strippedArgs };
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				stream.push({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					stream.push({ type: "message_start", message });
					stream.push({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Refresh prompt/tool context from live state before each model call
			if (config.syncContextBeforeModelCall) {
				await config.syncContextBeforeModelCall(currentContext);
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, stream, streamFn);
			newMessages.push(message);
			let steeringMessagesFromExecution: AgentMessage[] | undefined;

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				// Create placeholder tool results for any tool calls in the aborted message
				// This maintains the tool_use/tool_result pairing that the API requires
				type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
				const toolCalls = message.content.filter((c): c is ToolCallContent => c.type === "toolCall");
				const toolResults: ToolResultMessage[] = [];
				for (const toolCall of toolCalls) {
					const result = createAbortedToolResult(toolCall, stream, message.stopReason, message.errorMessage);
					currentContext.messages.push(result);
					newMessages.push(result);
					toolResults.push(result);
				}
				stream.push({ type: "turn_end", message, toolResults });
				stream.push({ type: "agent_end", messages: newMessages });
				stream.end(newMessages);
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter(c => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				const executionResult = await executeToolCalls(
					currentContext.tools,
					message,
					signal,
					stream,
					config.getSteeringMessages,
					config.interruptMode,
					config.getToolContext,
					config.transformToolCallArguments,
					config.intentTracing,
				);

				toolResults.push(...executionResult.toolResults);
				steeringMessagesFromExecution = executionResult.steeringMessages;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			stream.push({ type: "turn_end", message, toolResults });

			pendingMessages = steeringMessagesFromExecution ?? ((await config.getSteeringMessages?.()) || []);
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

	stream.push({ type: "agent_end", messages: newMessages });
	stream.end(newMessages);
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);
	const normalizedMessages = normalizeMessagesForProvider(llmMessages, config.model);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: normalizedMessages,
		tools: normalizeTools(context.tools, !!config.intentTracing),
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const dynamicToolChoice = config.getToolChoice?.();
	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		toolChoice: dynamicToolChoice ?? config.toolChoice,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	const responseIterator = response[Symbol.asyncIterator]();
	while (true) {
		const read = await readResponseEvent(responseIterator, signal);
		if (read.type === "aborted") {
			return emitAbortedAssistantMessage(partialMessage, addedPartial, context, config, stream);
		}
		if (read.type === "error") {
			throw read.error;
		}
		if (read.result.done) {
			break;
		}

		const event = read.result.value;
		// Check for abort signal before processing each event
		if (signal?.aborted) {
			return emitAbortedAssistantMessage(partialMessage, addedPartial, context, config, stream);
		}

		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				stream.push({ type: "message_start", message: { ...partialMessage } });
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
					config.onAssistantMessageEvent?.(partialMessage, event);
					if (signal?.aborted) {
						continue;
					}
					stream.push({
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
					stream.push({ type: "message_start", message: { ...finalMessage } });
				}
				stream.push({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	return await response.result();
}

type ResponseEventRead =
	| { type: "event"; result: IteratorResult<AssistantMessageEvent> }
	| { type: "error"; error: unknown }
	| { type: "aborted" };

async function readResponseEvent(
	iterator: AsyncIterator<AssistantMessageEvent>,
	signal: AbortSignal | undefined,
): Promise<ResponseEventRead> {
	if (!signal) {
		return { type: "event", result: await iterator.next() };
	}
	if (signal.aborted) {
		const returnPromise = iterator.return?.();
		if (returnPromise) void returnPromise.catch(() => {});
		return { type: "aborted" };
	}

	const { promise: abortPromise, resolve: resolveAbort } = Promise.withResolvers<ResponseEventRead>();
	const onAbort = () => resolveAbort({ type: "aborted" });
	signal.addEventListener("abort", onAbort, { once: true });

	const eventPromise = iterator.next().then(
		result => ({ type: "event" as const, result }),
		error => ({ type: "error" as const, error }),
	);

	try {
		const read = await Promise.race([eventPromise, abortPromise]);
		if (read.type === "aborted") {
			const returnPromise = iterator.return?.();
			if (returnPromise) void returnPromise.catch(() => {});
		}
		return read;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function emitAbortedAssistantMessage(
	partialMessage: AssistantMessage | null,
	addedPartial: boolean,
	context: AgentContext,
	config: AgentLoopConfig,
	stream: EventStream<AgentEvent, AgentMessage[]>,
): AssistantMessage {
	const errorMessage = "Request was aborted";
	const abortedMessage: AssistantMessage = partialMessage
		? { ...partialMessage, stopReason: "aborted", errorMessage }
		: {
				role: "assistant",
				content: [],
				api: config.model.api,
				provider: config.model.provider,
				model: config.model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "aborted",
				errorMessage,
				timestamp: Date.now(),
			};
	if (addedPartial) {
		context.messages[context.messages.length - 1] = abortedMessage;
	} else {
		context.messages.push(abortedMessage);
		stream.push({ type: "message_start", message: { ...abortedMessage } });
	}
	stream.push({ type: "message_end", message: abortedMessage });
	return abortedMessage;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	tools: AgentTool<any>[] | undefined,
	assistantMessage: AssistantMessage,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	getSteeringMessages?: AgentLoopConfig["getSteeringMessages"],
	interruptMode: AgentLoopConfig["interruptMode"] = "immediate",
	getToolContext?: AgentLoopConfig["getToolContext"],
	transformToolCallArguments?: AgentLoopConfig["transformToolCallArguments"],
	intentTracing?: AgentLoopConfig["intentTracing"],
): Promise<{ toolResults: ToolResultMessage[]; steeringMessages?: AgentMessage[] }> {
	type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
	const toolCalls = assistantMessage.content.filter((c): c is ToolCallContent => c.type === "toolCall");
	const emittedToolResults: ToolResultMessage[] = [];
	const toolCallInfos = toolCalls.map(call => ({ id: call.id, name: call.name }));
	const batchId = `${assistantMessage.timestamp ?? Date.now()}_${toolCalls[0]?.id ?? "batch"}`;
	const shouldInterruptImmediately = interruptMode !== "wait";
	const steeringAbortController = new AbortController();
	const toolSignal = signal
		? AbortSignal.any([signal, steeringAbortController.signal])
		: steeringAbortController.signal;
	const interruptState = { triggered: false };
	let steeringMessages: AgentMessage[] | undefined;
	let steeringCheck: Promise<void> | null = null;

	const records = toolCalls.map(toolCall => ({
		toolCall,
		// Tools emitted via OpenAI's custom-tool path (e.g. `apply_patch` on GPT-5)
		// come back under their wire-level name, which may differ from the
		// harness-internal `name`. Match on either, preferring `name` for
		// determinism if both somehow collide.
		tool:
			tools?.find(t => t.name === toolCall.name) ??
			tools?.find(t => t.customWireName !== undefined && t.customWireName === toolCall.name),
		args: toolCall.arguments as Record<string, unknown>,
		started: false,
		result: undefined as AgentToolResult<any> | undefined,
		isError: false,
		skipped: false,
		toolResultMessage: undefined as ToolResultMessage | undefined,
		resultEmitted: false,
	}));

	const checkSteering = async (): Promise<void> => {
		if (!shouldInterruptImmediately || !getSteeringMessages || interruptState.triggered) {
			return;
		}
		if (steeringCheck) {
			await steeringCheck;
			return;
		}
		steeringCheck = (async () => {
			const steering = await getSteeringMessages();
			if (steering.length > 0) {
				steeringMessages = steering;
				interruptState.triggered = true;
				steeringAbortController.abort();
			}
		})().finally(() => {
			steeringCheck = null;
		});
		await steeringCheck;
	};

	const emitToolResult = (record: (typeof records)[number], result: AgentToolResult<any>, isError: boolean): void => {
		if (record.resultEmitted) return;
		const { toolCall } = record;
		if (!record.started) {
			stream.push({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: record.args,
				intent: toolCall.intent,
			});
		}
		stream.push({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError,
		});

		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: result.content,
			details: result.details,
			isError,
			timestamp: Date.now(),
		};
		record.result = result;
		record.isError = isError;
		record.toolResultMessage = toolResultMessage;
		record.resultEmitted = true;
		emittedToolResults.push(toolResultMessage);

		stream.push({ type: "message_start", message: toolResultMessage });
		stream.push({ type: "message_end", message: toolResultMessage });
	};

	const runTool = async (record: (typeof records)[number], index: number): Promise<void> => {
		if (interruptState.triggered) {
			record.skipped = true;
			return;
		}

		const { toolCall, tool } = record;
		let argsForExecution = toolCall.arguments as Record<string, unknown>;
		if (intentTracing) {
			const { intent, strippedArgs } = extractIntent(toolCall.arguments);
			argsForExecution = strippedArgs;
			if (intent) {
				toolCall.intent = intent;
			} else if (typeof tool?.intent === "function") {
				try {
					const derived = tool.intent(strippedArgs as never)?.trim();
					if (derived) {
						toolCall.intent = derived;
					}
				} catch {
					// intent function must never break tool execution
				}
			}
		}
		record.args = argsForExecution;
		record.started = true;
		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: argsForExecution,
			intent: toolCall.intent,
		});

		let result: AgentToolResult<any>;
		let isError = false;

		try {
			if (!tool) throw new Error(`Tool ${toolCall.name} not found`);

			let effectiveArgs: Record<string, unknown>;
			try {
				effectiveArgs = validateToolArguments(tool, { ...toolCall, arguments: argsForExecution });
			} catch (validationError) {
				if (tool.lenientArgValidation) {
					effectiveArgs = argsForExecution;
				} else {
					throw validationError;
				}
			}
			const toolContext = getToolContext
				? getToolContext({
						batchId,
						index,
						total: toolCalls.length,
						toolCalls: toolCallInfos,
					})
				: undefined;
			result = await tool.execute(
				toolCall.id,
				transformToolCallArguments ? transformToolCallArguments(effectiveArgs, toolCall.name) : effectiveArgs,
				tool.nonAbortable ? undefined : toolSignal,
				partialResult => {
					stream.push({
						type: "tool_execution_update",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						args: argsForExecution,
						partialResult: {
							...partialResult,
							content: partialResult.content.map(c =>
								c.type === "text" ? { ...c, text: sanitizeText(c.text) } : c,
							),
						},
					});
				},
				toolContext,
			);
		} catch (e) {
			result = {
				content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
				details: {},
			};
			isError = true;
		}

		if (interruptState.triggered) {
			record.skipped = true;
			emitToolResult(record, createSkippedToolResult(), true);
		} else {
			emitToolResult(record, result, isError);
		}

		await checkSteering();
	};

	let lastExclusive: Promise<void> = Promise.resolve();
	let sharedTasks: Promise<void>[] = [];
	const tasks: Promise<void>[] = [];

	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		const concurrency = record.tool?.concurrency ?? "shared";
		const start = concurrency === "exclusive" ? Promise.all([lastExclusive, ...sharedTasks]) : lastExclusive;
		const task = start.then(() => runTool(record, index));
		tasks.push(task);
		if (concurrency === "exclusive") {
			lastExclusive = task;
			sharedTasks = [];
		} else {
			sharedTasks.push(task);
		}
	}

	await Promise.allSettled(tasks);

	for (const record of records) {
		if (!record.toolResultMessage) {
			record.skipped = true;
			emitToolResult(record, createSkippedToolResult(), true);
		}
	}

	return { toolResults: emittedToolResults, steeringMessages };
}

/**
 * Create a tool result for a tool call that was aborted or errored before execution.
 * Maintains the tool_use/tool_result pairing required by the API.
 */
function createAbortedToolResult(
	toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	reason: "aborted" | "error",
	errorMessage?: string,
): ToolResultMessage {
	const message = reason === "aborted" ? "Tool execution was aborted" : "Tool execution failed due to an error";
	const result: AgentToolResult<any> = {
		content: [{ type: "text", text: errorMessage ? `${message}: ${errorMessage}` : `${message}.` }],
		details: {},
	};

	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
		intent: toolCall.intent,
	});
	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError: true,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: {},
		isError: true,
		timestamp: Date.now(),
	};

	stream.push({ type: "message_start", message: toolResultMessage });
	stream.push({ type: "message_end", message: toolResultMessage });

	return toolResultMessage;
}

function createSkippedToolResult(): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: "Skipped due to queued user message." }],
		details: {},
	};
}
