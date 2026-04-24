import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthCredentialStore } from "../src/auth-storage";
import { buildAnthropicUrl, findAnthropicAuth } from "../src/utils/anthropic-auth";
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
		expect(authUrl.searchParams.get("scope")).toBe("org:create_api_key user:profile user:inference");
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
});

describe("anthropic auth resolution", () => {
	it("prefers explicit Foundry env key over stored OAuth and normalizes Foundry base URL", async () => {
		const tmpDir = path.join(os.tmpdir(), `pi-ai-auth-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		fs.mkdirSync(tmpDir, { recursive: true });
		const dbPath = path.join(tmpDir, "agent.db");
		const store = await AuthCredentialStore.open(dbPath);
		try {
			store.replaceAuthCredentialsForProvider("anthropic", [
				{ type: "oauth", access: "sk-ant-oat-db", refresh: "refresh", expires: Date.now() + 20 * 60 * 1000 },
			]);
			await withEnv(
				{
					CLAUDE_CODE_USE_FOUNDRY: "true",
					ANTHROPIC_FOUNDRY_API_KEY: "foundry-explicit-key",
					FOUNDRY_BASE_URL: "https://foundry.example.com/anthropic/",
					ANTHROPIC_API_KEY: undefined,
					ANTHROPIC_OAUTH_TOKEN: undefined,
				},
				async () => {
					const auth = await findAnthropicAuth(store);
					expect(auth).not.toBeNull();
					expect(auth?.apiKey).toBe("foundry-explicit-key");
					expect(auth?.isOAuth).toBe(false);
					expect(auth?.baseUrl).toBe("https://foundry.example.com/anthropic");
					expect(buildAnthropicUrl(auth!)).toBe("https://foundry.example.com/anthropic/v1/messages?beta=true");
				},
			);
		} finally {
			store.close();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("keeps non-Foundry OAuth precedence unchanged", async () => {
		const tmpDir = path.join(os.tmpdir(), `pi-ai-auth-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		fs.mkdirSync(tmpDir, { recursive: true });
		const dbPath = path.join(tmpDir, "agent.db");
		const store = await AuthCredentialStore.open(dbPath);
		try {
			store.replaceAuthCredentialsForProvider("anthropic", [
				{ type: "oauth", access: "sk-ant-oat-db", refresh: "refresh", expires: Date.now() + 20 * 60 * 1000 },
			]);
			await withEnv(
				{
					CLAUDE_CODE_USE_FOUNDRY: undefined,
					ANTHROPIC_FOUNDRY_API_KEY: "foundry-explicit-key",
					ANTHROPIC_API_KEY: "sk-ant-api-env",
					ANTHROPIC_OAUTH_TOKEN: undefined,
				},
				async () => {
					const auth = await findAnthropicAuth(store);
					expect(auth).not.toBeNull();
					expect(auth?.apiKey).toBe("sk-ant-oat-db");
					expect(auth?.isOAuth).toBe(true);
					expect(auth?.baseUrl).toBe("https://api.anthropic.com");
				},
			);
		} finally {
			store.close();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("prefers stored API key over generic env fallback", async () => {
		const tmpDir = path.join(os.tmpdir(), `pi-ai-auth-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		fs.mkdirSync(tmpDir, { recursive: true });
		const dbPath = path.join(tmpDir, "agent.db");
		const store = await AuthCredentialStore.open(dbPath);
		try {
			store.replaceAuthCredentialsForProvider("anthropic", [{ type: "api_key", key: "sk-ant-api-db" }]);
			await withEnv(
				{
					CLAUDE_CODE_USE_FOUNDRY: undefined,
					ANTHROPIC_FOUNDRY_API_KEY: undefined,
					ANTHROPIC_API_KEY: "sk-ant-api-env",
					ANTHROPIC_BASE_URL: "https://anthropic.example.com/",
					ANTHROPIC_OAUTH_TOKEN: undefined,
				},
				async () => {
					const auth = await findAnthropicAuth(store);
					expect(auth).not.toBeNull();
					expect(auth?.apiKey).toBe("sk-ant-api-db");
					expect(auth?.isOAuth).toBe(false);
					expect(auth?.baseUrl).toBe("https://anthropic.example.com");
				},
			);
		} finally {
			store.close();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
