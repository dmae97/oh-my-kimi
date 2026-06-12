import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const waferPassProvider = {
	id: "wafer-pass",
	name: "Wafer Pass (flat-rate subscription)",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginWaferPass } = await import("./oauth/wafer");
		return loginWaferPass(cb);
	},
} as const satisfies ProviderDefinition;
