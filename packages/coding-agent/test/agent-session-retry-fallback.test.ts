import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, Effort, getBundledModel, type Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

class MockAssistantStream extends AssistantMessageEventStream {}

function createAssistantMessage(
	model: Model,
	options: { text?: string; stopReason: "stop" | "error"; errorMessage?: string },
): AssistantMessage {
	return {
		role: "assistant",
		content: options.text ? [{ type: "text", text: options.text }] : [],
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
		stopReason: options.stopReason,
		errorMessage: options.errorMessage,
		timestamp: Date.now(),
	};
}

async function _waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for condition");
}

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

function trackRetryEvents(session: AgentSession): {
	retryStartEvents: AutoRetryStartEvent[];
	retryEndEvents: AutoRetryEndEvent[];
} {
	const retryStartEvents: AutoRetryStartEvent[] = [];
	const retryEndEvents: AutoRetryEndEvent[] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start") {
			retryStartEvents.push(event);
		}
		if (event.type === "auto_retry_end") {
			retryEndEvents.push(event);
		}
	});
	return { retryStartEvents, retryEndEvents };
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage {
	const lastMessage = session.messages.at(-1);
	if (!lastMessage || lastMessage.role !== "assistant") {
		throw new Error("Expected final assistant message");
	}
	return lastMessage;
}

function createFallbackAgent(primaryModel: Model, requestedModels: string[]): Agent {
	let primaryAttempts = 0;
	return new Agent({
		getApiKey: provider => `${provider}-test-key`,
		initialState: {
			model: primaryModel,
			systemPrompt: "Test",
			tools: [],
			messages: [],
		},
		streamFn: model => {
			requestedModels.push(`${model.provider}/${model.id}`);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (model.provider === primaryModel.provider && model.id === primaryModel.id && primaryAttempts === 0) {
					primaryAttempts += 1;
					const message = createAssistantMessage(model, {
						stopReason: "error",
						errorMessage: "rate limit exceeded retry-after-ms=200",
					});
					stream.push({ type: "start", partial: message });
					stream.push({ type: "error", reason: "error", error: message });
					return;
				}
				const message = createAssistantMessage(model, {
					text: `ok:${model.provider}/${model.id}`,
					stopReason: "stop",
				});
				stream.push({ type: "start", partial: createAssistantMessage(model, { text: "", stopReason: "stop" }) });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		},
	});
}

