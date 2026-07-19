import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type ToolResultMessage,
	type UserMessage,
} from "omk-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentLoop, agentLoopContinue, planFailureTermination, runAgentLoop } from "../src/agent-loop.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
} from "../src/types.ts";

// Mock stream for testing - mimics MockAssistantStream
class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

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

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

function createToolResultMessage(toolCallId: string, toolName = "echo"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	};
}

function toolCallBlock(id: string, name = "echo"): AssistantMessage["content"][number] {
	return { type: "toolCall", id, name, arguments: {} };
}

// Simple identity converter for tests - just passes through standard messages
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
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
		const eventTypes = events.map((e) => e.type);
		expect(eventTypes).toContain("agent_start");
		expect(eventTypes).toContain("turn_start");
		expect(eventTypes).toContain("message_start");
		expect(eventTypes).toContain("message_end");
		expect(eventTypes).toContain("turn_end");
		expect(eventTypes).toContain("agent_end");
	});

	it("should handle a runtime-extended message via convertToLlm", async () => {
		// Given: an application-defined message inserted through the open runtime boundary.
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		Reflect.set(context.messages, 0, { role: "notification", text: "notice", timestamp: Date.now() });
		let convertedMessages: Message[] = [];
		const response = new MockAssistantStream();
		queueMicrotask(() => {
			response.push({
				type: "done",
				reason: "stop",
				message: createAssistantMessage([{ type: "text", text: "Response" }]),
			});
		});

		// When: the converter filters the application-defined role.
		const stream = agentLoop(
			[createUserMessage("Hello")],
			context,
			{
				model: createModel(),
				convertToLlm: (messages) => {
					convertedMessages = messages.flatMap((message) => {
						const role: unknown = Reflect.get(message, "role");
						return role === "notification" ? [] : identityConverter([message]);
					});
					return convertedMessages;
				},
			},
			undefined,
			() => response,
		);
		for await (const _event of stream) {
			// consume
		}

		// Then: only the real user prompt crosses the provider boundary.
		expect(convertedMessages.map((message) => message.role)).toEqual(["user"]);
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
			transformContext: async (messages) => {
				// Keep only last 2 messages (prune old ones)
				transformedMessages = messages.slice(-2);
				return transformedMessages;
			},
			convertToLlm: (messages) => {
				convertedMessages = messages.filter(
					(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
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

	it("should reject a transformContext result that reopens a closed tool turn", async () => {
		const context: AgentContext = {
			systemPrompt: "",
			messages: [
				createUserMessage("first"),
				createAssistantMessage([toolCallBlock("call-1")], "toolUse"),
				createToolResultMessage("call-1"),
			],
			tools: [],
		};
		let providerCalls = 0;
		const config: AgentLoopConfig = {
			model: createModel(),
			transformContext: async (messages) => messages.filter((message) => message.role !== "toolResult"),
			convertToLlm: identityConverter,
		};
		const stream = agentLoop([createUserMessage("continue")], context, config, undefined, () => {
			providerCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				mockStream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "should not run" }]),
				});
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}
		const messages = await stream.result();

		expect(providerCalls).toBe(0);
		const failure = messages[messages.length - 1];
		if (failure.role !== "assistant") throw new Error("Expected assistant failure");
		expect(failure.errorMessage).toMatch(/transformed context.*invalid tool transcript/i);
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
		const toolStart = events.find((e) => e.type === "tool_execution_start");
		const toolEnd = events.find((e) => e.type === "tool_execution_end");
		expect(toolStart).toBeDefined();
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_execution_end") {
			expect(toolEnd.isError).toBe(false);
		}
	});

	it.each([
		["Map", () => Object.setPrototypeOf(new Map([["key", "value"]]), Object.prototype)],
		["Set", () => Object.setPrototypeOf(new Set(["value"]), Object.prototype)],
		["Date", () => Object.setPrototypeOf(new Date(0), Object.prototype)],
		["DataView", () => Object.setPrototypeOf(new DataView(new ArrayBuffer(1)), Object.prototype)],
		["typed array", () => Object.setPrototypeOf(new Uint8Array([1]), Object.prototype)],
		["SharedArrayBuffer", () => Object.setPrototypeOf(new SharedArrayBuffer(1), Object.prototype)],
		[
			"cycle",
			() => {
				const value: Record<string, unknown> = {};
				value.self = value;
				return value;
			},
		],
	] as const)("rejects hook-produced %s values before claims or execution", async (_name, createValue) => {
		// Given: a valid call whose hook replaces one argument with unsupported non-JSON data.
		const toolSchema = Type.Object({ value: Type.Unknown() });
		let claimsWithUnsupportedValue = 0;
		let executions = 0;
		const tool: AgentTool<typeof toolSchema> = {
			name: "extension",
			label: "Extension",
			description: "Rejects unsupported hook values",
			parameters: toolSchema,
			resourceClaims(args) {
				if (typeof args === "object" && args !== null && "value" in args && args.value !== "safe") {
					claimsWithUnsupportedValue++;
				}
				return [{ kind: "global", key: "extension", access: "write" }];
			},
			async execute() {
				executions++;
				return { content: [{ type: "text", text: "unexpected" }], details: {} };
			},
		};
		let providerCalls = 0;

		// When: the hook introduces the adversarial value after schema validation.
		const stream = agentLoop(
			[createUserMessage("go")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				toolScheduler: "dag-v2",
				beforeToolCall: async ({ args }) => {
					if (typeof args === "object" && args !== null && "value" in args) args.value = createValue();
					return undefined;
				},
			},
			undefined,
			() => {
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					const firstCall = providerCalls++ === 0;
					const message = firstCall
						? createAssistantMessage(
								[{ type: "toolCall", id: "tool-1", name: "extension", arguments: { value: "safe" } }],
								"toolUse",
							)
						: createAssistantMessage([{ type: "text", text: "done" }]);
					response.push({ type: "done", reason: firstCall ? "toolUse" : "stop", message });
				});
				return response;
			},
		);
		for await (const _event of stream) {
			// consume
		}
		const messages = await stream.result();

		// Then: final claims and the executor never observe the unsupported value.
		expect(claimsWithUnsupportedValue).toBe(0);
		expect(executions).toBe(0);
		expect(messages.find((message) => message.role === "toolResult")?.details).toMatchObject({
			omk: { disposition: "failed", executionStarted: false },
		});
	});

	it("should prepare tool arguments for validation", async () => {
		const replaceSchema = Type.Object({ oldText: Type.String(), newText: Type.String() });
		const toolSchema = Type.Object({ edits: Type.Array(replaceSchema) });
		const executed: Array<Array<{ oldText: string; newText: string }>> = [];
		const tool: AgentTool<typeof toolSchema, { count: number }> = {
			name: "edit",
			label: "Edit",
			description: "Edit tool",
			parameters: toolSchema,
			prepareArguments(args) {
				if (!args || typeof args !== "object") {
					return args as { edits: { oldText: string; newText: string }[] };
				}
				const input = args as {
					edits?: Array<{ oldText: string; newText: string }>;
					oldText?: string;
					newText?: string;
				};
				if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
					return args as { edits: { oldText: string; newText: string }[] };
				}
				return {
					edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }],
				};
			},
			async execute(_toolCallId, params) {
				executed.push(params.edits);
				return {
					content: [{ type: "text", text: `edited ${params.edits.length}` }],
					details: { count: params.edits.length },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("edit something");
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
							{
								type: "toolCall",
								id: "tool-1",
								name: "edit",
								arguments: { oldText: "before", newText: "after" },
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

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);
		for await (const _event of stream) {
			// consume
		}

		expect(executed).toEqual([[{ oldText: "before", newText: "after" }]]);
	});

	it("should emit tool_execution_end in completion order but persist tool results in source order", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			executionMode: "parallel",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
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

		const userPrompt: AgentMessage = createUserMessage("echo both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const toolExecutionEndIds = events.flatMap((event) => {
			if (event.type !== "tool_execution_end") {
				return [];
			}
			return [event.toolCallId];
		});
		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		const turnToolResultIds = events.flatMap((event) => {
			if (event.type !== "turn_end") {
				return [];
			}
			return event.toolResults.map((toolResult) => toolResult.toolCallId);
		});

		expect(parallelObserved).toBe(true);
		expect(toolExecutionEndIds).toEqual(["tool-2", "tool-1"]);
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
		expect(turnToolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("should run conflicting writes in later sequential waves while safe calls run concurrently", async () => {
		const echoSchema = Type.Object({ value: Type.String() });
		const writeSchema = Type.Object({ path: Type.String() });
		const writeOrder: string[] = [];
		let firstEchoResolved = false;
		let echoOverlapObserved = false;
		let releaseFirstEcho: (() => void) | undefined;
		const firstEchoDone = new Promise<void>((resolve) => {
			releaseFirstEcho = resolve;
		});

		const echoTool: AgentTool<typeof echoSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			executionMode: "parallel",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstEchoDone;
					firstEchoResolved = true;
				}
				if (params.value === "second" && !firstEchoResolved) {
					echoOverlapObserved = true;
				}
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const writeTool: AgentTool<typeof writeSchema, { path: string }> = {
			name: "write",
			label: "Write",
			description: "Write tool",
			parameters: writeSchema,
			async execute(toolCallId, params) {
				writeOrder.push(`${toolCallId}-start`);
				await new Promise((resolve) => setTimeout(resolve, 5));
				writeOrder.push(`${toolCallId}-end`);
				return {
					content: [{ type: "text", text: `wrote: ${params.path}` }],
					details: { path: params.path },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [echoTool, writeTool],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("mixed batch")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
							{ type: "toolCall", id: "tool-3", name: "write", arguments: { path: "x.ts" } },
							{ type: "toolCall", id: "tool-4", name: "write", arguments: { path: "x.ts" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirstEcho?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});

		// Wave 1: echoes + first write run concurrently; wave 2: the conflicting write runs alone after.
		expect(echoOverlapObserved).toBe(true);
		expect(writeOrder).toEqual(["tool-3-start", "tool-3-end", "tool-4-start", "tool-4-end"]);
		expect(toolResultIds).toEqual(["tool-1", "tool-2", "tool-3", "tool-4"]);
	});

	it("should inject queued messages after all tool calls complete", async () => {
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
			toolExecution: "sequential",
			getSteeringMessages: async () => {
				// Return steering message after tool execution has started.
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
					(m) => m.role === "user" && typeof m.content === "string" && m.content === "interrupt",
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

		// Both tools should execute before steering is injected
		expect(executed).toEqual(["first", "second"]);

		const toolEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnds.length).toBe(2);
		expect(toolEnds[0].isError).toBe(false);
		expect(toolEnds[1].isError).toBe(false);

		// Queued message should appear in events after both tool result messages
		const eventSequence = events.flatMap((event) => {
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

	it("should force sequential execution when a tool has executionMode=sequential even with default parallel config", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const slowTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "slow",
			label: "Slow",
			description: "Slow tool",
			parameters: toolSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
				}
				return {
					content: [{ type: "text", text: `slow: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [slowTool],
		};

		const userPrompt: AgentMessage = createUserMessage("run both");
		// config is parallel (default), but tool forces sequential
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "slow", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "slow", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// With sequential execution, second tool should NOT start before first finishes
		expect(parallelObserved).toBe(false);

		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
	});

	it("should allow parallel execution when all tools have executionMode=parallel", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let firstResolved = false;
		let parallelObserved = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			executionMode: "parallel",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					await firstDone;
					firstResolved = true;
				}
				if (params.value === "second" && !firstResolved) {
					parallelObserved = true;
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

		const userPrompt: AgentMessage = createUserMessage("echo both");
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop([userPrompt], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// With executionMode=parallel, second tool should start before first finishes
		expect(parallelObserved).toBe(true);
	});

	it("should use prepareNextTurn snapshot before continuing", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = {
			systemPrompt: "first prompt",
			messages: [],
			tools: [tool],
		};
		let convertedSecondTurnSystemPrompt = "";
		let prepared = false;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			prepareNextTurn: async ({ context: currentContext }) => {
				if (prepared) return undefined;
				prepared = true;
				return {
					context: {
						systemPrompt: "second prompt",
						messages: currentContext.messages.slice(),
						tools: currentContext.tools,
					},
				};
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, (_model, ctx) => {
			llmCalls++;
			if (llmCalls === 2) {
				convertedSecondTurnSystemPrompt = ctx.systemPrompt ?? "";
			}
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
							"toolUse",
						),
					});
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(2);
		expect(convertedSecondTurnSystemPrompt).toBe("second prompt");
	});

	it("should stop after the current turn when shouldStopAfterTurn returns true", async () => {
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

		let steeringPolls = 0;
		let followUpPolls = 0;
		let callbackToolResultIds: string[] = [];
		let callbackContextRoles: string[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			getSteeringMessages: async () => {
				steeringPolls++;
				return [];
			},
			getFollowUpMessages: async () => {
				followUpPolls++;
				return [createUserMessage("follow up should stay queued")];
			},
			shouldStopAfterTurn: async ({ message, toolResults, context }) => {
				expect(message.role).toBe("assistant");
				callbackToolResultIds = toolResults.map((toolResult) => toolResult.toolCallId);
				callbackContextRoles = context.messages.map((contextMessage) => contextMessage.role);
				return true;
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					const message = createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "should not run" }]),
					});
				}
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(llmCalls).toBe(1);
		expect(executed).toEqual(["hello"]);
		expect(steeringPolls).toBe(1);
		expect(followUpPolls).toBe(0);
		expect(callbackToolResultIds).toEqual(["tool-1"]);
		expect(callbackContextRoles).toEqual(["user", "assistant", "toolResult"]);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
	});

	it("should stop after a tool batch when every tool result sets terminate=true", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					terminate: true,
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
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					"toolUse",
				);
				mockStream.push({ type: "done", reason: "toolUse", message });
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const messages = await stream.result();
		expect(llmCalls).toBe(1);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
	});

	it("should continue after parallel tool calls when not all tool results terminate", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
					terminate: params.value === "first",
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
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("echo both")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					const message = createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					mockStream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		const messages = await stream.result();
		expect(callIndex).toBe(2);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"assistant",
		]);
	});

	it("should allow afterToolCall to mark a tool batch as terminating", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
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
			afterToolCall: async () => ({ terminate: true }),
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("echo something")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }],
					"toolUse",
				);
				mockStream.push({ type: "done", reason: "toolUse", message });
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(llmCalls).toBe(1);
	});

	it("should close an aborted sequential tool batch with one terminal result per call", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const controller = new AbortController();
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					controller.abort();
				}
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
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "sequential",
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, controller.signal, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
								{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
								{ type: "toolCall", id: "tool-3", name: "echo", arguments: { value: "third" } },
							],
							"toolUse",
						),
					});
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "should not run" }]),
					});
				}
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		// No further provider request after the abort.
		expect(llmCalls).toBe(1);
		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		// Exactly one terminal result for every emitted call, in source order.
		expect(toolResultIds).toEqual(["tool-1", "tool-2", "tool-3"]);
		const result1 = messages.find((m) => m.role === "toolResult" && m.toolCallId === "tool-1") as Extract<
			AgentMessage,
			{ role: "toolResult" }
		>;
		const result2 = messages.find((m) => m.role === "toolResult" && m.toolCallId === "tool-2") as Extract<
			AgentMessage,
			{ role: "toolResult" }
		>;
		const result3 = messages.find((m) => m.role === "toolResult" && m.toolCallId === "tool-3") as Extract<
			AgentMessage,
			{ role: "toolResult" }
		>;
		// Parent abort wins for the in-flight call; tool-2 and tool-3 never start.
		expect(result1.isError).toBe(true);
		expect(result1.content).toEqual([{ type: "text", text: "Operation aborted" }]);
		expect(result2.isError).toBe(true);
		expect(result2.content).toEqual([{ type: "text", text: "Operation aborted" }]);
		expect(result3.isError).toBe(true);
		expect(result3.content).toEqual([{ type: "text", text: "Operation aborted" }]);
		const turnEnd = events.find((e): e is Extract<AgentEvent, { type: "turn_end" }> => e.type === "turn_end");
		expect(turnEnd?.toolResults.map((r) => r.toolCallId)).toEqual(["tool-1", "tool-2", "tool-3"]);
		expect(events[events.length - 1].type).toBe("agent_end");
	});

	it("should close an aborted parallel tool batch and keep pre-abort immediate errors terminal", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const controller = new AbortController();
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			executionMode: "parallel",
			async execute(_toolCallId, params) {
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
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
			beforeToolCall: async ({ toolCall }) => {
				if (toolCall.id === "tool-2") {
					controller.abort();
				}
				return undefined;
			},
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, controller.signal, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
								{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
								{ type: "toolCall", id: "tool-3", name: "echo", arguments: { value: "third" } },
							],
							"toolUse",
						),
					});
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "should not run" }]),
					});
				}
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		expect(llmCalls).toBe(1);
		const allResultIds = messages
			.filter((m): m is Extract<AgentMessage, { role: "toolResult" }> => m.role === "toolResult")
			.map((m) => m.toolCallId);
		// tool-1 real, tool-2 pre-abort immediate error, tool-3 synthesized; no duplication.
		expect(allResultIds).toEqual(["tool-1", "tool-2", "tool-3"]);
		const byId = new Map(
			allResultIds.map((id) => [
				id,
				messages.find((m) => m.role === "toolResult" && m.toolCallId === id) as Extract<
					AgentMessage,
					{ role: "toolResult" }
				>,
			]),
		);
		expect(byId.get("tool-1")?.isError).toBe(true);
		expect(byId.get("tool-1")?.content).toEqual([{ type: "text", text: "Operation aborted" }]);
		expect(byId.get("tool-2")?.isError).toBe(true);
		expect(byId.get("tool-2")?.content).toEqual([{ type: "text", text: "Operation aborted" }]);
		expect(byId.get("tool-3")?.isError).toBe(true);
		expect(events[events.length - 1].type).toBe("agent_end");
	});

	it("should close an aborted multi-wave tool batch", async () => {
		const echoSchema = Type.Object({ value: Type.String() });
		const writeSchema = Type.Object({ path: Type.String() });
		const controller = new AbortController();
		const echoTool: AgentTool<typeof echoSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			executionMode: "parallel",
			async execute(_toolCallId, params) {
				if (params.value === "first") {
					controller.abort();
				}
				return {
					content: [{ type: "text", text: `echo:${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const writeTool: AgentTool<typeof writeSchema, { path: string }> = {
			name: "write",
			label: "Write",
			description: "Write tool",
			parameters: writeSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `wrote:${params.path}` }],
					details: { path: params.path },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [echoTool, writeTool],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, controller.signal, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
								{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
								{ type: "toolCall", id: "tool-3", name: "write", arguments: { path: "x.ts" } },
								{ type: "toolCall", id: "tool-4", name: "write", arguments: { path: "x.ts" } },
							],
							"toolUse",
						),
					});
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "should not run" }]),
					});
				}
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		expect(llmCalls).toBe(1);
		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		// Wave 1 (tool-1, tool-2, tool-3) completes; wave 2 (tool-4) is synthesized.
		expect(toolResultIds).toEqual(["tool-1", "tool-2", "tool-3", "tool-4"]);
		const findResult = (id: string): Extract<AgentMessage, { role: "toolResult" }> =>
			messages.find((m) => m.role === "toolResult" && m.toolCallId === id) as Extract<
				AgentMessage,
				{ role: "toolResult" }
			>;
		expect(findResult("tool-1").isError).toBe(true);
		expect(findResult("tool-2").isError).toBe(true);
		expect(findResult("tool-3").isError).toBe(true);
		expect(findResult("tool-4").isError).toBe(true);
		expect(findResult("tool-4").content).toEqual([{ type: "text", text: "Operation aborted" }]);
		expect(events[events.length - 1].type).toBe("agent_end");
	});
});

