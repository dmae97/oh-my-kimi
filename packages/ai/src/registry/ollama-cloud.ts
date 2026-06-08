import { ollamaCloudModelManagerOptions } from "../provider-models/ollama";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

const OLLAMA_CLOUD_KEYS_URL = "https://ollama.com/settings/keys";

export async function loginOllamaCloud(options: OAuthController): Promise<string> {
	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}
	if (!options.onPrompt) {
		throw new Error("Interactive prompt is required for Ollama Cloud login");
	}
	options.onAuth?.({
		url: OLLAMA_CLOUD_KEYS_URL,
		instructions: "Create an Ollama Cloud API key, then paste it here.",
	});
	const apiKey = await options.onPrompt({
		message: "Paste your Ollama Cloud API key",
		placeholder: "ollama-cloud-api-key",
	});
	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}
	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("Ollama Cloud API key is required");
	}
	return trimmed;
}

export const ollamaCloudProvider = {
	id: "ollama-cloud",
	name: "Ollama Cloud",
	defaultModel: "gpt-oss:120b",
	createModelManagerOptions: (config: ModelManagerConfig) => ollamaCloudModelManagerOptions(config),
	catalogDiscovery: { label: "Ollama Cloud", envVars: ["OLLAMA_CLOUD_API_KEY"], oauthProvider: "ollama-cloud" },
	envKeys: "OLLAMA_CLOUD_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginOllamaCloud(cb),
} as const satisfies ProviderDefinition;
