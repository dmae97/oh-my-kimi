/** Fireworks login flow (API key paste against https://api.fireworks.ai/inference/v1). */
import { createApiKeyLogin } from "./api-key-login";

export const loginFireworks = createApiKeyLogin({
	providerLabel: "Fireworks",
	authUrl: "https://app.fireworks.ai/settings/users/api-keys",
	instructions: "Create or copy your Fireworks API key",
	promptMessage: "Paste your Fireworks API key",
	placeholder: "fw_...",
	validation: {
		kind: "models-endpoint",
		provider: "Fireworks",
		modelsUrl: "https://api.fireworks.ai/inference/v1/models",
	},
});
