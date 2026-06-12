import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const xiaomiTokenPlanSgpProvider = {
	id: "xiaomi-token-plan-sgp",
	name: "Xiaomi Token Plan (Singapore)",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginXiaomiTokenPlan } = await import("./oauth/xiaomi");
		return loginXiaomiTokenPlan(cb, "sgp");
	},
} as const satisfies ProviderDefinition;
