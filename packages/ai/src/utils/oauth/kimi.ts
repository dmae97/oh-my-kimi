/**
 * Kimi Code OAuth flow (device authorization grant).
 *
 * Kimi Code is Moonshot AI's coding subscription service.
 * Uses RFC 8628 device authorization flow with a persistent device id.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEVICE_ID_FILENAME = "kimi-device-id";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;
const OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;

export const KIMI_CODE_OAUTH_PROVIDER_ID = "kimi-code";

interface DeviceAuthorizationResponse {
	user_code?: string;
	device_code?: string;
	verification_uri?: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
	interval?: number;
}

function _sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveOAuthHost(): string {
	return process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || DEFAULT_OAUTH_HOST;
}

function formatDeviceModel(system: string, release: string, arch: string): string {
	return [system, release, arch].filter(Boolean).join(" ").trim();
}

function getDeviceModel(): string {
	const platform = os.platform();
	const release = os.release();
	const arch = os.arch();
	if (platform === "darwin") return formatDeviceModel("macOS", release, arch);
	if (platform === "win32") return formatDeviceModel("Windows", release, arch);
	const label = platform === "linux" ? "Linux" : platform;
	return formatDeviceModel(label, release, arch);
}

function getDeviceIdPath(): string {
	const agentDir = process.env.OMK_AGENT_DIR || path.join(os.homedir(), ".omk", "agent");
	return path.join(agentDir, DEVICE_ID_FILENAME);
}

function readPersistedDeviceId(): string | null {
	try {
		const filePath = getDeviceIdPath();
		if (fs.existsSync(filePath)) {
			const id = fs.readFileSync(filePath, "utf-8").trim();
			if (id.length > 0) return id;
		}
	} catch {
		// Best-effort
	}
	return null;
}

function persistDeviceId(deviceId: string): void {
	try {
		const filePath = getDeviceIdPath();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, deviceId, "utf-8");
	} catch {
		// Best-effort
	}
}

function getOrCreateDeviceId(): string {
	const existing = readPersistedDeviceId();
	if (existing) return existing;
	const deviceId = crypto.randomUUID();
	persistDeviceId(deviceId);
	return deviceId;
}

async function requestDeviceAuthorization(
	host: string,
	deviceId: string,
	signal?: AbortSignal,
): Promise<DeviceAuthorizationResponse> {
	const deviceModel = getDeviceModel();
	const response = await fetch(`${host}/oauth2/device/code`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			scope: "openid profile email offline_access",
			device_id: deviceId,
			device_model: deviceModel,
		}),
		signal,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Kimi device authorization failed: ${response.status} ${text}`);
	}

	return (await response.json()) as DeviceAuthorizationResponse;
}

async function pollKimiToken(
	host: string,
	deviceCode: string,
	signal?: AbortSignal,
): Promise<
	| { status: "pending" }
	| { status: "slow_down" }
	| { status: "failed"; message: string }
	| { status: "complete"; value: OAuthCredentials }
> {
	const response = await fetch(`${host}/oauth2/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			client_id: CLIENT_ID,
			device_code: deviceCode,
		}),
		signal,
	});

	const payload = (await response.json()) as TokenResponse;

	if (response.ok && payload.access_token) {
		const expiresInMs = (payload.expires_in ?? 3600) * 1000;
		return {
			status: "complete",
			value: {
				access: payload.access_token,
				refresh: payload.refresh_token || "",
				expires: Date.now() + expiresInMs - OAUTH_EXPIRY_SKEW_MS,
			},
		};
	}

	if (payload.error === "authorization_pending") return { status: "pending" };
	if (payload.error === "slow_down") return { status: "slow_down" };

	const detail = payload.error_description || payload.error || String(response.status);
	throw new Error(`Kimi token polling failed: ${detail}`);
}

/** Log in to Kimi Code using the device authorization flow. */
export async function loginKimiCode(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const host = resolveOAuthHost();
	const deviceId = getOrCreateDeviceId();

	const device = await requestDeviceAuthorization(host, deviceId, callbacks.signal);

	if (!device.device_code || !device.user_code) {
		throw new Error("Kimi device authorization response missing required fields");
	}

	const verificationUri =
		device.verification_uri_complete || `${device.verification_uri || host}/activate?user_code=${device.user_code}`;

	callbacks.onAuth({
		url: verificationUri,
		instructions: `Enter code: ${device.user_code}`,
	});
	callbacks.onProgress?.("Waiting for Kimi device authorization...");

	return pollOAuthDeviceCodeFlow({
		poll: () => pollKimiToken(host, device.device_code!, callbacks.signal),
		intervalSeconds: device.interval ?? Math.floor(DEFAULT_POLL_INTERVAL_MS / 1000),
		expiresInSeconds: device.expires_in ?? Math.floor(DEFAULT_DEVICE_FLOW_TTL_MS / 1000),
		signal: callbacks.signal,
	});
}

/** Refresh a Kimi Code OAuth token. */
export async function refreshKimiToken(refreshToken: string): Promise<OAuthCredentials> {
	const host = resolveOAuthHost();

	const response = await fetch(`${host}/oauth2/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		}),
	});

	const payload = (await response.json()) as TokenResponse;

	if (!response.ok || !payload.access_token) {
		const detail = payload.error_description || payload.error || String(response.status);
		throw new Error(`Kimi token refresh failed: ${detail}`);
	}

	const expiresInMs = (payload.expires_in ?? 3600) * 1000;
	return {
		access: payload.access_token,
		refresh: payload.refresh_token || refreshToken,
		expires: Date.now() + expiresInMs - OAUTH_EXPIRY_SKEW_MS,
	};
}

export const kimiCodeOAuthProvider: OAuthProviderInterface = {
	id: KIMI_CODE_OAUTH_PROVIDER_ID,
	name: "Kimi Code (Moonshot AI)",
	login: loginKimiCode,
	refreshToken: (credentials: OAuthCredentials) => refreshKimiToken(credentials.refresh),
	getApiKey: (credentials: OAuthCredentials) => credentials.access,
};
