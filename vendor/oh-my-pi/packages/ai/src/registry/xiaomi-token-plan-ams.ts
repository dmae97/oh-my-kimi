import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const xiaomiTokenPlanAmsProvider = {
	id: "xiaomi-token-plan-ams",
	name: "Xiaomi Token Plan (Europe)",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginXiaomiTokenPlan } = await import("./oauth/xiaomi");
		return loginXiaomiTokenPlan(cb, "ams");
	},
} as const satisfies ProviderDefinition;
