/**
 * Antigravity OAuth flow (Gemini 3, Claude, GPT-OSS via Google Cloud).
 *
 * Uses different OAuth credentials than google-gemini-cli for access to
 * additional models through the Antigravity platform.
 */
import { refreshGoogleToken, runGoogleOAuthLogin } from "./google-oauth-shared.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const CLIENT_SECRET = decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = "/oauth-callback";

const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUD_CODE_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const TIER_LEGACY = "legacy-tier";
const PROJECT_ONBOARD_MAX_ATTEMPTS = 5;
const PROJECT_ONBOARD_INTERVAL_MS = 2000;

export const GOOGLE_ANTIGRAVITY_PROVIDER_ID = "google-antigravity";

const ANTIGRAVITY_METADATA = Object.freeze({
	ideType: "ANTIGRAVITY",
	platform: "PLATFORM_UNSPECIFIED",
	pluginType: "GEMINI",
});

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string | { id?: string };
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

interface LongRunningOperationResponse {
	done?: boolean;
	response?: {
		cloudaicompanionProject?: string | { id?: string };
	};
}

function readProjectId(value: string | { id?: string } | undefined): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (value && typeof value === "object" && typeof value.id === "string" && value.id.length > 0) return value.id;
	return undefined;
}

function getDefaultTierId(allowedTiers?: Array<{ id?: string; isDefault?: boolean }>): string {
	if (!allowedTiers || allowedTiers.length === 0) return TIER_LEGACY;
	const defaultTier = allowedTiers.find((tier) => tier.isDefault && typeof tier.id === "string" && tier.id.length > 0);
	if (defaultTier?.id) return defaultTier.id;
	return TIER_LEGACY;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function onboardProjectWithRetries(
	endpoint: string,
	headers: Record<string, string>,
	onboardBody: { tierId: string; metadata: typeof ANTIGRAVITY_METADATA },
	onProgress?: (message: string) => void,
): Promise<string> {
	for (let attempt = 1; attempt <= PROJECT_ONBOARD_MAX_ATTEMPTS; attempt += 1) {
		if (attempt > 1) {
			onProgress?.(`Waiting for project provisioning (attempt ${attempt}/${PROJECT_ONBOARD_MAX_ATTEMPTS})...`);
			await sleep(PROJECT_ONBOARD_INTERVAL_MS);
		}

		const onboardResponse = await fetch(`${endpoint}/v1internal:onboardUser`, {
			method: "POST",
			headers,
			body: JSON.stringify(onboardBody),
		});

		if (!onboardResponse.ok) {
			const errorText = await onboardResponse.text();
			throw new Error(`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${errorText}`);
		}

		const operation = (await onboardResponse.json()) as LongRunningOperationResponse;
		if (!operation.done) continue;

		const projectId = readProjectId(operation.response?.cloudaicompanionProject);
		if (projectId) return projectId;
	}

	throw new Error(
		`onboardUser did not return a provisioned project id after ${PROJECT_ONBOARD_MAX_ATTEMPTS} attempts`,
	);
}

async function discoverProject(accessToken: string, onProgress?: (message: string) => void): Promise<string> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
	};

	onProgress?.("Checking for existing project...");
	const endpoint = CLOUD_CODE_ENDPOINT;

	const loadResponse = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
		method: "POST",
		headers,
		body: JSON.stringify({ metadata: ANTIGRAVITY_METADATA }),
	});

	if (!loadResponse.ok) {
		const errorText = await loadResponse.text();
		throw new Error(`loadCodeAssist failed: ${loadResponse.status} ${loadResponse.statusText}: ${errorText}`);
	}

	const loadPayload = (await loadResponse.json()) as LoadCodeAssistPayload;
	const existingProject = readProjectId(loadPayload.cloudaicompanionProject);
	if (existingProject) return existingProject;

	const tierId = getDefaultTierId(loadPayload.allowedTiers);
	onProgress?.("Provisioning project...");
	return onboardProjectWithRetries(endpoint, headers, { tierId, metadata: ANTIGRAVITY_METADATA }, onProgress);
}

/** Log in to Antigravity. */
export async function loginAntigravity(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	return runGoogleOAuthLogin(callbacks, {
		clientId: CLIENT_ID,
		clientSecret: CLIENT_SECRET,
		authUrl: AUTH_URL,
		tokenUrl: TOKEN_URL,
		scopes: SCOPES,
		callbackPort: CALLBACK_PORT,
		callbackPath: CALLBACK_PATH,
		discoverProject,
	});
}

/** Refresh an Antigravity token. */
export async function refreshAntigravityToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	if (!credentials.projectId) {
		throw new Error("Antigravity credentials missing projectId");
	}
	return refreshGoogleToken(
		{ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tokenUrl: TOKEN_URL },
		credentials.refresh,
		credentials.projectId as string,
	);
}

export const googleAntigravityOAuthProvider: OAuthProviderInterface = {
	id: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
	name: "Antigravity (Gemini 3, Claude, GPT-OSS)",
	login: loginAntigravity,
	refreshToken: refreshAntigravityToken,
	getApiKey: (credentials: OAuthCredentials) => credentials.access,
};
