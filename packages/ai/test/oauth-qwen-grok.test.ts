import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "../src/types.ts";
import { GROK_PROXY_PROVIDER_ID, grokProxyOAuthProvider, loginGrokProxy } from "../src/utils/oauth/grok-proxy.ts";
import { getOAuthProviders } from "../src/utils/oauth/index.ts";
import {
	loginQwen,
	normalizeQwenBaseUrl,
	QWEN_OAUTH_PROVIDER_ID,
	qwenOAuthProvider,
	refreshQwenToken,
} from "../src/utils/oauth/qwen.ts";
import type { OAuthCredentials } from "../src/utils/oauth/types.ts";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function urlOf(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function fakeModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	} satisfies Model<"openai-completions">;
}

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.OMK_GROK_PROXY_BASE_URL;
	delete process.env.OMK_GROK_PROXY_API_KEY;
});

describe("OAuth provider registry", () => {
	it("registers Qwen and Grok as built-in subscription providers", () => {
		const ids = getOAuthProviders().map((p) => p.id);
		expect(ids).toContain(QWEN_OAUTH_PROVIDER_ID);
		expect(ids).toContain(GROK_PROXY_PROVIDER_ID);

		const qwen = getOAuthProviders().find((p) => p.id === QWEN_OAUTH_PROVIDER_ID);
		const grok = getOAuthProviders().find((p) => p.id === GROK_PROXY_PROVIDER_ID);
		expect(qwen?.name).toBe("Qwen (Qwen Code Subscription)");
		expect(grok?.name).toBe("Grok (xAI OAuth Proxy)");
	});
});

describe("Qwen OAuth provider", () => {
	it("normalizes resource_url into a /v1 base URL", () => {
		expect(normalizeQwenBaseUrl("portal.qwen.ai")).toBe("https://portal.qwen.ai/v1");
		expect(normalizeQwenBaseUrl("https://portal.qwen.ai/")).toBe("https://portal.qwen.ai/v1");
		expect(normalizeQwenBaseUrl("https://portal.qwen.ai/v1")).toBe("https://portal.qwen.ai/v1");
		expect(normalizeQwenBaseUrl(undefined)).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
	});

	it("adds default Qwen models at resource_url without clobbering user models or duplicating ids", () => {
		const cred: OAuthCredentials = { access: "a", refresh: "r", expires: Date.now(), resource_url: "portal.qwen.ai" };
		// Pre-existing: an unrelated model, a user-custom qwen model, and one that collides with a default id.
		const existing = [
			fakeModel("openai", "gpt-x"),
			fakeModel(QWEN_OAUTH_PROVIDER_ID, "my-custom-qwen"),
			fakeModel(QWEN_OAUTH_PROVIDER_ID, "qwen3-coder-plus"),
		];
		const result = qwenOAuthProvider.modifyModels?.(existing, cred) ?? [];
		const qwenIds = result.filter((m) => m.provider === QWEN_OAUTH_PROVIDER_ID).map((m) => m.id);
		// User models preserved, defaults added, no duplicate ids.
		expect(qwenIds.sort()).toEqual(["my-custom-qwen", "qwen3-coder-flash", "qwen3-coder-plus"]);
		// Newly added default points at the resolved endpoint.
		expect(result.find((m) => m.id === "qwen3-coder-flash")?.baseUrl).toBe("https://portal.qwen.ai/v1");
		// Pre-existing models keep their own baseUrl (not overwritten).
		expect(result.find((m) => m.id === "qwen3-coder-plus")?.baseUrl).toBe("https://example.com/v1");
		expect(result.find((m) => m.id === "my-custom-qwen")?.baseUrl).toBe("https://example.com/v1");
		expect(result.find((m) => m.id === "gpt-x")).toBeDefined();
	});

	it("getApiKey returns the access token", () => {
		expect(qwenOAuthProvider.getApiKey({ access: "tok", refresh: "r", expires: 0 })).toBe("tok");
	});

	it("runs the device flow and returns credentials with resource_url", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = urlOf(input);
			if (url.includes("/device/code")) {
				return jsonResponse({ device_code: "dev", user_code: "WXYZ", interval: 0, expires_in: 600 });
			}
			if (url.includes("/oauth2/token")) {
				return jsonResponse({
					access_token: "acc",
					refresh_token: "ref",
					expires_in: 3600,
					resource_url: "portal.qwen.ai",
				});
			}
			throw new Error(`unexpected url ${url}`);
		});

		const onDeviceCode = vi.fn();
		const creds = await loginQwen({ onDeviceCode });
		expect(onDeviceCode).toHaveBeenCalledWith(
			expect.objectContaining({ userCode: "WXYZ", verificationUri: expect.stringContaining("qwen") }),
		);
		expect(creds.access).toBe("acc");
		expect(creds.refresh).toBe("ref");
		expect(creds.resource_url).toBe("portal.qwen.ai");
		expect(fetchMock).toHaveBeenCalled();
	});

	it("refreshes tokens against the token endpoint", async () => {
		let sentBody = "";
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			expect(urlOf(input)).toBe("https://chat.qwen.ai/api/v1/oauth2/token");
			sentBody = String(init?.body ?? "");
			return jsonResponse({ access_token: "acc2", expires_in: 3600 });
		});
		const creds = await refreshQwenToken("old-refresh");
		expect(creds.access).toBe("acc2");
		// No new refresh token returned -> keep the old one.
		expect(creds.refresh).toBe("old-refresh");
		expect(sentBody).toContain("grant_type=refresh_token");
		expect(sentBody).toContain("refresh_token=old-refresh");
	});
});

