import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { searchPerplexity } from "@oh-my-pi/pi-coding-agent/web/search/providers/perplexity";
import { hookFetch } from "@oh-my-pi/pi-utils";

const API_URL = "https://api.perplexity.ai/chat/completions";

// API-key path only: getOAuthAccess returns undefined so findPerplexityAuth
// falls through to PERPLEXITY_API_KEY (set per-test, restored in afterEach).
const apiKeyAuthStorage = {
	async getOAuthAccess() {
		return undefined;
	},
	hasAuth() {
		return false;
	},
} as unknown as AuthStorage;

function mockApi(capture: (body: Record<string, unknown>) => void, response: Record<string, unknown>) {
	return hookFetch(async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === API_URL) {
			capture(JSON.parse(init?.body as string));
			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response("not mocked", { status: 500 });
	});
}

function baseResponse(extra: Record<string, unknown> = {}) {
	return {
		id: "req-1",
		model: "sonar-pro",
		created: 0,
		choices: [{ index: 0, message: { role: "assistant", content: "answer" }, delta: {} }],
		search_results: [{ title: "T", url: "https://example.com", snippet: "s" }],
		...extra,
	};
}

describe("Perplexity API-key request shape", () => {
	const savedKey = process.env.PERPLEXITY_API_KEY;
	const savedCookies = process.env.PERPLEXITY_COOKIES;

	beforeEach(() => {
		process.env.PERPLEXITY_API_KEY = "test-key";
		delete process.env.PERPLEXITY_COOKIES;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedKey === undefined) delete process.env.PERPLEXITY_API_KEY;
		else process.env.PERPLEXITY_API_KEY = savedKey;
		if (savedCookies === undefined) delete process.env.PERPLEXITY_COOKIES;
		else process.env.PERPLEXITY_COOKIES = savedCookies;
	});

	it("requests comprehensive defaults: 20 results, high context, related questions", async () => {
		let body: Record<string, unknown> | undefined;
		using _hook = mockApi(b => (body = b), baseResponse());

		await searchPerplexity({ query: "quic vs tcp", authStorage: apiKeyAuthStorage });

		expect(body?.num_search_results).toBe(20);
		expect(body?.web_search_options).toMatchObject({ search_type: "pro", search_context_size: "high" });
		expect(body?.return_related_questions).toBe(true);
	});

	it("honors a caller-supplied num_search_results over the default", async () => {
		let body: Record<string, unknown> | undefined;
		using _hook = mockApi(b => (body = b), baseResponse());

		await searchPerplexity({ query: "quic vs tcp", authStorage: apiKeyAuthStorage, num_search_results: 5 });

		expect(body?.num_search_results).toBe(5);
	});

	it("parses related_questions into relatedQuestions, preserving order and dropping blanks", async () => {
		using _hook = mockApi(
			() => {},
			baseResponse({ related_questions: ["How does QUIC handle loss?", "  ", "What is 0-RTT?"] }),
		);

		const response = await searchPerplexity({ query: "quic vs tcp", authStorage: apiKeyAuthStorage });

		expect(response.relatedQuestions).toEqual(["How does QUIC handle loss?", "What is 0-RTT?"]);
	});

	it("omits relatedQuestions when the API returns none", async () => {
		using _hook = mockApi(() => {}, baseResponse());

		const response = await searchPerplexity({ query: "quic vs tcp", authStorage: apiKeyAuthStorage });

		expect(response.relatedQuestions).toBeUndefined();
	});
});
