import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { parseHTML } from "linkedom";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { browserFetch } from "./browser-page";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

/**
 * Bing's HTML search frontend. A plain GET with browser navigation headers
 * returns a fully server-rendered results page — no JavaScript challenge on
 * the organic path — so we parse it directly without a real browser.
 */
const BING_HOME_URL = "https://www.bing.com/";
const BING_SEARCH_URL = "https://www.bing.com/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const MS_PER_DAY = 86_400_000;

/**
 * Recency → Bing `filters=ex1:"…"` freshness codes, as emitted by Bing's own
 * "Any time" dropdown. `year` has no fixed code; the dropdown emits a custom
 * epoch-day range (`ez5_<start>_<end>`, days since 1970-01-01) which
 * {@link recencyToFilters} computes. Bing parses the parameter (the SERP
 * filter UI reflects it) but enforcement is server-side and vantage-dependent.
 */
const RECENCY_TO_BING_EZ: Record<Exclude<NonNullable<SearchParams["recency"]>, "year">, string> = {
	day: "ez1",
	week: "ez2",
	month: "ez3",
};

/** Snippet containers observed on Bing result blocks, in preference order. */
const BING_SNIPPET_SELECTORS: readonly string[] = [".b_caption p", "p[class*='b_lineclamp']", ".b_algoSlug"];

interface ParsedResult {
	title: string;
	url: string;
	snippet?: string;
}

/** Build the `filters` value for a recency window, mirroring Bing's dropdown URLs. */
function recencyToFilters(recency: NonNullable<SearchParams["recency"]>): string {
	if (recency === "year") {
		const epochDay = Math.floor(Date.now() / MS_PER_DAY);
		return `ex1:"ez5_${epochDay - 365}_${epochDay}"`;
	}
	return `ex1:"${RECENCY_TO_BING_EZ[recency]}"`;
}

/**
 * Resolve a Bing result href to the underlying target URL.
 *
 * Organic hrefs are usually wrapped as `https://www.bing.com/ck/a?…&u=a1<payload>`
 * where the payload after the literal `a1` prefix is the unpadded base64url
 * encoding of the target URL. Direct external hrefs also occur; Bing-internal
 * links (vertical tabs, ads plumbing) and non-http(s) schemes are rejected.
 */
function unwrapResultUrl(href: string): string | undefined {
	let url: URL;
	try {
		url = new URL(href, BING_HOME_URL);
	} catch {
		return undefined;
	}

	if (url.hostname === "bing.com" || url.hostname.endsWith(".bing.com")) {
		if (url.pathname !== "/ck/a") return undefined;
		const wrapped = url.searchParams.get("u");
		if (!wrapped?.startsWith("a1")) return undefined;
		try {
			url = new URL(Buffer.from(wrapped.slice(2), "base64url").toString("utf-8"));
		} catch {
			return undefined;
		}
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	return url.href;
}

function findSnippet(item: Element): string | undefined {
	for (const selector of BING_SNIPPET_SELECTORS) {
		const text = (item.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();
		if (text) return text;
	}
	return undefined;
}

/**
 * Pull organic result blocks out of the page in document order.
 *
 * Each organic hit is an `<li class="b_algo">` with the title link in
 * `h2 > a[href]` (sitelink/attribution anchors live outside the `h2`) and the
 * preview text in one of {@link BING_SNIPPET_SELECTORS}. Ads, answer cards,
 * and the "no results" row use other classes and fall out naturally.
 */
function parseHtmlResults(html: string): ParsedResult[] {
	const { document } = parseHTML(html);
	const results: ParsedResult[] = [];
	for (const item of document.querySelectorAll("li.b_algo")) {
		const anchor = item.querySelector("h2 a[href]");
		const href = anchor?.getAttribute("href");
		if (!href) continue;
		const url = unwrapResultUrl(href);
		if (!url) continue;
		const title = (anchor?.textContent ?? "").replace(/\s+/g, " ").trim();
		if (!title) continue;
		results.push({ title, url, snippet: findSnippet(item) });
	}
	return results;
}

/**
 * `true` when Bing answered with its CAPTCHA/consent interstitial instead of
 * a results page. The challenge redirects to `/turing/captcha/…`; body
 * markers are only trusted when no organic result block is present so a
 * search *about* CAPTCHAs never trips the detector.
 */
function isChallengeResponse(html: string, finalUrl: string): boolean {
	if (finalUrl.includes("/turing/captcha")) return true;
	if (html.includes('class="b_algo"')) return false;
	return /turing\/captcha|b_captcha|px-captcha|verify (?:that )?you are (?:a )?human/i.test(html);
}

function buildSearchUrl(params: SearchParams, numResults: number): string {
	const url = new URL(BING_SEARCH_URL);
	url.searchParams.set("q", params.query);
	url.searchParams.set("count", String(numResults));
	url.searchParams.set("mkt", "en-US");
	url.searchParams.set("setlang", "en");
	if (params.recency) url.searchParams.set("filters", recencyToFilters(params.recency));
	return url.href;
}

async function callBingHtml(params: SearchParams, numResults: number): Promise<string> {
	const url = buildSearchUrl(params, numResults);
	const page = await browserFetch(url, {
		fetch: params.fetch ?? fetch,
		signal: withHardTimeout(params.signal),
		referer: BING_HOME_URL,
	});

	const body = page.html;
	if (isChallengeResponse(body, page.url)) {
		throw new SearchProviderError(
			"bing",
			"Bing blocked the request with a CAPTCHA challenge. Bing throttles automated searches from datacenter/shared-egress IPs; try the duckduckgo or mojeek provider, or configure a credentialed provider such as Brave, Tavily, Exa, or Kagi.",
			429,
		);
	}
	if (page.status < 200 || page.status >= 300) {
		const classified = classifyProviderHttpError("bing", page.status, body);
		if (classified) throw classified;
		throw new SearchProviderError("bing", `Bing HTML error (${page.status})`, page.status);
	}

	return body;
}

/** Execute a Bing web search via the server-rendered HTML results page. */
export async function searchBing(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const html = await callBingHtml(params, numResults);
	const parsed = parseHtmlResults(html);

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const result of parsed) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		sources.push({ title: result.title, url: result.url, snippet: result.snippet });
		if (sources.length >= numResults) break;
	}

	return { provider: "bing", sources };
}

/** Search provider for Bing (no API key required). */
export class BingProvider extends SearchProvider {
	readonly id = "bing";
	readonly label = "Bing";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchBing(params);
	}
}
