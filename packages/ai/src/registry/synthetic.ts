import { syntheticModelManagerOptions } from "../provider-models/openai-compat";
import { createApiKeyLogin } from "./api-key-login";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const loginSynthetic = createApiKeyLogin({
	providerLabel: "Synthetic",
	authUrl: "https://dev.synthetic.new/docs/api/overview",
	instructions: "Copy your API key from the Synthetic dashboard",
	promptMessage: "Paste your Synthetic API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "Synthetic",
		modelsUrl: "https://api.synthetic.new/openai/v1/models",
	},
});

export const syntheticProvider = {
	id: "synthetic",
	name: "Synthetic",
	defaultModel: "hf:zai-org/GLM-5.1",
	createModelManagerOptions: (config: ModelManagerConfig) => syntheticModelManagerOptions(config),
	dynamicModelsAuthoritative: true,
	catalogDiscovery: { label: "Synthetic", envVars: ["SYNTHETIC_API_KEY"] },
	envKeys: "SYNTHETIC_API_KEY",
	login: loginSynthetic,
} as const satisfies ProviderDefinition;
