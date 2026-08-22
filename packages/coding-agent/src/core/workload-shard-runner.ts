import { WorkloadPermitError } from "./workload-permit-pool.ts";
import type { ExecuteWorkloadShardPlanInput } from "./workload-shard-executor.ts";
import type {
	WorkloadShardPlan,
	WorkloadShardProjection,
	WorkloadShardSpec,
	WorkloadShardState,
} from "./workload-shard-plan.ts";

export async function runOneShard(
	input: ExecuteWorkloadShardPlanInput,
	projections: Map<string, WorkloadShardProjection>,
	shardId: string,
	now: () => Date,
): Promise<void> {
	const shard = shardById(input.plan, shardId);
	let releasePermit: (() => void) | undefined;
	if (input.permitPool) {
		try {
			const permit = await input.permitPool.acquire({
				requestId: `shard-${input.plan.planId}-${shardId}`,
				promptRunId: input.plan.promptRunId,
				workloadClass: "heavy",
				weight: 1,
				signal: input.signal,
				timeoutMs: input.permitWaitTimeoutMs ?? 120_000,
			});
			releasePermit = () => permit.release();
		} catch (error) {
			const aborted = error instanceof WorkloadPermitError && error.code === "aborted";
			// Never ran: stays pending; an aborted wait is not a shard failure.
			if (!aborted) {
				applyTransition(input, projections, shardId, "running", { now });
				applyTransition(input, projections, shardId, "failed", { reasonCode: "permit.unavailable", now });
			}
			return;
		}
	}
	const startedAt = now().toISOString();
	applyTransition(input, projections, shardId, "running", { now, startedAt });
	try {
		const result = await input.runner({
			shard,
			attempt: projections.get(shardId)?.attempt ?? 1,
			signal: input.signal,
		});
		const state = terminalStateFor(input.signal, result.exitCode);
		applyTransition(input, projections, shardId, state, {
			now,
			startedAt,
			evidenceRefs: [`exit-code:${result.exitCode}`, ...(result.evidenceRefs ?? [])],
			reasonCode: terminalReasonFor(state, result.exitCode),
		});
	} catch (error) {
		const state: WorkloadShardState = input.signal?.aborted ? "aborted" : "failed";
		applyTransition(input, projections, shardId, state, {
			now,
			startedAt,
			reasonCode: state === "aborted" ? "run.aborted" : "runner.error",
			evidenceRefs: [`error:${String(error).slice(0, 120)}`],
		});
	} finally {
		releasePermit?.();
	}
}

export function applyTransition(
	input: ExecuteWorkloadShardPlanInput,
	projections: Map<string, WorkloadShardProjection>,
	shardId: string,
	state: WorkloadShardState,
	options: {
		readonly now: () => Date;
		readonly startedAt?: string;
		readonly evidenceRefs?: readonly string[];
		readonly reasonCode?: string;
	},
): void {
	const current = projections.get(shardId);
	if (current === undefined) return;
	const attempt = state === "running" ? current.attempt + 1 : current.attempt;
	const terminal = state !== "pending" && state !== "running";
	input.store.appendTransition({
		schemaVersion: 1,
		planId: input.plan.planId,
		shardId,
		attempt,
		state,
		...(options.startedAt !== undefined && state === "running" ? { startedAt: options.startedAt } : {}),
		...(terminal ? { finishedAt: options.now().toISOString() } : {}),
		evidenceRefs: options.evidenceRefs ?? [],
		...(options.reasonCode !== undefined ? { reasonCode: options.reasonCode } : {}),
	});
	projections.set(shardId, {
		shardId,
		state,
		attempt,
		evidenceRefs: options.evidenceRefs?.length ? options.evidenceRefs : current.evidenceRefs,
		reasonCode: options.reasonCode ?? (state === "pending" ? undefined : current.reasonCode),
	});
}

function terminalStateFor(signal: AbortSignal | undefined, exitCode: number): WorkloadShardState {
	if (signal?.aborted) return "aborted";
	return exitCode === 0 ? "passed" : "failed";
}

function terminalReasonFor(state: WorkloadShardState, exitCode: number): string | undefined {
	if (state === "failed") return `exit.${exitCode}`;
	return state === "aborted" ? "run.aborted" : undefined;
}

export function shardById(plan: WorkloadShardPlan, shardId: string): WorkloadShardSpec {
	const shard = plan.shards.find((candidate) => candidate.shardId === shardId);
	if (shard === undefined) {
		throw new Error(`shard ${shardId} not in plan ${plan.planId}`);
	}
	return shard;
}
