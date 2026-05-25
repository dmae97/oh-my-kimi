/**
 * DeepSeek login flow (API key paste against https://api.deepseek.com).
 *
 * Validation hits `GET /v1/models` so it authenticates the key without
 * depending on a specific model being enabled on the account. The previous
 * implementation issued a chat-completion against `deepseek-v4-pro`, which
 * 404s for accounts without that preview model even when the key is valid.
 */
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthController, OAuthPrompt } from "./types";

const innerLogin = createApiKeyLogin({
	providerLabel: "DeepSeek",
	authUrl: "https://platform.deepseek.com/api_keys",
	instructions: "Create or copy your API key from the DeepSeek dashboard",
	promptMessage: "Paste your DeepSeek API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "deepseek",
		modelsUrl: "https://api.deepseek.com/v1/models",
	},
});

/**
 * Normalize a pasted DeepSeek API key.
 *
 * Users frequently copy keys out of `curl` snippets that include the
 * `Authorization: Bearer …` prefix. Strip it so validation does not fail
 * with a confusing 401, and reject obviously empty input early.
 */
export function normalizeDeepSeekApiKey(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		return trimmed; // let the shared factory throw the canonical "API key is required"
	}
	const stripped = trimmed.replace(/^bearer\b\s*/i, "");
	if (!stripped) {
		throw new Error("DeepSeek API key is empty after stripping Bearer prefix");
	}
	return stripped;
}

export const loginDeepSeek = async (options: OAuthController): Promise<string> => {
	const userOnPrompt = options.onPrompt;
	const wrapped: OAuthController = userOnPrompt
		? {
				...options,
				onPrompt: async (prompt: OAuthPrompt) => normalizeDeepSeekApiKey(await userOnPrompt(prompt)),
			}
		: options;
	return innerLogin(wrapped);
};
