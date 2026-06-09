import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import {
	applyOpenRouterRoutingVariant,
	convertMessages,
	detectCompat,
	streamOpenAICompletions,
} from "@oh-my-pi/pi-ai/providers/openai-completions";
import { type ResolvedOpenAICompat, resolveOpenAICompat } from "@oh-my-pi/pi-ai/providers/openai-completions-compat";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	OpenAICompat,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai/types";

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function toObject(value: unknown): object | null {
	return typeof value === "object" && value !== null ? value : null;
}

function getNestedObject(value: unknown, key: string): object | null {
	const obj = toObject(value);
	if (!obj) return null;
	return toObject(Reflect.get(obj, key));
}

function getNestedBoolean(value: unknown, key: string): boolean | undefined {
	const obj = toObject(value);
	if (!obj) return undefined;
	const property = Reflect.get(obj, key);
	return typeof property === "boolean" ? property : undefined;
}

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createMockFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createSseResponse(events);
	}

	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: "hello",
				timestamp: Date.now(),
			},
		],
	};
}

async function captureOpenAICompletionsPayload(
	model: Model<"openai-completions">,
	context: Context = baseContext(),
): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	const fetchMock = createMockFetch(["[DONE]"]);
	streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		fetch: fetchMock,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return promise;
}

function getPayloadMessages(payload: unknown): object[] {
	const payloadObject = toObject(payload);
	const messages = payloadObject ? Reflect.get(payloadObject, "messages") : undefined;
	if (!Array.isArray(messages)) throw new Error("payload messages missing");
	return messages.map(message => {
		const messageObject = toObject(message);
		if (!messageObject) throw new Error("payload message is not an object");
		return messageObject;
	});
}

function getLastPayloadContent(payload: unknown): unknown {
	const lastMessage = getPayloadMessages(payload).at(-1);
	if (!lastMessage) throw new Error("payload has no messages");
	return Reflect.get(lastMessage, "content");
}

function getLastTextPart(content: unknown): object | undefined {
	if (!Array.isArray(content)) return undefined;
	for (let index = content.length - 1; index >= 0; index--) {
		const part = toObject(content[index]);
		if (part && Reflect.get(part, "type") === "text") return part;
	}
	return undefined;
}

