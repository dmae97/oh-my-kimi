import { $pickenv } from "@oh-my-pi/pi-utils";
import { isFoundryEnabled } from "../utils/foundry";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const anthropicProvider = {
	id: "anthropic",
	name: "Anthropic (Claude Pro/Max)",
	// Foundry mode optionally switches Anthropic auth to enterprise gateway credentials.
	envKeys: () =>
		isFoundryEnabled()
			? $pickenv("ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY")
			: $pickenv("ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"),
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginAnthropic } = await import("./oauth/anthropic");
		return loginAnthropic(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { refreshAnthropicToken } = await import("./oauth/anthropic");
		return refreshAnthropicToken(credentials.refresh);
	},
	callbackPort: 54545,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
