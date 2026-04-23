/** ZenMux login flow (API key paste, validated via /models). */
import { createApiKeyLogin } from "./api-key-login";

export const loginZenMux = createApiKeyLogin({
	providerLabel: "ZenMux",
	authUrl: "https://zenmux.ai/settings/keys",
	instructions: "Create or copy your ZenMux API key",
	promptMessage: "Paste your ZenMux API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "ZenMux",
		modelsUrl: "https://zenmux.ai/api/v1/models",
	},
});
