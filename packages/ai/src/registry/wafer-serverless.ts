import { waferServerlessModelManagerOptions } from "../provider-models/openai-compat";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const waferServerlessProvider = {
	id: "wafer-serverless",
	name: "Wafer Serverless (pay-as-you-go)",
	defaultModel: "GLM-5.1",
	createModelManagerOptions: (config: ModelManagerConfig) => waferServerlessModelManagerOptions(config),
	catalogDiscovery: {
		label: "Wafer Serverless",
		envVars: ["WAFER_SERVERLESS_API_KEY"],
		oauthProvider: "wafer-serverless",
	},
	envKeys: "WAFER_SERVERLESS_API_KEY",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginWaferServerless } = await import("./oauth/wafer");
		return loginWaferServerless(cb);
	},
} as const satisfies ProviderDefinition;
