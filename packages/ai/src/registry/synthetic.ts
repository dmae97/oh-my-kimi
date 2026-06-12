import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

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
	login: loginSynthetic,
} as const satisfies ProviderDefinition;
