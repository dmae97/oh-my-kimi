import { describe, expect, it } from "bun:test";
import { Agent, type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getBundledModel, type SimpleStreamOptions, type ThinkingBudgets } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Type } from "@sinclair/typebox";
import { createAssistantMessage, pushAlphaThenDoneEvent } from "./helpers";

class MockAssistantStream extends AssistantMessageEventStream {}

describe("Agent", () => {
	it("should create an agent instance with default state", () => {
		const agent = new Agent();

		expect(agent.state).toBeDefined();
		expect(agent.state.systemPrompt).toEqual([]);
		expect(agent.state.model).toBeDefined();
		expect(agent.state.thinkingLevel).toBeUndefined();
		expect(agent.state.tools).toEqual([]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamMessage).toBe(null);
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		expect(agent.state.error).toBeUndefined();
	});

	it("should create an agent instance with custom initial state", () => {
		const customModel = getBundledModel("openai", "gpt-4o-mini");
		const agent = new Agent({
			initialState: {
				systemPrompt: ["You are a helpful assistant."],
				model: customModel,
				thinkingLevel: ThinkingLevel.Low,
			},
		});

		expect(agent.state.systemPrompt).toEqual(["You are a helpful assistant."]);
		expect(agent.state.model).toBe(customModel);
		expect(agent.state.thinkingLevel).toBe(ThinkingLevel.Low);
	});

	it("should subscribe to events", () => {
		const agent = new Agent();

		let eventCount = 0;
		const unsubscribe = agent.subscribe(_event => {
			eventCount++;
		});

		// No initial event on subscribe
		expect(eventCount).toBe(0);

		// State mutators don't emit events
		agent.setSystemPrompt(["Test prompt"]);
		expect(eventCount).toBe(0);
		expect(agent.state.systemPrompt).toEqual(["Test prompt"]);

		// Unsubscribe should work
		unsubscribe();
		agent.setSystemPrompt(["Another prompt"]);
		expect(eventCount).toBe(0); // Should not increase
	});

	it("should update state with mutators", () => {
		const agent = new Agent();

		// Test setSystemPrompt
		agent.setSystemPrompt(["Custom prompt"]);
		expect(agent.state.systemPrompt).toEqual(["Custom prompt"]);

		// Test setModel
		const newModel = getBundledModel("google", "gemini-2.5-flash");
		agent.setModel(newModel);
		expect(agent.state.model).toBe(newModel);

		// Test setThinkingLevel
		agent.setThinkingLevel(ThinkingLevel.High);
		expect(agent.state.thinkingLevel).toBe(ThinkingLevel.High);

		// Test setTools
		const tools = [{ name: "test", description: "test tool" } as any];
		agent.setTools(tools);
		expect(agent.state.tools).toBe(tools);

		// Test replaceMessages
		const messages = [{ role: "user" as const, content: "Hello", timestamp: Date.now() }];
		agent.replaceMessages(messages);
		expect(agent.state.messages).toEqual(messages);
		expect(agent.state.messages).not.toBe(messages); // Should be a copy

		// Test appendMessage
		const newMessage = createAssistantMessage([{ type: "text", text: "Hi" }]);
		agent.appendMessage(newMessage);
		expect(agent.state.messages).toHaveLength(2);
		expect(agent.state.messages[1]).toBe(newMessage);

		// Test clearMessages
		agent.clearMessages();
		expect(agent.state.messages).toEqual([]);
	});

	it("should support steering message queueing", async () => {
		const agent = new Agent();

		const message = { role: "user" as const, content: "Queued message", timestamp: Date.now() };
		agent.steer(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("should handle abort controller", () => {
		const agent = new Agent();

		// Should not throw even if nothing is running
		expect(() => agent.abort()).not.toThrow();
	});

	it("continue() should process queued follow-up messages after an assistant turn", async () => {
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "Processed" }]),
					});
				});
				return stream;
			},
		});

		agent.replaceMessages([
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage([{ type: "text", text: "Initial response" }]),
		]);

		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "Queued follow-up" }],
			timestamp: Date.now(),
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const hasQueuedFollowUp = agent.state.messages.some(message => {
			if (message.role !== "user") return false;
			if (typeof message.content === "string") return message.content === "Queued follow-up";
			return message.content.some(part => part.type === "text" && part.text === "Queued follow-up");
		});

		expect(hasQueuedFollowUp).toBe(true);
		expect(agent.state.messages[agent.state.messages.length - 1].role).toBe("assistant");
	});

	it("continue() should keep one-at-a-time steering semantics from assistant tail", async () => {
		let responseCount = 0;
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				responseCount++;
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: `Processed ${responseCount}` }]),
					});
				});
				return stream;
			},
		});

		agent.replaceMessages([
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage([{ type: "text", text: "Initial response" }]),
		]);

		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 1" }],
			timestamp: Date.now(),
		});
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 2" }],
			timestamp: Date.now() + 1,
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const recentMessages = agent.state.messages.slice(-4);
		expect(recentMessages.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(responseCount).toBe(2);
	});

	it("prompt() refreshes tools and system prompt between same-turn model calls", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		type Details = { value: string };
		let callIndex = 0;
		const callContexts: Array<{ systemPrompt: string; toolNames: string[] }> = [];

		const betaTool: AgentTool<typeof toolSchema, Details> = {
			name: "beta",
			label: "Beta",
			description: "Beta tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `beta:${params.value}` }], details: { value: params.value } };
			},
		};
		const alphaTool: AgentTool<typeof toolSchema, Details> = {
			name: "alpha",
			label: "Alpha",
			description: "Alpha tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `alpha:${params.value}` }], details: { value: params.value } };
			},
		};

		const agent = new Agent({
			initialState: {
				model: getBundledModel("openai", "gpt-4o-mini"),
				systemPrompt: ["prompt-one"],
				tools: [alphaTool],
				messages: [],
			},
			streamFn: (_model, context) => {
				callContexts.push({
					systemPrompt: context.systemPrompt?.join("\n\n") ?? "",
					toolNames: (context.tools ?? []).map(tool => tool.name),
				});
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					pushAlphaThenDoneEvent(stream, callIndex, createAssistantMessage);
					callIndex += 1;
				});
				return stream;
			},
		});

		const unsubscribe = agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				agent.setSystemPrompt(["prompt-two"]);
				agent.setTools([alphaTool, betaTool]);
			}
		});

		await agent.prompt("refresh tools");
		unsubscribe();

		expect(callContexts).toEqual([
			{ systemPrompt: "prompt-one", toolNames: ["alpha"] },
			{ systemPrompt: "prompt-two", toolNames: ["alpha", "beta"] },
		]);
	});

	it("prompt() drops stale forced toolChoice after same-turn tool refresh", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		type Details = { value: string };
		let callIndex = 0;
		const providerCalls: Array<{ toolNames: string[]; toolChoice: SimpleStreamOptions["toolChoice"] }> = [];

		const betaTool: AgentTool<typeof toolSchema, Details> = {
			name: "beta",
			label: "Beta",
			description: "Beta tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `beta:${params.value}` }], details: { value: params.value } };
			},
		};
		const alphaTool: AgentTool<typeof toolSchema, Details> = {
			name: "alpha",
			label: "Alpha",
			description: "Alpha tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `alpha:${params.value}` }], details: { value: params.value } };
			},
		};

		const agent = new Agent({
			initialState: {
				model: getBundledModel("openai", "gpt-4o-mini"),
				tools: [alphaTool],
				messages: [],
			},
			streamFn: (_model, context, options) => {
				providerCalls.push({
					toolNames: (context.tools ?? []).map(tool => tool.name),
					toolChoice: options?.toolChoice,
				});
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					pushAlphaThenDoneEvent(stream, callIndex, createAssistantMessage);
					callIndex += 1;
				});
				return stream;
			},
		});

		const unsubscribe = agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				agent.setTools([betaTool]);
			}
		});

		await agent.prompt("refresh tools", { toolChoice: { type: "function", name: "alpha" } });
		unsubscribe();

		expect(providerCalls).toEqual([
			{ toolNames: ["alpha"], toolChoice: { type: "function", name: "alpha" } },
			{ toolNames: ["beta"], toolChoice: undefined },
		]);
	});

	it("forwards sessionId and thinkingBudgets to streamFn options", async () => {
		let receivedSessionId: string | undefined;
		let receivedBudgets: ThinkingBudgets | undefined;

		const agent = new Agent({
			sessionId: "session-abc",
			thinkingBudgets: { minimal: 64, low: 256 },
			streamFn: (_model, _context, options) => {
				receivedSessionId = options?.sessionId;
				receivedBudgets = options?.thinkingBudgets;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage([{ type: "text", text: "ok" }]);
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("hello");
		expect(receivedSessionId).toBe("session-abc");
		expect(receivedBudgets).toEqual({ minimal: 64, low: 256 });

		agent.sessionId = "session-def";
		agent.thinkingBudgets = { medium: 512 };

		await agent.prompt("hello again");
		expect(receivedSessionId).toBe("session-def");
		expect(receivedBudgets).toEqual({ medium: 512 });
	});

	it("forwards onPayload to streamFn options", async () => {
		let receivedOnPayload: SimpleStreamOptions["onPayload"] | undefined;

		const agent = new Agent({
			onPayload: async (payload, model) => ({ payload, provider: model?.provider }),
			streamFn: (_model, _context, options) => {
				receivedOnPayload = options?.onPayload;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage([{ type: "text", text: "ok" }]);
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("hello");
		expect(receivedOnPayload).toBeDefined();

		const replacementPayload = await receivedOnPayload?.({ request: true }, getBundledModel("openai", "gpt-4o-mini"));
		expect(replacementPayload).toEqual({
			payload: { request: true },
			provider: "openai",
		});
	});

	it("re-reads thinking level for each model call within a run", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		type Details = { value: string };
		const alphaTool: AgentTool<typeof toolSchema, Details> = {
			name: "alpha",
			label: "Alpha",
			description: "Alpha tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `alpha:${params.value}` }], details: { value: params.value } };
			},
		};

		let callIndex = 0;
		const reasoningPerCall: Array<SimpleStreamOptions["reasoning"]> = [];

		const agent = new Agent({
			initialState: {
				model: getBundledModel("openai", "gpt-4o-mini"),
				thinkingLevel: ThinkingLevel.Low,
				tools: [alphaTool],
				messages: [],
			},
			streamFn: (_model, _context, options) => {
				reasoningPerCall.push(options?.reasoning);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					pushAlphaThenDoneEvent(stream, callIndex, createAssistantMessage);
					callIndex += 1;
				});
				return stream;
			},
		});

		// Bump thinking level mid-run, after the first assistant turn finishes
		// and before the second model call (which follows the tool result).
		const unsubscribe = agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				agent.setThinkingLevel(ThinkingLevel.High);
			}
		});

		await agent.prompt("run");
		unsubscribe();

		expect(reasoningPerCall).toEqual([ThinkingLevel.Low, ThinkingLevel.High]);
	});
});
