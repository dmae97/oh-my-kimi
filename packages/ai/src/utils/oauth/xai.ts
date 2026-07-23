/**
 * xAI Grok OAuth (native device authorization flow).
 *
 * RFC 8628 device-authorization grant with OIDC discovery.
 * Uses the official xAI OAuth client id and scopes.
 */
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";

const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 15_000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

export const XAI_OAUTH_PROVIDER_ID = "xai";

interface XAIOAuthDiscovery {
	token_endpoint: string;
}

interface XAIDeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUriComplete: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function validateXAIEndpoint(url: string, field: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Invalid xAI ${field}: ${url}`);
	}
	if (parsed.protocol !== "https:") {
		throw new Error(`Invalid xAI ${field}: ${url}`);
	}
	const host = parsed.hostname.toLowerCase();
	if (!host || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
		throw new Error(`Invalid xAI ${field}: ${url}`);
	}
	return url;
}

export function isXAIAccessTokenExpiring(jwt: string, skewSeconds = 0): boolean {
	try {
		if (typeof jwt !== "string" || !jwt.includes(".")) return false;
		const parts = jwt.split(".");
		if (parts.length < 2) return false;
		const payloadPart = parts[1];
		if (!payloadPart) return false;
		const decoded = Buffer.from(payloadPart, "base64url").toString("utf8");
		const payload: unknown = JSON.parse(decoded);
		if (!isRecord(payload)) return false;
		const exp = payload.exp;
		if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
		const now = Math.floor(Date.now() / 1000);
		return exp <= now + Math.max(0, Math.floor(skewSeconds));
	} catch {
		return false;
	}
}

async function xaiOAuthDiscovery(timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<XAIOAuthDiscovery> {
	let response: Response;
	try {
		response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw new Error(`xAI OIDC discovery failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (response.status !== 200) {
		throw new Error(`xAI OIDC discovery returned status ${response.status}.`);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error(
			`xAI OIDC discovery returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(payload)) {
		throw new Error("xAI OIDC discovery response was not a JSON object.");
	}
	const tokenEndpoint = typeof payload.token_endpoint === "string" ? payload.token_endpoint.trim() : "";
	if (!tokenEndpoint) {
		throw new Error("xAI OIDC discovery response was missing token_endpoint.");
	}
	validateXAIEndpoint(tokenEndpoint, "token_endpoint");
	return { token_endpoint: tokenEndpoint };
}

function parseXAIDeviceAuthorization(payload: unknown): XAIDeviceAuthorization {
	if (!isRecord(payload)) {
		throw new Error("xAI device-code response was not a JSON object.");
	}

	const deviceCode = typeof payload.device_code === "string" ? payload.device_code.trim() : "";
	const userCode = typeof payload.user_code === "string" ? payload.user_code.trim() : "";
	const verificationUri = typeof payload.verification_uri === "string" ? payload.verification_uri.trim() : "";
	const verificationUriComplete =
		typeof payload.verification_uri_complete === "string" ? payload.verification_uri_complete.trim() : "";
	const expiresInSeconds = payload.expires_in;
	const intervalSeconds = payload.interval;
	if (
		!deviceCode ||
		!userCode ||
		!verificationUri ||
		!verificationUriComplete ||
		typeof expiresInSeconds !== "number" ||
		!Number.isFinite(expiresInSeconds) ||
		expiresInSeconds <= 0 ||
		typeof intervalSeconds !== "number" ||
		!Number.isFinite(intervalSeconds) ||
		intervalSeconds <= 0
	) {
		throw new Error("xAI device-code response missing or invalid required fields.");
	}

	validateXAIEndpoint(verificationUri, "verification_uri");
	validateXAIEndpoint(verificationUriComplete, "verification_uri_complete");
	return {
		deviceCode,
		userCode,
		verificationUriComplete,
		expiresInSeconds,
		intervalSeconds,
	};
}

function parseXAITokenResponse(payload: unknown, label: string, refreshTokenFallback?: string): OAuthCredentials {
	if (!isRecord(payload)) {
		throw new Error(`${label} was not a JSON object`);
	}
	const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
	const responseRefreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
	const refreshToken = responseRefreshToken || refreshTokenFallback || "";
	const expiresInSeconds = payload.expires_in;
	if (!accessToken) {
		throw new Error(`${label} missing access_token`);
	}
	if (!refreshToken) {
		throw new Error(`${label} missing refresh_token`);
	}
	if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds)) {
		throw new Error(`${label} missing expires_in`);
	}
	return {
		access: accessToken,
		refresh: refreshToken,
		expires: Date.now() + expiresInSeconds * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS,
	};
}

async function requestXAIDeviceAuthorization(signal?: AbortSignal): Promise<XAIDeviceAuthorization> {
	let response: Response;
	try {
		const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
		response = await fetch(XAI_OAUTH_DEVICE_CODE_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: new URLSearchParams({
				client_id: XAI_OAUTH_CLIENT_ID,
				scope: XAI_OAUTH_SCOPE,
			}),
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});
	} catch (error) {
		if (signal?.aborted) throw new Error("Login cancelled");
		throw new Error(`xAI device-code request failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!response.ok) {
		let detail = "";
		try {
			detail = (await response.text()).trim();
		} catch {
			// Ignore body-read failures
		}
		throw new Error(`xAI device-code request failed: ${response.status}${detail ? ` ${detail}` : ""}`);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error(
			`xAI device-code response returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseXAIDeviceAuthorization(payload);
}

async function pollXAIDeviceToken(
	tokenEndpoint: string,
	deviceCode: string,
	signal?: AbortSignal,
): Promise<
	| { status: "pending" }
	| { status: "slow_down" }
	| { status: "failed"; message: string }
	| { status: "complete"; value: OAuthCredentials }
> {
	let response: Response;
	try {
		const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
		response = await fetch(tokenEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: XAI_OAUTH_CLIENT_ID,
				device_code: deviceCode,
			}),
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});
	} catch (error) {
		if (signal?.aborted) throw new Error("Login cancelled");
		throw new Error(
			`xAI device-code token polling failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error(
			`xAI device-code token polling returned invalid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	if (response.ok) {
		return {
			status: "complete",
			value: parseXAITokenResponse(payload, "xAI device-code token response"),
		};
	}
	if (!isRecord(payload)) {
		throw new Error(`xAI device-code token polling failed: ${response.status}`);
	}

	const errorCode = typeof payload.error === "string" ? payload.error : "";
	if (errorCode === "authorization_pending") return { status: "pending" };
	if (errorCode === "slow_down") return { status: "slow_down" };

	const errorDescription = typeof payload.error_description === "string" ? payload.error_description : "";
	const detail = errorDescription || errorCode || String(response.status);
	throw new Error(`xAI device-code token polling failed: ${detail}`);
}

/** Log in to xAI Grok with the RFC 8628 device authorization grant. */
export async function loginXAI(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const discovery = await xaiOAuthDiscovery(DISCOVERY_TIMEOUT_MS);
	const device = await requestXAIDeviceAuthorization(callbacks.signal);

	callbacks.onAuth({
		url: device.verificationUriComplete,
		instructions: `Enter code: ${device.userCode}`,
	});
	callbacks.onProgress?.("Waiting for xAI device authorization...");

	return pollOAuthDeviceCodeFlow({
		poll: () => pollXAIDeviceToken(discovery.token_endpoint, device.deviceCode, callbacks.signal),
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		signal: callbacks.signal,
	});
}

/**
 * Refresh an xAI OAuth access token using a stored refresh_token.
 * Re-runs OIDC discovery and re-validates the token endpoint before sending.
 */
export async function refreshXAIToken(refreshToken: string): Promise<OAuthCredentials> {
	if (typeof refreshToken !== "string" || !refreshToken.trim()) {
		throw new Error("missing refresh_token");
	}

	const discovery = await xaiOAuthDiscovery(DISCOVERY_TIMEOUT_MS);
	const tokenEndpoint = validateXAIEndpoint(discovery.token_endpoint, "token_endpoint");

	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: XAI_OAUTH_CLIENT_ID,
		refresh_token: refreshToken,
	});

	const response = await fetch(tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body,
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});

	if (!response.ok) {
		let detail = "";
		try {
			detail = (await response.text()).trim();
		} catch {
			// Ignore body-read failures
		}
		throw new Error(`xAI token refresh failed: ${response.status}${detail ? ` ${detail}` : ""}`);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error(
			`xAI token refresh returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return parseXAITokenResponse(payload, "xAI token refresh response", refreshToken);
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: XAI_OAUTH_PROVIDER_ID,
	name: "xAI Grok (SuperGrok or X Premium+)",
	login: loginXAI,
	refreshToken: (credentials: OAuthCredentials) => refreshXAIToken(credentials.refresh),
	getApiKey: (credentials: OAuthCredentials) => credentials.access,
};
