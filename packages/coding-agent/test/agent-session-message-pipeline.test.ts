import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	clearCustomApis,
	type Message,
	type Model,
	registerCustomApi,
	type SimpleStreamOptions,
	type TextContent,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm, wrapSteeringForModel } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function createAgent(): Agent {
	return new Agent({
		initialState: {
			systemPrompt: ["system prompt"],
			messages: [],
			tools: [],
		},
	});
}

function getConvertedUserText(message: Message | undefined): string {
	if (message?.role !== "user") {
		throw new Error("Expected converted user message");
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	const text = message.content.find((content): content is TextContent => content.type === "text");
	if (!text) {
		throw new Error("Expected converted text content");
	}
	return text.text;
}

describe("AgentSession message pipeline", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		clearCustomApis();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("applies transformContext before convertToLlm", async () => {
		const inputMessages: AgentMessage[] = [{ role: "user", content: "hello", timestamp: Date.now() }];
		const transformedMessages: AgentMessage[] = [
			...inputMessages,
			{ role: "user", content: "injected context", timestamp: Date.now() },
		];
		const convertedMessages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "converted" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		];
		const transformContext = vi.fn(async (messages: AgentMessage[], signal?: AbortSignal) => {
			expect(signal).toBe(abortController.signal);
			return [...messages, ...transformedMessages.slice(messages.length)];
		});
		const convertToLlm = vi.fn(async (_messages: AgentMessage[]) => {
			return convertedMessages;
		});
		const abortController = new AbortController();
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			transformContext,
			convertToLlm,
		});
		sessions.push(session);

		const result = await session.convertMessagesToLlm(inputMessages, abortController.signal);

		expect(transformContext).toHaveBeenCalledWith(inputMessages, abortController.signal);
		expect(convertToLlm).toHaveBeenCalledWith(transformedMessages);
		expect(result).toEqual(convertedMessages);
	});

	it("marks queued user steers without changing the public queue text", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		await session.sendUserMessage("raw <steer> &", { deliverAs: "steer" });

		expect(session.getQueuedMessages().steering).toEqual(["raw <steer> &"]);
		const queued = session.agent.popLastSteer();
		if (queued?.role !== "user") {
			throw new Error("Expected queued user steer");
		}
		expect(queued.steering).toBe(true);
		expect(queued.content).toEqual([{ type: "text", text: "raw <steer> &" }]);
		session.clearQueue();
	});

	it("keeps stored steering text raw while pre-LLM conversion wraps it", async () => {
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			transformContext: wrapSteeringForModel,
			convertToLlm,
		});
		sessions.push(session);
		const raw: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "steer with <xml> & ampersand" }],
			steering: true,
			timestamp: 1,
		};
		session.agent.appendMessage(raw);

		const converted = await session.convertMessagesToLlm(session.messages);

		expect(session.messages[0]).toBe(raw);
		expect(raw.content).toEqual([{ type: "text", text: "steer with <xml> & ampersand" }]);
		const convertedText = getConvertedUserText(converted[0]);
		expect(convertedText).toContain("<user_interjection>");
		expect(convertedText).toContain("<message>\nsteer with <xml> & ampersand\n</message>");
		expect(convertedText).not.toContain("&lt;xml&gt;");
		expect(convertedText).not.toContain("&amp;");
	});

	it("composes session payload hooks into direct side-request options", async () => {
		const sessionOnPayload = vi.fn(async (payload: unknown) => ({
			...(payload as Record<string, unknown>),
			session: true,
		}));
		const requestOnPayload = vi.fn(async () => undefined);
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			onPayload: sessionOnPayload,
		});
		sessions.push(session);
		const options: SimpleStreamOptions = {
			apiKey: "key",
			onPayload: requestOnPayload,
		};

		const prepared = session.prepareSimpleStreamOptions(options);
		const result = await prepared.onPayload?.({ original: true });

		expect(sessionOnPayload).toHaveBeenCalledWith({ original: true }, undefined);
		expect(requestOnPayload).toHaveBeenCalledWith({ original: true, session: true }, undefined);
		expect(result).toEqual({ original: true, session: true });
	});
	it("keeps ephemeral side-channel cache key separate from provider routing", async () => {
		const api = "test-ephemeral-side-channel";
		let capturedOptions: SimpleStreamOptions | undefined;
		registerCustomApi(api, (_model, _context, options) => {
			capturedOptions = options;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("Answer");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		const model = {
			id: "side-model",
			name: "Side Model",
			api,
			provider: "test-provider",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} satisfies Model;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {
				getApiKey: vi.fn(async () => "key"),
			} as never,
		});
		sessions.push(session);
		const cacheSessionId = session.sessionId;

		const result = await session.runEphemeralTurn({ promptText: "Question?" });

		expect(result.replyText).toBe("Answer");
		expect(capturedOptions?.promptCacheKey).toBe(cacheSessionId);
		expect(capturedOptions?.sessionId).toStartWith(`${cacheSessionId}:side:`);
		expect(capturedOptions?.sessionId).not.toBe(cacheSessionId);
		expect(capturedOptions?.preferWebsockets).toBe(false);
	});

	it("applies configured OpenRouter routing variant to ephemeral side-channel options", async () => {
		const api = "test-ephemeral-openrouter-variant";
		let capturedOptions: SimpleStreamOptions | undefined;
		registerCustomApi(api, (_model, _context, options) => {
			capturedOptions = options;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("Answer");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "Answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});

		const model = {
			id: "anthropic/claude-sonnet-4",
			name: "OpenRouter Model",
			api,
			provider: "openrouter",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} satisfies Model;
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["system prompt"],
					messages: [],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"providers.openrouterVariant": "nitro",
			}),
			modelRegistry: {
				getApiKey: vi.fn(async () => "key"),
			} as never,
		});
		sessions.push(session);

		const result = await session.runEphemeralTurn({ promptText: "Question?" });

		expect(result.replyText).toBe("Answer");
		expect(capturedOptions?.openrouterVariant).toBe("nitro");
	});

	it("records raw SSE diagnostics into the session buffer before request hooks", async () => {
		const requestOnSseEvent = vi.fn();
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			onSseEvent: requestOnSseEvent,
		});
		sessions.push(session);

		const prepared = session.prepareSimpleStreamOptions({});
		prepared.onSseEvent?.({ event: "message", data: "{}", raw: ["event: message", "data: {}"] });

		expect(session.rawSseDebugBuffer.snapshot().totalEvents).toBe(1);
		expect(requestOnSseEvent).toHaveBeenCalledWith(
			{ event: "message", data: "{}", raw: ["event: message", "data: {}"] },
			undefined,
		);
	});

	it("emits message_update to session listeners before slow extension handlers finish", async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const extensionEmit = vi.fn(async (event: { type: string }) => {
			if (event.type === "message_update") {
				await promise;
			}
		});
		const session = new AgentSession({
			agent: createAgent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			extensionRunner: {
				emit: extensionEmit,
			} as never,
		});
		sessions.push(session);

		const events: AgentSessionEvent[] = [];
		session.subscribe(event => {
			events.push(event);
		});

		const assistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "edit",
					arguments: {},
					partialJson: '{"file":"preview.txt","steps":[{"kbd":["ggdGi"],"insert":"rep',
				},
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as const;

		session.agent.emitExternalEvent({
			type: "message_update",
			message: assistantMessage as never,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "rep",
			},
		} as never);

		await Bun.sleep(0);

		expect(events.some(event => event.type === "message_update")).toBe(true);
		expect(extensionEmit).toHaveBeenCalledTimes(1);

		resolve();
		await Bun.sleep(0);
	});
});
