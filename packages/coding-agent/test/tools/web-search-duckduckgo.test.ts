import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { searchDuckDuckGo } from "@oh-my-pi/pi-coding-agent/web/search/providers/duckduckgo";
import { SEARCH_PROVIDER_OPTIONS, SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { formatSearchProviderFailures } from "../../src/web/search/provider";

const fakeAuthStorage = {
	async getApiKey() {
		throw new Error("DuckDuckGo must not request API keys");
	},
	resolver() {
		throw new Error("DuckDuckGo must not request credential resolvers");
	},
	hasAuth() {
		throw new Error("DuckDuckGo search must not check auth");
	},
} as unknown as AuthStorage;

function makeParams(query: string, fetch: FetchImpl) {
	return {
		query,
		authStorage: fakeAuthStorage,
		systemPrompt: "DuckDuckGo test prompt",
		fetch,
	} as const;
}

function htmlPage(...results: Array<{ url: string; title: string; snippet?: string }>): string {
	const blocks = results
		.map(r => {
			const href = `//duckduckgo.com/l/?uddg=${encodeURIComponent(r.url)}&amp;rut=abc`;
			const snippet = r.snippet === undefined ? "" : `<a class="result__snippet" href="${href}">${r.snippet}</a>`;
			return `<div class="result results_links results_links_deep web-result">
				<h2 class="result__title"><a rel="nofollow" class="result__a" href="${href}">${r.title}</a></h2>
				${snippet}
			</div>`;
		})
		.join("\n");
	return `<!DOCTYPE html><html><body>${blocks}<div class="nav-link">next</div></body></html>`;
}

function anomalyPage(): string {
	return `<!DOCTYPE html><html><body>
		<form id="challenge-form" action="//duckduckgo.com/anomaly.js?cc=botnet" method="POST">
			<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
		</form>
	</body></html>`;
}

describe("DuckDuckGo web search provider", () => {
	it("POSTs the query and recency filter to the no-JS HTML frontend", async () => {
		const captured: { url?: string } = {};
		let capturedInit: RequestInit | undefined;
		const fetchMock: FetchImpl = (input, init) => {
			captured.url = typeof input === "string" ? input : input.toString();
			capturedInit = init;
			return Promise.resolve(
				new Response(htmlPage({ url: "https://example.com/a", title: "A" }), {
					status: 200,
					headers: { "Content-Type": "text/html" },
				}),
			);
		};

		await searchDuckDuckGo({ ...makeParams("how to fix bug in code", fetchMock), recency: "week" });

		expect(captured.url).toBe("https://html.duckduckgo.com/html/");
		expect(capturedInit?.method).toBe("POST");
		const form = new URLSearchParams(capturedInit?.body as string);
		expect(form.get("q")).toBe("how to fix bug in code");
		expect(form.get("kl")).toBe("us-en");
		expect(form.get("b")).toBe("");
		expect(form.get("df")).toBe("w");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
		expect(headers["User-Agent"]).toContain("Mozilla/5.0");
		expect(headers.Referer).toBe("https://html.duckduckgo.com/");
		expect(headers["Accept-Language"]).toContain("en");
		expect(headers["Sec-Fetch-Mode"]).toBe("navigate");
		expect(headers["Sec-Ch-Ua"]).toContain("Chromium");
	});

	it("omits the df form param when no recency is requested", async () => {
		let capturedInit: RequestInit | undefined;
		const fetchMock: FetchImpl = (_input, init) => {
			capturedInit = init;
			return Promise.resolve(
				new Response(htmlPage({ url: "https://example.com/x", title: "X" }), {
					status: 200,
					headers: { "Content-Type": "text/html" },
				}),
			);
		};

		await searchDuckDuckGo(makeParams("plain query", fetchMock));

		const form = new URLSearchParams(capturedInit?.body as string);
		expect(form.has("df")).toBe(false);
	});

	it("parses result blocks, unwraps DDG redirect URLs, and clamps to numSearchResults", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(
					htmlPage(
						{
							url: "https://example.com/first",
							title: "First &amp; result",
							snippet: "Snippet <b>one</b>",
						},
						{ url: "https://example.com/second", title: "Second" },
						{ url: "https://example.com/third", title: "Third" },
					),
					{ status: 200, headers: { "Content-Type": "text/html" } },
				),
			);

		const response = await searchDuckDuckGo({ ...makeParams("multi", fetchMock), numSearchResults: 2 });

		expect(response.provider).toBe("duckduckgo");
		expect(response.answer).toBeUndefined();
		expect(response.sources).toEqual([
			{
				title: "First & result",
				url: "https://example.com/first",
				snippet: "Snippet one",
			},
			{
				title: "Second",
				url: "https://example.com/second",
				snippet: undefined,
			},
		]);
	});

	it("deduplicates results that share the same target URL", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(
					htmlPage(
						{ url: "https://example.com/dup", title: "First copy", snippet: "one" },
						{ url: "https://example.com/dup", title: "Second copy", snippet: "two" },
						{ url: "https://example.com/unique", title: "Other" },
					),
					{ status: 200, headers: { "Content-Type": "text/html" } },
				),
			);

		const response = await searchDuckDuckGo(makeParams("dup query", fetchMock));

		expect(response.sources.map(s => s.url)).toEqual(["https://example.com/dup", "https://example.com/unique"]);
	});

	it("clamps oversized result limits to the provider maximum", async () => {
		const many = Array.from({ length: 40 }, (_, i) => ({
			url: `https://example.com/r-${i}`,
			title: `Result ${i}`,
		}));
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(htmlPage(...many), {
					status: 200,
					headers: { "Content-Type": "text/html" },
				}),
			);

		const response = await searchDuckDuckGo({ ...makeParams("clamp", fetchMock), numSearchResults: 999 });

		expect(response.sources).toHaveLength(20);
		expect(response.sources.at(0)?.url).toBe("https://example.com/r-0");
		expect(response.sources.at(-1)?.url).toBe("https://example.com/r-19");
	});

	it("supports unwrapped result hrefs (sponsored/instant rows)", async () => {
		const html = `<div class="result"><h2 class="result__title">
			<a class="result__a" href="https://direct.example/page">Direct</a>
		</h2></div>`;
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }));

		const response = await searchDuckDuckGo(makeParams("direct", fetchMock));

		expect(response.sources).toEqual([{ title: "Direct", url: "https://direct.example/page", snippet: undefined }]);
	});

	it("throws a clear SearchProviderError when DDG serves the anomaly modal", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(anomalyPage(), {
					status: 202,
					headers: { "Content-Type": "text/html" },
				}),
			);

		try {
			await searchDuckDuckGo(makeParams("blocked", fetchMock));
			expect.unreachable("DDG anomaly response should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			const err = error as SearchProviderError;
			expect(err.provider).toBe("duckduckgo");
			expect(err.status).toBe(429);
			expect(err.message).toMatch(/bot-detection challenge/i);
			expect(err.message).toContain("datacenter/shared-egress IPs");
			expect(err.message).toContain("configure a credentialed provider");
		}
	});

	it("flags anomaly pages served with a 200 status", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(anomalyPage(), {
					status: 200,
					headers: { "Content-Type": "text/html" },
				}),
			);

		await expect(searchDuckDuckGo(makeParams("blocked-200", fetchMock))).rejects.toMatchObject({
			provider: "duckduckgo",
			status: 429,
		});
	});

	it("throws a provider-tagged SearchProviderError for HTTP failures", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response("upstream unavailable", {
					status: 503,
				}),
			);

		try {
			await searchDuckDuckGo(makeParams("http failure", fetchMock));
			expect.unreachable("DuckDuckGo HTTP failure should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({
				provider: "duckduckgo",
				status: 503,
				message: "DuckDuckGo HTML error (503)",
			});
		}
	});

	it("formats DuckDuckGo bot detection clearly in a fallback-chain failure", () => {
		const message = `All web search providers failed: ${formatSearchProviderFailures([
			{
				provider: { id: "codex", label: "OpenAI" },
				error: new SearchProviderError("codex", "codex: 401 unauthorized", 401),
			},
			{
				provider: { id: "duckduckgo", label: "DuckDuckGo" },
				error: new SearchProviderError(
					"duckduckgo",
					"DuckDuckGo blocked the request with a bot-detection challenge. DuckDuckGo throttles automated HTML searches from datacenter/shared-egress IPs; configure a credentialed provider such as Brave, Tavily, Exa, or Kagi for reliable web search.",
					429,
				),
			},
		])}`;

		expect(message).toContain("All web search providers failed");
		expect(message).toContain("codex: OpenAI authorization failed (401). Check API key or base URL.");
		expect(message).toContain("duckduckgo: DuckDuckGo blocked the request with a bot-detection challenge.");
		expect(message).toContain("datacenter/shared-egress IPs");
		expect(message).toContain("configure a credentialed provider");
		expect(message).not.toContain("codex: 401 unauthorized");
	});

	it("documents DuckDuckGo as a best-effort datacenter-sensitive fallback", () => {
		const option = SEARCH_PROVIDER_OPTIONS.find(item => item.value === "duckduckgo");

		expect(option?.description).toContain("Credential-free best-effort fallback");
		expect(option?.description).toContain("datacenter/shared-egress IPs");
	});
});
