import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { hookFetch } from "@oh-my-pi/pi-utils";
import { searchTavily } from "../../src/web/search/providers/tavily";
import type { SearchProviderError } from "../../src/web/search/types";

describe("Tavily web search provider", () => {
	beforeEach(() => {
		process.env.TAVILY_API_KEY = "test-tavily-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.TAVILY_API_KEY;
	});

	const fakeAuthStorage = {
		async getApiKey() {
			return process.env.TAVILY_API_KEY ?? undefined;
		},
		hasAuth() {
			return Boolean(process.env.TAVILY_API_KEY);
		},
	} as unknown as AuthStorage;

	function makeParams(query: string) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "Tavily test prompt",
		} as const;
	}

	it("maps Tavily responses into SearchResponse and forwards recency filters", async () => {
		let requestBody: Record<string, unknown> | null = null;

		using _hook = hookFetch(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					answer: "Synthesized Tavily answer",
					request_id: "req-tavily-123",
					results: [
						{
							title: "Result One",
							url: "https://example.com/one",
							content: "First snippet",
							published_date: "2026-03-01T00:00:00Z",
						},
						{
							url: "https://example.com/two",
							content: "Second snippet",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const response = await searchTavily({ ...makeParams("latest ai news"), numSearchResults: 2, recency: "week" });
		// Recency must not couple to topic — topic should be absent (Tavily defaults to general)
		expect(requestBody).toMatchObject({
			query: "latest ai news",
			max_results: 2,
			time_range: "week",
			include_answer: "advanced",
			include_raw_content: false,
		});
		expect(requestBody).not.toHaveProperty("topic");
		expect(response).toMatchObject({
			provider: "tavily",
			answer: "Synthesized Tavily answer",
			requestId: "req-tavily-123",
			authMode: "api_key",
			sources: [
				{
					title: "Result One",
					url: "https://example.com/one",
					snippet: "First snippet",
					publishedDate: "2026-03-01T00:00:00Z",
				},
				{
					title: "https://example.com/two",
					url: "https://example.com/two",
					snippet: "Second snippet",
				},
			],
		});
		expect(response.sources[0]?.ageSeconds).toBeTypeOf("number");
	});

	it("surfaces structured API errors", async () => {
		using _hook = hookFetch(
			() =>
				new Response(JSON.stringify({ detail: { error: "invalid api key" } }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				}),
		);

		await expect(searchTavily(makeParams("bad auth"))).rejects.toEqual(
			expect.objectContaining({
				provider: "tavily",
				status: 401,
				message: "tavily: 401 unauthorized",
			}) satisfies Partial<SearchProviderError>,
		);
	});

	it("throws a clear error when Tavily credentials are missing", async () => {
		delete process.env.TAVILY_API_KEY;
		await expect(searchTavily(makeParams("missing creds"))).rejects.toThrow(
			'Tavily credentials not found. Set TAVILY_API_KEY or configure an API key for provider "tavily".',
		);
	});
});
