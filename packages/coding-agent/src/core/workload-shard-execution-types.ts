/**
 * Shard execution contract.
 *
 * These declarations describe the call the executor makes and the input it
 * takes. They lived in the executor, so the runner — which the executor calls
 * to advance one shard — had to import the executor back to name its own
 * parameter type. Moving the contract below both leaves the executor free to
 * depend on the runner without the runner depending on the executor.
 *
 * Types only. Imports stay on the plan, store, admission, and permit modules,
 * none of which reach the executor or the runner.
 */

import type { ResourceAdmissionDecision } from "./resource-admission.ts";
import type { WorkloadPermitPool } from "./workload-permit-pool.ts";
import type { WorkloadShardPlan, WorkloadShardSpec } from "./workload-shard-plan.ts";
import type { WorkloadShardStore } from "./workload-shard-store.ts";

export interface ShardRunContext {
	readonly shard: WorkloadShardSpec;
	readonly attempt: number;
	readonly signal?: AbortSignal;
}

export type ShardRunner = (
	context: ShardRunContext,
) => Promise<{ readonly exitCode: number; readonly evidenceRefs?: readonly string[] }>;

export interface ExecuteWorkloadShardPlanInput {
	readonly plan: WorkloadShardPlan;
	readonly store: WorkloadShardStore;
	readonly runner: ShardRunner;
	readonly decision: ResourceAdmissionDecision;
	readonly permitPool?: WorkloadPermitPool;
	readonly signal?: AbortSignal;
	/** §13.5 step 4 retry policy: re-arm previously failed shards. Default false. */
	readonly retryFailed?: boolean;
	/** §13.4: aborted -> pending needs an explicit resume; this call is that act. Default true. */
	readonly resumeAborted?: boolean;
	readonly permitWaitTimeoutMs?: number;
	readonly now?: () => Date;
}
