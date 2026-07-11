import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchBing } from "@oh-my-pi/pi-coding-agent/web/search/providers/bing";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

const fakeAuthStorage = {
	async getApiKey() {
		throw new Error("Bing search must not request API keys");
	},
	resolver() {
		throw new Error("Bing search must not request credential resolvers");
	},
	hasAuth() {
		throw new Error("Bing search must not check auth");
	},
} as unknown as AuthStorage;

function makeParams(query: string, fetch: FetchImpl): SearchParams {
	return {
		query,
		authStorage: fakeAuthStorage,
		systemPrompt: "Bing search test prompt",
		fetch,
	};
}

/** Wrap a target URL the way Bing's `/ck/a` click-tracking redirect does (`u=a1<base64url>`). */
function wrapBingHref(target: string): string {
	const payload = Buffer.from(target, "utf-8").toString("base64url");
	return `https://www.bing.com/ck/a?!&&p=6ddfcabc8528ae9bbd50e99e9ccfcb85&ptn=3&ver=2&hsh=4&fclid=2a06eaa3&u=a1${payload}&ntb=1`;
}

/** Render a `b_algo` block matching Bing's live markup (entity-escaped href, sitelink anchor outside `h2`). */
function algoResult(href: string, title: string, snippet?: string): string {
	const escaped = href.replace(/&/g, "&amp;");
	return `<li class="b_algo" data-id iid="SERP.5333">
		<div class="b_tpcn"><a class="tilk" aria-label="site" href="${escaped}"><div class="tptt">sitename</div></a></div>
		<h2 class=""><a target="_blank" href="${escaped}" h="ID=SERP,5144.2">${title}</a></h2>
		${snippet ? `<div class="b_caption"><p class="b_lineclamp2">${snippet}</p></div>` : ""}
	</li>`;
}

function resultsPage(...items: string[]): string {
	return `<html><body><ol id="b_results">${items.join("\n")}</ol></body></html>`;
}