describe("openai-completions compatibility", () => {
	it("serializes assistant text content as a plain string", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};
		const compat = {
			supportsStore: true,
			supportsDeveloperRole: true,
			supportsMultipleSystemMessages: true,
			supportsReasoningEffort: true,
			reasoningEffortMap: {},
			supportsUsageInStreaming: true,
			supportsToolChoice: true,
			disableReasoningOnForcedToolChoice: false,
			disableReasoningOnToolChoice: false,
			maxTokensField: "max_completion_tokens",
			requiresToolResultName: false,
			requiresAssistantAfterToolResult: false,
			requiresThinkingAsText: false,
			requiresMistralToolIds: false,
			thinkingFormat: "openai",
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: false,
			allowsSyntheticReasoningContentForToolCalls: true,
			requiresAssistantContentForToolCalls: false,
			openRouterRouting: {},
			vercelGatewayRouting: {},
			extraBody: {},
			supportsStrictMode: true,
			toolStrictMode: "none",
		} satisfies ResolvedOpenAICompat;
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "hello" },
				{ type: "text", text: " world" },
			],
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
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const messages = convertMessages(model, { messages: [assistantMessage] }, compat);
		const assistant = messages.find(message => message.role === "assistant");
		expect(assistant).toBeDefined();
		if (assistant?.role !== "assistant") {
			throw new Error("assistant message missing");
		}
		expect(typeof assistant.content).toBe("string");
		expect(assistant.content).toBe("hello world");
	});

	it("preserves multiple system prompts as leading system messages for chat completions", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			detectCompat(model),
		);

		expect(messages.slice(0, 3)).toEqual([
			{ role: "system", content: "stable instructions" },
			{ role: "system", content: "cacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("uses developer messages for reasoning chat models only when the target supports them", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			reasoning: true,
		};

		const supportedMessages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			detectCompat(model),
		);

		expect(supportedMessages.slice(0, 3)).toEqual([
			{ role: "developer", content: "stable instructions" },
			{ role: "developer", content: "cacheable policy" },
			{ role: "user", content: "hello" },
		]);

		const unsupportedMessages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ ...detectCompat(model), supportsDeveloperRole: false },
		);

		expect(unsupportedMessages.slice(0, 3)).toEqual([
			{ role: "system", content: "stable instructions" },
			{ role: "system", content: "cacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("defaults supportsDeveloperRole to off for non-OpenAI/Azure hosts", () => {
		// Regression: Moonshot's Kimi chat template rejects the `developer` role
		// with `400 Invalid request: tokenization failed` because `developer` is
		// an OpenAI extension and most other hosts don't carry it through their
		// tokenizer. The default for any non-OpenAI/Azure host MUST be `system`,
		// so reasoning models on those hosts cannot accidentally emit `developer`.
		const cases: Array<{ provider: string; baseUrl: string; expected: boolean }> = [
			{ provider: "openai", baseUrl: "https://api.openai.com/v1", expected: true },
			{ provider: "azure", baseUrl: "https://example.openai.azure.com/openai", expected: true },
			{ provider: "moonshot", baseUrl: "https://api.moonshot.ai/v1", expected: false },
			{ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", expected: false },
			{ provider: "groq", baseUrl: "https://api.groq.com/openai/v1", expected: false },
			{ provider: "github-copilot", baseUrl: "https://api.githubcopilot.com", expected: false },
		];
		for (const { provider, baseUrl, expected } of cases) {
			const model: Model<"openai-completions"> = {
				...getBundledModel("openai", "gpt-4o-mini"),
				api: "openai-completions",
				provider: provider as Model["provider"],
				baseUrl,
				reasoning: true,
			};
			expect(detectCompat(model).supportsDeveloperRole).toBe(expected);
		}
	});

	it("emits system role for reasoning models on Moonshot (kimi tokenization rejects developer)", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "moonshot",
			baseUrl: "https://api.moonshot.ai/v1",
			id: "kimi-k2.5",
			reasoning: true,
		};

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["you are a helpful assistant"],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			detectCompat(model),
		);

		expect(messages.slice(0, 2)).toEqual([
			{ role: "system", content: "you are a helpful assistant" },
			{ role: "user", content: "hi" },
		]);
	});

	it("coalesces ordered system prompts when the host disables multi-system support", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ ...detectCompat(model), supportsMultipleSystemMessages: false },
		);

		expect(messages.slice(0, 2)).toEqual([
			{ role: "system", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("coalesces system prompts on a developer-role reasoning model when multi-system is disabled", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			reasoning: true,
		};

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ ...detectCompat(model), supportsMultipleSystemMessages: false },
		);

		expect(messages.slice(0, 2)).toEqual([
			{ role: "developer", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("emits separate system prompts for an unknown OpenAI-compatible host when explicitly enabled", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "custom" as Model["provider"],
			baseUrl: "https://example.invalid/v1",
		};

		const detected = detectCompat(model);
		expect(detected.supportsMultipleSystemMessages).toBe(false);

		const overridden = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ ...detected, supportsMultipleSystemMessages: true },
		);

		expect(overridden.slice(0, 3)).toEqual([
			{ role: "system", content: "stable instructions" },
			{ role: "system", content: "cacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("auto-detects MiniMax OpenAI hosts as single-system to satisfy error 2013", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "minimax-code" as Model["provider"],
			baseUrl: "https://api.minimax.io/v1",
		};

		const detected = detectCompat(model);
		expect(detected.supportsMultipleSystemMessages).toBe(false);

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			detected,
		);

		expect(messages.slice(0, 2)).toEqual([
			{ role: "system", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("respects an explicit compat override for strict-template local providers", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "custom" as Model["provider"],
			baseUrl: "https://my-vllm.local/v1",
			compat: {
				supportsDeveloperRole: false,
				supportsMultipleSystemMessages: false,
			},
		};

		const messages = convertMessages(
			model,
			{
				systemPrompt: ["stable instructions", "cacheable policy"],
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			resolveOpenAICompat(model),
		);

		expect(messages.slice(0, 2)).toEqual([
			{ role: "system", content: "stable instructions\n\ncacheable policy" },
			{ role: "user", content: "hello" },
		]);
	});

	it("reads usage from choice usage fallback", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { content: "Hello" },
						usage: {
							prompt_tokens: 12,
							completion_tokens: 3,
							prompt_tokens_details: { cached_tokens: 2 },
						},
					},
				],
			},
			{
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(10);
		expect(result.usage.output).toBe(3);
		expect(result.usage.cacheRead).toBe(2);
		expect(result.usage.totalTokens).toBe(15);
	});

	it("maps qwen chat template reasoning into chat_template_kwargs", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			reasoning: true,
			compat: {
				thinkingFormat: "qwen-chat-template",
			},
		};
		const { promise, resolve } = Promise.withResolvers<unknown>();
		streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			reasoning: "high",
			signal: createAbortedSignal(),
			onPayload: payload => resolve(payload),
		});
		const payload = await promise;
		const chatTemplateArgs = getNestedObject(payload, "chat_template_kwargs");
		expect(getNestedBoolean(chatTemplateArgs, "enable_thinking")).toBe(true);
	});

	it("treats finish_reason end as stop", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-end",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "done" } }],
			},
			{
				id: "chatcmpl-end",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "end" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ type: "text", text: "done" });
	});

	it("injects compat.extraBody into OpenAI payload", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			compat: {
				extraBody: {
					gateway: "m1-01",
					controller: "mlx",
				},
			},
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			signal: createAbortedSignal(),
			onPayload: payload => resolve(payload),
		});

		const payload = await promise;
		expect(payload).toEqual(
			expect.objectContaining({
				gateway: "m1-01",
				controller: "mlx",
			}),
		);
	});

	it("preserves the streamed reasoning field name when replay requires reasoning content", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-reasoning-text",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { reasoning_text: "inspect tool output" },
					},
				],
			},
			{
				id: "chatcmpl-reasoning-text",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		expect(result.content).toContainEqual({
			type: "thinking",
			thinking: "inspect tool output",
			thinkingSignature: "reasoning_text",
		});

		const compat = { ...detectCompat(model), requiresReasoningContentForToolCalls: true };
		const messages = convertMessages(model, { messages: [result] }, compat);
		const assistant = messages.find(message => message.role === "assistant");
		expect(assistant).toBeDefined();
		const assistantObject = toObject(assistant);
		expect(assistantObject).toBeDefined();
		expect(assistantObject ? Reflect.get(assistantObject, "reasoning_text") : undefined).toBe("inspect tool output");
		expect(assistantObject ? Reflect.get(assistantObject, "reasoning_content") : undefined).toBeUndefined();
	});
});

