import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchGoogle } from "@oh-my-pi/pi-coding-agent/web/search/providers/google";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

const fakeAuthStorage = {
	async getApiKey() {
		throw new Error("Google search must not request API keys");
	},
	resolver() {
		throw new Error("Google search must not request credential resolvers");
	},
	hasAuth() {
		throw new Error("Google search must not check auth");
	},
} as unknown as AuthStorage;

function makeParams(query: string, fetch: FetchImpl): SearchParams {
	return {
		query,
		authStorage: fakeAuthStorage,
		systemPrompt: "Google search test prompt",
		fetch,
	};
}

function modernResult(url: string, title: string, snippet?: string): string {
	return `<div class="MjjYud"><div class="tF2Cxc">
		<a href="${url}"><h3>${title}</h3></a>
		${snippet ? `<div data-sncf="1"><div class="VwiC3b">${snippet}</div></div>` : ""}
	</div></div>`;
}

describe("Google web search provider", () => {
	it("requests the rendered Web result page with browser navigation headers and recency", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		const fetchMock: FetchImpl = (input, init) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			capturedInit = init;
			return Promise.resolve(
				new Response(modernResult("https://example.com/result", "Result", "Search snippet"), {
					status: 200,
					headers: { "Content-Type": "text/html" },
				}),
			);
		};

		const response = await searchGoogle({
			...makeParams("browser headers & parsing", fetchMock),
			numSearchResults: 99,
			recency: "week",
		});

		const url = new URL(capturedUrl);
		expect(url.origin + url.pathname).toBe("https://www.google.com/search");
		expect(url.searchParams.get("q")).toBe("browser headers & parsing");
		expect(url.searchParams.get("num")).toBe("20");
		expect(url.searchParams.get("hl")).toBe("en");
		expect(url.searchParams.get("gl")).toBe("us");
		expect(url.searchParams.get("udm")).toBe("14");
		expect(url.searchParams.get("pws")).toBe("0");
		expect(url.searchParams.get("tbs")).toBe("qdr:w");
		expect(capturedInit?.method).toBeUndefined();
		const headers = new Headers(capturedInit?.headers);
		expect(headers.get("accept")).toContain("text/html");
		expect(headers.get("user-agent")).toContain("Chrome/149");
		expect(headers.get("referer")).toBe("https://www.google.com/");
		expect(headers.get("sec-fetch-dest")).toBe("document");
		expect(headers.get("sec-fetch-mode")).toBe("navigate");
		expect(headers.get("sec-fetch-site")).toBe("same-origin");
		expect(response.sources).toEqual([
			{ title: "Result", url: "https://example.com/result", snippet: "Search snippet" },
		]);
	});

	it("parses modern and legacy result markup, unwraps redirects, and deduplicates targets", async () => {
		const target = "https://example.com/legacy?a=1&b=2";
		const redirect = `/url?q=${encodeURIComponent(target)}&amp;sa=U`;
		const html = [
			modernResult(
				"https://example.com/modern",
				"Modern &amp; <em>result</em>",
				"A <em>useful</em> snippet Read more",
			),
			`<div class="Gx5Zad"><a href="${redirect}"><h3>Legacy result</h3></a><div class="BNeawe s3v9rd">Legacy snippet</div></div>`,
			modernResult(target, "Duplicate target", "duplicate"),
			modernResult("/search?q=internal", "Google navigation"),
		].join("\n");
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));

		const response = await searchGoogle({ ...makeParams("mixed markup", fetchMock), numSearchResults: 10 });

		expect(response.provider).toBe("google");
		expect(response.sources).toEqual([
			{
				title: "Modern & result",
				url: "https://example.com/modern",
				snippet: "A useful snippet",
			},
			{
				title: "Legacy result",
				url: target,
				snippet: "Legacy snippet",
			},
		]);
	});

	it("surfaces Google's JavaScript challenge as a provider-tagged block", async () => {
		const challenge = `<html><body><noscript><meta content="0;url=/httpservice/retry/enablejs?sei=test"></noscript></body></html>`;
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(challenge, { status: 200 }));

		try {
			await searchGoogle(makeParams("blocked", fetchMock));
			expect.unreachable("Google JavaScript challenge should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({
				provider: "google",
				status: 429,
				message: "Google returned its JavaScript challenge instead of rendered search results.",
			});
		}
	});
});
