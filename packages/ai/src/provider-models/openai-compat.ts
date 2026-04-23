import type { ModelManagerOptions } from "../model-manager";
import { getBundledModels, getBundledProviders } from "../models";
import type { Api, Model } from "../types";
import { isAnthropicOAuthToken, isRecord, toNumber, toPositiveNumber } from "../utils";
import {
	fetchOpenAICompatibleModels,
	type OpenAICompatibleModelMapperContext,
	type OpenAICompatibleModelRecord,
} from "../utils/discovery/openai-compatible";
import { getGitHubCopilotBaseUrl, OPENCODE_HEADERS, parseGitHubCopilotApiKey } from "../utils/oauth/github-copilot";

const MODELS_DEV_URL = "https://models.dev/api.json";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_OAUTH_BETA =
	"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05";

export interface ModelsDevModel {
	id?: string;
	name?: string;
	tool_call?: boolean;
	reasoning?: boolean;
	limit?: {
		context?: number;
		output?: number;
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
	modalities?: {
		input?: string[];
	};
	status?: string;
	provider?: { npm?: string };
}

function toModelName(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function toInputCapabilities(value: unknown): ("text" | "image")[] {
	if (!Array.isArray(value)) {
		return ["text"];
	}
	const supportsImage = value.some(item => item === "image");
	return supportsImage ? ["text", "image"] : ["text"];
}

async function fetchModelsDevPayload(fetchImpl: typeof fetch = fetch): Promise<unknown> {
	const response = await fetchImpl(MODELS_DEV_URL, {
		method: "GET",
		headers: { Accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error(`models.dev fetch failed: ${response.status}`);
	}
	return response.json();
}

function mapAnthropicModelsDev(payload: unknown, baseUrl: string): Model<"anthropic-messages">[] {
	if (!isRecord(payload)) {
		return [];
	}
	const anthropicPayload = payload.anthropic;
	if (!isRecord(anthropicPayload)) {
		return [];
	}
	const modelsValue = anthropicPayload.models;
	if (!isRecord(modelsValue)) {
		return [];
	}

	const models: Model<"anthropic-messages">[] = [];
	for (const [modelId, rawModel] of Object.entries(modelsValue)) {
		if (!isRecord(rawModel)) {
			continue;
		}
		const model = rawModel as ModelsDevModel;
		if (model.tool_call !== true) {
			continue;
		}
		models.push({
			id: modelId,
			name: toModelName(model.name, modelId),
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl,
			reasoning: model.reasoning === true,
			input: toInputCapabilities(model.modalities?.input),
			cost: {
				input: toNumber(model.cost?.input) ?? 0,
				output: toNumber(model.cost?.output) ?? 0,
				cacheRead: toNumber(model.cost?.cache_read) ?? 0,
				cacheWrite: toNumber(model.cost?.cache_write) ?? 0,
			},
			contextWindow: toPositiveNumber(model.limit?.context, UNK_CONTEXT_WINDOW),
			maxTokens: toPositiveNumber(model.limit?.output, UNK_MAX_TOKENS),
		});
	}

	models.sort((left, right) => left.id.localeCompare(right.id));
	return models;
}

function buildAnthropicDiscoveryHeaders(apiKey: string): Record<string, string> {
	const oauthToken = isAnthropicOAuthToken(apiKey);
	const headers: Record<string, string> = {
		"anthropic-version": "2023-06-01",
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-beta": ANTHROPIC_OAUTH_BETA,
	};
	if (oauthToken) {
		headers.Authorization = `Bearer ${apiKey}`;
	} else {
		headers["x-api-key"] = apiKey;
	}
	return headers;
}

function buildAnthropicReferenceMap(
	modelsDevModels: readonly Model<"anthropic-messages">[],
): Map<string, Model<"anthropic-messages">> {
	const merged = new Map<string, Model<"anthropic-messages">>();
	for (const model of modelsDevModels) {
		merged.set(model.id, model);
	}
	// Anthropic /v1/models does not carry token limits, so bundled metadata stays canonical
	// for known models while models.dev only fills gaps for newly discovered ids.
	const bundledModels = getBundledModels("anthropic").filter(
		(model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages",
	);
	for (const model of bundledModels) {
		merged.set(model.id, model);
	}
	return merged;
}

function mapWithBundledReference<TApi extends Api>(
	entry: OpenAICompatibleModelRecord,
	defaults: Model<TApi>,
	reference: Model<TApi> | undefined,
): Model<TApi> {
	const name = toModelName(entry.name, reference?.name ?? defaults.name);
	if (!reference) {
		return {
			...defaults,
			name,
		};
	}
	return {
		...reference,
		id: defaults.id,
		name,
		baseUrl: defaults.baseUrl,
		contextWindow: toPositiveNumber(entry.context_length, reference.contextWindow),
		maxTokens: toPositiveNumber(entry.max_completion_tokens, reference.maxTokens),
	};
}

function createBundledReferenceMap<TApi extends Api>(
	provider: Parameters<typeof getBundledModels>[0],
): Map<string, Model<TApi>> {
	const references = new Map<string, Model<TApi>>();
	for (const model of getBundledModels(provider)) {
		references.set(model.id, model as Model<TApi>);
	}
	return references;
}

/**
 * Returns a lookup that resolves a model ID to a bundled reference, preferring
 * the provider-specific entry over a cross-provider fallback. The global fallback
 * picks the best entry across all providers (largest contextWindow, then maxTokens,
 * then canonical OpenAI), but proxy providers (Copilot, nanogpt, etc.) impose their
 * own limits that are typically lower than native provider limits, so the
 * provider-specific entry must win.
 */
function createReferenceResolver<TApi extends Api>(
	providerRefs: Map<string, Model<TApi>>,
): (modelId: string) => Model<TApi> | undefined {
	const globalRefs = new Map<string, Model<Api>>();
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider as Parameters<typeof getBundledModels>[0])) {
			const candidate = model as Model<Api>;
			const existing = globalRefs.get(candidate.id);
			if (!existing) {
				globalRefs.set(candidate.id, candidate);
			} else if (candidate.contextWindow !== existing.contextWindow) {
				if (candidate.contextWindow > existing.contextWindow) globalRefs.set(candidate.id, candidate);
			} else if (candidate.maxTokens !== existing.maxTokens) {
				if (candidate.maxTokens > existing.maxTokens) globalRefs.set(candidate.id, candidate);
			} else if (existing.provider !== "openai" && candidate.provider === "openai") {
				// When limits tie, prefer OpenAI as canonical so generic OpenAI-family
				// providers inherit OpenAI pricing/capabilities instead of proxy metadata.
				globalRefs.set(candidate.id, candidate);
			}
		}
	}
	return (modelId: string) => providerRefs.get(modelId) ?? (globalRefs.get(modelId) as Model<TApi> | undefined);
}

function normalizeAnthropicBaseUrl(baseUrl: string | undefined, fallback: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return fallback;
	}
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toAnthropicDiscoveryBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

function normalizeOllamaBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return "http://127.0.0.1:11434/v1";
	}
	const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function toOllamaNativeBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
}

