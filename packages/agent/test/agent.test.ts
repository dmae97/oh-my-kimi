import { describe, expect, it } from "bun:test";
import { Agent, type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { z } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createAssistantMessage } from "./helpers";

describe("Agent", () => {
	it("should support steering message queueing", async () => {
		const agent = new Agent();

		const message = { role: "user" as const, content: "Queued message", timestamp: Date.now() };
		agent.steer(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("continue() should process queued follow-up messages after an assistant turn", async () => {
		const mock = createMockModel({ responses: [{ content: ["Processed"] }] });
		const agent = new Agent({ streamFn: mock.stream });

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
		const mock = createMockModel({
			responses: [{ content: ["Processed 1"] }, { content: ["Processed 2"] }],
		});
		const agent = new Agent({ streamFn: mock.stream });

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
		expect(mock.calls.length).toBe(2);
	});

	it("prompt() refreshes tools and system prompt between same-turn model calls", async () => {
		const toolSchema = z.object({ value: z.string() });
		type Details = { value: string };

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

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "alpha", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});

		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["prompt-one"],
				tools: [alphaTool],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const unsubscribe = agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				agent.setSystemPrompt(["prompt-two"]);
				agent.setTools([alphaTool, betaTool]);
			}
		});

		await agent.prompt("refresh tools");
		unsubscribe();

		const observed = mock.calls.map(call => ({
			systemPrompt: call.context.systemPrompt?.join("\n\n") ?? "",
			toolNames: (call.context.tools ?? []).map(tool => tool.name),
		}));
		expect(observed).toEqual([
			{ systemPrompt: "prompt-one", toolNames: ["alpha"] },
			{ systemPrompt: "prompt-two", toolNames: ["alpha", "beta"] },
		]);
	});

	it("prompt() drops stale forced toolChoice after same-turn tool refresh", async () => {
		const toolSchema = z.object({ value: z.string() });
		type Details = { value: string };

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

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "alpha", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});

		const agent = new Agent({
			initialState: {
				model: mock.model,
				tools: [alphaTool],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const unsubscribe = agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				agent.setTools([betaTool]);
			}
		});

		await agent.prompt("refresh tools", { toolChoice: { type: "function", name: "alpha" } });
		unsubscribe();

		const observed = mock.calls.map(call => ({
			toolNames: (call.context.tools ?? []).map(tool => tool.name),
			toolChoice: call.options?.toolChoice,
		}));
		expect(observed).toEqual([
			{ toolNames: ["alpha"], toolChoice: { type: "function", name: "alpha" } },
			{ toolNames: ["beta"], toolChoice: undefined },
		]);
	});

	it("re-reads thinking level for each model call within a run", async () => {
		const toolSchema = z.object({ value: z.string() });
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

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "alpha", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});

		const agent = new Agent({
			initialState: {
				model: mock.model,
				thinkingLevel: ThinkingLevel.Low,
				tools: [alphaTool],
				messages: [],
			},
			streamFn: mock.stream,
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

		const reasoningPerCall: Array<SimpleStreamOptions["reasoning"]> = mock.calls.map(call => call.options?.reasoning);
		expect(reasoningPerCall).toEqual([ThinkingLevel.Low, ThinkingLevel.High]);
	});

	it("returns static metadata via the plain setter", () => {
		const agent = new Agent();
		expect(agent.metadata).toBeUndefined();

		const value = { user_id: "static" };
		agent.metadata = value;
		expect(agent.metadata).toEqual({ user_id: "static" });

		agent.metadata = undefined;
		expect(agent.metadata).toBeUndefined();
	});

	it("metadataForProvider resolves dynamic value at every call when a resolver is installed", () => {
		const agent = new Agent();
		let live = "alpha";
		agent.setMetadataResolver(() => ({ user_id: live }));

		expect(agent.metadataForProvider("anthropic")).toEqual({ user_id: "alpha" });
		live = "beta";
		expect(agent.metadataForProvider("anthropic")).toEqual({ user_id: "beta" });
		// Static getter is unaffected by the resolver.
		expect(agent.metadata).toBeUndefined();
	});

	it("clears any installed resolver when assigning the plain setter", () => {
		const agent = new Agent();
		agent.setMetadataResolver(() => ({ user_id: "from-resolver" }));
		expect(agent.metadataForProvider("any")).toEqual({ user_id: "from-resolver" });

		agent.metadata = { user_id: "from-static" };
		expect(agent.metadata).toEqual({ user_id: "from-static" });
		expect(agent.metadataForProvider("any")).toEqual({ user_id: "from-static" });
	});

	it("metadataForProvider returns undefined from the resolver even when a static value is set", () => {
		// Pin the contract that an installed resolver wins unconditionally over
		// `#metadata` in the per-provider path.
		const agent = new Agent();
		agent.metadata = { user_id: "static" };
		agent.setMetadataResolver(() => undefined);
		expect(agent.metadataForProvider("any")).toBeUndefined();
		// The static getter returns the pre-set static value; the resolver does not affect it.
		expect(agent.metadata).toEqual({ user_id: "static" });
	});

	it("reverts to the plain-setter value when the resolver is cleared via setMetadataResolver(undefined)", () => {
		const agent = new Agent();
		agent.metadata = { user_id: "static" };
		agent.setMetadataResolver(() => ({ user_id: "from-resolver" }));
		expect(agent.metadataForProvider("any")).toEqual({ user_id: "from-resolver" });

		agent.setMetadataResolver(undefined);
		expect(agent.metadataForProvider("any")).toEqual({ user_id: "static" });
		expect(agent.metadata).toEqual({ user_id: "static" });
	});
});

describe("Agent — F3 in-place state mutation", () => {
	it("appendMessage mutates the existing messages array in place", () => {
		const agent = new Agent();
		const arr = agent.state.messages;

		agent.appendMessage({ role: "user", content: "a", timestamp: 1 });
		agent.appendMessage({ role: "user", content: "b", timestamp: 2 });

		expect(agent.state.messages).toBe(arr);
		expect(arr.length).toBe(2);
	});

	it("popMessage mutates in place and clears streamMessage when popping it", () => {
		const agent = new Agent();
		const arr = agent.state.messages;

		const m1 = { role: "user" as const, content: "x", timestamp: 1 };
		const m2 = { role: "user" as const, content: "y", timestamp: 2 };
		agent.appendMessage(m1);
		agent.appendMessage(m2);

		const removed = agent.popMessage();
		expect(removed).toBe(m2);
		expect(agent.state.messages).toBe(arr);
		expect(agent.state.messages).toEqual([m1]);
	});

	it("clearMessages and reset preserve array/Set identity", () => {
		const agent = new Agent();
		const msgs = agent.state.messages;
		const pending = agent.state.pendingToolCalls;

		agent.appendMessage({ role: "user", content: "x", timestamp: 1 });
		agent.clearMessages();
		expect(agent.state.messages).toBe(msgs);
		expect(agent.state.messages.length).toBe(0);

		agent.appendMessage({ role: "user", content: "y", timestamp: 2 });
		agent.reset();
		expect(agent.state.messages).toBe(msgs);
		expect(agent.state.pendingToolCalls).toBe(pending);
		expect(agent.state.messages.length).toBe(0);
		expect(agent.state.pendingToolCalls.size).toBe(0);
	});

	it("replaceMessages still snapshots the input (callers may keep mutating their array)", () => {
		const agent = new Agent();
		const external = [{ role: "user" as const, content: "x", timestamp: 1 }];
		agent.replaceMessages(external);
		external.push({ role: "user", content: "leaked", timestamp: 2 });
		expect(agent.state.messages.length).toBe(1);
	});
});
