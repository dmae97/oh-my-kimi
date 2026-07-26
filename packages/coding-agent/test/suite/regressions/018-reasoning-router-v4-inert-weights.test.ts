/**
 * Goal 016/L2 regression: calibrated inert-weight safety.
 *
 * Derivation: scripts/reasoning-router/calibrate-inert-weights.ts measures,
 * on the frozen gold set with unanimously OPPOSING extension signals (history
 * votes the runner-up, judge votes the runner-up, pressure bucket 3), the
 * first weight at which any outcome flips:
 *   multiTurnPrior: flips at 4 → calibrated to 2
 *   judgeVote:      flips at 4 → calibrated to 2
 *   pressureBucket: flips at 2 → calibrated to 1 (bucket is hard-clamped ≤ 3
 *                   in agent-session, so the max real bump is +3 < +6 flip
 *                   threshold)
 * The topScore>0 extension-vote gate (applyExtensionSignalsV4) keeps
 * zero-score fallback verdicts (trivial/ko-short/long-prose/lane) immune to
 * any vote, which is what makes these nonzero values safe at all.
 */
import { describe, expect, it } from "vitest";
import { classifyTaskV4, DEFAULT_WEIGHTS_V4, type TaskClassV4 } from "../../../src/core/reasoning-router-v4.ts";
import { GOLD_SET } from "../../fixtures/reasoning-router-gold-set.ts";

describe("reasoning-router v4 goal-016 inert-weight calibration", () => {
	it("pins the calibrated values in DEFAULT_WEIGHTS_V4", () => {
		expect(DEFAULT_WEIGHTS_V4.multiTurnPrior).toBe(2);
		expect(DEFAULT_WEIGHTS_V4.judgeVote).toBe(2);
		expect(DEFAULT_WEIGHTS_V4.pressureBucket).toBe(1);
	});

	it.each([
		["multiTurnPrior", (runnerUp: TaskClassV4) => ({ history: [runnerUp] })],
		["judgeVote", (runnerUp: TaskClassV4) => ({ judgeVote: runnerUp })],
		["pressureBucket", () => ({ pressureBucket: 3 })],
	] as const)("no gold outcome flips under %s opposing alone", (_name, input) => {
		for (const entry of GOLD_SET) {
			const base = classifyTaskV4({ prompt: entry.prompt });
			const runnerUp = base.runnerUp;
			if (runnerUp === null) continue;
			const adversarial = classifyTaskV4({ prompt: entry.prompt, ...input(runnerUp) });
			expect(adversarial.taskClass, `${entry.id} flipped`).toBe(base.taskClass);
		}
	});

	it("combined unanimous opposition flips only the two weakest-margin rows", () => {
		// history+2 AND judge+2 AND pressure+3 opposing at once: only the two
		// margin-4 rows (gold-0066/0067, 4 < 2+2+3) may flip. Every other row
		// survives even unanimous opposition.
		const flipped: string[] = [];
		for (const entry of GOLD_SET) {
			const base = classifyTaskV4({ prompt: entry.prompt });
			const runnerUp = base.runnerUp;
			if (runnerUp === null) continue;
			const adversarial = classifyTaskV4({
				prompt: entry.prompt,
				history: [runnerUp],
				judgeVote: runnerUp,
				pressureBucket: 3,
			});
			if (adversarial.taskClass !== base.taskClass) flipped.push(entry.id);
		}
		expect(flipped).toEqual(["gold-0066", "gold-0067"]);
	});

	it("a unanimous vote CAN still nudge when it agrees with the evidence", () => {
		// The gate must not make the weights decorative: with a real signal and
		// a supporting vote, the voted class keeps or raises its score.
		const prompt = "implement a rate limiter for the public API";
		const solo = classifyTaskV4({ prompt });
		const supported = classifyTaskV4({ prompt, history: ["code-gen"], judgeVote: "code-gen" });
		expect(solo.taskClass).toBe("code-gen");
		expect(supported.taskClass).toBe("code-gen");
		expect(supported.scores["code-gen"]).toBeGreaterThan(solo.scores["code-gen"]);
	});

	it("zero-score fallback verdicts are immune to opposing votes", () => {
		// gold-0001-style trivial row: "hi"-class prompts must stay trivial even
		// with a unanimous opposing vote (this is the gate's reason to exist).
		const verdict = classifyTaskV4({ prompt: "hi", history: ["code-gen"], judgeVote: "code-gen", pressureBucket: 3 });
		expect(verdict.taskClass).toBe("trivial");
	});

	it("pressure bucket alone cannot flip the weakest gold row", () => {
		const entry = GOLD_SET.find((e) => e.id === "gold-0066")!;
		const solo = classifyTaskV4({ prompt: entry.prompt });
		const pressured = classifyTaskV4({ prompt: entry.prompt, pressureBucket: 3 });
		expect(pressured.taskClass).toBe(solo.taskClass);
	});
});