describe("kimi model detection via detectCompat", () => {
	function kimiOpenCodeModel(id: string): Model<"openai-completions"> {
		return {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			id,
			reasoning: true,
		};
	}

	function kimiMoonshotModel(id: string): Model<"openai-completions"> {
		return {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "moonshot",
			baseUrl: "https://api.moonshot.ai/v1",
			id,
			reasoning: true,
		};
	}
	// The z.ai binary `thinking: { type }` field is Kimi's *native* surface
	// (Moonshot / Kimi-code, matched by isMoonshotKimi). Kimi reached through an
	// OpenAI-compatible proxy talks to the proxy's API shape, not Moonshot's
	// backend directly, and those proxies expect the OpenAI-standard
	// `reasoning_effort`. The generic Kimi model-id match MUST NOT default
	// proxies to "zai": doing so regressed #827 (opencode-go strips
	// reasoning_effort under forced tool_choice) and the Fire Pass xhigh capture
	// (#1199), and would mis-shape 14+ gateways (Fireworks, OpenCode, Kilo,
	// NVIDIA, Together, Vercel, …). Hosts that genuinely speak zai pin
	// `compat.thinkingFormat` per catalog entry (e.g. kimi-code, wafer-serverless).
	it("reserves zai for native Kimi hosts and defaults proxies to OpenAI reasoning_effort", () => {
		// Native Moonshot surface → z.ai binary thinking.
		const moonshotK25 = detectCompat(kimiMoonshotModel("kimi-k2.5"));
		expect(moonshotK25.thinkingFormat).toBe("zai");
		expect(moonshotK25.thinkingKeep).toBeUndefined();
		const moonshotK26 = detectCompat(kimiMoonshotModel("kimi-k2.6"));
		expect(moonshotK26.thinkingFormat).toBe("zai");
		expect(moonshotK26.thinkingKeep).toBe("all");

		// OpenAI-compatible proxies → reasoning_effort ("openai").
		const opencodeK26 = detectCompat(kimiOpenCodeModel("kimi-k2.6"));
		expect(opencodeK26.thinkingFormat).toBe("openai");
		expect(opencodeK26.thinkingKeep).toBeUndefined();
		const kiloKimi: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "kilo",
			baseUrl: "https://api.kilo.ai/api/gateway",
			id: "moonshotai/kimi-k2.6",
			reasoning: true,
		};
		expect(detectCompat(kiloKimi).thinkingFormat).toBe("openai");

		// OpenRouter normalizes reasoning via its own object and keeps precedence
		// over the generic Kimi id match.
		const openRouterKimi: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			id: "moonshotai/kimi-k2.6",
			reasoning: true,
		};
		expect(detectCompat(openRouterKimi).thinkingFormat).toBe("openrouter");
	});

	// Regression for #1071: OpenCode-Go/Zen handle reasoning content server-side
	// and reject client-supplied `reasoning_content` ("Extra inputs are not
	// permitted"). Kimi on opencode-* MUST NOT have reasoning_content injected,
	// even though it's still recognized as a Kimi model for other quirks.
	it("does not require reasoning_content for tool calls on kimi-k2.5 (opencode-go)", () => {
		const compat = detectCompat(kimiOpenCodeModel("kimi-k2.5"));
		expect(compat.requiresReasoningContentForToolCalls).toBe(false);
		// Kimi-specific quirks still apply even on opencode hosts.
		expect(compat.requiresAssistantContentForToolCalls).toBe(true);
	});

	it("does not inject reasoning_content placeholder for kimi on opencode-go", () => {
		const model = kimiOpenCodeModel("kimi-k2.5");
		const compat = detectCompat(model);
		const toolCallMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Let me research this." },
				{
					type: "toolCall",
					id: "call_abc123",
					name: "web_search",
					arguments: { query: "beads gastownhall" },
				},
			],
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
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const messages = convertMessages(model, { messages: [toolCallMessage] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(Reflect.get(assistant as object, "reasoning_content")).toBeUndefined();
	});

	it("does not replay streamed reasoning fields for kimi on opencode-go", () => {
		const model = kimiOpenCodeModel("kimi-k2.6");
		const compat = detectCompat(model);
		const toolCallMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "." },
				{
					type: "thinking",
					thinking: "The user wants to install...",
					thinkingSignature: "reasoning",
				},
				{
					type: "toolCall",
					id: "call_abc123",
					name: "bash",
					arguments: { command: "echo ok" },
				},
			],
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
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		expect(compat.requiresReasoningContentForToolCalls).toBe(false);
		const messages = convertMessages(model, { messages: [toolCallMessage] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		const assistantObject = toObject(assistant);
		expect(assistantObject).toBeDefined();
		if (!assistantObject) {
			throw new Error("assistant message missing");
		}
		expect(Reflect.get(assistantObject, "reasoning")).toBeUndefined();
		expect(Reflect.get(assistantObject, "reasoning_content")).toBeUndefined();
		expect(Reflect.get(assistantObject, "reasoning_text")).toBeUndefined();
	});

	// #1484: OpenCode Zen's Kimi gateway now 400s with `thinking is enabled but
	// reasoning_content is missing in assistant tool call message at index N`
	// when a follow-up request has thinking on but the prior assistant tool-call
	// turn lacks `reasoning_content`. `buildParams` must reactivate the
	// `requiresReasoningContentForToolCalls` flag whenever the request itself is
	// in thinking mode, even though static compat detection leaves it off.
	it("emits reasoning_content on kimi opencode-go tool-call replays when thinking is enabled", async () => {
		const model = kimiOpenCodeModel("kimi-k2.6");
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Need to read the file before answering.",
					// OpenCode Kimi streams reasoning under the `reasoning` field
					// name; the override must coerce it into `reasoning_content`
					// when replaying tool-call history.
					thinkingSignature: "reasoning",
				},
				{
					type: "toolCall",
					id: "call_abc123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
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
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(
			model,
			{
				messages: [
					{ role: "user", content: "Summarize the README", timestamp: Date.now() },
					priorAssistant,
					{
						role: "toolResult",
						toolCallId: "call_abc123",
						toolName: "read",
						content: [{ type: "text", text: "# Hello\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test-key",
				fetch: fetchMock,
				reasoning: "high",
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
			},
		);

		const payload = (await promise) as { messages: Array<Record<string, unknown>> };
		const assistant = payload.messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(Reflect.get(assistant as object, "reasoning_content")).toBe("Need to read the file before answering.");
		// The streamed `reasoning` key must NOT land in the wire body alongside
		// `reasoning_content`; opencode's strict schema rejects unknown fields.
		expect(Reflect.get(assistant as object, "reasoning")).toBeUndefined();
	});

	// #1071 regression guard alongside the #1484 fix: with thinking disabled the
	// override stays off so the gateway's `Extra inputs are not permitted` error
	// can never reappear on tool-call replays.
	it("omits reasoning_content on kimi opencode-go tool-call replays when thinking is disabled", async () => {
		const model = kimiOpenCodeModel("kimi-k2.6");
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Let me check." },
				{
					type: "toolCall",
					id: "call_abc123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
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
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(
			model,
			{
				messages: [
					{ role: "user", content: "Summarize the README", timestamp: Date.now() },
					priorAssistant,
					{
						role: "toolResult",
						toolCallId: "call_abc123",
						toolName: "read",
						content: [{ type: "text", text: "# Hello\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test-key",
				fetch: fetchMock,
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
			},
		);

		const payload = (await promise) as { messages: Array<Record<string, unknown>> };
		const assistant = payload.messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(Reflect.get(assistant as object, "reasoning_content")).toBeUndefined();
		expect(Reflect.get(assistant as object, "reasoning")).toBeUndefined();
		expect(Reflect.get(assistant as object, "reasoning_text")).toBeUndefined();
	});

	// #1485 review: `disableReasoningOnForcedToolChoice` strips thinking from
	// the wire body for Kimi when `toolChoice` is forced, so the per-request
	// reasoning_content override must back off on the same path or the
	// thinking-disabled payload reintroduces the #1071 `Extra inputs are not
	// permitted` failure.
	it("omits reasoning_content on kimi opencode-go forced-tool turns even when reasoning is requested", async () => {
		const model = kimiOpenCodeModel("kimi-k2.6");
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Plan first, then call the tool.",
					thinkingSignature: "reasoning_content",
				},
				{
					type: "toolCall",
					id: "call_abc123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
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
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(
			model,
			{
				messages: [
					{ role: "user", content: "Summarize the README", timestamp: Date.now() },
					priorAssistant,
					{
						role: "toolResult",
						toolCallId: "call_abc123",
						toolName: "read",
						content: [{ type: "text", text: "# Hello\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test-key",
				fetch: fetchMock,
				reasoning: "high",
				// Forced tool choice triggers `disableReasoningOnForcedToolChoice`
				// for Kimi, suppressing reasoning_effort on the wire body.
				toolChoice: { type: "tool", name: "read" },
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
			},
		);

		const payload = (await promise) as {
			messages: Array<Record<string, unknown>>;
			reasoning_effort?: unknown;
		};
		const assistant = payload.messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(Reflect.get(assistant as object, "reasoning_content")).toBeUndefined();
		expect(Reflect.get(assistant as object, "reasoning")).toBeUndefined();
		expect(Reflect.get(assistant as object, "reasoning_text")).toBeUndefined();
		// The forced-tool guard must still strip the request-level thinking
		// signal so neither end of the wire mentions reasoning.
		expect(payload.reasoning_effort).toBeUndefined();
	});

	// #1484 follow-up: DeepSeek V4 on opencode-go exhibits the same gateway
	// invariant as Kimi (same Zen gateway). DeepSeek emits reasoning under the
	// `reasoning` signature, so the pre-fix code wrote both `reasoning` and
	// `reasoning_content` to the wire body. The line-1488 fix in convertMessages
	// now coerces the replay onto `reasoningContentField` whenever
	// `allowsSyntheticReasoningContentForToolCalls=false`, so DeepSeek V4
	// payloads carry only `reasoning_content`.
	it("emits only reasoning_content on deepseek-v4-flash opencode-go tool-call replays", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			id: "deepseek-v4-flash",
			reasoning: true,
		};
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Need to read the file before answering.",
					thinkingSignature: "reasoning",
				},
				{
					type: "toolCall",
					id: "call_abc123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
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
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(
			model,
			{
				messages: [
					{ role: "user", content: "Summarize the README", timestamp: Date.now() },
					priorAssistant,
					{
						role: "toolResult",
						toolCallId: "call_abc123",
						toolName: "read",
						content: [{ type: "text", text: "# Hello\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test-key",
				fetch: fetchMock,
				reasoning: "high",
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
			},
		);

		const payload = (await promise) as { messages: Array<Record<string, unknown>> };
		const assistant = payload.messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(Reflect.get(assistant as object, "reasoning_content")).toBe("Need to read the file before answering.");
		// DeepSeek's allowsSynthetic=false must keep the stale `reasoning` key
		// off the wire body so opencode's schema validation does not flag it.
		expect(Reflect.get(assistant as object, "reasoning")).toBeUndefined();
	});

	// #1484 follow-up: the Zen gateway invariant applies to every opencode-go
	// model (GLM, Qwen, MiMo, MiniMax, Kimi, DeepSeek). Verify a non-Kimi
	// non-DeepSeek opencode model also replays reasoning_content when thinking
	// is enabled, and stays silent when thinking is disabled.
	it.each([
		{ id: "glm-5.1", reasoning: "high" as const, expectReplay: true },
		{ id: "glm-5.1", reasoning: undefined, expectReplay: false },
		{ id: "qwen3.7-max", reasoning: "high" as const, expectReplay: true },
		{ id: "mimo-v2-pro", reasoning: "high" as const, expectReplay: true },
	])("opencode-go/%s reasoning=%s → replay=%s", async ({ id, reasoning, expectReplay }) => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			id,
			reasoning: true,
		};
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Plan before acting.",
					thinkingSignature: "reasoning",
				},
				{
					type: "toolCall",
					id: "call_abc123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
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
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(
			model,
			{
				messages: [
					{ role: "user", content: "Summarize the README", timestamp: Date.now() },
					priorAssistant,
					{
						role: "toolResult",
						toolCallId: "call_abc123",
						toolName: "read",
						content: [{ type: "text", text: "# Hello\n" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "test-key",
				fetch: fetchMock,
				reasoning,
				signal: createAbortedSignal(),
				onPayload: payload => resolve(payload),
			},
		);

		const payload = (await promise) as { messages: Array<Record<string, unknown>> };
		const assistant = payload.messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		if (expectReplay) {
			expect(Reflect.get(assistant as object, "reasoning_content")).toBe("Plan before acting.");
			// The stale streamed `reasoning` key must never land in the wire body.
			expect(Reflect.get(assistant as object, "reasoning")).toBeUndefined();
		} else {
			expect(Reflect.get(assistant as object, "reasoning_content")).toBeUndefined();
			expect(Reflect.get(assistant as object, "reasoning")).toBeUndefined();
			expect(Reflect.get(assistant as object, "reasoning_text")).toBeUndefined();
		}
	});

	it("injects reasoning_content placeholder when kimi-on-moonshot has tool calls without reasoning field", () => {
		const model = kimiMoonshotModel("kimi-k2.5");
		const compat = detectCompat(model);
		const toolCallMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Let me research this." },
				{
					type: "toolCall",
					id: "call_abc123",
					name: "web_search",
					arguments: { query: "beads gastownhall" },
				},
			],
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
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const messages = convertMessages(model, { messages: [toolCallMessage] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		const reasoningContent = Reflect.get(assistant as object, "reasoning_content");
		expect(reasoningContent).toBeDefined();
		expect(typeof reasoningContent).toBe("string");
		expect((reasoningContent as string).length).toBeGreaterThan(0);
	});

	it("injects reasoning_content placeholder for direct Moonshot Kimi after thinking-disabled forced tool calls", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "moonshot",
			baseUrl: "https://api.moonshot.ai/v1",
			id: "kimi-k2.6",
			reasoning: false,
		};
		const compat = detectCompat(model);
		const toolCallMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_abc123",
					name: "resolve",
					arguments: { action: "apply", reason: "approved" },
				},
			],
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
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
		const messages = convertMessages(model, { messages: [toolCallMessage] }, compat);
		const assistant = messages.find(m => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(Reflect.get(assistant as object, "reasoning_content")).toBe(".");
	});

	it("does not inject reasoning_content when model is not kimi", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			id: "some-other-model",
		};
		const compat = detectCompat(model);
		expect(compat.requiresReasoningContentForToolCalls).toBe(false);
		expect(compat.requiresAssistantContentForToolCalls).toBe(false);
	});

	// `requiresAssistantContentForToolCalls` keys directly off isKimiModel and
	// is provider-agnostic, so it's the cleanest signal that the id-pattern
	// match recognizes every Kimi variant.
	it.each(["kimi-k2.5", "kimi-k1.5", "kimi-k2-5"])("matches kimi model id: %s", id => {
		const compat = detectCompat(kimiMoonshotModel(id));
		expect(compat.requiresAssistantContentForToolCalls).toBe(true);
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
	});

	it("still matches moonshotai/kimi via openrouter", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			id: "moonshotai/kimi-k2-5",
			reasoning: true,
		};
		const compat = detectCompat(model);
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
	});
});

describe("NVIDIA NIM DeepSeek special-token stripping", () => {
	function nvidiaDeepseekModel(): Model<"openai-completions"> {
		return {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "nvidia",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			id: "deepseek-ai/deepseek-v4-flash",
			reasoning: true,
		};
	}

	it("strips leaked <\uff5cDSML\uff5c...\uff5c> markers from visible content", async () => {
		const model = nvidiaDeepseekModel();
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-nim-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: { content: "Sure thing.<\uff5cDSML\uff5ctool_calls\uff5c>I'll help." },
					},
				],
			},
			{
				id: "chatcmpl-nim-1",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("Sure thing.I'll help.");
		expect(text).not.toContain("DSML");
		expect(text).not.toContain("\uff5c");
	});

	it("holds back partial token split across chunks", async () => {
		const model = nvidiaDeepseekModel();
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-nim-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "Hello <\uff5ctool_calls" } }],
			},
			{
				id: "chatcmpl-nim-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "_begin\uff5c>world" } }],
			},
			{
				id: "chatcmpl-nim-2",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("Hello world");
	});

	it("flushes a dangling partial open delimiter at end of stream", async () => {
		const model = nvidiaDeepseekModel();
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-nim-3",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "trailing <\uff5c" } }],
			},
			{
				id: "chatcmpl-nim-3",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		// At end-of-stream we have no way to know whether the partial is a real token,
		// so we emit it verbatim rather than swallow legitimate text forever.
		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("trailing <\uff5c");
	});

	it("leaves visible content alone for non-deepseek nvidia models", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "nvidia",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			id: "meta/llama-3.3-70b-instruct",
		};
		const fetchMock = createMockFetch([
			{
				id: "chatcmpl-nim-4",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: { content: "keep <\uff5cas-is\uff5c> please" } }],
			},
			{
				id: "chatcmpl-nim-4",
				object: "chat.completion.chunk",
				created: 0,
				model: model.id,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();
		const text = result.content
			.filter(b => b.type === "text")
			.map(b => (b as { text: string }).text)
			.join("");
		expect(text).toBe("keep <\uff5cas-is\uff5c> please");
	});
});

describe("applyOpenRouterRoutingVariant", () => {
	it("returns the id untouched when variant is missing", () => {
		expect(applyOpenRouterRoutingVariant("anthropic/claude-haiku-latest", undefined)).toBe(
			"anthropic/claude-haiku-latest",
		);
		expect(applyOpenRouterRoutingVariant("anthropic/claude-haiku-latest", "")).toBe("anthropic/claude-haiku-latest");
	});

	it("appends the variant suffix when the id has no colon after the last slash", () => {
		expect(applyOpenRouterRoutingVariant("anthropic/claude-haiku-latest", "nitro")).toBe(
			"anthropic/claude-haiku-latest:nitro",
		);
		expect(applyOpenRouterRoutingVariant("openai/gpt-4o-mini", "floor")).toBe("openai/gpt-4o-mini:floor");
	});

	it("preserves an explicit variant already present in the id", () => {
		// User-typed override
		expect(applyOpenRouterRoutingVariant("anthropic/claude-haiku-latest:nitro", "exacto")).toBe(
			"anthropic/claude-haiku-latest:nitro",
		);
		// Catalog entry with a baked-in variant
		expect(applyOpenRouterRoutingVariant("deepseek/deepseek-v3.1-terminus:exacto", "nitro")).toBe(
			"deepseek/deepseek-v3.1-terminus:exacto",
		);
	});

	it("appends the variant when the id has no slash separator", () => {
		expect(applyOpenRouterRoutingVariant("opaque-id", "nitro")).toBe("opaque-id:nitro");
	});
});

describe("anthropic cache control for OpenAI-compatible chat completions", () => {
	function claudeProxyModel(compat?: OpenAICompat): Model<"openai-completions"> {
		return {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
			provider: "litellm",
			baseUrl: "https://litellm.example/v1",
			id: "claude-opus-4-8",
			compat,
		};
	}

	function cacheContext(): Context {
		return { messages: [{ role: "user", content: "cache me", timestamp: 0 }] };
	}

	it("injects Anthropic cache_control when compat requests Anthropic cache markers", async () => {
		const payload = await captureOpenAICompletionsPayload(
			claudeProxyModel({ cacheControlFormat: "anthropic" }),
			cacheContext(),
		);
		const content = getLastPayloadContent(payload);
		const textPart = getLastTextPart(content);

		expect(Reflect.get(textPart ?? {}, "text")).toBe("cache me");
		expect(Reflect.get(textPart ?? {}, "cache_control")).toEqual({ type: "ephemeral" });
	});

	it("preserves OpenRouter Anthropic cache_control detection", async () => {
		const model = getBundledModel("openrouter", "anthropic/claude-sonnet-4") as Model<"openai-completions">;
		const payload = await captureOpenAICompletionsPayload(model, cacheContext());
		const content = getLastPayloadContent(payload);
		const textPart = getLastTextPart(content);

		expect(Reflect.get(textPart ?? {}, "cache_control")).toEqual({ type: "ephemeral" });
	});

	it("does not attach Anthropic cache_control to empty assistant tool-call content", async () => {
		const model = getBundledModel("openrouter", "anthropic/claude-sonnet-4") as Model<"openai-completions">;
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_read",
					name: "read",
					arguments: { path: "screenshot.png" },
				},
			],
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
			stopReason: "toolUse",
			timestamp: 1,
		};
		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_read",
			toolName: "read",
			content: [{ type: "text", text: "Read image file [image/webp]" }],
			isError: false,
			timestamp: 2,
		};
		const payload = await captureOpenAICompletionsPayload(model, {
			messages: [{ role: "user", content: "cache me", timestamp: 0 }, assistantMessage, toolResultMessage],
		});
		const messages = getPayloadMessages(payload);
		const assistant = messages.find(message => {
			const toolCalls = Reflect.get(message, "tool_calls");
			return Reflect.get(message, "role") === "assistant" && Array.isArray(toolCalls);
		});
		const firstUser = messages.find(message => Reflect.get(message, "role") === "user");
		const userContent = firstUser ? Reflect.get(firstUser, "content") : undefined;
		const textPart = getLastTextPart(userContent);

		expect(assistant ? Reflect.get(assistant, "content") : undefined).toBe("");
		expect(Reflect.get(textPart ?? {}, "text")).toBe("cache me");
		expect(Reflect.get(textPart ?? {}, "cache_control")).toEqual({ type: "ephemeral" });
	});

	it("does not infer Anthropic cache_control for custom Claude ids without compat", async () => {
		const payload = await captureOpenAICompletionsPayload(claudeProxyModel(), cacheContext());

		expect(getLastPayloadContent(payload)).toBe("cache me");
	});
});
describe("openrouterVariant request integration", () => {
	it("appends the configured variant suffix to params.model for OpenRouter requests", async () => {
		const model = getBundledModel("openrouter", "anthropic/claude-sonnet-4") as Model<"openai-completions">;
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			signal: createAbortedSignal(),
			openrouterVariant: "nitro",
			onPayload: payload => resolve(payload),
		});
		const payload = await promise;
		expect((payload as { model?: string }).model).toBe(`${model.id}:nitro`);
	});

	it("does not override an explicit variant in the model id", async () => {
		const base = getBundledModel("openrouter", "anthropic/claude-sonnet-4") as Model<"openai-completions">;
		const model: Model<"openai-completions"> = {
			...base,
			id: `${base.id}:online`,
		};
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			signal: createAbortedSignal(),
			openrouterVariant: "nitro",
			onPayload: payload => resolve(payload),
		});
		const payload = await promise;
		expect((payload as { model?: string }).model).toBe(model.id);
	});

	it("leaves params.model unchanged for non-OpenRouter providers", async () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchMock = createMockFetch(["[DONE]"]);
		streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			signal: createAbortedSignal(),
			openrouterVariant: "nitro",
			onPayload: payload => resolve(payload),
		});
		const payload = await promise;
		expect((payload as { model?: string }).model).toBe(model.id);
	});
});
