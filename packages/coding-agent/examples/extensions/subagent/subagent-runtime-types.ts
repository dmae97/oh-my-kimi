import type { Message } from "omk-ai";
import type { AgentCheckpoint } from "./checkpoint-runtime.ts";
import type { ManagedProcessCleanup, ManagedProcessReason } from "./managed-process.ts";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export type DeadlineOutcome = "completed" | "cutoff" | "aborted" | "failed" | "budget-exhausted";

export interface DeadlineAttemptMetadata {
	readonly attempt: number;
	readonly shardId: string;
	readonly cutoffMs: number;
	readonly elapsedMs: number;
	readonly outcome: Exclude<DeadlineOutcome, "budget-exhausted">;
	readonly exitCode: number;
	readonly messageCount: number;
	readonly processReason: ManagedProcessReason;
	readonly cleanup: ManagedProcessCleanup;
}

export interface AgentDeadlineMetadata {
	readonly outcome: DeadlineOutcome;
	readonly startedAtMs: number;
	readonly elapsedMs: number;
	readonly hardDeadlineMs: number;
	readonly estimatedTokens: number;
	readonly workUnits: number;
	readonly predictedMs: number;
	readonly plannedShardIds: readonly string[];
	readonly completedShardIds: readonly string[];
	readonly remainingShardIds: readonly string[];
	readonly resumeCount: number;
	readonly duplicateResumeBlocked: boolean;
	readonly provider: string;
	readonly model: string;
	readonly profileSamples: number;
	readonly attempts: readonly DeadlineAttemptMetadata[];
	readonly checkpoint?: AgentCheckpoint;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	output?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	deadline?: AgentDeadlineMetadata;
}

export interface SubagentAttemptResult {
	readonly result: SingleResult;
	readonly process: {
		readonly reason: ManagedProcessReason;
		readonly elapsedMs: number;
		readonly cleanup: ManagedProcessCleanup;
	};
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}
