import { describe, expect, it } from "bun:test";
import { buildModelPerformanceLookup } from "../src/client/data/view-models";
import type { ModelPerformancePoint } from "../src/shared-types";

const DAY = 24 * 60 * 60 * 1000;

describe("client view models", () => {
	it("keeps sparse all-time model performance buckets instead of dropping old points", () => {
		const points: ModelPerformancePoint[] = [
			{
				timestamp: DAY,
				model: "gpt-5.5",
				provider: "openai-codex",
				requests: 1,
				avgTtft: 250,
				avgTokensPerSecond: 40,
			},
			{
				timestamp: DAY * 10,
				model: "gpt-5.5",
				provider: "openai-codex",
				requests: 2,
				avgTtft: 500,
				avgTokensPerSecond: 60,
			},
		];

		const series = buildModelPerformanceLookup(points, "all").get("gpt-5.5::openai-codex");

		expect(series?.data.map(point => point.timestamp)).toEqual([DAY, DAY * 10]);
		expect(series?.data.map(point => point.requests)).toEqual([1, 2]);
		expect(series?.data.map(point => point.avgTtftSeconds)).toEqual([0.25, 0.5]);
	});
});
