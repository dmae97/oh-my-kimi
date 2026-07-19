/**
 * Grok (xAI) via the local grok-oauth-proxy.
 *
 * OMK reaches xAI/Grok through a local, OpenAI-compatible proxy that owns the
 * single OAuth refresher (see `~/.omk/agent/grok.md`). This provider deliberately
 * does NOT run a competing xAI OAuth flow; "login" only verifies the local proxy
 * is reachable and records a local marker credential. Chat requests use the
 * proxy's local API key (dummy by default) against the proxy base URL.
 */

import type { Api, Model } from "../../types.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

export const GROK_PROXY_PROVIDER_ID = "grok-oauth-proxy";

const DEFAULT_BASE_URL = "http://127.0.0.1:9996/v1";
const DEFAULT_API_KEY = "dummy";
/** Marker credential lifetime; the proxy owns real token refresh, we just re-check health. */
const MARKER_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function getBaseUrl(): string {
	const fromEnv = typeof process !== "undefined" ? process.env.OMK_GROK_PROXY_BASE_URL : undefined;
	return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_BASE_URL;
}

function getLocalApiKey(): string {
	const fromEnv = typeof process !== "undefined" ? process.env.OMK_GROK_PROXY_API_KEY : undefined;
	return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_API_KEY;
}

function startHint(baseUrl: string): string {
	return `Grok proxy not reachable at ${baseUrl}. Start it with: systemctl --user start grok-oauth-proxy`;
}

async function checkProxyHealth(signal?: AbortSignal): Promise<void> {
	const baseUrl = getBaseUrl();
	const healthUrl = new URL("/health", baseUrl).href;
	let response: Response;
	try {
		response = await fetch(healthUrl, { method: "GET", signal });
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw new Error(`${startHint(baseUrl)} (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!response.ok) {
		throw new Error(
			`Grok proxy health check failed (HTTP ${response.status}) at ${healthUrl}. ${startHint(baseUrl)}`,
		);
	}
}

function markerCredentials(): OAuthCredentials {
	return { access: GROK_PROXY_PROVIDER_ID, refresh: GROK_PROXY_PROVIDER_ID, expires: Date.now() + MARKER_TTL_MS };
}

/** Verify the local Grok proxy is reachable and return a marker credential. */
export async function loginGrokProxy(options: {
	onProgress?: OAuthLoginCallbacks["onProgress"];
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	options.onProgress?.(`Checking local Grok proxy health at ${getBaseUrl()}...`);
	await checkProxyHealth(options.signal);
	options.onProgress?.("Grok proxy is reachable.");
	return markerCredentials();
}

function grokModels(baseUrl: string): Model<"openai-completions">[] {
	const shared = {
		api: "openai-completions" as const,
		provider: GROK_PROXY_PROVIDER_ID,
		baseUrl,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 32_768,
	};
	return [
		{ ...shared, id: "grok-4.5", name: "Grok 4.5", reasoning: true },
		{ ...shared, id: "grok-4.3", name: "Grok 4.3", reasoning: true },
	];
}

export const grokProxyOAuthProvider: OAuthProviderInterface = {
	id: GROK_PROXY_PROVIDER_ID,
	name: "Grok (xAI OAuth Proxy)",
	usesCallbackServer: false,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginGrokProxy({ onProgress: callbacks.onProgress, signal: callbacks.signal });
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		// The proxy owns real token refresh; we only re-verify reachability.
		await checkProxyHealth();
		return { ...credentials, expires: Date.now() + MARKER_TTL_MS };
	},

	getApiKey(): string {
		return getLocalApiKey();
	},

	modifyModels(models: Model<Api>[]): Model<Api>[] {
		// Non-destructive: keep any user-configured grok-oauth-proxy models, only add missing defaults.
		const existingIds = new Set(
			models.filter((model) => model.provider === GROK_PROXY_PROVIDER_ID).map((model) => model.id),
		);
		const additions = grokModels(getBaseUrl()).filter((model) => !existingIds.has(model.id));
		return [...models, ...additions];
	},
};
