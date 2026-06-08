import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const openaiCodexProvider = {
	id: "openai-codex",
	name: "ChatGPT Plus/Pro (Codex Subscription)",
	defaultModel: "gpt-5.4",
	specialModelManager: true,
	envKeys: "OPENAI_CODEX_OAUTH_TOKEN",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginOpenAICodex } = await import("./oauth/openai-codex");
		return loginOpenAICodex(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { refreshOpenAICodexToken } = await import("./oauth/openai-codex");
		return refreshOpenAICodexToken(credentials.refresh);
	},
	callbackPort: 1455,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
