import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { PerplexityProvider, searchPerplexity } from "@oh-my-pi/pi-coding-agent/web/search/providers/perplexity";

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

function mockApi(capture: (body: Record<string, unknown>) => void, response: Record<string, unknown>): FetchImpl {
	return async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === API_URL) {
			capture(JSON.parse(init?.body as string));
			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response("not mocked", { status: 500 });
	};
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
		const fetchMock = mockApi(b => (body = b), baseResponse());
		await searchPerplexity({ query: "quic vs tcp", authStorage: apiKeyAuthStorage, fetch: fetchMock });

		expect(body?.num_search_results).toBe(20);
		expect(body?.web_search_options).toMatchObject({ search_type: "pro", search_context_size: "high" });
		expect(body?.return_related_questions).toBe(true);
	});

	it("honors a caller-supplied num_search_results over the default", async () => {
		let body: Record<string, unknown> | undefined;
		const fetchMock = mockApi(b => (body = b), baseResponse());

		await searchPerplexity({
			query: "quic vs tcp",
			authStorage: apiKeyAuthStorage,
			num_search_results: 5,
			fetch: fetchMock,
		});

		expect(body?.num_search_results).toBe(5);
	});

	it("parses related_questions into relatedQuestions, preserving order and dropping blanks", async () => {
		const fetchMock = mockApi(
			() => {},
			baseResponse({ related_questions: ["How does QUIC handle loss?", "  ", "What is 0-RTT?"] }),
		);

		const response = await searchPerplexity({
			query: "quic vs tcp",
			authStorage: apiKeyAuthStorage,
			fetch: fetchMock,
		});

		expect(response.relatedQuestions).toEqual(["How does QUIC handle loss?", "What is 0-RTT?"]);
	});

	it("omits relatedQuestions when the API returns none", async () => {
		const fetchMock = mockApi(() => {}, baseResponse());

		const response = await searchPerplexity({
			query: "quic vs tcp",
			authStorage: apiKeyAuthStorage,
			fetch: fetchMock,
		});

		expect(response.relatedQuestions).toBeUndefined();
	});
});

const OAUTH_ASK_URL = "https://www.perplexity.ai/rest/sse/perplexity_ask";

// OAuth path: getOAuthAccess returns a bearer (no `.`-delimited exp claim, so it
// is treated as non-expiring), making findPerplexityAuth pick the oauth branch.
const oauthAuthStorage = {
	async getOAuthAccess() {
		return { accessToken: "test-oauth-token" };
	},
	hasAuth() {
		return true;
	},
} as unknown as AuthStorage;

const anonymousAuthStorage = {
	async getOAuthAccess() {
		return undefined;
	},
	hasAuth() {
		return false;
	},
} as unknown as AuthStorage;

function mockOAuth(capture: (body: Record<string, unknown>, headers: Headers) => void): FetchImpl {
	const event = {
		final: true,
		display_model: "turbo",
		uuid: "req-oauth",
		blocks: [
			{ intended_usage: "ask_text", markdown_block: { answer: "OAuth answer" } },
			{
				intended_usage: "web_results",
				web_result_block: { web_results: [{ name: "T", url: "https://example.com", snippet: "s" }] },
			},
		],
	};
	const sseBody = `data: ${JSON.stringify(event)}\n\n`;
	return async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === OAUTH_ASK_URL) {
			capture(JSON.parse(init?.body as string), new Headers(init?.headers));
			return new Response(sseBody, { status: 200, headers: { "Content-Type": "text/event-stream" } });
		}
		return new Response("not mocked", { status: 500 });
	};
}

function mockAnonymous(capture: (body: Record<string, unknown>, headers: Headers) => void): FetchImpl {
	const answerPayload = {
		answer: "Anonymous answer",
		web_results: [{ name: "Example", url: "https://example.com", snippet: "s" }],
		chunks: ["Anonymous ", "answer"],
		structured_answer: [{ type: "markdown", text: "Anonymous answer", chunks: ["Anonymous ", "answer"] }],
	};
	const event = {
		final: true,
		display_model: "turbo",
		uuid: "req-anon",
		text: JSON.stringify([{ step_type: "FINAL", content: { answer: JSON.stringify(answerPayload) }, uuid: "" }]),
	};
	const sseBody = `data: ${JSON.stringify(event)}\n\n`;
	return async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url === OAUTH_ASK_URL) {
			capture(JSON.parse(init?.body as string), new Headers(init?.headers));
			return new Response(sseBody, { status: 200, headers: { "Content-Type": "text/event-stream" } });
		}
		return new Response("not mocked", { status: 500 });
	};
}

