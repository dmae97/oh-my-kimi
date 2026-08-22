import type { ResourceAdmissionDecision } from "./resource-admission.ts";
import type { SubagentOrchestrationPlan } from "./subagent-orchestration.ts";
import { WorkloadPermitError, type WorkloadPermitPool } from "./workload-permit-pool.ts";

/**
 * Subagent lane launch authority (OMK v0.97.x roadmap §14, M6/PR10).
 *
 * Turns `buildSubagentOrchestrationPlan()` output into enforced execution:
 * the §14.2 effective width is a hard cap on concurrently active children,
 * batches run in order (writer serialization / path conflicts are encoded in
 * the plan's batches, which supplies the `pathConflictFreeWidth` term), and
 * heavy lanes draw permits from the PARENT's shared pool (§14.1 — a child
 * never constructs its own pool here; it receives this launcher's budget).
 *
 * §14.3 guarantees: child failure releases its permit (leak 0), parent
 * abort aborts queued permit waits and never launches unstarted lanes, and
 * the child context carries the parent decision with a width the child
 * cannot raise (§14.4: no API exists to widen — the context is read-only).
 */

export interface EffectiveLaneWidthInput {
	readonly planWidth: number;
	readonly configuredMaxParallelLanes?: number;
	readonly admissionMaxParallelLanes: number;
	readonly availableHeavyPermits: number;
	/** Widest conflict-free batch; the plan's batching already serializes writers. */
	readonly pathConflictFreeWidth: number;
}

/** §14.2: `min(plan, configured, admission, availableHeavyPermits, conflictFree)`, floor 1. */
export function computeEffectiveLaneWidth(input: EffectiveLaneWidthInput): number {
	const configured =
		input.configuredMaxParallelLanes !== undefined && input.configuredMaxParallelLanes > 0
			? input.configuredMaxParallelLanes
			: Number.POSITIVE_INFINITY;
	const width = Math.min(
		input.planWidth,
		configured,
		input.admissionMaxParallelLanes,
		Math.max(1, input.availableHeavyPermits),
		input.pathConflictFreeWidth,
	);
	return Math.max(1, Math.floor(width));
}

/** Read-only budget handed to every child (§14.1). Nothing here can raise a cap. */
export interface SubagentLaneContext {
	readonly laneId: string;
	readonly promptRunId: string;
	readonly decision: ResourceAdmissionDecision;
	readonly effectiveLaneWidth: number;
}

export interface LaneOutcome {
	readonly laneId: string;
	readonly status: "completed" | "failed" | "skipped-abort" | "permit-rejected";
	readonly diagnostic?: string;
}

export interface LaunchSubagentLanesInput {
	readonly plan: SubagentOrchestrationPlan;
	readonly promptRunId: string;
	readonly decision: ResourceAdmissionDecision;
	readonly permitPool: WorkloadPermitPool;
	readonly configuredMaxParallelLanes?: number;
	readonly signal?: AbortSignal;
	/** Lane ids that run heavy work and must hold a shared permit (§14.3). */
	readonly heavyLaneIds?: ReadonlySet<string>;
	/** The actual child launcher (process spawn, SDK session, or test double). */
	readonly launchLane: (context: SubagentLaneContext) => Promise<void>;
	readonly permitWaitTimeoutMs?: number;
}

export interface LaunchSubagentLanesResult {
	readonly outcomes: readonly LaneOutcome[];
	readonly effectiveLaneWidth: number;
	readonly maxObservedConcurrency: number;
}

/**
 * Execute a plan's batches with the §14.2 width as launcher authority.
 * Never throws for lane failures; the caller reads per-lane outcomes.
 */
export async function launchSubagentLanes(input: LaunchSubagentLanesInput): Promise<LaunchSubagentLanesResult> {
	const poolSnapshot = input.permitPool.snapshot();
	const effectiveLaneWidth = computeEffectiveLaneWidth({
		planWidth: Math.max(1, input.plan.route.width),
		configuredMaxParallelLanes: input.configuredMaxParallelLanes,
		admissionMaxParallelLanes: input.decision.maxParallelLanes,
		availableHeavyPermits: Math.max(0, poolSnapshot.capacity - poolSnapshot.activeWeight),
		pathConflictFreeWidth: Math.max(1, ...input.plan.batches.map((batch) => batch.laneIds.length)),
	});

	const outcomes: LaneOutcome[] = [];
	let active = 0;
	let maxObservedConcurrency = 0;

	for (const batch of input.plan.batches) {
		if (input.signal?.aborted) {
			// Parent abort: unstarted lanes are never launched (§14.3).
			for (const laneId of batch.laneIds) {
				outcomes.push({ laneId, status: "skipped-abort" });
			}
			continue;
		}
		// Batches execute sequentially (dependency + writer serialization);
		// inside one batch, the effective width bounds the running children.
		let cursor = 0;
		const runners: Promise<void>[] = [];
		const runNext = async (): Promise<void> => {
			while (cursor < batch.laneIds.length) {
				const laneId = batch.laneIds[cursor];
				cursor += 1;
				if (input.signal?.aborted) {
					outcomes.push({ laneId, status: "skipped-abort" });
					continue;
				}
				outcomes.push(
					await runLane(input, laneId, effectiveLaneWidth, {
						enter: () => {
							active += 1;
							maxObservedConcurrency = Math.max(maxObservedConcurrency, active);
						},
						exit: () => {
							active -= 1;
						},
					}),
				);
			}
		};
		const workers = Math.min(effectiveLaneWidth, batch.laneIds.length);
		for (let i = 0; i < workers; i++) {
			runners.push(runNext());
		}
		await Promise.all(runners);
	}
	return { outcomes, effectiveLaneWidth, maxObservedConcurrency };
}

async function runLane(
	input: LaunchSubagentLanesInput,
	laneId: string,
	effectiveLaneWidth: number,
	gauge: { readonly enter: () => void; readonly exit: () => void },
): Promise<LaneOutcome> {
	let releasePermit: (() => void) | undefined;
	if (input.heavyLaneIds?.has(laneId)) {
		try {
			const permit = await input.permitPool.acquire({
				requestId: `lane-${laneId}`,
				promptRunId: input.promptRunId,
				workloadClass: "heavy",
				weight: 1,
				signal: input.signal,
				timeoutMs: input.permitWaitTimeoutMs ?? 60_000,
			});
			releasePermit = () => permit.release();
		} catch (error) {
			const code = error instanceof WorkloadPermitError ? error.code : "unknown";
			return {
				laneId,
				status: code === "aborted" ? "skipped-abort" : "permit-rejected",
				diagnostic: `permit.${code}`,
			};
		}
	}
	gauge.enter();
	try {
		await input.launchLane({
			laneId,
			promptRunId: input.promptRunId,
			decision: input.decision,
			effectiveLaneWidth,
		});
		return { laneId, status: "completed" };
	} catch (error) {
		// §14.3: a failing child must not leak its permit; release below.
		return { laneId, status: "failed", diagnostic: String(error).slice(0, 200) };
	} finally {
		gauge.exit();
		releasePermit?.();
	}
}
