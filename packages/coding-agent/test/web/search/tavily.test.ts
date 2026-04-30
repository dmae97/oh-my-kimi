import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	buildRequestBody,
	searchTavily,
	type TavilySearchParams,
} from "@oh-my-pi/pi-coding-agent/web/search/providers/tavily";
import { hookFetch } from "@oh-my-pi/pi-utils";

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

	it("does not send topic=news to the upstream API when recency is set", async () => {
		process.env.TAVILY_API_KEY = "test-key";

		let capturedBody: Record<string, unknown> | undefined;
		using _hook = hookFetch(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
		});

		const params: TavilySearchParams = {
			query: "Bun runtime latest release notes",
			recency: "week",
		};
		const response = await searchTavily(params);

		expect(capturedBody).toBeDefined();
		// The core regression: recency must not coerce topic to news. Topic should
		// be absent entirely (Tavily defaults to "general").
		expect(capturedBody).not.toHaveProperty("topic");
		expect(capturedBody?.time_range).toBe("week");
		expect(capturedBody?.query).toBe("Bun runtime latest release notes");

		// And the response should still be parsed correctly end-to-end.
		expect(response.provider).toBe("tavily");
		expect(response.answer).toBe("test answer");
		expect(response.sources).toHaveLength(1);
		expect(response.sources[0]?.url).toBe("https://bun.com/blog/bun-v1.3.12");
	});

	it("omits time_range entirely when recency is not provided", async () => {
		process.env.TAVILY_API_KEY = "test-key";

		let capturedBody: Record<string, unknown> | undefined;
		using _hook = hookFetch(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === "https://api.tavily.com/search") {
				capturedBody = JSON.parse(init?.body as string);
				return new Response(JSON.stringify({ answer: "", results: [], request_id: "req-0" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not mocked", { status: 500 });
		});

		await searchTavily({ query: "bun sqlite" });

		expect(capturedBody).toBeDefined();
		expect(capturedBody).not.toHaveProperty("topic");
		expect(capturedBody).not.toHaveProperty("time_range");
	});
});
