import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginBaseten = createApiKeyLogin({
	providerLabel: "Baseten",
	authUrl: "https://app.baseten.co/settings/api_keys",
	instructions: "Copy your API key from the Baseten dashboard",
	promptMessage: "Paste your Baseten API key",
	placeholder: "bt_...",
	validation: {
		kind: "models-endpoint",
		provider: "Baseten",
		modelsUrl: "https://inference.baseten.co/v1/models",
	},
});

export const basetenProvider = {
	id: "baseten",
	name: "Baseten",
	login: (cb: OAuthLoginCallbacks) => loginBaseten(cb),
} as const satisfies ProviderDefinition;
