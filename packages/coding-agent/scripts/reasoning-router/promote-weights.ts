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
 * Every row is replayed under the two-run rule before it can carry credit, and
 * the evidence declares that the opponent was the frozen reference policy —
 * without both, the gate refuses to reason about the numbers at all.
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
import {
	DEFAULT_REPLAY_MIN,
	type RouterReplayRow,
	type RouterReplayStability,
	summarizeReplayStability,
} from "../../src/core/reasoning-router-replay-stability.ts";
import { classifyTaskV4 } from "../../src/core/reasoning-router-v4.ts";
import { DEFAULT_WEIGHTS_V4, type RouterWeightsV4 } from "../../src/core/reasoning-router-v4-weights.ts";
import { type GoldEntry, GOLD_SET } from "../../test/fixtures/reasoning-router-gold-set.ts";
import { runMcNemar } from "./mcnemar.ts";

function observe(weights: RouterWeightsV4, entry: GoldEntry, replays: number): readonly boolean[] {
	return Array.from(
		{ length: replays },
		() => classifyTaskV4({ prompt: entry.prompt }, weights).taskClass === entry.expectedClass,
	);
}

/**
 * Replay every gold row under both weight sets, preserving the split flag.
 *
 * The classifier is deterministic, so repeating it is not a sampling strategy —
 * it is a determinism attestation. If nondeterminism ever leaks into the
 * routing path, the repeats disagree, those rows lose their credit, and the
 * gate refuses to promote instead of banking whichever run looked better.
 */
export function replayGoldSet(
	candidate: RouterWeightsV4,
	replays: number = DEFAULT_REPLAY_MIN,
): readonly RouterReplayRow[] {
	return GOLD_SET.map((entry) => ({
		baselineReplays: observe(DEFAULT_WEIGHTS_V4, entry, replays),
		candidateReplays: observe(candidate, entry, replays),
		holdout: entry.holdout === true,
		rowId: entry.id,
	}));
}

/** Assemble gate evidence from replay-stable outcomes only. */
export function buildEvidence(
	stability: RouterReplayStability,
	options: { readonly goldenChanges: number; readonly humanApproved: boolean },
): RouterPromotionEvidence {
	const heldIn = stability.stable.filter((row) => !row.holdout);
	const holdoutRows = stability.stable.filter((row) => row.holdout);

	// McNemar counts only discordant pairs, on the held-in split.
	const candidateWins = heldIn.filter((row) => row.candidateCorrect && !row.baselineCorrect).length;
	const baselineWins = heldIn.filter((row) => !row.candidateCorrect && row.baselineCorrect).length;
	const mcnemar = runMcNemar({ b: candidateWins, c: baselineWins });

	return {
		// The opponent is `DEFAULT_WEIGHTS_V4`: the shipped policy that learning
		// never updates, which is the frozen reference the gate demands.
		baselineKind: "frozen_reference",
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
		stability: {
			evaluated: stability.evaluated,
			replays: stability.minReplays,
			unstable: stability.unstable,
		},
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
	const evidence = buildEvidence(summarizeReplayStability(replayGoldSet(candidate)), {
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
