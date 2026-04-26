/** Moonshot login flow (API key paste against https://api.moonshot.ai/v1). */
import { createApiKeyLogin } from "./api-key-login";

export const loginMoonshot = createApiKeyLogin({
	providerLabel: "Moonshot",
	authUrl: "https://platform.moonshot.ai/console/api-keys",
	instructions: "Copy your API key from the Moonshot dashboard",
	promptMessage: "Paste your Moonshot API key",
	placeholder: "sk-...",
	validation: {
		kind: "chat-completions",
		provider: "moonshot",
		baseUrl: "https://api.moonshot.ai/v1",
		model: "kimi-k2.5",
	},
});