describe("AgentSession retry fallback", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-retry-fallback-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
	});

	it("advances through a role-keyed fallback chain across retries", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const firstFallback = getBundledModel("openai", "gpt-4o-mini");
		const secondFallback = getBundledModel("openai", "gpt-4o");
		if (!primaryModel || !firstFallback || !secondFallback) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const retryStartEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];

		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
			streamFn: model => {
				requestedModels.push(`${model.provider}/${model.id}`);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (model.provider === primaryModel.provider && model.id === primaryModel.id) {
						const message = createAssistantMessage(model, {
							stopReason: "error",
							errorMessage: "overloaded_error: provider returned error 503",
						});
						stream.push({ type: "start", partial: message });
						stream.push({ type: "error", reason: "error", error: message });
						return;
					}
					if (model.provider === firstFallback.provider && model.id === firstFallback.id) {
						const message = createAssistantMessage(model, {
							stopReason: "error",
							errorMessage: "service unavailable: 503 overloaded",
						});
						stream.push({ type: "start", partial: message });
						stream.push({ type: "error", reason: "error", error: message });
						return;
					}
					if (model.provider === secondFallback.provider && model.id === secondFallback.id) {
						const message = createAssistantMessage(model, {
							text: "Recovered on second fallback",
							stopReason: "stop",
						});
						stream.push({
							type: "start",
							partial: createAssistantMessage(model, { text: "", stopReason: "stop" }),
						});
						stream.push({ type: "done", reason: "stop", message });
						return;
					}
					throw new Error(`Unexpected model requested during retry fallback test: ${model.provider}/${model.id}`);
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [
					`${firstFallback.provider}/${firstFallback.id}`,
					`${secondFallback.provider}/${secondFallback.id}`,
				],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "auto_retry_start") {
				retryStartEvents.push(event);
			}
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});

		await session.prompt("Recover from rate limits");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${firstFallback.provider}/${firstFallback.id}`,
			`${secondFallback.provider}/${secondFallback.id}`,
		]);
		expect(session.model?.provider).toBe(secondFallback.provider);
		expect(session.model?.id).toBe(secondFallback.id);
		expect(retryStartEvents.map(event => event.delayMs)).toEqual([0, 0]);
		expect(fallbackAppliedEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: `${primaryModel.provider}/${primaryModel.id}`,
				to: `${firstFallback.provider}/${firstFallback.id}`,
				role: "default",
			},
			{
				type: "retry_fallback_applied",
				from: `${firstFallback.provider}/${firstFallback.id}`,
				to: `${secondFallback.provider}/${secondFallback.id}`,
				role: "default",
			},
		]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 2 });
		expect(fallbackSucceededEvents).toEqual([
			{
				type: "retry_fallback_succeeded",
				model: `${secondFallback.provider}/${secondFallback.id}`,
				role: "default",
			},
		]);
	});

	it("auto-retries preserved OpenAI first-event timeout errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const timeoutMessage = "OpenAI responses stream timed out while waiting for the first event";
		const requestedModels: string[] = [];
		let attemptCount = 0;

		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
			streamFn: requestedModel => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					attemptCount += 1;
					if (attemptCount === 1) {
						const message = createAssistantMessage(requestedModel, {
							stopReason: "error",
							errorMessage: timeoutMessage,
						});
						stream.push({ type: "start", partial: message });
						stream.push({ type: "error", reason: "error", error: message });
						return;
					}
					if (attemptCount === 2) {
						const message = createAssistantMessage(requestedModel, {
							text: "Recovered after OpenAI timeout",
							stopReason: "stop",
						});
						stream.push({
							type: "start",
							partial: createAssistantMessage(requestedModel, { text: "", stopReason: "stop" }),
						});
						stream.push({ type: "done", reason: "stop", message });
						return;
					}
					throw new Error(`Unexpected retry attempt in timeout test: ${attemptCount}`);
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry preserved OpenAI timeout");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: timeoutMessage,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after OpenAI timeout" });
	});

	it("auto-retries Bun socket closure errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const socketError =
			"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
		const requestedModels: string[] = [];
		let attemptCount = 0;

		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
			streamFn: requestedModel => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					attemptCount += 1;
					if (attemptCount === 1) {
						const message = createAssistantMessage(requestedModel, {
							stopReason: "error",
							errorMessage: socketError,
						});
						stream.push({ type: "start", partial: message });
						stream.push({ type: "error", reason: "error", error: message });
						return;
					}
					if (attemptCount === 2) {
						const message = createAssistantMessage(requestedModel, {
							text: "Recovered after socket closure",
							stopReason: "stop",
						});
						stream.push({
							type: "start",
							partial: createAssistantMessage(requestedModel, { text: "", stopReason: "stop" }),
						});
						stream.push({ type: "done", reason: "stop", message });
						return;
					}
					throw new Error(`Unexpected retry attempt in socket closure test: ${attemptCount}`);
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry Bun socket closure");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: socketError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after socket closure" });
	});

	it("auto-retries Anthropic stream-envelope failures before message_start", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const envelopeError = "Anthropic stream envelope error: received content_block_start before message_start";
		const requestedModels: string[] = [];
		let attemptCount = 0;

		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
			streamFn: requestedModel => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					attemptCount += 1;
					if (attemptCount === 1) {
						const message = createAssistantMessage(requestedModel, {
							stopReason: "error",
							errorMessage: envelopeError,
						});
						stream.push({ type: "start", partial: message });
						stream.push({ type: "error", reason: "error", error: message });
						return;
					}
					if (attemptCount === 2) {
						const message = createAssistantMessage(requestedModel, {
							text: "Recovered after Anthropic envelope retry",
							stopReason: "stop",
						});
						stream.push({
							type: "start",
							partial: createAssistantMessage(requestedModel, { text: "", stopReason: "stop" }),
						});
						stream.push({ type: "done", reason: "stop", message });
						return;
					}
					throw new Error(`Unexpected retry attempt in Anthropic envelope test: ${attemptCount}`);
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry Anthropic envelope failure before message_start");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: envelopeError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after Anthropic envelope retry" });
	});

	it("does not auto-retry Anthropic stream-envelope failures before terminal stop signal", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const envelopeError = "Anthropic stream envelope error: received content_block_delta before terminal stop signal";
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];

		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
			streamFn: requestedModel => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage(requestedModel, {
						stopReason: "error",
						errorMessage: envelopeError,
					});
					stream.push({ type: "start", partial: message });
					stream.push({ type: "error", reason: "error", error: message });
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});

		await session.prompt("Do not retry Anthropic envelope failure before terminal stop signal");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(0);
		expect(fallbackAppliedEvents).toHaveLength(0);
		expect(fallbackSucceededEvents).toHaveLength(0);
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("error");
		expect(lastAssistant.errorMessage).toBe(envelopeError);
	});

	it("does not auto-retry generic Request was aborted. errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
			streamFn: requestedModel => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = createAssistantMessage(requestedModel, {
						stopReason: "error",
						errorMessage: "Request was aborted.",
					});
					stream.push({ type: "start", partial: message });
					stream.push({ type: "error", reason: "error", error: message });
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Do not retry generic abort text");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(0);
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("error");
		expect(lastAssistant.errorMessage).toBe("Request was aborted.");
	});

	it("suppresses cooled selectors and lazily reverts to the role primary after cooldown expiry", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("First prompt triggers fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);

		await session.prompt("Immediate second prompt should stay on fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);

		await Bun.sleep(240);
		await session.prompt("Third prompt should lazily revert to primary");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
	});

	it("preserves thinking on bare fallback selectors and does not overwrite user thinking on restore", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const agent = createFallbackAgent(primaryModel, requestedModels);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}:high`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.High,
		});

		await session.prompt("First prompt triggers bare-selector fallback");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(session.model?.id).toBe(fallbackModel.id);
		expect(session.thinkingLevel).toBeUndefined();

		session.setThinkingLevel(Effort.Low);
		await Bun.sleep(240);
		await session.prompt("Second prompt should restore model but preserve user thinking change");
		await session.waitForIdle();
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(session.thinkingLevel).toBeUndefined();
	});

	it("normalizes suppression by base selector and clears it on model refresh", async () => {
		const future = Date.now() + 60_000;
		modelRegistry.suppressSelector("openai/gpt-4o:high", future);
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o")).toBe(true);
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o:low")).toBe(true);

		await modelRegistry.refresh("offline");
		expect(modelRegistry.isSelectorSuppressed("openai/gpt-4o")).toBe(false);
	});
});
