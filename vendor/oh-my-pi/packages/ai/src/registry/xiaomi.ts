import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const xiaomiProvider = {
	id: "xiaomi",
	name: "Xiaomi MiMo",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginXiaomi } = await import("./oauth/xiaomi");
		return loginXiaomi(cb);
	},
} as const satisfies ProviderDefinition;
