import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

/**
 * DuckDuckGo's no-JS HTML search frontend. POST `q=…` to receive a static
 * results page we can parse without a real browser. The Instant Answer API
 * (`api.duckduckgo.com`) was tried first but it only returns content for
 * Wikipedia/Wolfram-Alpha-style topics — empty for the vast majority of
 * agent queries (see #3799).
 */
const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

/**
 * Recency → DDG `df` form param. DDG accepts single letters for the time
 * filter; queries without a `df` value return the unfiltered default.
 */
const RECENCY_TO_DDG_DF: Record<NonNullable<SearchParams["recency"]>, string> = {
	day: "d",
	week: "w",
	month: "m",
	year: "y",
};

/**
 * Browser-like UA so DDG serves the standard results page instead of the
 * mobile-only or noscript variants. DDG returns HTTP 202 plus an anomaly
 * modal when it suspects automation; we surface that as a clear error so
 * the orchestrator can fall through to the next provider with context.
 */
const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

interface ParsedResult {
	title: string;
	url: string;
	snippet?: string;
}

/**
 * Decode an HTML-encoded fragment lifted from DDG markup. Strips inline tags
 * (the results page wraps query terms in `<b>`), unescapes the small set of
 * named entities DDG emits, and normalises whitespace.
 */
function decodeHtmlText(value: string): string {
	return value
		.replace(/<[^>]*>/g, " ")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Resolve a DDG result href back to the underlying target URL.
 *
 * DDG routes outbound clicks through `//duckduckgo.com/l/?uddg=<encoded>` so
 * it can record analytics; we want the unwrapped URL. Handles three shapes
 * the page mixes in practice: redirect wrappers, protocol-relative links,
 * and (rarely) absolute URLs on sponsored or instant answer rows.
 */
function unwrapResultUrl(href: string): string | undefined {
	if (!href) return undefined;
	const decoded = href.replace(/&amp;/gi, "&");
	const wrapMatch = decoded.match(/[?&]uddg=([^&]+)/);
	if (wrapMatch) {
		try {
			return decodeURIComponent(wrapMatch[1]);
		} catch {
			return undefined;
		}
	}
	if (decoded.startsWith("//")) return `https:${decoded}`;
	if (decoded.startsWith("http://") || decoded.startsWith("https://")) return decoded;
	return undefined;
}

/**
 * Walk the HTML page and pull out result blocks in document order.
 *
 * DDG renders each result inside a `<div class="result …">` container with
 * `<a class="result__a" …>` for the title link and an optional sibling
 * `<a class="result__snippet">` (or `<div class="result__snippet">` in some
 * variants) for the preview text. Sponsored placements, missing snippets,
 * and the trailing pagination row are tolerated.
 */
function parseHtmlResults(html: string): ParsedResult[] {
	const results: ParsedResult[] = [];
	const blockRe =
		/<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|<div\b[^>]*\bclass="[^"]*\bnav-link\b|$)/g;
	const titleRe = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
	const snippetRe = /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;
	for (const match of html.matchAll(blockRe)) {
		const block = match[1];
		const title = titleRe.exec(block);
		if (!title) continue;
		const url = unwrapResultUrl(title[1]);
		if (!url) continue;
		const titleText = decodeHtmlText(title[2]);
		if (!titleText) continue;
		const snippet = snippetRe.exec(block);
		const snippetText = snippet ? decodeHtmlText(snippet[1]) : undefined;
		results.push({ title: titleText, url, snippet: snippetText || undefined });
	}
	return results;
}

/**
 * `true` when the page DDG returned is the bot-challenge modal instead of
 * real results. DDG mixes status codes (200 vs 202) on these so the body
 * check is the reliable signal.
 */
function isAnomalyResponse(html: string): boolean {
	return html.includes("anomaly-modal") || html.includes("anomaly.js");
}

async function callDuckDuckGoHtml(params: SearchParams): Promise<string> {
	const form = new URLSearchParams({ q: params.query, kl: "us-en" });
	const df = params.recency ? RECENCY_TO_DDG_DF[params.recency] : undefined;
	if (df) form.set("df", df);
	// Add b: "" parameter as specified in the browser fetch template to match real browser form submission
	form.set("b", "");

	const response = await (params.fetch ?? fetch)(DUCKDUCKGO_HTML_URL, {
		method: "POST",
		body: form.toString(),
		headers: {
			Accept:
				"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
			"Accept-Language": "en,en-US;q=0.9",
			"Cache-Control": "max-age=0",
			"Content-Type": "application/x-www-form-urlencoded",
			Priority: "u=0, i",
			"Sec-Ch-Ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
			"Sec-Ch-Ua-Mobile": "?0",
			"Sec-Ch-Ua-Platform": '"macOS"',
			"Sec-Fetch-Dest": "document",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-User": "?1",
			"Upgrade-Insecure-Requests": "1",
			"User-Agent": BROWSER_USER_AGENT,
			Referer: "https://html.duckduckgo.com/",
		},
		signal: withHardTimeout(params.signal),
	});

	const body = await response.text();
	if (!response.ok && response.status !== 202) {
		const classified = classifyProviderHttpError("duckduckgo", response.status, body);
		if (classified) throw classified;
		throw new SearchProviderError("duckduckgo", `DuckDuckGo HTML error (${response.status})`, response.status);
	}

	if (isAnomalyResponse(body)) {
		throw new SearchProviderError(
			"duckduckgo",
			"DuckDuckGo blocked the request with a bot-detection challenge. DuckDuckGo throttles automated HTML searches from datacenter/shared-egress IPs; configure a credentialed provider such as Brave, Tavily, Exa, or Kagi for reliable web search.",
			429,
		);
	}

	return body;
}

/** Execute a DuckDuckGo web search via the no-JS HTML frontend. */
export async function searchDuckDuckGo(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const html = await callDuckDuckGoHtml(params);
	const parsed = parseHtmlResults(html);

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const result of parsed) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		sources.push({ title: result.title, url: result.url, snippet: result.snippet });
		if (sources.length >= numResults) break;
	}

	return { provider: "duckduckgo", sources };
}

/** Search provider for DuckDuckGo (no API key required). */
export class DuckDuckGoProvider extends SearchProvider {
	readonly id = "duckduckgo";
	readonly label = "DuckDuckGo";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchDuckDuckGo(params);
	}
}
