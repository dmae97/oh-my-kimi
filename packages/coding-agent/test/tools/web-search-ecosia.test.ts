import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchEcosia } from "@oh-my-pi/pi-coding-agent/web/search/providers/ecosia";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

const fakeAuthStorage = {
	async getApiKey() {
		throw new Error("Ecosia search must not request API keys");
	},
	resolver() {
		throw new Error("Ecosia search must not request credential resolvers");
	},
	hasAuth() {
		throw new Error("Ecosia search must not check auth");
	},
} as unknown as AuthStorage;

function makeParams(query: string, fetch: FetchImpl): SearchParams {
	return {
		query,
		authStorage: fakeAuthStorage,
		systemPrompt: "Ecosia search test prompt",
		fetch,
	};
}

/**
 * Trimmed organic result matching Ecosia's server-rendered markup: two
 * `result-link` anchors per article (breadcrumb row + title row) and a
 * description container that mixes a screen-reader thumbnail caption with
 * the real `web-result-description` paragraph.
 */
function organicResult(url: string, title: string, snippet?: string): string {
	return `<div data-test-id="mainline-result-web" class="mainline__result-wrapper">
	<article data-test-id="organic-result" class="result web-result mainline__result">
		<div class="result__body">
			<div class="result__header">
				<div class="result__info result__info--extended">
					<a data-test-id="result-link" tabindex="-1" href="${url}"><div data-test-id="result-source"><span class="result-info__domain">domain</span></div></a>
				</div>
				<div class="result__title">
					<a data-test-id="result-link" href="${url}" class="result__link"><h2 data-test-id="result-title" class="result-title__heading"> ${title} </h2></a>
				</div>
			</div>
			${
				snippet
					? `<div class="result__columns"><div data-test-id="result-description" class="result__description">
				<a href="${url}" class="video-thumbnail"><span class="sr-only">Thumbnail for “${title}”</span></a>
				<p data-test-id="web-result-description" class="web-result__description"> ${snippet} </p>
			</div></div>`
					: ""
			}
		</div>
	</article>
</div>`;
}

/** Trimmed Cloudflare managed-challenge page as served by Ecosia's firewall. */
const CLOUDFLARE_CHALLENGE = `<!doctype html><html><head><title>Ecosia Firewall</title></head><body><main>
<h1>Confirm you’re not a robot</h1>
<p>Our system has detected unusual traffic from your network. Please solve the challenge below to show you’re not a robot.</p>
<script>(function(){window._cf_chl_opt = {cFPWv: 'g',cType: 'managed'};var a = document.createElement('script');a.src = '/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=test';})();</script>
</main></body></html>`;

describe("Ecosia web search provider", () => {
	it("requests the results page with browser navigation headers and ignores recency", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const fetchMock: FetchImpl = (input, init) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			capturedInit = init;
			return Promise.resolve(
				new Response(organicResult("https://example.com/result", "Result", "Search snippet"), {
					status: 200,
					headers: { "Content-Type": "text/html" },
				}),
			);
		};

		const response = await searchEcosia({
			...makeParams("browser headers & parsing", fetchMock),
			numSearchResults: 99,
			recency: "week",
		});

		const url = new URL(capturedUrl);
		expect(url.origin + url.pathname).toBe("https://www.ecosia.org/search");
		expect(url.searchParams.get("q")).toBe("browser headers & parsing");
		// Ecosia has no confirmed time filter; recency must not leak into the request.
		expect([...url.searchParams.keys()]).toEqual(["q"]);
		expect(capturedInit?.method).toBeUndefined();
		const headers = new Headers(capturedInit?.headers);
		expect(headers.get("accept")).toContain("text/html");
		expect(headers.get("user-agent")).toMatch(/Chrome\/\d+\.0\.0\.0/);
		expect(headers.get("referer")).toBe("https://www.ecosia.org/");
		expect(headers.get("sec-fetch-dest")).toBe("document");
		expect(headers.get("sec-fetch-mode")).toBe("navigate");
		expect(headers.get("sec-fetch-site")).toBe("same-origin");
		expect(response.sources).toEqual([
			{ title: "Result", url: "https://example.com/result", snippet: "Search snippet" },
		]);
	});

	it("parses organic articles, skips junk rows, and deduplicates targets", async () => {
		const html = [
			organicResult("https://example.com/first", "First &amp; <em>decoded</em>", "Leading snippet"),
			// Ad slot: rendered client-side into an empty container, never an organic article.
			`<div data-test-id="mainline-result-ad" class="mainline__result-wrapper"><div id="ad-google-1" data-test-id="ad-google"></div></div>`,
			// Internal navigation and non-http targets must be rejected.
			organicResult("https://www.ecosia.org/images?q=first", "Images vertical", "internal"),
			organicResult("javascript:void(0)", "Script link", "junk"),
			// Article without a title heading is skipped.
			`<article data-test-id="organic-result"><div class="result__title"><a data-test-id="result-link" href="https://example.com/untitled"></a></div></article>`,
			organicResult("https://example.com/first", "Duplicate of first", "duplicate"),
			organicResult("https://example.com/bare", "Snippetless result"),
		].join("\n");
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));

		const response = await searchEcosia({ ...makeParams("mixed markup", fetchMock), numSearchResults: 10 });

		expect(response.provider).toBe("ecosia");
		expect(response.sources).toEqual([
			{ title: "First & decoded", url: "https://example.com/first", snippet: "Leading snippet" },
			{ title: "Snippetless result", url: "https://example.com/bare", snippet: undefined },
		]);
	});

	it("clamps sources to the requested count", async () => {
		const html = [
			organicResult("https://example.com/1", "One", "s1"),
			organicResult("https://example.com/2", "Two", "s2"),
			organicResult("https://example.com/3", "Three", "s3"),
		].join("\n");
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));

		const response = await searchEcosia({ ...makeParams("clamped", fetchMock), numSearchResults: 2 });

		expect(response.sources.map(source => source.url)).toEqual(["https://example.com/1", "https://example.com/2"]);
	});

	it("surfaces the Cloudflare challenge as a provider-tagged 429, regardless of HTTP status", async () => {
		for (const status of [403, 200]) {
			const fetchMock: FetchImpl = () => Promise.resolve(new Response(CLOUDFLARE_CHALLENGE, { status }));
			try {
				await searchEcosia(makeParams("blocked", fetchMock));
				expect.unreachable(`Cloudflare challenge with status ${status} should reject`);
			} catch (error) {
				expect(error).toBeInstanceOf(SearchProviderError);
				expect(error).toMatchObject({ provider: "ecosia", status: 429 });
				expect((error as SearchProviderError).message).toContain("Cloudflare bot challenge");
			}
		}
	});

	it("maps non-challenge HTTP failures to a provider-tagged error with the upstream status", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response("<html><body>Internal Server Error</body></html>", { status: 500 }));

		try {
			await searchEcosia(makeParams("broken", fetchMock));
			expect.unreachable("HTTP 500 should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({
				provider: "ecosia",
				status: 500,
				message: "Ecosia HTML error (500)",
			});
		}
	});
});
