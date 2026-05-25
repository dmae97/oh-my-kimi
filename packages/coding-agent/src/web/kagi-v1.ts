/**
 * Kagi V1 API Client
 *
 * Implements the Kagi V1 Search API (POST /api/v1/search) which differs from
 * the legacy V0 API (GET /api/v0/search) in authentication, request format,
 * and response structure.
 */
import { getEnvApiKey } from "@oh-my-pi/pi-ai";
import { findCredential, withHardTimeout } from "./search/providers/utils";

const KAGI_V1_SEARCH_URL = "https://kagi.com/api/v1/search";

// ---------------------------------------------------------------------------
// V1 Request / Response Types
// ---------------------------------------------------------------------------

/** V1 search request body */
export interface KagiV1SearchRequest {
	query: string;
	/** Workflow mode: "search" | "research" */
	workflow?: string;
	/** Number of results (1-100) */
	limit?: number;
	/** Lens identifier (e.g., "news", "reddit") */
	lens?: string;

	/** Time-based filter: ISO date string (YYYY-MM-DD, e.g. 2025-04-25) */
	filters?: {
		after?: string;
		before?: string;
	};
}

/** Individual V1 result item */
export interface KagiV1SearchResultItem {
	url: string;
	title: string;
	snippet?: string;
	/** ISO timestamp or relative ("2h ago") */
	time?: string;
	/** Thumbnail image */
	image?: { url: string; height?: number; width?: number };
	/** Extra metadata key-value pairs */
	props?: Record<string, unknown>;
}

export interface KagiV1SearchData {
	search?: KagiV1SearchResultItem[];
	image?: KagiV1SearchResultItem[];
	video?: KagiV1SearchResultItem[];
	podcast?: KagiV1SearchResultItem[];
	podcast_creator?: KagiV1SearchResultItem[];
	news?: KagiV1SearchResultItem[];
	adjacent_question?: KagiV1SearchResultItem[];
	direct_answer?: KagiV1SearchResultItem[];
	interesting_news?: KagiV1SearchResultItem[];
	interesting_finds?: KagiV1SearchResultItem[];
	infobox?: KagiV1SearchResultItem[];
	code?: KagiV1SearchResultItem[];
	package_tracking?: KagiV1SearchResultItem[];
	public_records?: KagiV1SearchResultItem[];
	weather?: KagiV1SearchResultItem[];
	related_search?: KagiV1SearchResultItem[];
	listicle?: KagiV1SearchResultItem[];
	web_archive?: KagiV1SearchResultItem[];
}

/** V1 success response */
export interface KagiV1SearchResponse {
	meta?: {
		id: string;
	};
	data?: KagiV1SearchData;
	error?: KagiV1ErrorEntry[];
}

/** V1 error entry */
export interface KagiV1ErrorEntry {
	code?: number;
	url?: string;
	message?: string;
	location?: string;
}

/** V1 error response */
export interface KagiV1ErrorResponse {
	meta?: Record<string, unknown>;
	error?: KagiV1ErrorEntry[];
}

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

export class KagiV1ApiError extends Error {
	readonly statusCode?: number;

	constructor(message: string, statusCode?: number) {
		super(message);
		this.name = "KagiV1ApiError";
		this.statusCode = statusCode;
	}
}

function extractKagiV1ErrorMessage(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null;
	const record = payload as Record<string, unknown>;

	// Try message field first
	if (typeof record.message === "string" && record.message.trim().length > 0) {
		return record.message.trim();
	}

	// Try V1 error array
	if (Array.isArray(record.error)) {
		for (const entry of record.error) {
			if (!entry || typeof entry !== "object") continue;
			const e = entry as Record<string, unknown>;
			if (typeof e.message === "string" && e.message.trim().length > 0) {
				return e.message.trim();
			}
			if (typeof e.msg === "string" && e.msg.trim().length > 0) {
				return e.msg.trim();
			}
		}
	}

	// Fallback: stringify the whole payload
	const keys = Object.keys(record);
	if (keys.length > 0) {
		const first = record[keys[0]];
		if (typeof first === "string" && first.trim().length > 0) {
			return first.trim();
		}
	}

	return null;
}

function createKagiV1ApiError(statusCode: number, detail?: string): KagiV1ApiError {
	const msg = detail ? `Kagi V1 API error (${statusCode}): ${detail}` : `Kagi V1 API error (${statusCode})`;
	return new KagiV1ApiError(msg, statusCode);
}

