import { fetchWithRetry, wrapFetchForExtraCa } from "@oh-my-pi/pi-utils";
import { Effort } from "../effort";
import { isGlm52ReasoningEffortModelId } from "../identity/family";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl, ThinkingConfig } from "../types";
import { createBundledReferenceMap, createReferenceResolver } from "./bundled-references";

export interface OllamaCloudModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

type OllamaTagEntry = {
	name?: string;
	model?: string;
};

type OllamaShowResponse = {
	capabilities?: string[];
	model_info?: Record<string, unknown>;
};

const OLLAMA_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
const OLLAMA_CLOUD_GLM_52_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.High, Effort.XHigh],
	effortMap: { [Effort.XHigh]: "max" },
};

function trimTrailingSlash(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function normalizeOllamaCloudBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return "https://ollama.com";
	}
	const trimmed = trimTrailingSlash(value);
	return trimmed.endsWith("/api") ? trimmed.slice(0, -4) : trimmed;
}

function createCloudHeaders(apiKey: string): Record<string, string> {
	return {
		Accept: "application/json",
		Authorization: `Bearer ${apiKey}`,
	};
}

function getContextWindow(modelInfo: Record<string, unknown> | undefined): number | undefined {
	if (!modelInfo) {
		return undefined;
	}
	for (const [key, value] of Object.entries(modelInfo)) {
		if (typeof value !== "number") {
			continue;
		}
		if (key.endsWith(".context_length") || key.endsWith(".num_ctx") || key.endsWith(".context_window")) {
			return value;
		}
	}
}

function getThinkingConfig(modelId: string, capabilities: string[] | undefined): ThinkingConfig | undefined {
	if (!capabilities?.includes("thinking")) {
		return undefined;
	}
	if (isGlm52ReasoningEffortModelId(modelId)) {
		return OLLAMA_CLOUD_GLM_52_THINKING;
	}
	return { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] };
}
async function fetchShowMetadata(
	baseUrl: string,
	apiKey: string,
	model: string,
	fetchImpl: FetchImpl = wrapFetchForExtraCa(fetch),
): Promise<OllamaShowResponse | undefined> {
	const response = await fetchImpl(`${baseUrl}/api/show`, {
		method: "POST",
		headers: {
			...createCloudHeaders(apiKey),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ model }),
	});
	if (!response.ok) {
		return undefined;
	}
	return (await response.json()) as OllamaShowResponse;
}

export function ollamaCloudModelManagerOptions(
	config?: OllamaCloudModelManagerConfig,
): ModelManagerOptions<"ollama-chat"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeOllamaCloudBaseUrl(config?.baseUrl);
	const providerReferences = createBundledReferenceMap<"ollama-chat">("ollama-cloud");
	const resolveReference = createReferenceResolver(providerReferences);
	return {
		providerId: "ollama-cloud",
		fetchDynamicModels: async () => {
			if (!apiKey) {
				return [];
			}
			const response = await fetchWithRetry(`${baseUrl}/api/tags`, {
				method: "GET",
				headers: createCloudHeaders(apiKey),
				fetch: config?.fetch ?? wrapFetchForExtraCa(fetch),
				defaultDelayMs: OLLAMA_RETRY_DELAYS_MS,
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} from ${baseUrl}/api/tags`);
			}
			const payload = (await response.json()) as { models?: OllamaTagEntry[] };
			const entries = payload.models ?? [];
			const models = await Promise.all(
				entries.map(async entry => {
					const id = entry.model ?? entry.name;
					if (!id) {
						return undefined;
					}
					const providerReference = providerReferences.get(id);
					const reference = resolveReference(id);
					let metadata: OllamaShowResponse | undefined;
					try {
						metadata = await fetchShowMetadata(baseUrl, apiKey, id, config?.fetch);
					} catch {
						metadata = undefined;
					}
					const capabilities = metadata?.capabilities;
					const discoveredContextWindow = getContextWindow(metadata?.model_info);
					// `/api/show` is the only trustworthy Ollama-owned source for size caps.
					// When it is unavailable (or returns only coarse capabilities), do NOT
					// inherit giant budgets from bundled fallback metadata sourced from a
					// different catalog; keep the historical safe fallback instead.
					const contextWindow = discoveredContextWindow ?? 128000;
					const reasoning = capabilities ? capabilities.includes("thinking") : (reference?.reasoning ?? false);
					const thinking = capabilities ? getThinkingConfig(id, capabilities) : reference?.thinking;
					const input = capabilities
						? capabilities.includes("vision")
							? (["text", "image"] as Array<"text" | "image">)
							: (["text"] as Array<"text">)
						: ((reference?.input as Array<"text" | "image"> | undefined) ?? (["text"] as Array<"text">));
					const resolvedName = entry.name && entry.name !== id ? entry.name : (reference?.name ?? id);
					return {
						id,
						name: resolvedName,
						api: "ollama-chat" as const,
						provider: "ollama-cloud" as const,
						baseUrl,
						reasoning,
						thinking,
						input,
						cost: reference?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow,
						maxTokens:
							discoveredContextWindow !== null && discoveredContextWindow !== undefined
								? (providerReference?.maxTokens ?? Math.min(contextWindow, 8192))
								: Math.min(contextWindow, 8192),
						omitMaxOutputTokens: true,
					};
				}),
			);
			return models
				.filter((model): model is NonNullable<(typeof models)[number]> => model !== undefined)
				.sort((left, right) => left.id.localeCompare(right.id));
		},
	};
}
