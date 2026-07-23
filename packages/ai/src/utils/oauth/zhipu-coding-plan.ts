/**
 * Zhipu Coding Plan (智谱) login flow.
 *
 * Zhipu Coding Plan is a subscription service providing access to GLM models
 * through an OpenAI-compatible API at open.bigmodel.cn.
 * This is an API key flow: open browser → copy key from dashboard → paste back.
 */
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const AUTH_URL = "https://bigmodel.cn/coding-plan/personal/overview";

export const ZHIPU_CODING_PLAN_PROVIDER_ID = "zhipu-coding-plan";

/** Login to Zhipu Coding Plan. */
export async function loginZhipuCodingPlan(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	if (!callbacks.onPrompt) {
		throw new Error("Zhipu Coding Plan login requires interactive prompt support");
	}

	callbacks.onAuth({
		url: AUTH_URL,
		instructions: "Copy your API key from the Coding Plan dashboard",
	});

	const apiKey = await callbacks.onPrompt({
		message: "Paste your Zhipu API key",
		placeholder: "<id>.<secret>",
	});

	if (callbacks.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("API key is required");
	}

	// Zhipu API keys don't expire; store as non-expiring credential
	return {
		access: trimmed,
		refresh: trimmed,
		expires: Number.MAX_SAFE_INTEGER,
	};
}

export const zhipuCodingPlanOAuthProvider: OAuthProviderInterface = {
	id: ZHIPU_CODING_PLAN_PROVIDER_ID,
	name: "Zhipu Coding Plan (智谱)",
	login: loginZhipuCodingPlan,
	refreshToken: (credentials: OAuthCredentials) => Promise.resolve(credentials),
	getApiKey: (credentials: OAuthCredentials) => credentials.access,
};
