import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { parseHTML } from "linkedom";
import type { Page } from "puppeteer-core";
import { applyStealthPatches, applyViewport } from "../../../tools/browser/launch";
import { acquireBrowser, holdBrowser, releaseBrowser } from "../../../tools/browser/registry";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { BROWSER_NAVIGATION_HEADERS } from "./browser-headers";
import { SEARCH_HARD_TIMEOUT_MS, withHardTimeout } from "./utils";

const GOOGLE_HOME_URL = "https://www.google.com/";
const GOOGLE_SEARCH_URL = "https://www.google.com/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const RESULT_RENDER_TIMEOUT_MS = 10_000;

const RECENCY_TO_GOOGLE_TBS: Record<NonNullable<SearchParams["recency"]>, string> = {
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};
const GOOGLE_SNIPPET_SELECTORS: readonly string[] = [
	"[data-sncf='1'] .VwiC3b",
	".VwiC3b",
	".IsZvec",
	".BNeawe.s3v9rd",
	"[data-sncf='1']",
];

interface ParsedResult {
	title: string;
	url: string;
	snippet?: string;
}

interface LoadedGooglePage {
	html: string;
	status: number;
	url: string;
}

function normalizeText(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function unwrapResultUrl(href: string): string | undefined {
	let url: URL;
	try {
		url = new URL(href, GOOGLE_HOME_URL);
	} catch {
		return undefined;
	}

	if ((url.hostname === "google.com" || url.hostname === "www.google.com") && url.pathname === "/url") {
		const target = url.searchParams.get("q") || url.searchParams.get("url");
		if (!target) return undefined;
		try {
			url = new URL(target);
		} catch {
			return undefined;
		}
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (url.hostname === "google.com" || url.hostname === "www.google.com") return undefined;
	return url.href;
}

function findSnippet(heading: Element): string | undefined {
	const container = heading.closest(".tF2Cxc, .MjjYud, .Gx5Zad") ?? heading.parentElement?.parentElement;
	if (!container) return undefined;

	for (const selector of GOOGLE_SNIPPET_SELECTORS) {
		const text = normalizeText(container.querySelector(selector)?.textContent).replace(/\s*Read more$/i, "");
		if (text) return text;
	}
	return undefined;
}

function parseHtmlResults(html: string): ParsedResult[] {
	const { document } = parseHTML(html);
	const results: ParsedResult[] = [];
	for (const heading of document.querySelectorAll("h3")) {
		const anchor = heading.closest("a");
		const href = anchor?.getAttribute("href");
		if (!href) continue;
		const url = unwrapResultUrl(href);
		if (!url) continue;
		const title = normalizeText(heading.textContent);
		if (!title) continue;
		results.push({ title, url, snippet: findSnippet(heading) });
	}
	return results;
}

function buildSearchUrl(params: SearchParams, numResults: number): string {
	const url = new URL(GOOGLE_SEARCH_URL);
	url.searchParams.set("q", params.query);
	url.searchParams.set("num", String(numResults));
	url.searchParams.set("hl", "en");
	url.searchParams.set("gl", "us");
	url.searchParams.set("udm", "14");
	url.searchParams.set("pws", "0");
	const tbs = params.recency ? RECENCY_TO_GOOGLE_TBS[params.recency] : undefined;
	if (tbs) url.searchParams.set("tbs", tbs);
	return url.href;
}

async function loadWithFetch(url: string, fetchImpl: FetchImpl, signal: AbortSignal): Promise<LoadedGooglePage> {
	const response = await fetchImpl(url, {
		headers: {
			...BROWSER_NAVIGATION_HEADERS,
			Referer: GOOGLE_HOME_URL,
			"Sec-Fetch-Site": "same-origin",
		},
		signal,
	});
	return { html: await response.text(), status: response.status, url: response.url || url };
}

async function loadWithBrowser(url: string, signal: AbortSignal): Promise<LoadedGooglePage> {
	const handle = await untilAborted(signal, () =>
		acquireBrowser(
			{ kind: "headless", headless: true },
			{
				cwd: process.cwd(),
				signal,
			},
		),
	);
	if (!("browser" in handle)) {
		await releaseBrowser(handle, { kill: false });
		throw new Error("Headless browser acquisition returned a non-Puppeteer browser");
	}

	holdBrowser(handle);
	let page: Page | undefined;
	try {
		const activePage = await untilAborted(signal, () => handle.browser.newPage());
		page = activePage;
		await applyViewport(activePage);
		await applyStealthPatches(handle.browser, activePage, handle.stealth);
		// Seed Google's same-origin cookies and referrer; a cold direct navigation gets the enable-JavaScript interstitial.
		await untilAborted(signal, () =>
			activePage.goto(GOOGLE_HOME_URL, { waitUntil: "domcontentloaded", timeout: SEARCH_HARD_TIMEOUT_MS }),
		);
		const response = await untilAborted(signal, () =>
			activePage.goto(url, { waitUntil: "domcontentloaded", timeout: SEARCH_HARD_TIMEOUT_MS }),
		);
		await untilAborted(signal, () =>
			activePage.waitForSelector("a h3", { timeout: RESULT_RENDER_TIMEOUT_MS }).catch(() => null),
		);
		return {
			html: await untilAborted(signal, () => activePage.content()),
			status: response?.status() ?? 200,
			url: activePage.url(),
		};
	} finally {
		await page?.close().catch(() => undefined);
		await releaseBrowser(handle, { kill: false });
	}
}

function isBlockedPage(page: LoadedGooglePage): boolean {
	return (
		page.status === 403 ||
		page.status === 429 ||
		page.url.includes("/sorry/") ||
		/unusual traffic|detected unusual traffic|g-recaptcha/i.test(page.html)
	);
}

async function callGoogleHtml(params: SearchParams, numResults: number): Promise<string> {
	const signal = withHardTimeout(params.signal);
	const url = buildSearchUrl(params, numResults);
	let page: LoadedGooglePage;
	try {
		page = params.fetch ? await loadWithFetch(url, params.fetch, signal) : await loadWithBrowser(url, signal);
	} catch (error) {
		if (error instanceof SearchProviderError || params.signal?.aborted) throw error;
		if (signal.aborted) {
			throw new SearchProviderError("google", "Google browser search timed out.", 504);
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new SearchProviderError("google", `Google browser search failed: ${message}`, 503);
	}

	if (isBlockedPage(page)) {
		throw new SearchProviderError(
			"google",
			"Google blocked the browser search with an automated-traffic challenge. Try another web search provider or retry later.",
			429,
		);
	}
	if (page.status < 200 || page.status >= 300) {
		throw new SearchProviderError("google", `Google HTML error (${page.status})`, page.status);
	}
	if (page.html.includes("/httpservice/retry/enablejs") && !/<h3\b/i.test(page.html)) {
		throw new SearchProviderError(
			"google",
			"Google returned its JavaScript challenge instead of rendered search results.",
			429,
		);
	}
	return page.html;
}

/** Execute a Google web search through a real headless browser and parse the rendered result page. */
export async function searchGoogle(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const html = await callGoogleHtml(params, numResults);
	const parsed = parseHtmlResults(html);

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const result of parsed) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		sources.push({ title: result.title, url: result.url, snippet: result.snippet });
		if (sources.length >= numResults) break;
	}

	return { provider: "google", sources };
}

/** Browser-backed Google Search provider; no API key is required. */
export class GoogleProvider extends SearchProvider {
	readonly id = "google";
	readonly label = "Google";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchGoogle(params);
	}
}
