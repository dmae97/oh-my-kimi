import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchStartpage } from "@oh-my-pi/pi-coding-agent/web/search/providers/startpage";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

const fakeAuthStorage = {
	async getApiKey() {
		throw new Error("Startpage search must not request API keys");
	},
	resolver() {
		throw new Error("Startpage search must not request credential resolvers");
	},
	hasAuth() {
		throw new Error("Startpage search must not check auth");
	},
} as unknown as AuthStorage;

function makeParams(query: string, fetch: FetchImpl): SearchParams {
	return {
		query,
		authStorage: fakeAuthStorage,
		systemPrompt: "Startpage search test prompt",
		fetch,
	};
}

const SC_TOKEN = "2sbbv9IndMZLVHNdHqjDurhVAo8vrQSiu3q8EtaSRZMbFzmQ0Qt1";

/** Homepage shell trimmed from a live capture: the `/sp/search` form with its hidden inputs. */
function homepageHtml(sc: string): string {
	return `<!DOCTYPE html><html><body>
	<form action="/sp/search" method="post" class="search-form-form" id="search" data-testid="search" role="search">
		<input class="abp" id="abp-input" type="hidden" name="abp" value="0"/>
		<input class="abe" id="abe-input" type="hidden" name="abe" value="0"/>
		<input type="hidden" name="lui" value="english"/>
		<input type="hidden" name="language" value="english"/>
		<input type="hidden" name="sc" value="${sc}"/>
		<input type="hidden" name="t" value="device"/>
		<input type="hidden" name="cat" value="home"/>
		<input type="hidden" name="segment" value="startpage.udog"/>
		<input type="hidden" name="abd" value="0"/>
		<input autocomplete="off" id="q" name="query" type="text" value=""/>
	</form>
	</body></html>`;
}

/** Organic result block trimmed from a live capture. */
function resultHtml(url: string, title: string, snippet?: string): string {
	return `<div class="result css-o7i03b">
		<div class="upper css-4wnopv">
			<a href="${url}" rel="noopener nofollow" class="favicon-link css-n7c8hp"><div class="favicon-container"></div></a>
			<div class="wgl-title-link-container css-1gz2b5f">
				<a href="${url}" rel="noopener nofollow" class="wgl-site-title css-1d1wvpc"><span class="link-text">Site</span></a>
			</div>
		</div>
		<a class="result-title result-link css-1bggj8v" href="${url}" target="_blank" rel="noopener nofollow noreferrer" data-testid="gl-title-link">
			<h2 class="wgl-title css-i3irj7">${title}</h2>
		</a>
		${snippet ? `<p class="description css-1507v2l">${snippet}</p>` : ""}
	</div>`;
}

function resultsPage(...blocks: string[]): string {
	return `<!DOCTYPE html><html><head><title>Startpage Search Results</title></head><body>
	<div class="w-gl">${blocks.join("\n")}</div>
	<div class="a-bg-result AdSense TextAd adBox css-i7d1s0"></div>
	</body></html>`;
}

/** CAPTCHA/error SPA shell trimmed from a live `/en/errors/` capture. */
const CHALLENGE_HTML = `<!DOCTYPE html><html><head><script>window.___chunkMapping={"component---src-pages-captcha-block-js":["/component---src-pages-captcha-block-js-c032045456f5fea25a2f.js"],"component---src-pages-captcha-js":["/component---src-pages-captcha-js-e7f56b04aa0a0bc67713.js"]}</script></head><body><div id="___gatsby"></div></body></html>`;

interface CapturedRequest {
	url: string;
	init: RequestInit | undefined;
}

/** Dispatch mocked responses by URL; records every request for assertions. */
function dispatchFetch(routes: Record<string, () => Response>, captured: CapturedRequest[]): FetchImpl {
	return (input, init) => {
		const url = typeof input === "string" ? input : input.toString();
		captured.push({ url, init });
		const pathname = new URL(url).pathname;
		const route = routes[pathname];
		if (!route) throw new Error(`Unexpected request: ${url}`);
		return Promise.resolve(route());
	};
}

