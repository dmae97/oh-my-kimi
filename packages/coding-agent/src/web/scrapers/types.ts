/**
 * Shared types and utilities for web-fetch handlers
 */
import { ptree } from "@oh-my-pi/pi-utils";
import type TurndownService from "turndown";

import { ToolAbortError } from "../../tools/tool-errors";

export { formatNumber } from "@oh-my-pi/pi-utils";

export interface RenderResult {
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	content: string;
	fetchedAt: string;
	truncated: boolean;
	notes: string[];
}

export type SpecialHandler = (url: string, timeout: number, signal?: AbortSignal) => Promise<RenderResult | null>;

export const MAX_OUTPUT_CHARS = 500_000;
export const MAX_BYTES = 50 * 1024 * 1024;

const USER_AGENTS = [
	"curl/8.0",
	"Mozilla/5.0 (compatible; TextBot/1.0)",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

function isBotBlocked(status: number, content: string): boolean {
	if (status === 403 || status === 503) {
		const lower = content.toLowerCase();
		return (
			lower.includes("cloudflare") ||
			lower.includes("captcha") ||
			lower.includes("challenge") ||
			lower.includes("blocked") ||
			lower.includes("access denied") ||
			lower.includes("bot detection")
		);
	}
	return false;
}

/**
 * Truncate and cleanup output
 */
export function finalizeOutput(content: string): { content: string; truncated: boolean } {
	const cleaned = content.replace(/\n{3,}/g, "\n\n").trim();
	const truncated = cleaned.length > MAX_OUTPUT_CHARS;
	return {
		content: cleaned.slice(0, MAX_OUTPUT_CHARS),
		truncated,
	};
}

export interface LoadPageOptions {
	timeout?: number;
	headers?: Record<string, string>;
	method?: string;
	body?: string;
	maxBytes?: number;
	signal?: AbortSignal;
}

export interface LoadPageResult {
	content: string;
	contentType: string;
	finalUrl: string;
	ok: boolean;
	status?: number;
}

/**
 * Fetch a page with timeout and size limit
 */
export async function loadPage(url: string, options: LoadPageOptions = {}): Promise<LoadPageResult> {
	const { timeout = 20, headers = {}, maxBytes = MAX_BYTES, signal, method = "GET", body } = options;

	for (let attempt = 0; attempt < USER_AGENTS.length; attempt++) {
		if (signal?.aborted) {
			throw new ToolAbortError();
		}

		const userAgent = USER_AGENTS[attempt];
		const requestSignal = ptree.combineSignals(signal, timeout * 1000);

		try {
			const requestInit: RequestInit = {
				signal: requestSignal,
				method,
				headers: {
					"User-Agent": userAgent,
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.5",
					"Accept-Encoding": "identity", // Cloudflare Markdown-for-Agents returns corrupted bytes when compression is negotiated
					...headers,
				},
				redirect: "follow",
			};

			if (body !== undefined) {
				requestInit.body = body;
			}

			const response = await fetch(url, requestInit);

			const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
			const finalUrl = response.url;

			const reader = response.body?.getReader();
			if (!reader) {
				return { content: "", contentType, finalUrl, ok: false, status: response.status };
			}

			const chunks: Uint8Array[] = [];
			let totalSize = 0;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				chunks.push(value);
				totalSize += value.length;

				if (totalSize > maxBytes) {
					reader.cancel();
					break;
				}
			}

			const content = Buffer.concat(chunks).toString("utf-8");
			if (isBotBlocked(response.status, content) && attempt < USER_AGENTS.length - 1) {
				continue;
			}

			if (!response.ok) {
				return { content, contentType, finalUrl, ok: false, status: response.status };
			}

			return { content, contentType, finalUrl, ok: true, status: response.status };
		} catch {
			if (signal?.aborted) {
				throw new ToolAbortError();
			}
			if (attempt === USER_AGENTS.length - 1) {
				return { content: "", contentType: "", finalUrl: url, ok: false };
			}
		}
	}

	return { content: "", contentType: "", finalUrl: url, ok: false };
}

/** Module-level Turndown instance — built lazily on first use. */
let turndownPromise: Promise<TurndownService> | undefined;

