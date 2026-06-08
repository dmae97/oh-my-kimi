import { cerebrasModelManagerOptions } from "../provider-models/openai-compat";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const loginCerebras = createApiKeyLogin({
	providerLabel: "Cerebras",
	authUrl: "https://cloud.cerebras.ai/platform/",
	instructions: "Copy your API key from the Cerebras dashboard",
	promptMessage: "Paste your Cerebras API key",
	placeholder: "csk-...",
	validation: {
		kind: "chat-completions",
		provider: "Cerebras",
		baseUrl: "https://api.cerebras.ai/v1",
		model: "gpt-oss-120b",
	},
});

export const cerebrasProvider = {
	id: "cerebras",
	name: "Cerebras",
	defaultModel: "zai-glm-4.6",
	createModelManagerOptions: (config: ModelManagerConfig) => cerebrasModelManagerOptions(config),
	catalogDiscovery: { label: "Cerebras", envVars: ["CEREBRAS_API_KEY"] },
	envKeys: "CEREBRAS_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginCerebras(cb),
} as const satisfies ProviderDefinition;
