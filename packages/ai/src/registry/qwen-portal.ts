import { validateOpenAICompatibleApiKey } from "./api-key-validation";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://chat.qwen.ai";
const API_BASE_URL = "https://portal.qwen.ai/v1";
const VALIDATION_MODEL = "coder-model";

export async function loginQwenPortal(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Qwen Portal login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your Qwen OAuth token or API key",
	});

	const token = await options.onPrompt({
		message: "Paste your Qwen OAuth token or API key",
		placeholder: "sk-...",
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = token.trim();
	if (!trimmed) {
		throw new Error("Qwen token/API key is required");
	}

	options.onProgress?.("Validating credentials...");
	await validateOpenAICompatibleApiKey({
		provider: "qwen-portal",
		apiKey: trimmed,
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
		signal: options.signal,
	});

	return trimmed;
}

export const qwenPortalProvider = {
	id: "qwen-portal",
	name: "Qwen Portal",
	login: (cb: OAuthLoginCallbacks) => loginQwenPortal(cb),
} as const satisfies ProviderDefinition;
