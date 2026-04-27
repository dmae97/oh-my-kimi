import { afterEach, describe, expect, it, vi } from "bun:test";
import { hookFetch } from "@oh-my-pi/pi-utils";
import { searchSearXNG } from "../../src/web/search/providers/searxng";

describe("SearXNG web search provider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.SEARXNG_ENDPOINT;
		delete process.env.SEARXNG_TOKEN;
		delete process.env.SEARXNG_BASIC_USERNAME;
		delete process.env.SEARXNG_BASIC_PASSWORD;
	});

	it("sends RFC 7617 Basic auth when username and password are configured", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org/";
		process.env.SEARXNG_BASIC_USERNAME = "alice";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		const captured: { url?: URL; headers?: Headers } = {};
		using _hook = hookFetch((input, init) => {
			captured.url = new URL(input.toString());
			captured.headers = new Headers(init?.headers);
			return new Response(
				JSON.stringify({
					results: [{ title: "SearXNG", url: "https://example.com/result", content: "Metasearch result" }],
					suggestions: ["related search"],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const response = await searchSearXNG({ query: "private search", num_results: 1, recency: "week" });

		expect(captured.url?.origin).toBe("https://searx.example.org");
		expect(captured.url?.pathname).toBe("/search");
		expect(captured.url?.searchParams.get("q")).toBe("private search");
		expect(captured.url?.searchParams.get("format")).toBe("json");
		expect(captured.url?.searchParams.get("time_range")).toBe("month");
		expect(captured.headers?.get("Authorization")).toBe(
			`Basic ${Buffer.from("alice:s3cret", "utf-8").toString("base64")}`,
		);
		expect(response).toMatchObject({
			provider: "searxng",
			relatedQuestions: ["related search"],
			sources: [{ title: "SearXNG", url: "https://example.com/result", snippet: "Metasearch result" }],
		});
	});

	it("prefers Basic auth over bearer token when both are configured", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_TOKEN = "bearer-token";
		process.env.SEARXNG_BASIC_USERNAME = "alice";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		const captured: { headers?: Headers } = {};
		using _hook = hookFetch((_input, init) => {
			captured.headers = new Headers(init?.headers);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await searchSearXNG({ query: "auth precedence" });

		expect(captured.headers?.get("Authorization")).toBe(
			`Basic ${Buffer.from("alice:s3cret", "utf-8").toString("base64")}`,
		);
	});

	it("sends Basic auth when the password is intentionally empty", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_USERNAME = "alice";
		process.env.SEARXNG_BASIC_PASSWORD = "";

		const captured: { headers?: Headers } = {};
		using _hook = hookFetch((_input, init) => {
			captured.headers = new Headers(init?.headers);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await searchSearXNG({ query: "empty password" });

		expect(captured.headers?.get("Authorization")).toBe(`Basic ${Buffer.from("alice:", "utf-8").toString("base64")}`);
	});

	it("sends Basic auth when the username is intentionally empty", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_USERNAME = "";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		const captured: { headers?: Headers } = {};
		using _hook = hookFetch((_input, init) => {
			captured.headers = new Headers(init?.headers);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await searchSearXNG({ query: "empty username" });

		expect(captured.headers?.get("Authorization")).toBe(
			`Basic ${Buffer.from(":s3cret", "utf-8").toString("base64")}`,
		);
	});

	it("requires both Basic auth username and password", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_USERNAME = "alice";

		await expect(searchSearXNG({ query: "missing password" })).rejects.toThrow(
			"SearXNG Basic auth requires both searxng.basicUsername and searxng.basicPassword",
		);
	});

	it("requires a Basic auth username when only password is configured", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		await expect(searchSearXNG({ query: "missing username" })).rejects.toThrow(
			"SearXNG Basic auth requires both searxng.basicUsername and searxng.basicPassword",
		);
	});

	it("rejects Basic auth usernames containing a colon", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_BASIC_USERNAME = "alice:admin";
		process.env.SEARXNG_BASIC_PASSWORD = "s3cret";

		await expect(searchSearXNG({ query: "invalid username" })).rejects.toThrow(
			"SearXNG Basic auth username cannot contain ':'",
		);
	});

	it("keeps bearer token authentication when Basic auth is not configured", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
		process.env.SEARXNG_TOKEN = "bearer-token";

		const captured: { headers?: Headers } = {};
		using _hook = hookFetch((_input, init) => {
			captured.headers = new Headers(init?.headers);
			return new Response(JSON.stringify({ results: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		await searchSearXNG({ query: "bearer search" });

		expect(captured.headers?.get("Authorization")).toBe("Bearer bearer-token");
	});
});
