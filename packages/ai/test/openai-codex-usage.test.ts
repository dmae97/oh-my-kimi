/**
 * Codex usage parser regressions. The widget client (osx-widgets) keys spark
 * detection off `limit.id.includes("spark")`, so the parser MUST surface
 * `additional_rate_limits[].metered_feature == "codex_bengalfox"` (the upstream
 * codename for GPT-5.3-Codex-Spark) as separate `UsageLimit` entries with
 * `spark` in the id. If this contract breaks, both the TUI and the macOS
 * widget lose per-model visibility.
 */
import { describe, expect, it } from "bun:test";
import { openaiCodexUsageProvider } from "../src/usage/openai-codex";

const accessTokenFixture = (() => {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture" },
			"https://api.openai.com/profile": { email: "fixture@example.com" },
		}),
	).toString("base64url");
	return `${header}.${body}.sig`;
})();

function makePayload() {
	return {
		plan_type: "pro",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: { used_percent: 4, limit_window_seconds: 17940, reset_at: 2_000_000_000 },
			secondary_window: { used_percent: 1, limit_window_seconds: 604740, reset_at: 2_000_500_000 },
		},
		additional_rate_limits: [
			{
				limit_name: "GPT-5.3-Codex-Spark",
				metered_feature: "codex_bengalfox",
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: { used_percent: 17, limit_window_seconds: 18000, reset_at: 2_000_001_000 },
					secondary_window: { used_percent: 61, limit_window_seconds: 604800, reset_at: 2_000_600_000 },
				},
			},
		],
	};
}

function fakeFetch(payload: unknown): typeof fetch {
	const fn = async () =>
		new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
	return fn as unknown as typeof fetch;
}

describe("openai-codex usage parser", () => {
	it("emits primary + secondary limits from the main rate_limit block", async () => {
		const report = await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fakeFetch(makePayload()) },
		);
		expect(report).not.toBeNull();
		const main = report?.limits.filter(l => l.id === "openai-codex:primary" || l.id === "openai-codex:secondary");
		expect(main?.map(l => l.id)).toEqual(["openai-codex:primary", "openai-codex:secondary"]);
		expect(main?.[0].scope.tier).toBe("pro");
		expect(main?.[0].amount.usedFraction).toBeCloseTo(0.04, 5);
	});

	it("surfaces additional_rate_limits as spark UsageLimit entries the widget can detect", async () => {
		const report = await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fakeFetch(makePayload()) },
		);
		const spark = report?.limits.filter(l => l.id.includes("spark"));
		expect(spark?.map(l => l.id)).toEqual(["openai-codex:spark:primary", "openai-codex:spark:secondary"]);
		expect(spark?.[0].label).toBe("5 hours (Spark)");
		expect(spark?.[1].label).toBe("7 days (Spark)");
		expect(spark?.[0].scope.tier).toBe("spark");
		expect(spark?.[0].scope.modelId).toBe("GPT-5.3-Codex-Spark");
		expect(spark?.[0].amount.usedFraction).toBeCloseTo(0.17, 5);
		expect(spark?.[1].amount.usedFraction).toBeCloseTo(0.61, 5);
	});

	it("treats bengalfox codename as spark even without explicit limit_name", async () => {
		const payload = makePayload();
		payload.additional_rate_limits[0].limit_name = undefined as unknown as string;
		const report = await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fakeFetch(payload) },
		);
		const spark = report?.limits.find(l => l.id === "openai-codex:spark:primary");
		expect(spark).toBeTruthy();
		expect(spark?.scope.tier).toBe("spark");
	});

	it("returns a report even when only additional_rate_limits are present (no main rate_limit)", async () => {
		const payload = {
			plan_type: "pro",
			rate_limit: null,
			additional_rate_limits: [
				{
					limit_name: "GPT-5.3-Codex-Spark",
					metered_feature: "codex_bengalfox",
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: 2_000_000_000 },
					},
				},
			],
		};
		const report = await openaiCodexUsageProvider.fetchUsage(
			{
				provider: "openai-codex",
				credential: { type: "oauth", accessToken: accessTokenFixture, accountId: "acct-1", email: "u@example.com" },
			},
			{ fetch: fakeFetch(payload) },
		);
		expect(report).not.toBeNull();
		expect(report?.limits.map(l => l.id)).toEqual(["openai-codex:spark:primary"]);
	});
});
