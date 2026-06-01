/** OpenRouter login flow (API key paste, validated via /auth/key).
 *
 * `/api/v1/models` is public and returns 200 for any bearer (including bogus),
 * so it cannot validate auth. `/api/v1/auth/key` is the canonical "who am I"
 * endpoint — 200 for valid keys, 401 otherwise.
 */
import { createApiKeyLogin } from "./api-key-login";

export const loginOpenRouter = createApiKeyLogin({
	providerLabel: "OpenRouter",
	authUrl: "https://openrouter.ai/keys",
	instructions: "Create or copy your OpenRouter API key",
	promptMessage: "Paste your OpenRouter API key",
	placeholder: "sk-or-...",
	validation: {
		kind: "models-endpoint",
		provider: "OpenRouter",
		modelsUrl: "https://openrouter.ai/api/v1/auth/key",
	},
});
