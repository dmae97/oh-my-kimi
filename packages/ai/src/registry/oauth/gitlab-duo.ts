import { clearGitLabDuoDirectAccessCache } from "../../providers/gitlab-duo";
import { OAuthCallbackFlow } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types";

const GITLAB_COM_URL = "https://gitlab.com";
const BUNDLED_CLIENT_ID = "da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b";
const OAUTH_SCOPES = ["api"];
const CALLBACK_PORT = 8080;
const CALLBACK_PATH = "/callback";

interface PKCEPair {
	verifier: string;
	challenge: string;
}

function mapTokenResponse(payload: {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	created_at?: number;
}): OAuthCredentials {
	if (!payload.access_token || !payload.refresh_token || typeof payload.expires_in !== "number") {
		throw new Error("GitLab OAuth token response missing required fields");
	}

	const createdAtMs =
		typeof payload.created_at === "number" && Number.isFinite(payload.created_at)
			? payload.created_at * 1000
			: Date.now();

	return {
		access: payload.access_token,
		refresh: payload.refresh_token,
		expires: createdAtMs + payload.expires_in * 1000 - 5 * 60 * 1000,
	};
}

class GitLabDuoOAuthFlow extends OAuthCallbackFlow {
	#pkce: PKCEPair;

	constructor(ctrl: OAuthLoginCallbacks, pkce: PKCEPair) {
		super(ctrl, CALLBACK_PORT, CALLBACK_PATH);
		this.#pkce = pkce;
	}

	override async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const authParams = new URLSearchParams({
			client_id: BUNDLED_CLIENT_ID,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: OAUTH_SCOPES.join(" "),
			code_challenge: this.#pkce.challenge,
			code_challenge_method: "S256",
			state,
		});

		return {
			url: `${GITLAB_COM_URL}/oauth/authorize?${authParams.toString()}`,
			instructions: "Complete GitLab login in browser. Authentication will finish automatically.",
		};
	}

	override async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		const response = await fetch(`${GITLAB_COM_URL}/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: BUNDLED_CLIENT_ID,
				grant_type: "authorization_code",
				code,
				code_verifier: this.#pkce.verifier,
				redirect_uri: redirectUri,
			}).toString(),
		});

		if (!response.ok) {
			throw new Error(`GitLab OAuth token exchange failed: ${response.status} ${await response.text()}`);
		}

		clearGitLabDuoDirectAccessCache();
		return mapTokenResponse(
			(await response.json()) as {
				access_token?: string;
				refresh_token?: string;
				expires_in?: number;
				created_at?: number;
			},
		);
	}
}

export async function loginGitLabDuo(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const pkce = await generatePKCE();
	const flow = new GitLabDuoOAuthFlow(callbacks, pkce);
	return flow.login();
}

export async function refreshGitLabDuoToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const response = await fetch(`${GITLAB_COM_URL}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: BUNDLED_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
		}).toString(),
	});

	if (!response.ok) {
		throw new Error(`GitLab OAuth refresh failed: ${response.status} ${await response.text()}`);
	}

	clearGitLabDuoDirectAccessCache();
	return mapTokenResponse(
		(await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			created_at?: number;
		},
	);
}
