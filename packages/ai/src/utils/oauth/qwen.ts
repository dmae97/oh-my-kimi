/**
 * Qwen OAuth (Qwen Code subscription).
 *
 * RFC 8628 device-authorization flow with PKCE. The client id, endpoints and
 * scopes mirror the open-source qwen-code CLI. After login the token response
 * carries a `resource_url` pointing at an OpenAI-compatible chat endpoint, so
 * Qwen models are exposed through the standard `openai-completions` API.
 */

import type { Api, Model } from "../../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

export const QWEN_OAUTH_PROVIDER_ID = "qwen-oauth";

const DEVICE_CODE_URL = "https://chat.qwen.ai/api/v1/oauth2/device/code";
const TOKEN_URL = "https://chat.qwen.ai/api/v1/oauth2/token";
const CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
const SCOPE = "openid profile email model.completion";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_VERIFICATION_URI = "https://chat.qwen.ai";
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const QWEN_RESOURCE_HOST_SUFFIXES = ["qwen.ai", "aliyuncs.com"] as const;

type QwenDeviceAuthResponse = {
	device_code?: string;
	user_code?: string;
	verification_uri?: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
};

type QwenTokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	resource_url?: string;
	error?: string;
	error_description?: string;
};

function formEncode(data: Record<string, string>): string {
	return new URLSearchParams(data).toString();
}

/** Normalize an OAuth `resource_url`, rejecting origins that could receive the bearer token. */
export function normalizeQwenBaseUrl(resourceUrl: string | undefined): string {
	if (!resourceUrl || resourceUrl.trim().length === 0) {
		return DEFAULT_BASE_URL;
	}
	try {
		const raw = resourceUrl.trim();
		const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
		const hostname = url.hostname.toLowerCase();
		const approvedHost = QWEN_RESOURCE_HOST_SUFFIXES.some(
			(suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
		);
		if (
			url.protocol !== "https:" ||
			!approvedHost ||
			url.username !== "" ||
			url.password !== "" ||
			(url.port !== "" && url.port !== "443") ||
			url.search !== "" ||
			url.hash !== ""
		) {
			throw new Error("unapproved origin");
		}
		const path = url.pathname.replace(/\/+$/, "");
		url.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
		return url.toString();
	} catch {
		throw new Error("Qwen resource_url must use an approved HTTPS origin");
	}
}

function normalizeVerificationUri(...candidates: Array<string | undefined>): string {
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const url = new URL(candidate);
			if (
				url.protocol === "https:" &&
				url.hostname.toLowerCase() === "chat.qwen.ai" &&
				url.username === "" &&
				url.password === ""
			) {
				return url.toString();
			}
		} catch {
			// Try the next fixed-origin candidate.
		}
	}
	return DEFAULT_VERIFICATION_URI;
}

function credentialsFromToken(json: QwenTokenResponse, fallbackRefresh?: string): OAuthCredentials {
	if (!json.access_token) {
		throw new Error("Qwen token response missing access_token");
	}
	const refresh = json.refresh_token ?? fallbackRefresh;
	if (!refresh) {
		throw new Error("Qwen token response missing refresh_token");
	}
	const expiresInSeconds = typeof json.expires_in === "number" ? json.expires_in : 3600;
	const credentials: OAuthCredentials = {
		access: json.access_token,
		refresh,
		expires: Date.now() + expiresInSeconds * 1000 - 30_000,
	};
	if (typeof json.resource_url === "string" && json.resource_url.length > 0) {
		normalizeQwenBaseUrl(json.resource_url);
		credentials.resource_url = json.resource_url;
	}
	return credentials;
}

async function requestDeviceCode(challenge: string, signal?: AbortSignal): Promise<QwenDeviceAuthResponse> {
	const response = await fetch(DEVICE_CODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: formEncode({
			client_id: CLIENT_ID,
			scope: SCOPE,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}),
		signal,
	});
	if (!response.ok) {
		throw new Error(`Qwen device code request failed (${response.status})`);
	}
	const json = (await response.json()) as QwenDeviceAuthResponse;
	if (!json?.device_code || !json.user_code) {
		throw new Error("Invalid Qwen device code response");
	}
	return json;
}

