import type { ExecuteWorkloadShardPlanInput, ShardRunContext, ShardRunner } from "./workload-shard-execution-types.ts";
import {
	planShardResume,
	reduceShardRecords,
	validateWorkloadShardPlan,
	type WorkloadShardProjection,
	type WorkloadShardState,
} from "./workload-shard-plan.ts";
import { applyTransition, runOneShard, shardById } from "./workload-shard-runner.ts";
import { WorkloadShardJournalError, type WorkloadShardStore } from "./workload-shard-store.ts";

// The contract lives in `workload-shard-execution-types.ts` so the runner can
// name its own parameter type without importing this module back.
export type { ExecuteWorkloadShardPlanInput, ShardRunContext, ShardRunner };

/**
 * Workload shard executor (OMK v0.97.x roadmap §13, M5 completion slice).
 *
 * Drives a validated `WorkloadShardPlan` through the journalled §13.4 state
 * machine: passed shards are terminal and never re-run (§13.5 step 3),
 * crash-orphaned `running` shards are recovered through `pending` re-arm
 * records, concurrency is recomputed from the CURRENT admission decision
 * (§13.5 step 6) plus the shared permit pool, and completion produces an
 * aggregate evidence receipt (§13.6) — an observation input for
 * `evaluateTask()`, never a task verdict by itself.
 *
 * Fail-closed rules (§21): a corrupt journal is quarantined and the run is
 * `blocked`; a journal written for a different plan is `blocked`; an invalid
 * plan never starts. The executor never rewrites shard commands (§12.3) —
 * it only runs what the plan's descriptors already describe via the
 * injected runner.
 */

export interface ShardResultSummary {
	readonly shardId: string;
	readonly state: WorkloadShardState;
	readonly attempt: number;
	readonly evidenceRefs: readonly string[];
	readonly reasonCode?: string;
}

/** §13.6 aggregate evidence receipt; §15.1 observation kind. */
export interface WorkloadShardAggregateEvidence {
	readonly kind: "workload_shard_result.v1";
	readonly planId: string;
	readonly promptRunId: string;
	readonly commandDigest: string;
	readonly strategy: string;
	readonly verdict: "passed" | "failed" | "aborted" | "blocked";
	readonly reasonCodes: readonly string[];
	readonly shardCount: number;
	readonly counts: Readonly<Record<WorkloadShardState, number>>;
	readonly shards: readonly ShardResultSummary[];
	readonly effectiveConcurrency: number;
	readonly completedAt: string;
}

export async function executeWorkloadShardPlan(
	input: ExecuteWorkloadShardPlanInput,
): Promise<WorkloadShardAggregateEvidence> {
	const now = input.now ?? (() => new Date());
	const planErrors = validateWorkloadShardPlan(input.plan);
	if (planErrors.length > 0) {
		return blockedEvidence(input, now, ["plan.invalid", ...planErrors.slice(0, 3)]);
	}

	let journal: ReturnType<WorkloadShardStore["load"]>;
	try {
		journal = input.store.load();
	} catch (error) {
		// §21 fail closed: corrupt evidence is quarantined, never silently rebuilt.
		if (error instanceof WorkloadShardJournalError) {
			input.store.quarantine();
			return blockedEvidence(input, now, [`journal.${error.code}`]);
		}
		throw error;
	}
	if (journal.plan === null) {
		input.store.appendPlan(input.plan);
	} else if (journal.plan.planId !== input.plan.planId || journal.plan.commandDigest !== input.plan.commandDigest) {
		return blockedEvidence(input, now, ["plan.mismatch"]);
	}

	const projections = new Map<string, WorkloadShardProjection>(
		journal.projections ?? reduceShardRecords(input.plan, []),
	);
	const effectiveConcurrency = Math.max(1, Math.min(input.plan.maxConcurrency, input.decision.maxHeavyProcesses));

	// §13.5 steps 2-4: re-arm recoverable shards through explicit pending records.
	const resume = planShardResume(input.plan, projections);
	const rearm = [
		...resume.interrupted,
		...(input.retryFailed ? resume.retryable : []),
		...((input.resumeAborted ?? true) ? resume.resumable : []),
	];
	for (const shardId of rearm) {
		// §13.5 step 2: a crash-orphaned `running` shard is first projected as
		// interrupted (running -> pending is illegal in §13.4), then re-armed.
		if (projections.get(shardId)?.state === "running") {
			applyTransition(input, projections, shardId, "interrupted", { reasonCode: "recovery.orphaned", now });
		}
		applyTransition(input, projections, shardId, "pending", { reasonCode: "recovery.rearm", now });
	}

	// Dependency-wave scheduler: launch ready shards up to the recomputed width.
	const remaining = new Set(
		input.plan.shards.map((shard) => shard.shardId).filter((id) => projections.get(id)?.state !== "passed"),
	);
	let active = 0;
	let wake: (() => void) | undefined;
	const waitTurn = () =>
		new Promise<void>((resolve) => {
			wake = resolve;
		});
	const running = new Map<string, Promise<void>>();

	while (remaining.size > 0 && !input.signal?.aborted) {
		const ready = [...remaining].filter((id) => {
			const projection = projections.get(id);
			if (projection?.state !== "pending") return false;
			const spec = shardById(input.plan, id);
			return spec.dependencyIds.every((dep) => projections.get(dep)?.state === "passed");
		});
		const launchable = ready.slice(0, Math.max(0, effectiveConcurrency - active));
		if (launchable.length === 0) {
			if (running.size === 0) break; // deadlock = blocked dependents; aggregate reports them
			await Promise.race([...running.values(), waitTurn()]);
			continue;
		}
		for (const shardId of launchable) {
			remaining.delete(shardId);
			active += 1;
			const task = runOneShard(input, projections, shardId, now).finally(() => {
				active -= 1;
				running.delete(shardId);
				wake?.();
			});
			running.set(shardId, task);
		}
	}
	await Promise.all(running.values());

	return aggregate(input, projections, effectiveConcurrency, now, input.signal?.aborted ? ["run.aborted"] : []);
}

