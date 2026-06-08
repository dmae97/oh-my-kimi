import { $pickenv } from "@oh-my-pi/pi-utils";
import { xaiOAuthModelManagerOptions } from "../provider-models/openai-compat";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const xaiOauthProvider = {
	id: "xai-oauth",
	name: "xAI Grok OAuth (SuperGrok Subscription)",
	defaultModel: "grok-4.3",
	createModelManagerOptions: (config: ModelManagerConfig) => xaiOAuthModelManagerOptions(config),
	catalogDiscovery: {
		label: "xAI Grok OAuth (SuperGrok)",
		envVars: ["XAI_OAUTH_TOKEN", "XAI_API_KEY"],
		oauthProvider: "xai-oauth",
	},
	envKeys: () => $pickenv("XAI_OAUTH_TOKEN", "XAI_API_KEY"),
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginXAIOAuth } = await import("./oauth/xai-oauth");
		return loginXAIOAuth(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { refreshXAIOAuthToken } = await import("./oauth/xai-oauth");
		return refreshXAIOAuthToken(credentials.refresh);
	},
} as const satisfies ProviderDefinition;
