import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://developers.cloudflare.com/ai-gateway/configuration/authentication/";

/**
 * Login to Cloudflare AI Gateway.
 *
 * Opens browser to Cloudflare AI Gateway authentication docs and prompts for a gateway token/API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export async function loginCloudflareAiGateway(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Cloudflare AI Gateway login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions:
			"Copy your Cloudflare AI Gateway token/API key. Configure account/gateway base URL in models config.",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Cloudflare AI Gateway token/API key",
		placeholder: "cf-aig-...",
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("API key is required");
	}

	return trimmed;
}

export const cloudflareAiGatewayProvider = {
	id: "cloudflare-ai-gateway",
	name: "Cloudflare AI Gateway",
	login: (cb: OAuthLoginCallbacks) => loginCloudflareAiGateway(cb),
} as const satisfies ProviderDefinition;
