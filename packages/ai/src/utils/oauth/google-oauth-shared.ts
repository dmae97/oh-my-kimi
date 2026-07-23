/**
 * Shared Google OAuth flow for Gemini CLI and Antigravity.
 *
 * Both use the same authorization-code flow with a local callback server;
 * only client credentials, scopes, and project-discovery logic differ.
 * Adapted from vendor/oh-my-pi for Node.js (no Bun dependencies).
 */
import type { Server } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types.ts";

export interface GoogleOAuthFlowConfig {
	clientId: string;
	clientSecret: string;
	authUrl: string;
	tokenUrl: string;
	scopes: string[];
	callbackPort: number;
	callbackPath: string;
	discoverProject: (accessToken: string, onProgress?: (message: string) => void) => Promise<string>;
}

type NodeApis = {
	createServer: typeof import("node:http").createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("Google OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

async function getUserEmail(accessToken: string): Promise<string | undefined> {
	try {
		const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (response.ok) {
			const data = (await response.json()) as { email?: string };
			return data.email;
		}
	} catch {
		// Ignore errors, email is optional
	}
	return undefined;
}

function startCallbackServer(
	port: number,
	callbackPath: string,
): Promise<{
	server: Server;
	redirectUri: string;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
	cancelWait: () => void;
}> {
	const hostname = "127.0.0.1";
	const redirectUri = `http://${hostname}:${port}${callbackPath}`;

	return getNodeApis().then(({ createServer }) => {
		return new Promise((resolveServer) => {
			let settled = false;

			const server = createServer((req, res) => {
				if (!req.url?.startsWith(callbackPath)) {
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

			server.listen(port, hostname, () => {
				// Server ready
			});

			server.on("error", () => {
				if (!settled) {
					settled = true;
					// Try random port fallback
					const fallback = createServer(server.listeners("request")[0] as any);
					fallback.listen(0, hostname, () => {
						const addr = fallback.address();
						const actualPort = typeof addr === "object" && addr ? addr.port : port;
						const fallbackUri = `http://${hostname}:${actualPort}${callbackPath}`;
						resolveServer({
							server: fallback,
							redirectUri: fallbackUri,
							waitForCode: () => Promise.resolve(null),
							cancelWait: () => {},
						});
					});
				}
			});
		});
	});
}

/** Run the full Google OAuth login flow. */
export async function runGoogleOAuthLogin(
	callbacks: OAuthLoginCallbacks,
	config: GoogleOAuthFlowConfig,
): Promise<OAuthCredentials> {
	const state = crypto.randomUUID();
	const server = await startCallbackServer(config.callbackPort, config.callbackPath);

	const authParams = new URLSearchParams({
		client_id: config.clientId,
		response_type: "code",
		redirect_uri: server.redirectUri,
		scope: config.scopes.join(" "),
		state,
		access_type: "offline",
		prompt: "consent",
	});

	const authUrl = `${config.authUrl}?${authParams.toString()}`;

	callbacks.onAuth({ url: authUrl, instructions: "Complete the sign-in in your browser." });
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

	callbacks.onProgress?.("Exchanging authorization code for tokens...");

	const tokenResponse = await fetch(config.tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: config.clientId,
			client_secret: config.clientSecret,
			code: result.code,
			grant_type: "authorization_code",
			redirect_uri: server.redirectUri,
		}),
	});

	if (!tokenResponse.ok) {
		const error = await tokenResponse.text();
		throw new Error(`Token exchange failed: ${error}`);
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	if (!tokenData.refresh_token) {
		throw new Error("No refresh token received. Please try again.");
	}

	callbacks.onProgress?.("Getting user info...");
	const email = await getUserEmail(tokenData.access_token);

	callbacks.onProgress?.("Discovering project...");
	const projectId = await config.discoverProject(tokenData.access_token, callbacks.onProgress);

	return {
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
		projectId,
		email,
	};
}

/** Refresh a Google OAuth token. */
export async function refreshGoogleToken(
	config: Pick<GoogleOAuthFlowConfig, "clientId" | "clientSecret" | "tokenUrl">,
	refreshToken: string,
	projectId: string,
): Promise<OAuthCredentials> {
	const response = await fetch(config.tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: config.clientId,
			client_secret: config.clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Google token refresh failed: ${error}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		expires_in: number;
		refresh_token?: string;
	};

	return {
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		projectId,
	};
}
