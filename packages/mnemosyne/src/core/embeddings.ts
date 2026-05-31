import { mkdirSync } from "node:fs";
import {
	$env,
	$flag,
	extractHttpStatusFromError,
	fetchWithRetry,
	getFastembedCacheDir,
	logger,
} from "@oh-my-pi/pi-utils";
import type { EmbeddingModel } from "fastembed";
import { getMnemosyneRuntimeOptions, resolveEmbeddingProvider } from "./runtime-options";

export { cosineSimilarity } from "./vector-math";

export type Vector = Float32Array;
export type EmbeddingMatrix = Vector[];

export interface EmbeddingProvider {
	embed(texts: readonly string[]): unknown | Promise<unknown>;
	available?(): boolean | Promise<boolean>;
}

type StandardEmbeddingModel = Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>;

interface LocalEmbeddingModel {
	embed(texts: string[], batchSize?: number): unknown;
	queryEmbed?(query: string): Promise<number[]>;
}

type LocalModelInitOptions = {
	model: StandardEmbeddingModel;
	cacheDir?: string;
	showDownloadProgress?: boolean;
};
type LocalModelInitializer = (options: LocalModelInitOptions) => Promise<LocalEmbeddingModel>;

const QUERY_CACHE_MAX = 512;

let providerOverride: EmbeddingProvider | null = null;
let localModelPromise: Promise<LocalEmbeddingModel> | null = null;
let localModelInitializer: LocalModelInitializer = defaultLocalModelInitializer;
let apiCallCount = 0;
const queryCache = new Map<string, Vector>();

async function defaultLocalModelInitializer(options: LocalModelInitOptions): Promise<LocalEmbeddingModel> {
	await import("onnxruntime-node");
	const { FlagEmbedding } = await import("fastembed");
	return FlagEmbedding.init(options);
}

function activeEmbeddingOptions() {
	return getMnemosyneRuntimeOptions()?.embeddings;
}

function inTestRuntime(): boolean {
	return $env.NODE_ENV === "test" || $env.BUN_ENV === "test";
}

function embeddingsDisabled(): boolean {
	const active = activeEmbeddingOptions();
	if (active?.disabled !== undefined) {
		return active.disabled;
	}
	return $flag("MNEMOSYNE_NO_EMBEDDINGS");
}

function embeddingApiKey(): string {
	const active = activeEmbeddingOptions();
	if (active?.apiKey !== undefined) {
		return active.apiKey;
	}
	return $env.MNEMOSYNE_EMBEDDING_API_KEY || $env.OPENROUTER_API_KEY || $env.OPENAI_API_KEY || "";
}

function embeddingBaseUrl(): string {
	const active = activeEmbeddingOptions();
	if (active?.apiUrl !== undefined) {
		return active.apiUrl;
	}
	return $env.MNEMOSYNE_EMBEDDING_API_URL || $env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
}

function defaultModel(): string {
	const active = activeEmbeddingOptions();
	if (active?.model !== undefined) {
		return active.model;
	}
	return $env.MNEMOSYNE_EMBEDDING_MODEL || "BAAI/bge-small-en-v1.5";
}

export function isApiModel(modelName: string): boolean {
	if (
		modelName.startsWith("openai/") ||
		modelName.includes("text-embedding") ||
		modelName.startsWith("text-embedding")
	) {
		return true;
	}
	const active = activeEmbeddingOptions();
	const baseUrl = active?.apiUrl ?? ($env.MNEMOSYNE_EMBEDDING_API_URL || $env.OPENROUTER_BASE_URL);
	if (baseUrl !== undefined && baseUrl !== "" && !baseUrl.includes("openrouter.ai")) {
		return true;
	}
	return $flag("MNEMOSYNE_EMBEDDINGS_VIA_API");
}

const MODEL_DIMS: Record<string, number> = {
	"BAAI/bge-small-en-v1.5": 384,
	"BAAI/bge-base-en-v1.5": 768,
	"BAAI/bge-large-en-v1.5": 1024,
	"BAAI/bge-small-zh-v1.5": 512,
	"BAAI/bge-base-zh-v1.5": 768,
	"BAAI/bge-large-zh-v1.5": 1024,
	"intfloat/multilingual-e5-small": 384,
	"intfloat/multilingual-e5-base": 768,
	"intfloat/multilingual-e5-large": 1024,
	"BAAI/bge-m3": 1024,
	"BAAI/bge-multilingual-gemma2": 3584,
	"openai/text-embedding-3-small": 1536,
	"openai/text-embedding-3-large": 3072,
	"text-embedding-3-small": 1536,
	"text-embedding-3-large": 3072,
	"jina-embeddings-v5-omni-nano": 768,
	"jina-embeddings-v5-omni-small": 1024,
};
export function embeddingDimFor(modelName: string): number {
	const override = Number.parseInt($env.MNEMOSYNE_EMBEDDING_DIM ?? "", 10);
	if (Number.isFinite(override)) {
		return override;
	}
	return MODEL_DIMS[modelName] ?? 384;
}

