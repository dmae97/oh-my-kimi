/**
 * Deadline policy (TB21 §9.1): monotonic-clock run budget with verify,
 * finalize, and cleanup reserves.
 *
 * All timestamps are monotonic milliseconds (performance.now()-style deltas
 * or Date.now() differences — the policy only subtracts, never interprets
 * wall-clock values). New exploration must not start when only reserves
 * remain; tool timeouts clamp into the exploration budget.
 */

export interface DeadlinePolicy {
	/** Total run allowance in ms. */
	readonly totalMs: number;
	/** Reserve for verification before the deadline. */
	readonly verifyReserveMs: number;
	/** Reserve for final persistence after verification. */
	readonly finalizeReserveMs: number;
	/** Reserve for cleanup after finalization. */
	readonly cleanupReserveMs: number;
}

export type RunPhase = "explore" | "verify" | "exhausted";

export interface RunBudget {
	readonly remainingMs: number;
	readonly explorationMs: number;
	readonly phase: RunPhase;
}

/** Pure budget computation from a monotonic start/now pair. */
export function computeRunBudget(policy: DeadlinePolicy, startMonoMs: number, nowMonoMs: number): RunBudget {
	const elapsed = Math.max(0, nowMonoMs - startMonoMs);
	const remainingMs = Math.max(0, policy.totalMs - elapsed);
	const reserves = policy.verifyReserveMs + policy.finalizeReserveMs + policy.cleanupReserveMs;
	const explorationMs = Math.max(0, remainingMs - reserves);
	const phase: RunPhase = remainingMs <= 0 ? "exhausted" : explorationMs <= 0 ? "verify" : "explore";
	return { remainingMs, explorationMs, phase };
}

/** Clamp a requested action timeout into the exploration budget. Zero means "do not start". */
export function clampActionTimeout(budget: RunBudget, requestedMs: number): number {
	if (budget.phase !== "explore") {
		return 0;
	}
	return Math.max(0, Math.min(requestedMs, budget.explorationMs));
}
