import { describe, expect, it, vi } from "vitest";
import {
	getConfiguredSubscriptionUsageProviders,
	getSubscriptionUsageRevision,
	getSubscriptionUsageSource,
	loadSubscriptionUsage,
	parseClaudeUsageSnapshot,
	parseCodexUsageSnapshot,
	parseKimiUsageSnapshot,
	parseZaiUsageSnapshot,
	recordClaudePassiveUsage,
	recordCodexPassiveUsage,
	supportsSubscriptionUsage,
} from "../src/core/provider-usage.ts";

function codexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toString("base64url");
	return `test.${payload}.signature`;
}

function session(
	provider: string,
	options: {
		oauthProviders?: readonly string[];
		configuredProviders?: readonly string[];
		apiKeys?: Readonly<Record<string, string>>;
	} = {},
) {
	const oauthProviders = new Set(options.oauthProviders ?? []);
	const configuredProviders = new Set(options.configuredProviders ?? []);
	return {
		state: { model: { provider, baseUrl: "https://example.test/v1" } },
		modelRegistry: {
			isUsingOAuthProvider: (candidate: string) => oauthProviders.has(candidate),
			getProviderAuthStatus: (candidate: string) =>
				configuredProviders.has(candidate)
					? { configured: true, source: "stored" as const }
					: { configured: false },
			getApiKeyForProvider: async (candidate: string) => options.apiKeys?.[candidate],
		},
	};
}