describe("agentLoop tool timeouts", () => {
	function hangingResult(): Promise<AgentToolResult<{ value: string }>> {
		// Ignores the abort signal and never settles on its own.
		return new Promise<AgentToolResult<{ value: string }>>(() => {});
	}

	function toolResultById(messages: AgentMessage[], id: string) {
		return messages.find((m) => m.role === "toolResult" && m.toolCallId === id) as Extract<
			AgentMessage,
			{ role: "toolResult" }
		>;
	}

	it("commits a timeout result and end before auditing a prompt late settlement", async () => {
		// Given: timeout cancellation makes the real promise settle immediately.
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "hang",
			label: "Hang",
			description: "Settles on timeout cancellation",
			parameters: toolSchema,
			timeoutMs: 20,
			execute(_toolCallId, _params, signal) {
				return new Promise((resolve) => {
					signal?.addEventListener(
						"abort",
						() => resolve({ content: [{ type: "text", text: "late" }], details: { value: "late" } }),
						{ once: true },
					);
				});
			},
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[{ type: "toolCall", id: "tool-1", name: "hang", arguments: { value: "x" } }],
							"toolUse",
						),
					});
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		// The timeout produces a terminal result and the loop makes a second request.
		expect(callIndex).toBe(2);
		const result = toolResultById(messages, "tool-1");
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: 'Tool "hang" timed out after 20ms and was terminated.' }]);
		expect(result.details).toEqual({
			omk: {
				schema: "tool-result/v2",
				synthetic: true,
				disposition: "timeout",
				reason: 'Tool "hang" timed out after 20ms',
				timeoutMs: 20,
				executionStarted: true,
			},
		});
		const toolEndIndex = events.findIndex(
			(event) => event.type === "tool_execution_end" && event.toolCallId === "tool-1",
		);
		expect(events[toolEndIndex]).toMatchObject({ isError: true });
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const lateIndex = events.findIndex((event) => event.type === "tool_execution_late_settlement");
		expect(toolEndIndex).toBeLessThan(lateIndex);
		expect(
			events.findIndex((event) => event.type === "message_end" && event.message.role === "toolResult"),
		).toBeLessThan(lateIndex);
	});

	it("closes a signal-ignoring tool on parent abort without a configured timeout", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const controller = new AbortController();
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let settleTool!: (result: AgentToolResult<{ value: string }>) => void;
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "hang",
			label: "Hang",
			description: "Ignores abort until its real promise settles",
			parameters: toolSchema,
			execute() {
				markStarted();
				return new Promise((resolve) => {
					settleTool = resolve;
				});
			},
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, controller.signal, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				mockStream.push({
					type: "done",
					reason: llmCalls === 1 ? "toolUse" : "stop",
					message:
						llmCalls === 1
							? createAssistantMessage(
									[{ type: "toolCall", id: "tool-1", name: "hang", arguments: { value: "x" } }],
									"toolUse",
								)
							: createAssistantMessage([{ type: "text", text: "should not run" }]),
				});
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		const finished = (async () => {
			for await (const event of stream) events.push(event);
			return stream.result();
		})();
		await started;
		controller.abort();
		await Promise.resolve();
		settleTool({ content: [{ type: "text", text: "late success" }], details: { value: "late" } });
		const messages = await finished;

		expect(llmCalls).toBe(1);
		const result = toolResultById(messages, "tool-1");
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "Operation aborted" }]);
		expect(
			events.filter(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "toolResult" &&
					event.message.toolCallId === "tool-1",
			),
		).toHaveLength(1);
	});

	it("times out one parallel tool while its sibling settles independently in source order", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			executionMode: "parallel",
			timeoutMs: 20,
			async execute(_toolCallId, params) {
				if (params.value === "hang") {
					return hangingResult();
				}
				return {
					content: [{ type: "text", text: `ok:${params.value}` }],
					details: { value: params.value },
				};
			},
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "parallel",
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hang" } },
								{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "fast" } },
							],
							"toolUse",
						),
					});
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") {
				return [];
			}
			return [event.message.toolCallId];
		});
		// Source order preserved even though the sibling settled first.
		expect(toolResultIds).toEqual(["tool-1", "tool-2"]);
		const hung = toolResultById(messages, "tool-1");
		const fast = toolResultById(messages, "tool-2");
		expect(hung.isError).toBe(true);
		expect(hung.details).toEqual({
			omk: {
				schema: "tool-result/v2",
				synthetic: true,
				disposition: "timeout",
				reason: 'Tool "echo" timed out after 20ms',
				timeoutMs: 20,
				executionStarted: true,
			},
		});
		expect(fast.isError).toBe(false);
		expect(fast.content).toEqual([{ type: "text", text: "ok:fast" }]);
		expect(callIndex).toBe(2);
	});
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
		const messageEndEvents = events.filter(
			(event): event is Extract<AgentEvent, { type: "message_end" }> => event.type === "message_end",
		);
		expect(messageEndEvents.length).toBe(1);
		expect(messageEndEvents[0]?.message.role).toBe("assistant");
	});

	it("should continue from a runtime-extended message converted to a user message", async () => {
		// Given: an application-defined tail that the provider cannot consume directly.
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		Reflect.set(context.messages, 0, { role: "custom", text: "Hook content", timestamp: Date.now() });
		const response = new MockAssistantStream();
		queueMicrotask(() => {
			response.push({
				type: "done",
				reason: "stop",
				message: createAssistantMessage([{ type: "text", text: "Response" }]),
			});
		});

		// When: continuation converts the custom tail at the boundary.
		const stream = agentLoopContinue(
			context,
			{
				model: createModel(),
				convertToLlm: (messages) =>
					messages.flatMap((message) => {
						if (Reflect.get(message, "role") !== "custom") return identityConverter([message]);
						const text = Reflect.get(message, "text");
						return typeof text === "string" ? [{ role: "user", content: text, timestamp: Date.now() }] : [];
					}),
			},
			undefined,
			() => response,
		);
		for await (const _event of stream) {
			// consume
		}

		// Then: continuation completes with a normal assistant message.
		expect((await stream.result()).map((message) => message.role)).toEqual(["assistant"]);
	});
});