async function fetchOllamaNativeModels(baseUrl: string): Promise<Model<"openai-responses">[] | null> {
	const nativeBaseUrl = toOllamaNativeBaseUrl(baseUrl);
	let response: Response;
	try {
		response = await fetch(`${nativeBaseUrl}/api/tags`, {
			method: "GET",
			headers: { Accept: "application/json" },
		});
	} catch {
		return null;
	}
	if (!response.ok) {
		return null;
	}
	const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
	const entries = payload.models ?? [];
	const models: Model<"openai-responses">[] = [];
	for (const entry of entries) {
		const id = entry.model ?? entry.name;
		if (!id) {
			continue;
		}
		models.push({
			id,
			name: entry.name ?? id,
			api: "openai-responses",
			provider: "ollama",
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		});
	}
	return models.sort((left, right) => left.id.localeCompare(right.id));
}

const OPENAI_NON_RESPONSES_PREFIXES = [
	"text-embedding",
	"whisper-",
	"tts-",
	"omni-moderation",
	"omni-transcribe",
	"omni-speech",
	"gpt-image-",
	"gpt-realtime",
] as const;

function isLikelyOpenAIResponsesModelId(id: string, references: Map<string, Model<"openai-responses">>): boolean {
	const trimmed = id.trim();
	if (!trimmed) {
		return false;
	}
	if (references.has(trimmed)) {
		return true;
	}
	const normalized = trimmed.toLowerCase();
	if (OPENAI_NON_RESPONSES_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
		return false;
	}
	if (normalized.includes("embedding")) {
		return false;
	}
	return (
		normalized.startsWith("gpt-") ||
		normalized.startsWith("o1") ||
		normalized.startsWith("o3") ||
		normalized.startsWith("o4") ||
		normalized.startsWith("chatgpt")
	);
}

const NANO_GPT_NON_TEXT_MODEL_TOKENS = [
	"embedding",
	"image",
	"vision",
	"audio",
	"speech",
	"transcribe",
	"moderation",
	"realtime",
	"whisper",
	"tts",
] as const;

/** Regex matching NanoGPT `:thinking` suffixed model IDs (with or without a level). */
const NANO_GPT_THINKING_SUFFIX_RE = /:thinking(:[^:]+)?$/;

function isLikelyNanoGptTextModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	if (NANO_GPT_THINKING_SUFFIX_RE.test(normalized)) {
		return false;
	}
	return !NANO_GPT_NON_TEXT_MODEL_TOKENS.some(token => normalized.includes(token));
}

type SimpleProviderConfig = { apiKey?: string; baseUrl?: string };

function createSimpleOpenAICompletionsOptions(
	providerId: Parameters<typeof getBundledModels>[0],
	defaultBaseUrl: string,
	config?: SimpleProviderConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? defaultBaseUrl;
	const references = createBundledReferenceMap<"openai-completions">(providerId);
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: providerId,
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						return mapWithBundledReference(entry, defaults, reference);
					},
				}),
		}),
	};
}

function createSimpleAnthropicProviderOptions(
	providerId: Parameters<typeof getBundledModels>[0],
	defaultBaseUrlFallback: string,
	config?: SimpleProviderConfig,
): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeAnthropicBaseUrl(config?.baseUrl, defaultBaseUrlFallback);
	const discoveryBaseUrl = toAnthropicDiscoveryBaseUrl(baseUrl);
	const references = createBundledReferenceMap<"anthropic-messages">(providerId);
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "anthropic-messages",
					provider: providerId,
					baseUrl: discoveryBaseUrl,
					headers: buildAnthropicDiscoveryHeaders(apiKey),
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						const model = mapWithBundledReference(entry, defaults, reference);
						return {
							...model,
							name: toModelName(entry.display_name, model.name),
							baseUrl,
						};
					},
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 1. OpenAI
// ---------------------------------------------------------------------------

export interface OpenAIModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function openaiModelManagerOptions(config?: OpenAIModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.openai.com/v1";
	const references = createBundledReferenceMap<"openai-responses">("openai");
	return {
		providerId: "openai",
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-responses",
					provider: "openai",
					baseUrl,
					apiKey,
					filterModel: (_entry, model) => isLikelyOpenAIResponsesModelId(model.id, references),
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						return mapWithBundledReference(entry, defaults, reference);
					},
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 2. Groq
// ---------------------------------------------------------------------------

export interface GroqModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function groqModelManagerOptions(config?: GroqModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("groq", "https://api.groq.com/openai/v1", config);
}

// ---------------------------------------------------------------------------
// 3. Cerebras
// ---------------------------------------------------------------------------

export interface CerebrasModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function cerebrasModelManagerOptions(
	config?: CerebrasModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("cerebras", "https://api.cerebras.ai/v1", config);
}

// ---------------------------------------------------------------------------
// 4. Hugging Face
// ---------------------------------------------------------------------------

export interface HuggingfaceModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function huggingfaceModelManagerOptions(
	config?: HuggingfaceModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("huggingface", "https://router.huggingface.co/v1", config);
}

// ---------------------------------------------------------------------------
// 5. NVIDIA
// ---------------------------------------------------------------------------

export interface NvidiaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function nvidiaModelManagerOptions(
	config?: NvidiaModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("nvidia", "https://integrate.api.nvidia.com/v1", config);
}

// ---------------------------------------------------------------------------
// 6. xAI
// ---------------------------------------------------------------------------

export interface XaiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function xaiModelManagerOptions(config?: XaiModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("xai", "https://api.x.ai/v1", config);
}

// ---------------------------------------------------------------------------
// 7. Mistral
// ---------------------------------------------------------------------------

export interface MistralModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function mistralModelManagerOptions(
	config?: MistralModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("mistral", "https://api.mistral.ai/v1", config);
}

// ---------------------------------------------------------------------------
// 8. OpenCode
// ---------------------------------------------------------------------------

export interface OpenCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

function openCodeModelManagerOptions(
	providerId: "opencode-go" | "opencode-zen",
	defaultBaseUrl: string,
	config?: OpenCodeModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? defaultBaseUrl;
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: providerId,
					baseUrl,
					apiKey,
				}),
		}),
	};
}

export function opencodeZenModelManagerOptions(
	config?: OpenCodeModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return openCodeModelManagerOptions("opencode-zen", "https://opencode.ai/zen/v1", config);
}

