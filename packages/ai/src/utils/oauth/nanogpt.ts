/** NanoGPT login flow (API key paste, validated via /models). */
import { createApiKeyLogin } from "./api-key-login";

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
