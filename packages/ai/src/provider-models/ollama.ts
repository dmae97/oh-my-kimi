import type { ModelManagerOptions } from "../model-manager";
import { Effort } from "../model-thinking";
import type { ThinkingConfig } from "../types";
import { createBundledReferenceMap, createReferenceResolver } from "./bundled-references";

export interface OllamaCloudModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

type OllamaTagEntry = {
	name?: string;
	model?: string;
};

type OllamaShowResponse = {
	capabilities?: string[];
	model_info?: Record<string, unknown>;
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

function getThinkingConfig(capabilities: string[] | undefined): ThinkingConfig | undefined {
	if (!capabilities?.includes("thinking")) {
		return undefined;
	}
	return {
		mode: "effort",
		minLevel: Effort.Minimal,
		maxLevel: Effort.High,
	};
}

async function fetchShowMetadata(
	baseUrl: string,
	apiKey: string,
	model: string,
): Promise<OllamaShowResponse | undefined> {
	const response = await fetch(`${baseUrl}/api/show`, {
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
	const resolveReference = createReferenceResolver(createBundledReferenceMap<"ollama-chat">("ollama-cloud"));
	return {
		providerId: "ollama-cloud",
		fetchDynamicModels: async () => {
			if (!apiKey) {
				return [];
			}
			const response = await fetch(`${baseUrl}/api/tags`, {
				method: "GET",
				headers: createCloudHeaders(apiKey),
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
					const reference = resolveReference(id);
					let metadata: OllamaShowResponse | undefined;
					try {
						metadata = await fetchShowMetadata(baseUrl, apiKey, id);
					} catch {
						metadata = undefined;
					}
					const capabilities = metadata?.capabilities;
					const contextWindow = getContextWindow(metadata?.model_info) ?? reference?.contextWindow ?? 128000;
					const reasoning = capabilities ? capabilities.includes("thinking") : (reference?.reasoning ?? false);
					const thinking = capabilities ? getThinkingConfig(capabilities) : reference?.thinking;
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
						maxTokens: reference?.maxTokens ?? Math.min(contextWindow, 8192),
					};
				}),
			);
			return models
				.filter((model): model is NonNullable<(typeof models)[number]> => model !== undefined)
				.sort((left, right) => left.id.localeCompare(right.id));
		},
	};
}
