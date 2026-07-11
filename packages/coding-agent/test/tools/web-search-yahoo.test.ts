import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchYahoo } from "@oh-my-pi/pi-coding-agent/web/search/providers/yahoo";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

const fakeAuthStorage = {
	async getApiKey() {
		throw new Error("Yahoo search must not request API keys");
	},
	resolver() {
		throw new Error("Yahoo search must not request credential resolvers");
	},
	hasAuth() {
		throw new Error("Yahoo search must not check auth");
	},
} as unknown as AuthStorage;

function makeParams(query: string, fetch: FetchImpl): SearchParams {
	return {
		query,
		authStorage: fakeAuthStorage,
		systemPrompt: "Yahoo search test prompt",
		fetch,
	};
}

/** Current Yahoo layout: tracker `<a>` wraps a breadcrumb div plus the `<h3>`. */
function wrappedResult(target: string, title: string, snippet?: string): string {
	const ru = encodeURIComponent(target);
	return `<li><div class="dd fst algo algo-sr relsrch Sr">
		<div class="compTitle options-toggle">
			<a class="d-ib va-top mt-38" target="_blank" referrerpolicy="origin"
				href="https://r.search.yahoo.com/_ylt=AwrhdoiWxVFqIgIAkOZXNyoA;_ylu=Y29sbwNiZjEEcG9zAzEEdnRpZAMEc2VjA3Ny/RV=2/RE=1784953495/RO=10/RU=${ru}/RK=2/RS=1dfICaVjkaq9kJKB4hyLzeIDF4o-">
				<div class="d-ib p-abs t-0 l-0"><span><span class="fc-141414 d-b">Breadcrumb</span>https://breadcrumb.example</span></div>
				<h3 style="display:block" class="title fc-2015C2-imp"><span class="d-b fz-20">${title}</span></h3>
			</a>
		</div>
		${snippet ? `<div class="compText aAbs"><p class="fc-dustygray fz-14">${snippet}</p></div>` : ""}
	</div></li>`;
}

function serp(body: string): string {
	return `<html><body><div id="web" class="web-res"><h2 class="off-left">Search Results</h2>
		<ol class="reg searchCenterMiddle">${body}</ol></div></body></html>`;
}

