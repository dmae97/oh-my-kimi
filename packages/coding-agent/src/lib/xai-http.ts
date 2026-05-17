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
 * Priority:
 *   1. xai-oauth (SuperGrok subscription token via AuthStorage; refresh
 *      cascade runs inside ModelRegistry.getApiKeyForProvider).
 *   2. XAI_API_KEY environment variable (legacy/headless).
 *
 * Returns null when neither credential is available. Caller is responsible
 * for surfacing an actionable error message in that case.
 *
 * baseURL: respects XAI_BASE_URL override (trailing slash stripped); falls
 * back to https://api.x.ai/v1.
 */
export async function resolveXAIHttpCredentials(modelRegistry: ModelRegistry): Promise<XAICredentials | null> {
	const baseURL = ($env.XAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");

	const oauthKey = await modelRegistry.getApiKeyForProvider("xai-oauth");
	if (oauthKey) {
		return { provider: "xai-oauth", apiKey: oauthKey, baseURL };
	}

	const apiKey = $env.XAI_API_KEY;
	if (apiKey) {
		return { provider: "xai", apiKey, baseURL };
	}

	return null;
}
