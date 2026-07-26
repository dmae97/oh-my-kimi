/**
 * Reasoning-router v4 calibration/robustness evaluator.
 * Measures whether classifier confidence actually carries information:
 * ECE (10-bin), confidence-band error rates, margin distribution,
 * and score-saturation stats. Read-only; prints JSON to stdout.
 */
import { classifyTaskV4 } from "../../src/core/reasoning-router-v4.ts";
import {
	computeGoldSetSplit,
	GOLD_SET,
	summarizeGoldSetSplit,
} from "../../test/fixtures/reasoning-router-gold-set.ts";
import {
	computeCalibrationMetrics,
} from "./calibration.ts";

const split = computeGoldSetSplit(GOLD_SET);
console.error("split:", JSON.stringify(summarizeGoldSetSplit(GOLD_SET, split)));

const samples = GOLD_SET.map((entry) => {
	const v = classifyTaskV4({ prompt: entry.prompt });
	return {
		id: entry.id,
		predicted: v.taskClass,
		expected: entry.expectedClass,
		confidence: v.confidence,
		confidenceBand: v.confidenceBand,
		margin: v.margin,
		winnerScore: v.scores[v.taskClass] ?? 0,
		holdout: entry.holdout === true,
	};
});

const wrong = samples.filter((s) => s.predicted !== s.expected);
console.error(`accuracy: ${samples.length - wrong.length}/${samples.length} (holdout wrong: ${wrong.filter((w) => w.holdout).map((w) => w.id)})`);

const metrics = computeCalibrationMetrics(samples, 10);
const bins = metrics.bins;
const ece = metrics.expectedCalibrationError;
const bandRates = metrics.bandErrorRates;

const margins = samples.map((s) => s.margin).sort((a, b) => a - b);
const confs = samples.map((s) => s.confidence).sort((a, b) => a - b);
const winnerScores = samples.map((s) => s.winnerScore).sort((a, b) => a - b);
const pct = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]?.toFixed(3);

console.log(JSON.stringify({
	accuracy: (samples.length - wrong.length) / samples.length,
	ece: Number(ece.toFixed(4)),
	bandRates: bandRates.map((b) => ({
		band: b.band,
		count: b.count,
		accuracy: Number(b.accuracy.toFixed(3)),
		errorRate: Number(b.errorRate.toFixed(3)),
		meanConfidence: Number(b.meanConfidence.toFixed(3)),
	})),
	margin: { p10: pct(margins, 0.1), p50: pct(margins, 0.5), p90: pct(margins, 0.9) },
	confidence: { p10: pct(confs, 0.1), p50: pct(confs, 0.5), p90: pct(confs, 0.9) },
	winnerScore: { p10: pct(winnerScores, 0.1), p50: pct(winnerScores, 0.5), p90: pct(winnerScores, 0.9) },
	bins: bins.filter((b) => b.count > 0).map((b) => ({
		lo: b.lowerBound, hi: b.upperBound, n: b.count,
		acc: Number(b.accuracy.toFixed(3)), conf: Number(b.meanConfidence.toFixed(3)),
	})),
}, null, 1));
