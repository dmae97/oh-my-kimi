import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const googleAntigravityProvider = {
	id: "google-antigravity",
	name: "Antigravity (Gemini 3, Claude, GPT-OSS)",
	defaultModel: "gemini-3-pro-high",
	specialModelManager: true,
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginAntigravity } = await import("./oauth/google-antigravity");
		return loginAntigravity(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		if (!credentials.projectId) {
			throw new Error("Antigravity credentials missing projectId");
		}
		const { refreshAntigravityToken } = await import("./oauth/google-antigravity");
		return refreshAntigravityToken(credentials.refresh, credentials.projectId);
	},
	callbackPort: 51121,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