async function pollForToken(
	deviceCode: string,
	verifier: string,
	intervalSeconds: number | undefined,
	signal: AbortSignal | undefined,
): Promise<OAuthCredentials> {
	return pollOAuthDeviceCodeFlow<OAuthCredentials>({
		intervalSeconds,
		expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
		signal,
		poll: async () => {
			const response = await fetch(TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
				body: formEncode({
					grant_type: DEVICE_GRANT_TYPE,
					client_id: CLIENT_ID,
					device_code: deviceCode,
					code_verifier: verifier,
				}),
				signal,
			});

			if (response.ok) {
				const json = (await response.json()) as QwenTokenResponse;
				if (!json.access_token) {
					return { status: "failed", message: "Qwen token response missing access_token" };
				}
				return { status: "complete", value: credentialsFromToken(json) };
			}

			const text = await response.text().catch(() => "");
			let errorCode: string | undefined;
			try {
				errorCode = (JSON.parse(text) as QwenTokenResponse).error;
			} catch {
				// non-JSON error body
			}
			if (errorCode === "authorization_pending") {
				return { status: "pending" };
			}
			if (errorCode === "slow_down") {
				return { status: "slow_down" };
			}
			return { status: "failed", message: `Qwen token poll failed (${response.status})` };
		},
	});
}

/** Run the Qwen device-authorization login flow. */
export async function loginQwen(options: {
	onDeviceCode: OAuthLoginCallbacks["onDeviceCode"];
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const device = await requestDeviceCode(challenge, options.signal);
	options.onDeviceCode({
		userCode: device.user_code ?? "",
		verificationUri: normalizeVerificationUri(device.verification_uri_complete, device.verification_uri),
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in ?? DEVICE_CODE_TIMEOUT_SECONDS,
	});
	return pollForToken(device.device_code ?? "", verifier, device.interval, options.signal);
}

/** Refresh a Qwen OAuth token. */
export async function refreshQwenToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: formEncode({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken }),
	});
	if (!response.ok) {
		throw new Error(`Qwen token refresh failed (${response.status})`);
	}
	const json = (await response.json()) as QwenTokenResponse;
	return credentialsFromToken(json, refreshToken);
}

function qwenModels(baseUrl: string): Model<"openai-completions">[] {
	const shared = {
		api: "openai-completions" as const,
		provider: QWEN_OAUTH_PROVIDER_ID,
		baseUrl,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	};
	return [
		{ ...shared, id: "qwen3-coder-plus", name: "Qwen3 Coder Plus" },
		{ ...shared, id: "qwen3-coder-flash", name: "Qwen3 Coder Flash" },
	];
}

export const qwenOAuthProvider: OAuthProviderInterface = {
	id: QWEN_OAUTH_PROVIDER_ID,
	name: "Qwen (Qwen Code Subscription)",
	usesCallbackServer: false,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginQwen({ onDeviceCode: callbacks.onDeviceCode, signal: callbacks.signal });
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		const refreshed = await refreshQwenToken(credentials.refresh);
		// The refresh response may omit resource_url; keep the previously resolved endpoint.
		if (refreshed.resource_url === undefined && typeof credentials.resource_url === "string") {
			refreshed.resource_url = credentials.resource_url;
		}
		return refreshed;
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},

	modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
		const resourceUrl = typeof credentials.resource_url === "string" ? credentials.resource_url : undefined;
		const baseUrl = normalizeQwenBaseUrl(resourceUrl);
		// Non-destructive: keep any user-configured qwen-oauth models, only add missing defaults.
		const existingIds = new Set(
			models.filter((model) => model.provider === QWEN_OAUTH_PROVIDER_ID).map((model) => model.id),
		);
		const additions = qwenModels(baseUrl).filter((model) => !existingIds.has(model.id));
		return [...models, ...additions];
	},
};
