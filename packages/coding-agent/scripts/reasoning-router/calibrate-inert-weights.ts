/**
 * Evidence-based safe bounds for the inert v4 extension weights.
 *
 * multiTurnPrior / pressureBucket / judgeVote are wired but 0 ("inert until
 * calibrated"). No real feedback ledger exists yet, so the defensible
 * calibration is adversarial: for each weight, find the largest bump that
 * cannot change ANY frozen gold-set outcome even when the opposing signal is
 * unanimous — history votes the runner-up, the judge votes the runner-up, or
 * context pressure pushes debug/review/plan against the expected class.
 *
 * Deterministic, fixture-only. Prints JSON bounds; a governance lane can then
 * pin weights at (bound - 1) with a documented derivation.
 */
import {
	classifyTaskV4,
	DEFAULT_WEIGHTS_V4,
	TASK_CLASSES_V4,
	type TaskClassV4,
} from "../../src/core/reasoning-router-v4.ts";
import { GOLD_SET } from "../../test/fixtures/reasoning-router-gold-set.ts";

const MAX_W = 16;

interface Bound {
	readonly weight: string;
	readonly maxSafe: number;
	readonly firstFlipAt: number | null;
	readonly firstFlipId: string | null;
	readonly firstFlipExpected: string | null;
	readonly recommended: number;
}

/** Baseline outcome per row, plus its runner-up class (the adversarial vote target). */
const baselineRows = GOLD_SET.map((entry) => {
	const verdict = classifyTaskV4({ prompt: entry.prompt });
	return { entry, predicted: verdict.taskClass, runnerUp: verdict.runnerUp };
});

function flipsAt(w: number, weightKey: "multiTurnPrior" | "judgeVote" | "pressureBucket"): { id: string; expected: string } | null {
	for (const { entry, predicted, runnerUp } of baselineRows) {
		if (runnerUp === null) continue;
		const weights = { ...DEFAULT_WEIGHTS_V4, [weightKey]: w };
		const verdict = classifyTaskV4(
			{
				prompt: entry.prompt,
				// Worst case: every extension signal votes AGAINST the expected class.
				history: weightKey === "multiTurnPrior" ? [runnerUp] : undefined,
				judgeVote: weightKey === "judgeVote" ? runnerUp : undefined,
				pressureBucket: weightKey === "pressureBucket" ? 3 : undefined,
			},
			weights,
		);
		if (verdict.taskClass !== predicted) {
			return { id: entry.id, expected: entry.expectedClass };
		}
	}
	return null;
}

function boundFor(weightKey: "multiTurnPrior" | "judgeVote" | "pressureBucket"): Bound {
	for (let w = 1; w <= MAX_W; w++) {
		const flip = flipsAt(w, weightKey);
		if (flip !== null) {
			return {
				weight: weightKey,
				maxSafe: w - 1,
				firstFlipAt: w,
				firstFlipId: flip.id,
				firstFlipExpected: flip.expected,
				recommended: Math.max(0, w - 2),
			};
		}
	}
	return { weight: weightKey, maxSafe: MAX_W, firstFlipAt: null, firstFlipId: null, firstFlipExpected: null, recommended: MAX_W - 1 };
}

const bounds = [boundFor("multiTurnPrior"), boundFor("judgeVote"), boundFor("pressureBucket")];
console.log(JSON.stringify({ baseline: "DEFAULT_WEIGHTS_V4 on frozen GOLD_SET, adversarial opposing signals", bounds }, null, 1));