describe("Startpage web search provider", () => {
	it("performs the homepage-token dance: GET home, then POST the form inputs with query and recency", async () => {
		const captured: CapturedRequest[] = [];
		const fetchMock = dispatchFetch(
			{
				"/": () => new Response(homepageHtml(SC_TOKEN), { status: 200 }),
				"/sp/search": () =>
					new Response(resultsPage(resultHtml("https://example.com/result", "Result", "Search snippet")), {
						status: 200,
					}),
			},
			captured,
		);

		const response = await searchStartpage({
			...makeParams("browser headers & parsing", fetchMock),
			numSearchResults: 99,
			recency: "week",
		});

		expect(captured.map(r => r.url)).toEqual(["https://www.startpage.com/", "https://www.startpage.com/sp/search"]);

		const homeInit = captured[0].init;
		expect(homeInit?.method).toBeUndefined();
		const homeHeaders = new Headers(homeInit?.headers);
		expect(homeHeaders.get("accept")).toContain("text/html");
		expect(homeHeaders.get("user-agent")).toMatch(/Chrome\/\d+\.0\.0\.0/);
		expect(homeHeaders.get("sec-fetch-site")).toBe("none");

		const searchInit = captured[1].init;
		expect(searchInit?.method).toBe("POST");
		const searchHeaders = new Headers(searchInit?.headers);
		expect(searchHeaders.get("content-type")).toBe("application/x-www-form-urlencoded");
		expect(searchHeaders.get("referer")).toBe("https://www.startpage.com/");
		expect(searchHeaders.get("sec-fetch-site")).toBe("same-origin");
		expect(searchHeaders.get("sec-fetch-dest")).toBe("document");
		expect(searchHeaders.get("user-agent")).toMatch(/Chrome\/\d+\.0\.0\.0/);

		const form = new URLSearchParams(String(searchInit?.body));
		expect(form.get("query")).toBe("browser headers & parsing");
		expect(form.get("sc")).toBe(SC_TOKEN);
		expect(form.get("with_date")).toBe("w");
		expect(form.get("cat")).toBe("home");
		expect(form.get("segment")).toBe("startpage.udog");
		expect(form.get("abp")).toBe("0");
		expect(form.get("lui")).toBe("english");

		expect(response.provider).toBe("startpage");
		expect(response.sources).toEqual([
			{ title: "Result", url: "https://example.com/result", snippet: "Search snippet" },
		]);
	});

	it("parses result blocks, skips junk rows, deduplicates targets, and clamps to the requested count", async () => {
		const html = resultsPage(
			resultHtml("https://example.com/a", "First &amp; <b>best</b> result", "A <b>useful</b>\n\tsnippet"),
			resultHtml("https://example.com/a", "Duplicate of first", "duplicate"),
			`<div class="result css-o7i03b"><p class="description">No title anchor: instant-answer widget</p></div>`,
			resultHtml("https://www.startpage.com/en/privacy", "Internal Startpage link", "never a result"),
			resultHtml("javascript:void(0)", "Bad scheme", "never a result"),
			resultHtml("https://example.com/b", "Second result"),
			resultHtml("https://example.com/c", "Third result", "clamped away"),
		);
		const captured: CapturedRequest[] = [];
		const fetchMock = dispatchFetch(
			{
				"/": () => new Response(homepageHtml(SC_TOKEN), { status: 200 }),
				"/sp/search": () => new Response(html, { status: 200 }),
			},
			captured,
		);

		const response = await searchStartpage({ ...makeParams("mixed markup", fetchMock), numSearchResults: 2 });

		expect(response.sources).toEqual([
			{ title: "First & best result", url: "https://example.com/a", snippet: "A useful snippet" },
			{ title: "Second result", url: "https://example.com/b", snippet: undefined },
		]);
	});

	it("falls back to a direct GET with query params when the homepage yields no sc token", async () => {
		const captured: CapturedRequest[] = [];
		const fetchMock = dispatchFetch(
			{
				"/": () => new Response("<html><body>redesigned homepage without the form</body></html>", { status: 200 }),
				"/sp/search": () =>
					new Response(resultsPage(resultHtml("https://example.com/fallback", "Fallback", "via GET")), {
						status: 200,
					}),
			},
			captured,
		);

		const response = await searchStartpage({ ...makeParams("fallback query", fetchMock), recency: "month" });

		expect(captured).toHaveLength(2);
		const searchUrl = new URL(captured[1].url);
		expect(searchUrl.origin + searchUrl.pathname).toBe("https://www.startpage.com/sp/search");
		expect(searchUrl.searchParams.get("query")).toBe("fallback query");
		expect(searchUrl.searchParams.get("with_date")).toBe("m");
		expect(captured[1].init?.method).toBeUndefined();
		const headers = new Headers(captured[1].init?.headers);
		expect(headers.get("referer")).toBe("https://www.startpage.com/");
		expect(headers.get("sec-fetch-site")).toBe("same-origin");
		expect(response.sources).toEqual([
			{ title: "Fallback", url: "https://example.com/fallback", snippet: "via GET" },
		]);
	});

	it("surfaces the CAPTCHA/error shell as a provider-tagged 429", async () => {
		const captured: CapturedRequest[] = [];
		const fetchMock = dispatchFetch(
			{
				"/": () => new Response(homepageHtml(SC_TOKEN), { status: 200 }),
				"/sp/search": () => new Response(CHALLENGE_HTML, { status: 200 }),
			},
			captured,
		);

		try {
			await searchStartpage(makeParams("blocked", fetchMock));
			expect.unreachable("Startpage CAPTCHA shell should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "startpage", status: 429 });
			expect((error as SearchProviderError).message).toContain("Startpage");
			expect((error as SearchProviderError).message).toContain("CAPTCHA");
		}
	});

	it("maps non-OK search responses to a status-tagged provider error", async () => {
		const captured: CapturedRequest[] = [];
		const fetchMock = dispatchFetch(
			{
				"/": () => new Response(homepageHtml(SC_TOKEN), { status: 200 }),
				"/sp/search": () => new Response("upstream exploded", { status: 500 }),
			},
			captured,
		);

		try {
			await searchStartpage(makeParams("server error", fetchMock));
			expect.unreachable("HTTP 500 should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({
				provider: "startpage",
				status: 500,
				message: "Startpage HTML error (500)",
			});
		}
	});
});