describe("Yahoo web search provider", () => {
	it("requests the HTML result page with browser navigation headers, count, and recency", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const fetchMock: FetchImpl = (input, init) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			capturedInit = init;
			return Promise.resolve(
				new Response(serp(wrappedResult("https://example.com/result", "Result", "Search snippet")), {
					status: 200,
					headers: { "Content-Type": "text/html" },
				}),
			);
		};

		const response = await searchYahoo({
			...makeParams("browser headers & parsing", fetchMock),
			numSearchResults: 99,
			recency: "week",
		});

		const url = new URL(capturedUrl);
		expect(url.origin + url.pathname).toBe("https://search.yahoo.com/search");
		expect(url.searchParams.get("p")).toBe("browser headers & parsing");
		expect(url.searchParams.get("n")).toBe("20");
		expect(url.searchParams.get("btf")).toBe("w");
		expect(capturedInit?.method).toBeUndefined();
		const headers = new Headers(capturedInit?.headers);
		expect(headers.get("accept")).toContain("text/html");
		expect(headers.get("user-agent")).toMatch(/Chrome\/\d+\.0\.0\.0/);
		expect(headers.get("referer")).toBe("https://search.yahoo.com/");
		expect(headers.get("sec-fetch-dest")).toBe("document");
		expect(headers.get("sec-fetch-mode")).toBe("navigate");
		expect(headers.get("sec-fetch-site")).toBe("same-origin");
		expect(response.sources).toEqual([
			{ title: "Result", url: "https://example.com/result", snippet: "Search snippet" },
		]);
	});

	it("maps day and month recency to btf and silently drops the unsupported year filter", async () => {
		const captured: string[] = [];
		const fetchMock: FetchImpl = input => {
			captured.push(typeof input === "string" ? input : input.toString());
			return Promise.resolve(new Response(serp(""), { status: 200 }));
		};

		await searchYahoo({ ...makeParams("q", fetchMock), recency: "day" });
		await searchYahoo({ ...makeParams("q", fetchMock), recency: "month" });
		await searchYahoo({ ...makeParams("q", fetchMock), recency: "year" });
		await searchYahoo(makeParams("q", fetchMock));

		expect(new URL(captured[0]).searchParams.get("btf")).toBe("d");
		expect(new URL(captured[1]).searchParams.get("btf")).toBe("m");
		expect(new URL(captured[2]).searchParams.get("btf")).toBeNull();
		expect(new URL(captured[2]).searchParams.get("p")).toBe("q");
		expect(new URL(captured[3]).searchParams.get("btf")).toBeNull();
	});

	it("unwraps /RU= tracker links, handles legacy plain hrefs, deduplicates, and skips junk rows", async () => {
		const target = "https://example.com/page?a=1&b=2";
		const html = serp(
			[
				wrappedResult(
					"https://bun.sh/",
					"Bun &mdash; A fast all-in-one <b>JavaScript</b> runtime",
					'<span class="fc-smoke">Jan 3, 2010 · </span>  Bundle, install, and run <b>JavaScript</b> &amp; TypeScript.',
				),
				// Legacy layout: anchor nested inside the h3, plain unwrapped href.
				`<li><div class="dd algo"><div class="compTitle"><h3 class="title"><a class="ac-algo" href="${target.replace("&", "&amp;")}">Legacy result</a></h3></div><div class="compText"><p>Legacy snippet</p></div></div></li>`,
				// Same target again: must deduplicate.
				wrappedResult(target, "Duplicate target", "duplicate"),
				// Tracker link without a recoverable /RU= segment: skipped.
				`<li><div class="dd algo"><div class="compTitle"><a href="https://r.search.yahoo.com/_ylt=broken/RO=10/RK=2"><h3 class="title">Tracker residue</h3></a></div></div></li>`,
				// Internal navigation resolves to search.yahoo.com: skipped.
				`<li><div class="dd algo"><div class="compTitle"><a href="/search?p=related"><h3 class="title">Related search</h3></a></div></div></li>`,
				// Module header h3 outside any .algo block: never considered.
				`<li><h3 class="s-header mb-12">Videos</h3></li>`,
			].join("\n"),
		);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));

		const response = await searchYahoo({ ...makeParams("mixed markup", fetchMock), numSearchResults: 10 });

		expect(response.provider).toBe("yahoo");
		expect(response.sources).toEqual([
			{
				title: "Bun — A fast all-in-one JavaScript runtime",
				url: "https://bun.sh/",
				snippet: "Jan 3, 2010 · Bundle, install, and run JavaScript & TypeScript.",
			},
			{
				title: "Legacy result",
				url: target,
				snippet: "Legacy snippet",
			},
		]);
	});

	it("clamps the parsed results to the requested count", async () => {
		const html = serp(
			Array.from({ length: 5 }, (_, i) =>
				wrappedResult(`https://example.com/${i}`, `Result ${i}`, `snippet ${i}`),
			).join("\n"),
		);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));

		const response = await searchYahoo({ ...makeParams("clamp", fetchMock), numSearchResults: 2 });

		expect(response.sources.map(s => s.url)).toEqual(["https://example.com/0", "https://example.com/1"]);
	});

	it("surfaces the GDPR consent interstitial as a provider-tagged 429", async () => {
		const consent = `<html><body><div id="consent-page"><form method="post" action="https://consent.yahoo.com/v2/collectConsent?sessionId=3_cc-session_abc"><button type="submit" name="agree" value="agree">Accept all</button></form></div></body></html>`;
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(consent, { status: 200 }));

		try {
			await searchYahoo(makeParams("blocked", fetchMock));
			expect.unreachable("Yahoo consent interstitial should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "yahoo", status: 429 });
			expect((error as SearchProviderError).message).toContain("consent");
		}
	});

	it("maps non-OK HTTP responses to a provider-tagged error with the upstream status", async () => {
		const fetchMock: FetchImpl = () => Promise.resolve(new Response("upstream broke", { status: 503 }));

		try {
			await searchYahoo(makeParams("unavailable", fetchMock));
			expect.unreachable("HTTP 503 should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({
				provider: "yahoo",
				status: 503,
				message: "Yahoo HTML error (503)",
			});
		}
	});
});