export function opencodeGoModelManagerOptions(
	config?: OpenCodeModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return openCodeModelManagerOptions("opencode-go", "https://opencode.ai/zen/go/v1", config);
}

// ---------------------------------------------------------------------------
// 9. Ollama
// ---------------------------------------------------------------------------

export interface OllamaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function ollamaModelManagerOptions(config?: OllamaModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeOllamaBaseUrl(config?.baseUrl);
	const references = createBundledReferenceMap<"openai-responses">("ollama" as Parameters<typeof getBundledModels>[0]);
	return {
		providerId: "ollama",
		fetchDynamicModels: async () => {
			const openAiCompatible = await fetchOpenAICompatibleModels({
				api: "openai-responses",
				provider: "ollama",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					if (!reference) {
						return {
							...defaults,
							name: toModelName(entry.name, defaults.name),
							contextWindow: 128000,
							maxTokens: 8192,
						};
					}
					return mapWithBundledReference(entry, defaults, reference);
				},
			});
			if (openAiCompatible && openAiCompatible.length > 0) {
				return openAiCompatible;
			}
			const nativeFallback = await fetchOllamaNativeModels(baseUrl);
			if (nativeFallback && nativeFallback.length > 0) {
				return nativeFallback;
			}
			return openAiCompatible;
		},
	};
}

// ---------------------------------------------------------------------------
// 10. OpenRouter
// ---------------------------------------------------------------------------

export interface OpenRouterModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function openrouterModelManagerOptions(
	config?: OpenRouterModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://openrouter.ai/api/v1";
	return {
		providerId: "openrouter",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "openrouter",
				baseUrl,
				apiKey,
				headers: {
					"X-Title": "Oh-My-Pi",
				},
				filterModel: (entry: OpenAICompatibleModelRecord) => {
					const params = entry.supported_parameters;
					return Array.isArray(params) && params.includes("tools");
				},
				mapModel: (
					entry: OpenAICompatibleModelRecord,
					defaults: Model<"openai-completions">,
					_context: OpenAICompatibleModelMapperContext<"openai-completions">,
				): Model<"openai-completions"> => {
					const pricing = entry.pricing as Record<string, unknown> | undefined;
					const params = Array.isArray(entry.supported_parameters) ? (entry.supported_parameters as string[]) : [];
					const modality = String((entry.architecture as Record<string, unknown> | undefined)?.modality ?? "");
					const topProvider = entry.top_provider as Record<string, unknown> | undefined;

					const supportsToolChoice = params.includes("tool_choice");

					return {
						...defaults,
						reasoning: params.includes("reasoning"),
						input: modality.includes("image") ? ["text", "image"] : ["text"],
						cost: {
							input: parseFloat(String(pricing?.prompt ?? "0")) * 1_000_000,
							output: parseFloat(String(pricing?.completion ?? "0")) * 1_000_000,
							cacheRead: parseFloat(String(pricing?.input_cache_read ?? "0")) * 1_000_000,
							cacheWrite: parseFloat(String(pricing?.input_cache_write ?? "0")) * 1_000_000,
						},
						contextWindow:
							typeof entry.context_length === "number" ? entry.context_length : defaults.contextWindow,
						maxTokens:
							typeof topProvider?.max_completion_tokens === "number"
								? topProvider.max_completion_tokens
								: defaults.maxTokens,
						...(!supportsToolChoice && {
							compat: { supportsToolChoice: false },
						}),
					};
				},
			}),
	};
}

const ZENMUX_OPENAI_BASE_URL = "https://zenmux.ai/api/v1";
const ZENMUX_ANTHROPIC_BASE_URL = "https://zenmux.ai/api/anthropic";

function normalizeZenMuxOpenAiBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return ZENMUX_OPENAI_BASE_URL;
	}
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toZenMuxAnthropicBaseUrl(openAiBaseUrl: string): string {
	try {
		const parsed = new URL(openAiBaseUrl);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = trimmedPath.endsWith("/api/v1")
			? `${trimmedPath.slice(0, -"/api/v1".length)}/api/anthropic`
			: "/api/anthropic";
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return ZENMUX_ANTHROPIC_BASE_URL;
	}
}

function isZenMuxAnthropicModel(entry: OpenAICompatibleModelRecord, modelId: string): boolean {
	if (typeof entry.owned_by === "string" && entry.owned_by.toLowerCase() === "anthropic") {
		return true;
	}
	return modelId.toLowerCase().startsWith("anthropic/");
}

function getZenMuxPricingValue(pricings: Record<string, unknown> | undefined, key: string): number {
	const bucket = pricings?.[key];
	if (!Array.isArray(bucket)) {
		return 0;
	}
	for (const item of bucket) {
		if (!isRecord(item)) {
			continue;
		}
		const value = toNumber(item.value);
		if (value !== undefined) {
			return value;
		}
	}
	return 0;
}

function getZenMuxCacheWritePrice(pricings: Record<string, unknown> | undefined): number {
	const oneHour = getZenMuxPricingValue(pricings, "input_cache_write_1_h");
	if (oneHour > 0) {
		return oneHour;
	}
	const fiveMinute = getZenMuxPricingValue(pricings, "input_cache_write_5_min");
	if (fiveMinute > 0) {
		return fiveMinute;
	}
	return getZenMuxPricingValue(pricings, "input_cache_write");
}

// ---------------------------------------------------------------------------
// 10.5 ZenMux
// ---------------------------------------------------------------------------

