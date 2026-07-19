import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type ToolResultMessage,
} from "omk-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type AgentTool } from "../src/index.ts";

// Mock stream that mimics AssistantMessageEventStream
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

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createAssistantMessageWithToolCalls(
	calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map((call) => ({
			type: "toolCall",
			id: call.id,
			name: call.name,
			arguments: call.arguments,
		})),
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createOrphanToolResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "ghost",
		content: [{ type: "text", text: "orphan" }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createDeferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("Agent", () => {
	it("should create an agent instance with default state", () => {
		const agent = new Agent();

		expect(agent.state.systemPrompt).toBe("");
		expect(agent.state.thinkingLevel).toBe("off");
		expect(agent.state.tools).toEqual([]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.isStreaming).toBe(false);
		expect(agent.state.streamingMessage).toBe(undefined);
		expect(agent.state.pendingToolCalls).toEqual(new Set());
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("should create an agent instance with custom initial state", () => {
		const customModel = getModel("openai", "gpt-4o-mini");
		const agent = new Agent({
			initialState: {
				systemPrompt: "You are a helpful assistant.",
				model: customModel,
				thinkingLevel: "low",
			},
		});

		expect(agent.state.systemPrompt).toBe("You are a helpful assistant.");
		expect(agent.state.model).toBe(customModel);
		expect(agent.state.thinkingLevel).toBe("low");
	});

	it("should subscribe to events", () => {
		const agent = new Agent();

		let eventCount = 0;
		const unsubscribe = agent.subscribe((_event) => {
			eventCount++;
		});

		// No initial event on subscribe
		expect(eventCount).toBe(0);

		// State mutators don't emit events
		agent.state.systemPrompt = "Test prompt";
		expect(eventCount).toBe(0);
		expect(agent.state.systemPrompt).toBe("Test prompt");

		// Unsubscribe should work
		unsubscribe();
		agent.state.systemPrompt = "Another prompt";
		expect(eventCount).toBe(0); // Should not increase
	});

	it("emits full lifecycle events for thrown run failures", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("provider exploded");
			},
		});
		const events: string[] = [];
		agent.subscribe((event) => {
			events.push(event.type);
		});

		await agent.prompt("hello");

		expect(events).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		const lastMessage = agent.state.messages[agent.state.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role !== "assistant") throw new Error("Expected assistant message");
		expect(lastMessage.stopReason).toBe("error");
		expect(lastMessage.errorMessage).toBe("provider exploded");
		expect(agent.state.errorMessage).toBe("provider exploded");
	});

	it("should await async subscribers before prompt resolves", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		let listenerFinished = false;
		agent.subscribe(async (event) => {
			if (event.type === "agent_end") {
				await barrier.promise;
				listenerFinished = true;
			}
		});

		let promptResolved = false;
		const promptPromise = agent.prompt("hello").then(() => {
			promptResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(promptResolved).toBe(false);
		expect(listenerFinished).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await promptPromise;

		expect(listenerFinished).toBe(true);
		expect(promptResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("waitForIdle should wait for async subscribers", async () => {
		const barrier = createDeferred();
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				});
				return stream;
			},
		});

		agent.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				await barrier.promise;
			}
		});

		const promptPromise = agent.prompt("hello");
		let idleResolved = false;
		const idlePromise = agent.waitForIdle().then(() => {
			idleResolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idleResolved).toBe(false);
		expect(agent.state.isStreaming).toBe(true);

		barrier.resolve();
		await Promise.all([promptPromise, idlePromise]);

		expect(idleResolved).toBe(true);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("should pass the active abort signal to subscribers", async () => {
		let receivedSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (options?.signal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		agent.subscribe((event, signal) => {
			if (event.type === "agent_start") {
				receivedSignal = signal;
			}
		});

		const promptPromise = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(receivedSignal).toBeDefined();
		expect(receivedSignal?.aborted).toBe(false);

		agent.abort();
		await promptPromise;

		expect(receivedSignal?.aborted).toBe(true);
	});

	it("should update state with mutators", () => {
		const agent = new Agent();

		// Test setSystemPrompt
		agent.state.systemPrompt = "Custom prompt";
		expect(agent.state.systemPrompt).toBe("Custom prompt");

		// Test setModel
		const newModel = getModel("google", "gemini-2.5-flash");
		agent.state.model = newModel;
		expect(agent.state.model).toBe(newModel);

		// Test setThinkingLevel
		agent.state.thinkingLevel = "high";
		expect(agent.state.thinkingLevel).toBe("high");

		// Test setTools
		const tools: AgentTool[] = [];
		agent.state.tools = tools;
		expect(agent.state.tools).toEqual(tools);
		expect(agent.state.tools).not.toBe(tools); // Should be a copy

		// Test replaceMessages
		const messages = [{ role: "user" as const, content: "Hello", timestamp: Date.now() }];
		agent.state.messages = messages;
		expect(agent.state.messages).toEqual(messages);
		expect(agent.state.messages).not.toBe(messages); // Should be a copy

		// Test appendMessage
		const newMessage = createAssistantMessage("Hi");
		agent.state.messages.push(newMessage);
		expect(agent.state.messages).toHaveLength(2);
		expect(agent.state.messages[1]).toBe(newMessage);

		// Test clearMessages
		agent.state.messages = [];
		expect(agent.state.messages).toEqual([]);
	});

	it.each(["steer", "followUp"] as const)("should support the %s message queue", (method) => {
		const agent = new Agent();
		const message = { role: "user" as const, content: "Queued message", timestamp: Date.now() };

		agent[method](message);

		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("should handle abort controller", () => {
		const agent = new Agent();

		// Should not throw even if nothing is running
		expect(() => agent.abort()).not.toThrow();
	});

	it("should throw when prompt() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			// Use a stream function that responds to abort
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					// Check abort signal periodically
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		// Start first prompt (don't await, it will block until abort)
		const firstPrompt = agent.prompt("First message");

		// Wait a tick for isStreaming to be set
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		// Second prompt should reject
		await expect(agent.prompt("Second message")).rejects.toThrow(
			"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
		);

		// Cleanup - abort to stop the stream
		agent.abort();
		await firstPrompt.catch(() => {}); // Ignore abort error
	});

	it("should throw when continue() called while streaming", async () => {
		let abortSignal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		// Start first prompt
		const firstPrompt = agent.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(agent.state.isStreaming).toBe(true);

		// continue() should reject
		await expect(agent.continue()).rejects.toThrow(
			"Agent is already processing. Wait for completion before continuing.",
		);

		// Cleanup
		agent.abort();
		await firstPrompt.catch(() => {});
	});

	it("continue() should process queued follow-up messages after an assistant turn", async () => {
		const agent = new Agent({
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});

		agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage("Initial response"),
		];

		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "Queued follow-up" }],
			timestamp: Date.now(),
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const hasQueuedFollowUp = agent.state.messages.some((message) => {
			if (message.role !== "user") return false;
			if (typeof message.content === "string") return message.content === "Queued follow-up";
			return message.content.some((part) => part.type === "text" && part.text === "Queued follow-up");
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
						message: createAssistantMessage(`Processed ${responseCount}`),
					});
				});
				return stream;
			},
		});

		agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage("Initial response"),
		];

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
		expect(recentMessages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(responseCount).toBe(2);
	});

	it("forwards sessionId to streamFn options", async () => {
		let receivedSessionId: string | undefined;
		const agent = new Agent({
			sessionId: "session-abc",
			streamFn: (_model, _context, options) => {
				receivedSessionId = options?.sessionId;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage("ok");
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt("hello");
		expect(receivedSessionId).toBe("session-abc");

		// Test setter
		agent.sessionId = "session-def";
		expect(agent.sessionId).toBe("session-def");

		await agent.prompt("hello again");
		expect(receivedSessionId).toBe("session-def");
	});

	it("forwards dag scheduler and concurrency controls to the loop", async () => {
		const schema = Type.Object({ path: Type.String() });
		let active = 0;
		let maxActive = 0;
		const tool: AgentTool<typeof schema, { path: string }> = {
			name: "read",
			label: "Read",
			description: "Tracks scheduler concurrency",
			parameters: schema,
			async execute(_toolCallId, params) {
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active--;
				return { content: [{ type: "text", text: params.path }], details: { path: params.path } };
			},
		};
		let providerCalls = 0;
		const agent = new Agent({
			initialState: { tools: [tool] },
			toolScheduler: "dag-v2",
			maxToolConcurrency: 1,
			strictExtensionClaims: true,
			streamFn: () => {
				const turn = providerCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: turn === 0 ? "toolUse" : "stop",
						message:
							turn === 0
								? createAssistantMessageWithToolCalls([
										{ id: "read-a", name: "read", arguments: { path: "a" } },
										{ id: "read-b", name: "read", arguments: { path: "b" } },
										{ id: "read-c", name: "read", arguments: { path: "c" } },
									])
								: createAssistantMessage("done"),
					});
				});
				return stream;
			},
		});
		const laterListenerIds: string[] = [];
		const listenerSnapshots: AgentEvent[] = [];
		agent.subscribe((event) => {
			if (event.type !== "message_start" || event.message.role !== "toolResult") return;
			listenerSnapshots.push(event);
			Reflect.set(event, "message", createOrphanToolResult("forged"));
		});
		agent.subscribe((event) => {
			if (event.type !== "message_start" || event.message.role !== "toolResult") return;
			listenerSnapshots.push(event);
			laterListenerIds.push(event.message.toolCallId);
		});
		await agent.prompt("read all");
		expect(maxActive).toBe(1);
		expect(providerCalls).toBe(2);
		expect(agent.toolScheduler).toBe("dag-v2");
		expect(agent.maxToolConcurrency).toBe(1);
		const results = agent.state.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(results).toHaveLength(3);
		expect(laterListenerIds).toEqual(["read-a", "read-b", "read-c"]);
		expect(listenerSnapshots.every(Object.isFrozen)).toBe(true);
		expect(new Set(listenerSnapshots).size).toBe(listenerSnapshots.length);
		expect(results.every((result) => Object.isFrozen(result))).toBe(true);
		for (const result of results) {
			expect(result.details).toMatchObject({ omk: { schema: "tool-result/v2", disposition: "completed" } });
		}
	});

	it("closes an aborted call despite a never-settling update listener and rejects terminal mutation", async () => {
		// Given: an in-flight write emits an update, then ignores abort forever.
		const schema = Type.Object({ path: Type.String() });
		const updateListenerEntered = createDeferred();
		const tool: AgentTool<typeof schema> = {
			name: "write",
			label: "Write",
			description: "Never settles after its update",
			parameters: schema,
			execute: (_id, params, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "partial" }], details: { path: params.path } });
				return new Promise(() => undefined);
			},
		};
		let providerCalls = 0;
		const agent = new Agent({
			initialState: { tools: [tool] },
			toolScheduler: "dag-v2",
			streamFn: () => {
				const turn = providerCalls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message =
						turn === 0
							? createAssistantMessageWithToolCalls([
									{ id: "write-1", name: "write", arguments: { path: "shared" } },
								])
							: createAssistantMessage("unexpected continuation");
					stream.push({ type: "done", reason: turn === 0 ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			if (event.type !== "tool_execution_update") return;
			updateListenerEntered.resolve();
			return new Promise<void>(() => undefined);
		});
		const observed: string[] = [];
		agent.subscribe((event) => {
			observed.push(event.type);
			if (event.type === "tool_execution_end") {
				Reflect.set(event, "isError", false);
				if (typeof event.result === "object" && event.result !== null) {
					Reflect.set(event.result, "details", { omk: { schema: "forged" } });
				}
			}
			if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "toolResult") {
				Reflect.set(event.message, "isError", false);
				Reflect.set(event.message, "content", [{ type: "text", text: "forged" }]);
				Reflect.set(event.message, "details", { omk: { schema: "forged" } });
			}
		});
		// When: abort wins after the public update listener starts and never settles.
		const prompt = agent.prompt("write");
		await updateListenerEntered.promise;
		agent.abort();
		const outcome = await Promise.race([
			prompt.then(() => "settled" as const),
			new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
		]);
		// Then: one immutable aborted result/end closes the run with no provider continuation.
		expect(outcome).toBe("settled");
		if (outcome === "pending") return;
		const results = agent.state.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			toolCallId: "write-1",
			isError: true,
			content: [{ type: "text", text: "Operation aborted" }],
			details: { omk: { schema: "tool-result/v2", disposition: "aborted" } },
		});
		expect(Object.isFrozen(results[0])).toBe(true);
		expect(Object.isFrozen(results[0].content)).toBe(true);
		expect(observed.filter((type) => type === "tool_execution_end")).toHaveLength(1);
		expect(observed.indexOf("tool_execution_update")).toBeLessThan(observed.indexOf("tool_execution_end"));
		expect(providerCalls).toBe(1);
		expect(agent.state.isStreaming).toBe(false);
	});
	it("closes an unambiguous open tool tail with exactly one synthetic result per call before the terminal failure", async () => {
		let providerCallCount = 0;
		const agent = new Agent({
			streamFn: () => {
				providerCallCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: createAssistantMessageWithToolCalls([
							{ id: "call_a", name: "search", arguments: {} },
							{ id: "call_b", name: "search", arguments: {} },
						]),
					});
				});
				return stream;
			},
		});

		const events: string[] = [];
		const toolResultIds: string[] = [];
		// Simulate a persistence/listener failure that rejects immediately after the
		// assistant turn (with its tool calls) is recorded, but before tool execution
		// can emit any results. This leaves the transcript with an open tool tail.
		let threwForOpenTail = false;
		agent.subscribe((event) => {
			events.push(event.type);
			if (event.type === "message_end" && event.message.role === "toolResult") {
				toolResultIds.push(event.message.toolCallId);
			}
			if (
				!threwForOpenTail &&
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.content.some((block) => block.type === "toolCall")
			) {
				threwForOpenTail = true;
				throw new Error("persistence listener failed after assistant turn");
			}
		});

		await agent.prompt("hello");

		// The provider was called once (turn 1) and never again for the failure turn.
		expect(providerCallCount).toBe(1);
		// Exactly one synthetic result per open tool call, in source order.
		expect(toolResultIds).toEqual(["call_a", "call_b"]);
		// The open tail is closed before a single coherent failure assistant.
		expect(agent.state.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"assistant",
		]);
		const assistantMessages = agent.state.messages.filter((message) => message.role === "assistant");
		expect(assistantMessages).toHaveLength(2);
		const failure = assistantMessages[1];
		if (failure.role !== "assistant") throw new Error("Expected assistant failure message");
		expect(failure.stopReason).toBe("error");
		expect(failure.errorMessage).toBe("persistence listener failed after assistant turn");
		expect(agent.state.errorMessage).toBe("persistence listener failed after assistant turn");
		expect(events[events.length - 1]).toBe("agent_end");
	});

	it("fails closed without a provider call or fabricated assistant when the transcript is ambiguous", async () => {
		let providerCallCount = 0;
		const agent = new Agent({
			streamFn: () => {
				providerCallCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage("should not happen"),
					});
				});
				return stream;
			},
		});

		// Seed an orphan tool result (result with no matching call): ambiguous, never auto-repaired.
		agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "seed" }], timestamp: Date.now() - 10 },
			createOrphanToolResult("ghost"),
		];

		const events: string[] = [];
		agent.subscribe((event) => {
			events.push(event.type);
		});

		await agent.prompt("hello");

		// Integrity rejected before any provider request.
		expect(providerCallCount).toBe(0);
		// No failure assistant fabricated over the corrupt transcript.
		expect(agent.state.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
		expect(agent.state.errorMessage).toBeUndefined();
		// Fail-closed terminal sequence: the prompt message is recorded, then agent_end.
		expect(events).toEqual(["agent_start", "turn_start", "message_start", "message_end", "agent_end"]);
	});

	it("continue() from an invalid transcript fails closed without calling the provider", async () => {
		let providerCallCount = 0;
		const agent = new Agent({
			streamFn: () => {
				providerCallCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage("should not happen"),
					});
				});
				return stream;
			},
		});

		// Seed an orphan tool result so assertContinuableTranscript rejects before any turn.
		agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "seed" }], timestamp: Date.now() - 10 },
			createOrphanToolResult("ghost"),
		];

		const events: string[] = [];
		agent.subscribe((event) => {
			events.push(event.type);
		});

		await agent.continue();

		// No provider request and no fabricated assistant over the corrupt transcript.
		expect(providerCallCount).toBe(0);
		expect(agent.state.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
		expect(agent.state.errorMessage).toBeUndefined();
		// Fail-closed terminal sequence: the continuation rejects before agent_start.
		expect(events).toEqual(["agent_end"]);
	});
});
describe("Agent immutable tool argument snapshots (ALG002 P9/P10)", () => {
	it.each(["read", "write"] as const)(
		"isolates %s/write execution from post-claim event mutation",
		async (firstAccess) => {
			// Given: two claim-disjoint calls whose second public start payload is retargeted to the first path.
			const schema = Type.Object({ path: Type.String() });
			const active: Array<{ id: string; path: string; access: "read" | "write" }> = [];
			const actualPaths: string[] = [];
			let conflictOverlapped = false;
			const makeTool = (name: "read" | "write"): AgentTool<typeof schema> => ({
				name,
				label: name,
				description: name,
				parameters: schema,
				async execute(id, params) {
					const access = id === "first" ? firstAccess : "write";
					conflictOverlapped ||= active.some(
						(entry) => entry.path === params.path && (entry.access === "write" || access === "write"),
					);
					active.push({ id, path: params.path, access });
					actualPaths.push(params.path);
					await new Promise<void>((resolve) => setImmediate(resolve));
					active.splice(
						active.findIndex((entry) => entry.id === id),
						1,
					);
					return { content: [{ type: "text", text: params.path }], details: {} };
				},
			});
			let providerCalls = 0;
			const agent = new Agent({
				initialState: {
					tools: firstAccess === "read" ? [makeTool("read"), makeTool("write")] : [makeTool("write")],
				},
				toolScheduler: "dag-v2",
				beforeToolCall: async () => undefined,
				streamFn: () => {
					const turn = providerCalls++;
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						const message =
							turn === 0
								? createAssistantMessageWithToolCalls([
										{ id: "first", name: firstAccess, arguments: { path: "shared" } },
										{ id: "second", name: "write", arguments: { path: "other" } },
									])
								: createAssistantMessage("done");
						stream.push({ type: "done", reason: turn === 0 ? "toolUse" : "stop", message });
					});
					return stream;
				},
			});
			const mutationResults: boolean[] = [];
			agent.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolCallId === "second") {
					mutationResults.push(
						typeof event.args === "object" && event.args !== null && Reflect.set(event.args, "path", "shared"),
					);
				}
			});
			// When: final claims are fixed, then the adversarial subscriber receives the detached payload.
			await agent.prompt("run both");
			// Then: both read/write and write/write executions retain their separately claimed paths.
			expect(mutationResults).toEqual([false]);
			expect(actualPaths).toEqual(["shared", "other"]);
			expect(conflictOverlapped).toBe(false);
			expect(providerCalls).toBe(2);
		},
	);
});
