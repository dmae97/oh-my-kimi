import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const xiaomiTokenPlanCnProvider = {
	id: "xiaomi-token-plan-cn",
	name: "Xiaomi Token Plan (China)",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginXiaomiTokenPlan } = await import("./oauth/xiaomi");
		return loginXiaomiTokenPlan(cb, "cn");
	},
} as const satisfies ProviderDefinition;