type TurndownListParent = {
	nodeName: string;
	getAttribute(name: string): string | null;
	children: ArrayLike<unknown>;
};

function getTurndown(): Promise<TurndownService> {
	turndownPromise ||= initTurndown();
	return turndownPromise;
}

async function initTurndown(): Promise<TurndownService> {
	const [{ default: TurndownService }, { gfm }] = await Promise.all([
		import("turndown"),
		import("turndown-plugin-gfm"),
	]);
	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});
	turndown.use(gfm);
	turndown.addRule("strikethrough", {
		filter: ["del", "s", "strike"],
		replacement(content) {
			return `~~${content}~~`;
		},
	});
	turndown.addRule("heading", {
		filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
		replacement(content, node) {
			const level = Number(node.nodeName.charAt(1));
			const prefix = "#".repeat(level);
			const cleaned = content.replace(/\\([.])/g, "$1").trim();
			return `\n\n${prefix} ${cleaned}\n\n`;
		},
	});
	turndown.addRule("listItem", {
		filter: "li",
		replacement(content, node, options) {
			content = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n  ");
			const parent = node.parentNode as unknown as TurndownListParent | null;
			let prefix = `${options.bulletListMarker} `;
			if (parent?.nodeName === "OL") {
				const start = parent.getAttribute("start");
				const index = Array.prototype.indexOf.call(parent.children, node);
				prefix = `${(start ? Number(start) : 1) + index}. `;
			}
			return prefix + content + (node.nextSibling ? "\n" : "");
		},
	});
	return turndown;
}

/**
 * Convert HTML to markdown using Turndown with GFM support.
 * Strips script/style tags before conversion.
 */
export async function htmlToBasicMarkdown(html: string): Promise<string> {
	const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
	const turndown = await getTurndown();
	return turndown.turndown(cleaned).trim();
}

/**
 * Build a RenderResult from markdown content. Calls finalizeOutput internally.
 */
export function buildResult(
	md: string,
	opts: { url: string; finalUrl?: string; method: string; fetchedAt: string; notes?: string[]; contentType?: string },
): RenderResult {
	const output = finalizeOutput(md);
	return {
		url: opts.url,
		finalUrl: opts.finalUrl ?? opts.url,
		contentType: opts.contentType ?? "text/markdown",
		method: opts.method,
		content: output.content,
		fetchedAt: opts.fetchedAt,
		truncated: output.truncated,
		notes: opts.notes ?? [],
	};
}

/**
 * Format a date value as YYYY-MM-DD. Returns empty string on invalid input.
 */
export function formatIsoDate(value?: string | number | Date): string {
	if (value == null) return "";
	if (typeof value === "string") {
		const datePrefix = value.match(/^\d{4}-\d{2}-\d{2}/);
		if (datePrefix) return datePrefix[0];
	}
	try {
		return new Date(value).toISOString().split("T")[0];
	} catch {
		return "";
	}
}

/**
 * Decode common HTML entities.
 */
export function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, "/")
		.replace(/&nbsp;/g, " ");
}

/**
 * Format seconds into HH:MM:SS or MM:SS.
 */
export function formatMediaDuration(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const secs = Math.floor(totalSeconds % 60);
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/**
 * Extract localized text, preferring en-US/en.
 */
export type LocalizedText = string | Record<string, string | null> | null | undefined;

export function getLocalizedText(value: LocalizedText, defaultLocale?: string): string | undefined {
	if (value == null) return undefined;
	if (typeof value === "string") return value;
	if (defaultLocale && value[defaultLocale]) return value[defaultLocale];
	return (
		value["en-US"] ?? value.en_US ?? value.en ?? Object.values(value).find(v => typeof v === "string") ?? undefined
	);
}

/**
 * Check if content looks like HTML by inspecting the leading tag.
 */
export function looksLikeHtml(content: string): boolean {
	const trimmed = content.trim().toLowerCase();
	return (
		trimmed.startsWith("<!doctype") ||
		trimmed.startsWith("<html") ||
		trimmed.startsWith("<head") ||
		trimmed.startsWith("<body")
	);
}