function normalizeVector(input: unknown): Vector | null {
	if (input == null || typeof input !== "object") {
		return null;
	}
	if (!Array.isArray(input) && !ArrayBuffer.isView(input)) {
		return null;
	}
	if (input instanceof DataView) {
		return null;
	}

	const arr = input as ArrayLike<unknown>;
	const length = arr.length;
	if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
		return null;
	}
	if (input instanceof Float32Array) {
		for (let i = 0; i < input.length; i += 1) {
			if (!Number.isFinite(input[i])) {
				return null;
			}
		}
		return input;
	}

	const vector = new Float32Array(length);
	for (let i = 0; i < length; i += 1) {
		const value = Number(arr[i]);
		if (!Number.isFinite(value)) {
			return null;
		}
		vector[i] = value;
	}
	return vector;
}
function isVectorLike(value: unknown): boolean {
	if (value == null || typeof value !== "object") {
		return false;
	}
	// Accept Array or TypedArray (ArrayBuffer.isView), but reject DataView
	if (Array.isArray(value)) {
		return true;
	}
	if (ArrayBuffer.isView(value)) {
		// Reject DataView as it's not numeric-indexed
		return !(value instanceof DataView);
	}
	return false;
}

function appendNormalized(rows: Vector[], input: unknown): boolean {
	if (Array.isArray(input) && input.length > 0 && isVectorLike(input[0])) {
		for (const item of input) {
			const row = normalizeVector(item);
			if (row === null) {
				return false;
			}
			rows.push(row);
		}
		return true;
	}

	const vector = normalizeVector(input);
	if (vector !== null) {
		rows.push(vector);
		return true;
	}
	return false;
}

async function normalizeEmbeddingResult(result: unknown): Promise<EmbeddingMatrix | null> {
	const rows: Vector[] = [];
	if (Array.isArray(result)) {
		return appendNormalized(rows, result) ? rows : null;
	}
	if (result !== null && typeof result === "object" && Symbol.asyncIterator in result) {
		for await (const item of result as AsyncIterable<unknown>) {
			if (!appendNormalized(rows, item)) {
				return null;
			}
		}
		return rows;
	}
	if (result !== null && typeof result === "object" && Symbol.iterator in result) {
		for (const item of result as Iterable<unknown>) {
			if (!appendNormalized(rows, item)) {
				return null;
			}
		}
		return rows;
	}
	return null;
}

function cacheGet(key: string): Vector | null {
	const value = queryCache.get(key);
	if (value === undefined) {
		return null;
	}
	queryCache.delete(key);
	queryCache.set(key, value);
	return value;
}

function cacheSet(key: string, value: Vector): void {
	if (queryCache.has(key)) {
		queryCache.delete(key);
	}
	queryCache.set(key, value);
	if (queryCache.size > QUERY_CACHE_MAX) {
		const oldest = queryCache.keys().next().value as string | undefined;
		if (oldest !== undefined) {
			queryCache.delete(oldest);
		}
	}
}

const KNOWN_MODEL_NAMES: Record<string, string> = {
	"BAAI/bge-small-en-v1.5": "fast-bge-small-en-v1.5",
	"BAAI/bge-base-en-v1.5": "fast-bge-base-en-v1.5",
	"BAAI/bge-small-en": "fast-bge-small-en",
	"BAAI/bge-base-en": "fast-bge-base-en",
	"BAAI/bge-small-zh-v1.5": "fast-bge-small-zh-v1.5",
	"intfloat/multilingual-e5-large": "fast-multilingual-e5-large",
	"sentence-transformers/all-MiniLM-L6-v2": "fast-all-MiniLM-L6-v2",
};
function fastembedModelName(modelName: string): StandardEmbeddingModel | null {
	// Fastembed `EmbeddingModel` enum string values, inlined so resolving a model name
	// (and `available()`) never imports `fastembed` — its module eagerly loads the
	// `onnxruntime-node` native addon, which segfaults in some runtimes.
	const id = KNOWN_MODEL_NAMES[modelName];
	return id === undefined ? null : (id as StandardEmbeddingModel);
}

async function getLocalModel(): Promise<LocalEmbeddingModel | null> {
	if (isApiModel(defaultModel()) || embeddingsDisabled() || inTestRuntime()) {
		return null;
	}
	if (localModelPromise !== null) {
		return localModelPromise;
	}

	const modelName = fastembedModelName(defaultModel());
	if (modelName === null) {
		return null;
	}
	const cacheDir = getFastembedCacheDir();
	mkdirSync(cacheDir, { recursive: true });
	const loading = localModelInitializer({
		model: modelName,
		cacheDir,
		showDownloadProgress: false,
	});
	localModelPromise = loading;
	try {
		return await loading;
	} catch {
		if (localModelPromise === loading) localModelPromise = null;
		return null;
	}
}