export interface ZenMuxModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function zenmuxModelManagerOptions(config?: ZenMuxModelManagerConfig): ModelManagerOptions<Api> {
	const apiKey = config?.apiKey;
	const openAiBaseUrl = normalizeZenMuxOpenAiBaseUrl(config?.baseUrl);
	const anthropicBaseUrl = toZenMuxAnthropicBaseUrl(openAiBaseUrl);
	return {
		providerId: "zenmux",
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels<Api>({
					api: "openai-completions",
					provider: "zenmux",
					baseUrl: openAiBaseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const pricings = isRecord(entry.pricings) ? entry.pricings : undefined;
						const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
						const isAnthropicModel = isZenMuxAnthropicModel(entry, defaults.id);
						return {
							...defaults,
							name: toModelName(entry.display_name, defaults.name),
							api: isAnthropicModel ? "anthropic-messages" : "openai-completions",
							baseUrl: isAnthropicModel ? anthropicBaseUrl : openAiBaseUrl,
							reasoning: capabilities?.reasoning === true || defaults.reasoning,
							input: toInputCapabilities(entry.input_modalities),
							cost: {
								input: getZenMuxPricingValue(pricings, "prompt"),
								output: getZenMuxPricingValue(pricings, "completion"),
								cacheRead: getZenMuxPricingValue(pricings, "input_cache_read"),
								cacheWrite: getZenMuxCacheWritePrice(pricings),
							},
							contextWindow: toPositiveNumber(entry.context_length, defaults.contextWindow),
							maxTokens: toPositiveNumber(entry.max_completion_tokens, defaults.maxTokens),
						};
					},
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 10.6 Kilo Gateway
// ---------------------------------------------------------------------------

export interface KiloModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function kiloModelManagerOptions(config?: KiloModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.kilo.ai/api/gateway";
	return {
		providerId: "kilo",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "kilo",
				baseUrl,
				apiKey,
			}),
	};
}

// ---------------------------------------------------------------------------
// Alibaba Coding Plan
// ---------------------------------------------------------------------------

export interface AlibabaCodingPlanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function alibabaCodingPlanModelManagerOptions(
	config?: AlibabaCodingPlanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://coding-intl.dashscope.aliyuncs.com/v1";
	const references = createBundledReferenceMap<"openai-completions">("alibaba-coding-plan");
	return {
		providerId: "alibaba-coding-plan",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "alibaba-coding-plan",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					return mapWithBundledReference(entry, defaults, reference);
				},
			}),
	};
}

// ---------------------------------------------------------------------------
// 11. Vercel AI Gateway
// ---------------------------------------------------------------------------

export interface VercelAiGatewayModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function vercelAiGatewayModelManagerOptions(
	config?: VercelAiGatewayModelManagerConfig,
): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://ai-gateway.vercel.sh";
	return {
		providerId: "vercel-ai-gateway",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "anthropic-messages",
				provider: "vercel-ai-gateway",
				baseUrl,
				apiKey,
				filterModel: (entry: OpenAICompatibleModelRecord) => {
					const tags = entry.tags;
					return Array.isArray(tags) && tags.includes("tool-use");
				},
				mapModel: (
					entry: OpenAICompatibleModelRecord,
					defaults: Model<"anthropic-messages">,
					_context: OpenAICompatibleModelMapperContext<"anthropic-messages">,
				): Model<"anthropic-messages"> => {
					const pricing = entry.pricing as Record<string, unknown> | undefined;
					const tags = Array.isArray(entry.tags) ? (entry.tags as string[]) : [];

					return {
						...defaults,
						reasoning: tags.includes("reasoning"),
						input: tags.includes("vision") ? ["text", "image"] : ["text"],
						cost: {
							input: (toNumber(pricing?.input) ?? 0) * 1_000_000,
							output: (toNumber(pricing?.output) ?? 0) * 1_000_000,
							cacheRead: (toNumber(pricing?.input_cache_read) ?? 0) * 1_000_000,
							cacheWrite: (toNumber(pricing?.input_cache_write) ?? 0) * 1_000_000,
						},
						contextWindow:
							typeof entry.context_window === "number" ? entry.context_window : defaults.contextWindow,
						maxTokens: typeof entry.max_tokens === "number" ? entry.max_tokens : defaults.maxTokens,
					};
				},
			}),
	};
}

// ---------------------------------------------------------------------------
// 12. Kimi Code
// ---------------------------------------------------------------------------

export interface KimiCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function kimiCodeModelManagerOptions(
	config?: KimiCodeModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.kimi.com/coding/v1";
	return {
		providerId: "kimi-code",
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "kimi-code",
					baseUrl,
					apiKey,
					headers: {
						"User-Agent": "KimiCLI/1.0",
						"X-Msh-Platform": "kimi_cli",
					},
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: Model<"openai-completions">,
						_context: OpenAICompatibleModelMapperContext<"openai-completions">,
					): Model<"openai-completions"> => {
						const id = defaults.id;
						return {
							...defaults,
							name: typeof entry.display_name === "string" ? entry.display_name : defaults.name,
							reasoning: entry.supports_reasoning === true || id.includes("thinking"),
							input: entry.supports_image_in === true || id.includes("k2.5") ? ["text", "image"] : ["text"],
							contextWindow: typeof entry.context_length === "number" ? entry.context_length : 262144,
							maxTokens: 32000,
							compat: {
								thinkingFormat: "zai",
								reasoningContentField: "reasoning_content",
								supportsDeveloperRole: false,
							},
						};
					},
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 12.5. LM Studio
// ---------------------------------------------------------------------------

export interface LmStudioModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function lmStudioModelManagerOptions(
	config?: LmStudioModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? Bun.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
	const references = createBundledReferenceMap<"openai-completions">("lm-studio" as any);
	return {
		providerId: "lm-studio",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "lm-studio",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					return mapWithBundledReference(entry, defaults, reference);
				},
			}),
	};
}

// ---------------------------------------------------------------------------
// 13. Synthetic
// ---------------------------------------------------------------------------

export interface SyntheticModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function syntheticModelManagerOptions(
	config?: SyntheticModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.synthetic.new/openai/v1";
	const references = new Map(
		(getBundledModels("synthetic") as Model<"openai-completions">[]).map(model => [model.id, model]),
	);
	return {
		providerId: "synthetic",
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "synthetic",
					baseUrl,
					apiKey,
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: Model<"openai-completions">,
						_context: OpenAICompatibleModelMapperContext<"openai-completions">,
					): Model<"openai-completions"> => {
						const reference = references.get(defaults.id);
						const referenceSupportsImage = reference?.input.includes("image") ?? false;
						return {
							...(reference ? { ...reference, id: defaults.id, baseUrl } : defaults),
							name: toModelName(entry.name, reference?.name ?? defaults.name),
							reasoning: entry.supports_reasoning === true || (reference?.reasoning ?? false),
							input: entry.supports_vision === true || referenceSupportsImage ? ["text", "image"] : ["text"],
							contextWindow: toPositiveNumber(
								entry.context_length,
								reference?.contextWindow ?? defaults.contextWindow,
							),
							maxTokens: toPositiveNumber(entry.max_tokens, reference?.maxTokens ?? 8192),
						};
					},
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 14. Venice
// ---------------------------------------------------------------------------

export interface VeniceModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function veniceModelManagerOptions(
	config?: VeniceModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.venice.ai/api/v1";
	const references = createBundledReferenceMap<"openai-completions">("venice");
	return {
		providerId: "venice",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "venice",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					const model = mapWithBundledReference(entry, defaults, reference);
					return {
						...model,
						compat: { ...model.compat, supportsUsageInStreaming: false },
					};
				},
			}),
	};
}

// ---------------------------------------------------------------------------
// 15. Together
// ---------------------------------------------------------------------------

export interface TogetherModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function togetherModelManagerOptions(
	config?: TogetherModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("together", "https://api.together.xyz/v1", config);
}

