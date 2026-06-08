import { nanoGptModelManagerOptions } from "../provider-models/openai-compat";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const loginNanoGPT = createApiKeyLogin({
	providerLabel: "NanoGPT",
	authUrl: "https://nano-gpt.com/api",
	instructions: "Create or copy your NanoGPT API key",
	promptMessage: "Paste your NanoGPT API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "NanoGPT",
		modelsUrl: "https://nano-gpt.com/api/v1/models",
	},
});

export const nanogptProvider = {
	id: "nanogpt",
	name: "NanoGPT",
	defaultModel: "openai/gpt-5.4",
	createModelManagerOptions: (config: ModelManagerConfig) => nanoGptModelManagerOptions(config),
	catalogDiscovery: { label: "NanoGPT", envVars: ["NANO_GPT_API_KEY"] },
	envKeys: "NANO_GPT_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginNanoGPT(cb),
} as const satisfies ProviderDefinition;
