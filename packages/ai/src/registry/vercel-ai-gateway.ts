import { vercelAiGatewayModelManagerOptions } from "../provider-models/openai-compat";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

const AUTH_URL = "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys";

export async function loginVercelAiGateway(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Vercel AI Gateway login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your Vercel AI Gateway API key from the Vercel dashboard",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Vercel AI Gateway API key",
		placeholder: "vck_...",
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

export const vercelAiGatewayProvider = {
	id: "vercel-ai-gateway",
	name: "Vercel AI Gateway",
	defaultModel: "anthropic/claude-sonnet-4-6",
	createModelManagerOptions: (config: ModelManagerConfig) => vercelAiGatewayModelManagerOptions(config),
	catalogDiscovery: { label: "Vercel AI Gateway", envVars: ["VERCEL_AI_GATEWAY_API_KEY"], allowUnauthenticated: true },
	envKeys: "AI_GATEWAY_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginVercelAiGateway(cb),
} as const satisfies ProviderDefinition;
