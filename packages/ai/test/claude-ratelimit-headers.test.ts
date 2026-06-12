import { describe, expect, it } from "bun:test";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { parseClaudeRateLimitHeaders } from "@oh-my-pi/pi-ai/usage/claude";

const NOW = 1_780_400_000_000;

function requireReport(report: UsageReport | null): UsageReport {
	if (!report) throw new Error("expected Claude rate-limit headers to parse");
	return report;
}

function requireLimit(report: UsageReport, id: string): UsageLimit {
	const limit = report.limits.find(candidate => candidate.id === id);
	if (!limit) throw new Error(`expected ${id} limit`);
	return limit;
}

describe("Claude rate-limit response headers", () => {
	it("parses unified 5h and 7d header windows with percent scaling and epoch-ms resets", () => {
		const report = requireReport(
			parseClaudeRateLimitHeaders(
				{
					"anthropic-ratelimit-unified-5h-utilization": "0.0",
					"anthropic-ratelimit-unified-5h-reset": "1780405800",
					"anthropic-ratelimit-unified-5h-status": "allowed",
					"anthropic-ratelimit-unified-7d-utilization": "0.1",
					"anthropic-ratelimit-unified-7d-reset": "1780531200",
					"anthropic-ratelimit-unified-7d-status": "allowed",
				},
				NOW,
			),
		);

		expect(report.provider).toBe("anthropic");
		expect(report.fetchedAt).toBe(NOW);
		expect(report.metadata?.source).toBe("ratelimit-headers");
		expect(report.limits).toHaveLength(2);

		const fiveHour = requireLimit(report, "anthropic:5h");
		expect(fiveHour.label).toBe("Claude 5 Hour");
		expect(fiveHour.scope.provider).toBe("anthropic");
		expect(fiveHour.scope.windowId).toBe("5h");
		expect(fiveHour.scope.shared).toBe(true);
		expect(fiveHour.window?.label).toBe("5 Hour");
		expect(fiveHour.window?.durationMs).toBe(5 * 60 * 60 * 1000);
		expect(fiveHour.amount.used).toBe(0);
		expect(fiveHour.amount.usedFraction).toBe(0);

		const sevenDay = requireLimit(report, "anthropic:7d");
		expect(sevenDay.label).toBe("Claude 7 Day");
		expect(sevenDay.scope.provider).toBe("anthropic");
		expect(sevenDay.scope.windowId).toBe("7d");
		expect(sevenDay.scope.shared).toBe(true);
		expect(sevenDay.scope.tier).toBeUndefined();
		expect(sevenDay.window?.label).toBe("7 Day");
		expect(sevenDay.window?.durationMs).toBe(7 * 24 * 60 * 60 * 1000);
		expect(sevenDay.window?.resetsAt).toBe(1780531200 * 1000);
		expect(sevenDay.amount.used).toBe(10);
		expect(sevenDay.amount.usedFraction).toBe(0.1);
	});

	it("parses a single available unified window", () => {
		const report = requireReport(
			parseClaudeRateLimitHeaders(
				{
					"anthropic-ratelimit-unified-5h-utilization": "0.25",
					"anthropic-ratelimit-unified-5h-reset": "1780405800",
				},
				NOW,
			),
		);

		expect(report.limits.map(limit => limit.id)).toEqual(["anthropic:5h"]);
		expect(report.limits[0]?.amount.used).toBe(25);
	});

	it("returns null when no unified utilization headers are present", () => {
		expect(parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-status": "allowed" }, NOW)).toBeNull();
	});

	it("omits a window that has reset metadata without utilization", () => {
		const report = requireReport(
			parseClaudeRateLimitHeaders(
				{
					"anthropic-ratelimit-unified-5h-reset": "1780405800",
					"anthropic-ratelimit-unified-7d-utilization": "0.4",
					"anthropic-ratelimit-unified-7d-reset": "1780531200",
				},
				NOW,
			),
		);

		expect(report.limits.map(limit => limit.id)).toEqual(["anthropic:7d"]);
		expect(report.limits[0]?.amount.used).toBe(40);
	});
});
