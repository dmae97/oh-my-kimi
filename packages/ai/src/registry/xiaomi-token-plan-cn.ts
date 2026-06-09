import { xiaomiModelManagerOptions } from "../provider-models/openai-compat";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const xiaomiTokenPlanCnProvider = {
	id: "xiaomi-token-plan-cn",
	name: "Xiaomi Token Plan (China)",
	defaultModel: "mimo-v2.5",
	createModelManagerOptions: (config: ModelManagerConfig) =>
		xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-cn", tokenPlanRegion: "cn" }),
	envKeys: "XIAOMI_TOKEN_PLAN_CN_API_KEY",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginXiaomiTokenPlan } = await import("./oauth/xiaomi");
		return loginXiaomiTokenPlan(cb, "cn");
	},
} as const satisfies ProviderDefinition;
