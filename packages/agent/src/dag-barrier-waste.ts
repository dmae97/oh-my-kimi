/**
 * Barrier waste measurement (TB21 §12.3): pure accounting, no execution change.
 *
 * Under a level barrier, call `i` starts only after its whole level's
 * predecessors finish. Its true predecessors are `assignDagDependencies`
 * entries; any wait beyond the latest true-predecessor finish is barrier
 * waste — time a dependency-ready call sat idle because an unrelated slow
 * call shared its barrier level.
 *
 * Missing or inconsistent timings contribute zero, never negative.
 */

import { assignDagDependencies, type ResolvedClaimEntry } from "./tool-dag-scheduler.ts";

export interface CallTiming {
	readonly startMs: number;
	readonly finishMs: number;
}

/**
 * Total barrier waste in ms across one batch: sum over calls of
 * max(0, actualStart - maxFinish(true predecessors)).
 */
export function computeBarrierWaste(entries: readonly ResolvedClaimEntry[], timings: readonly CallTiming[]): number {
	if (timings.length < entries.length) {
		return 0;
	}
	const predecessors = assignDagDependencies(entries);
	let waste = 0;
	for (let index = 0; index < entries.length; index++) {
		const timing = timings[index];
		if (
			timing === undefined ||
			!Number.isFinite(timing.startMs) ||
			!Number.isFinite(timing.finishMs) ||
			timing.finishMs < timing.startMs
		) {
			continue;
		}
		let depFinish = 0;
		let valid = true;
		for (const pred of predecessors[index] ?? []) {
			const predTiming = timings[pred];
			if (
				predTiming === undefined ||
				!Number.isFinite(predTiming.finishMs) ||
				predTiming.finishMs < predTiming.startMs
			) {
				valid = false;
				break;
			}
			depFinish = Math.max(depFinish, predTiming.finishMs);
		}
		if (!valid) {
			continue;
		}
		waste += Math.max(0, timing.startMs - depFinish);
	}
	return waste;
}
