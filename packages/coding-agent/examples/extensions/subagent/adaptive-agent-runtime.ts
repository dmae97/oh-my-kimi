import * as os from "node:os";
import * as path from "node:path";
import {
	attemptOutcome,
	createBaseResult,
	finalizeResult,
	mergeForUpdate,
	mergeResult,
	parseProviderModel,
	resultOutput,
} from "./adaptive-result.ts";
import {
	buildCheckpointTask,
	checkpointMadeProgress,
	createCheckpointWorkspace,
	createEmptyCheckpoint,
	readCheckpoint,
	removeCheckpointWorkspace,
	writeCheckpoint,
} from "./checkpoint-runtime.ts";
import {
	allocateAttemptBudget,
	type DeadlineProfile,
	type ExecutionBudget,
	estimateTaskDemand,
	planTaskShards,
	recommendAttemptCutoff,
	remainingExecutionMs,
} from "./deadline-budget.ts";
import type { DeadlineProfileStore } from "./deadline-profile-store.ts";
import type {
	DeadlineAttemptMetadata,
	DeadlineOutcome,
	SingleResult,
	SubagentAttemptResult,
} from "./subagent-runtime-types.ts";

export interface RunAttemptInput {
	readonly logicalTask: string;
	readonly task: string;
	readonly cutoffMs: number;
	readonly attempt: number;
	readonly shardId: string;
	readonly shardIndex: number;
	readonly shardCount: number;
	readonly checkpointFilePath: string;
	readonly onUpdate?: (partial: SingleResult) => void;
}

interface AdaptiveRuntimePolicy {
	readonly fallbackAttemptMs: number;
	readonly minimumAttemptMs: number;
	readonly maxTokensPerShard: number;
}

interface RunAdaptiveAgentOptions {
	readonly agentName: string;
	readonly agentSource: "user" | "project";
	readonly logicalTask: string;
	readonly model?: string;
	readonly step?: number;
	readonly signal?: AbortSignal;
	readonly budget: ExecutionBudget;
	readonly pendingSequentialTasks: number;
	readonly checkpointPrefix?: string;
	readonly profileStore: DeadlineProfileStore;
	readonly policy: AdaptiveRuntimePolicy;
	readonly onUpdate?: (partial: SingleResult) => void;
	readonly runAttempt: (input: RunAttemptInput) => Promise<SubagentAttemptResult>;
}

