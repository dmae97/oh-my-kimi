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
 * Yahoo Search's server-rendered results page. A plain GET with browser
 * navigation headers returns the full SERP without any JavaScript challenge,
 * so no headless-browser fallback is needed (verified live 2026-07).
 */
const YAHOO_HOME_URL = "https://search.yahoo.com/";
const YAHOO_SEARCH_URL = "https://search.yahoo.com/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

/**
 * Recency → Yahoo `btf` query param. Yahoo's time filter only offers
 * day/week/month; `year` has no equivalent and is silently dropped per the
 * {@link SearchParams.recency} contract.
 */
const RECENCY_TO_YAHOO_BTF: Partial<Record<NonNullable<SearchParams["recency"]>, string>> = {
	day: "d",
	week: "w",
	month: "m",
};

interface ParsedResult {
	title: string;
	url: string;
	snippet?: string;
}

/**
 * Resolve a Yahoo result href back to the underlying target URL.
 *
 * Organic hrefs are wrapped through the click tracker
 * `https://r.search.yahoo.com/_ylt=…/RU=<percent-encoded-target>/RK=…/RS=…`;
 * the `/RU=` path segment carries the destination. Older layouts emit plain
 * absolute hrefs, so both shapes are handled. Tracker links without a
 * recoverable target and Yahoo-internal navigation are rejected.
 */
function unwrapResultUrl(href: string): string | undefined {
	let url: URL;
	try {
		url = new URL(href, YAHOO_HOME_URL);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

	const wrapped = /\/RU=([^/]+)/.exec(url.pathname);
	if (wrapped) {
		let target: string;
		try {
			target = decodeURIComponent(wrapped[1]);
		} catch {
			return undefined;
		}
		return target.startsWith("http://") || target.startsWith("https://") ? target : undefined;
	}
	// A tracker link without an RU segment has no recoverable destination.
	if (url.hostname === "r.search.yahoo.com") return undefined;
	// Relative hrefs resolve against the search host: internal navigation.
	if (url.hostname === "search.yahoo.com") return undefined;
	return url.href;
}

/**
 * Walk the SERP and pull organic result blocks in document order.
 *
 * Organics render as `<div class="… algo …">` blocks (inside `#web`'s
 * `<ol>`): the title `<h3>` sits inside the tracker `<a>` in the current
 * layout, while legacy layouts nested the `<a>` inside `<h3 class="title">`
 * — both are handled. The preview text lives in a sibling
 * `<div class="compText">`. Module headers ("Videos", "People also ask")
 * carry `<h3>`s outside `.algo` blocks and are excluded by construction.
 */
function parseHtmlResults(html: string): ParsedResult[] {
	const { document } = parseHTML(html);
	const results: ParsedResult[] = [];
	for (const block of document.querySelectorAll("div.algo")) {
		const heading = block.querySelector("h3");
		if (!heading) continue;
		const anchor = heading.querySelector("a") ?? heading.closest("a");
		const href = anchor?.getAttribute("href");
		if (!href) continue;
		const url = unwrapResultUrl(href);
		if (!url) continue;
		const title = (heading.textContent ?? "").replace(/\s+/g, " ").trim();
		if (!title) continue;
		const snippet = (block.querySelector(".compText")?.textContent ?? "").replace(/\s+/g, " ").trim() || undefined;
		results.push({ title, url, snippet });
	}
	return results;
}

/**
 * `true` when Yahoo answered with its EU consent interstitial instead of
 * results: either the request was redirected to consent.yahoo.com /
 * guce.yahoo.com, or the body carries the consent form. The normal SERP
 * mentions guce.yahoo.com only in a meta tag, so detection keys on the
 * consent-host redirect and the `collectConsent` form action.
 */
function isConsentInterstitial(finalUrl: string, html: string): boolean {
	if (/^https?:\/\/(?:[^/]*\.)?(?:consent|guce)\.yahoo\.com\//i.test(finalUrl)) return true;
	return html.includes("consent.yahoo.com") || html.includes("collectConsent");
}

async function callYahooHtml(params: SearchParams, numResults: number): Promise<string> {
	const url = new URL(YAHOO_SEARCH_URL);
	url.searchParams.set("p", params.query);
	url.searchParams.set("n", String(numResults));
	const btf = params.recency ? RECENCY_TO_YAHOO_BTF[params.recency] : undefined;
	if (btf) url.searchParams.set("btf", btf);

	const page = await browserFetch(url.href, {
		fetch: params.fetch ?? fetch,
		signal: withHardTimeout(params.signal),
		referer: YAHOO_HOME_URL,
	});

	const body = page.html;
	if (page.status < 200 || page.status >= 300) {
		const classified = classifyProviderHttpError("yahoo", page.status, body);
		if (classified) throw classified;
		throw new SearchProviderError("yahoo", `Yahoo HTML error (${page.status})`, page.status);
	}

	if (isConsentInterstitial(page.url, body)) {
		throw new SearchProviderError(
			"yahoo",
			"Yahoo served its GDPR consent interstitial instead of search results. This typically affects EU egress IPs; use another web search provider such as DuckDuckGo, Brave, or Mojeek.",
			429,
		);
	}

	return body;
}

/** Execute a Yahoo web search via the server-rendered HTML results page. */
export async function searchYahoo(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const html = await callYahooHtml(params, numResults);
	const parsed = parseHtmlResults(html);

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const result of parsed) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		sources.push({ title: result.title, url: result.url, snippet: result.snippet });
		if (sources.length >= numResults) break;
	}

	return { provider: "yahoo", sources };
}

/** Search provider for Yahoo (no API key required). */
export class YahooProvider extends SearchProvider {
	readonly id = "yahoo";
	readonly label = "Yahoo";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchYahoo(params);
	}
}
