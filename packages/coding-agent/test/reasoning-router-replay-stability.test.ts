import { describe, expect, it } from "vitest";
import {
	DEFAULT_REPLAY_MIN,
	type RouterReplayRow,
	summarizeReplayStability,
} from "../src/core/reasoning-router-replay-stability.ts";

function row(over: Partial<RouterReplayRow> = {}): RouterReplayRow {
	return {
		baselineReplays: [true, true],
		candidateReplays: [true, true],
		holdout: false,
		rowId: "gold-0001",
		...over,
	};
}

describe("summarizeReplayStability", () => {
	it("credits a row when every replay agrees on both sides", () => {
		// Given a row observed twice under each policy, agreeing each time
		const rows = [row({ baselineReplays: [false, false], candidateReplays: [true, true] })];

		// When the stability rule runs
		const report = summarizeReplayStability(rows);

		// Then the row carries its agreed outcome forward
		expect(report.stable).toEqual([
			{ baselineCorrect: false, candidateCorrect: true, holdout: false, rowId: "gold-0001" },
		]);
		expect(report.unstable).toBe(0);
	});

	it("withholds credit from a row whose candidate replays disagree", () => {
		// Given the candidate scored differently on two identical replays
		const rows = [row({ candidateReplays: [true, false] })];

		// When the stability rule runs
		const report = summarizeReplayStability(rows);

		// Then the row is excluded rather than counted as a win
		expect(report.stable).toEqual([]);
		expect(report.unstable).toBe(1);
	});

	it("withholds credit from a row whose baseline replays disagree", () => {
		const report = summarizeReplayStability([row({ baselineReplays: [false, true] })]);

		expect(report.stable).toEqual([]);
		expect(report.unstable).toBe(1);
	});

	it("withholds credit from a row observed fewer times than the rule requires", () => {
		// Given only one observation per side, instability is undetectable
		const rows = [row({ baselineReplays: [true], candidateReplays: [true] })];

		const report = summarizeReplayStability(rows);

		expect(report.stable).toEqual([]);
		expect(report.insufficientReplays).toBe(1);
		expect(report.unstable).toBe(0);
	});

	it("withholds credit when only one side was replayed enough", () => {
		const report = summarizeReplayStability([row({ candidateReplays: [true] })]);

		expect(report.stable).toEqual([]);
		expect(report.insufficientReplays).toBe(1);
	});

	it("preserves the holdout flag so the caller can split credit", () => {
		const report = summarizeReplayStability([row({ holdout: true, rowId: "gold-0200" })]);

		expect(report.stable[0]?.holdout).toBe(true);
		expect(report.stable[0]?.rowId).toBe("gold-0200");
	});

	it("partitions every evaluated row into exactly one bucket", () => {
		const rows = [
			row({ rowId: "a" }),
			row({ candidateReplays: [true, false], rowId: "b" }),
			row({ baselineReplays: [true], candidateReplays: [true], rowId: "c" }),
			row({ baselineReplays: [false, false], candidateReplays: [false, false], rowId: "d" }),
		];

		const report = summarizeReplayStability(rows);

		expect(report.evaluated).toBe(4);
		expect(report.stable.length + report.unstable + report.insufficientReplays).toBe(report.evaluated);
	});

	it("honors a stricter replay minimum than the default two-run rule", () => {
		// Given two replays but a policy demanding three
		const report = summarizeReplayStability([row()], 3);

		expect(report.stable).toEqual([]);
		expect(report.insufficientReplays).toBe(1);
		expect(report.minReplays).toBe(3);
	});

	it("defaults to the two-run rule", () => {
		expect(DEFAULT_REPLAY_MIN).toBe(2);
		expect(summarizeReplayStability([row()]).minReplays).toBe(2);
	});

	it("reports an empty corpus without inventing credit", () => {
		const report = summarizeReplayStability([]);

		expect(report.evaluated).toBe(0);
		expect(report.stable).toEqual([]);
	});

	it("treats a three-run majority as unstable rather than voting on it", () => {
		// Given 2-of-3 agreement, the rule refuses to break the tie by majority:
		// a flipped observation means the measurement is noisy, not that the
		// majority is the truth.
		const report = summarizeReplayStability([row({ candidateReplays: [true, true, false] })]);

		expect(report.stable).toEqual([]);
		expect(report.unstable).toBe(1);
	});
});
