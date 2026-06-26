import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { searchXAI } from "@oh-my-pi/pi-coding-agent/web/search/providers/xai";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

type CapturedRequest = {
	url: string;
	method: string | undefined;
	headers: RequestInit["headers"];
	body: Record<string, unknown> | null;
};

function makeAuthStorage(apiKey: string | undefined) {
	return {
		resolver(provider: string, options?: { sessionId?: string }) {
			expect(provider).toBe("xai");
			expect(options?.sessionId).toBe("session-xai-test");
			return async () => apiKey;
		},
		hasAuth(provider: string) {
			return provider === "xai" && Boolean(apiKey);
		},
	} as unknown as AuthStorage;
}

function makeParams(fetch: FetchImpl, authStorage: AuthStorage = makeAuthStorage("test-xai-key")) {
	return {
		query: "latest xAI web search",
		systemPrompt: "Use web search for current xAI facts.",
		authStorage,
		fetch,
		sessionId: "session-xai-test",
	} as const;
}

function captureFetch(responseBody: Record<string, unknown>, status = 200) {
	let capturedRequest: CapturedRequest | null = null;
	const fetchMock: FetchImpl = (input, init) => {
		capturedRequest = {
			url: typeof input === "string" ? input : input.toString(),
			method: init?.method,
			headers: init?.headers,
			body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
		};
		return Promise.resolve(
			new Response(JSON.stringify(responseBody), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		);
	};
	return {
		fetchMock,
		get capturedRequest() {
			return capturedRequest;
		},
	};
}

describe("xAI web search provider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("POSTs the Responses API with bearer auth and xAI web_search tool payload", async () => {
		const capture = captureFetch({ id: "resp_request", model: "grok-4.3", output_text: "xAI answer" });

		await searchXAI({
			...makeParams(capture.fetchMock),
			maxOutputTokens: 512,
			temperature: 0.2,
		});

		expect(capture.capturedRequest).not.toBeNull();
		expect(capture.capturedRequest?.url).toBe("https://api.x.ai/v1/responses");
		expect(capture.capturedRequest?.method).toBe("POST");
		expect(capture.capturedRequest?.headers).toMatchObject({
			"Content-Type": "application/json",
			Authorization: "Bearer test-xai-key",
		});
		expect(capture.capturedRequest?.body).toMatchObject({
			model: "grok-4.3",
			input: [
				{ role: "system", content: "Use web search for current xAI facts." },
				{ role: "user", content: "latest xAI web search" },
			],
			tools: [{ type: "web_search" }],
			max_output_tokens: 512,
			temperature: 0.2,
		});
	});

	it("maps output_text, URL citation annotations, top-level citations, id, model, usage, and auth mode", async () => {
		const capture = captureFetch({
			id: "resp_xai_123",
			model: "grok-4.3",
			output_text: "Top-level xAI answer",
			annotations: [
				{
					type: "url_citation",
					url: "https://example.com/top-annotation",
					title: "Top Annotation",
					text: "Top annotation text",
				},
			],
			output: [
				{
					type: "message",
					annotations: [
						{
							type: "url_citation",
							url: "https://example.com/item-annotation",
							title: "Item Annotation",
							cited_text: "Item annotation text",
						},
					],
					content: [
						{
							type: "output_text",
							text: "Ignored because output_text wins",
							annotations: [
								{
									type: "url_citation",
									url: "https://example.com/annotated",
									title: "Annotated Source",
									cited_text: "Annotated cited text",
								},
							],
						},
					],
				},
			],
			citations: ["https://example.com/top-level-citation"],
			usage: {
				input_tokens: 12,
				output_tokens: 8,
				total_tokens: 20,
			},
		});

		const response = await searchXAI(makeParams(capture.fetchMock));

		expect(response).toMatchObject({
			provider: "xai",
			answer: "Top-level xAI answer",
			requestId: "resp_xai_123",
			model: "grok-4.3",
			authMode: "api_key",
			usage: {
				inputTokens: 12,
				outputTokens: 8,
				totalTokens: 20,
			},
			sources: [
				{
					title: "Top Annotation",
					url: "https://example.com/top-annotation",
					snippet: "Top annotation text",
				},
				{
					title: "Item Annotation",
					url: "https://example.com/item-annotation",
					snippet: "Item annotation text",
				},
				{
					title: "Annotated Source",
					url: "https://example.com/annotated",
					snippet: "Annotated cited text",
				},
				{
					title: "https://example.com/top-level-citation",
					url: "https://example.com/top-level-citation",
				},
			],
			citations: [
				{
					title: "Top Annotation",
					url: "https://example.com/top-annotation",
					citedText: "Top annotation text",
				},
				{
					title: "Item Annotation",
					url: "https://example.com/item-annotation",
					citedText: "Item annotation text",
				},
				{
					title: "Annotated Source",
					url: "https://example.com/annotated",
					citedText: "Annotated cited text",
				},
				{
					title: "https://example.com/top-level-citation",
					url: "https://example.com/top-level-citation",
				},
			],
		});
	});

	it("falls back to output content parts when output_text is absent", async () => {
		const capture = captureFetch({
			id: "resp_content_parts",
			model: "grok-4.3",
			output: [
				{
					content: [
						{ type: "output_text", text: "First content part" },
						{ type: "text", output_text: "Second content part" },
					],
				},
			],
		});

		const response = await searchXAI(makeParams(capture.fetchMock));
		expect(response).toMatchObject({
			answer: "First content part\nSecond content part",
		});
	});

	it.each([
		[401, "xai: 401 unauthorized"],
		[402, "xai: 402 credits exhausted"],
	] as const)("maps HTTP %s failures to SearchProviderError", async (status, message) => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(JSON.stringify({ error: "request failed" }), {
					status,
					headers: { "Content-Type": "application/json" },
				}),
			);

		try {
			await searchXAI(makeParams(fetchMock));
			expect.unreachable(`xAI HTTP ${status} failure should reject`);
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({
				provider: "xai",
				status,
				message,
			});
		}
	});

	it("throws a clear missing-key error before fetch when credentials are unavailable", async () => {
		const fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 }))) as unknown as FetchImpl;

		try {
			await searchXAI(makeParams(fetchMock, makeAuthStorage(undefined)));
			expect.unreachable("missing xAI credentials should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect(error).toHaveProperty(
				"message",
				'xAI credentials not found. Set XAI_API_KEY or configure an API key for provider "xai".',
			);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
