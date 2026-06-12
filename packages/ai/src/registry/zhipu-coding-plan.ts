import { validateOpenAICompatibleApiKey } from "./api-key-validation";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://bigmodel.cn/coding-plan/personal/overview";
const API_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const VALIDATION_MODEL = "glm-5.1";

export async function loginZhipuCodingPlan(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Zhipu Coding Plan login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your API key from the Coding Plan dashboard",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Zhipu API key",
		placeholder: "<id>.<secret>",
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
		provider: "Zhipu",
		apiKey: trimmed,
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
		signal: options.signal,
	});
	return trimmed;
}

export const zhipuCodingPlanProvider = {
	id: "zhipu-coding-plan",
	name: "Zhipu Coding Plan (智谱)",
	login: (cb: OAuthLoginCallbacks) => loginZhipuCodingPlan(cb),
} as const satisfies ProviderDefinition;