describe("transcript integrity guards", () => {
	it("rejects duplicate emitted tool-call IDs before any tool executes", async () => {
		const toolSchema = Type.Object({});
		let executions = 0;
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "echo",
			label: "Echo",
			description: "Must not execute for an ambiguous turn",
			parameters: toolSchema,
			async execute() {
				executions++;
				return { content: [{ type: "text", text: "unexpected" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
		let providerCalls = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, () => {
			providerCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				mockStream.push({
					type: "done",
					reason: "toolUse",
					message: createAssistantMessage([toolCallBlock("duplicate"), toolCallBlock("duplicate")], "toolUse"),
				});
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}
		const messages = await stream.result();

		expect(providerCalls).toBe(1);
		expect(executions).toBe(0);
		expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
	});

	it("does not invoke the provider when continuing from a transcript with a missing result", () => {
		const context: AgentContext = {
			systemPrompt: "",
			// assistant(A,B) -> result(A): result(B) is missing.
			messages: [
				createUserMessage("go"),
				createAssistantMessage([toolCallBlock("a"), toolCallBlock("b")], "toolUse"),
				createToolResultMessage("a"),
			],
			tools: [],
		};
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
		let providerCalls = 0;
		const streamFn = (): MockAssistantStream => {
			providerCalls++;
			return new MockAssistantStream();
		};

		expect(() => agentLoopContinue(context, config, undefined, streamFn)).toThrow();
		expect(providerCalls).toBe(0);
	});

	it("does not invoke the provider when continuing from an open tool turn", () => {
		const context: AgentContext = {
			systemPrompt: "",
			messages: [createUserMessage("go"), createAssistantMessage([toolCallBlock("a")], "toolUse")],
			tools: [],
		};
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
		let providerCalls = 0;
		const streamFn = (): MockAssistantStream => {
			providerCalls++;
			return new MockAssistantStream();
		};

		expect(() => agentLoopContinue(context, config, undefined, streamFn)).toThrow();
		expect(providerCalls).toBe(0);
	});

	it("does not invoke the provider when the starting transcript is structurally invalid", async () => {
		const context: AgentContext = {
			systemPrompt: "",
			// Open tool turn baked into the starting context.
			messages: [
				createAssistantMessage([toolCallBlock("a"), toolCallBlock("b")], "toolUse"),
				createToolResultMessage("a"),
			],
			tools: [],
		};
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
		let providerCalls = 0;
		const streamFn = (): MockAssistantStream => {
			providerCalls++;
			return new MockAssistantStream();
		};

		const stream = agentLoop([createUserMessage("go")], context, config, undefined, streamFn);
		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		// The provider-time integrity check fails before any provider call.
		expect(providerCalls).toBe(0);
		expect(events[events.length - 1].type).toBe("agent_end");
		// The failure terminates the stream with an assistant message carrying the error.
		const lastMessage = messages[messages.length - 1];
		if (lastMessage.role !== "assistant") throw new Error("Expected assistant failure message");
		expect(lastMessage.errorMessage).toMatch(/invalid tool transcript/);
	});
});

describe("planFailureTermination", () => {
	it("appends a synthetic assistant failure over a closed transcript", () => {
		const closed: AgentMessage[] = [
			createUserMessage("go"),
			createAssistantMessage([toolCallBlock("a")], "toolUse"),
			createToolResultMessage("a"),
		];
		const plan = planFailureTermination(closed, createModel(), new Error("boom"), false);

		expect(plan.closureResults).toEqual([]);
		expect(plan.failureMessage).toBeDefined();
		const failureMessage = plan.failureMessage;
		if (!failureMessage || failureMessage.role !== "assistant") throw new Error("Expected assistant failure");
		expect(failureMessage.stopReason).toBe("error");
		expect(failureMessage.errorMessage).toBe("boom");
		expect(Object.isFrozen(failureMessage)).toBe(true);
		expect(plan.messages.length).toBe(closed.length + 1);
		expect(plan.messages[plan.messages.length - 1]).toBe(failureMessage);
	});

	it("records stopReason 'aborted' when the run was aborted", () => {
		const plan = planFailureTermination([createUserMessage("go")], createModel(), new Error("aborted"), true);
		const failureMessage = plan.failureMessage;
		if (!failureMessage || failureMessage.role !== "assistant") throw new Error("Expected assistant failure");
		expect(failureMessage.stopReason).toBe("aborted");
	});

	it("closes an unambiguous open tool turn with missing-only closure before the failure assistant", () => {
		const open: AgentMessage[] = [
			createUserMessage("go"),
			createAssistantMessage([toolCallBlock("a"), toolCallBlock("b")], "toolUse"),
			createToolResultMessage("a"),
		];
		const plan = planFailureTermination(open, createModel(), new Error("boom"), false);

		// Exactly one synthetic closure result for the missing call, in source order.
		expect(plan.closureResults.map((result) => result.toolCallId)).toEqual(["b"]);
		expect(plan.closureResults.every((result) => result.isError && Object.isFrozen(result))).toBe(true);
		expect(plan.failureMessage).toBeDefined();
		// The open turn is closed before the failure assistant is appended.
		expect(plan.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"assistant",
		]);
		expect((plan.messages[3] as ToolResultMessage).toolCallId).toBe("b");
		expect(plan.messages[4]).toBe(plan.failureMessage);
	});

	it("does not auto-repair a duplicate-result transcript and fails closed", () => {
		const ambiguous: AgentMessage[] = [
			createAssistantMessage([toolCallBlock("a")], "toolUse"),
			createToolResultMessage("a"),
			createToolResultMessage("a"),
		];
		const plan = planFailureTermination(ambiguous, createModel(), new Error("boom"), false);

		expect(plan.failureMessage).toBeUndefined();
		expect(plan.closureResults).toEqual([]);
		// No fabrication: messages are the original transcript, unchanged.
		expect(plan.messages).toEqual(ambiguous);
	});

	it("does not auto-repair an interleaved transcript and fails closed", () => {
		const interleaved: AgentMessage[] = [
			createAssistantMessage([toolCallBlock("a")], "toolUse"),
			createUserMessage("interrupt"),
			createToolResultMessage("a"),
		];
		const plan = planFailureTermination(interleaved, createModel(), new Error("boom"), false);

		expect(plan.failureMessage).toBeUndefined();
		expect(plan.closureResults).toEqual([]);
		expect(plan.messages).toEqual(interleaved);
	});

	it("does not auto-repair an orphan result and fails closed", () => {
		const orphan: AgentMessage[] = [createUserMessage("hi"), createToolResultMessage("ghost")];
		const plan = planFailureTermination(orphan, createModel(), new Error("boom"), false);

		expect(plan.failureMessage).toBeUndefined();
		expect(plan.closureResults).toEqual([]);
		expect(plan.messages).toEqual(orphan);
	});
});

describe("agentLoop dag-v2 scheduler", () => {
	it("schedules the head-of-line example with concurrent level 0 and source-order results", async () => {
		const writeSchema = Type.Object({ path: Type.String() });
		let firstWriteXDone = false;
		let writeYOverlap = false;
		let secondWriteXBeforeFirst = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const writeTool: AgentTool<typeof writeSchema, { path: string }> = {
			name: "write",
			label: "Write",
			description: "Write tool",
			parameters: writeSchema,
			async execute(toolCallId, params) {
				if (params.path === "x" && toolCallId === "tool-1") {
					await firstDone;
					firstWriteXDone = true;
				} else if (params.path === "x" && toolCallId === "tool-2") {
					if (!firstWriteXDone) {
						secondWriteXBeforeFirst = true;
					}
				} else if (params.path === "y" && !firstWriteXDone) {
					writeYOverlap = true;
				}
				return {
					content: [{ type: "text", text: `wrote:${params.path}` }],
					details: { path: params.path },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [writeTool],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolScheduler: "dag-v2",
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{ type: "toolCall", id: "tool-1", name: "write", arguments: { path: "x" } },
								{ type: "toolCall", id: "tool-2", name: "write", arguments: { path: "x" } },
								{ type: "toolCall", id: "tool-3", name: "write", arguments: { path: "y" } },
							],
							"toolUse",
						),
					});
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		// Level 0 = [tool-1, tool-3]: write y runs concurrently with the first write x.
		expect(writeYOverlap).toBe(true);
		// Level 1 = [tool-2]: the conflicting second write x waits for the first.
		expect(secondWriteXBeforeFirst).toBe(false);
		// Buffered tool results are emitted globally in original source order.
		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") return [];
			return [event.message.toolCallId];
		});
		expect(toolResultIds).toEqual(["tool-1", "tool-2", "tool-3"]);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"toolResult",
			"assistant",
		]);
	});

	it("honors sequential execution before dag-v2 for disjoint blocking calls", async () => {
		const readSchema = Type.Object({ path: Type.String() });
		let firstReleased = false;
		let secondStartedBeforeRelease = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const readTool: AgentTool<typeof readSchema, { path: string }> = {
			name: "read",
			label: "Read",
			description: "Read tool",
			parameters: readSchema,
			async execute(_toolCallId, params) {
				if (params.path === "a") {
					await firstDone;
					firstReleased = true;
				} else if (!firstReleased) {
					secondStartedBeforeRelease = true;
				}
				return {
					content: [{ type: "text", text: `read:${params.path}` }],
					details: { path: params.path },
				};
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [readTool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolExecution: "sequential",
			toolScheduler: "dag-v2",
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "a" } },
								{ type: "toolCall", id: "tool-2", name: "read", arguments: { path: "b" } },
							],
							"toolUse",
						),
					});
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(secondStartedBeforeRelease).toBe(false);
		expect(callIndex).toBe(2);
	});

	it("preserves inherited custom claims while binding tool identity", async () => {
		const toolSchema = Type.Object({ key: Type.String() });
		const trace: string[] = [];
		let firstSharedDone = false;
		let disjointOverlapObserved = false;
		let overlappingCallSerialized = false;
		let releaseFirst: (() => void) | undefined;
		const firstDone = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const tool: AgentTool<typeof toolSchema, { key: string }> = {
			name: "extension_store",
			label: "Extension Store",
			description: "Custom extension write tool",
			parameters: toolSchema,
			async resourceClaims(args, claimContext) {
				await Promise.resolve();
				trace.push(`claim:${claimContext.toolCallId}:${claimContext.cwd}`);
				const key =
					typeof args === "object" && args !== null && "key" in args && typeof args.key === "string"
						? args.key
						: "invalid";
				return [{ kind: "global", key, access: "write" }];
			},
			async execute(toolCallId, params) {
				trace.push(`execute:${toolCallId}`);
				if (toolCallId === "tool-1") {
					await firstDone;
					firstSharedDone = true;
				} else if (toolCallId === "tool-2" && !firstSharedDone) {
					disjointOverlapObserved = true;
				} else if (toolCallId === "tool-3") {
					overlappingCallSerialized = firstSharedDone;
				}
				return {
					content: [{ type: "text", text: `stored:${params.key}` }],
					details: { key: params.key },
				};
			},
		};
		Object.setPrototypeOf(tool, { resourceClaims: tool.resourceClaims });
		Reflect.deleteProperty(tool, "resourceClaims");
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolScheduler: "dag-v2",
			cwd: "/workspace",
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{ type: "toolCall", id: "tool-1", name: "extension_store", arguments: { key: "shared" } },
								{ type: "toolCall", id: "tool-2", name: "extension_store", arguments: { key: "disjoint" } },
								{ type: "toolCall", id: "tool-3", name: "extension_store", arguments: { key: "shared" } },
							],
							"toolUse",
						),
					});
					setTimeout(() => releaseFirst?.(), 20);
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}

		expect(trace.slice(0, 3)).toEqual([
			"claim:tool-1:/workspace",
			"claim:tool-2:/workspace",
			"claim:tool-3:/workspace",
		]);
		expect(disjointOverlapObserved).toBe(true);
		expect(overlappingCallSerialized).toBe(true);
	});

	it("fails throwing and rejecting custom claim resolvers closed without crashing the loop", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let active = 0;
		let maxActive = 0;
		const executionOrder: string[] = [];
		const execute = async (toolCallId: string, params: { value: string }) => {
			active++;
			maxActive = Math.max(maxActive, active);
			executionOrder.push(toolCallId);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return {
				content: [{ type: "text" as const, text: `ok:${params.value}` }],
				details: { value: params.value },
			};
		};
		const throwingTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "extension_throwing_claims",
			label: "Throwing Claims",
			description: "Throws while resolving claims",
			parameters: toolSchema,
			resourceClaims: () => {
				throw new Error("claim failure");
			},
			execute,
		};
		const safeTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "extension_safe_claims",
			label: "Safe Claims",
			description: "Returns a custom claim",
			parameters: toolSchema,
			resourceClaims: () => [{ kind: "global", key: "safe", access: "write" }],
			execute,
		};
		const rejectingTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "extension_rejecting_claims",
			label: "Rejecting Claims",
			description: "Rejects while resolving claims",
			parameters: toolSchema,
			resourceClaims: () => Promise.reject(new Error("claim rejection")),
			execute,
		};
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [throwingTool, safeTool, rejectingTool],
		};
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolScheduler: "dag-v2",
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{
									type: "toolCall",
									id: "tool-throws",
									name: "extension_throwing_claims",
									arguments: { value: "throws" },
								},
								{
									type: "toolCall",
									id: "tool-safe",
									name: "extension_safe_claims",
									arguments: { value: "safe" },
								},
								{
									type: "toolCall",
									id: "tool-rejects",
									name: "extension_rejecting_claims",
									arguments: { value: "rejects" },
								},
							],
							"toolUse",
						),
					});
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(maxActive).toBe(1);
		expect(executionOrder).toEqual(["tool-throws", "tool-safe", "tool-rejects"]);
		const toolEnds = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
		);
		expect(toolEnds.map((event) => event.toolCallId)).toEqual(["tool-throws", "tool-safe", "tool-rejects"]);
		expect(toolEnds.every((event) => !event.isError)).toBe(true);
		expect(callIndex).toBe(2);
	});

	it("emits tool results in source order when levels reorder execution", async () => {
		const readSchema = Type.Object({ path: Type.String() });
		const tool: AgentTool<typeof readSchema, { path: string }> = {
			name: "read",
			label: "Read",
			description: "Read tool",
			parameters: readSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `read:${params.path}` }],
					details: { path: params.path },
				};
			},
		};
		const writeTool: AgentTool<typeof readSchema, { path: string }> = {
			name: "write",
			label: "Write",
			description: "Write tool",
			parameters: readSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `wrote:${params.path}` }],
					details: { path: params.path },
				};
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool, writeTool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolScheduler: "dag-v2",
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// dag levels: [[0, 2], [1]] (read a, read b parallel; write a alone).
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "a" } },
								{ type: "toolCall", id: "tool-2", name: "write", arguments: { path: "a" } },
								{ type: "toolCall", id: "tool-3", name: "read", arguments: { path: "b" } },
							],
							"toolUse",
						),
					});
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") return [];
			return [event.message.toolCallId];
		});
		expect(toolResultIds).toEqual(["tool-1", "tool-2", "tool-3"]);
	});

	it("closes an aborted dag-v2 batch with one terminal result per call and no second provider call", async () => {
		const writeSchema = Type.Object({ path: Type.String() });
		const controller = new AbortController();
		const writeTool: AgentTool<typeof writeSchema, { path: string }> = {
			name: "write",
			label: "Write",
			description: "Write tool",
			parameters: writeSchema,
			async execute(toolCallId, params) {
				if (toolCallId === "tool-1") {
					controller.abort();
				}
				return {
					content: [{ type: "text", text: `wrote:${params.path}` }],
					details: { path: params.path },
				};
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [writeTool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolScheduler: "dag-v2",
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, controller.signal, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (llmCalls === 1) {
					// dag levels: [[0, 2, 3], [1]] -> level 0 runs, level 1 never starts.
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{ type: "toolCall", id: "tool-1", name: "write", arguments: { path: "x" } },
								{ type: "toolCall", id: "tool-2", name: "write", arguments: { path: "x" } },
								{ type: "toolCall", id: "tool-3", name: "write", arguments: { path: "y" } },
								{ type: "toolCall", id: "tool-4", name: "write", arguments: { path: "z" } },
							],
							"toolUse",
						),
					});
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "should not run" }]),
					});
				}
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		// No second provider request after the abort.
		expect(llmCalls).toBe(1);
		const expectedIds = ["tool-1", "tool-2", "tool-3", "tool-4"];
		const resultStartIds = events.flatMap((event) => {
			if (event.type !== "message_start" || event.message.role !== "toolResult") return [];
			return [event.message.toolCallId];
		});
		const resultEndIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") return [];
			return [event.message.toolCallId];
		});
		const returnedResultIds = messages
			.filter((m): m is Extract<AgentMessage, { role: "toolResult" }> => m.role === "toolResult")
			.map((m) => m.toolCallId);
		const turnEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "turn_end" }> => event.type === "turn_end",
		);
		expect(resultStartIds).toEqual(expectedIds);
		expect(resultEndIds).toEqual(expectedIds);
		expect(returnedResultIds).toEqual(expectedIds);
		expect(turnEnd?.toolResults.map((result) => result.toolCallId)).toEqual(expectedIds);
		expect(new Set(returnedResultIds).size).toBe(4);

		const byId = new Map(
			returnedResultIds.map((id) => [
				id,
				messages.find((m) => m.role === "toolResult" && m.toolCallId === id) as Extract<
					AgentMessage,
					{ role: "toolResult" }
				>,
			]),
		);
		// Parent abort closes every in-flight level-0 call; level 1 never starts.
		expect(byId.get("tool-1")?.isError).toBe(true);
		expect(byId.get("tool-3")?.isError).toBe(true);
		expect(byId.get("tool-4")?.isError).toBe(true);
		expect(byId.get("tool-2")?.isError).toBe(true);
		expect(byId.get("tool-2")?.content).toEqual([{ type: "text", text: "Operation aborted" }]);
		const executionStarts = events.flatMap((event) =>
			event.type === "tool_execution_start" ? [event.toolCallId] : [],
		);
		const executionEnds = events.flatMap((event) => (event.type === "tool_execution_end" ? [event.toolCallId] : []));
		expect(executionStarts).not.toContain("tool-2");
		expect(executionEnds).not.toContain("tool-2");
		expect(events[events.length - 1].type).toBe("agent_end");
	});

	it("stops the run after a single signal-ignoring dag-v2 tool times out unsettled", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "hang",
			label: "Hang",
			description: "Hangs forever",
			parameters: toolSchema,
			timeoutMs: 20,
			execute: () => new Promise<AgentToolResult<{ value: string }>>(() => {}),
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		let followUpPolls = 0;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolScheduler: "dag-v2",
			getFollowUpMessages: async () => {
				followUpPolls++;
				return [];
			},
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[{ type: "toolCall", id: "tool-1", name: "hang", arguments: { value: "x" } }],
							"toolUse",
						),
					});
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		expect(callIndex).toBe(1);
		expect(followUpPolls).toBe(0);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		const result = messages.find((m) => m.role === "toolResult" && m.toolCallId === "tool-1") as Extract<
			AgentMessage,
			{ role: "toolResult" }
		>;
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: 'Tool "hang" timed out after 20ms and was terminated.' }]);
		expect(result.details).toEqual({
			omk: {
				schema: "tool-result/v2",
				synthetic: true,
				disposition: "timeout",
				reason: 'Tool "hang" timed out after 20ms',
				timeoutMs: 20,
				executionStarted: true,
			},
		});
	});

	it("stops after a dag-v2 batch when every tool result sets terminate=true", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			executionMode: "parallel",
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed:${params.value}` }],
					details: { value: params.value },
					terminate: true,
				};
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolScheduler: "dag-v2",
		};

		let llmCalls = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				mockStream.push({
					type: "done",
					reason: "toolUse",
					message: createAssistantMessage(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "a" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "b" } },
						],
						"toolUse",
					),
				});
			});
			return mockStream;
		});

		for await (const _event of stream) {
			// consume
		}
		const messages = await stream.result();

		expect(llmCalls).toBe(1);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult"]);
	});

	it("splits a conflict-free level when maxToolConcurrency is set", async () => {
		const toolSchema = Type.Object({ path: Type.String() });
		const active: string[] = [];
		let maxActive = 0;
		const tool: AgentTool<typeof toolSchema, { path: string }> = {
			name: "read",
			label: "Read",
			description: "Read tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				active.push(params.path);
				maxActive = Math.max(maxActive, active.length);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active.splice(active.indexOf(params.path), 1);
				return {
					content: [{ type: "text", text: `read:${params.path}` }],
					details: { path: params.path },
				};
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			toolScheduler: "dag-v2",
			maxToolConcurrency: 2,
		};

		let callIndex = 0;
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, () => {
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					mockStream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							[
								{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "a" } },
								{ type: "toolCall", id: "tool-2", name: "read", arguments: { path: "b" } },
								{ type: "toolCall", id: "tool-3", name: "read", arguments: { path: "c" } },
								{ type: "toolCall", id: "tool-4", name: "read", arguments: { path: "d" } },
							],
							"toolUse",
						),
					});
				} else {
					mockStream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return mockStream;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		// Cap of 2 chunks the single conflict-free level; at most 2 reads run at once.
		expect(maxActive).toBeLessThanOrEqual(2);
		const toolResultIds = events.flatMap((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") return [];
			return [event.message.toolCallId];
		});
		expect(toolResultIds).toEqual(["tool-1", "tool-2", "tool-3", "tool-4"]);
	});
});

describe("P0 terminal and final-argument DAG guards", () => {
	it.each([
		{ stopReason: "error", disposition: "skipped" },
		{ stopReason: "aborted", disposition: "aborted" },
	] as const)(
		"closes completed tool calls without executing them when the provider terminates with $stopReason",
		async ({ stopReason, disposition }) => {
			// Given: a provider terminal response containing two complete, unambiguous tool calls.
			const schema = Type.Object({});
			let executions = 0;
			const tool: AgentTool<typeof schema, Record<string, never>> = {
				name: "echo",
				label: "Echo",
				description: "Must not execute after provider termination",
				parameters: schema,
				async execute() {
					executions++;
					return { content: [{ type: "text", text: "unexpected" }], details: {} };
				},
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCalls = 0;
			const events: AgentEvent[] = [];

			// When: the terminal provider event closes the assistant stream.
			const stream = agentLoop(
				[createUserMessage("go")],
				context,
				{ model: createModel(), convertToLlm: identityConverter },
				undefined,
				() => {
					providerCalls++;
					const response = new MockAssistantStream();
					queueMicrotask(() => {
						const message = createAssistantMessage(
							[toolCallBlock("terminal-1"), toolCallBlock("terminal-2")],
							stopReason,
						);
						response.push({ type: "error", reason: stopReason, error: message });
					});
					return response;
				},
			);
			for await (const event of stream) events.push(event);
			const messages = await stream.result();

			// Then: each call has one source-ordered synthetic result before terminal events, with no execution/retry.
			const results = messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
			expect(executions).toBe(0);
			expect(providerCalls).toBe(1);
			expect(results.map((result) => result.toolCallId)).toEqual(["terminal-1", "terminal-2"]);
			for (const result of results) {
				expect(result.details).toMatchObject({
					omk: { synthetic: true, disposition, executionStarted: false },
				});
			}
			expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
			expect(events.some((event) => event.type === "tool_execution_end")).toBe(false);
			const assistantEnd = events.findIndex(
				(event) => event.type === "message_end" && event.message.role === "assistant",
			);
			expect(events.slice(assistantEnd + 1).map((event) => event.type)).toEqual([
				"message_start",
				"message_end",
				"message_start",
				"message_end",
				"turn_end",
				"agent_end",
			]);
		},
	);

	it("fails closed when a provider terminal response duplicates a tool-call id", async () => {
		// Given: a terminal provider response with an ambiguous duplicate call id.
		const schema = Type.Object({});
		let executions = 0;
		const tool: AgentTool<typeof schema, Record<string, never>> = {
			name: "echo",
			label: "Echo",
			description: "Must not execute ambiguous calls",
			parameters: schema,
			async execute() {
				executions++;
				return { content: [{ type: "text", text: "unexpected" }], details: {} };
			},
		};
		let providerCalls = 0;
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };

		// When: the invalid terminal turn reaches the integrity guard.
		const stream = agentLoop(
			[createUserMessage("go")],
			context,
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			() => {
				providerCalls++;
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					response.push({
						type: "error",
						reason: "error",
						error: createAssistantMessage([toolCallBlock("duplicate"), toolCallBlock("duplicate")], "error"),
					});
				});
				return response;
			},
		);
		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);
		const messages = await stream.result();

		// Then: no tool or synthetic result is fabricated, and the run ends without another provider request.
		expect(executions).toBe(0);
		expect(providerCalls).toBe(1);
		expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(0);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(0);
		expect(events[events.length - 1]?.type).toBe("agent_end");
	});

	it("defers each dag-v2 lifecycle start until its final sublevel begins", async () => {
		// Given: two conflicting writes that must execute in separate DAG levels.
		const schema = Type.Object({ path: Type.String() });
		const trace: string[] = [];
		const tool: AgentTool<typeof schema, { path: string }> = {
			name: "write",
			label: "Write",
			description: "Write a path",
			parameters: schema,
			async execute(toolCallId, params) {
				trace.push(`execute:${toolCallId}`);
				return { content: [{ type: "text", text: `wrote:${params.path}` }], details: params };
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		let providerCalls = 0;

		// When: the DAG runs both levels.
		await runAgentLoop(
			[createUserMessage("go")],
			context,
			{
				model: createModel(),
				convertToLlm: identityConverter,
				toolScheduler: "dag-v2",
				beforeToolCall: async ({ toolCall }) => {
					trace.push(`hook:${toolCall.id}`);
					return undefined;
				},
			},
			(event) => {
				if (event.type === "tool_execution_start") trace.push(`start:${event.toolCallId}`);
			},
			undefined,
			() => {
				providerCalls++;
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					response.push(
						providerCalls === 1
							? {
									type: "done",
									reason: "toolUse",
									message: createAssistantMessage(
										[
											{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "same" } },
											{ type: "toolCall", id: "write-2", name: "write", arguments: { path: "same" } },
										],
										"toolUse",
									),
								}
							: {
									type: "done",
									reason: "stop",
									message: createAssistantMessage([{ type: "text", text: "done" }]),
								},
					);
				});
				return response;
			},
		);

		// Then: authorization settles before start, and level 2 is not authorized early.
		expect(trace).toEqual([
			"hook:write-1",
			"start:write-1",
			"execute:write-1",
			"hook:write-2",
			"start:write-2",
			"execute:write-2",
		]);
	});

	it.each([
		{ immediateKind: "failure", firstToolName: "missing", disposition: "failed" },
		{ immediateKind: "block", firstToolName: "echo", disposition: "blocked" },
	] as const)(
		"preserves an earlier immediate $immediateKind when a later dag-v2 hook aborts",
		async ({ firstToolName, disposition }) => {
			// Given: an immediate outcome before a hook-aborting call and an untouched suffix call.
			const schema = Type.Object({});
			const controller = new AbortController();
			const authorized: string[] = [];
			const tool: AgentTool<typeof schema, Record<string, never>> = {
				name: "echo",
				label: "Echo",
				description: "Echo",
				parameters: schema,
				async execute() {
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			const events: AgentEvent[] = [];

			// When: authorization of the second call aborts the batch.
			const stream = agentLoop(
				[createUserMessage("go")],
				context,
				{
					model: createModel(),
					convertToLlm: identityConverter,
					toolScheduler: "dag-v2",
					beforeToolCall: async ({ toolCall }) => {
						authorized.push(toolCall.id);
						if (toolCall.id === "first" && disposition === "blocked") {
							return { block: true, reason: "blocked first" };
						}
						if (toolCall.id === "abort") controller.abort();
						return undefined;
					},
				},
				controller.signal,
				() => {
					const response = new MockAssistantStream();
					queueMicrotask(() => {
						response.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[
									{ type: "toolCall", id: "first", name: firstToolName, arguments: {} },
									{ type: "toolCall", id: "abort", name: "echo", arguments: {} },
									{ type: "toolCall", id: "later", name: "echo", arguments: {} },
								],
								"toolUse",
							),
						});
					});
					return response;
				},
			);
			for await (const event of stream) events.push(event);
			const messages = await stream.result();

			// Then: the known immediate outcome survives before abort closure.
			const results = messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
			expect(results.map((result) => result.toolCallId)).toEqual(["first", "abort", "later"]);
			expect(results[0]?.details).toMatchObject({ omk: { disposition, executionStarted: false } });
			expect(results[1]?.details).toMatchObject({ omk: { disposition: "aborted", executionStarted: false } });
			expect(results[2]?.details).toMatchObject({ omk: { disposition: "aborted", executionStarted: false } });
			expect(authorized).toEqual(disposition === "blocked" ? ["first", "abort"] : ["abort"]);
			expect(events.flatMap((event) => (event.type === "tool_execution_start" ? [event.toolCallId] : []))).toEqual(
				[],
			);
		},
	);

	it.each(["prepare replacement", "in-place hook mutation"] as const)(
		"serializes final same-path writes after %s",
		async (caseName) => {
			// Given: two raw-disjoint writes that are retargeted to one path before execute.
			const schema = Type.Object({ path: Type.String() });
			const trace: string[] = [];
			const executedPaths: string[] = [];
			let markFirstStarted: (() => void) | undefined;
			const firstStarted = new Promise<void>((resolve) => {
				markFirstStarted = resolve;
			});
			let releaseFirst: (() => void) | undefined;
			const firstRelease = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			const tool: AgentTool<typeof schema, { path: string }> = {
				name: "write",
				label: "Write",
				description: "Write a path",
				parameters: schema,
				...(caseName === "prepare replacement" ? { prepareArguments: () => ({ path: "same.txt" }) } : {}),
				async execute(toolCallId, params) {
					trace.push(`${toolCallId}:start`);
					executedPaths.push(params.path);
					if (toolCallId === "write-1") {
						markFirstStarted?.();
						await firstRelease;
					}
					trace.push(`${toolCallId}:end`);
					return { content: [{ type: "text", text: `wrote:${params.path}` }], details: params };
				},
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				toolScheduler: "dag-v2",
				...(caseName === "in-place hook mutation"
					? {
							beforeToolCall: async ({ args, toolCall }) => {
								Reflect.set(toolCall, "name", "read");
								if (typeof args === "object" && args !== null && "path" in args) {
									args.path = "same.txt";
								}
								return undefined;
							},
						}
					: {}),
			};
			let providerCalls = 0;

			// When: the DAG executes the retargeted batch.
			const stream = agentLoop([createUserMessage("go")], context, config, undefined, () => {
				providerCalls++;
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					response.push(
						providerCalls === 1
							? {
									type: "done",
									reason: "toolUse",
									message: createAssistantMessage(
										[
											{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "a.txt" } },
											{ type: "toolCall", id: "write-2", name: "write", arguments: { path: "b.txt" } },
										],
										"toolUse",
									),
								}
							: {
									type: "done",
									reason: "stop",
									message: createAssistantMessage([{ type: "text", text: "done" }]),
								},
					);
				});
				return response;
			});
			const finished = (async () => {
				for await (const _event of stream) {
					// consume
				}
			})();
			await firstStarted;
			await Promise.resolve();
			releaseFirst?.();
			await finished;

			// Then: execution uses the final path and the second write starts only after the first settles.
			expect(executedPaths).toEqual(["same.txt", "same.txt"]);
			expect(trace).toEqual(["write-1:start", "write-1:end", "write-2:start", "write-2:end"]);
			expect(providerCalls).toBe(2);
		},
	);

	it.each([
		{ intervalKind: "search/write", firstToolName: "grep" },
		{ intervalKind: "write/write", firstToolName: "write" },
	] as const)("keeps hook-mutated $intervalKind execution intervals disjoint", async ({ firstToolName }) => {
		// Given: raw-disjoint paths that the hook retargets to one actual resource.
		const schema = Type.Object({ path: Type.String() });
		let clock = 0;
		const intervals = new Map<string, { start: number; end?: number }>();
		let markFirstStarted: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		let releaseFirst: (() => void) | undefined;
		const firstRelease = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const execute = async (toolCallId: string, params: { path: string }) => {
			const interval = { start: clock++ };
			intervals.set(toolCallId, interval);
			if (toolCallId === "first") {
				markFirstStarted?.();
				await firstRelease;
			}
			intervals.set(toolCallId, { ...interval, end: clock++ });
			return { content: [{ type: "text" as const, text: `done:${params.path}` }], details: params };
		};
		const firstTool: AgentTool<typeof schema, { path: string }> = {
			name: firstToolName,
			label: firstToolName,
			description: `${firstToolName} a path`,
			parameters: schema,
			execute,
		};
		const writeTool: AgentTool<typeof schema, { path: string }> = {
			name: "write",
			label: "write",
			description: "write a path",
			parameters: schema,
			execute,
		};
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: firstToolName === "write" ? [writeTool] : [firstTool, writeTool],
		};
		let providerCalls = 0;

		// When: both calls are authorized with a hook-mutated final path.
		const stream = agentLoop(
			[createUserMessage("go")],
			context,
			{
				model: createModel(),
				convertToLlm: identityConverter,
				toolScheduler: "dag-v2",
				beforeToolCall: async ({ args }) => {
					if (typeof args === "object" && args !== null && "path" in args) args.path = "same.txt";
					return undefined;
				},
			},
			undefined,
			() => {
				providerCalls++;
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					response.push(
						providerCalls === 1
							? {
									type: "done",
									reason: "toolUse",
									message: createAssistantMessage(
										[
											{ type: "toolCall", id: "first", name: firstToolName, arguments: { path: "a.txt" } },
											{ type: "toolCall", id: "second", name: "write", arguments: { path: "b.txt" } },
										],
										"toolUse",
									),
								}
							: {
									type: "done",
									reason: "stop",
									message: createAssistantMessage([{ type: "text", text: "done" }]),
								},
					);
				});
				return response;
			},
		);
		const finished = (async () => {
			for await (const _event of stream) {
				// consume
			}
		})();
		await firstStarted;
		await Promise.resolve();
		releaseFirst?.();
		await finished;

		// Then: the concrete execution intervals do not overlap.
		const first = intervals.get("first");
		const second = intervals.get("second");
		if (first?.end === undefined || second === undefined) throw new Error("Expected completed intervals");
		expect(first.end).toBeLessThan(second.start);
	});

	it("skips later DAG levels after an unsettled timeout and keeps late settlement audit-only", async () => {
		vi.useFakeTimers();
		try {
			// Given: a first-level write that ignores timeout cancellation and a conflicting queued write.
			const schema = Type.Object({ path: Type.String() });
			const started: string[] = [];
			let markFirstStarted: (() => void) | undefined;
			const firstStarted = new Promise<void>((resolve) => {
				markFirstStarted = resolve;
			});
			let settleFirst: ((result: AgentToolResult<{ path: string }>) => void) | undefined;
			const unsettled = new Promise<AgentToolResult<{ path: string }>>((resolve) => {
				settleFirst = resolve;
			});
			const tool: AgentTool<typeof schema, { path: string }> = {
				name: "write",
				label: "Write",
				description: "Write a path",
				parameters: schema,
				timeoutMs: 20,
				execute(toolCallId, params) {
					started.push(toolCallId);
					if (toolCallId === "write-1") {
						markFirstStarted?.();
						return unsettled;
					}
					return Promise.resolve({
						content: [{ type: "text", text: `wrote:${params.path}` }],
						details: params,
					});
				},
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			const events: AgentEvent[] = [];
			const authorized: string[] = [];
			let providerCalls = 0;
			let followUpPolls = 0;
			const streamFn = () => {
				providerCalls++;
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					response.push(
						providerCalls === 1
							? {
									type: "done",
									reason: "toolUse",
									message: createAssistantMessage(
										[
											{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "same.txt" } },
											{ type: "toolCall", id: "write-2", name: "write", arguments: { path: "same.txt" } },
										],
										"toolUse",
									),
								}
							: {
									type: "done",
									reason: "stop",
									message: createAssistantMessage([{ type: "text", text: "should not run" }]),
								},
					);
				});
				return response;
			};

			// When: the first write times out while its real promise remains pending.
			const run = runAgentLoop(
				[createUserMessage("go")],
				context,
				{
					model: createModel(),
					convertToLlm: identityConverter,
					toolScheduler: "dag-v2",
					beforeToolCall: async ({ toolCall }) => {
						authorized.push(toolCall.id);
						return undefined;
					},
					getFollowUpMessages: async () => {
						followUpPolls++;
						return followUpPolls === 1 ? [createUserMessage("must stay queued")] : [];
					},
				},
				(event) => {
					events.push(event);
				},
				undefined,
				streamFn,
			);
			await firstStarted;
			await vi.advanceTimersByTimeAsync(20);
			const messages = await run;

			// Then: the dependent call is skipped in source order and the run returns without retrying the provider.
			const results = messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
			expect(providerCalls).toBe(1);
			expect(followUpPolls).toBe(0);
			expect(authorized).toEqual(["write-1"]);
			expect(started).toEqual(["write-1"]);
			expect(results.map((result) => result.toolCallId)).toEqual(["write-1", "write-2"]);
			expect(results[0]?.details).toMatchObject({ omk: { disposition: "timeout", executionStarted: true } });
			expect(results[1]?.details).toMatchObject({
				omk: { synthetic: true, disposition: "skipped", executionStarted: false },
			});
			expect(events.slice(-2).map((event) => event.type)).toEqual(["turn_end", "agent_end"]);

			// And: settling late emits audit metadata only, never another result or a delayed dependent execution.
			settleFirst?.({
				content: [{ type: "text", text: "late success" }],
				details: { path: "same.txt" },
			});
			await vi.runAllTimersAsync();
			expect(events.filter((event) => event.type === "tool_execution_late_settlement")).toMatchObject([
				{ toolCallId: "write-1", disposition: "timeout", outcome: "resolved" },
			]);
			expect(
				events.filter((event) => event.type === "message_end" && event.message.role === "toolResult"),
			).toHaveLength(2);
			expect(started).toEqual(["write-1"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops before provider and follow-up continuation after an unsettled final DAG-level timeout", async () => {
		vi.useFakeTimers();
		try {
			// Given: a completed first level and a signal-ignoring timeout in the final level.
			const schema = Type.Object({ path: Type.String() });
			let markFinalStarted: (() => void) | undefined;
			const finalStarted = new Promise<void>((resolve) => {
				markFinalStarted = resolve;
			});
			let settleFinal: ((result: AgentToolResult<{ path: string }>) => void) | undefined;
			const unsettled = new Promise<AgentToolResult<{ path: string }>>((resolve) => {
				settleFinal = resolve;
			});
			const started: string[] = [];
			const tool: AgentTool<typeof schema, { path: string }> = {
				name: "write",
				label: "Write",
				description: "Write a path",
				parameters: schema,
				timeoutMs: 20,
				execute(toolCallId, params) {
					started.push(toolCallId);
					if (toolCallId === "write-final") {
						markFinalStarted?.();
						return unsettled;
					}
					return Promise.resolve({
						content: [{ type: "text", text: `wrote:${params.path}` }],
						details: params,
					});
				},
			};
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
			let providerCalls = 0;
			let followUpPolls = 0;
			const events: AgentEvent[] = [];

			// When: the final-level call times out before its real promise settles.
			const run = runAgentLoop(
				[createUserMessage("go")],
				context,
				{
					model: createModel(),
					convertToLlm: identityConverter,
					toolScheduler: "dag-v2",
					getFollowUpMessages: async () => {
						followUpPolls++;
						return followUpPolls === 1 ? [createUserMessage("must stay queued")] : [];
					},
				},
				(event) => {
					events.push(event);
				},
				undefined,
				() => {
					providerCalls++;
					const response = new MockAssistantStream();
					queueMicrotask(() => {
						response.push(
							providerCalls === 1
								? {
										type: "done",
										reason: "toolUse",
										message: createAssistantMessage(
											[
												{ type: "toolCall", id: "write-first", name: "write", arguments: { path: "same" } },
												{ type: "toolCall", id: "write-final", name: "write", arguments: { path: "same" } },
											],
											"toolUse",
										),
									}
								: {
										type: "done",
										reason: "stop",
										message: createAssistantMessage([{ type: "text", text: "should not run" }]),
									},
						);
					});
					return response;
				},
			);
			await finalStarted;
			await vi.advanceTimersByTimeAsync(20);
			const messages = await run;

			// Then: both started calls retain real outcomes, but no continuation or queue polling occurs.
			const results = messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
			expect(providerCalls).toBe(1);
			expect(followUpPolls).toBe(0);
			expect(started).toEqual(["write-first", "write-final"]);
			expect(results.map((result) => result.toolCallId)).toEqual(["write-first", "write-final"]);
			expect(results[0]?.details).toMatchObject({ omk: { disposition: "completed", executionStarted: true } });
			expect(results[1]?.details).toMatchObject({ omk: { disposition: "timeout", executionStarted: true } });
			expect(
				results.some(
					(result) => (result.details as { omk?: { disposition?: string } })?.omk?.disposition === "skipped",
				),
			).toBe(false);
			expect(events.slice(-2).map((event) => event.type)).toEqual(["turn_end", "agent_end"]);

			settleFinal?.({ content: [{ type: "text", text: "late" }], details: { path: "same" } });
			await vi.runAllTimersAsync();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("tool-result/v2 disposition envelope (ALG001-C / ALG004-D)", () => {
	const toolSchema = Type.Object({ value: Type.String() });

	function makeTool(
		overrides: Partial<AgentTool<typeof toolSchema, unknown>> = {},
	): AgentTool<typeof toolSchema, unknown> {
		return {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
			...overrides,
		};
	}

	function toolTurnStream(calls: Array<{ id: string; name?: string; value?: string }>) {
		let callIndex = 0;
		return () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessage(
							calls.map((call) => ({
								type: "toolCall",
								id: call.id,
								name: call.name ?? "echo",
								arguments: { value: call.value ?? "v" },
							})),
							"toolUse",
						),
					});
				} else {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
				}
				callIndex++;
			});
			return stream;
		};
	}

	function resultMessages(events: AgentEvent[]): ToolResultMessage[] {
		return events.flatMap((event) =>
			event.type === "message_end" && event.message.role === "toolResult" ? [event.message] : [],
		);
	}

	function envelopeOf(message: ToolResultMessage): unknown {
		return (message.details as { omk?: unknown } | undefined)?.omk;
	}

	async function run(
		context: AgentContext,
		config: Partial<AgentLoopConfig>,
		streamFn: () => MockAssistantStream,
		signal?: AbortSignal,
	): Promise<AgentEvent[]> {
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[createUserMessage("go")],
			context,
			{ model: createModel(), convertToLlm: identityConverter, ...config },
			signal,
			streamFn,
		);
		for await (const event of stream) {
			events.push(event);
		}
		return events;
	}

	it("stamps completed and failed real executions without mislabeling them synthetic", async () => {
		const failing = makeTool({
			name: "boom",
			async execute() {
				throw new Error("exploded");
			},
		});
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [makeTool(), failing] };
		const events = await run(
			context,
			{},
			toolTurnStream([
				{ id: "t1", name: "echo", value: "hello" },
				{ id: "t2", name: "boom" },
			]),
		);

		const results = resultMessages(events);
		expect(results.map((m) => m.toolCallId)).toEqual(["t1", "t2"]);
		expect(envelopeOf(results[0])).toEqual({
			schema: "tool-result/v2",
			synthetic: false,
			disposition: "completed",
			executionStarted: true,
		});
		// Real tool details are preserved next to the envelope.
		expect((results[0].details as { value?: string }).value).toBe("hello");
		expect(results[0].isError).toBe(false);
		expect(envelopeOf(results[1])).toMatchObject({
			schema: "tool-result/v2",
			synthetic: false,
			disposition: "failed",
			executionStarted: true,
		});
		expect(results[1].isError).toBe(true);
	});

	it("stamps blocked calls with a synthetic blocked disposition that never started", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [makeTool()] };
		const events = await run(
			context,
			{ beforeToolCall: async () => ({ block: true, reason: "policy says no" }) },
			toolTurnStream([{ id: "t1" }]),
		);

		const [result] = resultMessages(events);
		expect(result.isError).toBe(true);
		expect(envelopeOf(result)).toEqual({
			schema: "tool-result/v2",
			synthetic: true,
			disposition: "blocked",
			reason: "policy says no",
			executionStarted: false,
		});
		expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
		expect(events.some((event) => event.type === "tool_execution_end")).toBe(false);
	});

	it("stamps a timeout result with the timeout envelope on the transcript message", async () => {
		const hanging = makeTool({
			name: "hang",
			timeoutMs: 20,
			async execute() {
				return new Promise(() => {});
			},
		});
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [hanging] };
		const events = await run(context, {}, toolTurnStream([{ id: "t1", name: "hang" }]));

		const [result] = resultMessages(events);
		expect(result.isError).toBe(true);
		expect(envelopeOf(result)).toEqual({
			schema: "tool-result/v2",
			synthetic: true,
			disposition: "timeout",
			reason: 'Tool "hang" timed out after 20ms',
			timeoutMs: 20,
			executionStarted: true,
		});
	});

	it("closes an aborted batch with synthetic aborted envelopes for unstarted calls", async () => {
		const controller = new AbortController();
		const first = makeTool({
			name: "first",
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		});
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [first, makeTool()] };
		const events = await run(
			context,
			{
				toolExecution: "sequential",
				// Abort after the first call's real result committed, before t2 starts.
				afterToolCall: async ({ toolCall }) => {
					if (toolCall.id === "t1") {
						controller.abort();
					}
					return undefined;
				},
			},
			toolTurnStream([
				{ id: "t1", name: "first" },
				{ id: "t2", name: "echo" },
			]),
			controller.signal,
		);

		const results = resultMessages(events);
		expect(results.map((m) => m.toolCallId)).toEqual(["t1", "t2"]);
		// Abort during afterToolCall commits an immutable in-flight aborted terminal.
		expect(envelopeOf(results[0])).toMatchObject({ synthetic: true, disposition: "aborted", executionStarted: true });
		// The unstarted suffix call is a synthetic aborted terminal.
		expect(envelopeOf(results[1])).toEqual({
			schema: "tool-result/v2",
			synthetic: true,
			disposition: "aborted",
			reason: "Operation aborted",
			executionStarted: false,
		});
	});

	it("never stamps a completed call synthetic across sequential, parallel, and dag-v2 schedulers", async () => {
		for (const config of [
			{ toolExecution: "sequential" as const },
			{ toolExecution: "parallel" as const },
			{ toolScheduler: "dag-v2" as const },
		]) {
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [makeTool()] };
			const events = await run(context, config, toolTurnStream([{ id: "t1", value: "x" }]));
			const [result] = resultMessages(events);
			expect(envelopeOf(result)).toEqual({
				schema: "tool-result/v2",
				synthetic: false,
				disposition: "completed",
				executionStarted: true,
			});
		}
	});

	it("wraps primitive and array details from tools and afterToolCall without losing compatibility data", async () => {
		const primitive = makeTool({
			name: "primitive",
			async execute() {
				return { content: [{ type: "text", text: "primitive" }], details: 7 };
			},
		});
		const array = makeTool({
			name: "array",
			async execute() {
				return { content: [{ type: "text", text: "array" }], details: ["tool", 2] };
			},
		});
		const hooked = makeTool({ name: "hooked" });
		const nullHooked = makeTool({ name: "null-hooked" });
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [primitive, array, hooked, nullHooked],
		};
		const events = await run(
			context,
			{
				afterToolCall: async ({ toolCall }) => {
					if (toolCall.id === "t3") return { details: ["hook", 3] };
					if (toolCall.id === "t4") return { details: null };
					return undefined;
				},
			},
			toolTurnStream([
				{ id: "t1", name: "primitive" },
				{ id: "t2", name: "array" },
				{ id: "t3", name: "hooked" },
				{ id: "t4", name: "null-hooked" },
			]),
		);

		const completedEnvelope = {
			schema: "tool-result/v2",
			synthetic: false,
			disposition: "completed",
			executionStarted: true,
		};
		expect(resultMessages(events).map((result) => result.details)).toEqual([
			{ originalDetails: 7, omk: completedEnvelope },
			{ originalDetails: ["tool", 2], omk: completedEnvelope },
			{ originalDetails: ["hook", 3], omk: completedEnvelope },
			{ originalDetails: null, omk: completedEnvelope },
		]);
	});

	it("replaces forged tool and hook omk dispositions with executor-owned completed envelopes", async () => {
		const forged = {
			schema: "tool-result/v2",
			synthetic: true,
			disposition: "timeout",
			reason: "forged",
			timeoutMs: 1,
			executionStarted: false,
		};
		const tool = makeTool({
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: { source: "tool", omk: forged } };
			},
		});
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const toolEvents = await run(context, {}, toolTurnStream([{ id: "t1" }]));
		const hookContext: AgentContext = { systemPrompt: "", messages: [], tools: [makeTool()] };
		const hookEvents = await run(
			hookContext,
			{ afterToolCall: async () => ({ details: { source: "hook", omk: forged } }) },
			toolTurnStream([{ id: "t2" }]),
		);

		for (const result of [...resultMessages(toolEvents), ...resultMessages(hookEvents)]) {
			expect(result.details).toMatchObject({
				omk: {
					schema: "tool-result/v2",
					synthetic: false,
					disposition: "completed",
					executionStarted: true,
				},
			});
			expect(envelopeOf(result)).not.toHaveProperty("reason");
			expect(envelopeOf(result)).not.toHaveProperty("timeoutMs");
		}
		expect(resultMessages(toolEvents)[0].details).toHaveProperty("source", "tool");
		expect(resultMessages(hookEvents)[0].details).toHaveProperty("source", "hook");
	});

	it("produces skipped for dag-v2 dependents intentionally not started after level termination", async () => {
		const started: string[] = [];
		const terminating = makeTool({
			async execute(toolCallId) {
				started.push(toolCallId);
				return { content: [{ type: "text", text: "done" }], details: {}, terminate: true };
			},
		});
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [terminating] };
		const events = await run(context, { toolScheduler: "dag-v2" }, toolTurnStream([{ id: "t1" }, { id: "t2" }]));

		const results = resultMessages(events);
		expect(started).toEqual(["t1"]);
		expect(results.map((result) => result.toolCallId)).toEqual(["t1", "t2"]);
		expect(envelopeOf(results[0])).toMatchObject({ disposition: "completed", synthetic: false });
		expect(envelopeOf(results[1])).toEqual({
			schema: "tool-result/v2",
			synthetic: true,
			disposition: "skipped",
			reason: "Skipped because the preceding DAG level requested termination",
			executionStarted: false,
		});
		const starts = events.flatMap((event) => (event.type === "tool_execution_start" ? [event.toolCallId] : []));
		expect(starts).not.toContain("t2");
	});
});
