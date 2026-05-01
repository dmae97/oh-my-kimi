import { describe, expect, it } from "bun:test";
import { agentLoop, agentLoopContinue, INTENT_FIELD } from "@oh-my-pi/pi-agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolContext,
	ToolCallContext,
} from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Context, Message, Model, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Type } from "@sinclair/typebox";
import { createAssistantMessage, pushAlphaThenDoneEvent } from "./helpers";

// Mock stream for testing - uses actual AssistantMessageEventStream with throttling
class MockAssistantStream extends AssistantMessageEventStream {}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

// Simple identity converter for tests - just passes through standard messages
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

describe("agentLoop with AgentMessage", () => {
	it("should emit events with AgentMessage types", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("Hello");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Hi there!" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should have user message and assistant message
		expect(messages.length).toBe(2);
		expect(messages[0].role).toBe("user");
		expect(messages[1].role).toBe("assistant");

		// Verify event sequence
		const eventTypes = events.map(e => e.type);
		expect(eventTypes).toContain("agent_start");
		expect(eventTypes).toContain("turn_start");
		expect(eventTypes).toContain("message_start");
		expect(eventTypes).toContain("message_end");
		expect(eventTypes).toContain("turn_end");
		expect(eventTypes).toContain("agent_end");
	});

	it("emits an aborted assistant message when cancellation happens before provider events", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};
		const userPrompt: AgentMessage = createUserMessage("Hello");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};
		const controller = new AbortController();
		const streamFn = () => new MockAssistantStream();

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, controller.signal, streamFn);
		queueMicrotask(() => controller.abort());

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		const finalMessage = messages[messages.length - 1];
		expect(finalMessage.role).toBe("assistant");
		if (finalMessage.role !== "assistant") throw new Error("Expected assistant message");
		expect(finalMessage.stopReason).toBe("aborted");
		expect(finalMessage.errorMessage).toBe("Request was aborted");
		expect(events.map(event => event.type)).toContain("agent_end");
	});

	it("should handle custom message types via convertToLlm", async () => {
		// Create a custom message type
		interface CustomNotification {
			role: "notification";
			text: string;
			timestamp: number;
		}

		const notification: CustomNotification = {
			role: "notification",
			text: "This is a notification",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [notification as unknown as AgentMessage], // Custom message in context
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("Hello");

		let convertedMessages: Message[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: messages => {
				// Filter out notifications, convert rest
				convertedMessages = messages
					.filter(m => (m as { role: string }).role !== "notification")
					.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
				return convertedMessages;
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		// The notification should have been filtered out in convertToLlm
		expect(convertedMessages.length).toBe(1); // Only user message
		expect(convertedMessages[0].role).toBe("user");
	});

	it("should apply transformContext before convertToLlm", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [
				createUserMessage("old message 1"),
				createAssistantMessage([{ type: "text", text: "old response 1" }]),
				createUserMessage("old message 2"),
				createAssistantMessage([{ type: "text", text: "old response 2" }]),
			],
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("new message");

		let transformedMessages: AgentMessage[] = [];
		let convertedMessages: Message[] = [];

		const config: AgentLoopConfig = {
			model: createModel(),
			transformContext: async messages => {
				// Keep only last 2 messages (prune old ones)
				transformedMessages = messages.slice(-2);
				return transformedMessages;
			},
			convertToLlm: messages => {
				convertedMessages = messages.filter(
					m => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
				) as Message[];
				return convertedMessages;
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const _ of stream) {
			// consume
		}

		// transformContext should have been called first, keeping only last 2
		expect(transformedMessages.length).toBe(2);
		// Then convertToLlm receives the pruned messages
		expect(convertedMessages.length).toBe(2);
	});

	it("provides tool call batch context", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const contexts: ToolCallContext[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const toolCall = (ctx as { toolCall?: ToolCallContext })?.toolCall;
				if (toolCall) {
					contexts.push(toolCall);
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo something");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			getToolContext: toolCall => ({ toolCall }) as AgentToolContext,
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "world" } },
						],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const _ of stream) {
			// consume
		}

		expect(contexts).toHaveLength(2);
		expect(contexts[0]?.batchId).toBe(contexts[1]?.batchId);
		expect(contexts[0]?.total).toBe(2);
		expect(contexts[0]?.toolCalls).toEqual([
			{ id: "tool-1", name: "echo" },
			{ id: "tool-2", name: "echo" },
		]);
		expect(contexts[0]?.index).toBe(0);
		expect(contexts[1]?.index).toBe(1);
	});

	it("should handle tool calls and results", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("echo something");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: return tool call
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					// Second call: return final response
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		// Tool should have been executed
		expect(executed).toEqual(["hello"]);

		// Should have tool execution events
		const toolStart = events.find(e => e.type === "tool_execution_start");
		const toolEnd = events.find(e => e.type === "tool_execution_end");
		expect(toolStart).toBeDefined();
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBeFalsy();
		}
	});

	it("injects and strips intent when intent tracing is enabled", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executedParams: Record<string, unknown>[] = [];
		let firstRequestToolSchema: Record<string, unknown> | undefined;
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executedParams.push(params as Record<string, unknown>);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			intentTracing: true,
		};

		let callIndex = 0;
		const streamFn = (_model: Model, llmContext: Context) => {
			if (callIndex === 0) {
				firstRequestToolSchema = llmContext.tools?.[0]?.parameters;
			}
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{
								type: "toolCall",
								id: "tool-1",
								name: "echo",
								arguments: { value: "hello", [INTENT_FIELD]: "Read one file" },
							},
						],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([createUserMessage("run")], context, config, undefined, streamFn);
		for await (const _ of stream) {
			// consume
		}
		const messages = await stream.result();
		const assistantWithToolCall = messages.find(
			message => message.role === "assistant" && message.content.some(content => content.type === "toolCall"),
		) as AssistantMessage | undefined;
		const tracedToolCall = assistantWithToolCall?.content.find(content => content.type === "toolCall");

		expect(firstRequestToolSchema?.properties).toMatchObject({
			value: { type: "string" },
			[INTENT_FIELD]: { type: "string" },
		});
		expect(firstRequestToolSchema?.required).toEqual(expect.arrayContaining([INTENT_FIELD]));
		expect(executedParams).toEqual([{ value: "hello" }]);
		expect(tracedToolCall?.type).toBe("toolCall");
		if (tracedToolCall?.type === "toolCall") {
			expect(tracedToolCall.intent).toBe("Read one file");
		}
	});

	it("runs shared tools in parallel and emits completion-ordered results", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const startTimes: Record<string, number> = {};
		const finishTimes: Record<string, number> = {};
		const { promise: slowContinue, resolve: slowResolve } = Promise.withResolvers<void>();
		const { promise: slowStarted, resolve: slowStartedResolve } = Promise.withResolvers<void>();
		const { promise: fastFinished, resolve: fastFinishedResolve } = Promise.withResolvers<void>();

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				if (params.value === "slow") {
					startTimes.slow = Bun.nanoseconds();
					slowStartedResolve();
					await slowContinue;
					finishTimes.slow = Bun.nanoseconds();
				} else {
					await slowStarted;
					startTimes.fast = Bun.nanoseconds();
					finishTimes.fast = Bun.nanoseconds();
					fastFinishedResolve();
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("start");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "slow" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "fast" } },
						],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		const streamTask = (async () => {
			for await (const event of stream) {
				events.push(event);
			}
		})();

		await fastFinished;
		slowResolve();
		await streamTask;

		expect(startTimes.fast).toBeDefined();
		expect(startTimes.slow).toBeDefined();
		expect(finishTimes.fast).toBeDefined();
		expect(finishTimes.slow).toBeDefined();
		expect(startTimes.fast).toBeLessThan(finishTimes.slow);
		expect(finishTimes.fast).toBeLessThan(finishTimes.slow);

		const toolResultStarts = events.filter(
			(e): e is Extract<AgentEvent, { type: "message_start" }> =>
				e.type === "message_start" && e.message.role === "toolResult",
		);
		expect(toolResultStarts).toHaveLength(2);
		expect((toolResultStarts[0].message as ToolResultMessage).toolCallId).toBe("tool-2");
		expect((toolResultStarts[1].message as ToolResultMessage).toolCallId).toBe("tool-1");

		const turnEndEvent = events.find((e): e is Extract<AgentEvent, { type: "turn_end" }> => e.type === "turn_end");
		expect(turnEndEvent).toBeDefined();
		if (!turnEndEvent) return;
		expect(turnEndEvent.toolResults.map(result => result.toolCallId)).toEqual(["tool-2", "tool-1"]);
	});

	it("emits an explicit warning toolResult when assistant aborts after issuing tool calls", async () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};

		const userPrompt: AgentMessage = createUserMessage("start");
		const abortController = new AbortController();
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const partial = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "yield", arguments: { data: { ok: true } } }],
					"toolUse",
				);
				stream.push({ type: "start", partial });
				setTimeout(() => {
					abortController.abort();
					stream.push({ type: "done", reason: "toolUse", message: partial });
				}, 0);
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, abortController.signal, streamFn);
		for await (const event of stream) {
			events.push(event);
		}

		const toolResultEvent = events.find(
			(e): e is Extract<AgentEvent, { type: "message_end" }> =>
				e.type === "message_end" && e.message.role === "toolResult",
		);
		expect(toolResultEvent).toBeDefined();
		if (!toolResultEvent || toolResultEvent.message.role !== "toolResult") return;
		expect(toolResultEvent.message.isError).toBe(true);
		expect(toolResultEvent.message.toolCallId).toBe("tool-1");
		expect(toolResultEvent.message.content[0]?.type).toBe("text");
		if (toolResultEvent.message.content[0]?.type === "text") {
			const text = toolResultEvent.message.content[0].text;
			expect(text).toContain("Tool execution was aborted");
			expect(text).not.toContain("Tool execution was aborted.:");
		}
	});
	it("should skip remaining tool calls when steering is queued", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "exclusive",
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("start");
		const queuedUserMessage: AgentMessage = createUserMessage("interrupt");

		let queuedDelivered = false;
		let callIndex = 0;
		let sawInterruptInContext = false;

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			interruptMode: "immediate",
			getSteeringMessages: async () => {
				// Return steering message after tool execution has started
				if (executed.length >= 1 && !queuedDelivered) {
					queuedDelivered = true;
					return [queuedUserMessage];
				}
				return [];
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, (_model, ctx, _options) => {
			// Check if interrupt message is in context on second call
			if (callIndex === 1) {
				sawInterruptInContext = ctx.messages.some(
					m => m.role === "user" && typeof m.content === "string" && m.content === "interrupt",
				);
			}

			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: return two tool calls
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					// Second call: return final response
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const event of stream) {
			events.push(event);
		}

		// Only the first tool should execute; the second is skipped after steering is queued.
		expect(executed).toEqual(["first"]);

		const toolEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnds.length).toBe(2);
		expect(toolEnds[0].isError).toBe(false);
		expect(toolEnds[1].isError).toBe(true);
		if (toolEnds[1].result.content[0]?.type === "text") {
			expect(toolEnds[1].result.content[0].text).toContain("Skipped due to queued user message");
		}

		// Queued message should appear in events after the tool results and before the next model call.
		const eventSequence = events.flatMap(event => {
			if (event.type !== "message_start") return [];
			if (event.message.role === "toolResult") return [`tool:${event.message.toolCallId}`];
			if (event.message.role === "user" && typeof event.message.content === "string") {
				return [event.message.content];
			}
			return [];
		});
		expect(eventSequence).toContain("interrupt");
		expect(eventSequence.indexOf("tool:tool-1")).toBeLessThan(eventSequence.indexOf("interrupt"));
		expect(eventSequence.indexOf("tool:tool-2")).toBeLessThan(eventSequence.indexOf("interrupt"));

		// Interrupt message should be in context when second LLM call is made
		expect(sawInterruptInContext).toBe(true);
	});
});

