/**
 * Antigravity usage provider contract tests. The merge logic
 * deduplicates per-model quota entries by (tier, windowId),
 * preserves reset times when bar data and window data come from
 * different model entries, and handles mixed-case tier names.
 */
import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams, UsageLimit } from "@oh-my-pi/pi-ai/usage";
import { antigravityRankingStrategy, antigravityUsageProvider } from "@oh-my-pi/pi-ai/usage/google-antigravity";

const accessTokenFixture = (() => {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify({ sub: "user-fixture" })).toString("base64url");
	return `${header}.${body}.sig`;
})();

function makeCredential(overrides?: Partial<UsageFetchParams["credential"]>) {
	return {
		type: "oauth" as const,
		accessToken: accessTokenFixture,
		refreshToken: "refresh-fixture",
		expiresAt: Date.now() + 3600_000,
		projectId: "test-project",
		email: "test@example.com",
		accountId: "acct-1",
		...overrides,
	} satisfies UsageFetchParams["credential"];
}

function fakeFetch(json: unknown): FetchImpl {
	const fn = async () =>
		new Response(JSON.stringify(json), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	return fn;
}

function makeCtx(fetchImpl?: FetchImpl): UsageFetchContext {
	return { fetch: fetchImpl ?? fakeFetch({}) };
}

// ── helpers ──────────────────────────────────────────────────────────

function makeApiModel(
	displayName: string,
	quota: {
		remainingFraction?: number;
		resetTime?: string;
		tier?: string;
		windowId?: string;
		apiProvider?: string;
		modelProvider?: string;
	},
) {
	return {
		displayName,
		apiProvider: quota.apiProvider,
		modelProvider: quota.modelProvider,
		quotaInfo: {
			remainingFraction: quota.remainingFraction,
			resetTime: quota.resetTime,
			tier: quota.tier,
			windowId: quota.windowId,
		},
	};
}

// ── tests ────────────────────────────────────────────────────────────

describe("antigravity usage provider", () => {
	it("merges two models with same tier into one limit", async () => {
		const payload = {
			models: {
				modelA: makeApiModel("Model A", { remainingFraction: 0.3, tier: "premium" }),
				modelB: makeApiModel("Model B", { remainingFraction: 0.5, tier: "premium" }),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential(), signal: undefined },
			makeCtx(fakeFetch(payload)),
		);
		expect(report).not.toBeNull();
		expect(report!.limits.length).toBe(1);
	});

	it("keeps the worst remainingFraction when merging same tier", async () => {
		const payload = {
			models: {
				modelA: makeApiModel("Model A", { remainingFraction: 0.1, tier: "premium" }),
				modelB: makeApiModel("Model B", { remainingFraction: 0.8, tier: "premium" }),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential(), signal: undefined },
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(1);
		expect(report!.limits[0]!.amount.remainingFraction).toBe(0.1);
	});

	it("merges mixed-case tier names under lowercased key", async () => {
		const payload = {
			models: {
				modelA: makeApiModel("Model A", { remainingFraction: 0.3, tier: "Default" }),
				modelB: makeApiModel("Model B", { remainingFraction: 0.6, tier: "default" }),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential(), signal: undefined },
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(1);
	});

	it("treats reset-only quota entries as exhausted and preserves reset time", async () => {
		const now = Date.now();
		const resetTime = new Date(now + 4 * 3600_000).toISOString();
		const payload = {
			models: {
				modelA: makeApiModel("Model A", { remainingFraction: 0.3, tier: "default" }),
				modelB: makeApiModel("Model B", { remainingFraction: undefined, tier: "default", resetTime }),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential(), signal: undefined },
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(1);
		expect(report!.limits[0]!.amount.remainingFraction).toBe(0);
		expect(report!.limits[0]!.amount.usedFraction).toBe(1);
		expect(report!.limits[0]!.status).toBe("exhausted");
		expect(report!.limits[0]!.window).toBeDefined();
		expect(report!.limits[0]!.window!.resetsAt).toBeGreaterThan(now);
	});

	it("separates Google and Anthropic backend counters", async () => {
		const now = Date.now();
		const resetTime = new Date(now + 4 * 3600_000).toISOString();
		const payload = {
			models: {
				claude: makeApiModel("Claude", {
					remainingFraction: 1,
					modelProvider: "MODEL_PROVIDER_ANTHROPIC",
					apiProvider: "API_PROVIDER_ANTHROPIC_VERTEX",
				}),
				gemini: makeApiModel("Gemini", {
					remainingFraction: undefined,
					resetTime,
					modelProvider: "MODEL_PROVIDER_GOOGLE",
					apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential(), signal: undefined },
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(2);
		const googleLimit = report!.limits.find(limit => limit.label === "Usage (Google)");
		const anthropicLimit = report!.limits.find(limit => limit.label === "Usage (Anthropic)");
		expect(googleLimit?.amount.remainingFraction).toBe(0);
		expect(googleLimit?.status).toBe("exhausted");
		expect(anthropicLimit?.amount.remainingFraction).toBe(1);
		expect(anthropicLimit?.status).toBe("ok");
	});

	it("separates models with different windowIds in the same tier", async () => {
		const now = Date.now();
		const t1 = new Date(now + 5 * 3600_000).toISOString();
		const t2 = new Date(now + 24 * 3600_000).toISOString();
		const payload = {
			models: {
				modelA: makeApiModel("Model A", { remainingFraction: 0.3, tier: "premium", windowId: "5h", resetTime: t1 }),
				modelB: makeApiModel("Model B", {
					remainingFraction: 0.7,
					tier: "premium",
					windowId: "daily",
					resetTime: t2,
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential(), signal: undefined },
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(2);
	});

	it("includes email and projectId in report metadata", async () => {
		const payload = { models: { m: makeApiModel("M", { remainingFraction: 1 }) } };
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential({ email: "user@example.com", projectId: "proj-1" }),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.metadata?.email).toBe("user@example.com");
		expect(report!.metadata?.projectId).toBe("proj-1");
	});

	it("does not include email when credential has none", async () => {
		const payload = { models: { m: makeApiModel("M", { remainingFraction: 1 }) } };
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential({ email: undefined }), signal: undefined },
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.metadata?.email).toBeUndefined();
	});

	it("sorts limits by remainingFraction ascending (worst first)", async () => {
		const payload = {
			models: {
				modelA: makeApiModel("Model A", { remainingFraction: 0.9, tier: "high" }),
				modelB: makeApiModel("Model B", { remainingFraction: 0.2, tier: "low" }),
				modelC: makeApiModel("Model C", { remainingFraction: 0.5, tier: "mid" }),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential(), signal: undefined },
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(3);
		expect(report!.limits[0]!.amount.remainingFraction).toBe(0.2);
		expect(report!.limits[1]!.amount.remainingFraction).toBe(0.5);
		expect(report!.limits[2]!.amount.remainingFraction).toBe(0.9);
	});

	it("returns null when credential has no projectId", async () => {
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential({ projectId: undefined }), signal: undefined },
			makeCtx(),
		);
		expect(report).toBeNull();
	});
});

describe("antigravity ranking strategy", () => {
	function makeLimit(remainingFraction: number, label = "Usage"): UsageLimit {
		const usedFraction = 1 - remainingFraction;
		return {
			id: `google-antigravity:${label.toLowerCase()}`,
			label,
			scope: { provider: "google-antigravity" },
			amount: {
				unit: "percent",
				remainingFraction,
				usedFraction,
				remaining: remainingFraction * 100,
				used: usedFraction * 100,
				limit: 100,
			},
			status: remainingFraction <= 0 ? "exhausted" : remainingFraction <= 0.1 ? "warning" : "ok",
		};
	}

	it("maps the most-pressured counter to primary and leaves secondary unset", () => {
		// fetchAntigravityUsage sorts ascending by remainingFraction, so a real
		// report's limits[0] is always the bottleneck. AuthStorage compares the
		// secondary ranking metrics before primary; leaving secondary unset makes
		// every Antigravity candidate tie there, so the bottleneck counter in
		// primary decides — otherwise [5%, 90%] remaining can beat [40%, 40%]
		// because the runner-up counter looks healthier.
		const report = {
			provider: "google-antigravity" as const,
			fetchedAt: Date.now(),
			limits: [makeLimit(0.05, "Anthropic"), makeLimit(0.4, "Google"), makeLimit(0.9, "OpenAI")],
		};
		const { primary, secondary } = antigravityRankingStrategy.findWindowLimits(report);
		expect(primary?.label).toBe("Anthropic");
		expect(secondary).toBeUndefined();
	});

	it("returns undefined windows when the credential has no usage limits", () => {
		const report = {
			provider: "google-antigravity" as const,
			fetchedAt: Date.now(),
			limits: [],
		};
		const { primary, secondary } = antigravityRankingStrategy.findWindowLimits(report);
		expect(primary).toBeUndefined();
		expect(secondary).toBeUndefined();
	});

	it("uses a 24h window default for drain-rate normalisation", () => {
		// Antigravity's API exposes resetTime but not durationMs, so AuthStorage's
		// drain-rate calculator falls back to windowDefaults. The constant has to
		// match the daily quota Antigravity actually applies; if it drifts, two
		// credentials with identical headroom but different windowIds will be
		// ranked unfairly.
		expect(antigravityRankingStrategy.windowDefaults.primaryMs).toBe(24 * 60 * 60 * 1000);
		expect(antigravityRankingStrategy.windowDefaults.secondaryMs).toBe(24 * 60 * 60 * 1000);
	});
});
