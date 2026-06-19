import { describe, expect, it } from "bun:test";
import { streamAzureOpenAIResponses } from "@oh-my-pi/pi-ai/providers/azure-openai-responses";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function createChatSseResponse(): Response {
	const chunks = [
		{
			id: "chatcmpl-reasoning-fallback",
			object: "chat.completion.chunk",
			created: 0,
			model: "fallback-reasoner",
			choices: [{ index: 0, delta: { content: "ok" } }],
		},
		{
			id: "chatcmpl-reasoning-fallback",
			object: "chat.completion.chunk",
			created: 0,
			model: "fallback-reasoner",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
		"[DONE]",
	];
	return new Response(
		`${chunks.map(chunk => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`).join("\n\n")}\n\n`,
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);
}

function createResponsesSseResponse(id = "resp_reasoning_fallback"): Response {
	const events = [
		{
			type: "response.completed",
			response: {
				id,
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function invalidReasoningResponse(param: "reasoning_effort" | "reasoning.effort", value: string): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: `invalid reasoning value: '${value}' (must be "high", "medium", "low", "max", or "none")`,
				type: "invalid_request_error",
				param,
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}
function pipeDelimitedReasoningEffortResponse(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: 'reasoning.effort: Invalid option: expected one of "xhigh"|"high"|"medium"|"low"|"minimal"|"none"',
				type: "invalid_request_error",
				param: "reasoning.effort",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

function summaryReasoningErrorResponse(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: "invalid reasoning.summary value: 'verbose'",
				type: "invalid_request_error",
				param: "reasoning.summary",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

function parseJsonBody(init: RequestInit | undefined): Record<string, unknown> {
	return JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
}

function createCompletionsModel(): Model<"openai-completions"> {
	return buildModel({
		id: "fallback-reasoner",
		name: "Fallback Reasoner",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://proxy.example.test/v1",
		reasoning: true,
		compat: {
			thinkingFormat: "openai",
			supportsReasoningParams: true,
			supportsReasoningEffort: true,
		},
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function createResponsesModel(): Model<"openai-responses"> {
	return buildModel({
		id: "fallback-responses-reasoner",
		name: "Fallback Responses Reasoner",
		api: "openai-responses",
		provider: "custom-responses",
		baseUrl: "https://responses.example.test/v1",
		reasoning: true,
		compat: {
			supportsReasoningParams: true,
			supportsReasoningEffort: true,
		},
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}
function createMappedResponsesModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mapped-responses-reasoner",
		name: "Mapped Responses Reasoner",
		api: "openai-responses",
		provider: "custom-responses",
		baseUrl: "https://responses.example.test/v1",
		reasoning: true,
		compat: {
			supportsReasoningParams: true,
			supportsReasoningEffort: true,
		},
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			effortMap: { [Effort.XHigh]: "max" },
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function createAzureResponsesModel(): Model<"azure-openai-responses"> {
	return buildModel({
		id: "gpt-5.2-test",
		name: "GPT 5.2 Test",
		api: "azure-openai-responses",
		provider: "azure",
		baseUrl: "https://azure.example.test/openai/v1",
		reasoning: true,
		compat: {
			supportsReasoningParams: true,
			supportsReasoningEffort: true,
		},
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

describe("OpenAI reasoning effort fallback retry", () => {
	it("retries Chat Completions xhigh as provider max", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return bodies.length === 1
					? invalidReasoningResponse("reasoning_effort", "xhigh")
					: createChatSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAICompletions(createCompletionsModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "xhigh",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies.map(body => body.reasoning_effort)).toEqual(["xhigh", "max"]);
	});

	it("retries Responses xhigh as provider max and stores the successful fallback params", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return bodies.length === 1
					? invalidReasoningResponse("reasoning.effort", "xhigh")
					: createResponsesSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);
		const providerSessionState = new Map<string, ProviderSessionState>();

		const result = await streamOpenAIResponses(createResponsesModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "xhigh",
			statefulResponses: true,
			sessionId: "reasoning-fallback-session",
			providerSessionState,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies.map(body => (body.reasoning as { effort?: string } | undefined)?.effort)).toEqual(["xhigh", "max"]);
		const state = [...providerSessionState.values()][0] as unknown as {
			chains: Map<string, { lastParams?: { reasoning?: { effort?: string } } }>;
		};
		const chain = [...state.chains.values()][0]!;
		expect(chain.lastParams?.reasoning?.effort).toBe("max");
	});

	it("retries pipe-delimited reasoning.effort errors with the nearest supported tier", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return bodies.length === 1 ? pipeDelimitedReasoningEffortResponse() : createResponsesSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAIResponses(createMappedResponsesModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "xhigh",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies.map(body => (body.reasoning as { effort?: string } | undefined)?.effort)).toEqual(["max", "xhigh"]);
	});

	it("retries Azure Responses xhigh as provider max", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const body = parseJsonBody(init);
				bodies.push(body);
				return bodies.length === 1
					? invalidReasoningResponse("reasoning.effort", "xhigh")
					: createResponsesSseResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamAzureOpenAIResponses(createAzureResponsesModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			azureBaseUrl: "https://azure.example.test/openai/v1",
			azureApiVersion: "v1",
			reasoning: "xhigh",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies.map(body => (body.reasoning as { effort?: string } | undefined)?.effort)).toEqual(["xhigh", "max"]);
	});

	it("does not retry unrelated reasoning parameter errors", async () => {
		let attempts = 0;
		const fetchMock: FetchImpl = Object.assign(
			async (): Promise<Response> => {
				attempts += 1;
				return summaryReasoningErrorResponse();
			},
			{ preconnect: fetch.preconnect },
		);

		const result = await streamOpenAIResponses(createResponsesModel(), testContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "xhigh",
			reasoningSummary: "auto",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(attempts).toBe(1);
	});
});
