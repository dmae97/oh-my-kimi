import { type } from "arktype";
import type { ModelSpec } from "../types";
import { discoveryFetch } from "../utils";
import { CODEX_BASE_URL, CODEX_CLIENT_VERSION, OPENAI_HEADER_VALUES, OPENAI_HEADERS } from "../wire/codex";

const DEFAULT_MODEL_LIST_PATHS = ["/codex/models", "/models"] as const;
const DEFAULT_CONTEXT_WINDOW = 272_000;
const DEFAULT_MAX_TOKENS = 128_000;
const CODEX_REMOTE_COMPACTION = {
	enabled: true,
	api: "openai-codex-responses",
	v2StreamingEnabled: true,
} as const;

const codexReasoningPresetSchema = type({
	"effort?": "unknown",
});

const codexModelEntrySchema = type({
	"slug?": "unknown",
	"id?": "unknown",
	"display_name?": "unknown",
	"context_window?": "unknown",
	"default_reasoning_level?": "unknown",
	"supported_reasoning_levels?": "unknown",
	"input_modalities?": "unknown",
	"supported_in_api?": "unknown",
	"priority?": "unknown",
	"prefer_websockets?": "unknown",
	"use_responses_lite?": "unknown",
});

const codexModelsResponseSchema = type({
	"models?": "unknown[]",
	"data?": "unknown[]",
});

type CodexModelEntry = typeof codexModelEntrySchema.infer;
interface NormalizedCodexModel {
	model: ModelSpec<"openai-codex-responses">;
	priority: number;
}

/**
 * Fetch options for OpenAI Codex model discovery.
 */
export interface CodexModelDiscoveryOptions {
	/** OAuth access token used for `Authorization: Bearer ...`. */
	accessToken: string;
	/** ChatGPT account id value used for `chatgpt-account-id` header. */
	accountId?: string;
	/** Base URL for Codex backend. Defaults to `https://chatgpt.com/backend-api`. */
	baseUrl?: string;
	/** Optional client version attached as `client_version` query parameter. */
	clientVersion?: string;
	/** Optional endpoint path candidates. Defaults to `/codex/models`, then `/models`. */
	paths?: readonly string[];
	/** Additional headers merged on top of required Codex headers. */
	headers?: Record<string, string>;
	/** Abort signal for network request cancellation. */
	signal?: AbortSignal;
	/** Optional fetch implementation override for tests. */
	fetchFn?: typeof fetch;
}

/**
 * Normalized Codex discovery response.
 */
export interface CodexModelDiscoveryResult {
	models: ModelSpec<"openai-codex-responses">[];
	etag?: string;
}

/**
 * Fetches model metadata from Codex backend and normalizes it for pi model management.
 *
 * Returns `null` when no supported model-list route can be fetched/parsed.
 * Returns `{ models: [] }` when a route succeeds but yields no usable models.
 */
export async function fetchCodexModels(options: CodexModelDiscoveryOptions): Promise<CodexModelDiscoveryResult | null> {
	const fetchFn = discoveryFetch(options.fetchFn);
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const paths = normalizePaths(options.paths);
	const clientVersion = normalizeClientVersion(options.clientVersion) ?? CODEX_CLIENT_VERSION;
	const headers = buildCodexHeaders(options, clientVersion);

	let sawSuccessfulResponse = false;
	for (const path of paths) {
		const requestUrl = buildModelsUrl(baseUrl, path, clientVersion);
		let response: Response;
		try {
			response = await fetchFn(requestUrl, {
				method: "GET",
				headers,
				signal: options.signal,
			});
		} catch {
			continue;
		}

		if (!response.ok) {
			continue;
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			continue;
		}

		const models = normalizeCodexModels(payload, baseUrl);
		if (models === null) {
			continue;
		}
		sawSuccessfulResponse = true;
		const etag = getResponseEtag(response.headers);
		return etag ? { models, etag } : { models };
	}
	return sawSuccessfulResponse ? { models: [] } : null;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
	const raw = (baseUrl ?? CODEX_BASE_URL).trim();
	if (!raw) {
		return CODEX_BASE_URL;
	}
	return raw.replace(/\/+$/, "");
}

function normalizePaths(paths: readonly string[] | undefined): string[] {
	if (!paths || paths.length === 0) {
		return [...DEFAULT_MODEL_LIST_PATHS];
	}
	const normalized = paths
		.map(path => path.trim())
		.filter(path => path.length > 0)
		.map(path => (path.startsWith("/") ? path : `/${path}`));
	return normalized.length > 0 ? normalized : [...DEFAULT_MODEL_LIST_PATHS];
}

function buildModelsUrl(baseUrl: string, path: string, clientVersion: string | undefined): string {
	const url = new URL(`${baseUrl}${path}`);
	if (clientVersion && clientVersion.trim().length > 0) {
		url.searchParams.set("client_version", clientVersion.trim());
	}
	return url.toString();
}

