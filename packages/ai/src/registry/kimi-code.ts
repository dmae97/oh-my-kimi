import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const kimiCodeProvider = {
	id: "kimi-code",
	name: "Kimi Code",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginKimi } = await import("./oauth/kimi");
		return loginKimi(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { refreshKimiToken } = await import("./oauth/kimi");
		return refreshKimiToken(credentials.refresh);
	},
} as const satisfies ProviderDefinition;