async function embedApi(texts: readonly string[]): Promise<EmbeddingMatrix | null> {
	const baseUrl = embeddingBaseUrl();
	const isCustom = !baseUrl.includes("openrouter.ai");
	const apiKey = embeddingApiKey();
	if (!isCustom && apiKey === "") {
		return null;
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"HTTP-Referer": "https://mnemosyne.site",
		"X-Title": "Mnemosyne Embedding",
	};
	if (apiKey !== "") {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	try {
		const response = await fetchWithRetry(`${baseUrl.replace(/\/+$/, "")}/embeddings`, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: defaultModel(), input: texts }),
			signal: AbortSignal.timeout(30000),
			maxAttempts: 3,
			defaultDelayMs: attempt => 2 ** attempt * 1000,
		});
		if (!response.ok) {
			return null;
		}
		const data = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
		const rows = data.data;
		if (rows === undefined) {
			return null;
		}
		const vectors: Vector[] = [];
		for (const row of rows) {
			const vector = normalizeVector(row.embedding);
			if (vector === null) {
				return null;
			}
			vectors.push(vector);
		}
		apiCallCount += 1;
		return vectors;
	} catch (error) {
		logger.debug("mnemosyne embedding request failed", { status: extractHttpStatusFromError(error) });
		return null;
	}
}

async function providerAvailable(provider: EmbeddingProvider): Promise<boolean> {
	if (provider.available === undefined) {
		return true;
	}
	try {
		return await provider.available();
	} catch {
		return false;
	}
}

export function setEmbeddingProviderForTests(provider: EmbeddingProvider | null | undefined): void {
	providerOverride = provider ?? null;
	queryCache.clear();
}

export const setEmbeddingProvider = setEmbeddingProviderForTests;

export function setLocalModelInitializerForTests(initializer: LocalModelInitializer | null | undefined): void {
	localModelInitializer = initializer ?? defaultLocalModelInitializer;
	localModelPromise = null;
	queryCache.clear();
}

export function resetEmbeddingProviderForTests(): void {
	providerOverride = null;
	localModelPromise = null;
	localModelInitializer = defaultLocalModelInitializer;
	apiCallCount = 0;
	queryCache.clear();
}

export const resetEmbeddingStateForTests = resetEmbeddingProviderForTests;

export async function available(): Promise<boolean> {
	if (embeddingsDisabled()) {
		return false;
	}
	const active = activeEmbeddingOptions();
	const activeProvider = resolveEmbeddingProvider(active?.provider);
	if (activeProvider !== undefined) {
		return providerAvailable(activeProvider);
	}
	if (providerOverride !== null) {
		return providerAvailable(providerOverride);
	}
	if (isApiModel(defaultModel())) {
		const baseUrl = active?.apiUrl ?? ($env.MNEMOSYNE_EMBEDDING_API_URL || $env.OPENROUTER_BASE_URL);
		if (baseUrl !== undefined && baseUrl !== "" && !baseUrl.includes("openrouter.ai")) {
			return true;
		}
		return embeddingApiKey() !== "";
	}
	if (inTestRuntime()) {
		return false;
	}
	return fastembedModelName(defaultModel()) !== null;
}

export function availableApi(): boolean {
	return embeddingApiKey() !== "";
}

export async function embedQuery(text: string): Promise<Vector | null> {
	if (text === "" || embeddingsDisabled()) {
		return null;
	}
	const cached = cacheGet(text);
	if (cached !== null) {
		return cached;
	}
	const vectors = await embed([text]);
	const vector = vectors?.[0] ?? null;
	if (vector !== null) {
		cacheSet(text, vector);
	}
	return vector;
}

export async function embed(texts: readonly string[]): Promise<EmbeddingMatrix | null> {
	if (texts.length === 0 || embeddingsDisabled()) {
		return null;
	}
	const activeProvider = resolveEmbeddingProvider(activeEmbeddingOptions()?.provider);
	if (activeProvider !== undefined) {
		try {
			return await normalizeEmbeddingResult(await activeProvider.embed(texts));
		} catch {
			return null;
		}
	}
	if (providerOverride !== null) {
		try {
			return await normalizeEmbeddingResult(await providerOverride.embed(texts));
		} catch {
			return null;
		}
	}
	if (isApiModel(defaultModel())) {
		return embedApi(texts);
	}
	if (texts.length === 1) {
		const cached = cacheGet(texts[0] ?? "");
		if (cached !== null) {
			return [cached];
		}
	}
	const model = await getLocalModel();
	if (model === null) {
		return null;
	}
	try {
		const vectors = await normalizeEmbeddingResult(await model.embed([...texts]));
		if (vectors !== null && vectors.length === 1) {
			const vector = vectors[0];
			if (vector !== undefined) {
				cacheSet(texts[0] ?? "", vector);
			}
		}
		return vectors;
	} catch {
		return null;
	}
}

export function getEmbeddingApiCallCountForTests(): number {
	return apiCallCount;
}

export const DEFAULT_MODEL = defaultModel();
export const EMBEDDING_DIM = embeddingDimFor(DEFAULT_MODEL);