function aggregate(
	input: ExecuteWorkloadShardPlanInput,
	projections: ReadonlyMap<string, WorkloadShardProjection>,
	effectiveConcurrency: number,
	now: () => Date,
	extraReasons: readonly string[],
): WorkloadShardAggregateEvidence {
	const counts: Record<WorkloadShardState, number> = {
		pending: 0,
		running: 0,
		passed: 0,
		failed: 0,
		aborted: 0,
		interrupted: 0,
	};
	const shards: ShardResultSummary[] = input.plan.shards.map((shard) => {
		const projection = projections.get(shard.shardId);
		const state = projection?.state ?? "pending";
		counts[state] += 1;
		return {
			shardId: shard.shardId,
			state,
			attempt: projection?.attempt ?? 0,
			evidenceRefs: projection?.evidenceRefs ?? [],
			...(projection?.reasonCode !== undefined ? { reasonCode: projection.reasonCode } : {}),
		};
	});
	const verdict = aggregateVerdict(counts, input.plan.shards.length, extraReasons);
	return {
		kind: "workload_shard_result.v1",
		planId: input.plan.planId,
		promptRunId: input.plan.promptRunId,
		commandDigest: input.plan.commandDigest,
		strategy: input.plan.strategy,
		verdict,
		reasonCodes: extraReasons,
		shardCount: input.plan.shards.length,
		counts,
		shards,
		effectiveConcurrency,
		completedAt: now().toISOString(),
	};
}

function blockedEvidence(
	input: ExecuteWorkloadShardPlanInput,
	now: () => Date,
	reasonCodes: readonly string[],
): WorkloadShardAggregateEvidence {
	const counts: Record<WorkloadShardState, number> = {
		pending: input.plan.shards.length,
		running: 0,
		passed: 0,
		failed: 0,
		aborted: 0,
		interrupted: 0,
	};
	return {
		kind: "workload_shard_result.v1",
		planId: input.plan.planId,
		promptRunId: input.plan.promptRunId,
		commandDigest: input.plan.commandDigest,
		strategy: input.plan.strategy,
		verdict: "blocked",
		reasonCodes,
		shardCount: input.plan.shards.length,
		counts,
		shards: input.plan.shards.map((shard) => ({
			shardId: shard.shardId,
			state: "pending" as const,
			attempt: 0,
			evidenceRefs: [],
		})),
		effectiveConcurrency: 0,
		completedAt: now().toISOString(),
	};
}

/** §13.6: "passed" requires EVERY shard to hold terminal passed evidence. */
function aggregateVerdict(
	counts: Readonly<Record<WorkloadShardState, number>>,
	shardCount: number,
	extraReasons: readonly string[],
): WorkloadShardAggregateEvidence["verdict"] {
	if (counts.passed === shardCount) return "passed";
	if (counts.aborted > 0 || extraReasons.includes("run.aborted")) return "aborted";
	return "failed";
}
