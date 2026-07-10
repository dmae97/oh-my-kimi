import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginNovita = createApiKeyLogin({
	providerLabel: "Novita",
	authUrl: "https://novita.ai/settings/key-management",
	instructions: "Create or copy your API key from the Novita dashboard",
	promptMessage: "Paste your Novita API key",
	placeholder: "sk_...",
	validation: {
		kind: "models-endpoint",
		provider: "novita",
		modelsUrl: "https://api.novita.ai/openai/v1/models",
	},
});

export const novitaProvider = {
	id: "novita",
	name: "Novita",
	login: (cb: Parameters<typeof loginNovita>[0]) => loginNovita(cb),
} as const satisfies ProviderDefinition;
