import { firepassModelManagerOptions } from "../provider-models/openai-compat";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

/**
 * Fire Pass login flow.
 *
 * Fire Pass is a Fireworks subscription product whose dedicated `fpk_…` API
 * keys are scoped to the `accounts/fireworks/routers/kimi-k2p6-turbo` router
 * (Kimi K2.6 Turbo). The key does NOT authorize `/v1/models`, so validation
 * pings the chat completions endpoint with the router id directly.
 * See https://docs.fireworks.ai/firepass.
 */
export const loginFirepass = createApiKeyLogin({
	providerLabel: "Fire Pass",
	authUrl: "https://app.fireworks.ai/settings/users/api-keys",
	instructions: "Create a dedicated Fire Pass API key in the Fireworks dashboard",
	promptMessage: "Paste your Fire Pass API key",
	placeholder: "fpk_...",
	validation: {
		kind: "chat-completions",
		provider: "Fire Pass",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		model: "accounts/fireworks/routers/kimi-k2p6-turbo",
	},
});

export const firepassProvider = {
	id: "firepass",
	name: "Fire Pass (Fireworks Kimi K2.6 Turbo subscription)",
	defaultModel: "kimi-k2.6-turbo",
	createModelManagerOptions: (config: ModelManagerConfig) => firepassModelManagerOptions(config),
	envKeys: "FIREPASS_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginFirepass(cb),
} as const satisfies ProviderDefinition;
