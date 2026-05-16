import { afterEach, describe, expect, it, vi } from "bun:test";
import { setTimeout as setTimeoutCb } from "node:timers";
import type { UsageFetchContext } from "../src/usage";
import { claudeUsageProvider } from "../src/usage/claude";

const VALID_PAYLOAD = {
	five_hour: { utilization: 42, resets_at: new Date(Date.now() + 5 * 60_000).toISOString() },
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function makeContext(fetchImpl: typeof fetch): UsageFetchContext {
	return { fetch: fetchImpl };
}

function baseParams() {
	return {
		provider: "anthropic" as const,
		credential: {
			type: "oauth" as const,
			accessToken: "oat-test",
			accountId: "org_test",
			email: "user@example.com",
			expiresAt: Date.now() + 60_000,
		},
	};
}

describe("claudeUsageProvider retry contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("retries on 429 and succeeds on a later attempt", async () => {
		let attempt = 0;
		const fetchMock = (async () => {
			attempt += 1;
			if (attempt < 3) return jsonResponse(429, { error: "rate_limited" });
			return jsonResponse(200, VALID_PAYLOAD);
		}) as unknown as typeof fetch;

		const report = await claudeUsageProvider.fetchUsage(baseParams(), makeContext(fetchMock));
		expect(report).not.toBeNull();
		expect(attempt).toBe(3);
		expect(report?.limits[0]?.amount.used).toBe(42);
	});

	it("retries on 503 then succeeds", async () => {
		let attempt = 0;
		const fetchMock = (async () => {
			attempt += 1;
			if (attempt === 1) return jsonResponse(503, { error: "unavailable" });
			return jsonResponse(200, VALID_PAYLOAD);
		}) as unknown as typeof fetch;

		const report = await claudeUsageProvider.fetchUsage(baseParams(), makeContext(fetchMock));
		expect(report).not.toBeNull();
		expect(attempt).toBe(2);
	});

	it("does NOT retry on 401 — permanent for this credential", async () => {
		let attempt = 0;
		const fetchMock = (async () => {
			attempt += 1;
			return jsonResponse(401, { error: "unauthorized" });
		}) as unknown as typeof fetch;

		const report = await claudeUsageProvider.fetchUsage(baseParams(), makeContext(fetchMock));
		expect(report).toBeNull();
		expect(attempt).toBe(1);
	});

	it("does NOT retry on 404 — permanent for this credential", async () => {
		let attempt = 0;
		const fetchMock = (async () => {
			attempt += 1;
			return jsonResponse(404, { error: "not_found" });
		}) as unknown as typeof fetch;

		const report = await claudeUsageProvider.fetchUsage(baseParams(), makeContext(fetchMock));
		expect(report).toBeNull();
		expect(attempt).toBe(1);
	});

	it("returns null after MAX_RETRIES of consecutive 429s", async () => {
		let attempt = 0;
		const fetchMock = (async () => {
			attempt += 1;
			return jsonResponse(429, { error: "rate_limited" });
		}) as unknown as typeof fetch;

		// Provider's MAX_RETRIES is 3; provider sleeps BASE_RETRY_DELAY_MS * 2^attempt
		// between attempts — total worst-case ~1.5s, well within our test budget.
		const report = await claudeUsageProvider.fetchUsage(baseParams(), makeContext(fetchMock));
		expect(report).toBeNull();
		expect(attempt).toBe(3);
	});

	it("honours Retry-After when retrying a 429", async () => {
		let attempt = 0;
		const callTimes: number[] = [];
		const fetchMock = (async () => {
			attempt += 1;
			callTimes.push(Date.now());
			if (attempt === 1) {
				// Retry-After: 1 second. Provider must wait ~1s before re-attempting.
				return jsonResponse(429, { error: "rate_limited" }, { "retry-after": "1" });
			}
			return jsonResponse(200, VALID_PAYLOAD);
		}) as unknown as typeof fetch;

		const t0 = Date.now();
		const report = await claudeUsageProvider.fetchUsage(baseParams(), makeContext(fetchMock));
		const elapsed = Date.now() - t0;
		expect(report).not.toBeNull();
		expect(attempt).toBe(2);
		// Allow generous slop (Bun scheduling jitter) but ensure we actually waited
		// closer to the Retry-After than to the default 500ms backoff.
		expect(elapsed).toBeGreaterThanOrEqual(800);
		expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(800);
	});

	it("aborts the retry sleep when the signal fires mid-backoff", async () => {
		let attempt = 0;
		const fetchMock = (async (_url: string | URL, init?: RequestInit) => {
			attempt += 1;
			if (init?.signal?.aborted) throw new Error("AbortError");
			if (attempt === 1) {
				// Pretend Anthropic wants us to back off for 60s. Without
				// `scheduler.wait({ signal })` the provider would stall through
				// the timeout; with it, the abort rejects the sleep promptly.
				return jsonResponse(429, { error: "rate_limited" }, { "retry-after": "60" });
			}
			return jsonResponse(200, VALID_PAYLOAD);
		}) as unknown as typeof fetch;

		const controller = new AbortController();
		setTimeoutCb(() => controller.abort(), 150);

		const t0 = Date.now();
		const report = await claudeUsageProvider.fetchUsage(
			{ ...baseParams(), signal: controller.signal },
			makeContext(fetchMock),
		);
		const elapsed = Date.now() - t0;
		expect(report).toBeNull();
		expect(elapsed).toBeLessThan(3_000);
		expect(attempt).toBe(1);
	});

	it("falls back to lastPayload when retries exhausted with stale-but-valid data", async () => {
		// Provider keeps lastPayload across attempts — if the upstream returns
		// a 200 with a recognized shape but no usage data, we keep iterating.
		// If we then 429 forever, we return what we have (null in this case).
		let attempt = 0;
		const fetchMock = (async () => {
			attempt += 1;
			if (attempt === 1) {
				// 200 OK but no usage payload — provider continues to next attempt
				// (waiting for fresh data) rather than returning immediately.
				return jsonResponse(200, {});
			}
			return jsonResponse(429, { error: "rate_limited" });
		}) as unknown as typeof fetch;

		const report = await claudeUsageProvider.fetchUsage(baseParams(), makeContext(fetchMock));
		// The 200 set lastPayload but had no usage data; 429s mean no further
		// successes. lastPayload survives but has no usage data → no limits.
		// Specifically: report is null (since lastPayload has nothing to expose).
		expect(report).toBeNull();
		expect(attempt).toBe(3);
	});
});
