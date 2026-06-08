import { kimiCodeModelManagerOptions } from "../provider-models/openai-compat";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const kimiCodeProvider = {
	id: "kimi-code",
	name: "Kimi Code",
	defaultModel: "kimi-k2.5",
	createModelManagerOptions: (config: ModelManagerConfig) => kimiCodeModelManagerOptions(config),
	catalogDiscovery: { label: "Kimi Code", envVars: ["KIMI_API_KEY"] },
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginKimi } = await import("./oauth/kimi");
		return loginKimi(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { refreshKimiToken } = await import("./oauth/kimi");
		return refreshKimiToken(credentials.refresh);
	},
} as const satisfies ProviderDefinition;
