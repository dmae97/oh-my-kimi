/**
 * Reasoning-router weight promotion gate (CLI).
 *
 * Closes the router learning loop: the feedback ledger and calibration stack
 * already produce candidate weights, but nothing decided whether a candidate
 * was actually allowed to replace the active one. This script evaluates a
 * candidate against `DEFAULT_WEIGHTS_V4` on the gold set, splits held-in from
 * the frozen holdout, runs McNemar's exact test on the held-in discordant
 * pairs, and feeds the result to `evaluateRouterPromotion`.
 *
 * Read-only: it never writes weights. It prints a JSON verdict and exits
 * non-zero when promotion is refused, so CI can gate on it.
 *
 * Usage:
 *   node --experimental-strip-types promote-weights.ts <candidate-weights.json>
 *   node --experimental-strip-types promote-weights.ts <weights.json> --approved
 *   node --experimental-strip-types promote-weights.ts <weights.json> --golden-changes 2
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_ROUTER_PROMOTION_POLICY,
	evaluateRouterPromotion,
	type RouterPromotionEvidence,
} from "../../src/core/reasoning-router-promotion.ts";
import { classifyTaskV4 } from "../../src/core/reasoning-router-v4.ts";
import { DEFAULT_WEIGHTS_V4, type RouterWeightsV4 } from "../../src/core/reasoning-router-v4-weights.ts";
import { GOLD_SET } from "../../test/fixtures/reasoning-router-gold-set.ts";
import { runMcNemar } from "./mcnemar.ts";

interface PairOutcome {
	readonly holdout: boolean;
	readonly baselineCorrect: boolean;
	readonly candidateCorrect: boolean;
}

/** Classify every gold row under both weight sets, preserving the split flag. */
export function scoreGoldSet(candidate: RouterWeightsV4): readonly PairOutcome[] {
	return GOLD_SET.map((entry) => ({
		baselineCorrect: classifyTaskV4({ prompt: entry.prompt }, DEFAULT_WEIGHTS_V4).taskClass === entry.expectedClass,
		candidateCorrect: classifyTaskV4({ prompt: entry.prompt }, candidate).taskClass === entry.expectedClass,
		holdout: entry.holdout === true,
	}));
}

/** Assemble gate evidence from paired outcomes. */
export function buildEvidence(
	outcomes: readonly PairOutcome[],
	options: { readonly goldenChanges: number; readonly humanApproved: boolean },
): RouterPromotionEvidence {
	const heldIn = outcomes.filter((outcome) => !outcome.holdout);
	const holdoutRows = outcomes.filter((outcome) => outcome.holdout);

	// McNemar counts only discordant pairs, on the held-in split.
	const candidateWins = heldIn.filter((row) => row.candidateCorrect && !row.baselineCorrect).length;
	const baselineWins = heldIn.filter((row) => !row.candidateCorrect && row.baselineCorrect).length;
	const mcnemar = runMcNemar({ b: candidateWins, c: baselineWins });

	return {
		goldenChanges: options.goldenChanges,
		heldIn: {
			baselineWins,
			candidateWins,
			pValue: mcnemar.pValue,
			significant: mcnemar.significant,
		},
		holdout: {
			baselineCorrect: holdoutRows.filter((row) => row.baselineCorrect).length,
			candidateCorrect: holdoutRows.filter((row) => row.candidateCorrect).length,
			total: holdoutRows.length,
		},
		humanApproved: options.humanApproved,
	};
}

/**
 * Read a candidate weight override map. Fails closed with a diagnostic instead
 * of throwing: this script is a CI gate, so unreadable input must produce a
 * refusal, never a stack trace that a runner could misread as a crash.
 */
function readCandidateOverrides(weightsPath: string): Partial<RouterWeightsV4> | undefined {
	let raw: string;
	try {
		raw = readFileSync(weightsPath, "utf-8");
	} catch (error) {
		console.error(`cannot read candidate weights at ${weightsPath}: ${(error as Error).message}`);
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		console.error(`candidate weights at ${weightsPath} are not valid JSON: ${(error as Error).message}`);
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		console.error(`candidate weights at ${weightsPath} must be a JSON object of weight overrides`);
		return undefined;
	}
	return parsed;
}

function readNumberFlag(argv: readonly string[], flag: string, fallback: number): number {
	const index = argv.indexOf(flag);
	if (index < 0) return fallback;
	const parsed = Number(argv[index + 1]);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function main(argv: readonly string[]): number {
	const weightsPath = argv.find((arg) => !arg.startsWith("--") && arg.endsWith(".json"));
	if (!weightsPath) {
		console.error("usage: promote-weights.ts <candidate-weights.json> [--approved] [--golden-changes N]");
		return 2;
	}

	const overrides = readCandidateOverrides(weightsPath);
	if (!overrides) return 2;
	const candidate: RouterWeightsV4 = { ...DEFAULT_WEIGHTS_V4, ...overrides };
	const evidence = buildEvidence(scoreGoldSet(candidate), {
		goldenChanges: readNumberFlag(argv, "--golden-changes", 0),
		humanApproved: argv.includes("--approved"),
	});
	const verdict = evaluateRouterPromotion(evidence, DEFAULT_ROUTER_PROMOTION_POLICY);

	console.log(JSON.stringify({ candidate: weightsPath, evidence, verdict }, null, 1));
	return verdict.promote ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main(process.argv.slice(2));
}