describe("Grok proxy OAuth provider", () => {
	it("adds default Grok models at the proxy base URL", () => {
		const cred: OAuthCredentials = { access: "x", refresh: "x", expires: Date.now() };
		const result = grokProxyOAuthProvider.modifyModels?.([fakeModel("openai", "gpt-x")], cred) ?? [];
		const grokModels = result.filter((m) => m.provider === GROK_PROXY_PROVIDER_ID);
		expect(grokModels.map((m) => m.id)).toEqual(["grok-4.5", "grok-4.3"]);
		expect(grokModels.every((m) => m.baseUrl === "http://127.0.0.1:9996/v1")).toBe(true);
		expect(result.find((m) => m.id === "gpt-x")).toBeDefined();
	});

	it("preserves user-configured Grok models and does not duplicate default ids", () => {
		const cred: OAuthCredentials = { access: "x", refresh: "x", expires: Date.now() };
		const existing = [fakeModel(GROK_PROXY_PROVIDER_ID, "grok-4.5"), fakeModel(GROK_PROXY_PROVIDER_ID, "my-grok")];
		const result = grokProxyOAuthProvider.modifyModels?.(existing, cred) ?? [];
		const grokIds = result.filter((m) => m.provider === GROK_PROXY_PROVIDER_ID).map((m) => m.id);
		expect(grokIds.sort()).toEqual(["grok-4.3", "grok-4.5", "my-grok"]);
		// Pre-existing grok-4.5 keeps its own baseUrl (default not re-added on top).
		expect(result.find((m) => m.id === "grok-4.5")?.baseUrl).toBe("https://example.com/v1");
	});

	it("honors OMK_GROK_PROXY_BASE_URL and OMK_GROK_PROXY_API_KEY", () => {
		process.env.OMK_GROK_PROXY_BASE_URL = "http://127.0.0.1:8080/v1";
		process.env.OMK_GROK_PROXY_API_KEY = "local-key";
		const cred: OAuthCredentials = { access: "x", refresh: "x", expires: Date.now() };
		const result = grokProxyOAuthProvider.modifyModels?.([], cred) ?? [];
		expect(result.every((m) => m.baseUrl === "http://127.0.0.1:8080/v1")).toBe(true);
		expect(grokProxyOAuthProvider.getApiKey({ access: "x", refresh: "x", expires: 0 })).toBe("local-key");
	});

	it("getApiKey defaults to dummy", () => {
		expect(grokProxyOAuthProvider.getApiKey({ access: "x", refresh: "x", expires: 0 })).toBe("dummy");
	});

	it("login succeeds when the proxy health endpoint is reachable", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			expect(urlOf(input)).toBe("http://127.0.0.1:9996/health");
			return new Response("ok", { status: 200 });
		});
		const onProgress = vi.fn();
		const creds = await loginGrokProxy({ onProgress });
		expect(creds.access).toBe(GROK_PROXY_PROVIDER_ID);
		expect(creds.expires).toBeGreaterThan(Date.now());
		expect(onProgress).toHaveBeenCalled();
	});

	it("login fails with a start hint when the proxy is unreachable", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
		await expect(loginGrokProxy({})).rejects.toThrow(/systemctl --user start grok-oauth-proxy/);
	});
});