describe("subscription usage providers", () => {
	it("maps subscription and model provider aliases without matching look-alike providers", () => {
		expect(getSubscriptionUsageSource("openai-codex")?.label).toBe("CODEX");
		expect(getSubscriptionUsageSource("anthropic")?.label).toBe("CLAUDE");
		expect(getSubscriptionUsageSource("qwen-oauth")?.label).toBe("QWEN");
		expect(getSubscriptionUsageSource("modelstudio-maas")?.label).toBe("QWEN TOKEN PLAN");
		expect(getSubscriptionUsageSource("kimi-code")?.label).toBe("KIMI");
		expect(getSubscriptionUsageSource("kimi-coding")?.label).toBe("KIMI");
		expect(getSubscriptionUsageSource("zhipu-coding-plan")?.label).toBe("GLM");
		expect(getSubscriptionUsageSource("zai")?.label).toBe("GLM");
		expect(getSubscriptionUsageSource("zai-coding-cn")?.label).toBe("GLM");
		expect(getSubscriptionUsageSource("grok-oauth-proxy")?.label).toBe("GROK");
		expect(getSubscriptionUsageSource("xai")?.label).toBe("GROK");
		expect(getSubscriptionUsageSource("openai")).toBeUndefined();
		expect(getSubscriptionUsageSource("moonshotai")).toBeUndefined();
	});

	it("only enables subscription usage when the required credential source exists", () => {
		expect(supportsSubscriptionUsage(session("anthropic", { oauthProviders: ["anthropic"] }) as never)).toBe(true);
		expect(supportsSubscriptionUsage(session("anthropic", { configuredProviders: ["anthropic"] }) as never)).toBe(
			false,
		);
		expect(supportsSubscriptionUsage(session("kimi-coding", { oauthProviders: ["kimi-code"] }) as never)).toBe(true);
		expect(supportsSubscriptionUsage(session("kimi-coding", { configuredProviders: ["kimi-coding"] }) as never)).toBe(
			true,
		);
		expect(supportsSubscriptionUsage(session("zai", { configuredProviders: ["zai"] }) as never)).toBe(true);
		expect(
			supportsSubscriptionUsage(session("modelstudio-maas", { configuredProviders: ["modelstudio-maas"] }) as never),
		).toBe(true);
		expect(supportsSubscriptionUsage(session("openai", { configuredProviders: ["openai"] }) as never)).toBe(false);
	});

	it("lists every configured quota group with the active provider first", () => {
		const configured = session("anthropic", {
			oauthProviders: ["openai-codex", "anthropic", "grok-oauth-proxy"],
			configuredProviders: ["kimi-coding", "zai", "modelstudio-maas"],
		});
		expect(getConfiguredSubscriptionUsageProviders(configured as never)).toEqual([
			"anthropic",
			"openai-codex",
			"kimi-coding",
			"zai",
			"modelstudio-maas",
			"grok-oauth-proxy",
		]);
	});

	it("merges passive Codex response limits into missing polled windows", async () => {
		const token = codexToken("acct-passive-merge");
		recordCodexPassiveUsage(token, {
			limitId: "codex",
			primary: { usedPercent: 37, windowSeconds: 5 * 60 * 60, resetsAt: 1_900_000_000 },
		});
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						rate_limit: {
							primary_window: {
								used_percent: 50,
								limit_window_seconds: 7 * 24 * 60 * 60,
								reset_at: 1_900_500_000,
							},
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		const result = await loadSubscriptionUsage(
			session("openai-codex", {
				oauthProviders: ["openai-codex"],
				apiKeys: { "openai-codex": token },
			}) as never,
			fetchMock,
		);

		expect(result).toEqual({
			label: "CODEX",
			windows: [
				{ label: "5H", usedPercent: 37, resetsAt: 1_900_000_000 },
				{ label: "7D", usedPercent: 50, resetsAt: 1_900_500_000 },
			],
		});
	});

	it("uses reset_after_seconds when Codex omits reset_at and does not invent a missing 5H window", () => {
		const now = 1_800_000_000;
		expect(
			parseCodexUsageSnapshot(
				{
					rate_limit: {
						primary_window: {
							used_percent: 50,
							limit_window_seconds: 7 * 24 * 60 * 60,
							reset_after_seconds: 90,
						},
					},
				},
				now,
			),
		).toEqual({ sevenDay: { usedPercent: 50, resetsAt: now + 90 } });
	});

	it("parses Claude legacy and generic 5H/7D windows", () => {
		expect(
			parseClaudeUsageSnapshot({
				five_hour: { utilization: 42, resets_at: "2026-08-01T01:00:00Z" },
				limits: [
					{ kind: "weekly_all", percent: 17, resets_at: "2026-08-07T00:00:00Z", is_active: true },
					{ kind: "weekly_scoped", percent: 99, is_active: false },
				],
			}),
		).toEqual([
			{ label: "5H", usedPercent: 42, resetsAt: Date.parse("2026-08-01T01:00:00Z") / 1000 },
			{ label: "7D", usedPercent: 17, resetsAt: Date.parse("2026-08-07T00:00:00Z") / 1000 },
		]);
	});

	it("parses Kimi totals and duration-labelled limits with detail reset fallback", () => {
		expect(
			parseKimiUsageSnapshot({
				usage: { limit: "100", used: "28", resetTime: "2026-08-07T00:00:00Z" },
				limits: [
					{
						window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
						detail: { limit: "100", remaining: "60", resetTime: "2026-08-01T02:00:00Z" },
					},
				],
			}),
		).toEqual([
			{ label: "TOTAL", usedPercent: 28, resetsAt: Date.parse("2026-08-07T00:00:00Z") / 1000 },
			{ label: "5H", usedPercent: 40, resetsAt: Date.parse("2026-08-01T02:00:00Z") / 1000 },
		]);
	});

	it("parses and sorts GLM request quota windows", () => {
		expect(
			parseZaiUsageSnapshot({
				success: true,
				data: {
					limits: [
						{ type: "TIME_LIMIT", percentage: 25, unit: 6, number: 1, nextResetTime: 1_800_000_000 },
						{ type: "TIME_LIMIT", currentValue: 30, usage: 100, unit: 3, number: 5 },
						{ type: "TOKENS_LIMIT", percentage: 90, unit: 4, number: 1 },
					],
				},
			}),
		).toEqual([
			{ label: "5H", usedPercent: 30 },
			{ label: "7D", usedPercent: 25, resetsAt: 1_800_000_000 },
		]);
	});

	it("rejects malformed usage payloads", () => {
		expect(
			parseCodexUsageSnapshot({ rate_limit: { primary_window: { used_percent: "not-a-number" } } }),
		).toBeUndefined();
		expect(parseClaudeUsageSnapshot({ limits: [{ kind: "session", percent: null }] })).toBeUndefined();
		expect(parseKimiUsageSnapshot({ limits: [{ detail: { limit: 0, used: 1 } }] })).toBeUndefined();
		expect(parseZaiUsageSnapshot({ success: false, data: { limits: [] } })).toBeUndefined();
	});

	it("uses passive Claude Code headers when the usage endpoint is rate limited", async () => {
		const token = "test-claude-passive-token";
		const nowMs = Date.now();
		const beforeRevision = getSubscriptionUsageRevision("anthropic");
		recordClaudePassiveUsage(
			token,
			{
				limitId: "anthropic-unified",
				primary: {
					usedPercent: 37.5,
					windowSeconds: 5 * 60 * 60,
					resetsAt: Math.floor(nowMs / 1000) + 3_600,
				},
				secondary: {
					usedPercent: 62,
					windowSeconds: 7 * 24 * 60 * 60,
					resetsAt: Math.floor(nowMs / 1000) + 86_400,
				},
			},
			nowMs,
		);
		const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }));

		const result = await loadSubscriptionUsage(
			session("anthropic", { oauthProviders: ["anthropic"], apiKeys: { anthropic: token } }) as never,
			fetchMock,
		);

		expect(getSubscriptionUsageRevision("anthropic")).toBeGreaterThan(beforeRevision);
		expect(result).toEqual({
			label: "CLAUDE",
			windows: [
				{ label: "5H", usedPercent: 37.5, resetsAt: Math.floor(nowMs / 1000) + 3_600 },
				{ label: "7D", usedPercent: 62, resetsAt: Math.floor(nowMs / 1000) + 86_400 },
			],
		});

		const otherAccount = await loadSubscriptionUsage(
			session("anthropic", {
				oauthProviders: ["anthropic"],
				apiKeys: { anthropic: "test-other-claude-account" },
			}) as never,
			fetchMock,
		);
		expect(otherAccount).toEqual({ label: "CLAUDE", windows: [], message: "rate limited · retry later" });
	});

	it("mirrors Claude Code's one-token quota check when the usage endpoint is rate limited", async () => {
		const token = "test-claude-quota-probe-token";
		const nowSeconds = Math.floor(Date.now() / 1000);
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			if (url.endsWith("/api/oauth/usage")) return new Response(null, { status: 429 });
			return new Response(null, {
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-5h-utilization": "0.24",
					"anthropic-ratelimit-unified-5h-reset": String(nowSeconds + 3_600),
					"anthropic-ratelimit-unified-7d-utilization": "0.44",
					"anthropic-ratelimit-unified-7d-reset": String(nowSeconds + 86_400),
				},
			});
		});
		const testSession = session("anthropic", {
			oauthProviders: ["anthropic"],
			apiKeys: { anthropic: token },
		}) as never;

		const result = await loadSubscriptionUsage(testSession, fetchMock);

		expect(result).toEqual({
			label: "CLAUDE",
			windows: [
				{ label: "5H", usedPercent: 24, resetsAt: nowSeconds + 3_600 },
				{ label: "7D", usedPercent: 44, resetsAt: nowSeconds + 86_400 },
			],
		});
		expect(requests).toHaveLength(2);
		expect(requests[1]?.url).toBe("https://api.anthropic.com/v1/messages");
		expect(requests[1]?.init?.method).toBe("POST");
		expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe(`Bearer ${token}`);
		expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
			model: "claude-haiku-4-5",
			max_tokens: 1,
			messages: [{ role: "user", content: "quota" }],
		});

		await loadSubscriptionUsage(testSession, fetchMock);
		expect(requests).toHaveLength(3);
		expect(requests.filter(({ url }) => url.endsWith("/v1/messages"))).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain(token);
	});

	it("rejects malformed quota-check headers and cools down failed Claude probes", async () => {
		const token = "test-claude-malformed-probe-token";
		const requests: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			requests.push(url);
			if (url.endsWith("/api/oauth/usage")) return new Response(null, { status: 429 });
			return new Response(null, {
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-5h-utilization": "4.2",
					"anthropic-ratelimit-unified-5h-reset": String(Number.MAX_SAFE_INTEGER),
				},
			});
		});
		const testSession = session("anthropic", {
			oauthProviders: ["anthropic"],
			apiKeys: { anthropic: token },
		}) as never;

		const first = await loadSubscriptionUsage(testSession, fetchMock);
		const second = await loadSubscriptionUsage(testSession, fetchMock);

		expect(first).toEqual({ label: "CLAUDE", windows: [], message: "rate limited · retry later" });
		expect(second).toEqual(first);
		expect(requests.filter((url) => url.endsWith("/v1/messages"))).toHaveLength(1);
	});

	it("recognizes the Qwen Token Plan without sending its key to the console-only usage API", async () => {
		const fetchMock = vi.fn();
		const result = await loadSubscriptionUsage(
			session("modelstudio-maas", {
				configuredProviders: ["modelstudio-maas"],
				apiKeys: { "modelstudio-maas": "test-token-plan-key" },
			}) as never,
			fetchMock,
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result).toEqual({ label: "QWEN TOKEN PLAN", windows: [], message: "console-only quota" });
	});

	it("fetches Claude quota with the stored OAuth token without returning it", async () => {
		const token = "test-oauth-token";
		const requests: Array<{ url: string | URL | Request; init?: RequestInit }> = [];
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			requests.push({ url, init });
			return new Response(JSON.stringify({ five_hour: { utilization: 33 }, seven_day: { utilization: 11 } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const result = await loadSubscriptionUsage(
			session("anthropic", { oauthProviders: ["anthropic"], apiKeys: { anthropic: token } }) as never,
			fetchMock,
		);

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(requests[0]?.url).toBe("https://api.anthropic.com/api/oauth/usage");
		expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(`Bearer ${token}`);
		expect(result).toEqual({
			label: "CLAUDE",
			windows: [
				{ label: "5H", usedPercent: 33 },
				{ label: "7D", usedPercent: 11 },
			],
		});
		expect(JSON.stringify(result)).not.toContain(token);
	});

	it("uses a configured Kimi Coding key for the fixed official quota endpoint", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ usage: { limit: 100, used: 24 } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const result = await loadSubscriptionUsage(
			session("kimi-coding", {
				configuredProviders: ["kimi-coding"],
				apiKeys: { "kimi-coding": "test-kimi-key" },
			}) as never,
			fetchMock,
		);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(result).toEqual({ label: "KIMI", windows: [{ label: "TOTAL", usedPercent: 24 }] });
	});

	it("keeps Kimi OAuth quota requests on the fixed official origin and sanitizes labels", async () => {
		const originalBaseUrl = process.env.KIMI_CODE_BASE_URL;
		process.env.KIMI_CODE_BASE_URL = "http://127.0.0.1:9999/steal";
		const requests: Array<{ url: string | URL | Request }> = [];
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			requests.push({ url });
			return new Response(
				JSON.stringify({ limits: [{ name: "\u001b[31mInjected", detail: { limit: 10, used: 2 } }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		try {
			const result = await loadSubscriptionUsage(
				session("kimi-coding", { oauthProviders: ["kimi-code"], apiKeys: { "kimi-code": "test-token" } }) as never,
				fetchMock,
			);
			expect(requests[0]?.url).toBe("https://api.kimi.com/coding/v1/usages");
			expect(result?.windows[0]?.label).not.toContain("\u001b");
		} finally {
			if (originalBaseUrl === undefined) delete process.env.KIMI_CODE_BASE_URL;
			else process.env.KIMI_CODE_BASE_URL = originalBaseUrl;
		}
	});

	it("uses the China GLM quota origin for the Zhipu credential alias", async () => {
		const requests: Array<{ url: string | URL | Request; init?: RequestInit }> = [];
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			requests.push({ url, init });
			return new Response(
				JSON.stringify({
					success: true,
					data: { limits: [{ type: "TIME_LIMIT", percentage: 20, unit: 3, number: 5 }] },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		const result = await loadSubscriptionUsage(
			session("zai", {
				oauthProviders: ["zhipu-coding-plan"],
				apiKeys: { "zhipu-coding-plan": "test-zhipu-key" },
			}) as never,
			fetchMock,
		);

		expect(requests[0]?.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
		expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("test-zhipu-key");
		expect(result?.windows).toEqual([{ label: "5H", usedPercent: 20 }]);
	});

	it("rejects oversized quota responses before parsing", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ five_hour: { utilization: 1 } }), {
					status: 200,
					headers: { "content-length": String(1024 * 1024 + 1), "content-type": "application/json" },
				}),
		);
		const result = await loadSubscriptionUsage(
			session("anthropic", { oauthProviders: ["anthropic"], apiKeys: { anthropic: "test-token" } }) as never,
			fetchMock,
		);
		expect(result).toEqual({ label: "CLAUDE", windows: [], message: "usage unavailable" });
	});

	it("reports Qwen and Grok quota APIs as unavailable without probing the network", async () => {
		const fetchMock = vi.fn();
		const qwen = await loadSubscriptionUsage(
			session("qwen-oauth", { oauthProviders: ["qwen-oauth"] }) as never,
			fetchMock,
		);
		const grok = await loadSubscriptionUsage(
			session("grok-oauth-proxy", { oauthProviders: ["grok-oauth-proxy"] }) as never,
			fetchMock,
		);

		expect(qwen).toEqual({ label: "QWEN", windows: [], message: "quota API unavailable" });
		expect(grok).toEqual({ label: "GROK", windows: [], message: "quota API unavailable" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
