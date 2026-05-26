import { UNK_CONTEXT_WINDOW, UNK_MAX_TOKENS } from "@oh-my-pi/pi-ai";
import * as z from "zod/v4";
import type { FetchImpl, Model } from "../../types";
import { getVertexAccessToken } from "../../providers/google-auth";

const API_VERSION = "v1";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 25;

const vertexOpenAIModelSchema = z.object({
	id: z.string().optional().catch(undefined),
	name: z.string().optional().catch(undefined),
	displayName: z.string().optional().catch(undefined),
});

const vertexOpenAIModelsResponseSchema = z.object({
	data: z
		.array(z.unknown())
		.optional()
		.transform(items => {
			if (!items) return [];
			const parsedItems: VertexOpenAIModelItem[] = [];
			for (const item of items) {
				const parsed = vertexOpenAIModelSchema.safeParse(item);
				if (parsed.success) parsedItems.push(parsed.data);
			}
			return parsedItems;
		}),
	nextPageToken: z.string().optional().catch(undefined),
});

type VertexOpenAIModelItem = z.infer<typeof vertexOpenAIModelSchema>;

/** Configuration for Vertex AI OpenAI-compatible model discovery. */
export interface VertexDiscoveryOptions {
	/** Google Cloud project ID hosting the Vertex AI endpoint. */
	project: string;
	/** Vertex AI location, for example `global` or `us-central1`. */
	location: string;
	/** Optional requested page size for model listing. */
	pageSize?: number;
	/** Maximum number of pages to request before stopping pagination. */
	maxPages?: number;
	/** Optional abort signal for HTTP requests. */
	signal?: AbortSignal;
	/** Optional fetch implementation override for tests. */
	fetch?: FetchImpl;
}

/**
 * Fetches models exposed by Vertex AI's OpenAI-compatible endpoint.
 *
 * Returns `null` on auth, transport, or protocol failures so callers can fall
 * back to cache/static models without surfacing discovery noise at startup.
 */
export async function fetchVertexOpenAIModels(
	options: VertexDiscoveryOptions,
): Promise<Model<"openai-completions">[] | null> {
	const project = options.project.trim();
	const location = options.location.trim();
	if (!project || !location) return null;

	const fetchImpl = options.fetch ?? fetch;
	const baseUrl = buildVertexOpenAIBaseUrl(project, location);
	const pageSize = normalizePositiveInt(options.pageSize, DEFAULT_PAGE_SIZE);
	const maxPages = normalizePositiveInt(options.maxPages, DEFAULT_MAX_PAGES);
	let accessToken: string;
	try {
		accessToken = await getVertexAccessToken({ signal: options.signal, fetch: fetchImpl });
	} catch {
		return null;
	}

	const modelsById = new Map<string, Model<"openai-completions">>();
	const seenTokens = new Set<string>();
	let nextPageToken: string | undefined;
	for (let page = 0; page < maxPages; page += 1) {
		const requestUrl = buildModelsUrl(baseUrl, pageSize, nextPageToken);
		let response: Response;
		try {
			response = await fetchImpl(requestUrl, {
				method: "GET",
				headers: { Authorization: `Bearer ${accessToken}` },
				signal: options.signal,
			});
		} catch {
			return null;
		}

		if (!response.ok) return null;

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return null;
		}

		const parsed = vertexOpenAIModelsResponseSchema.safeParse(payload);
		if (!parsed.success) return null;

		for (const item of parsed.data.data) {
			const model = normalizeModel(item, baseUrl);
			if (model) modelsById.set(model.id, model);
		}

		const token = normalizePageToken(parsed.data.nextPageToken);
		if (!token || seenTokens.has(token)) break;
		seenTokens.add(token);
		nextPageToken = token;
	}

	return Array.from(modelsById.values()).sort((left, right) => left.id.localeCompare(right.id));
}

/** Returns the stable Vertex AI OpenAI-compatible endpoint base URL. */
export function buildVertexOpenAIBaseUrl(project: string, location: string): string {
	const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
	return `https://${host}/${API_VERSION}/projects/${project}/locations/${location}/endpoints/openapi`;
}

function buildModelsUrl(baseUrl: string, pageSize: number, pageToken?: string): URL {
	const url = new URL(`${baseUrl}/models`);
	url.searchParams.set("pageSize", String(pageSize));
	if (pageToken) url.searchParams.set("pageToken", pageToken);
	return url;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	const normalized = Math.floor(value);
	return normalized > 0 ? normalized : fallback;
}

function normalizePageToken(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const token = value.trim();
	return token.length > 0 ? token : undefined;
}

function normalizeModel(item: VertexOpenAIModelItem, baseUrl: string): Model<"openai-completions"> | null {
	const id = normalizeModelId(item.id ?? item.name);
	if (!id) return null;
	return {
		id,
		name: normalizeModelName(item.displayName, id),
		api: "openai-completions",
		provider: "google-vertex",
		baseUrl,
		reasoning: inferReasoning(id),
		input: inferInput(id),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: UNK_CONTEXT_WINDOW,
		maxTokens: UNK_MAX_TOKENS,
	};
}

function normalizeModelId(value: string | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const marker = "/models/";
	const markerIndex = trimmed.lastIndexOf(marker);
	if (markerIndex >= 0) {
		const modelId = trimmed.slice(markerIndex + marker.length);
		const publisher = extractPublisher(trimmed.slice(0, markerIndex));
		return publisher ? `${publisher}/${modelId}` : modelId;
	}
	return trimmed;
}

function extractPublisher(prefix: string): string | undefined {
	const marker = "/publishers/";
	const markerIndex = prefix.lastIndexOf(marker);
	if (markerIndex < 0) return undefined;
	const publisher = prefix.slice(markerIndex + marker.length).trim();
	return publisher.length > 0 ? publisher : undefined;
}

function normalizeModelName(displayName: string | undefined, id: string): string {
	const trimmed = displayName?.trim();
	return trimmed ? trimmed : id;
}

function inferReasoning(id: string): boolean {
	const normalized = id.toLowerCase();
	return (
		normalized.includes("thinking") ||
		normalized.includes("reasoning") ||
		normalized.includes("glm-4.5") ||
		normalized.includes("glm-4.6") ||
		normalized.includes("glm-4.7") ||
		normalized.includes("glm-5") ||
		normalized.includes("gemini-2.5") ||
		normalized.includes("gemini-3")
	);
}

function inferInput(id: string): ("text" | "image")[] {
	const normalized = id.toLowerCase();
	if (
		normalized.includes("gemini") ||
		normalized.includes("vision") ||
		normalized.includes("image") ||
		normalized.includes("vl")
	) {
		return ["text", "image"];
	}
	return ["text"];
}
