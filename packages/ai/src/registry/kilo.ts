import { kiloModelManagerOptions } from "../provider-models/openai-compat";
import type { OAuthController, OAuthCredentials } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

const KILO_DEVICE_AUTH_BASE_URL = "https://api.kilo.ai/api/device-auth";
const POLL_INTERVAL_MS = 5000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

interface KiloDeviceAuthCodeResponse {
	code?: string;
	verificationUrl?: string;
	expiresIn?: number;
}

interface KiloDeviceAuthPollResponse {
	status?: string;
	token?: string;
}

export async function loginKilo(callbacks: OAuthController): Promise<OAuthCredentials> {
	const initiateResponse = await fetch(`${KILO_DEVICE_AUTH_BASE_URL}/codes`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
	});

	if (!initiateResponse.ok) {
		if (initiateResponse.status === 429) {
			throw new Error("Too many pending authorization requests. Please try again later.");
		}
		throw new Error(`Failed to initiate device authorization: ${initiateResponse.status}`);
	}

	const initiateData = (await initiateResponse.json()) as KiloDeviceAuthCodeResponse;
	const userCode = initiateData.code;
	const verificationUrl = initiateData.verificationUrl;
	const expiresInSeconds = initiateData.expiresIn;
	if (!userCode || !verificationUrl || typeof expiresInSeconds !== "number" || expiresInSeconds <= 0) {
		throw new Error("Kilo device authorization response missing required fields");
	}

	callbacks.onAuth?.({
		url: verificationUrl,
		instructions: `Enter code: ${userCode}`,
	});

	const deadline = Date.now() + expiresInSeconds * 1000;
	while (Date.now() < deadline) {
		if (callbacks.signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const pollResponse = await fetch(`${KILO_DEVICE_AUTH_BASE_URL}/codes/${encodeURIComponent(userCode)}`);
		if (pollResponse.status === 202) {
			await Bun.sleep(POLL_INTERVAL_MS);
			continue;
		}
		if (pollResponse.status === 403) {
			throw new Error("Authorization was denied");
		}
		if (pollResponse.status === 410) {
			throw new Error("Authorization code expired. Please try again.");
		}
		if (!pollResponse.ok) {
			throw new Error(`Failed to poll device authorization: ${pollResponse.status}`);
		}

		const pollData = (await pollResponse.json()) as KiloDeviceAuthPollResponse;
		if (pollData.status === "approved" && pollData.token) {
			return {
				refresh: "",
				access: pollData.token,
				expires: Date.now() + ONE_YEAR_MS,
			};
		}
		if (pollData.status === "denied") {
			throw new Error("Authorization was denied");
		}
		if (pollData.status === "expired") {
			throw new Error("Authorization code expired. Please try again.");
		}

		await Bun.sleep(POLL_INTERVAL_MS);
	}

	throw new Error("Authentication timed out. Please try again.");
}

export const kiloProvider = {
	id: "kilo",
	name: "Kilo Gateway",
	defaultModel: "anthropic/claude-sonnet-4.5",
	createModelManagerOptions: (config: ModelManagerConfig) => kiloModelManagerOptions(config),
	catalogDiscovery: { label: "Kilo Gateway", envVars: ["KILO_API_KEY"], allowUnauthenticated: true },
	envKeys: "KILO_API_KEY",
	login: loginKilo,
} as const satisfies ProviderDefinition;
