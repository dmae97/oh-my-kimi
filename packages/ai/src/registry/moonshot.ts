import { moonshotModelManagerOptions } from "../provider-models/openai-compat";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const loginMoonshot = createApiKeyLogin({
	providerLabel: "Moonshot",
	authUrl: "https://platform.moonshot.ai/console/api-keys",
	instructions: "Copy your API key from the Moonshot dashboard",
	promptMessage: "Paste your Moonshot API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "moonshot",
		modelsUrl: "https://api.moonshot.ai/v1/models",
	},
});

export const moonshotProvider = {
	id: "moonshot",
	name: "Moonshot (Kimi API)",
	defaultModel: "kimi-k2.5",
	createModelManagerOptions: (config: ModelManagerConfig) => moonshotModelManagerOptions(config),
	catalogDiscovery: { label: "Moonshot", envVars: ["MOONSHOT_API_KEY"] },
	envKeys: "MOONSHOT_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginMoonshot(cb),
} as const satisfies ProviderDefinition;
