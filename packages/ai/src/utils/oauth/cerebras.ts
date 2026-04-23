/** Cerebras login flow (API key paste against https://api.cerebras.ai/v1). */
import { createApiKeyLogin } from "./api-key-login";

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
