import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { logger } from "@oh-my-pi/pi-utils";

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
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
	it("returns the title from a forced set_title tool call", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [
				{
					type: "toolCall",
					id: "call-title",
					name: "set_title",
					arguments: { title: "Structured Title" },
				},
			],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Structured Title");
		expect(completeSimpleMock.mock.calls[0]?.[1]).toMatchObject({
			tools: [expect.objectContaining({ name: "set_title" })],
		});
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			disableReasoning: true,
			toolChoice: { type: "tool", name: "set_title" },
		});
	});

	it("uses the bundled default prompt when no title prompt file is resolved", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "toolCall", id: "call-title", name: "set_title", arguments: { title: "Default Prompt" } }],
		} as never);

		await generateSessionTitle("Investigate the resolver", createRegistry(model), createSettings(model));

		const request = completeSimpleMock.mock.calls[0]?.[1] as { systemPrompt?: string[] } | undefined;
		expect(request?.systemPrompt).toHaveLength(1);
		expect(request?.systemPrompt?.[0]).toContain("set_title");
	});

	it("uses the resolved TITLE_SYSTEM.md prompt for online title generation", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const customPrompt = "Generate lowercase colon-delimited session names.";
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "toolCall", id: "call-title", name: "set_title", arguments: { title: "fix:resolver" } }],
		} as never);

		await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
			undefined,
			undefined,
			undefined,
			customPrompt,
		);

		const request = completeSimpleMock.mock.calls[0]?.[1] as
			| { systemPrompt?: string[]; tools?: Array<{ name?: string }> }
			| undefined;
		const options = completeSimpleMock.mock.calls[0]?.[2] as
			| { toolChoice?: { type?: string; name?: string } }
			| undefined;
		expect(request?.systemPrompt).toEqual([customPrompt]);
		expect(request?.tools?.[0]?.name).toBe("set_title");
		expect(options?.toolChoice).toEqual({ type: "tool", name: "set_title" });
	});

	it("falls back to text content when no set_title tool call is returned", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Text Title" }],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Text Title");
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
			content: [
				{
					type: "toolCall",
					id: "call-title",
					name: "set_title",
					arguments: { title: "none" },
				},
			],
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
			content: [
				{
					type: "toolCall",
					id: "call-title",
					name: "set_title",
					arguments: { title: "Budget Title" },
				},
			],
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
			content: [{ type: "toolCall", id: "call-title", name: "set_title", arguments: { title: "Setup Screen" } }],
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
});