// ---------------------------------------------------------------------------
// 16. Moonshot
// ---------------------------------------------------------------------------

export interface MoonshotModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function moonshotModelManagerOptions(
	config?: MoonshotModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.moonshot.ai/v1";
	const references = createBundledReferenceMap<"openai-completions">("moonshot");
	return {
		providerId: "moonshot",
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "moonshot",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						const model = mapWithBundledReference(entry, defaults, reference);
						const id = model.id.toLowerCase();
						const isThinking = id.includes("thinking");
						const isVision = id.includes("vision") || id.includes("vl") || id.includes("k2.5");
						return {
							...model,
							reasoning: isThinking || model.reasoning,
							input: isVision ? ["text", "image"] : model.input,
						};
					},
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 17. Qwen Portal
// ---------------------------------------------------------------------------

export interface QwenPortalModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function qwenPortalModelManagerOptions(
	config?: QwenPortalModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("qwen-portal", "https://portal.qwen.ai/v1", config);
}

// ---------------------------------------------------------------------------
// 18. Qianfan
// ---------------------------------------------------------------------------

export interface QianfanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function qianfanModelManagerOptions(
	config?: QianfanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("qianfan", "https://qianfan.baidubce.com/v2", config);
}

// ---------------------------------------------------------------------------
// 19. Cloudflare AI Gateway
// ---------------------------------------------------------------------------

export interface CloudflareAiGatewayModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function cloudflareAiGatewayModelManagerOptions(
	config?: CloudflareAiGatewayModelManagerConfig,
): ModelManagerOptions<"anthropic-messages"> {
	return createSimpleAnthropicProviderOptions(
		"cloudflare-ai-gateway",
		"https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic",
		config,
	);
}

// ---------------------------------------------------------------------------
// 20. Xiaomi
// ---------------------------------------------------------------------------

export interface XiaomiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function xiaomiModelManagerOptions(
	config?: XiaomiModelManagerConfig,
): ModelManagerOptions<"anthropic-messages"> {
	return createSimpleAnthropicProviderOptions("xiaomi", "https://api.xiaomimimo.com/anthropic", config);
}

// ---------------------------------------------------------------------------
// 21. LiteLLM
// ---------------------------------------------------------------------------

export interface LiteLLMModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function litellmModelManagerOptions(
	config?: LiteLLMModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "http://localhost:4000/v1";
	const references = createBundledReferenceMap<"openai-completions">("litellm");
	return {
		providerId: "litellm",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "litellm",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					return mapWithBundledReference(entry, defaults, reference);
				},
			}),
	};
}

// ---------------------------------------------------------------------------
// 22. vLLM
// ---------------------------------------------------------------------------

export interface VllmModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function vllmModelManagerOptions(config?: VllmModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "http://127.0.0.1:8000/v1";
	const references = createBundledReferenceMap<"openai-completions">("vllm" as Parameters<typeof getBundledModels>[0]);
	return {
		providerId: "vllm",
		fetchDynamicModels: () =>
			fetchOpenAICompatibleModels({
				api: "openai-completions",
				provider: "vllm",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					return mapWithBundledReference(entry, defaults, reference);
				},
			}),
	};
}

// ---------------------------------------------------------------------------
// 23. NanoGPT
// ---------------------------------------------------------------------------

