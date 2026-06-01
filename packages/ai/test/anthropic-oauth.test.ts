import { afterEach, describe, expect, it, vi } from "bun:test";
import { buildAnthropicAuthConfig, buildAnthropicUrl } from "../src/utils/anthropic-auth";
import { AnthropicOAuthFlow, refreshAnthropicToken } from "../src/utils/oauth/anthropic";
import { withEnv } from "./helpers";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("anthropic oauth alignment", () => {
	it("generates auth URL with expected scope set", async () => {
		const flow = new AnthropicOAuthFlow({});
		const state = "state-123";
		const redirectUri = "http://localhost:54545/callback";

		const { url } = await flow.generateAuthUrl(state, redirectUri);
		const authUrl = new URL(url);

		expect(authUrl.origin + authUrl.pathname).toBe("https://claude.ai/oauth/authorize");
		expect(authUrl.searchParams.get("scope")).toBe(
			"user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
		);
		expect(authUrl.searchParams.get("state")).toBe(state);
		expect(authUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
		expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
	});

	it("uses api.anthropic.com token URL for code exchange", async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			expect(typeof input === "string" ? input : input.toString()).toBe("https://api.anthropic.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const flow = new AnthropicOAuthFlow({});
		await flow.generateAuthUrl("state-123", "http://localhost:54545/callback");

		const result = await flow.exchangeToken("code-123", "state-123", "http://localhost:54545/callback");

		expect(result.access).toBe("access-token");
		expect(result.refresh).toBe("refresh-token");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("parses callback code fragments into token exchange code/state", async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			expect(typeof input === "string" ? input : input.toString()).toBe("https://api.anthropic.com/v1/oauth/token");
			const payload = JSON.parse(String(init?.body));
			expect(payload.code).toBe("code-123");
			expect(payload.state).toBe("state-override");
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const flow = new AnthropicOAuthFlow({});
		await flow.generateAuthUrl("state-123", "http://localhost:54545/callback");
		await flow.exchangeToken("code-123#state-override", "state-123", "http://localhost:54545/callback");

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps explicit state when callback code fragment state is empty", async () => {
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const payload = JSON.parse(String(init?.body));
			expect(payload.code).toBe("code-123");
			expect(payload.state).toBe("state-explicit");
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const flow = new AnthropicOAuthFlow({});
		await flow.generateAuthUrl("state-123", "http://localhost:54545/callback");
		await flow.exchangeToken("code-123#", "state-explicit", "http://localhost:54545/callback");

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("uses api.anthropic.com token URL for refresh", async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			expect(typeof input === "string" ? input : input.toString()).toBe("https://api.anthropic.com/v1/oauth/token");
			expect(init?.method).toBe("POST");
			return new Response(
				JSON.stringify({
					access_token: "new-access-token",
					refresh_token: "new-refresh-token",
					expires_in: 7200,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await refreshAnthropicToken("refresh-123");

		expect(result.access).toBe("new-access-token");
		expect(result.refresh).toBe("new-refresh-token");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("extracts account uuid and email from token-exchange response", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
					account: {
						uuid: "11111111-2222-3333-4444-555555555555",
						email_address: "user@example.com",
					},
					organization: { uuid: "99999999-8888-7777-6666-555555555555" },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const flow = new AnthropicOAuthFlow({});
		await flow.generateAuthUrl("state-123", "http://localhost:54545/callback");
		const result = await flow.exchangeToken("code-123", "state-123", "http://localhost:54545/callback");

		expect(result.accountId).toBe("11111111-2222-3333-4444-555555555555");
		expect(result.email).toBe("user@example.com");
	});

	it("extracts account uuid and email from refresh response", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					access_token: "new-access-token",
					refresh_token: "new-refresh-token",
					expires_in: 7200,
					account: {
						uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
						email_address: "refreshed@example.com",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await refreshAnthropicToken("refresh-123");

		expect(result.accountId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
		expect(result.email).toBe("refreshed@example.com");
	});

	it("leaves accountId/email undefined when token response omits account block", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const flow = new AnthropicOAuthFlow({});
		await flow.generateAuthUrl("state-noaccount", "http://localhost:54545/callback");
		const result = await flow.exchangeToken("code-noaccount", "state-noaccount", "http://localhost:54545/callback");

		expect(result.accountId).toBeUndefined();
		expect(result.email).toBeUndefined();
	});
});

describe("buildAnthropicAuthConfig", () => {
	it("classifies sk-ant-oat tokens as OAuth", () => {
		const config = buildAnthropicAuthConfig("sk-ant-oat-foobar");
		expect(config.isOAuth).toBe(true);
		expect(config.apiKey).toBe("sk-ant-oat-foobar");
	});

	it("treats sk-ant-api tokens as non-OAuth", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api-foobar");
		expect(config.isOAuth).toBe(false);
	});

	it("normalizes the explicit baseUrl override (trailing slash, env precedence)", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com/anthropic/",
				ANTHROPIC_BASE_URL: undefined,
			},
			async () => {
				const explicit = buildAnthropicAuthConfig("sk-ant-api-key", "https://override.example.com/");
				expect(explicit.baseUrl).toBe("https://override.example.com");
				expect(buildAnthropicUrl(explicit)).toBe("https://override.example.com/v1/messages?beta=true");
			},
		);
	});

	it("falls back to FOUNDRY_BASE_URL when Foundry mode is enabled and no explicit override is given", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "true",
				FOUNDRY_BASE_URL: "https://foundry.example.com/anthropic/",
				ANTHROPIC_BASE_URL: undefined,
			},
			async () => {
				const config = buildAnthropicAuthConfig("sk-ant-api-key");
				expect(config.baseUrl).toBe("https://foundry.example.com/anthropic");
			},
		);
	});

	it("falls back to ANTHROPIC_BASE_URL when Foundry mode is disabled", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				FOUNDRY_BASE_URL: undefined,
				ANTHROPIC_BASE_URL: "https://anthropic.example.com/",
			},
			async () => {
				const config = buildAnthropicAuthConfig("sk-ant-api-key");
				expect(config.baseUrl).toBe("https://anthropic.example.com");
			},
		);
	});

	it("uses the default Anthropic base URL when no env or override is set", async () => {
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				FOUNDRY_BASE_URL: undefined,
				ANTHROPIC_BASE_URL: undefined,
			},
			async () => {
				const config = buildAnthropicAuthConfig("sk-ant-api-key");
				expect(config.baseUrl).toBe("https://api.anthropic.com");
			},
		);
	});
});
