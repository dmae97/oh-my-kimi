import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

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
	login: (cb: OAuthLoginCallbacks) => loginNanoGPT(cb),
} as const satisfies ProviderDefinition;