describe("Bing web search provider", () => {
	it("requests the HTML result page with browser navigation headers and recency filter", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const fetchMock: FetchImpl = (input, init) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			capturedInit = init;
			return Promise.resolve(
				new Response(
					resultsPage(algoResult(wrapBingHref("https://example.com/result"), "Result", "Search snippet")),
					{ status: 200, headers: { "Content-Type": "text/html" } },
				),
			);
		};

		const response = await searchBing({
			...makeParams("browser headers & parsing", fetchMock),
			numSearchResults: 99,
			recency: "week",
		});

		const url = new URL(capturedUrl);
		expect(url.origin + url.pathname).toBe("https://www.bing.com/search");
		expect(url.searchParams.get("q")).toBe("browser headers & parsing");
		expect(url.searchParams.get("count")).toBe("20");
		expect(url.searchParams.get("mkt")).toBe("en-US");
		expect(url.searchParams.get("setlang")).toBe("en");
		expect(url.searchParams.get("filters")).toBe('ex1:"ez2"');
		expect(capturedInit?.method).toBeUndefined();
		const headers = new Headers(capturedInit?.headers);
		expect(headers.get("accept")).toContain("text/html");
		expect(headers.get("user-agent")).toMatch(/Chrome\/\d+\.0\.0\.0/);
		expect(headers.get("referer")).toBe("https://www.bing.com/");
		expect(headers.get("sec-fetch-dest")).toBe("document");
		expect(headers.get("sec-fetch-mode")).toBe("navigate");
		expect(headers.get("sec-fetch-site")).toBe("same-origin");
		expect(response.sources).toEqual([
			{ title: "Result", url: "https://example.com/result", snippet: "Search snippet" },
		]);
	});

	it("maps every recency window to Bing's native freshness codes and omits the param otherwise", async () => {
		const filtersFor = async (recency?: SearchParams["recency"]): Promise<string | null> => {
			let captured = "";
			const fetchMock: FetchImpl = input => {
				captured = typeof input === "string" ? input : input.toString();
				return Promise.resolve(new Response(resultsPage(), { status: 200 }));
			};
			await searchBing({ ...makeParams("recency mapping", fetchMock), recency });
			return new URL(captured).searchParams.get("filters");
		};

		expect(await filtersFor("day")).toBe('ex1:"ez1"');
		expect(await filtersFor("month")).toBe('ex1:"ez3"');
		expect(await filtersFor(undefined)).toBeNull();

		// "Past year" has no fixed code; Bing's own dropdown emits an epoch-day range.
		const year = await filtersFor("year");
		const match = year?.match(/^ex1:"ez5_(\d+)_(\d+)"$/);
		expect(match).toBeTruthy();
		const [, start, end] = match as RegExpMatchArray;
		expect(Number(end) - Number(start)).toBe(365);
		expect(Math.abs(Number(end) - Math.floor(Date.now() / 86_400_000))).toBeLessThanOrEqual(1);
	});

	it("unwraps ck/a redirects, keeps direct links, deduplicates targets, and skips junk rows", async () => {
		const target = "https://example.com/docs?a=1&b=2";
		const html = resultsPage(
			algoResult(
				wrapBingHref(target),
				"<strong>Bun</strong> — A fast runtime",
				`<span class="news_dt">Jan 3, 2026</span>&nbsp;&#0183;&#32;Bundle &amp; run JavaScript. How to verify you are human on CAPTCHA walls.`,
			),
			// Direct external href; snippet only in the b_algoSlug fallback container.
			`<li class="b_algo"><h2><a href="https://example.com/direct">Direct result</a></h2><div class="b_algoSlug">Slug snippet</div></li>`,
			algoResult(wrapBingHref(target), "Duplicate target", "duplicate"),
			// Bing-internal navigation link must be dropped.
			algoResult("https://www.bing.com/images/search?q=x", "Images tab"),
			// Unknown u= payload version must be dropped, not garbage-decoded.
			`<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=b2xyz&amp;ntb=1">Future wrapper</a></h2></li>`,
			algoResult(wrapBingHref("https://example.com/bare"), "No snippet row"),
		);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));

		const response = await searchBing({ ...makeParams("mixed markup", fetchMock), numSearchResults: 10 });

		expect(response.provider).toBe("bing");
		expect(response.sources).toEqual([
			{
				title: "Bun — A fast runtime",
				url: target,
				snippet: "Jan 3, 2026 · Bundle & run JavaScript. How to verify you are human on CAPTCHA walls.",
			},
			{ title: "Direct result", url: "https://example.com/direct", snippet: "Slug snippet" },
			{ title: "No snippet row", url: "https://example.com/bare", snippet: undefined },
		]);
	});

	it("returns empty sources for Bing's genuine no-results page", async () => {
		const html = `<html><body><ol id="b_results"><li class="b_no"><h1>There are no results for <strong>xzqv</strong></h1></li></ol></body></html>`;
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));

		const response = await searchBing(makeParams("xzqv", fetchMock));

		expect(response).toEqual({ provider: "bing", sources: [] });
	});

	it("surfaces Bing's CAPTCHA challenge as a provider-tagged 429", async () => {
		const challenge = `<html><body><div id="b_content"><form action="/turing/captcha/challenge" method="post">Please solve the challenge</form></div></body></html>`;
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(challenge, { status: 200 }));

		try {
			await searchBing(makeParams("blocked", fetchMock));
			expect.unreachable("Bing CAPTCHA challenge should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "bing", status: 429 });
			expect((error as SearchProviderError).message).toContain("CAPTCHA");
		}
	});

	it("propagates non-OK HTTP statuses as provider errors", async () => {
		const fetchMock: FetchImpl = () => Promise.resolve(new Response("Service Unavailable", { status: 503 }));

		try {
			await searchBing(makeParams("outage", fetchMock));
			expect.unreachable("HTTP 503 should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({
				provider: "bing",
				status: 503,
				message: "Bing HTML error (503)",
			});
		}
	});
});
