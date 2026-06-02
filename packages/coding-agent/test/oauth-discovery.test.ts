import { describe, expect, it } from "bun:test";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	extractMcpAuthServerUrl,
} from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import { hookFetch } from "@oh-my-pi/pi-utils";

describe("mcp oauth discovery", () => {
	it("extracts Mcp-Auth-Server from transport error headers", () => {
		const error = new Error(
			'HTTP 401: unauthorized [WWW-Authenticate: Bearer resource_metadata="https://mcp.figma.com/.well-known/oauth-protected-resource"; Mcp-Auth-Server: https://www.figma.com]',
		);

		expect(extractMcpAuthServerUrl(error)).toBe("https://www.figma.com/");
		const auth = analyzeAuthError(error);
		expect(auth.requiresAuth).toBe(true);
		expect(auth.authServerUrl).toBe("https://www.figma.com/");
	});

	it("discovers oauth endpoints from auth server metadata", async () => {
		const calls: string[] = [];
		using _hook = hookFetch(input => {
			const url = String(input);
			calls.push(url);

			if (url === "https://www.figma.com/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						authorization_endpoint: "https://www.figma.com/oauth",
						token_endpoint: "https://api.figma.com/v1/oauth/token",
						client_id: "figma-client-id",
						scopes_supported: ["file_read", "file_write"],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints("https://mcp.figma.com/mcp", "https://www.figma.com");

		expect(oauth).toEqual({
			authorizationUrl: "https://www.figma.com/oauth",
			tokenUrl: "https://api.figma.com/v1/oauth/token",
			clientId: "figma-client-id",
			scopes: "file_read file_write",
		});
		expect(calls[0]).toBe("https://www.figma.com/.well-known/oauth-authorization-server");
	});
});

describe("path-prefixed auth servers", () => {
	it("discovers endpoints via relative well-known path when server URL has a sub-path", async () => {
		const calls: string[] = [];
		using _hook = hookFetch(input => {
			const url = String(input);
			calls.push(url);

			// Absolute well-known fails (at origin root)
			if (url === "https://gateway.example.com/.well-known/oauth-authorization-server") {
				return new Response("not found", { status: 404 });
			}
			// Relative well-known succeeds (under /my-service/)
			if (url === "https://gateway.example.com/my-service/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						authorization_endpoint: "https://gateway.example.com/my-service/oauth/authorize",
						token_endpoint: "https://gateway.example.com/my-service/oauth/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints("https://gateway.example.com/my-service/mcp");

		expect(oauth).toEqual({
			authorizationUrl: "https://gateway.example.com/my-service/oauth/authorize",
			tokenUrl: "https://gateway.example.com/my-service/oauth/token",
		});
		// Absolute well-known was tried first (existing behavior)
		expect(calls[0]).toBe("https://gateway.example.com/.well-known/oauth-authorization-server");
		// Relative well-known was tried as fallback
		expect(calls).toContain("https://gateway.example.com/my-service/.well-known/oauth-authorization-server");
	});

	it("discovers endpoints via single-segment path prefix (no trailing endpoint segment)", async () => {
		const calls: string[] = [];
		using _hook = hookFetch(input => {
			const url = String(input);
			calls.push(url);

			if (url === "https://gateway.example.com/.well-known/oauth-authorization-server") {
				return new Response("not found", { status: 404 });
			}
			if (url === "https://gateway.example.com/my-service/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						authorization_endpoint: "https://gateway.example.com/my-service/oauth/authorize",
						token_endpoint: "https://gateway.example.com/my-service/oauth/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints("https://gateway.example.com/my-service");

		expect(oauth).toEqual({
			authorizationUrl: "https://gateway.example.com/my-service/oauth/authorize",
			tokenUrl: "https://gateway.example.com/my-service/oauth/token",
		});
		expect(calls[0]).toBe("https://gateway.example.com/.well-known/oauth-authorization-server");
		expect(calls).toContain("https://gateway.example.com/my-service/.well-known/oauth-authorization-server");
	});

	it("falls back to RFC 8414 path-ful issuer form (/.well-known/oauth-authorization-server/<path>)", async () => {
		const calls: string[] = [];
		using _hook = hookFetch(input => {
			const url = String(input);
			calls.push(url);

			if (url === "https://gateway.example.com/.well-known/oauth-authorization-server/my-service") {
				return new Response(
					JSON.stringify({
						authorization_endpoint: "https://gateway.example.com/my-service/oauth",
						token_endpoint: "https://gateway.example.com/my-service/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints("https://gateway.example.com/my-service");

		expect(oauth).toEqual({
			authorizationUrl: "https://gateway.example.com/my-service/oauth",
			tokenUrl: "https://gateway.example.com/my-service/token",
		});
		expect(calls).toContain("https://gateway.example.com/.well-known/oauth-authorization-server/my-service");
	});

	it("prefers absolute well-known when it succeeds (origin-root servers still work)", async () => {
		const calls: string[] = [];
		using _hook = hookFetch(input => {
			const url = String(input);
			calls.push(url);

			if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						authorization_endpoint: "https://auth.example.com/oauth",
						token_endpoint: "https://auth.example.com/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints("https://mcp.example.com", "https://auth.example.com");

		expect(oauth).toEqual({
			authorizationUrl: "https://auth.example.com/oauth",
			tokenUrl: "https://auth.example.com/token",
		});
		// Only the absolute path was needed
		expect(calls).toHaveLength(1);
		expect(calls[0]).toBe("https://auth.example.com/.well-known/oauth-authorization-server");
	});
});

describe("resource_metadata chain", () => {
	it("extracts resourceMetadataUrl from error message", () => {
		const error = new Error(
			'HTTP 401: WWW-Authenticate: Bearer resource_metadata="https://gateway.example.com/my-service/.well-known/oauth-protected-resource"',
		);

		const auth = analyzeAuthError(error);
		expect(auth.requiresAuth).toBe(true);
		expect(auth.resourceMetadataUrl).toBe(
			"https://gateway.example.com/my-service/.well-known/oauth-protected-resource",
		);
	});

	it("follows resource_metadata URL to discover authorization servers", async () => {
		const calls: string[] = [];
		using _hook = hookFetch(input => {
			const url = String(input);
			calls.push(url);

			// resource_metadata URL returns authorization_servers
			if (url === "https://gateway.example.com/my-service/.well-known/oauth-protected-resource") {
				return new Response(
					JSON.stringify({
						authorization_servers: ["https://gateway.example.com/my-service"],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			// Well-known at the discovered auth server (absolute fails, relative succeeds)
			if (url === "https://gateway.example.com/.well-known/oauth-authorization-server") {
				return new Response("not found", { status: 404 });
			}
			if (url === "https://gateway.example.com/my-service/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						authorization_endpoint: "https://gateway.example.com/my-service/oauth",
						token_endpoint: "https://gateway.example.com/my-service/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const oauth = await discoverOAuthEndpoints(
			"https://gateway.example.com/my-service/mcp",
			undefined,
			"https://gateway.example.com/my-service/.well-known/oauth-protected-resource",
		);

		expect(oauth).toEqual({
			authorizationUrl: "https://gateway.example.com/my-service/oauth",
			tokenUrl: "https://gateway.example.com/my-service/token",
		});
		// resource_metadata fetched first
		expect(calls[0]).toBe("https://gateway.example.com/my-service/.well-known/oauth-protected-resource");
	});
});

describe("relative Mcp-Auth-Server URL", () => {
	it("resolves relative Mcp-Auth-Server against server URL", () => {
		const error = new Error("HTTP 401: WWW-Authenticate: Bearer; Mcp-Auth-Server: /my-service/oauth");

		// Without serverUrl, relative URL returns undefined
		expect(extractMcpAuthServerUrl(error)).toBeUndefined();

		// With serverUrl, relative URL is resolved
		expect(extractMcpAuthServerUrl(error, "https://gateway.example.com/my-service/mcp")).toBe(
			"https://gateway.example.com/my-service/oauth",
		);
	});
});
