import { xiaomiModelManagerOptions } from "../provider-models/openai-compat";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const xiaomiTokenPlanSgpProvider = {
	id: "xiaomi-token-plan-sgp",
	name: "Xiaomi Token Plan (Singapore)",
	defaultModel: "mimo-v2.5",
	createModelManagerOptions: (config: ModelManagerConfig) =>
		xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-sgp", tokenPlanRegion: "sgp" }),
	envKeys: "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginXiaomiTokenPlan } = await import("./oauth/xiaomi");
		return loginXiaomiTokenPlan(cb, "sgp");
	},
} as const satisfies ProviderDefinition;
