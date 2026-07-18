import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { logger } from "@oh-my-pi/pi-utils";

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function getModelFor(provider: GeneratedProvider, id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected model ${provider}/${id}`);
	return model;
}

function createSettings(model: Model<Api>, tinyModel = "online") {
	return {
		get(path: string) {
			if (path === "providers.tinyModel") return tinyModel;
			return undefined;
		},
		getModelRole(role: string) {
			return role === "smol" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
		getApiKeyForProvider: async () => "test-key",
		authStorage: { rotateSessionCredential: async () => false },
		resolver: () => async () => "test-key",
	} as never;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("title generator", () => {
	it("returns the marker-wrapped title without forcing a tool call", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Structured Title</title>" }],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Structured Title");
		const request = completeSimpleMock.mock.calls[0]?.[1] as { tools?: unknown } | undefined;
		const options = completeSimpleMock.mock.calls[0]?.[2] as
			| { toolChoice?: unknown; disableReasoning?: boolean }
			| undefined;
		expect(request?.tools).toBeUndefined();
		expect(options?.toolChoice).toBeUndefined();
		expect(options?.disableReasoning).toBe(true);
	});

	it.each([
		[
			"<thinking>",
			"<thinking>Thinking process:\n<title>Wrong internal scratchpad</title>\n</thinking>\n<title>Fix login button</title>",
		],
		[
			"<think>",
			"<think>Thinking process:\n<title>Wrong internal scratchpad</title>\n</think>\n<title>Fix login button</title>",
		],
		[
			"<reasoning>",
			"<reasoning>Thinking process:\n<title>Wrong internal scratchpad</title>\n</reasoning>\n<title>Fix login button</title>",
		],
		[
			"```reasoning",
			"```reasoning\nThinking process:\n<title>Wrong internal scratchpad</title>\n```\n<title>Fix login button</title>",
		],
	] as const)("ignores leaked %s reasoning markup before the visible title", async (_marker, responseText) => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: responseText }],
		} as never);

		const title = await generateSessionTitle(
			"the login button is broken on mobile",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Fix login button");
	});

	it("preserves in-band reasoning syntax inside the parsed title", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Fix <think> tag parsing</title>" }],
		} as never);

		const title = await generateSessionTitle(
			"fix title generation for <think> tag parsing",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Fix <think> tag parsing");
	});

	it("uses the bundled default prompt when no title prompt file is resolved", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Default Prompt</title>" }],
		} as never);

		await generateSessionTitle("Investigate the resolver", createRegistry(model), createSettings(model));

		const request = completeSimpleMock.mock.calls[0]?.[1] as { systemPrompt?: string[] } | undefined;
		expect(request?.systemPrompt).toHaveLength(1);
		expect(request?.systemPrompt?.[0]).toContain("<title>");
	});

	it("appends the marker instruction after a resolved TITLE_SYSTEM.md prompt", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const customPrompt = "Generate lowercase colon-delimited session names.";
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>fix:resolver</title>" }],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
			undefined,
			undefined,
			undefined,
			customPrompt,
		);

		expect(title).toBe("fix:resolver");
		const request = completeSimpleMock.mock.calls[0]?.[1] as { systemPrompt?: string[] } | undefined;
		expect(request?.systemPrompt).toHaveLength(2);
		expect(request?.systemPrompt?.[0]).toBe(customPrompt);
		expect(request?.systemPrompt?.[1]).toContain("<title>");
	});

	it('unwraps a JSON {"title": ...} response into the bare title', async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: '{"title": "Optimize CNPG kernel reports"}' }],
		} as never);

		const title = await generateSessionTitle(
			"optimize the CNPG kernel report pipeline",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Optimize CNPG kernel reports");
	});

	it("unwraps a code-fenced JSON title response", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: '```json\n{"title": "Fix login button on mobile"}\n```' }],
		} as never);

		const title = await generateSessionTitle(
			"the login button is broken on mobile",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Fix login button on mobile");
	});

	it("unwraps a JSON title wrapped in <title> markers", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: '<title>{"title": "Add OAuth authentication"}</title>' }],
		} as never);

		const title = await generateSessionTitle(
			"add OAuth authentication to the API",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Add OAuth authentication");
	});

	it("salvages the title from truncated JSON output", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: '{"title": "Debug failing CI tests"' }],
		} as never);

		const title = await generateSessionTitle(
			"the CI tests keep failing",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Debug failing CI tests");
	});

	it("defers titling for a greeting without invoking the model", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");

		const title = await generateSessionTitle("hi", createRegistry(model), createSettings(model));

		expect(title).toBeNull();
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("returns null when the model rejects a non-greeting taskless message with the none sentinel", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>none</title>" }],
		} as never);

		const title = await generateSessionTitle(
			"I have a quick question for you",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBeNull();
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("returns null for a self-closing <title/> marker", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title/>" }],
		} as never);

		const title = await generateSessionTitle(
			"I have a quick question for you",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBeNull();
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("returns null for a bare <title> marker", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>" }],
		} as never);

		const title = await generateSessionTitle(
			"I have a quick question for you",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBeNull();
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("logs and returns null when title credentials are missing", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const title = await generateSessionTitle(
			"Investigate the resolver",
			{
				getAvailable: () => [model],
				getApiKey: async () => undefined,
			} as never,
			createSettings(model),
			"session-1",
		);

		expect(title).toBeNull();
		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledWith(
			"title-generator: no API key",
			expect.objectContaining({
				sessionId: "session-1",
				provider: model.provider,
				id: model.id,
				reason: "missing-api-key",
			}),
		);
	});

	it("logs and returns null when title credential lookup throws", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const title = await generateSessionTitle(
			"Investigate the resolver",
			{
				getAvailable: () => [model],
				getApiKey: async () => {
					throw new Error("credential lookup failed");
				},
			} as never,
			createSettings(model),
			"session-2",
		);

		expect(title).toBeNull();
		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledWith(
			"title-generator: error",
			expect.objectContaining({
				sessionId: "session-2",
				provider: model.provider,
				id: model.id,
				reason: "exception",
				error: "credential lookup failed",
			}),
		);
	});

	it("uses a reasoning-safe output budget for reasoning models", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Budget Title</title>" }],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);
		const maxTokens = (completeSimpleMock.mock.calls[0]?.[2] as { maxTokens?: number } | undefined)?.maxTokens;

		expect(title).toBe("Budget Title");
		expect(maxTokens).toBeGreaterThanOrEqual(1024);
	});

	// Regression for #4355: a model catalogued with `reasoning: false` that
	// still emits thinking (e.g. Qwen3 via llama.cpp) must get the same
	// reasoning-safe budget, otherwise the `<title>` output is truncated
	// before it can be emitted.
	it("uses a reasoning-safe output budget even when the model declares reasoning: false", async () => {
		const baseModel = getModelOrThrow("claude-sonnet-4-5");
		const model = { ...baseModel, reasoning: false } as Model<Api>;
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Budget Title</title>" }],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);
		const maxTokens = (completeSimpleMock.mock.calls[0]?.[2] as { maxTokens?: number } | undefined)?.maxTokens;

		expect(title).toBe("Budget Title");
		expect(maxTokens).toBeGreaterThanOrEqual(1024);
	});

	it("strips code blocks from the message sent to the model", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Setup Screen</title>" }],
		} as never);

		await generateSessionTitle(
			"plan a setup screen\n```\nWelcome to Claude Code v2.1.158\n```\npick provider then theme",
			createRegistry(model),
			createSettings(model),
		);

		const sentMessages = (completeSimpleMock.mock.calls[0]?.[1] as { messages?: Array<{ content?: string }> })
			?.messages;
		const userContent = sentMessages?.[0]?.content ?? "";
		expect(userContent).not.toContain("Claude Code v2.1.158");
		expect(userContent).toContain("pick provider then theme");
	});

	it("accepts a plain sentence when the model omits the <title> markers", async () => {
		const model = getModelFor("deepseek", "deepseek-v4-pro");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Fix login button on mobile" }],
		} as never);

		const title = await generateSessionTitle(
			"the login button is broken on mobile",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Fix login button on mobile");
	});

	it.each(["Here's a thinking process:", "Thinking process:", "Reasoning process:"])(
		"rejects a markerless prose thinking preamble: %s",
		async responseText => {
			const model = getModelFor("deepseek", "deepseek-v4-pro");
			vi.spyOn(ai, "completeSimple").mockResolvedValue({
				stopReason: "stop",
				content: [{ type: "text", text: responseText }],
			} as never);

			const title = await generateSessionTitle(
				"the login button is broken on mobile",
				createRegistry(model),
				createSettings(model),
			);

			expect(title).toBeNull();
		},
	);

	it("preserves a markerless title that mentions a <think> tag", async () => {
		const model = getModelFor("deepseek", "deepseek-v4-pro");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Fix <think> tag parsing" }],
		} as never);

		const title = await generateSessionTitle(
			"fix title generation for <think> tag parsing",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Fix <think> tag parsing");
	});

	it("preserves a markerless title that mentions a ```thinking fence", async () => {
		const model = getModelFor("deepseek", "deepseek-v4-pro");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Fix ```thinking fence parsing" }],
		} as never);

		const title = await generateSessionTitle(
			"fix title generation for a ```thinking fence",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toContain("```thinking");
		expect(title).toContain("fence");
	});

	it("strips an unclosed <title> tag from a truncated response", async () => {
		const model = getModelFor("deepseek", "deepseek-v4-pro");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Refactor API client error handling" }],
		} as never);

		const title = await generateSessionTitle(
			"refactor the error handling in the api client",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Refactor API client error handling");
	});

	it("resolves the model roles in precedence order: tiny -> commit -> smol", async () => {
		const tinyModel = getModelOrThrow("claude-haiku-4-5");
		const commitModel = getModelOrThrow("claude-sonnet-4-5");
		const smolModel = getModelOrThrow("claude-opus-4-8");

		const mockComplete = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Test Title</title>" }],
		} as never);

		// Case 1: All three roles configured. 'tiny' should be used.
		let currentSettings = {
			get(path: string) {
				if (path === "providers.tinyModel") return "online";
				return undefined;
			},
			getModelRole(role: string) {
				if (role === "tiny") return `${tinyModel.provider}/${tinyModel.id}`;
				if (role === "commit") return `${commitModel.provider}/${commitModel.id}`;
				if (role === "smol") return `${smolModel.provider}/${smolModel.id}`;
				return undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;

		const registry = {
			getAvailable: () => [tinyModel, commitModel, smolModel],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false },
			resolver: () => async () => "test-key",
		} as never;

		await generateSessionTitle("Some message", registry, currentSettings);
		expect(mockComplete).toHaveBeenCalled();
		expect(mockComplete.mock.calls[0]?.[0]).toBe(tinyModel);

		mockComplete.mockClear();

		// Case 2: 'tiny' role not configured, 'commit' and 'smol' configured. 'commit' should be used.
		currentSettings = {
			get(path: string) {
				if (path === "providers.tinyModel") return "online";
				return undefined;
			},
			getModelRole(role: string) {
				if (role === "commit") return `${commitModel.provider}/${commitModel.id}`;
				if (role === "smol") return `${smolModel.provider}/${smolModel.id}`;
				return undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;

		await generateSessionTitle("Some message", registry, currentSettings);
		expect(mockComplete).toHaveBeenCalled();
		expect(mockComplete.mock.calls[0]?.[0]).toBe(commitModel);

		mockComplete.mockClear();

		// Case 3: Only 'smol' role configured. 'smol' should be used.
		currentSettings = {
			get(path: string) {
				if (path === "providers.tinyModel") return "online";
				return undefined;
			},
			getModelRole(role: string) {
				if (role === "smol") return `${smolModel.provider}/${smolModel.id}`;
				return undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;

		await generateSessionTitle("Some message", registry, currentSettings);
		expect(mockComplete).toHaveBeenCalled();
		expect(mockComplete.mock.calls[0]?.[0]).toBe(smolModel);
	});
});
