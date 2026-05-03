/**
 * Minimal fetch-based client for the Hindsight HTTP API.
 *
 * Replaces the `@vectorize-io/hindsight-client` SDK with hand-rolled fetch
 * calls so we depend on nothing more than the API endpoints we actually use:
 * `retain`, `recall`, `reflect`, and `createBank`. Centralising construction
 * here keeps a single seam for tests to spy on.
 */

import type { HindsightConfig } from "./config";

const USER_AGENT = "oh-my-pi-coding-agent";
const DEFAULT_USER_AGENT = USER_AGENT;

export type Budget = "low" | "mid" | "high" | string;
export type TagsMatch = "any" | "all" | "any_strict" | "all_strict";

export interface HindsightApiOptions {
	baseUrl: string;
	apiKey?: string;
	userAgent?: string;
}

export interface RecallResult {
	id?: string;
	text: string;
	type?: string | null;
	mentioned_at?: string | null;
	[key: string]: unknown;
}

export interface RecallResponse {
	results: RecallResult[];
	[key: string]: unknown;
}

export interface ReflectResponse {
	text?: string;
	[key: string]: unknown;
}

export interface RetainResponse {
	[key: string]: unknown;
}

export interface BankProfileResponse {
	[key: string]: unknown;
}

export interface RetainOptions {
	timestamp?: Date | string;
	context?: string;
	metadata?: Record<string, string>;
	documentId?: string;
	async?: boolean;
	tags?: string[];
	updateMode?: "replace" | "append";
}

export interface RecallOptions {
	types?: string[];
	maxTokens?: number;
	budget?: Budget;
	tags?: string[];
	tagsMatch?: TagsMatch;
}

export interface ReflectOptions {
	context?: string;
	budget?: Budget;
	tags?: string[];
	tagsMatch?: TagsMatch;
}

export interface CreateBankOptions {
	reflectMission?: string;
	retainMission?: string;
}

export class HindsightError extends Error {
	statusCode?: number;
	details?: unknown;

	constructor(message: string, statusCode?: number, details?: unknown) {
		super(message);
		this.name = "HindsightError";
		this.statusCode = statusCode;
		this.details = details;
	}
}

export class HindsightApi {
	#baseUrl: string;
	#headers: Record<string, string>;

	constructor(options: HindsightApiOptions) {
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#headers = {
			"User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
			"Content-Type": "application/json",
		};
		if (options.apiKey) {
			this.#headers.Authorization = `Bearer ${options.apiKey}`;
		}
	}

	async retain(bankId: string, content: string, options?: RetainOptions): Promise<RetainResponse> {
		const item: Record<string, unknown> = { content };
		if (options?.timestamp !== undefined) {
			item.timestamp = options.timestamp instanceof Date ? options.timestamp.toISOString() : options.timestamp;
		}
		if (options?.context !== undefined) item.context = options.context;
		if (options?.metadata !== undefined) item.metadata = options.metadata;
		if (options?.documentId !== undefined) item.document_id = options.documentId;
		if (options?.tags !== undefined) item.tags = options.tags;
		if (options?.updateMode !== undefined) item.update_mode = options.updateMode;

		return this.#request<RetainResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
			"retain",
			{ items: [item], async: options?.async },
		);
	}

	async recall(bankId: string, query: string, options?: RecallOptions): Promise<RecallResponse> {
		return this.#request<RecallResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`,
			"recall",
			{
				query,
				types: options?.types,
				max_tokens: options?.maxTokens,
				budget: options?.budget ?? "mid",
				tags: options?.tags,
				tags_match: options?.tagsMatch,
			},
		);
	}

	async reflect(bankId: string, query: string, options?: ReflectOptions): Promise<ReflectResponse> {
		return this.#request<ReflectResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/reflect`,
			"reflect",
			{
				query,
				context: options?.context,
				budget: options?.budget ?? "low",
				tags: options?.tags,
				tags_match: options?.tagsMatch,
			},
		);
	}

	async createBank(bankId: string, options: CreateBankOptions = {}): Promise<BankProfileResponse> {
		return this.#request<BankProfileResponse>(
			"PUT",
			`/v1/default/banks/${encodeURIComponent(bankId)}`,
			"createBank",
			{
				reflect_mission: options.reflectMission,
				retain_mission: options.retainMission,
			},
		);
	}

	async #request<T>(method: string, path: string, operation: string, body: Record<string, unknown>): Promise<T> {
		const url = `${this.#baseUrl}${path}`;
		const payload = pruneUndefined(body);
		let response: Response;
		try {
			response = await fetch(url, {
				method,
				headers: this.#headers,
				body: JSON.stringify(payload),
			});
		} catch (err) {
			throw new HindsightError(
				`${operation} request failed: ${err instanceof Error ? err.message : String(err)}`,
				undefined,
				err,
			);
		}

		const text = await response.text();
		const parsed = text ? safeJsonParse(text) : null;

		if (!response.ok) {
			const details =
				(parsed && typeof parsed === "object"
					? ((parsed as { detail?: unknown; message?: unknown }).detail ??
						(parsed as { message?: unknown }).message)
					: undefined) ??
				parsed ??
				text;
			throw new HindsightError(
				`${operation} failed: ${typeof details === "string" ? details : JSON.stringify(details)}`,
				response.status,
				details,
			);
		}

		return (parsed ?? {}) as T;
	}
}

function pruneUndefined(obj: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) out[k] = v;
	}
	return out;
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
export function createHindsightClient(config: HindsightConfig & { hindsightApiUrl: string }): HindsightApi {
	return new HindsightApi({
		baseUrl: config.hindsightApiUrl,
		apiKey: config.hindsightApiToken ?? undefined,
		userAgent: USER_AGENT,
	});
}
