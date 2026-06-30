import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { __resetVertexTokenCache } from "@oh-my-pi/pi-ai/providers/google-auth";
import { streamGoogleVertex } from "@oh-my-pi/pi-ai/providers/google-vertex";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, Context, FetchImpl, Model, Tool, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function googleModel(baseUrl = "https://generativelanguage.googleapis.com/v1beta"): Model<"google-generative-ai"> {
	return buildModel({
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		api: "google-generative-ai",
		provider: "google",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8_192,
	});
}

function vertexModel(id = "gemini-3.5-flash"): Model<"google-vertex"> {
	return buildModel({
		id,
		name: id,
		api: "google-vertex",
		provider: "google-vertex",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8_192,
	});
}

function sseResponse(events: readonly unknown[]): Response {
	const payload = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const weatherTool: Tool = {
	name: "get_weather",
	description: "Get weather",
	parameters: {
		type: "object",
		properties: { city: { type: "string" } },
		required: ["city"],
		additionalProperties: false,
	},
};

describe("Google Interactions API", () => {
	it("chains tool results with previous_interaction_id from the prior assistant response", async () => {
		const model = googleModel();
		const requestBodies: unknown[] = [];
		let calls = 0;
		const fetchMock: FetchImpl = async (_input, init) => {
			requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
			calls += 1;
			if (calls === 1) {
				return sseResponse([
					{
						event_type: "interaction.created",
						interaction: { id: "int_1", status: "in_progress" },
					},
					{ event_type: "step.start", index: 0, step: { type: "thought" } },
					{
						event_type: "step.delta",
						index: 0,
						delta: { type: "thought_signature", signature: "thought_sig_1" },
					},
					{
						event_type: "step.delta",
						index: 0,
						delta: { type: "thought_summary", content: { type: "text", text: "Checking weather.\n" } },
					},
					{ event_type: "step.stop", index: 0 },
					{
						event_type: "step.start",
						index: 1,
						step: {
							type: "function_call",
							id: "call_weather",
							name: "get_weather",
							arguments: {},
						},
					},
					{ event_type: "step.delta", index: 1, delta: { type: "arguments_delta", arguments: '{"city":"Bos' } },
					{ event_type: "step.delta", index: 1, delta: { type: "arguments_delta", arguments: 'ton"}' } },
					{ event_type: "step.stop", index: 1 },
					{
						event_type: "interaction.completed",
						interaction: {
							id: "int_1",
							status: "requires_action",
							usage: { total_input_tokens: 10, total_output_tokens: 2, total_tokens: 12 },
						},
					},
				]);
			}
			return sseResponse([
				{ event_type: "interaction.created", interaction: { id: "int_2", status: "in_progress" } },
				{ event_type: "step.start", index: 0, step: { type: "model_output" } },
				{ event_type: "step.delta", index: 0, delta: { type: "text", text: "Sunny." } },
				{ event_type: "step.stop", index: 0 },
				{
					event_type: "interaction.completed",
					interaction: {
						id: "int_2",
						status: "completed",
						usage: { total_input_tokens: 3, total_output_tokens: 1, total_tokens: 4 },
					},
				},
			]);
		};
		Object.assign(fetchMock, { preconnect: fetch.preconnect });

		const firstContext: Context = {
			systemPrompt: ["Use concise weather reports."],
			messages: [{ role: "user", content: "Need weather", timestamp: 1 }],
			tools: [weatherTool],
		};
		const first = await streamGoogle(model, firstContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			useInteractionsApi: true,
			thinking: { enabled: true, level: "HIGH", budgetTokens: 123 },
		}).result();

		expect(first.responseId).toBe("int_1");
		expect(first.stopReason).toBe("toolUse");
		expect(first.content).toEqual([
			{ type: "thinking", thinking: "Checking weather.\n", thinkingSignature: "thought_sig_1" },
			{ type: "toolCall", id: "call_weather", name: "get_weather", arguments: { city: "Boston" } },
		]);
		expect(requestBodies[0]).toMatchObject({
			model: "gemini-3.5-flash",
			stream: true,
			input: [{ type: "user_input", content: [{ type: "text", text: "Need weather" }] }],
			system_instruction: "Use concise weather reports.",
			tools: [{ functionDeclarations: [{ name: "get_weather" }] }],
			generation_config: { thinking_level: "high" },
		});
		expect(requestBodies[0]).not.toHaveProperty("previous_interaction_id");
		expect(JSON.stringify(requestBodies[0])).not.toContain("thinking_budget");

		const secondContext: Context = {
			messages: [
				{ role: "user", content: "Need weather", timestamp: 1 },
				first,
				{
					role: "toolResult",
					toolCallId: "call_weather",
					toolName: "get_weather",
					content: [{ type: "text", text: "72F and sunny" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: [weatherTool],
			systemPrompt: ["Use concise weather reports."],
		};
		const second = await streamGoogle(model, secondContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			thinking: { enabled: true, level: "HIGH", budgetTokens: 123 },
		}).result();

		expect(second.responseId).toBe("int_2");
		expect(second.content).toEqual([{ type: "text", text: "Sunny." }]);
		expect(requestBodies[1]).toMatchObject({
			previous_interaction_id: "int_1",
			input: [
				{
					type: "function_result",
					name: "get_weather",
					call_id: "call_weather",
					result: [{ type: "text", text: "72F and sunny" }],
				},
			],
			tools: [{ functionDeclarations: [{ name: "get_weather" }] }],
			system_instruction: "Use concise weather reports.",
			generation_config: { thinking_level: "high" },
		});
		expect(JSON.stringify(requestBodies[1])).not.toContain("Need weather");
		expect(JSON.stringify(requestBodies[1])).not.toContain("thinking_budget");
	});

	it("does not expose or reuse interaction ids when storage is disabled", async () => {
		const model = googleModel();
		const requestBodies: unknown[] = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
			return sseResponse([
				{ event_type: "interaction.created", interaction: { id: "unstored_int", status: "in_progress" } },
				{ event_type: "step.start", index: 0, step: { type: "model_output" } },
				{ event_type: "step.delta", index: 0, delta: { type: "text", text: "Done." } },
				{ event_type: "step.stop", index: 0 },
				{ event_type: "interaction.completed", interaction: { id: "unstored_int", status: "completed" } },
			]);
		};
		Object.assign(fetchMock, { preconnect: fetch.preconnect });

		const result = await streamGoogle(
			model,
			{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{
				apiKey: "test-key",
				fetch: fetchMock,
				useInteractionsApi: true,
				storeInteraction: false,
			},
		).result();

		expect(result.responseId).toBeUndefined();
		expect(requestBodies[0]).toMatchObject({ store: false });
		expect(() =>
			streamGoogle(
				model,
				{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
				{
					apiKey: "test-key",
					fetch: fetchMock,
					storeInteraction: false,
					previousInteractionId: "unstored_int",
				},
			),
		).toThrow(/storeInteraction:false/);
	});

	it("reads thought payload from step.start without leaking a prior signature", async () => {
		const model = googleModel();
		const fetchMock: FetchImpl = async () =>
			sseResponse([
				{ event_type: "interaction.created", interaction: { id: "int_3", status: "in_progress" } },
				{ event_type: "step.start", index: 0, step: { type: "thought", signature: "stale_sig" } },
				{ event_type: "step.stop", index: 0 },
				{
					event_type: "step.start",
					index: 1,
					step: { type: "thought", summary: [{ type: "text", text: "Fresh plan.\n" }] },
				},
				{ event_type: "step.stop", index: 1 },
				{ event_type: "step.start", index: 2, step: { type: "model_output" } },
				{ event_type: "step.delta", index: 2, delta: { type: "text", text: "Answer." } },
				{ event_type: "step.stop", index: 2 },
				{ event_type: "interaction.completed", interaction: { id: "int_3", status: "completed" } },
			]);
		Object.assign(fetchMock, { preconnect: fetch.preconnect });

		const result = await streamGoogle(
			model,
			{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{ apiKey: "test-key", fetch: fetchMock, useInteractionsApi: true },
		).result();

		expect(result.content).toEqual([
			{ type: "thinking", thinking: "Fresh plan.\n" },
			{ type: "text", text: "Answer." },
		]);
	});
});

function genaiSse(text: string): Response {
	return new Response(
		`data: ${JSON.stringify({
			candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
		})}\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function interactionsTextSse(
	id: string,
	text: string,
	terminal: "interaction.completed" | "interaction.complete" = "interaction.completed",
): Response {
	return sseResponse([
		{ event_type: "interaction.created", interaction: { id, status: "in_progress" } },
		{ event_type: "step.start", index: 0, step: { type: "model_output" } },
		{ event_type: "step.delta", index: 0, delta: { type: "text", text } },
		{ event_type: "step.stop", index: 0 },
		{
			event_type: terminal,
			interaction: {
				id,
				status: "completed",
				usage: { total_input_tokens: 10, total_output_tokens: 5, total_tokens: 15 },
			},
		},
	]);
}

interface CapturedCall {
	url: string;
	method: string;
	headers: Headers;
	body: unknown;
}

function captureFetch(handler: (url: string) => Response): { fetch: FetchImpl; calls: CapturedCall[] } {
	const calls: CapturedCall[] = [];
	const fetchMock: FetchImpl = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		calls.push({
			url,
			method: String(init?.method ?? "GET"),
			headers: new Headers(init?.headers),
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		return handler(url);
	};
	Object.assign(fetchMock, { preconnect: fetch.preconnect });
	return { fetch: fetchMock, calls };
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantWithResponse(
	api: "google-vertex" | "google-generative-ai",
	provider: string,
	responseId: string,
): AssistantMessage {
	return {
		role: "assistant",
		api,
		provider,
		model: "gemini-3.5-flash",
		content: [{ type: "text", text: "prev" }],
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 2,
		responseId,
	};
}

const userTurn: Context = { messages: [{ role: "user", content: "Hi there", timestamp: 1 }] };

describe("Google Interactions API — zero-config default + fallback", () => {
	let savedToken: string | undefined;
	beforeEach(() => {
		// A bearer source makes the Vertex auto-gate fire deterministically on any machine, and
		// `getVertexAccessToken` returns it directly (no OAuth/metadata round-trip in tests).
		savedToken = Bun.env.GOOGLE_CLOUD_ACCESS_TOKEN;
		Bun.env.GOOGLE_CLOUD_ACCESS_TOKEN = "test-bearer";
	});
	afterEach(() => {
		if (savedToken === undefined) delete Bun.env.GOOGLE_CLOUD_ACCESS_TOKEN;
		else Bun.env.GOOGLE_CLOUD_ACCESS_TOKEN = savedToken;
		__resetVertexTokenCache();
	});

	it("auto-routes a capable Vertex model to Interactions under bearer auth", async () => {
		const { fetch, calls } = captureFetch(() => interactionsTextSse("vint_1", "Hi"));
		const result = await streamGoogleVertex(vertexModel(), userTurn, {
			project: "p",
			location: "us",
			fetch,
		}).result();

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://aiplatform.googleapis.com/v1beta1/projects/p/locations/global/interactions");
		expect(calls[0].method).toBe("POST");
		expect(calls[0].headers.get("Api-Revision")).toBe("2026-05-20");
		expect(calls[0].headers.get("Authorization")).toBe("Bearer test-bearer");
		expect(calls[0].body).toMatchObject({
			model: "gemini-3.5-flash",
			stream: true,
			input: [{ type: "user_input", content: [{ type: "text", text: "Hi there" }] }],
		});
		expect(calls[0].body).not.toHaveProperty("contents");
		expect(calls[0].body).not.toHaveProperty("agent");
		expect(calls[0].body).not.toHaveProperty("environment");
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hi" }]);
		expect(result.responseId).toBe("vint_1");
		expect(result.usage.totalTokens).toBe(15);
	});

	it("keeps an older (sub-3) Vertex model on generateContent", async () => {
		const { fetch, calls } = captureFetch(() => genaiSse("ok"));
		await streamGoogleVertex(vertexModel("gemini-2.5-flash"), userTurn, {
			project: "p",
			location: "us",
			fetch,
		}).result();

		expect(calls[0].url).toContain(":streamGenerateContent");
		expect(calls.some(c => c.url.includes("/interactions"))).toBe(false);
	});

	it("honors useInteractionsApi:false on a capable Vertex model", async () => {
		const { fetch, calls } = captureFetch(() => genaiSse("ok"));
		await streamGoogleVertex(vertexModel(), userTurn, {
			project: "p",
			location: "us",
			useInteractionsApi: false,
			fetch,
		}).result();

		expect(calls[0].url).toContain(":streamGenerateContent");
		expect(calls.some(c => c.url.includes("/interactions"))).toBe(false);
	});

	it("falls back to generateContent when auto Interactions is unsupported (404)", async () => {
		const { fetch, calls } = captureFetch(url =>
			url.includes("/interactions") ? new Response("nope", { status: 404 }) : genaiSse("recovered"),
		);
		const result = await streamGoogleVertex(vertexModel(), userTurn, {
			project: "p",
			location: "us",
			fetch,
		}).result();

		expect(calls[0].url).toContain("/interactions");
		expect(calls[1].url).toContain(":streamGenerateContent");
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("surfaces the error (no fallback) when explicit Interactions is unsupported", async () => {
		const { fetch, calls } = captureFetch(url =>
			url.includes("/interactions") ? new Response("nope", { status: 404 }) : genaiSse("unexpected"),
		);
		const result = await streamGoogleVertex(vertexModel(), userTurn, {
			project: "p",
			useInteractionsApi: true,
			fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(calls.some(c => c.url.includes(":streamGenerateContent"))).toBe(false);
	});

	it("accepts interaction.complete as a terminal-event alias", async () => {
		const { fetch } = captureFetch(() => interactionsTextSse("vint_2", "Done", "interaction.complete"));
		const result = await streamGoogleVertex(vertexModel(), userTurn, { project: "p", fetch }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Done" }]);
	});

	it("sends previous_interaction_id only for same-provider assistant lineage", async () => {
		const sameProvider = captureFetch(() => interactionsTextSse("vint_3", "ok"));
		await streamGoogleVertex(
			vertexModel(),
			{
				messages: [
					{ role: "user", content: "a", timestamp: 1 },
					assistantWithResponse("google-vertex", "google-vertex", "vint_prev"),
					{ role: "user", content: "b", timestamp: 3 },
				],
			},
			{ project: "p", fetch: sameProvider.fetch },
		).result();
		expect(sameProvider.calls[0].body).toMatchObject({ previous_interaction_id: "vint_prev" });

		const wrongProvider = captureFetch(() => interactionsTextSse("vint_4", "ok"));
		await streamGoogleVertex(
			vertexModel(),
			{
				messages: [
					{ role: "user", content: "a", timestamp: 1 },
					assistantWithResponse("google-generative-ai", "google", "gint_prev"),
					{ role: "user", content: "b", timestamp: 3 },
				],
			},
			{ project: "p", fetch: wrongProvider.fetch },
		).result();
		expect(wrongProvider.calls[0].body).not.toHaveProperty("previous_interaction_id");
	});

	it("auto-routes a capable direct Google model on the official endpoint to Interactions", async () => {
		const { fetch, calls } = captureFetch(() => interactionsTextSse("gint_1", "Hi"));
		const result = await streamGoogle(googleModel(), userTurn, { apiKey: "k", fetch }).result();

		expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
		expect(calls[0].headers.get("x-goog-api-key")).toBe("k");
		expect(result.responseId).toBe("gint_1");
	});

	it("keeps a custom-baseUrl direct Google model on generateContent", async () => {
		const { fetch, calls } = captureFetch(() => genaiSse("ok"));
		await streamGoogle(googleModel("https://proxy.example.com/v1beta"), userTurn, {
			apiKey: "k",
			fetch,
		}).result();

		expect(calls[0].url).toContain(":streamGenerateContent");
		expect(calls[0].url.startsWith("https://proxy.example.com/")).toBe(true);
		expect(calls.some(c => c.url.includes("/interactions"))).toBe(false);
	});

	it("threads the auto-default through streamSimple for a capable Google model", async () => {
		const { fetch, calls } = captureFetch(() => interactionsTextSse("sint_1", "Hi"));
		await streamSimple(googleModel(), userTurn, { apiKey: "k", fetch }).result();

		expect(calls.some(c => c.url.includes("/interactions"))).toBe(true);
	});
});
