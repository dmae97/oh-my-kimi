import { afterEach, describe, expect, it, vi } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { MCPOAuthFlow, refreshMCPOAuthToken } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";

afterEach(() => {
	vi.restoreAllMocks();
});

function mockProviderTokenEndpoint(onBody: (body: string) => void): FetchImpl {
	return async (input, init) => {
		const url = String(input);
		if (url === "https://provider.example/token") {
			onBody(String(init?.body ?? ""));
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		throw new Error(`Unexpected fetch: ${url}`);
	};
}

function mockFigmaRegistration(onRegistration: (payload: Record<string, unknown>) => void): FetchImpl {
	return async (input, init) => {
		const url = String(input);
		if (url === "https://www.figma.com/.well-known/oauth-authorization-server") {
			return new Response(JSON.stringify({ registration_endpoint: "https://www.figma.com/oauth/register" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (url === "https://www.figma.com/oauth/register") {
			onRegistration(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return new Response(
				JSON.stringify({ client_id: "registered-client-id", client_secret: "registered-client-secret" }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response("not found", { status: 404 });
	};
}

describe("mcp oauth flow", () => {
	it("uses Codex client name for dynamic client registration", async () => {
		let registrationPayload: Record<string, unknown> | null = null;

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://www.figma.com/oauth/mcp",
				tokenUrl: "https://api.figma.com/v1/oauth/token",
				fetch: mockFigmaRegistration(payload => {
					registrationPayload = payload;
				}),
			},
			{},
		);

		const { url } = await flow.generateAuthUrl("test-state", "http://127.0.0.1:53172/callback");
		const authUrl = new URL(url);

		expect(registrationPayload).not.toBeNull();
		expect((registrationPayload as { client_name?: string } | null)?.client_name).toBe("Codex");
		expect(authUrl.searchParams.get("client_id")).toBe("registered-client-id");
		expect(authUrl.searchParams.get("state")).toBe("test-state");
	});

	it("uses configured callbackPath for the local redirect URI", async () => {
		let observedRedirectUri = "";
		let tokenRequestBody = "";

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				callbackPort: 14567,
				callbackPath: "slack/oauth_redirect",
				fetch: mockProviderTokenEndpoint(body => {
					tokenRequestBody = body;
				}),
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					observedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void fetch(`${observedRedirectUri}?code=test-code&state=${state}`);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const redirectUrl = new URL(observedRedirectUri);
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(redirectUrl.pathname).toBe("/slack/oauth_redirect");
		expect(tokenParams.get("redirect_uri")).toBe(observedRedirectUri);
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
		});
	});
	it("sends MCP resource indicator in authorization and token requests", async () => {
		let authResource = "";
		let tokenRequestBody = "";

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				resource: "https://mcp.example.com/mcp",
				callbackPort: 14572,
				fetch: mockProviderTokenEndpoint(body => {
					tokenRequestBody = body;
				}),
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					authResource = authUrl.searchParams.get("resource") ?? "";
					const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void fetch(`${redirectUri}?code=test-code&state=${state}`);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(authResource).toBe("https://mcp.example.com/mcp");
		expect(tokenParams.get("resource")).toBe("https://mcp.example.com/mcp");
	});
	it("uses an authorization URL resource for the matching token request", async () => {
		let authResource = "";
		let tokenRequestBody = "";

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl:
					"https://provider.example/authorize?resource=https%3A%2F%2Fauth-url-resource.example%2Fmcp",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				resource: "https://config-resource.example/mcp",
				callbackPort: 14573,
				fetch: mockProviderTokenEndpoint(body => {
					tokenRequestBody = body;
				}),
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					authResource = authUrl.searchParams.get("resource") ?? "";
					const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void fetch(`${redirectUri}?code=test-code&state=${state}`);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(authResource).toBe("https://auth-url-resource.example/mcp");
		expect(tokenParams.get("resource")).toBe("https://auth-url-resource.example/mcp");
	});

	it("uses exact redirectUri and clientSecret for provider requests", async () => {
		let observedRedirectUri = "";
		let tokenRequestBody = "";

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				clientSecret: "client-secret",
				redirectUri: "https://public.example/slack/oauth_redirect",
				callbackPort: 14568,
				callbackPath: "slack/oauth_redirect",
				fetch: mockProviderTokenEndpoint(body => {
					tokenRequestBody = body;
				}),
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					observedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void fetch(`http://localhost:14568/slack/oauth_redirect?code=test-code&state=${state}`);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(observedRedirectUri).toBe("https://public.example/slack/oauth_redirect");
		expect(tokenParams.get("redirect_uri")).toBe("https://public.example/slack/oauth_redirect");
		expect(tokenParams.get("client_secret")).toBe("client-secret");
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
		});
	});

	it("preserves root redirectUri values without adding a trailing slash", async () => {
		let observedRedirectUri = "";
		let tokenRequestBody = "";

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				redirectUri: "https://public.example",
				callbackPort: 14571,
				fetch: mockProviderTokenEndpoint(body => {
					tokenRequestBody = body;
				}),
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					observedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void fetch(`http://localhost:14571/?code=test-code&state=${state}`);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(observedRedirectUri).toBe("https://public.example");
		expect(tokenParams.get("redirect_uri")).toBe("https://public.example");
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
		});
	});

	it("supports https loopback redirectUri values behind a separate local callback port", async () => {
		let observedRedirectUri = "";
		let tokenRequestBody = "";

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				redirectUri: "https://localhost:3443/slack/oauth_redirect",
				callbackPort: 14570,
				fetch: mockProviderTokenEndpoint(body => {
					tokenRequestBody = body;
				}),
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					observedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void fetch(`http://localhost:14570/slack/oauth_redirect?code=test-code&state=${state}`);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(observedRedirectUri).toBe("https://localhost:3443/slack/oauth_redirect");
		expect(tokenParams.get("redirect_uri")).toBe("https://localhost:3443/slack/oauth_redirect");
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
		});
	});

	it("rejects https loopback redirectUri values without a separate callback port", () => {
		expect(
			() =>
				new MCPOAuthFlow(
					{
						authorizationUrl: "https://provider.example/authorize",
						tokenUrl: "https://provider.example/token",
						redirectUri: "https://localhost:3000/slack/oauth_redirect",
					},
					{},
				),
		).toThrow("HTTPS loopback redirect URIs require oauth.callbackPort");
	});

	it("listens on the implied port for exact HTTP loopback redirectUri values", async () => {
		const serveSpy = vi.spyOn(Bun, "serve").mockImplementation(options => {
			expect(options.port).toBe(80);
			throw new Error("EADDRINUSE");
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				redirectUri: "http://localhost/callback",
			},
			{ signal: AbortSignal.timeout(1_000) },
		);

		await expect(flow.login()).rejects.toThrow(
			"OAuth callback port 80 unavailable; cannot fall back to a random port when oauth.redirectUri is set",
		);
		expect(serveSpy).toHaveBeenCalledTimes(1);
	});

	it("listens on the explicit port for exact HTTP loopback redirectUri values", async () => {
		const serveSpy = vi.spyOn(Bun, "serve").mockImplementation(options => {
			expect(options.port).toBe(3000);
			throw new Error("EADDRINUSE");
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				redirectUri: "http://localhost:3000/callback",
			},
			{ signal: AbortSignal.timeout(1_000) },
		);

		await expect(flow.login()).rejects.toThrow(
			"OAuth callback port 3000 unavailable; cannot fall back to a random port when oauth.redirectUri is set",
		);
		expect(serveSpy).toHaveBeenCalledTimes(1);
	});

	it("fails instead of falling back to a random port when redirectUri is exact", async () => {
		vi.spyOn(Bun, "serve").mockImplementation(() => {
			throw new Error("EADDRINUSE");
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				redirectUri: "https://public.example/slack/oauth_redirect",
				callbackPort: 14569,
				callbackPath: "/slack/oauth_redirect",
			},
			{ signal: AbortSignal.timeout(1_000) },
		);

		await expect(flow.login()).rejects.toThrow("cannot fall back to a random port when oauth.redirectUri is set");
	});

	it("exposes the dynamically registered client_id and client_secret after generateAuthUrl", async () => {
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://www.figma.com/oauth/mcp",
				tokenUrl: "https://api.figma.com/v1/oauth/token",
				fetch: mockFigmaRegistration(() => {}),
			},
			{},
		);

		expect(flow.resolvedClientId).toBeUndefined();
		expect(flow.registeredClientSecret).toBeUndefined();

		await flow.generateAuthUrl("test-state", "http://127.0.0.1:53173/callback");

		expect(flow.resolvedClientId).toBe("registered-client-id");
		expect(flow.registeredClientSecret).toBe("registered-client-secret");
	});

	it("returns the configured client_id from resolvedClientId without triggering registration", async () => {
		let registrationCalled = false;
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "configured-client-id",
				fetch: async input => {
					registrationCalled = true;
					throw new Error(`Unexpected fetch: ${String(input)}`);
				},
			},
			{},
		);

		expect(flow.resolvedClientId).toBe("configured-client-id");
		expect(flow.registeredClientSecret).toBeUndefined();

		await flow.generateAuthUrl("test-state", "http://127.0.0.1:53174/callback");

		expect(flow.resolvedClientId).toBe("configured-client-id");
		expect(flow.registeredClientSecret).toBeUndefined();
		expect(registrationCalled).toBe(false);
	});

	it("accepts pasted redirect URLs through manual input", async () => {
		let tokenRequestBody = "";
		let manualAuthUrl = "";

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				callbackPort: 14570,
				fetch: mockProviderTokenEndpoint(body => {
					tokenRequestBody = body;
				}),
			},
			{
				onAuth: info => {
					manualAuthUrl = info.url;
				},
				onManualCodeInput: async () => {
					const authUrl = new URL(manualAuthUrl);

					const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					return `${redirectUri}?code=manual-code&state=${encodeURIComponent(state)}`;
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(credentials.access).toBe("access-token");
		expect(tokenParams.get("code")).toBe("manual-code");
	});

	it("sends MCP resource indicator when refreshing tokens", async () => {
		let tokenRequestBody = "";

		const credentials = await refreshMCPOAuthToken(
			"https://provider.example/token",
			"refresh-token",
			"client-id",
			"client-secret",
			"https://mcp.example.com/mcp",
			{
				fetch: mockProviderTokenEndpoint(body => {
					tokenRequestBody = body;
				}),
			},
		);
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(credentials.access).toBe("access-token");
		expect(tokenParams.get("grant_type")).toBe("refresh_token");
		expect(tokenParams.get("resource")).toBe("https://mcp.example.com/mcp");
	});
	it("keeps the legacy refresh options position when no resource is provided", async () => {
		let tokenRequestBody = "";

		await refreshMCPOAuthToken("https://provider.example/token", "refresh-token", undefined, undefined, {
			fetch: mockProviderTokenEndpoint(body => {
				tokenRequestBody = body;
			}),
		});
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(tokenParams.get("grant_type")).toBe("refresh_token");
		expect(tokenParams.get("resource")).toBeNull();
	});
});
