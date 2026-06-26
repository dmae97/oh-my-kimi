import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { searchTinyFish } from "@oh-my-pi/pi-coding-agent/web/search/providers/tinyfish";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

const TEST_KEY = "test-tinyfish-key";
const UNSUPPORTED_TINYFISH_COUNT_PARAMS = ["limit", "num_results", "count", "size", "max_results"] as const;

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

function expectOnlyDocumentedTinyFishParams(url: URL, expectedParams: readonly string[]): void {
	expect([...url.searchParams.keys()].sort()).toEqual([...expectedParams].sort());
	for (const unsupportedParam of UNSUPPORTED_TINYFISH_COUNT_PARAMS) {
		expect(url.searchParams.has(unsupportedParam)).toBe(false);
	}
}

describe("TinyFish web search provider", () => {
	it("documents TinyFish's absent result-count parameter and applies numSearchResults locally", async () => {
		const captured: { url?: URL; init?: RequestInit } = {};
		const upstreamResults = Array.from({ length: 13 }, (_, index) => ({
			title: `TinyFish result ${index}`,
			url: `https://example.com/${index}`,
			snippet: `Snippet ${index}`,
			site_name: index === 0 ? "Example Site" : undefined,
		}));

		const fetchMock: FetchImpl = async (input, init) => {
			captured.url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			captured.init = init;
			return new Response(JSON.stringify({ results: upstreamResults }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const response = await searchTinyFish({
			...makeParams("fresh fish"),
			numSearchResults: 12,
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

		// TinyFish Search docs expose no result-count parameter; unified counts are applied after the response.
		expectOnlyDocumentedTinyFishParams(capturedUrl, ["query", "recency_minutes"]);

		expect(response.provider).toBe("tinyfish");
		expect(response.authMode).toBe("api_key");
		expect(response.sources).toHaveLength(12);
		expect(response.sources[0]).toEqual({
			title: "TinyFish result 0",
			url: "https://example.com/0",
			snippet: "Snippet 0",
			author: "Example Site",
		});
		expect(response.sources.at(-1)).toEqual({
			title: "TinyFish result 11",
			url: "https://example.com/11",
			snippet: "Snippet 11",
			author: undefined,
		});
		expect(response.sources.some(source => source.url === "https://example.com/12")).toBe(false);
	});

	it("does not serialize unsupported count-like params for the unified limit option", async () => {
		const captured: { url?: URL } = {};
		const upstreamResults = Array.from({ length: 12 }, (_, index) => ({
			title: `TinyFish limit result ${index}`,
			url: `https://example.com/limit-${index}`,
			snippet: `Limit snippet ${index}`,
		}));

		const fetchMock: FetchImpl = async input => {
			captured.url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			return new Response(JSON.stringify({ results: upstreamResults }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const response = await searchTinyFish({
			...makeParams("limit fish"),
			limit: 11,
			fetch: fetchMock,
		});

		const capturedUrl = captured.url;
		if (!capturedUrl) throw new Error("TinyFish request was not captured");
		expect(capturedUrl.searchParams.get("query")).toBe("limit fish");
		// The unified limit option must not invent an upstream TinyFish count parameter.
		expectOnlyDocumentedTinyFishParams(capturedUrl, ["query"]);

		expect(response.sources).toHaveLength(11);
		expect(response.sources.at(-1)?.url).toBe("https://example.com/limit-10");
		expect(response.sources.some(source => source.url === "https://example.com/limit-11")).toBe(false);
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
