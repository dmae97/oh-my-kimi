import type { OAuthController } from "./types";

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
