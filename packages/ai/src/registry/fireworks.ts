import { fireworksModelManagerOptions } from "../provider-models/openai-compat";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const loginFireworks = createApiKeyLogin({
	providerLabel: "Fireworks",
	authUrl: "https://app.fireworks.ai/settings/users/api-keys",
	instructions: "Create or copy your Fireworks API key",
	promptMessage: "Paste your Fireworks API key",
	placeholder: "fw_...",
	validation: {
		kind: "models-endpoint",
		provider: "Fireworks",
		modelsUrl: "https://api.fireworks.ai/inference/v1/models",
	},
});

export const fireworksProvider = {
	id: "fireworks",
	name: "Fireworks",
	defaultModel: "kimi-k2.6",
	createModelManagerOptions: (config: ModelManagerConfig) => fireworksModelManagerOptions(config),
	catalogDiscovery: { label: "Fireworks", envVars: ["FIREWORKS_API_KEY"] },
	envKeys: "FIREWORKS_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginFireworks(cb),
} as const satisfies ProviderDefinition;