export interface NanoGptModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function nanoGptModelManagerOptions(
	config?: NanoGptModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://nano-gpt.com/api/v1";
	const resolveReference = createReferenceResolver(
		createBundledReferenceMap<"openai-completions">("nanogpt" as Parameters<typeof getBundledModels>[0]),
	);
	return {
		providerId: "nanogpt",
		...(apiKey && {
			fetchDynamicModels: async () => {
				// Track base IDs that have :thinking variants so we can mark them reasoning-capable.
				const thinkingBaseIds = new Set<string>();
				const models = await fetchOpenAICompatibleModels({
					api: "openai-completions",
					provider: "nanogpt",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = resolveReference(defaults.id);
						const mapped = mapWithBundledReference(entry, defaults, reference);
						return { ...mapped, api: "openai-completions", provider: "nanogpt" };
					},
					filterModel: (_entry, model) => {
						const match = NANO_GPT_THINKING_SUFFIX_RE.exec(model.id);
						if (match) {
							thinkingBaseIds.add(model.id.slice(0, match.index));
							return false;
						}
						return isLikelyNanoGptTextModelId(model.id);
					},
				});
				if (!models) return null;
				// Mark base models as reasoning-capable when a :thinking variant existed.
				for (const model of models) {
					if (!model.reasoning && thinkingBaseIds.has(model.id)) {
						(model as { reasoning: boolean }).reasoning = true;
					}
				}
				return models;
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// 24. GitHub Copilot
// ---------------------------------------------------------------------------

export interface GithubCopilotModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

function inferCopilotApi(modelId: string): Api {
	if (/^claude-(haiku|sonnet|opus)-4([.-]|$)/.test(modelId)) {
		return "anthropic-messages";
	}
	if (modelId.startsWith("gpt-5") || modelId.startsWith("oswe")) {
		return "openai-responses";
	}
	return "openai-completions";
}

function extractCopilotLimits(entry: OpenAICompatibleModelRecord): {
	maxPromptTokens?: number;
	maxContextWindowTokens?: number;
	maxOutputTokens?: number;
	maxNonStreamingOutputTokens?: number;
} {
	if (!isRecord(entry.capabilities)) {
		return {};
	}
	const limitsValue = entry.capabilities.limits;
	if (!isRecord(limitsValue)) {
		return {};
	}
	return {
		maxPromptTokens: toNumber(limitsValue.max_prompt_tokens),
		maxContextWindowTokens: toNumber(limitsValue.max_context_window_tokens),
		maxOutputTokens: toNumber(limitsValue.max_output_tokens),
		maxNonStreamingOutputTokens: toNumber(limitsValue.max_non_streaming_output_tokens),
	};
}

export function githubCopilotModelManagerOptions(config?: GithubCopilotModelManagerConfig): ModelManagerOptions<Api> {
	const rawApiKey = config?.apiKey;
	const configuredBaseUrl = config?.baseUrl ?? "https://api.githubcopilot.com";
	const parsedApiKey = rawApiKey ? parseGitHubCopilotApiKey(rawApiKey) : undefined;
	const apiKey = parsedApiKey?.accessToken;
	const baseUrl =
		parsedApiKey?.enterpriseUrl && configuredBaseUrl.includes("githubcopilot.com")
			? getGitHubCopilotBaseUrl(parsedApiKey.enterpriseUrl)
			: configuredBaseUrl;
	const providerRefs = createBundledReferenceMap<Api>("github-copilot");
	const resolveReference = createReferenceResolver(providerRefs);
	return {
		providerId: "github-copilot",
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels<Api>({
					api: "openai-completions",
					provider: "github-copilot",
					baseUrl,
					apiKey,
					headers: OPENCODE_HEADERS,
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: Model<Api>,
						_context: OpenAICompatibleModelMapperContext<Api>,
					): Model<Api> => {
						const reference = resolveReference(defaults.id);
						const copilotLimits = extractCopilotLimits(entry);
						// Copilot exposes token limits under capabilities.limits.*.
						// max_prompt_tokens is the prompt capacity (what OMP calls contextWindow).
						// max_context_window_tokens is the total window (prompt + output budget)
						// and must NOT be used for contextWindow — it inflates the limit and
						// breaks compaction thresholds, overflow detection, and promotion.
						// The OpenAI-compatible root-level `context_length` field mirrors the
						// total window (e.g. 400k for gpt-5.4), so Copilot's max_prompt_tokens
						// (the true prompt budget) must take precedence whenever it is present.
						const contextWindowFallback = toPositiveNumber(
							entry.context_length,
							reference?.contextWindow ?? defaults.contextWindow,
						);
						const contextWindow = toPositiveNumber(
							copilotLimits.maxPromptTokens,
							reference ? Math.min(contextWindowFallback, reference.contextWindow) : contextWindowFallback,
						);
						const maxTokens = toPositiveNumber(
							entry.max_completion_tokens,
							toPositiveNumber(
								copilotLimits.maxOutputTokens,
								toPositiveNumber(
									copilotLimits.maxNonStreamingOutputTokens,
									reference?.maxTokens ?? defaults.maxTokens,
								),
							),
						);
						const name =
							typeof entry.name === "string" && entry.name.trim().length > 0
								? entry.name
								: (reference?.name ?? defaults.name);
						const api = inferCopilotApi(defaults.id);
						if (reference) {
							return {
								...reference,
								api,
								provider: "github-copilot",
								baseUrl,
								name,
								contextWindow,
								maxTokens,
								headers: { ...OPENCODE_HEADERS, ...(providerRefs.get(defaults.id)?.headers ?? {}) },
								...(api === "openai-completions"
									? {
											compat: {
												supportsStore: false,
												supportsDeveloperRole: false,
												supportsReasoningEffort: false,
											},
										}
									: {}),
							};
						}
						return {
							...defaults,
							api,
							baseUrl,
							name,
							contextWindow,
							maxTokens,
							headers: { ...OPENCODE_HEADERS },
							...(api === "openai-completions"
								? {
										compat: {
											supportsStore: false,
											supportsDeveloperRole: false,
											supportsReasoningEffort: false,
										},
									}
								: {}),
						};
					},
				}),
		}),
	};
}

// ---------------------------------------------------------------------------
// 24. Anthropic
// ---------------------------------------------------------------------------

export interface AnthropicModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function anthropicModelManagerOptions(
	config?: AnthropicModelManagerConfig,
): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? ANTHROPIC_BASE_URL;
	return {
		providerId: "anthropic",
		modelsDev: {
			fetch: fetchModelsDevPayload,
			map: payload => mapAnthropicModelsDev(payload, baseUrl),
		},
		...(apiKey && {
			fetchDynamicModels: async () => {
				const modelsDevModels = await fetchModelsDevPayload()
					.then(payload => mapAnthropicModelsDev(payload, baseUrl))
					.catch(() => []);
				const references = buildAnthropicReferenceMap(modelsDevModels);
				return (
					fetchOpenAICompatibleModels({
						api: "anthropic-messages",
						provider: "anthropic",
						baseUrl,
						headers: buildAnthropicDiscoveryHeaders(apiKey),
						mapModel: (
							entry: OpenAICompatibleModelRecord,
							defaults: Model<"anthropic-messages">,
							_context: OpenAICompatibleModelMapperContext<"anthropic-messages">,
						): Model<"anthropic-messages"> => {
							const discoveredName = typeof entry.display_name === "string" ? entry.display_name : defaults.name;
							const reference = references.get(defaults.id);
							if (!reference) {
								return {
									...defaults,
									name: discoveredName,
								};
							}
							return {
								...reference,
								id: defaults.id,
								name: discoveredName,
								api: "anthropic-messages",
								provider: "anthropic",
								baseUrl,
							};
						},
					}) ?? null
				);
			},
		}),
	};
}

// ---------------------------------------------------------------------------
// Models.dev provider descriptors for generate-models.ts
// ---------------------------------------------------------------------------

export const UNK_CONTEXT_WINDOW = 222_222;
export const UNK_MAX_TOKENS = 8_888;

/** Describes how to map models.dev API data for a single provider. */
export interface ModelsDevProviderDescriptor {
	/** Key in the models.dev API response JSON (e.g., "anthropic", "amazon-bedrock") */
	modelsDevKey: string;
	/** Provider ID in our system */
	providerId: string;
	/** Default API type for this provider's models */
	api: Api;
	/** Default base URL */
	baseUrl: string;
	/** Default context window fallback (default: UNKNNOWN_CONTEXT_WINDOW) */
	defaultContextWindow?: number;
	/** Default max tokens fallback (default: UNKNNOWN_MAX_TOKENS) */
	defaultMaxTokens?: number;
	/** Optional compat overrides applied to every model from this provider */
	compat?: Model<Api>["compat"];
	/** Optional static headers applied to every model */
	headers?: Record<string, string>;
	/**
	 * Optional filter: return false to skip a model.
	 * Called with (modelId, rawModel). Default: skip if tool_call !== true.
	 */
	filterModel?: (modelId: string, model: ModelsDevModel) => boolean;
	/**
	 * Optional transform: modify the mapped model before it's added.
	 * Can return null to skip the model, or an array to emit multiple models.
	 */
	transformModel?: (model: Model<Api>, modelId: string, raw: ModelsDevModel) => Model<Api> | Model<Api>[] | null;
	/**
	 * Optional: override the API type per-model.
	 * Called with (modelId, raw). Return the API type to use.
	 * If not provided, uses the `api` field.
	 */
	resolveApi?: (modelId: string, raw: ModelsDevModel) => { api: Api; baseUrl: string } | null;
}

