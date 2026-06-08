import { alibabaCodingPlanModelManagerOptions } from "../provider-models/openai-compat";
import { validateOpenAICompatibleApiKey } from "./api-key-validation";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

const AUTH_URL = "https://modelstudio.console.alibabacloud.com/";
const API_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
const VALIDATION_MODEL = "qwen3.5-plus";

export async function loginAlibabaCodingPlan(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error("Alibaba Coding Plan login requires onPrompt callback");
	}

	options.onAuth?.({
		url: AUTH_URL,
		instructions: "Copy your API key from the Alibaba Cloud DashScope console",
	});

	const apiKey = await options.onPrompt({
		message: "Paste your Alibaba Coding Plan API key",
		placeholder: "sk-...",
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
		provider: "Alibaba Coding Plan",
		apiKey: trimmed,
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
		signal: options.signal,
	});

	return trimmed;
}

export const alibabaCodingPlanProvider = {
	id: "alibaba-coding-plan",
	name: "Alibaba Coding Plan",
	defaultModel: "qwen3.5-plus",
	createModelManagerOptions: (config: ModelManagerConfig) => alibabaCodingPlanModelManagerOptions(config),
	catalogDiscovery: { label: "Alibaba Coding Plan", envVars: ["ALIBABA_CODING_PLAN_API_KEY"] },
	envKeys: "ALIBABA_CODING_PLAN_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginAlibabaCodingPlan(cb),
} as const satisfies ProviderDefinition;
