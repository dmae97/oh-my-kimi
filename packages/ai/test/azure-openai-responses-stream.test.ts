import { afterEach, describe, expect, it, vi } from "bun:test";
import { type AzureOpenAIResponsesOptions, streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses";
import type { Context, Model } from "../src/types";

const originalFetch = global.fetch;

const azureModel: Model<"azure-openai-responses"> = {
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function createSseResponse(events: unknown[]): Response {
	const sse = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(sse));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createAssistantMessage(text: string, textSignature?: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text, ...(textSignature ? { textSignature } : {}) }],
		api: "azure-openai-responses" as const,
		provider: "azure" as const,
		model: "gpt-5-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

async function captureAzurePayload(
	context: Context,
	model: Model<"azure-openai-responses"> = azureModel,
	options: Partial<AzureOpenAIResponsesOptions> = {},
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamAzureOpenAIResponses(model, context, {
		apiKey: "test-key",
		azureBaseUrl: model.baseUrl,
		azureApiVersion: "v1",
		...options,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("azure openai responses streaming", () => {
	it("serializes each system prompt as an Azure Responses system input item for non-reasoning models", async () => {
		const payload = await captureAzurePayload({
			systemPrompt: ["First instruction", "", "Second instruction"],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		expect(payload.input).toEqual([
			{ role: "system", content: "First instruction" },
			{ role: "system", content: "Second instruction" },
			{ role: "user", content: [{ type: "input_text", text: "Say hello" }] },
		]);
	});

	it("uses developer role for Azure Responses reasoning model system prompts", async () => {
		const reasoningModel: Model<"azure-openai-responses"> = {
			...azureModel,
			reasoning: true,
		};
		const payload = await captureAzurePayload(
			{
				systemPrompt: ["Reasoning instruction", "Second instruction"],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			reasoningModel,
		);

		expect(payload.input).toEqual([
			{ role: "developer", content: "Reasoning instruction" },
			{ role: "developer", content: "Second instruction" },
			{ role: "user", content: [{ type: "input_text", text: "Say hello" }] },
			{
				role: "developer",
				content: [{ type: "input_text", text: "# Juice: 0 !important" }],
			},
		]);
	});

	it("keeps Azure Responses prompt_cache_key separate from Anthropic cache controls", async () => {
		const payload = await captureAzurePayload(
			{
				systemPrompt: ["Cache-stable instruction"],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			azureModel,
			{ sessionId: "azure-session" },
		);

		expect(payload.prompt_cache_key).toBe("azure-session");
		expect(payload.prompt_cache_retention).toBeUndefined();
		expect(payload.cache_control).toBeUndefined();
	});

	it("surfaces nested response.failed provider errors", async () => {
		global.fetch = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.failed",
					response: {
						error: { code: "server_error", message: "backend exploded" },
					},
				},
			]),
		) as unknown as typeof fetch;

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("server_error: backend exploded");
	});

	it("surfaces response.failed incomplete reasons", async () => {
		global.fetch = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.failed",
					response: {
						incomplete_details: { reason: "max_output_tokens" },
					},
				},
			]),
		) as unknown as typeof fetch;

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("incomplete: max_output_tokens");
	});

	it("surfaces response.completed failed status_details errors", async () => {
		global.fetch = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.completed",
					response: {
						status: "failed",
						status_details: {
							error: { code: "server_error", message: "backend exploded late" },
						},
					},
				},
			]),
		) as unknown as typeof fetch;

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("server_error: backend exploded late");
	});
	it("preserves assistant message phase when rebuilding fallback replay history", async () => {
		const payload = await captureAzurePayload({
			messages: [
				{ role: "user", content: "first user", timestamp: Date.now() },
				createAssistantMessage(
					"Commentary answer",
					JSON.stringify({ v: 1, id: "msg_commentary", phase: "final_answer" }),
				),
				{ role: "user", content: "follow-up", timestamp: Date.now() },
			],
		});

		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "first user" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Commentary answer", annotations: [] }],
				status: "completed",
				id: "msg_commentary",
				phase: "final_answer",
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});

	it("keeps legacy plain-string text signatures when rebuilding fallback replay history", async () => {
		const payload = await captureAzurePayload({
			messages: [
				{ role: "user", content: "first user", timestamp: Date.now() },
				createAssistantMessage("Legacy answer", "msg_legacy"),
				{ role: "user", content: "follow-up", timestamp: Date.now() },
			],
		});

		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "first user" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Legacy answer", annotations: [] }],
				status: "completed",
				id: "msg_legacy",
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});
});
