/** Together login flow (API key paste against https://api.together.xyz/v1). */
import { createApiKeyLogin } from "./api-key-login";

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
