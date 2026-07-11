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
		provider: "Novita",
		modelsUrl: "https://api.novita.ai/openapi/v1/billing/balance/detail",
		headers: { "Content-Type": "application/json" },
	},
});

export const novitaProvider = {
	id: "novita",
	name: "Novita",
	login: loginNovita,
} satisfies ProviderDefinition & { readonly id: "novita" };
