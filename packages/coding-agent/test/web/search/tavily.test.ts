import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import {
	buildRequestBody,
	searchTavily,
	type TavilySearchParams,
} from "@oh-my-pi/pi-coding-agent/web/search/providers/tavily";

describe("Tavily buildRequestBody", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("omits topic entirely so Tavily uses its default general index", () => {
		const body = buildRequestBody({ query: "Bun 1.3 release notes" });
		expect(body).not.toHaveProperty("topic");
	});

	it("does not send time_range when recency is unset", () => {
		const body = buildRequestBody({ query: "Bun 1.3 release notes" });
		expect(body).not.toHaveProperty("time_range");
	});

	it("sends time_range when recency is set, without switching topic to news", () => {
		const body = buildRequestBody({
			query: "Bun 1.3 release notes",
			recency: "week",
		});
		expect(body.time_range).toBe("week");
		expect(body).not.toHaveProperty("topic");
	});

	it.each(["day", "week", "month", "year"] as const)("passes %s through as time_range verbatim", recency => {
		const body = buildRequestBody({ query: "q", recency });
		expect(body.time_range).toBe(recency);
		expect(body).not.toHaveProperty("topic");
	});

	it("always includes query, max_results, search_depth, and include_answer", () => {
		const body = buildRequestBody({ query: "q", num_results: 7 });
		expect(body.query).toBe("q");
		expect(body.max_results).toBe(7);
		expect(body.search_depth).toBe("basic");
		expect(body.include_answer).toBe("advanced");
		expect(body.include_raw_content).toBe(false);
	});
});

describe("Tavily searchTavily request shape (integration)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.TAVILY_API_KEY;
	});

	const fakeAuthStorage = {
		async getApiKey() {
			return process.env.TAVILY_API_KEY ?? undefined;
		},
		resolver: vi.fn(() => async () => process.env.TAVILY_API_KEY ?? undefined),
		hasAuth() {
			return Boolean(process.env.TAVILY_API_KEY);
		},
	} as unknown as AuthStorage;

	function makeParams(query: string, extras: Partial<TavilySearchParams> = {}) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "Tavily integration test prompt",
			...extras,
		};
	}

	it("does not send topic=news to the upstream API when recency is set", async () => {
		process.env.TAVILY_API_KEY = "test-key";

		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url === "https://api.tavily.com/search") {
				capturedBody = JSON.parse(init?.body as string);
				return new Response(
					JSON.stringify({
						answer: "test answer",
						results: [
							{
								title: "Bun v1.3.12",
								url: "https://bun.com/blog/bun-v1.3.12",
								content: "release notes",
								published_date: "2026-04-09",
							},
						],
						request_id: "req-123",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not mocked", { status: 500 });
		};

		const response = await searchTavily({
			...makeParams("Bun runtime latest release notes", { recency: "week" }),
			fetch: fetchMock,
		});

		expect(capturedBody).toBeDefined();
		expect(capturedBody).not.toHaveProperty("topic");
		expect(capturedBody?.time_range).toBe("week");
		expect(capturedBody?.query).toBe("Bun runtime latest release notes");

		expect(response.provider).toBe("tavily");
		expect(response.answer).toBe("test answer");
		expect(response.sources).toHaveLength(1);
		expect(response.sources[0]?.url).toBe("https://bun.com/blog/bun-v1.3.12");
	});

	it("omits time_range entirely when recency is not provided", async () => {
		process.env.TAVILY_API_KEY = "test-key";

		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url === "https://api.tavily.com/search") {
				capturedBody = JSON.parse(init?.body as string);
				return new Response(JSON.stringify({ answer: "", results: [], request_id: "req-0" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not mocked", { status: 500 });
		};

		await searchTavily({ ...makeParams("bun sqlite"), fetch: fetchMock });

		expect(capturedBody).toBeDefined();
		expect(capturedBody).not.toHaveProperty("topic");
		expect(capturedBody).not.toHaveProperty("time_range");
	});
});
