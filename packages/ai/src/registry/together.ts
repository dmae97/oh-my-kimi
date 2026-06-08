import { togetherModelManagerOptions } from "../provider-models/openai-compat";
import { createApiKeyLogin } from "./api-key-login";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const loginTogether = createApiKeyLogin({
	providerLabel: "Together",
	authUrl: "https://api.together.xyz/settings/api-keys",
	instructions: "Copy your API key from the Together dashboard",
	promptMessage: "Paste your Together API key",
	placeholder: "sk-...",
	validation: {
		kind: "chat-completions",
		provider: "together",
		baseUrl: "https://api.together.xyz/v1",
		model: "moonshotai/Kimi-K2.5",
	},
});

export const togetherProvider = {
	id: "together",
	name: "Together",
	defaultModel: "moonshotai/Kimi-K2.5",
	createModelManagerOptions: (config: ModelManagerConfig) => togetherModelManagerOptions(config),
	catalogDiscovery: { label: "Together", envVars: ["TOGETHER_API_KEY"] },
	envKeys: "TOGETHER_API_KEY",
	login: (cb: Parameters<typeof loginTogether>[0]) => loginTogether(cb),
} as const satisfies ProviderDefinition;
