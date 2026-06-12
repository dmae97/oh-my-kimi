import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

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
	login: (cb: Parameters<typeof loginTogether>[0]) => loginTogether(cb),
} as const satisfies ProviderDefinition;