/** Generic mapper that converts models.dev data using provider descriptors. */
export function mapModelsDevToModels(
	data: Record<string, unknown>,
	descriptors: readonly ModelsDevProviderDescriptor[],
): Model<Api>[] {
	const models: Model<Api>[] = [];
	for (const desc of descriptors) {
		const providerData = (data as Record<string, Record<string, unknown>>)[desc.modelsDevKey];
		if (!isRecord(providerData) || !isRecord(providerData.models)) continue;

		for (const [modelId, rawModel] of Object.entries(providerData.models)) {
			if (!isRecord(rawModel)) continue;
			const m = rawModel as ModelsDevModel;

			// Default filter: tool_call must be true
			if (desc.filterModel) {
				if (!desc.filterModel(modelId, m)) continue;
			} else {
				if (m.tool_call !== true) continue;
			}

			// Resolve API and baseUrl (may be per-model for providers like OpenCode)
			const resolved = desc.resolveApi?.(modelId, m) ?? { api: desc.api, baseUrl: desc.baseUrl };
			if (!resolved) continue;

			const mapped: Model<Api> = {
				id: modelId,
				name: toModelName(m.name, modelId),
				api: resolved.api,
				provider: desc.providerId as Model<Api>["provider"],
				baseUrl: resolved.baseUrl,
				reasoning: m.reasoning === true,
				input: toInputCapabilities(m.modalities?.input),
				cost: {
					input: toNumber(m.cost?.input) ?? 0,
					output: toNumber(m.cost?.output) ?? 0,
					cacheRead: toNumber(m.cost?.cache_read) ?? 0,
					cacheWrite: toNumber(m.cost?.cache_write) ?? 0,
				},
				contextWindow: toPositiveNumber(m.limit?.context, desc.defaultContextWindow ?? UNK_CONTEXT_WINDOW),
				maxTokens: toPositiveNumber(m.limit?.output, desc.defaultMaxTokens ?? UNK_MAX_TOKENS),
				...(desc.compat && { compat: desc.compat }),
				...(desc.headers && { headers: { ...desc.headers } }),
			};

			// Apply per-model transform
			if (desc.transformModel) {
				const result = desc.transformModel(mapped, modelId, m);
				if (result === null) continue;
				if (Array.isArray(result)) {
					models.push(...result);
				} else {
					models.push(result);
				}
			} else {
				models.push(mapped);
			}
		}
	}
	return models;
}

// Bedrock cross-region prefix helpers
const BEDROCK_GLOBAL_PREFIXES = [
	"anthropic.claude-haiku-4-5",
	"anthropic.claude-sonnet-4",
	"anthropic.claude-opus-4-5",
	"amazon.nova-2-lite",
	"cohere.embed-v4",
	"twelvelabs.pegasus-1-2",
];

const BEDROCK_US_PREFIXES = [
	"amazon.nova-lite",
	"amazon.nova-micro",
	"amazon.nova-premier",
	"amazon.nova-pro",
	"anthropic.claude-3-7-sonnet",
	"anthropic.claude-opus-4-1",
	"anthropic.claude-opus-4-20250514",
	"deepseek.r1",
	"meta.llama3-2",
	"meta.llama3-3",
	"meta.llama4",
];

function bedrockCrossRegionId(id: string): string {
	if (BEDROCK_GLOBAL_PREFIXES.some(p => id.startsWith(p))) return `global.${id}`;
	if (BEDROCK_US_PREFIXES.some(p => id.startsWith(p))) return `us.${id}`;
	return id;
}

interface ApiResolutionRule {
	matches: (modelId: string, raw: ModelsDevModel) => boolean;
	resolved: { api: Api; baseUrl: string };
}

function resolveApiByRules(
	modelId: string,
	raw: ModelsDevModel,
	rules: readonly ApiResolutionRule[],
	fallback: { api: Api; baseUrl: string },
): { api: Api; baseUrl: string } {
	for (const rule of rules) {
		if (rule.matches(modelId, raw)) return rule.resolved;
	}
	return fallback;
}

function createOpenCodeApiResolution(basePath: string): {
	defaultResolution: { api: Api; baseUrl: string };
	rules: ApiResolutionRule[];
} {
	const completionsBaseUrl = `${basePath}/v1`;
	return {
		defaultResolution: { api: "openai-completions", baseUrl: completionsBaseUrl },
		rules: [
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/openai",
				resolved: { api: "openai-responses", baseUrl: completionsBaseUrl },
			},
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/anthropic",
				resolved: { api: "anthropic-messages", baseUrl: basePath },
			},
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/google",
				resolved: { api: "google-generative-ai", baseUrl: completionsBaseUrl },
			},
		],
	};
}

const OPENCODE_ZEN_API_RESOLUTION = createOpenCodeApiResolution("https://opencode.ai/zen");
const OPENCODE_GO_API_RESOLUTION = createOpenCodeApiResolution("https://opencode.ai/zen/go");

const COPILOT_BASE_URL = "https://api.githubcopilot.com";

const COPILOT_DEFAULT_RESOLUTION = {
	api: "openai-completions",
	baseUrl: COPILOT_BASE_URL,
} as const satisfies { api: Api; baseUrl: string };

const COPILOT_API_RESOLUTION_RULES: readonly ApiResolutionRule[] = [
	{
		matches: modelId => /^claude-(haiku|sonnet|opus)-4([.-]|$)/.test(modelId),
		resolved: { api: "anthropic-messages", baseUrl: COPILOT_BASE_URL },
	},
	{
		matches: modelId => modelId.startsWith("gpt-5") || modelId.startsWith("oswe"),
		resolved: { api: "openai-responses", baseUrl: COPILOT_BASE_URL },
	},
];

function simpleModelsDevDescriptor(
	modelsDevKey: string,
	providerId: string,
	api: Api,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return {
		modelsDevKey,
		providerId,
		api,
		baseUrl,
		...options,
	};
}

function openAiCompletionsDescriptor(
	modelsDevKey: string,
	providerId: string,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return simpleModelsDevDescriptor(modelsDevKey, providerId, "openai-completions", baseUrl, options);
}

function anthropicMessagesDescriptor(
	modelsDevKey: string,
	providerId: string,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return simpleModelsDevDescriptor(modelsDevKey, providerId, "anthropic-messages", baseUrl, options);
}

const MODELS_DEV_PROVIDER_DESCRIPTORS_BEDROCK: readonly ModelsDevProviderDescriptor[] = [
	// --- Amazon Bedrock ---
	{
		modelsDevKey: "amazon-bedrock",
		providerId: "amazon-bedrock",
		api: "bedrock-converse-stream",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		filterModel: (id, m) => {
			if (m.tool_call !== true) return false;
			if (id.startsWith("ai21.jamba")) return false;
			if (id.startsWith("amazon.titan-text-express") || id.startsWith("mistral.mistral-7b-instruct-v0"))
				return false;
			return true;
		},
		transformModel: (model, modelId, m) => {
			const crossRegionId = bedrockCrossRegionId(modelId);
			const bedrockModel: Model<Api> = {
				...model,
				id: crossRegionId,
				name: toModelName(m.name, crossRegionId),
			};
			// Also emit EU variants for Claude models
			if (modelId.startsWith("anthropic.claude-")) {
				return [
					bedrockModel,
					{
						...bedrockModel,
						id: `eu.${modelId}`,
						name: `${toModelName(m.name, modelId)} (EU)`,
					},
				];
			}
			return bedrockModel;
		},
	},
];

