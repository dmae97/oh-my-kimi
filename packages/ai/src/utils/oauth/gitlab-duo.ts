/**
 * GitLab Duo OAuth flow.
 *
 * Standard OAuth 2.0 authorization code flow with PKCE and a local callback server.
 * After login, provides access to GitLab Duo AI models (Claude, etc.).
 *
 * Users can customize the OAuth client:
 *   GITLAB_CLIENT_ID     — override the bundled client id
 *   GITLAB_REDIRECT_URI  — override the redirect URI (must match registered URI)
 *   GITLAB_TOKEN         — skip OAuth and use a Personal Access Token directly
 */
import type { Server } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const GITLAB_COM_URL = "https://gitlab.com";
const DEFAULT_CLIENT_ID = "da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b";
const OAUTH_SCOPES = ["api"];
const DEFAULT_CALLBACK_PORT = 8080;
const DEFAULT_CALLBACK_PATH = "/callback";
const DEFAULT_CALLBACK_HOSTNAME = "localhost";
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

export const GITLAB_DUO_OAUTH_PROVIDER_ID = "gitlab-duo";

type CallbackServerInfo = {
	server: Server;
	redirectUri: string;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
};

type NodeApis = {
	createServer: typeof import("node:http").createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("GitLab Duo OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

function resolveClientId(): string {
	const env = process.env.GITLAB_CLIENT_ID?.trim();
	return env && env.length > 0 ? env : DEFAULT_CLIENT_ID;
}

function resolveCallbackHostname(): string {
	return process.env.GITLAB_REDIRECT_URI_HOST?.trim() || DEFAULT_CALLBACK_HOSTNAME;
}

function resolveCallbackPort(): number {
	const env = process.env.GITLAB_REDIRECT_URI_PORT?.trim();
	if (env) {
		const port = Number.parseInt(env, 10);
		if (!Number.isNaN(port) && port > 0 && port < 65536) return port;
	}
	return DEFAULT_CALLBACK_PORT;
}

function resolveCallbackPath(): string {
	return process.env.GITLAB_REDIRECT_URI_PATH?.trim() || DEFAULT_CALLBACK_PATH;
}

function startCallbackServer(_verifier: string): Promise<CallbackServerInfo> {
	const hostname = resolveCallbackHostname();
	const port = resolveCallbackPort();
	const callbackPath = resolveCallbackPath();
	const redirectUri = `http://${hostname}:${port}${callbackPath}`;

	return getNodeApis().then(({ createServer }) => {
		return new Promise<CallbackServerInfo>((resolveServer) => {
			const server = createServer((req, res) => {
				if (!req.url?.startsWith(callbackPath)) {
					res.writeHead(404).end();
					return;
				}
				const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml);
					return;
				}

				if (!code) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml);
					return;
				}

				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthSuccessHtml);

				// Resolve the promise on the next tick so the response is sent first
				setImmediate(() => {
					resolveServer({
						server,
						redirectUri,
						cancelWait: () => {},
						waitForCode: () => Promise.resolve({ code, state: state || "" }),
					});
				});
			});

			server.listen(port, hostname, () => {
				// Server is ready — the auth URL will be opened by the caller
			});

			server.on("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE") {
					// Try a random port
					server.close();
					server.listen(0, hostname, () => {
						// Will use the assigned port
					});
				}
			});
		});
	});
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

async function exchangeToken(
	code: string,
	verifier: string,
	redirectUri: string,
	clientId: string,
): Promise<OAuthCredentials> {
	const response = await fetch(`${GITLAB_COM_URL}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}).toString(),
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`GitLab OAuth token exchange failed: ${response.status} ${body}`);
	}

	return mapTokenResponse(
		(await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			created_at?: number;
		},
	);
}

/** Log in to GitLab Duo using OAuth 2.0 authorization code flow with PKCE. */
export async function loginGitLabDuo(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const clientId = resolveClientId();
	const callbackHostname = resolveCallbackHostname();
	const callbackPort = resolveCallbackPort();
	const callbackPath = resolveCallbackPath();
	const redirectUri = `http://${callbackHostname}:${callbackPort}${callbackPath}`;

	const authParams = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: OAUTH_SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: crypto.randomUUID(),
	});

	const authUrl = `${GITLAB_COM_URL}/oauth/authorize?${authParams.toString()}`;

	callbacks.onAuth({
		url: authUrl,
		instructions:
			'Complete GitLab login in browser. If GitLab responds with "The redirect URI included is not valid", ' +
			"register your own GitLab OAuth application and set GITLAB_CLIENT_ID + GITLAB_REDIRECT_URI, or use a " +
			"Personal Access Token via GITLAB_TOKEN.",
	});

	const server = await startCallbackServer(verifier);
	callbacks.onProgress?.("Waiting for browser authentication...");

	try {
		const result = await server.waitForCode();
		if (!result) {
			throw new Error("Login cancelled");
		}
		callbacks.onProgress?.("Exchanging authorization code for token...");
		return exchangeToken(result.code, verifier, redirectUri, clientId);
	} finally {
		server.cancelWait();
		server.server.close();
	}
}

/** Refresh a GitLab Duo OAuth token. */
export async function refreshGitLabDuoToken(refreshToken: string): Promise<OAuthCredentials> {
	const clientId = resolveClientId();

	const response = await fetch(`${GITLAB_COM_URL}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}).toString(),
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`GitLab OAuth refresh failed: ${response.status} ${body}`);
	}

	return mapTokenResponse(
		(await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			created_at?: number;
		},
	);
}

export const gitlabDuoOAuthProvider: OAuthProviderInterface = {
	id: GITLAB_DUO_OAUTH_PROVIDER_ID,
	name: "GitLab Duo (Code Suggestions, Chat)",
	login: loginGitLabDuo,
	refreshToken: (credentials: OAuthCredentials) => refreshGitLabDuoToken(credentials.refresh),
	getApiKey: (credentials: OAuthCredentials) => credentials.access,
};
