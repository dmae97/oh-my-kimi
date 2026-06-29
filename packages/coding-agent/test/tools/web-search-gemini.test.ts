import { afterEach, describe, expect, it } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { GeminiProvider, searchGemini } from "@oh-my-pi/pi-coding-agent/web/search/providers/gemini";

const SSE_RESPONSE =
	'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Gemini answer"}]}}],"modelVersion":"gemini-2.5-flash"}}\n\n';
const DEVELOPER_SSE_RESPONSE =
	'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Developer answer"}]},"groundingMetadata":{"webSearchQueries":["latest Bun version"],"groundingChunks":[{"web":{"uri":"https://bun.sh","title":"Bun"}}],"groundingSupports":[{"segment":{"text":"Developer answer"},"groundingChunkIndices":[0]}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7},"modelVersion":"gemini-2.5-flash"}\n\n';

type CapturedRequest = {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown> | null;
};

describe("searchGemini tools serialization", () => {
	let capturedRequest: CapturedRequest | null = null;

	const fakeAuthStorage = {
		async getOAuthAccess() {
			return {
				accessToken: "test-access-token",
				projectId: "test-project",
			};
		},
		hasOAuth() {
			return true;
		},
	} as unknown as AuthStorage;

	const apiKeyAuthStorage = {
		async getOAuthAccess() {
			return undefined;
		},
		hasOAuth() {
			return false;
		},
		hasAuth(provider: string) {
			return provider === "google";
		},
		async getApiKey(provider: string) {
			return provider === "google" ? "test-gemini-api-key" : undefined;
		},
	} as unknown as AuthStorage;

	function mockGeminiFetch(responseText = SSE_RESPONSE): FetchImpl {
		capturedRequest = null;
		return (url, init) => {
			const headers = new Headers(init?.headers);
			capturedRequest = {
				url: String(url),
				headers: Object.fromEntries(headers.entries()),
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};
			return Promise.resolve(
				new Response(responseText, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);
		};
	}

	afterEach(() => {
		capturedRequest = null;
	});

	function makeParams(query: string) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "Gemini test prompt",
		} as const;
	}

	it("treats a standard Google developer API key as available", () => {
		const provider = new GeminiProvider();
		expect(provider.isAvailable(apiKeyAuthStorage)).toBe(true);
	});

	it("routes API key auth through the developer API with Google Search grounding", async () => {
		const fetchMock = mockGeminiFetch(DEVELOPER_SSE_RESPONSE);
		const response = await searchGemini({
			...makeParams("developer api"),
			authStorage: apiKeyAuthStorage,
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
		);
		expect(capturedRequest?.headers["x-goog-api-key"]).toBe("test-gemini-api-key");
		expect(capturedRequest?.body).toMatchObject({
			tools: [{ googleSearch: {} }],
		});
		expect(response).toMatchObject({
			answer: "Developer answer",
			sources: [{ title: "Bun", url: "https://bun.sh" }],
			searchQueries: ["latest Bun version"],
			usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
		});
	});
	it("sends default googleSearch tool when no passthrough payloads are provided", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({ ...makeParams("default tools"), fetch: fetchMock });

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: {} }],
		});
	});

	it("passes through googleSearch payload into googleSearch tool", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("google payload"),
			google_search: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } },
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } } }],
		});
	});

	it("includes codeExecution and urlContext tools when provided", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("extended tools"),
			code_execution: {},
			url_context: { allowedDomains: ["example.com"] },
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: {} }, { codeExecution: {} }, { urlContext: { allowedDomains: ["example.com"] } }],
		});
	});
});
