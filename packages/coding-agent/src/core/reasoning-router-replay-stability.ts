/**
 * Two-run stability filter for reasoning-router promotion evidence.
 *
 * A promotion gate is only as trustworthy as the outcomes it credits. Routing
 * evaluations are paired comparisons, and paired comparisons are cheap to fool:
 * if the measured outcome of a row can flip between two identical replays, then
 * a "win" on that row may be measurement noise rather than a better policy.
 * Published routing evaluations report exactly this — a non-trivial share of
 * model/question pairs score differently when the identical matrix is re-run —
 * so a credit rule that ignores rerun disagreement will happily promote noise.
 *
 * This module implements the rule that closes that hole: a row carries credit
 * only when it was observed at least `minReplays` times under each policy and
 * every one of those observations agreed. Rows that disagree are withheld, not
 * majority-voted — a flipped observation means the measurement is unreliable,
 * not that the majority is the truth.
 *
 * For a deterministic classifier every row is stable by construction, so the
 * filter is also a determinism attestation: if nondeterminism ever leaks into
 * the routing path (iteration order, clock, randomness), rows start landing in
 * the unstable bucket and the gate refuses to promote instead of crediting a
 * coin flip.
 *
 * Pure and total: no I/O, no global state, no prompt text.
 */

/** Independent observations required per side before a row may carry credit. */
export const DEFAULT_REPLAY_MIN = 2;

/** One evaluated row, replayed independently under each policy. */
export interface RouterReplayRow {
	readonly rowId: string;
	/** True when the row belongs to the frozen held-out split. */
	readonly holdout: boolean;
	/** Correctness observed on each independent replay under the baseline. */
	readonly baselineReplays: readonly boolean[];
	/** Correctness observed on each independent replay under the candidate. */
	readonly candidateReplays: readonly boolean[];
}

/** A row whose replays agreed, so its outcome may carry promotion credit. */
export interface RouterStableOutcome {
	readonly rowId: string;
	readonly holdout: boolean;
	readonly baselineCorrect: boolean;
	readonly candidateCorrect: boolean;
}

/** Credit-eligible outcomes plus why every other row was withheld. */
export interface RouterReplayStability {
	readonly stable: readonly RouterStableOutcome[];
	/** Rows considered, whatever bucket they landed in. */
	readonly evaluated: number;
	/** Rows withheld because repeated observations disagreed. */
	readonly unstable: number;
	/** Rows withheld because one side was observed too few times to judge. */
	readonly insufficientReplays: number;
	readonly minReplays: number;
}

/** Verdict for one side of one row. */
type ReplayVerdict =
	| { readonly kind: "agreed"; readonly correct: boolean }
	| { readonly kind: "disagreed" }
	| { readonly kind: "insufficient" };

function judgeReplays(replays: readonly boolean[], minReplays: number): ReplayVerdict {
	const [first, ...rest] = replays;
	if (first === undefined || replays.length < minReplays) {
		return { kind: "insufficient" };
	}
	return rest.every((replay) => replay === first) ? { correct: first, kind: "agreed" } : { kind: "disagreed" };
}

/**
 * Partition replayed rows into credit-eligible outcomes and withheld rows.
 *
 * Insufficient replays outrank disagreement: a row observed once is not stable
 * evidence that happens to agree with itself, it is evidence that was never
 * tested for stability at all. Reporting the two buckets separately keeps that
 * distinction visible to the gate, which fails closed on either.
 */
export function summarizeReplayStability(
	rows: readonly RouterReplayRow[],
	minReplays: number = DEFAULT_REPLAY_MIN,
): RouterReplayStability {
	const stable: RouterStableOutcome[] = [];
	let unstable = 0;
	let insufficientReplays = 0;

	for (const row of rows) {
		const baseline = judgeReplays(row.baselineReplays, minReplays);
		const candidate = judgeReplays(row.candidateReplays, minReplays);

		if (baseline.kind === "insufficient" || candidate.kind === "insufficient") {
			insufficientReplays++;
			continue;
		}
		if (baseline.kind === "disagreed" || candidate.kind === "disagreed") {
			unstable++;
			continue;
		}

		stable.push({
			baselineCorrect: baseline.correct,
			candidateCorrect: candidate.correct,
			holdout: row.holdout,
			rowId: row.rowId,
		});
	}

	return { evaluated: rows.length, insufficientReplays, minReplays, stable, unstable };
}
