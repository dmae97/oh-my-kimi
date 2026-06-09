import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { searchWithParallel } from "@oh-my-pi/pi-coding-agent/web/parallel";
import { searchParallel } from "@oh-my-pi/pi-coding-agent/web/search/providers/parallel";

describe("Parallel web search", () => {
	const fakeStorage = {
		listAuthCredentials: () => [
			{
				id: 1,
				credential: {
					type: "oauth",
					access: "test-access-token",
					expires: Date.now() + 600_000,
					accountId: "acct-test",
				},
			},
		],
		updateAuthCredential: () => undefined,
		get authStore() {
			return null as never;
		},
	} as unknown as AgentStorage;
	const fakeAuthStorage = {
		async getApiKey() {
			return process.env.PARALLEL_API_KEY ?? undefined;
		},
		hasAuth() {
			return Boolean(process.env.PARALLEL_API_KEY);
		},
		resolver(_provider: string) {
			return async () => process.env.PARALLEL_API_KEY ?? undefined;
		},
		async rotateSessionCredential() {
			return false;
		},
	} as unknown as AuthStorage;

	let capturedRequestBody: unknown;

	beforeEach(() => {
		capturedRequestBody = undefined;
		process.env.PARALLEL_API_KEY = "test-parallel-key";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PARALLEL_API_KEY;
	});

	function mockFetch(responseBody: unknown, status = 200): FetchImpl {
		return (_url, init) => {
			if (typeof init?.body === "string") {
				capturedRequestBody = JSON.parse(init.body);
			}
			return Promise.resolve(
				new Response(JSON.stringify(responseBody), {
					status,
					headers: { "Content-Type": "application/json" },
				}),
			);
		};
	}

	it("sends the expected Parallel search request and parses results", async () => {
		const fetchMock = mockFetch({
			search_id: "search-parallel-1",
			results: [
				{
					title: "Parallel result",
					url: "https://example.com/article",
					publish_date: "2025-01-01",
					excerpts: ["First excerpt", "Second excerpt"],
				},
			],
			warnings: null,
			usage: [{ name: "sku_search", count: 1 }],
		});

		const result = await searchWithParallel("parallel query", ["parallel query"], { fetch: fetchMock }, fakeStorage);
		expect(capturedRequestBody).toEqual({
			objective: "parallel query",
			search_queries: ["parallel query"],
			mode: "fast",
			excerpts: { max_chars_per_result: 10_000 },
		});
		expect(result).toEqual({
			requestId: "search-parallel-1",
			sources: [
				{
					title: "Parallel result",
					url: "https://example.com/article",
					snippet: "First excerpt\n\nSecond excerpt",
					publishedDate: "2025-01-01",
					excerpts: ["First excerpt", "Second excerpt"],
				},
			],
			warnings: [],
			usage: [{ name: "sku_search", count: 1 }],
		});
	});

	it("maps Parallel search responses into SearchResponse", async () => {
		const fetchMock = mockFetch({
			search_id: "search-parallel-2",
			results: [
				{
					title: "Alpha",
					url: "https://alpha.example",
					publish_date: "2024-12-24",
					excerpts: ["Alpha excerpt"],
				},
			],
			errors: [],
			warnings: null,
			usage: null,
		});

		const result = await searchParallel({ query: "alpha search", fetch: fetchMock }, fakeAuthStorage);
		expect(result.provider).toBe("parallel");
		expect(result.requestId).toBe("search-parallel-2");
		expect(result.sources).toEqual([
			{
				title: "Alpha",
				url: "https://alpha.example",
				snippet: "Alpha excerpt",
				publishedDate: "2024-12-24",
				ageSeconds: expect.any(Number),
			},
		]);
	});

	it("surfaces plain-text Parallel API errors", async () => {
		const fetchMock: FetchImpl = () => Promise.resolve(new Response("upstream unavailable", { status: 503 }));
		await expect(searchParallel({ query: "broken", fetch: fetchMock }, fakeAuthStorage)).rejects.toMatchObject({
			provider: "parallel",
			status: 503,
			message: "Parallel API error (503): upstream unavailable",
		});
	});
});
