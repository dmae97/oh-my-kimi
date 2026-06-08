import { xiaomiModelManagerOptions } from "../provider-models/openai-compat";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const xiaomiProvider = {
	id: "xiaomi",
	name: "Xiaomi MiMo",
	defaultModel: "mimo-v2-flash",
	createModelManagerOptions: (config: ModelManagerConfig) => xiaomiModelManagerOptions(config),
	catalogDiscovery: { label: "Xiaomi", envVars: ["XIAOMI_API_KEY"] },
	envKeys: "XIAOMI_API_KEY",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginXiaomi } = await import("./oauth/xiaomi");
		return loginXiaomi(cb);
	},
} as const satisfies ProviderDefinition;
