/**
 * Devin OAuth flow (Cognition AI's software engineer).
 *
 * Uses PKCE + local callback server for authentication.
 * After login, provides access to Devin's API for autonomous software engineering.
 */
import type { Server } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

const DEVIN_WEBAPP_URL = "https://app.devin.ai";
const DEVIN_API_URL = "https://api.devin.ai";
const CALLBACK_PORT = 59653;
const CALLBACK_PATH = "/callback";
const TOKEN_PATH = "/auth/cli/token";
const FALLBACK_EXPIRES_MS = 365 * 24 * 60 * 60 * 1000;

export const DEVIN_OAUTH_PROVIDER_ID = "devin";

type NodeApis = {
	createServer: typeof import("node:http").createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("Devin OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

function getTokenExpiry(token: string): number {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return Date.now() + FALLBACK_EXPIRES_MS;
		const payload = parts[1];
		if (!payload) return Date.now() + FALLBACK_EXPIRES_MS;
		const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
		if (decoded && typeof decoded === "object" && typeof decoded.exp === "number") {
			return decoded.exp * 1000 - 5 * 60 * 1000;
		}
	} catch {
		// Ignore parsing errors
	}
	return Date.now() + FALLBACK_EXPIRES_MS;
}

async function exchangeDevinCliToken(authorizationCode: string, codeVerifier: string): Promise<string> {
	const response = await fetch(`${DEVIN_API_URL}${TOKEN_PATH}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			code: authorizationCode,
			code_verifier: codeVerifier,
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Devin token exchange failed: ${response.status} ${errorText}`);
	}

	const data = (await response.json()) as { token?: string };
	if (!data.token) {
		throw new Error("Devin token exchange response missing token");
	}
	return data.token;
}

function startCallbackServer(): Promise<{
	server: Server;
	redirectUri: string;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
	cancelWait: () => void;
}> {
	const hostname = "127.0.0.1";
	const redirectUri = `http://${hostname}:${CALLBACK_PORT}${CALLBACK_PATH}`;

	return getNodeApis().then(({ createServer }) => {
		return new Promise((resolveServer) => {
			let settled = false;

			const server = createServer((req, res) => {
				if (!req.url?.startsWith(CALLBACK_PATH)) {
					res.writeHead(404).end();
					return;
				}
				const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error || !code) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml);
					return;
				}

				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthSuccessHtml);

				if (!settled) {
					settled = true;
					setImmediate(() => {
						resolveServer({
							server,
							redirectUri,
							waitForCode: () => Promise.resolve({ code, state: state || "" }),
							cancelWait: () => {},
						});
					});
				}
			});

			server.listen(CALLBACK_PORT, hostname, () => {
				// Server ready
			});

			server.on("error", () => {
				if (!settled) {
					settled = true;
					server.close();
					server.listen(0, hostname, () => {
						const addr = server.address();
						const actualPort = typeof addr === "object" && addr ? addr.port : CALLBACK_PORT;
						resolveServer({
							server,
							redirectUri: `http://${hostname}:${actualPort}${CALLBACK_PATH}`,
							waitForCode: () => Promise.resolve(null),
							cancelWait: () => {},
						});
					});
				}
			});
		});
	});
}

/** Log in to Devin using PKCE + callback server. */
export async function loginDevin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	const server = await startCallbackServer();

	const params = new URLSearchParams({
		redirect_uri: server.redirectUri,
		state,
		prompt: "select_account",
		code_challenge: challenge,
		code_challenge_method: "S256",
	});

	const authUrl = `${DEVIN_WEBAPP_URL}/auth/cli/continue?${params.toString()}`;

	callbacks.onAuth({ url: authUrl, instructions: "Sign in to Devin in your browser." });
	callbacks.onProgress?.("Waiting for browser authentication...");

	let result: { code: string; state: string } | null;
	try {
		result = await server.waitForCode();
	} finally {
		server.cancelWait();
		server.server.close();
	}

	if (!result) {
		throw new Error("Login cancelled or timed out");
	}

	callbacks.onProgress?.("Exchanging authorization code for token...");
	const token = await exchangeDevinCliToken(result.code, verifier);

	return {
		access: token,
		refresh: token,
		expires: getTokenExpiry(token),
		apiEndpoint: DEVIN_API_URL,
		enterpriseUrl: DEVIN_WEBAPP_URL,
	};
}

export const devinOAuthProvider: OAuthProviderInterface = {
	id: DEVIN_OAUTH_PROVIDER_ID,
	name: "Devin (Cognition AI)",
	login: loginDevin,
	// Devin tokens are long-lived; no refresh endpoint
	refreshToken: (credentials: OAuthCredentials) => Promise.resolve(credentials),
	getApiKey: (credentials: OAuthCredentials) => credentials.access,
};
