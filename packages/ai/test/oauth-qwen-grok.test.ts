import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.ts";
import { streamSimpleOpenAICompletions } from "../src/providers/openai-completions.ts";
import type { Api, Model, ThinkingLevel } from "../src/types.ts";
import { getOAuthProviders } from "../src/utils/oauth/index.ts";
import {
	loginQwen,
	normalizeQwenBaseUrl,
	QWEN_OAUTH_PROVIDER_ID,
	qwenOAuthProvider,
	refreshQwenToken,
} from "../src/utils/oauth/qwen.ts";
import type { OAuthCredentials } from "../src/utils/oauth/types.ts";
import { XAI_OAUTH_PROVIDER_ID, xaiOAuthProvider } from "../src/utils/oauth/xai.ts";

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

function getGrokModel(id: "grok-4.6" | "grok-4.5" | "grok-4.3"): Model<"openai-completions"> {
	return getModel("xai", id);
}

async function captureGrokPayload(model: Model<"openai-completions">, reasoning?: ThinkingLevel): Promise<unknown> {
	let captured: unknown;
	const stream = streamSimpleOpenAICompletions(
		model,
		{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
		{
			apiKey: "dummy",
			maxTokens: 128,
			reasoning,
			onPayload(payload) {
				captured = payload;
				throw new Error("payload captured");
			},
		},
	);
	for await (const _event of stream) {
		// The capture hook aborts before network I/O; consume the terminal error event.
	}
	return captured;
}

function payloadField(payload: unknown, field: string): unknown {
	return typeof payload === "object" && payload !== null ? Reflect.get(payload, field) : undefined;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OAuth provider registry", () => {
	it("registers Qwen and native xAI as built-in subscription providers", () => {
		const ids = getOAuthProviders().map((p) => p.id);
		expect(ids).toContain(QWEN_OAUTH_PROVIDER_ID);
		expect(ids).toContain(XAI_OAUTH_PROVIDER_ID);
		expect(ids).not.toContain("grok-oauth-proxy");

		const qwen = getOAuthProviders().find((p) => p.id === QWEN_OAUTH_PROVIDER_ID);
		const grok = getOAuthProviders().find((p) => p.id === XAI_OAUTH_PROVIDER_ID);
		expect(qwen?.name).toBe("Qwen (Qwen Code Subscription)");
		expect(grok?.name).toBe("xAI Grok (SuperGrok or X Premium+)");
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

describe("native xAI Grok OAuth provider", () => {
	it("applies model-specific thinking levels on native xAI Grok models", () => {
		const grok46 = getGrokModel("grok-4.6");
		expect(grok46.provider).toBe(XAI_OAUTH_PROVIDER_ID);
		expect(grok46.baseUrl).toBe("https://api.x.ai/v1");
		expect(grok46.contextWindow).toBe(500_000);
		expect(grok46.compat).toMatchObject({ supportsReasoningEffort: true });
		expect(getSupportedThinkingLevels(grok46)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
		expect(getSupportedThinkingLevels(getGrokModel("grok-4.5"))).toEqual(["low", "medium", "high", "max", "ultra"]);
		expect(getSupportedThinkingLevels(getGrokModel("grok-4.3"))).toEqual([
			"off",
			"low",
			"medium",
			"high",
			"max",
			"ultra",
		]);
	});

	it.each([
		["grok-4.6", "max", "xhigh"],
		["grok-4.5", "max", "high"],
	] as const)("maps %s %s thinking to xAI reasoning_effort=%s", async (id, requested, expected) => {
		const payload = await captureGrokPayload(getGrokModel(id), requested);
		expect(payloadField(payload, "reasoning_effort")).toBe(expected);
		expect(payloadField(payload, "max_tokens")).toBeDefined();
		expect(payloadField(payload, "max_completion_tokens")).toBeUndefined();
	});

	it("keeps mandatory Grok 4.6 reasoning enabled when no level is selected", async () => {
		const payload = await captureGrokPayload(getGrokModel("grok-4.6"));
		expect(payloadField(payload, "reasoning_effort")).toBeUndefined();
	});

	it("sends none when Grok 4.3 thinking is off", async () => {
		const payload = await captureGrokPayload(getGrokModel("grok-4.3"));
		expect(payloadField(payload, "reasoning_effort")).toBe("none");
	});

	it("applies thinking maps to existing xAI models without adding or duplicating ids", () => {
		const cred: OAuthCredentials = { access: "x", refresh: "x", expires: Date.now() };
		const existing = [fakeModel(XAI_OAUTH_PROVIDER_ID, "grok-4.5"), fakeModel(XAI_OAUTH_PROVIDER_ID, "my-grok")];
		const result = xaiOAuthProvider.modifyModels?.(existing, cred) ?? [];
		const grokIds = result.filter((m) => m.provider === XAI_OAUTH_PROVIDER_ID).map((m) => m.id);
		expect(grokIds.sort()).toEqual(["grok-4.5", "my-grok"]);
		expect(result.find((m) => m.id === "grok-4.5")?.thinkingLevelMap?.high).toBe("high");
		expect(result.find((m) => m.id === "grok-4.5")?.baseUrl).toBe("https://api.x.ai/v1");
	});

	it("getApiKey returns the access token", () => {
		expect(xaiOAuthProvider.getApiKey({ access: "tok", refresh: "r", expires: 0 })).toBe("tok");
	});
});
