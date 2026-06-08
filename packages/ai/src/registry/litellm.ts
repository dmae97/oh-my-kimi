import { litellmModelManagerOptions } from "../provider-models/openai-compat";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

const AUTH_URL = "https://docs.litellm.ai/docs/proxy/deploy";

/**
 * Login to LiteLLM.
 *
 * Opens browser to LiteLLM setup docs, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export async function loginLiteLLM(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("LiteLLM login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Run LiteLLM proxy (default http://localhost:4000/v1), then copy your master key or virtual key",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your LiteLLM API key (master key or virtual key)",
		placeholder: "sk-...",
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("API key is required");
	}

	return trimmed;
}

export const litellmProvider = {
	id: "litellm",
	name: "LiteLLM",
	defaultModel: "claude-opus-4-6",
	createModelManagerOptions: (config: ModelManagerConfig) => litellmModelManagerOptions(config),
	catalogDiscovery: { label: "LiteLLM", envVars: ["LITELLM_API_KEY"], allowUnauthenticated: true },
	envKeys: "LITELLM_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginLiteLLM(cb),
} as const satisfies ProviderDefinition;