function buildCodexHeaders(options: CodexModelDiscoveryOptions, clientVersion: string): Headers {
	const headers = new Headers(options.headers);
	headers.set("Authorization", `Bearer ${options.accessToken}`);
	if (options.accountId && options.accountId.trim().length > 0) {
		headers.set(OPENAI_HEADERS.ACCOUNT_ID, options.accountId);
	}
	headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	headers.set(OPENAI_HEADERS.VERSION, clientVersion);
	headers.set("accept", "application/json");
	return headers;
}

function normalizeClientVersion(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	if (!/^\d+\.\d+\.\d+$/.test(trimmed)) {
		return undefined;
	}
	return trimmed;
}

function normalizeCodexModels(payload: unknown, baseUrl: string): ModelSpec<"openai-codex-responses">[] | null {
	const parsedResponse = codexModelsResponseSchema(payload);
	if (parsedResponse instanceof type.errors) {
		return null;
	}

	const entries = parsedResponse.models ?? parsedResponse.data ?? [];
	const normalized: NormalizedCodexModel[] = [];
	for (const entry of entries) {
		const model = normalizeCodexModelEntry(entry, baseUrl);
		if (model) {
			normalized.push(model);
		}
	}

	normalized.sort((left, right) => {
		if (left.priority !== right.priority) {
			return left.priority - right.priority;
		}
		return left.model.id.localeCompare(right.model.id);
	});

	return normalized.map(item => item.model);
}

function normalizeCodexModelEntry(entry: unknown, baseUrl: string): NormalizedCodexModel | null {
	const parsedEntry = codexModelEntrySchema(entry);
	if (parsedEntry instanceof type.errors) {
		return null;
	}

	const payload: CodexModelEntry = parsedEntry;
	const slug = toNonEmptyString(payload.slug) ?? toNonEmptyString(payload.id);
	if (!slug) {
		return null;
	}

	const supportedInApi = toBoolean(payload.supported_in_api);
	if (supportedInApi === false) {
		return null;
	}

	const name = toNonEmptyString(payload.display_name) ?? slug;
	const contextWindow = toPositiveInt(payload.context_window) ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens = Math.min(DEFAULT_MAX_TOKENS, contextWindow);
	const reasoning = supportsReasoning(payload.default_reasoning_level, payload.supported_reasoning_levels);
	const input = normalizeInputModalities(payload.input_modalities);
	const preferWebsockets = toBoolean(payload.prefer_websockets) === true;
	const useResponsesLite = toBoolean(payload.use_responses_lite) === true;
	const priority = toFiniteNumber(payload.priority) ?? Number.MAX_SAFE_INTEGER;

	return {
		priority,
		model: {
			id: slug,
			name,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl,
			reasoning,
			input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			remoteCompaction: CODEX_REMOTE_COMPACTION,
			contextWindow,
			maxTokens,
			...(preferWebsockets ? { preferWebsockets: true } : {}),
			...(useResponsesLite ? { useResponsesLite: true } : {}),
			...(priority !== Number.MAX_SAFE_INTEGER ? { priority } : {}),
		},
	};
}

function supportsReasoning(defaultReasoningLevel: unknown, supportedReasoningLevels: unknown): boolean {
	const defaultLevel = toNonEmptyString(defaultReasoningLevel)?.toLowerCase();
	if (defaultLevel && defaultLevel !== "none") {
		return true;
	}

	if (!Array.isArray(supportedReasoningLevels)) {
		return false;
	}

	for (const level of supportedReasoningLevels) {
		const parsedLevel = codexReasoningPresetSchema(level);
		if (parsedLevel instanceof type.errors) {
			continue;
		}
		const effort = toNonEmptyString(parsedLevel.effort)?.toLowerCase();
		if (effort && effort !== "none") {
			return true;
		}
	}

	return false;
}

function normalizeInputModalities(inputModalities: unknown): ("text" | "image")[] {
	if (!Array.isArray(inputModalities)) {
		return ["text", "image"];
	}

	const set = new Set<"text" | "image">();
	for (const modality of inputModalities) {
		const normalized = toNonEmptyString(modality)?.toLowerCase();
		if (normalized === "text" || normalized === "image") {
			set.add(normalized);
		}
	}

	if (set.size === 0) {
		return ["text", "image"];
	}

	const canonical: ("text" | "image")[] = ["text", "image"];
	return canonical.filter(modality => set.has(modality));
}

function getResponseEtag(headers: Headers): string | undefined {
	const etag = headers.get("etag");
	if (!etag) {
		return undefined;
	}
	const trimmed = etag.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function toNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function toPositiveInt(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	if (value <= 0) {
		return null;
	}
	return Math.trunc(value);
}

function toFiniteNumber(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	return value;
}

function toBoolean(value: unknown): boolean | null {
	if (typeof value !== "boolean") {
		return null;
	}
	return value;
}
