import { waferPassModelManagerOptions } from "../provider-models/openai-compat";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const waferPassProvider = {
	id: "wafer-pass",
	name: "Wafer Pass (flat-rate subscription)",
	defaultModel: "GLM-5.1",
	createModelManagerOptions: (config: ModelManagerConfig) => waferPassModelManagerOptions(config),
	catalogDiscovery: { label: "Wafer Pass", envVars: ["WAFER_PASS_API_KEY"], oauthProvider: "wafer-pass" },
	envKeys: "WAFER_PASS_API_KEY",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginWaferPass } = await import("./oauth/wafer");
		return loginWaferPass(cb);
	},
} as const satisfies ProviderDefinition;