const MODELS_DEV_PROVIDER_DESCRIPTORS_CORE: readonly ModelsDevProviderDescriptor[] = [
	// --- Anthropic ---
	anthropicMessagesDescriptor("anthropic", "anthropic", "https://api.anthropic.com", {
		filterModel: (id, m) => {
			if (m.tool_call !== true) return false;
			if (
				id.startsWith("claude-3-5-haiku") ||
				id.startsWith("claude-3-7-sonnet") ||
				id === "claude-3-opus-20240229" ||
				id === "claude-3-sonnet-20240229"
			)
				return false;
			return true;
		},
	}),
	// --- Google ---
	simpleModelsDevDescriptor(
		"google",
		"google",
		"google-generative-ai",
		"https://generativelanguage.googleapis.com/v1beta",
	),
	// --- OpenAI ---
	simpleModelsDevDescriptor("openai", "openai", "openai-responses", "https://api.openai.com/v1"),
	// --- Groq ---
	openAiCompletionsDescriptor("groq", "groq", "https://api.groq.com/openai/v1"),
	// --- Cerebras ---
	openAiCompletionsDescriptor("cerebras", "cerebras", "https://api.cerebras.ai/v1"),
	// --- Together ---
	openAiCompletionsDescriptor("together", "together", "https://api.together.xyz/v1"),
	// --- NVIDIA ---
	openAiCompletionsDescriptor("nvidia", "nvidia", "https://integrate.api.nvidia.com/v1", {
		defaultContextWindow: 131072,
	}),
	// --- xAI ---
	openAiCompletionsDescriptor("xai", "xai", "https://api.x.ai/v1"),
];

const MODELS_DEV_PROVIDER_DESCRIPTORS_CODING_PLANS: readonly ModelsDevProviderDescriptor[] = [
	// --- zAI ---
	anthropicMessagesDescriptor("zai-coding-plan", "zai", "https://api.z.ai/api/anthropic"),
	// --- Xiaomi ---
	anthropicMessagesDescriptor("xiaomi", "xiaomi", "https://api.xiaomimimo.com/anthropic", {
		defaultContextWindow: 262144,
		defaultMaxTokens: 8192,
	}),
	// --- MiniMax Coding Plan ---
	openAiCompletionsDescriptor("minimax-coding-plan", "minimax-code", "https://api.minimax.io/v1", {
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			thinkingFormat: "zai",
			reasoningContentField: "reasoning_content",
		},
	}),
	openAiCompletionsDescriptor("minimax-cn-coding-plan", "minimax-code-cn", "https://api.minimaxi.com/v1", {
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			thinkingFormat: "zai",
			reasoningContentField: "reasoning_content",
		},
	}),
	// --- Alibaba Coding Plan ---
	openAiCompletionsDescriptor(
		"alibaba-coding-plan",
		"alibaba-coding-plan",
		"https://coding-intl.dashscope.aliyuncs.com/v1",
		{
			compat: {
				supportsDeveloperRole: false,
			},
		},
	),
];

const filterActiveToolCallModels = (_id: string, m: ModelsDevModel): boolean => {
	if (m.tool_call !== true) return false;
	if (m.status === "deprecated") return false;
	return true;
};

const MODELS_DEV_PROVIDER_DESCRIPTORS_SPECIALIZED: readonly ModelsDevProviderDescriptor[] = [
	// --- Cloudflare AI Gateway ---
	anthropicMessagesDescriptor(
		"cloudflare-ai-gateway",
		"cloudflare-ai-gateway",
		"https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic",
	),
	// --- Mistral ---
	openAiCompletionsDescriptor("mistral", "mistral", "https://api.mistral.ai/v1"),
	// --- OpenCode Zen ---
	openAiCompletionsDescriptor("opencode", "opencode-zen", "https://opencode.ai/zen/v1", {
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(
				modelId,
				raw,
				OPENCODE_ZEN_API_RESOLUTION.rules,
				OPENCODE_ZEN_API_RESOLUTION.defaultResolution,
			),
	}),
	// --- OpenCode Go ---
	openAiCompletionsDescriptor("opencode-go", "opencode-go", "https://opencode.ai/zen/go/v1", {
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(
				modelId,
				raw,
				OPENCODE_GO_API_RESOLUTION.rules,
				OPENCODE_GO_API_RESOLUTION.defaultResolution,
			),
	}),
	// --- GitHub Copilot ---
	openAiCompletionsDescriptor("github-copilot", "github-copilot", COPILOT_BASE_URL, {
		defaultContextWindow: 128000,
		defaultMaxTokens: 8192,
		headers: { ...OPENCODE_HEADERS },
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(modelId, raw, COPILOT_API_RESOLUTION_RULES, COPILOT_DEFAULT_RESOLUTION),
		transformModel: model => {
			// compat only applies to openai-completions models
			if (model.api === "openai-completions") {
				return {
					...model,
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
					},
				};
			}
			return model;
		},
	}),
	// --- MiniMax (Anthropic) ---
	anthropicMessagesDescriptor("minimax", "minimax", "https://api.minimax.io/anthropic"),
	anthropicMessagesDescriptor("minimax-cn", "minimax-cn", "https://api.minimaxi.com/anthropic"),
	// --- Qwen Portal ---
	openAiCompletionsDescriptor("qwen-portal", "qwen-portal", "https://portal.qwen.ai/v1", {
		defaultContextWindow: 128000,
		defaultMaxTokens: 8192,
	}),

	// --- ZenMux ---
	openAiCompletionsDescriptor("zenmux", "zenmux", ZENMUX_OPENAI_BASE_URL, {
		filterModel: filterActiveToolCallModels,
		resolveApi: modelId => {
			if (modelId.startsWith("anthropic/")) {
				return { api: "anthropic-messages" as const, baseUrl: ZENMUX_ANTHROPIC_BASE_URL };
			}
			return { api: "openai-completions" as const, baseUrl: ZENMUX_OPENAI_BASE_URL };
		},
	}),
];
/** All provider descriptors for models.dev data mapping in generate-models.ts. */
export const MODELS_DEV_PROVIDER_DESCRIPTORS: readonly ModelsDevProviderDescriptor[] = [
	...MODELS_DEV_PROVIDER_DESCRIPTORS_BEDROCK,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_CORE,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_CODING_PLANS,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_SPECIALIZED,
];
