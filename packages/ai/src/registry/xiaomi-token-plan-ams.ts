import { xiaomiModelManagerOptions } from "../provider-models/openai-compat";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const xiaomiTokenPlanAmsProvider = {
	id: "xiaomi-token-plan-ams",
	name: "Xiaomi Token Plan (Europe)",
	defaultModel: "mimo-v2.5",
	createModelManagerOptions: (config: ModelManagerConfig) =>
		xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-ams", tokenPlanRegion: "ams" }),
	envKeys: "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginXiaomiTokenPlan } = await import("./oauth/xiaomi");
		return loginXiaomiTokenPlan(cb, "ams");
	},
} as const satisfies ProviderDefinition;