export async function runAdaptiveAgent(options: RunAdaptiveAgentOptions): Promise<SingleResult> {
	const startedAtMs = Date.now();
	let identity = parseProviderModel(options.model);
	let profile = await options.profileStore.profileFor(identity.provider, identity.model);
	const initialCutoff = cutoffFor(profile, options, remainingExecutionMs(options.budget));
	const demand = estimateTaskDemand(options.logicalTask);
	const shards = planTaskShards(options.logicalTask, demand, {
		attemptCutoffMs: initialCutoff,
		maxTaskShards: options.budget.maxTaskShards,
		maxTokensPerShard: options.policy.maxTokensPerShard,
	});
	const taskAllocation = allocateAttemptBudget({
		budget: options.budget,
		pendingSequentialTasks: options.pendingSequentialTasks,
		pendingShards: 1,
		recommendedCutoffMs: remainingExecutionMs(options.budget),
		minimumAttemptMs: 1,
	});
	const taskBudget: ExecutionBudget = {
		...options.budget,
		hardDeadlineMs: Math.max(1, taskAllocation.taskDeadlineAtMs - startedAtMs),
		deadlineAtMs: Math.min(options.budget.deadlineAtMs, taskAllocation.taskDeadlineAtMs),
	};
	const aggregate = createBaseResult(options);
	const attempts: DeadlineAttemptMetadata[] = [];
	const completedShardIds: string[] = [];
	let resumeCount = 0;
	let duplicateResumeBlocked = false;
	let lastCheckpoint: Awaited<ReturnType<typeof readCheckpoint>> | undefined;
	let terminalOutcome: DeadlineOutcome = "budget-exhausted";
	const checkpointPrefix = options.checkpointPrefix ?? path.join(os.tmpdir(), "omk-subagent-checkpoint-");
	const workspace = await createCheckpointWorkspace(checkpointPrefix);

	try {
		outer: for (const shard of shards) {
			let shardAttempt = 0;
			let shardMessageCount = 0;
			let checkpoint: typeof lastCheckpoint;
			while (true) {
				const pendingShards = shards.length - completedShardIds.length;
				const recommended = cutoffFor(profile, options, remainingExecutionMs(taskBudget));
				const allocation = allocateAttemptBudget({
					budget: taskBudget,
					pendingSequentialTasks: 1,
					pendingShards,
					recommendedCutoffMs: recommended,
					minimumAttemptMs: options.policy.minimumAttemptMs,
				});
				if (allocation.cutoffMs === 0 || options.signal?.aborted) {
					terminalOutcome = options.signal?.aborted ? "aborted" : "budget-exhausted";
					break outer;
				}

				const attemptNumber = shardAttempt + 1;
				const task = buildCheckpointTask({
					originalTask: options.logicalTask,
					shardTask: shard.task,
					shardId: shard.id,
					shardIndex: shard.index,
					shardCount: shards.length,
					attempt: attemptNumber,
					cutoffMs: allocation.cutoffMs,
					checkpointFilePath: workspace.filePath,
					...(checkpoint === undefined ? {} : { checkpoint }),
				});
				const attempt = await options.runAttempt({
					logicalTask: options.logicalTask,
					task,
					cutoffMs: allocation.cutoffMs,
					attempt: attemptNumber,
					shardId: shard.id,
					shardIndex: shard.index,
					shardCount: shards.length,
					checkpointFilePath: workspace.filePath,
					onUpdate: options.onUpdate
						? (partial) => options.onUpdate?.(mergeForUpdate(aggregate, partial))
						: undefined,
				});
				mergeResult(aggregate, attempt.result);
				shardMessageCount += attempt.result.messages.length;
				const outcome = attemptOutcome(attempt);
				const observedIdentity = parseProviderModel(attempt.result.model ?? options.model);
				if (observedIdentity.provider !== identity.provider || observedIdentity.model !== identity.model) {
					identity = observedIdentity;
					profile = await options.profileStore.profileFor(identity.provider, identity.model);
				}
				try {
					profile = await options.profileStore.record({
						provider: identity.provider,
						model: identity.model,
						outcome,
						elapsedMs: attempt.process.elapsedMs,
						estimatedTokens: demand.estimatedTokens,
						workUnits: demand.workUnits,
					});
				} catch {
					profile = await options.profileStore.profileFor(identity.provider, identity.model);
				}
				lastCheckpoint = await readCheckpoint(workspace.filePath, {
					messageCount: shardMessageCount,
					outputTail: resultOutput(attempt.result),
					lastEventAtMs: Date.now(),
				});
				attempts.push({
					attempt: attemptNumber,
					shardId: shard.id,
					cutoffMs: allocation.cutoffMs,
					elapsedMs: attempt.process.elapsedMs,
					outcome,
					exitCode: attempt.result.exitCode,
					messageCount: attempt.result.messages.length,
					processReason: attempt.process.reason,
					cleanup: attempt.process.cleanup,
				});

				if (outcome === "completed") {
					completedShardIds.push(shard.id);
					terminalOutcome = "completed";
					checkpoint = undefined;
					await writeCheckpoint(workspace.filePath, createEmptyCheckpoint());
					continue outer;
				}
				terminalOutcome = outcome;
				if (outcome !== "cutoff" || resumeCount >= taskBudget.maxResumeAttempts) break outer;
				if (!checkpointMadeProgress(checkpoint, lastCheckpoint)) {
					duplicateResumeBlocked = true;
					break outer;
				}
				checkpoint = lastCheckpoint;
				shardAttempt += 1;
				resumeCount += 1;
			}
		}
	} finally {
		await removeCheckpointWorkspace(workspace);
	}

	const remainingShardIds = shards.map((shard) => shard.id).filter((id) => !completedShardIds.includes(id));
	if (remainingShardIds.length === 0) terminalOutcome = "completed";
	finalizeResult(aggregate, terminalOutcome);
	aggregate.deadline = {
		outcome: terminalOutcome,
		startedAtMs,
		elapsedMs: Date.now() - startedAtMs,
		hardDeadlineMs: taskBudget.hardDeadlineMs,
		estimatedTokens: demand.estimatedTokens,
		workUnits: demand.workUnits,
		predictedMs: demand.predictedMs,
		plannedShardIds: shards.map((shard) => shard.id),
		completedShardIds,
		remainingShardIds,
		resumeCount,
		duplicateResumeBlocked,
		provider: identity.provider,
		model: identity.model,
		profileSamples: profile?.samples ?? 0,
		attempts,
		...(lastCheckpoint === undefined ? {} : { checkpoint: lastCheckpoint }),
	};
	return aggregate;
}

function cutoffFor(profile: DeadlineProfile | undefined, options: RunAdaptiveAgentOptions, maximumMs: number): number {
	return recommendAttemptCutoff(profile, {
		fallbackMs: options.policy.fallbackAttemptMs,
		minimumMs: Math.min(options.policy.minimumAttemptMs, maximumMs),
		maximumMs: Math.max(1, maximumMs),
	});
}
