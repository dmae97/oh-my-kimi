import { validateOpenAICompatibleApiKey } from "./api-key-validation";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://console.bce.baidu.com/qianfan/ais/console/apiKey";
const API_BASE_URL = "https://qianfan.baidubce.com/v2";
const VALIDATION_MODEL = "deepseek-v3.2";

export async function loginQianfan(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Qianfan login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your Qianfan API key from the console",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Qianfan API key",
		placeholder: "bce-v3/ALTAK-...",
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("API key is required");
	}

	options.onProgress?.("Validating API key...");
	await validateOpenAICompatibleApiKey({
		provider: "qianfan",
		apiKey: trimmed,
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
		signal: options.signal,
	});

	return trimmed;
}

export const qianfanProvider = {
	id: "qianfan",
	name: "Qianfan",
	login: (cb: OAuthLoginCallbacks) => loginQianfan(cb),
} as const satisfies ProviderDefinition;
