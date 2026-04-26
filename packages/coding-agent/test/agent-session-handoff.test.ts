import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRunner, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

class MockAssistantStream extends AssistantMessageEventStream {}

describe("AgentSession handoff", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let events: AgentSessionEvent[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-handoff-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
			}),
			modelRegistry,
		});

		session.subscribe(event => {
			events.push(event);
		});

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("does not run auto-compaction after handoff turn completes", async () => {
		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const handoffText = "## Goal\nContinue from here";
		const handoffAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: handoffText }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 190_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			session.agent.replaceMessages([handoffAssistant]);
			session.agent.emitExternalEvent({ type: "message_end", message: handoffAssistant });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [handoffAssistant] });
		});

		const result = await session.handoff();
		await Bun.sleep(20);

		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(result?.document).toBe(handoffText);
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);
	});

	it("does not run auto maintenance after final yield", async () => {
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const yieldCall: ToolCall = {
			type: "toolCall",
			id: "call_yield_done",
			name: "yield",
			arguments: { result: { data: { done: true } } },
		};
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [yieldCall],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff document" });
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: yieldCall.id,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { done: true } },
			},
			isError: false,
		});
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await Bun.sleep(20);

		expect(handoffSpy).not.toHaveBeenCalled();
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
	});

	it("does not run auto maintenance when strategy is off", async () => {
		session.settings.set("compaction.strategy", "off");
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff");
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await Bun.sleep(20);

		expect(handoffSpy).not.toHaveBeenCalled();
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
	});

	it("restores context-full strategy when enabling auto-compaction from off strategy", () => {
		session.settings.set("compaction.enabled", true);
		session.settings.set("compaction.strategy", "off");

		expect(session.autoCompactionEnabled).toBe(false);
		session.setAutoCompactionEnabled(true);
		expect(session.settings.get("compaction.strategy")).toBe("context-full");
		expect(session.autoCompactionEnabled).toBe(true);
	});

	it("falls back to context-full maintenance for overflow when strategy is handoff", async () => {
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}
		const handoffSpy = vi.spyOn(session, "handoff");

		const overflowAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "overflow" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "error",
			errorMessage: "maximum context length is 200000 tokens, however you requested 200001 tokens",
			usage: {
				input: 120_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: overflowAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowAssistant] });
		await Bun.sleep(20);

		expect(handoffSpy).not.toHaveBeenCalled();
		const startEvents = events.filter(event => event.type === "auto_compaction_start");
		expect(startEvents).toHaveLength(1);
		expect(startEvents[0]).toMatchObject({ type: "auto_compaction_start", reason: "overflow" });
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).not.toMatchObject({
			errorMessage: "Auto-handoff failed: no handoff document was generated",
		});
	});

	it("uses handoff strategy for threshold-triggered auto maintenance", async () => {
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff document" });

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await Bun.sleep(20);

		expect(handoffSpy).toHaveBeenCalledTimes(1);
		expect(handoffSpy).toHaveBeenCalledWith(expect.stringContaining("Threshold-triggered maintenance"), {
			autoTriggered: true,
			signal: expect.anything(),
		});
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({ type: "auto_compaction_end", aborted: false, willRetry: false });
	});

	it("completes threshold-triggered auto-handoff while the original prompt is still unwinding", async () => {
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];
		let streamCallCount = 0;

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});

		const thresholdAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 190_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		const handoffAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "## Goal\nContinue from here" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 8_000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 8_500,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() + 1,
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
			streamFn: () => {
				streamCallCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = streamCallCount === 1 ? thresholdAssistant : handoffAssistant;
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.strategy": "handoff",
				"compaction.thresholdPercent": 1,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
		});
		session.subscribe(event => {
			events.push(event);
		});

		await session.prompt("Trigger threshold handoff");

		expect(streamCallCount).toBe(2);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({ type: "auto_compaction_end", action: "handoff", aborted: false });
		expect(endEvents[0]).not.toMatchObject({ errorMessage: expect.any(String) });
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);
	});

	it("falls back to context-full when handoff strategy returns no document", async () => {
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue(undefined);

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await Bun.sleep(20);

		expect(handoffSpy).toHaveBeenCalledTimes(1);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({
			type: "auto_compaction_end",
			action: "context-full",
			aborted: false,
			willRetry: false,
		});
		expect(endEvents[0]).not.toMatchObject({
			errorMessage: "Auto-handoff failed: no handoff document was generated",
		});
	});

	it("resets to the base system prompt before generating a handoff", async () => {
		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}
		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const extensionsResult = await loadExtensions([], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const emitBeforeAgentStart = vi.spyOn(extensionRunner, "emitBeforeAgentStart").mockResolvedValueOnce({
			systemPrompt: "Hook override",
		});
		vi.spyOn(extensionRunner, "emit").mockResolvedValue(undefined);

		const observedSystemPrompts: string[] = [];
		let streamCallCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
			streamFn: (_model, context) => {
				observedSystemPrompts.push(context.systemPrompt ?? "");
				streamCallCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message: AssistantMessage = {
						role: "assistant",
						content: [
							{
								type: "text",
								text: streamCallCount === 1 ? "normal response" : "## Goal\nContinue from here",
							},
						],
						api: model.api,
						provider: model.provider,
						model: model.id,
						stopReason: "stop",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});

		await session.prompt("hello from user");
		await session.handoff();

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
		expect(observedSystemPrompts).toEqual(["Hook override", "Test"]);
	});

	it("saves auto-handoff document to disk when enabled", async () => {
		session.settings.set("compaction.handoffSaveToDisk", true);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const handoffText = "## Goal\nContinue from here";
		const handoffAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: handoffText }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 190_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			session.agent.replaceMessages([handoffAssistant]);
			session.agent.emitExternalEvent({ type: "message_end", message: handoffAssistant });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [handoffAssistant] });
		});

		const result = await session.handoff(undefined, { autoTriggered: true });
		expect(result?.savedPath).toBeDefined();
		if (!result?.savedPath) throw new Error("Expected handoff document path");
		expect(result.savedPath.endsWith(".md")).toBe(true);
		const savedText = await Bun.file(result.savedPath).text();
		expect(savedText).toContain(handoffText);
	});

	it("does not save manual handoff document when save setting is enabled", async () => {
		session.settings.set("compaction.handoffSaveToDisk", true);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const handoffAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "## Goal\nManual handoff" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 190_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			session.agent.replaceMessages([handoffAssistant]);
			session.agent.emitExternalEvent({ type: "message_end", message: handoffAssistant });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [handoffAssistant] });
		});

		const result = await session.handoff();
		expect(result?.savedPath).toBeUndefined();
	});

	it("does not start handoff prompt when provided signal is already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();

		const promptSpy = vi.spyOn(session.agent, "prompt");
		const abortSpy = vi.spyOn(session.agent, "abort");

		await expect(session.handoff(undefined, { signal: controller.signal })).rejects.toThrow("Handoff cancelled");
		expect(promptSpy).not.toHaveBeenCalled();
		expect(abortSpy).toHaveBeenCalledTimes(1);
	});

	it("aborts handoff generation when provided signal is cancelled", async () => {
		const controller = new AbortController();
		const { promise: promptPromise, resolve: resolvePrompt } = Promise.withResolvers<void>();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			await promptPromise;
		});
		const abortSpy = vi.spyOn(session.agent, "abort").mockImplementation(() => {
			resolvePrompt();
		});

		const handoffPromise = session.handoff(undefined, { signal: controller.signal });
		await Bun.sleep(10);
		controller.abort();

		await expect(handoffPromise).rejects.toThrow("Handoff cancelled");
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(abortSpy).toHaveBeenCalled();
	});
});
