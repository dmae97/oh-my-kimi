import { describe, expect, it } from "bun:test";
import { claudeCodeVersion } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { UsageFetchContext, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { claudeRankingStrategy, claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";

function getHeaderCaseInsensitive(
	headers: Headers | Record<string, string | ReadonlyArray<string>> | string[][] | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	const target = name.toLowerCase();

	if (headers instanceof Headers) {
		for (const [key, value] of headers.entries()) {
			if (key.toLowerCase() === target) return value;
		}
		return undefined;
	}

	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key.toLowerCase() === target);
		return match?.[1];
	}

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === target) return String(value);
	}
	return undefined;
}

describe("claude usage request headers", () => {
	it("sends aligned anthropic fingerprint and bearer auth headers", async () => {
		const now = Date.now();
		const token = "oat-test-access-token";
		const calls: Array<{ input: string; init?: RequestInit }> = [];
		const fetchMock = (async (input: string | URL, init?: RequestInit) => {
			calls.push({ input: String(input), init });
			return new Response(
				JSON.stringify({
					five_hour: {
						utilization: 42,
						resets_at: new Date(now + 10 * 60 * 1000).toISOString(),
					},
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "application/json",
						"anthropic-organization-id": "org_test",
					},
				},
			);
		}) as unknown as typeof fetch;

		const ctx: UsageFetchContext = {
			fetch: fetchMock,
		};

		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: token,
					accountId: "org_test",
					email: "user@example.com",
					expiresAt: now + 60_000,
				},
			},
			ctx,
		);

		expect(report).not.toBeNull();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("https://api.anthropic.com/api/oauth/usage");

		const headers = calls[0]?.init?.headers;
		expect(getHeaderCaseInsensitive(headers, "authorization")).toBe(`Bearer ${token}`);
		expect(getHeaderCaseInsensitive(headers, "user-agent")).toBe(`claude-cli/${claudeCodeVersion} (external, cli)`);

		const beta = getHeaderCaseInsensitive(headers, "anthropic-beta");
		expect(beta).toBeDefined();
		const betaTokens = beta?.split(",").map(tokenValue => tokenValue.trim()) ?? [];
		expect(betaTokens).toContain("claude-code-20250219");
		expect(betaTokens).toContain("oauth-2025-04-20");
		expect(betaTokens).toContain("interleaved-thinking-2025-05-14");
		expect(betaTokens).toContain("redact-thinking-2026-02-12");
		expect(betaTokens).toContain("context-management-2025-06-27");
		expect(betaTokens).toContain("prompt-caching-scope-2026-01-05");
		expect(betaTokens).toContain("mid-conversation-system-2026-04-07");
		expect(betaTokens).toContain("advanced-tool-use-2025-11-20");
		expect(betaTokens).toContain("effort-2025-11-24");
		expect(betaTokens).toContain("extended-cache-ttl-2025-04-11");
	});

	it("does not invent reset timestamps when Claude omits them", async () => {
		const fetchMock = (async () => {
			return new Response(
				JSON.stringify({
					five_hour: { utilization: 42 },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "oat-test-access-token",
					expiresAt: Date.now() + 60_000,
				},
			},
			{ fetch: fetchMock },
		);

		expect(report?.limits[0]?.window?.resetsAt).toBeUndefined();
	});

	it("surfaces the Fable weekly scoped limit from the limits array as a tiered UsageLimit", async () => {
		const now = Date.now();
		const fiveHourReset = new Date(now + 5 * 60 * 60 * 1000).toISOString();
		const sevenDayReset = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();
		const fableReset = new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString();
		const fetchMock = (async () => {
			return new Response(
				JSON.stringify({
					five_hour: { utilization: 16, resets_at: fiveHourReset },
					seven_day: { utilization: 18, resets_at: sevenDayReset },
					seven_day_opus: null,
					seven_day_sonnet: null,
					limits: [
						{
							kind: "session",
							group: "session",
							percent: 16,
							severity: "normal",
							resets_at: fiveHourReset,
							scope: null,
							is_active: true,
						},
						{
							kind: "weekly_all",
							group: "weekly",
							percent: 18,
							severity: "normal",
							resets_at: sevenDayReset,
							scope: null,
							is_active: true,
						},
						{
							kind: "weekly_scoped",
							group: "weekly",
							percent: 28,
							severity: "normal",
							resets_at: fableReset,
							scope: { model: { display_name: "Fable", id: null }, surface: null },
							is_active: true,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const ctx: UsageFetchContext = { fetch: fetchMock };

		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "oat-test-access-token",
					expiresAt: now + 60_000,
				},
			},
			ctx,
		);

		expect(report?.limits.map(limit => limit.id)).toEqual(["anthropic:5h", "anthropic:7d", "anthropic:7d:fable"]);
		const fable = report?.limits.find(limit => limit.id === "anthropic:7d:fable");
		expect(fable?.label).toBe("Claude 7 Day (Fable)");
		expect(fable?.scope.provider).toBe("anthropic");
		expect(fable?.scope.tier).toBe("fable");
		expect(fable?.scope.windowId).toBe("7d");
		expect(fable?.scope.shared).toBeUndefined();
		expect(fable?.window?.durationMs).toBe(7 * 24 * 60 * 60 * 1000);
		expect(fable?.window?.label).toBe("7 Day");
		expect(fable?.window?.resetsAt).toBe(Date.parse(fableReset));
		expect(fable?.amount.used).toBe(28);
		expect(fable?.amount.limit).toBe(100);
		expect(fable?.amount.remaining).toBe(72);
		expect(fable?.amount.remainingFraction).toBeCloseTo(0.72);
		expect(fable?.amount.unit).toBe("percent");
		expect(fable?.amount.usedFraction).toBeCloseTo(0.28);
		expect(fable?.status).toBe("ok");
		const weekly = report?.limits.find(limit => limit.id === "anthropic:7d");
		expect(weekly?.amount.used).toBe(18);
		expect(weekly?.scope.shared).toBe(true);
	});

	it("skips inactive and unnamed scoped limits", async () => {
		const now = Date.now();
		const futureReset = new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString();
		const fetchMock = (async () => {
			return new Response(
				JSON.stringify({
					five_hour: { utilization: 16, resets_at: new Date(now + 5 * 60 * 60 * 1000).toISOString() },
					limits: [
						{
							kind: "weekly_scoped",
							group: "weekly",
							percent: 0,
							severity: "normal",
							resets_at: null,
							scope: { model: { display_name: "Fable", id: null }, surface: null },
							is_active: false,
						},
						{
							kind: "weekly_scoped",
							group: "weekly",
							percent: 40,
							resets_at: futureReset,
							scope: { model: null, surface: null },
							is_active: true,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const ctx: UsageFetchContext = { fetch: fetchMock };

		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "oat-test-access-token",
					expiresAt: now + 60_000,
				},
			},
			ctx,
		);

		expect(report?.limits.some(limit => limit.id.includes(":fable"))).toBe(false);
		expect(report?.limits.map(limit => limit.id)).toEqual(["anthropic:5h"]);
	});

	it("falls back to session and weekly_all entries when legacy buckets are absent", async () => {
		const now = Date.now();
		const fiveHourReset = new Date(now + 5 * 60 * 60 * 1000).toISOString();
		const sevenDayReset = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();
		const calls: string[] = [];
		const fetchMock = (async (input: string | URL) => {
			calls.push(String(input));
			return new Response(
				JSON.stringify({
					limits: [
						{
							kind: "session",
							group: "session",
							percent: 16,
							severity: "normal",
							resets_at: fiveHourReset,
							scope: null,
							is_active: true,
						},
						{
							kind: "weekly_all",
							group: "weekly",
							percent: 18,
							severity: "normal",
							resets_at: sevenDayReset,
							scope: null,
							is_active: true,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const ctx: UsageFetchContext = { fetch: fetchMock };

		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "oat-test-access-token",
					expiresAt: now + 60_000,
				},
			},
			ctx,
		);

		// Exactly one usage fetch: hasUsageData must accept a limits[]-only payload
		// instead of burning retries. The trailing /profile call is the expected
		// identity backfill for a payload/credential carrying no account identity.
		expect(calls.filter(url => url.endsWith("/usage"))).toEqual(["https://api.anthropic.com/api/oauth/usage"]);
		expect(report).not.toBeNull();
		expect(report?.limits.map(limit => limit.id)).toEqual(["anthropic:5h", "anthropic:7d"]);
		const session = report?.limits.find(limit => limit.id === "anthropic:5h");
		const weekly = report?.limits.find(limit => limit.id === "anthropic:7d");
		expect(session?.scope.shared).toBe(true);
		expect(weekly?.scope.shared).toBe(true);
		expect(session?.amount.used).toBe(16);
		expect(weekly?.amount.used).toBe(18);
	});
});

describe("claude ranking strategy", () => {
	function usageLimit(args: {
		id: string;
		windowId: "5h" | "7d";
		usedFraction: number;
		tier?: "fable";
		durationMs?: number;
		resetsAt?: number;
	}): UsageLimit {
		const used = args.usedFraction * 100;
		return {
			id: args.id,
			label:
				args.tier === "fable" ? "Claude 7 Day (Fable)" : `Claude ${args.windowId === "5h" ? "5 Hour" : "7 Day"}`,
			scope: {
				provider: "anthropic",
				windowId: args.windowId,
				...(args.tier ? { tier: args.tier } : { shared: true }),
			},
			window: {
				id: args.windowId,
				label: args.windowId === "5h" ? "5 Hour" : "7 Day",
				...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
				...(args.resetsAt !== undefined ? { resetsAt: args.resetsAt } : {}),
			},
			amount: {
				used,
				limit: 100,
				remaining: 100 - used,
				usedFraction: args.usedFraction,
				remainingFraction: 1 - args.usedFraction,
				unit: "percent",
			},
			status: "ok",
		};
	}

	function usageReportWithWeeklyCaps(args: { sharedWeeklyUsed: number; fableWeeklyUsed: number }): UsageReport {
		return {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				usageLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 0.2 }),
				usageLimit({ id: "anthropic:7d", windowId: "7d", usedFraction: args.sharedWeeklyUsed }),
				usageLimit({
					id: "anthropic:7d:fable",
					windowId: "7d",
					usedFraction: args.fableWeeklyUsed,
					tier: "fable",
				}),
			],
		};
	}

	it("scopes credential gating to shared umbrella limits plus the requested model tier", () => {
		const limits: UsageLimit[] = [
			{
				id: "anthropic:5h",
				label: "Claude 5 Hour",
				scope: { provider: "anthropic", windowId: "5h", shared: true },
				window: { id: "5h", label: "5 Hour" },
				amount: {
					used: 16,
					limit: 100,
					remaining: 84,
					usedFraction: 0.16,
					remainingFraction: 0.84,
					unit: "percent",
				},
				status: "ok",
			},
			{
				id: "anthropic:7d",
				label: "Claude 7 Day",
				scope: { provider: "anthropic", windowId: "7d", shared: true },
				window: { id: "7d", label: "7 Day" },
				amount: {
					used: 18,
					limit: 100,
					remaining: 82,
					usedFraction: 0.18,
					remainingFraction: 0.82,
					unit: "percent",
				},
				status: "ok",
			},
			{
				id: "anthropic:7d:fable",
				label: "Claude 7 Day (Fable)",
				scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
				window: { id: "7d", label: "7 Day" },
				amount: {
					used: 28,
					limit: 100,
					remaining: 72,
					usedFraction: 0.28,
					remainingFraction: 0.72,
					unit: "percent",
				},
				status: "ok",
			},
		];
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits,
		};

		expect(claudeRankingStrategy.scopeLimits).toBeDefined();
		const scopeLimits = claudeRankingStrategy.scopeLimits;
		if (!scopeLimits) throw new Error("expected claude scopeLimits");
		expect(scopeLimits(report).map(limit => limit.id)).toEqual(["anthropic:5h", "anthropic:7d"]);
		expect(scopeLimits(report, { modelId: "claude-opus-4-8" }).map(limit => limit.id)).toEqual([
			"anthropic:5h",
			"anthropic:7d",
		]);
		expect(scopeLimits(report, { modelId: "claude-fable-5" }).map(limit => limit.id)).toEqual([
			"anthropic:5h",
			"anthropic:7d",
		]);
		expect(claudeRankingStrategy.blockScope?.({ modelId: "claude-fable-5" })).toBe("tier:fable");
		expect(claudeRankingStrategy.blockScope?.({ modelId: "claude-mythos-5" })).toBe("tier:mythos");
		expect(claudeRankingStrategy.blockScope?.({ modelId: "claude-opus-4-8" })).toBeUndefined();
		expect(claudeRankingStrategy.blockScope?.({})).toBeUndefined();
	});

	it("uses the Fable weekly cap as secondary when it is more used than the shared weekly cap", () => {
		const report = usageReportWithWeeklyCaps({ sharedWeeklyUsed: 0.18, fableWeeklyUsed: 0.64 });

		const windows = claudeRankingStrategy.findWindowLimits(report, { modelId: "claude-fable-5" });

		expect(windows.secondary?.id).toBe("anthropic:7d:fable");
		expect(windows.secondary?.amount.usedFraction).toBe(0.64);
	});

	it("ranks the Fable weekly secondary by drain pressure instead of raw used fraction", () => {
		const now = Date.now();
		const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
		const hourMs = 60 * 60 * 1000;
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: now,
			limits: [
				usageLimit({ id: "anthropic:5h", windowId: "5h", usedFraction: 0.2 }),
				usageLimit({
					id: "anthropic:7d",
					windowId: "7d",
					usedFraction: 0.4,
					durationMs: sevenDaysMs,
					resetsAt: now + 160 * hourMs,
				}),
				usageLimit({
					id: "anthropic:7d:fable",
					windowId: "7d",
					usedFraction: 0.9,
					tier: "fable",
					durationMs: sevenDaysMs,
					resetsAt: now + hourMs,
				}),
			],
		};

		const windows = claudeRankingStrategy.findWindowLimits(report, { modelId: "claude-fable-5" });

		expect(windows.secondary?.id).toBe("anthropic:7d");
		expect(windows.secondary?.amount.usedFraction).toBe(0.4);
	});

	it("keeps Fable weekly caps out of Opus and unscoped secondary ranking", () => {
		const report = usageReportWithWeeklyCaps({ sharedWeeklyUsed: 0.18, fableWeeklyUsed: 0.64 });

		expect(claudeRankingStrategy.findWindowLimits(report, { modelId: "claude-opus-4-8" }).secondary?.id).toBe(
			"anthropic:7d",
		);
		expect(claudeRankingStrategy.findWindowLimits(report).secondary?.id).toBe("anthropic:7d");
	});

	it("keeps the shared weekly cap as secondary for Fable when it is the more used cap", () => {
		const report = usageReportWithWeeklyCaps({ sharedWeeklyUsed: 0.74, fableWeeklyUsed: 0.31 });

		expect(claudeRankingStrategy.findWindowLimits(report, { modelId: "claude-fable-5" }).secondary?.id).toBe(
			"anthropic:7d",
		);
	});
});
