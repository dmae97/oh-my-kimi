import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { searchTinyFish } from "@oh-my-pi/pi-coding-agent/web/search/providers/tinyfish";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

const TEST_KEY = "test-tinyfish-key";

function makeAuthStorage(apiKey: string | undefined): AuthStorage {
	return {
		resolver(provider: string, options?: { sessionId?: string }) {
			expect(provider).toBe("tinyfish");
			expect(options?.sessionId).toBe("session-tinyfish-test");
			return async () => apiKey;
		},
		hasAuth(provider: string) {
			return provider === "tinyfish" && Boolean(apiKey);
		},
	} as unknown as AuthStorage;
}

function makeParams(query: string, authStorage: AuthStorage = makeAuthStorage(TEST_KEY)) {
	return {
		query,
		authStorage,
		systemPrompt: "TinyFish test prompt",
		sessionId: "session-tinyfish-test",
	} as const;
}

function getHeader(headers: RequestInit["headers"] | undefined, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);
	if (Array.isArray(headers)) {
		return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null;
	}
	const record = headers as Record<string, string>;
	return record[name] ?? record[name.toLowerCase()] ?? null;
}

describe("TinyFish web search provider", () => {
	it("sends the TinyFish GET request and locally clamps results", async () => {
		const captured: { url?: URL; init?: RequestInit } = {};

		const fetchMock: FetchImpl = async (input, init) => {
			captured.url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			captured.init = init;
			return new Response(
				JSON.stringify({
					results: [
						{
							title: "TinyFish result one",
							url: "https://example.com/one",
							snippet: "First snippet",
							site_name: "Example Site",
						},
						{
							title: "TinyFish result two",
							url: "https://example.com/two",
							snippet: "Second snippet",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const response = await searchTinyFish({
			...makeParams("fresh fish"),
			numSearchResults: 1,
			recency: "week",
			fetch: fetchMock,
		});

		const capturedUrl = captured.url;
		if (!capturedUrl) throw new Error("TinyFish request was not captured");
		const endpoint = `${capturedUrl.origin}${capturedUrl.pathname === "/" ? "" : capturedUrl.pathname}`;
		expect(endpoint).toBe("https://api.search.tinyfish.ai");
		expect(captured.init?.method ?? "GET").toBe("GET");
		expect(getHeader(captured.init?.headers, "X-API-Key")).toBe(TEST_KEY);
		expect(capturedUrl.searchParams.get("query")).toBe("fresh fish");
		expect(capturedUrl.searchParams.get("recency_minutes")).toBe("10080");
		expect([...capturedUrl.searchParams.keys()].sort()).toEqual(["query", "recency_minutes"]);
		expect(response).toEqual({
			provider: "tinyfish",
			sources: [
				{
					title: "TinyFish result one",
					url: "https://example.com/one",
					snippet: "First snippet",
					author: "Example Site",
				},
			],
			authMode: "api_key",
		});
	});

	it.each([
		[401, "tinyfish: 401 unauthorized"],
		[402, "tinyfish: 402 credits exhausted"],
	] as const)("maps HTTP %d to a SearchProviderError", async (status, message) => {
		const fetchMock: FetchImpl = async () => new Response("upstream rejected", { status });

		try {
			await searchTinyFish({ ...makeParams("bad auth"), fetch: fetchMock });
			expect.unreachable("expected searchTinyFish to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "tinyfish", status, message });
		}
	});

	it("throws a clear error when TinyFish credentials are missing", async () => {
		const fetchMock: FetchImpl = async () => {
			throw new Error("fetch should not be called without credentials");
		};

		try {
			await searchTinyFish({ ...makeParams("missing creds", makeAuthStorage(undefined)), fetch: fetchMock });
			expect.unreachable("expected searchTinyFish to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe(
				'TinyFish credentials not found. Set TINYFISH_API_KEY or configure an API key for provider "tinyfish".',
			);
		}
	});
});