describe("Perplexity OAuth request shape", () => {
	const savedCookies = process.env.PERPLEXITY_COOKIES;

	beforeEach(() => {
		delete process.env.PERPLEXITY_COOKIES; // cookies take precedence over oauth; keep them out
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedCookies === undefined) delete process.env.PERPLEXITY_COOKIES;
		else process.env.PERPLEXITY_COOKIES = savedCookies;
	});

	it("sends the bare query, never the API-style system prompt, to the ask endpoint", async () => {
		let body: Record<string, unknown> | undefined;
		let headers: Headers | undefined;
		const fetchMock = mockOAuth((b, h) => {
			body = b;
			headers = h;
		});

		const response = await searchPerplexity({
			query: "quic vs tcp",
			system_prompt: "Research assistant with web search. Synthesize comprehensive answers.",
			authStorage: oauthAuthStorage,
			fetch: fetchMock,
		});

		// The consumer ask endpoint has no system slot; prepending the prompt makes
		// the model refuse ("I don't have web-search tools in this turn").
		expect(body?.query_str).toBe("quic vs tcp");
		expect((body?.params as Record<string, unknown>).query_str).toBe("quic vs tcp");
		expect((body?.params as Record<string, unknown>).model_preference).toBe("experimental");
		// The ask endpoint authenticates via the next-auth session cookie; a bearer
		// header is ignored and silently downgrades to the anonymous `turbo` model.
		expect(headers?.get("cookie")).toBe("__Secure-next-auth.session-token=test-oauth-token");
		expect(headers?.has("authorization")).toBe(false);
		expect(response.authMode).toBe("oauth");
		expect(response.answer).toBe("OAuth answer");
	});
});

describe("Perplexity anonymous fallback", () => {
	const savedKey = process.env.PERPLEXITY_API_KEY;
	const savedPplxKey = process.env.PPLX_API_KEY;
	const savedCookies = process.env.PERPLEXITY_COOKIES;

	beforeEach(() => {
		delete process.env.PERPLEXITY_API_KEY;
		delete process.env.PPLX_API_KEY;
		delete process.env.PERPLEXITY_COOKIES;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedKey === undefined) delete process.env.PERPLEXITY_API_KEY;
		else process.env.PERPLEXITY_API_KEY = savedKey;
		if (savedPplxKey === undefined) delete process.env.PPLX_API_KEY;
		else process.env.PPLX_API_KEY = savedPplxKey;
		if (savedCookies === undefined) delete process.env.PERPLEXITY_COOKIES;
		else process.env.PERPLEXITY_COOKIES = savedCookies;
	});

	it("uses the browser ask endpoint without credential headers when no key is configured", async () => {
		let body: Record<string, unknown> | undefined;
		let headers: Headers | undefined;
		const fetchMock = mockAnonymous((b, h) => {
			body = b;
			headers = h;
		});

		const response = await searchPerplexity({
			query: "anonymous search",
			authStorage: anonymousAuthStorage,
			fetch: fetchMock,
		});
		const requestParams = body?.params as Record<string, unknown>;

		expect(headers?.has("authorization")).toBe(false);
		expect(headers?.has("cookie")).toBe(false);
		expect(headers?.get("user-agent")).toContain("Mozilla/5.0");
		expect(requestParams.model_preference).toBe("experimental");
		expect(requestParams.send_back_text_in_streaming_api).toBe(true);
		expect(requestParams.source).toBe("default");
		expect(response.authMode).toBe("anonymous");
		expect(response.answer).toBe("Anonymous answer");
		expect(response.sources).toEqual([
			{
				title: "Example",
				url: "https://example.com",
				snippet: "s",
				publishedDate: undefined,
				ageSeconds: undefined,
			},
		]);
	});

	it("keeps anonymous Perplexity out of auto provider selection but allows explicit selection", () => {
		const provider = new PerplexityProvider();

		expect(provider.isAvailable(anonymousAuthStorage)).toBe(false);
		expect(provider.isExplicitlyAvailable(anonymousAuthStorage)).toBe(true);
	});
});