it("refreshes tools and system prompt between same-turn model calls", async () => {
	const toolSchema = Type.Object({ value: Type.String() });
	let activeSystemPrompt = "prompt-one";
	let activeTools: Array<AgentTool<typeof toolSchema, { value: string }>> = [];
	const betaTool: AgentTool<typeof toolSchema, { value: string }> = {
		name: "beta",
		label: "Beta",
		description: "Beta tool",
		parameters: toolSchema,
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `beta:${params.value}` }],
				details: { value: params.value },
			};
		},
	};
	const alphaTool: AgentTool<typeof toolSchema, { value: string }> = {
		name: "alpha",
		label: "Alpha",
		description: "Alpha tool",
		parameters: toolSchema,
		async execute(_toolCallId, params) {
			activeSystemPrompt = "prompt-two";
			activeTools = [alphaTool, betaTool];
			return {
				content: [{ type: "text", text: `alpha:${params.value}` }],
				details: { value: params.value },
			};
		},
	};
	activeTools = [alphaTool];

	const context: AgentContext = {
		systemPrompt: activeSystemPrompt,
		messages: [],
		tools: activeTools,
	};
	const userPrompt: AgentMessage = createUserMessage("refresh tools");
	const config: AgentLoopConfig = {
		model: createModel(),
		convertToLlm: identityConverter,
		syncContextBeforeModelCall: async currentContext => {
			currentContext.systemPrompt = activeSystemPrompt;
			currentContext.tools = activeTools;
		},
	};

	const callContexts: Context[] = [];
	let callIndex = 0;
	const streamFn = (_model: Model, llmContext: Context) => {
		callContexts.push(llmContext);
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			pushAlphaThenDoneEvent(stream, callIndex, createAssistantMessage);
			callIndex += 1;
		});
		return stream;
	};

	const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
	for await (const _event of stream) {
		// consume
	}

	expect(callContexts).toHaveLength(2);
	expect(callContexts[0]?.systemPrompt).toBe("prompt-one");
	expect(callContexts[0]?.tools?.map(tool => tool.name)).toEqual(["alpha"]);
	expect(callContexts[1]?.systemPrompt).toBe("prompt-two");
	expect(callContexts[1]?.tools?.map(tool => tool.name)).toEqual(["alpha", "beta"]);
});

