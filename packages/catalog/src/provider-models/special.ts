import { once } from "@oh-my-pi/pi-utils";
import { fetchCodexModels } from "../discovery/codex";
import type { DevinModelDiscoveryOptions } from "../discovery/devin";
import type { ModelManagerOptions } from "../model-manager";

// ---------------------------------------------------------------------------
// OpenAI Codex
// ---------------------------------------------------------------------------

export interface OpenAICodexModelManagerConfig {
	accessToken?: string;
	accountId?: string;
	clientVersion?: string;
}

export function openaiCodexModelManagerOptions(
	config: OpenAICodexModelManagerConfig = {},
): ModelManagerOptions<"openai-codex-responses"> {
	const { accessToken, accountId, clientVersion } = config;
	return {
		providerId: "openai-codex",
		...(accessToken
			? {
					fetchDynamicModels: async () => {
						const result = await fetchCodexModels({ accessToken, accountId, clientVersion });
						return result?.models ?? null;
					},
				}
			: undefined),
	};
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export interface CursorModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	clientVersion?: string;
}

export function cursorModelManagerOptions(config: CursorModelManagerConfig = {}): ModelManagerOptions<"cursor-agent"> {
	const { apiKey, baseUrl, clientVersion } = config;
	return {
		providerId: "cursor",
		...(apiKey
			? {
					fetchDynamicModels: async () => {
						const { fetchCursorUsableModels } = await cursorDiscovery();
						return fetchCursorUsableModels({ apiKey, baseUrl, clientVersion });
					},
				}
			: undefined),
	};
}

const cursorDiscovery = once(() => import("../discovery/cursor"));

// ---------------------------------------------------------------------------
// Devin (Codeium Cascade)
// ---------------------------------------------------------------------------

export interface DevinModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: DevinModelDiscoveryOptions["fetch"];
}

export function devinModelManagerOptions(config: DevinModelManagerConfig = {}): ModelManagerOptions<"devin-agent"> {
	const { apiKey, baseUrl, fetch } = config;
	return {
		providerId: "devin",
		...(apiKey ? { dynamicModelsAuthoritative: true } : undefined),
		...(apiKey
			? {
					fetchDynamicModels: async () => {
						const { fetchDevinModels } = await devinDiscovery();
						return fetchDevinModels({ apiKey, baseUrl, fetch });
					},
				}
			: undefined),
	};
}

const devinDiscovery = once(() => import("../discovery/devin"));

// ---------------------------------------------------------------------------
// Zai
// ---------------------------------------------------------------------------

export interface ZaiModelManagerConfig {}

export function zaiModelManagerOptions(_config: ZaiModelManagerConfig = {}): ModelManagerOptions<"anthropic-messages"> {
	return { providerId: "zai" };
}