function parseKagiV1ErrorResponse(statusCode: number, responseText: string): KagiV1ApiError {
	const trimmed = responseText.trim();
	if (trimmed.length === 0) {
		return createKagiV1ApiError(statusCode);
	}

	try {
		const payload = JSON.parse(trimmed) as KagiV1ErrorResponse;
		return createKagiV1ApiError(statusCode, extractKagiV1ErrorMessage(payload) ?? trimmed);
	} catch {
		return createKagiV1ApiError(statusCode, trimmed);
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface KagiV1SearchOptions {
	limit?: number;
	recency?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
}

export interface KagiV1SearchSource {
	title: string;
	url: string;
	snippet?: string;
	publishedDate?: string;
}

export interface KagiV1SearchResult {
	requestId: string;
	sources: KagiV1SearchSource[];
	relatedQuestions: string[];
	answer?: string;
}

/**
 * Find the Kagi API key (same key works for both V0 and V1 APIs).
 * Checks KAGI_API_KEY env var, then keychain storage.
 */
export async function findKagiApiKey(): Promise<string | null> {
	return findCredential(getEnvApiKey("kagi"), "kagi");
}

function buildRequestBody(query: string, options: KagiV1SearchOptions): KagiV1SearchRequest {
	const req: KagiV1SearchRequest = {
		query,
		workflow: "search",
		limit: options.limit,
	};

	// Map recency to ISO date string for filters.after
	if (options.recency) {
		req.filters = { ...req.filters, after: recencyToDate(options.recency) };
	}

	return req;
}

/// Compute the date string YYYY-MM-DD in local time by subtracting the given
/// recency unit from today. Uses Date setters to correctly handle month drift
/// (e.g. Mar 31 −1 month → Feb 28/29) and leap years (e.g. Mar 1 −1 year →
/// Mar 1 2024, not Mar 2).
function recencyToDate(recency: "day" | "week" | "month" | "year"): string {
	const d = new Date();
	switch (recency) {
		case "day":
			d.setDate(d.getDate() - 1);
			break;
		case "week":
			d.setDate(d.getDate() - 7);
			break;
		case "month":
			d.setMonth(d.getMonth() - 1);
			break;
		case "year":
			d.setFullYear(d.getFullYear() - 1);
			break;
	}
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

export async function searchWithKagiV1(query: string, options: KagiV1SearchOptions = {}): Promise<KagiV1SearchResult> {
	const apiKey = await findKagiApiKey();
	if (!apiKey) {
		throw new KagiV1ApiError("Kagi credentials not found. Set KAGI_API_KEY or login with 'omp /login kagi'.");
	}

	const requestBody = buildRequestBody(query, options);

	const response = await fetch(KAGI_V1_SEARCH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(requestBody),
		signal: withHardTimeout(options.signal),
	});

	if (!response.ok) {
		throw parseKagiV1ErrorResponse(response.status, await response.text());
	}

	const payload = (await response.json()) as KagiV1SearchResponse;

	if (payload.error && payload.error.length > 0) {
		const first = payload.error[0];
		throw createKagiV1ApiError(first.code ?? 400, extractKagiV1ErrorMessage(payload) ?? first.message);
	}

	const sources: KagiV1SearchSource[] = [];
	const relatedQuestions: string[] = [];
	let answer: string | undefined;

	const data = payload.data;

	// V1 categorizes results; collect from each category
	if (data?.search) {
		for (const item of data.search) {
			sources.push({
				title: item.title,
				url: item.url,
				snippet: item.snippet,
				publishedDate: item.time,
			});
		}
	}
	if (data?.video) {
		for (const item of data.video) {
			sources.push({
				title: `[Video] ${item.title}`,
				url: item.url,
				snippet: item.snippet,
				publishedDate: item.time,
			});
		}
	}
	if (data?.news) {
		for (const item of data.news) {
			sources.push({
				title: `[News] ${item.title}`,
				url: item.url,
				snippet: item.snippet,
				publishedDate: item.time,
			});
		}
	}
	if (data?.infobox) {
		for (const item of data.infobox) {
			sources.push({
				title: `[Info] ${item.title}`,
				url: item.url,
				snippet: item.snippet,
				publishedDate: item.time,
			});
		}
	}

	// Adjacent questions (stored under adjacent_question with question in props.question)
	if (data?.adjacent_question) {
		for (const item of data.adjacent_question) {
			const q = item.props?.question ?? item.props?.query ?? item.title;
			if (q) relatedQuestions.push(q as string);
		}
	}

	// Related searches
	if (data?.related_search) {
		for (const item of data.related_search) {
			const q = item.props?.question ?? item.props?.query ?? item.title;
			if (q) relatedQuestions.push(q as string);
		}
	}
	// Direct answer
	if (data?.direct_answer && data.direct_answer.length > 0) {
		answer = data.direct_answer[0].snippet ?? data.direct_answer[0].title;
	}

	return {
		requestId: payload.meta?.id ?? "",
		sources,
		relatedQuestions,
		answer,
	};
}
