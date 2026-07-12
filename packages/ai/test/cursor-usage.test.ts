import { describe, expect, it } from "bun:test";
import type { UsageFetchContext, UsageFetchParams } from "../src/usage";
import { cursorUsageProvider, parseCursorUsage } from "../src/usage/cursor";

describe("cursor usage provider", () => {
	describe("parseCursorUsage", () => {
		it("returns null for non-record payloads", () => {
			expect(parseCursorUsage(null)).toBeNull();
			expect(parseCursorUsage(undefined)).toBeNull();
			expect(parseCursorUsage("invalid")).toBeNull();
			expect(parseCursorUsage([])).toBeNull();
		});

		it("returns null when no recognized quotas are present", () => {
			const payload = {
				someOtherField: "hello",
				startOfMonth: "2026-07-01T00:00:00.000Z",
			};
			expect(parseCursorUsage(payload)).toBeNull();
		});

		it("parses request-count buckets with stable IDs and labels", () => {
			const payload = {
				"gpt-4": {
					numRequests: 150,
					maxRequestUsage: 500,
				},
				"claude-3-5-sonnet": {
					used: 80,
					limit: 100,
				},
				startOfMonth: "2026-07-01T00:00:00.000Z",
			};

			const report = parseCursorUsage(payload);
			expect(report).not.toBeNull();
			if (!report) return;

			expect(report.provider).toBe("cursor");
			expect(report.limits).toHaveLength(2);

			const gpt4Limit = report.limits.find(l => l.id === "cursor:requests:gpt-4");
			expect(gpt4Limit).toBeDefined();
			if (gpt4Limit) {
				expect(gpt4Limit.label).toBe("gpt-4 requests");
				expect(gpt4Limit.amount.used).toBe(150);
				expect(gpt4Limit.amount.limit).toBe(500);
				expect(gpt4Limit.amount.remaining).toBe(350);
				expect(gpt4Limit.amount.usedFraction).toBe(0.3);
				expect(gpt4Limit.amount.unit).toBe("requests");
				expect(gpt4Limit.status).toBe("ok");
				expect(gpt4Limit.window).toBeDefined();
				expect(gpt4Limit.window?.id).toBe("monthly");
				expect(gpt4Limit.window?.label).toBe("Monthly");
				// 2026-07-01 + 1 month = 2026-08-01
				expect(gpt4Limit.window?.resetsAt).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
			}

			const sonnetLimit = report.limits.find(l => l.id === "cursor:requests:claude-3-5-sonnet");
			expect(sonnetLimit).toBeDefined();
			if (sonnetLimit) {
				expect(sonnetLimit.label).toBe("claude-3-5-sonnet requests");
				expect(sonnetLimit.amount.used).toBe(80);
				expect(sonnetLimit.amount.limit).toBe(100);
				expect(sonnetLimit.amount.usedFraction).toBe(0.8);
				expect(sonnetLimit.status).toBe("ok");
			}
		});

		it("parses USD/billing plan buckets with stable IDs and labels", () => {
			const payload = {
				planUsage: {
					used: 15.5,
					limit: 20.0,
				},
				"usd-custom": {
					amountUsed: 45,
					amountLimit: 50,
				},
			};

			const report = parseCursorUsage(payload);
			expect(report).not.toBeNull();
			if (!report) return;

			expect(report.limits).toHaveLength(2);

			const planLimit = report.limits.find(l => l.id === "cursor:usd:planusage");
			expect(planLimit).toBeDefined();
			if (planLimit) {
				expect(planLimit.label).toBe("planUsage spend");
				expect(planLimit.amount.used).toBe(15.5);
				expect(planLimit.amount.limit).toBe(20.0);
				expect(planLimit.amount.unit).toBe("usd");
				expect(planLimit.status).toBe("ok");
			}

			const customLimit = report.limits.find(l => l.id === "cursor:usd:usd-custom");
			expect(customLimit).toBeDefined();
			if (customLimit) {
				expect(customLimit.label).toBe("usd-custom spend");
				expect(customLimit.amount.used).toBe(45);
				expect(customLimit.amount.limit).toBe(50);
				expect(customLimit.amount.unit).toBe("usd");
				// 45 / 50 = 0.9 -> warning status
				expect(customLimit.status).toBe("warning");
			}
		});

		it("derives resetsAt from startOfMonth", () => {
			const payload = {
				"gpt-4": {
					numRequests: 10,
					maxRequestUsage: 10,
				},
				startOfMonth: "2026-07-11T12:00:00.000Z",
			};
			const report = parseCursorUsage(payload);
			expect(report).not.toBeNull();
			const limit = report?.limits[0];
			expect(limit?.window?.resetsAt).toBe(Date.parse("2026-08-11T12:00:00.000Z"));
		});

		it("derives resetsAt directly from billingCycleEnd", () => {
			const payload = {
				"gpt-4": {
					numRequests: 10,
					maxRequestUsage: 10,
				},
				billingCycleEnd: "2026-07-20T00:00:00.000Z",
			};
			const report = parseCursorUsage(payload);
			expect(report).not.toBeNull();
			const limit = report?.limits[0];
			expect(limit?.window?.resetsAt).toBe(Date.parse("2026-07-20T00:00:00.000Z"));
		});
	});

	describe("cursorUsageProvider", () => {
		it("supports oauth credentials", () => {
			const params: UsageFetchParams = {
				provider: "cursor",
				credential: {
					type: "oauth",
					accessToken: "valid-token",
				},
			};
			expect(cursorUsageProvider.supports?.(params)).toBe(true);
		});

		it("supports api_key credentials", () => {
			const params: UsageFetchParams = {
				provider: "cursor",
				credential: {
					type: "api_key",
					apiKey: "valid-api-key",
				},
			};
			expect(cursorUsageProvider.supports?.(params)).toBe(true);
		});

		it("does not support missing token/key", () => {
			const params1: UsageFetchParams = {
				provider: "cursor",
				credential: {
					type: "oauth",
				},
			};
			const params2: UsageFetchParams = {
				provider: "cursor",
				credential: {
					type: "api_key",
				},
			};
			expect(cursorUsageProvider.supports?.(params1)).toBe(false);
			expect(cursorUsageProvider.supports?.(params2)).toBe(false);
		});

		it("does not support other providers", () => {
			const params: UsageFetchParams = {
				provider: "openai-codex",
				credential: {
					type: "oauth",
					accessToken: "token",
				},
			};
			expect(cursorUsageProvider.supports?.(params)).toBe(false);
		});

		it("fetches and parses usage successfully", async () => {
			const payload = {
				"gpt-4": {
					numRequests: 10,
					maxRequestUsage: 100,
				},
				startOfMonth: "2026-07-01T00:00:00.000Z",
			};

			const mockFetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
				const urlStr = typeof input === "string" ? input : input.toString();
				expect(urlStr).toBe("https://api2.cursor.sh/auth/usage");
				expect(init?.headers).toBeDefined();
				const headers = init?.headers as Record<string, string>;
				expect(headers.Accept).toBe("application/json");
				expect(headers.Authorization).toBe("Bearer test-token");

				return new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}) as unknown as typeof fetch;

			const ctx: UsageFetchContext = {
				fetch: mockFetch,
			};

			const report = await cursorUsageProvider.fetchUsage(
				{
					provider: "cursor",
					credential: {
						type: "oauth",
						accessToken: "test-token",
						email: "user@example.com",
						accountId: "acc_123",
					},
				},
				ctx,
			);

			expect(report).not.toBeNull();
			if (!report) return;

			expect(report.provider).toBe("cursor");
			expect(report.limits).toHaveLength(1);
			expect(report.limits[0].id).toBe("cursor:requests:gpt-4");
			expect(report.metadata).toEqual({
				email: "user@example.com",
				accountId: "acc_123",
			});
		});

		it("returns null on non-2xx response", async () => {
			const mockFetch = (async () => new Response("Error", { status: 403 })) as unknown as typeof fetch;
			const ctx: UsageFetchContext = {
				fetch: mockFetch,
			};

			const report = await cursorUsageProvider.fetchUsage(
				{
					provider: "cursor",
					credential: {
						type: "oauth",
						accessToken: "test-token",
					},
				},
				ctx,
			);

			expect(report).toBeNull();
		});

		it("returns null on fetch error", async () => {
			const mockFetch = (async () => {
				throw new Error("Network error");
			}) as unknown as typeof fetch;
			const ctx: UsageFetchContext = {
				fetch: mockFetch,
			};

			const report = await cursorUsageProvider.fetchUsage(
				{
					provider: "cursor",
					credential: {
						type: "oauth",
						accessToken: "test-token",
					},
				},
				ctx,
			);

			expect(report).toBeNull();
		});
	});
});
