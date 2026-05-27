// Ported from NousResearch/hermes-agent (MIT) — tools/xai_http.py.

import { $env } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";

interface XAICredentials {
	provider: "xai-oauth" | "xai";
	apiKey: string;
	baseURL: string;
}

export function ohMyPiXAIUserAgent(): string {
	return "oh-my-pi/xai";
}

/**
 * Resolve xAI credentials for HTTP tool calls.
 *
 * Credential priority:
 *   1. xai-oauth — only when a *dedicated* xai-oauth source exists. Composed
 *      of two checks against the registry layer:
 *        a. `authStorage.hasNonEnvCredential("xai-oauth")` covers stored
 *           credentials (OAuth or api_key), runtime overrides (CLI
 *           `--api-key` for xai-oauth), config overrides (models.yml
 *           `providers.xai-oauth.apiKey`), and fallback resolvers.
 *        b. `$env.XAI_OAUTH_TOKEN` covers the xai-oauth-specific env var.
 *      `XAI_API_KEY` is intentionally NOT a signal here, even though the
 *      env-fallback map (`stream.ts: "xai-oauth"`) lets xai-oauth borrow it
 *      as a back-compat convenience: the borrow lets API-key-only setups
 *      satisfy the xai-oauth branch and then resolve baseUrl under
 *      xai-oauth instead of xai, silently bypassing `providers.xai.baseUrl`
 *      overrides for image/TTS traffic. The gate routes the borrow case to
 *      step 2 while preserving every dedicated xai-oauth path.
 *   2. xai (plain API key). Delegates to ModelRegistry.getApiKeyForProvider
 *      which runs AuthStorage.getApiKey's full cascade: runtime override →
 *      models.yml config override → stored api_key credential → OAuth
 *      resolution → XAI_API_KEY env var → custom fallback resolver.
 *
 * Returns null when neither credential is available. Caller is responsible
 * for surfacing an actionable error message in that case.
 *
 * baseURL: respects XAI_BASE_URL override (trailing slash stripped); falls
 * back to https://api.x.ai/v1.
 */
export async function resolveXAIHttpCredentials(modelRegistry: ModelRegistry): Promise<XAICredentials | null> {
	const baseURL = ($env.XAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");

	const hasDedicatedXaiOAuth =
		modelRegistry.authStorage.hasNonEnvCredential("xai-oauth") || Boolean($env.XAI_OAUTH_TOKEN);
	if (hasDedicatedXaiOAuth) {
		const oauthKey = await modelRegistry.getApiKeyForProvider("xai-oauth");
		if (oauthKey) {
			return { provider: "xai-oauth", apiKey: oauthKey, baseURL };
		}
	}

	const apiKey = await modelRegistry.getApiKeyForProvider("xai");
	if (apiKey) {
		return { provider: "xai", apiKey, baseURL };
	}

	return null;
}
