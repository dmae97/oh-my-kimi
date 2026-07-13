import { describe, expect, it } from "bun:test";
import { armOf, experimentOf, summarizeArm } from "./experiments";
import type { RunRow, TrialRow } from "./store";

/**
 * Contracts under test:
 *  - job names group by their first `-` token; arm labels strip that prefix.
 *  - summarizeArm computes observed metrics from decided trials only and
 *    projects running arms linearly (ETA, pass%, total cost).
 */

function runRow(overrides: Partial<RunRow>): RunRow {
	return {
		jobName: "exp-arm",
		dataset: "d",
		agent: "omp",
		models: "anthropic/claude-opus-4-8",
		slide: null,
		role: "",
		note: "",
		status: "running",
		pid: null,
		exitCode: null,
		createdAt: Date.now(),
		finishedAt: null,
		nTotal: 0,
		done: 0,
		pass: 0,
		fail: 0,
		error: 0,
		running: 0,
		costUsd: 0,
		tokIn: 0,
		tokOut: 0,
		tokCache: 0,
		...overrides,
	};
}

function trialRow(overrides: Partial<TrialRow>): TrialRow {
	return {
		jobName: "exp-arm",
		name: "task__x",
		task: "task",
		status: "pass",
		reward: 1,
		costUsd: 1,
		durationMs: 60_000,
		detail: "",
		updatedAt: Date.now(),
		...overrides,
	};
}

describe("experiment grouping", () => {
	it("groups by prefix and strips it from arm labels", () => {
		expect(experimentOf("sb2-n4p-fix")).toBe("sb2");
		expect(armOf("sb2-n4p-fix")).toBe("n4p-fix");
		expect(experimentOf("standalone")).toBe("standalone");
		expect(armOf("standalone")).toBe("standalone");
	});
});

describe("summarizeArm", () => {
	it("projects running arms linearly and leaves finished arms unprojected", () => {
		const tenMinutesAgo = Date.now() - 10 * 60_000;
		const running = summarizeArm(
			runRow({
				jobName: "sb2-n8",
				status: "running",
				createdAt: tenMinutesAgo,
				nTotal: 20,
				done: 10,
				pass: 8,
				costUsd: 5,
			}),
			[
				trialRow({ status: "pass", durationMs: 120_000 }),
				trialRow({ name: "b__x", task: "b", status: "fail", reward: 0, durationMs: 240_000 }),
			],
		);
		expect(running.arm).toBe("n8");
		expect(running.projected).not.toBeNull();
		// 10 done in 10 min → 1/min → 10 remaining ≈ 10 min out.
		const etaMin = ((running.projected?.etaMs ?? 0) - Date.now()) / 60_000;
		expect(etaMin).toBeGreaterThan(8);
		expect(etaMin).toBeLessThan(12);
		expect(running.projected?.passPct).toBeCloseTo(80, 5);
		expect(running.projected?.costPerTask).toBeCloseTo(0.5, 5);
		expect(running.projected?.totalCostUsd).toBeCloseTo(10, 5);
		// observed metrics come from decided trials only
		expect(running.passPct).toBeCloseTo((100 * 8) / 2, 5); // decided=2 in fixture trials
		expect(running.meanTrialMs).toBeCloseTo(180_000, 5);

		const finished = summarizeArm(
			runRow({ jobName: "sb2-opus", status: "complete", nTotal: 20, done: 20, pass: 15, costUsd: 30 }),
			[trialRow({})],
		);
		expect(finished.projected).toBeNull();
		expect(finished.costPerTask).toBeCloseTo(1.5, 5);
	});

	it("describes the slide config in the arm line", () => {
		const arm = summarizeArm(
			runRow({
				jobName: "sb2-nact",
				slide: JSON.stringify({ model: "google/gemini-3.5-flash", onAction: true, plan: true }),
			}),
			[],
		);
		expect(arm.config).toBe("anthropic/claude-opus-4-8 → google/gemini-3.5-flash on first edit/write +plan");
	});
});