describe("agentLoopContinue with AgentMessage", () => {
	it("should throw when context has no messages", () => {
		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		expect(() => agentLoopContinue(context, config)).toThrow("Cannot continue: no messages in context");
	});

	it("should continue from existing context without emitting user message events", async () => {
		const userMessage: AgentMessage = createUserMessage("Hello");

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [userMessage],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();

		// Should only return the new assistant message (not the existing user message)
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("assistant");

		// Should NOT have user message events (that's the key difference from agentLoop)
		const messageEndEvents = events.filter(e => e.type === "message_end");
		expect(messageEndEvents.length).toBe(1);
		expect((messageEndEvents[0] as any).message.role).toBe("assistant");
	});

	it("should allow custom message types as last message (caller responsibility)", async () => {
		// Custom message that will be converted to user message by convertToLlm
		interface HookMessage {
			role: "hookMessage";
			text: string;
			timestamp: number;
		}

		const hookMessage: HookMessage = {
			role: "hookMessage",
			text: "Hook content",
			timestamp: Date.now(),
		};

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [hookMessage as unknown as AgentMessage],
			tools: [],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: messages => {
				// Convert hookMessage to user message
				return messages
					.map(m => {
						if ((m as any).role === "hookMessage") {
							return {
								role: "user" as const,
								content: (m as any).text,
								timestamp: m.timestamp,
							};
						}
						return m;
					})
					.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
			},
		};

		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage([{ type: "text", text: "Response to hook" }]);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		// Should not throw - the hookMessage will be converted to user message
		const stream = agentLoopContinue(context, config, undefined, streamFn);

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(messages.length).toBe(1);
		expect(messages[0].role).toBe("assistant");
	});
});
