import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "@oh-my-pi/pi-utils";
import { searchWithKagiV1 } from "../../src/web/kagi-v1";
import { KagiV1Provider, searchKagiV1 } from "../../src/web/search/providers/kagi-v1";
import { SearchProviderError } from "../../src/web/search/types";

describe("Kagi V1 web search error handling", () => {
	beforeEach(() => {
		process.env.KAGI_API_KEY = "test-kagi-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.KAGI_API_KEY;
	});

	it("surfaces error messages from JSON error bodies", async () => {
		const providerMessage = "Invalid API key or access denied.";

		using _hook = hookFetch(
			() =>
				new Response(JSON.stringify({ error: [{ code: 401, message: providerMessage }] }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				}),
		);

		try {
			await searchKagiV1({ query: "kagi v1 test" });
			expect.unreachable("expected searchKagiV1 to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "kagi-v1", status: 401 });
			expect((error as Error).message).toContain(providerMessage);
		}
	});

	it("falls back to plain text for non-JSON error bodies", async () => {
		using _hook = hookFetch(() => new Response("service unavailable", { status: 503 }));

		await expect(searchWithKagiV1("plain text error")).rejects.toThrow(
			"Kagi V1 API error (503): service unavailable",
		);
	});

	it("maps HTTP 5xx errors with empty body", async () => {
		using _hook = hookFetch(() => new Response("", { status: 502 }));

		await expect(searchWithKagiV1("empty error")).rejects.toThrow("Kagi V1 API error (502)");
	});
});

describe("Kagi V1 search result parsing", () => {
	beforeEach(() => {
		process.env.KAGI_API_KEY = "test-kagi-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.KAGI_API_KEY;
	});

	it("correctly parses categorized V1 response with search + video + news", async () => {
		using _hook = hookFetch(
			() =>
				new Response(
					JSON.stringify({
						meta: { id: "req-v1-success" },
						data: {
							search: [
								{
									url: "https://example.com/article",
									title: "Example Article",
									snippet: "Example snippet text",
									time: "2025-06-01T00:00:00Z",
								},
							],
							video: [
								{
									url: "https://example.com/video",
									title: "Example Video",
									snippet: "Video description",
									time: "2025-06-02T00:00:00Z",
								},
							],
							news: [
								{
									url: "https://example.com/news",
									title: "Breaking News",
									snippet: "News snippet",
									time: "2025-06-03T00:00:00Z",
								},
							],
							related_search: ["related query one", "related query two"],
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		const result = await searchWithKagiV1("success case");

		expect(result.requestId).toBe("req-v1-success");
		expect(result.sources).toHaveLength(3);
		expect(result.sources[0]).toMatchObject({
			title: "Example Article",
			url: "https://example.com/article",
			snippet: "Example snippet text",
			publishedDate: "2025-06-01T00:00:00Z",
		});
		expect(result.sources[1]).toMatchObject({
			title: "[Video] Example Video",
			url: "https://example.com/video",
		});
		expect(result.sources[2]).toMatchObject({
			title: "[News] Breaking News",
			url: "https://example.com/news",
		});
		expect(result.relatedQuestions).toEqual(["related query one", "related query two"]);
		expect(result.answer).toBeUndefined();
	});

	it("correctly parses direct_answer into answer field", async () => {
		using _hook = hookFetch(
			() =>
				new Response(
					JSON.stringify({
						meta: { id: "req-v1-answer" },
						data: {
							search: [{ url: "https://example.com", title: "Result", snippet: "Snippet" }],
							direct_answer: [{ text: "This is a direct answer." }],
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		const result = await searchWithKagiV1("question");

		expect(result.answer).toBe("This is a direct answer.");
	});

	it("returns empty sources array for empty search results", async () => {
		using _hook = hookFetch(
			() =>
				new Response(
					JSON.stringify({
						meta: { id: "req-v1-empty" },
						data: {},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		const result = await searchWithKagiV1("no results");

		expect(result.sources).toHaveLength(0);
		expect(result.relatedQuestions).toHaveLength(0);
		expect(result.answer).toBeUndefined();
	});

	it("maps recency 'month' to time_after filter in request body", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		using _hook = hookFetch((input: string | URL | Request, init) => {
			const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (urlStr === "https://kagi.com/api/v1/search") {
				capturedBody = JSON.parse(init?.body as string);
				return new Response(
					JSON.stringify({
						meta: { id: "req-recency" },
						data: { search: [] },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not mocked", { status: 500 });
		});

		await searchWithKagiV1("recency test", { recency: "month" });

		expect(capturedBody).toMatchObject({
			query: "recency test",
			workflow: "search",
			filters: { time_after: "1mo ago" },
		});
	});

	it("maps recency 'year' to time_after filter with 1y ago", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		using _hook = hookFetch((input: string | URL | Request, init) => {
			const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (urlStr === "https://kagi.com/api/v1/search") {
				capturedBody = JSON.parse(init?.body as string);
				return new Response(
					JSON.stringify({
						meta: { id: "req-recency-year" },
						data: { search: [] },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not mocked", { status: 500 });
		});

		await searchWithKagiV1("year recency", { recency: "year" });

		expect(capturedBody).toMatchObject({
			filters: { time_after: "1y ago" },
		});
	});

	it("uses Bearer auth header for V1 API", async () => {
		let capturedAuth: string | null = null;
		using _hook = hookFetch((input: string | URL | Request, init) => {
			const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (urlStr === "https://kagi.com/api/v1/search") {
				capturedAuth =
					init?.headers instanceof Headers
						? init.headers.get("Authorization")
						: typeof init?.headers === "object" && init?.headers !== null
							? (init.headers as Record<string, string>).Authorization
							: null;
				return new Response(
					JSON.stringify({
						meta: { id: "req-auth" },
						data: { search: [] },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not mocked", { status: 500 });
		});

		await searchWithKagiV1("auth test");

		expect(capturedAuth ?? "null").toBe("Bearer test-kagi-key");
	});
});

describe("KagiV1Provider.isAvailable", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.KAGI_API_KEY;
	});

	it("returns true when KAGI_API_KEY is set", async () => {
		process.env.KAGI_API_KEY = "test-key";
		const provider = new KagiV1Provider();
		await expect(provider.isAvailable()).resolves.toBe(true);
	});

	it("returns false when KAGI_API_KEY is not set", async () => {
		delete process.env.KAGI_API_KEY;
		const provider = new KagiV1Provider();
		await expect(provider.isAvailable()).resolves.toBe(false);
	});
});
