import { afterEach, describe, expect, it, vi } from "bun:test";
import { isXAIAccessTokenExpiring, refreshXAIOAuthToken, validateXAIEndpoint, XAIOAuthFlow } from "../xai-oauth";

afterEach(() => {
	vi.restoreAllMocks();
});

function jwtWithExp(exp: number): string {
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
	return `${header}.${payload}.sig`;
}

describe("isXAIAccessTokenExpiring", () => {
	it("returns false for an empty string", () => {
		expect(isXAIAccessTokenExpiring("")).toBe(false);
	});

	it("returns false for a non-JWT", () => {
		expect(isXAIAccessTokenExpiring("not.a.jwt")).toBe(false);
	});

	it("returns true when exp is already in the past", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(isXAIAccessTokenExpiring(jwtWithExp(now - 60))).toBe(true);
	});

	it("returns false when exp is well in the future", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(isXAIAccessTokenExpiring(jwtWithExp(now + 3600))).toBe(false);
	});
});

describe("validateXAIEndpoint", () => {
	it("rejects non-HTTPS URLs", () => {
		expect(() => validateXAIEndpoint("http://x.ai/token", "token_endpoint")).toThrow(/Invalid xAI token_endpoint/);
	});

	it("rejects non-xAI hosts", () => {
		expect(() => validateXAIEndpoint("https://evil.com/token", "token_endpoint")).toThrow(
			/Invalid xAI token_endpoint/,
		);
	});

	it("accepts the x.ai apex and *.x.ai subdomains", () => {
		expect(validateXAIEndpoint("https://x.ai/token", "token_endpoint")).toBe("https://x.ai/token");
		expect(validateXAIEndpoint("https://auth.x.ai/oauth/token", "token_endpoint")).toBe(
			"https://auth.x.ai/oauth/token",
		);
	});
});

describe("refreshXAIOAuthToken", () => {
	it("rejects an empty refresh_token without making a network call", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("fetch should not be called when refresh_token is empty");
		});

		await expect(refreshXAIOAuthToken("", fetchMock as unknown as typeof fetch)).rejects.toThrow(
			/missing refresh_token/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("XAIOAuthFlow", () => {
	it("pins the redirect URI to xAI's allowlisted loopback port", () => {
		const flow = new XAIOAuthFlow({});

		expect(flow.redirectUri).toBe("http://127.0.0.1:56121/callback");
	});

	it("uses pasted-code login without starting a callback server", async () => {
		const serveSpy = vi.spyOn(Bun, "serve").mockImplementation(() => {
			throw new Error("callback server should not start");
		});
		let authUrl = "";
		let tokenRequestBody = "";
		const progress: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
			if (url.includes("/.well-known/openid-configuration")) {
				return new Response(
					JSON.stringify({
						authorization_endpoint: "https://auth.x.ai/oauth/authorize",
						token_endpoint: "https://auth.x.ai/oauth/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			tokenRequestBody = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const flow = new XAIOAuthFlow({
			fetch: fetchMock as unknown as typeof fetch,
			onAuth: info => {
				authUrl = info.url;
			},
			onManualCodeInput: async () => {
				const parsed = new URL(authUrl);
				const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
				const state = parsed.searchParams.get("state") ?? "";
				return `${redirectUri}?code=code-xyz&state=${encodeURIComponent(state)}`;
			},
			onProgress: message => progress.push(message),
		});

		const credentials = await flow.login();
		const authorizeUrl = new URL(authUrl);
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(serveSpy).not.toHaveBeenCalled();
		expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
		expect(progress).toContain("Waiting for pasted authorization code...");
		expect(tokenParams.get("code")).toBe("code-xyz");
		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
	});
});

describe("XAIOAuthFlow.exchangeToken", () => {
	it("rejects when the token-exchange response is missing access_token", async () => {
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/.well-known/openid-configuration")) {
				return new Response(
					JSON.stringify({
						authorization_endpoint: "https://auth.x.ai/oauth/authorize",
						token_endpoint: "https://auth.x.ai/oauth/token",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			// Token-exchange response deliberately omits `access_token` to exercise
			// the missing-token rejection path. The value of `refresh_token` here is
			// a literal test marker, not a real secret — the test verifies
			// exchangeToken throws before any token would be persisted.
			return new Response(JSON.stringify({ refresh_token: "stub-refresh-token-for-test-only" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const flow = new XAIOAuthFlow({ fetch: fetchMock as unknown as typeof fetch });
		await flow.generateAuthUrl("state-abc", "http://127.0.0.1:56121/callback");

		await expect(flow.exchangeToken("code-xyz", "state-abc", "http://127.0.0.1:56121/callback")).rejects.toThrow(
			/access_token/,
		);
	});
});
