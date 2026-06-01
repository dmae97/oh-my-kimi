/**
 * Moonshot login flow (API key paste against https://api.moonshot.ai/v1).
 *
 * Validation hits `GET /v1/models` rather than a chat completion. Moonshot's
 * thinking models (e.g. kimi-k2.5/k2.6) reject the `temperature: 0` probe used
 * by the chat-completions validator with `invalid temperature: only 1 is
 * allowed for this model`, so a hello-world chat call cannot authenticate the
 * key reliably across the Moonshot catalog.
 */
import { createApiKeyLogin } from "./api-key-login";

export const loginMoonshot = createApiKeyLogin({
	providerLabel: "Moonshot",
	authUrl: "https://platform.moonshot.ai/console/api-keys",
	instructions: "Copy your API key from the Moonshot dashboard",
	promptMessage: "Paste your Moonshot API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "moonshot",
		modelsUrl: "https://api.moonshot.ai/v1/models",
	},
});
