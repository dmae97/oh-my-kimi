export type DeadlineSampleOutcome = "completed" | "cutoff" | "aborted" | "failed";

export interface TaskDemand {
	readonly estimatedTokens: number;
	readonly workUnits: number;
	readonly predictedMs: number;
	readonly actionUnits: readonly string[];
}

export interface TaskShard {
	readonly id: string;
	readonly index: number;
	readonly task: string;
	readonly units: readonly string[];
}

export interface ExecutionBudget {
	readonly startedAtMs: number;
	readonly hardDeadlineMs: number;
	readonly deadlineAtMs: number;
	readonly cleanupReserveMs: number;
	readonly maxResumeAttempts: number;
	readonly maxTaskShards: number;
}

export interface DeadlineProfileSample {
	readonly provider: string;
	readonly model: string;
	readonly outcome: DeadlineSampleOutcome;
	readonly elapsedMs: number;
	readonly estimatedTokens: number;
	readonly workUnits: number;
}

export interface DeadlineProfile {
	readonly provider: string;
	readonly model: string;
	readonly samples: number;
	readonly completions: number;
	readonly cutoffs: number;
	readonly aborts: number;
	readonly failures: number;
	readonly ewmaElapsedMs: number;
	readonly ewmaMsPerWorkUnit: number;
	readonly completedDurationsMs: readonly number[];
	readonly cutoffDurationsMs: readonly number[];
}

export interface DeadlineProfileDb {
	readonly version: 1;
	readonly profiles: Readonly<Record<string, DeadlineProfile>>;
}

interface CreateExecutionBudgetOptions {
	readonly nowMs?: number;
	readonly hardDeadlineMs: number;
	readonly cleanupReserveMs: number;
	readonly maxResumeAttempts: number;
	readonly maxTaskShards: number;
}

interface PlanTaskShardsOptions {
	readonly attemptCutoffMs: number;
	readonly maxTaskShards: number;
	readonly maxTokensPerShard: number;
}

interface AllocateAttemptBudgetOptions {
	readonly budget: ExecutionBudget;
	readonly nowMs?: number;
	readonly pendingSequentialTasks: number;
	readonly pendingShards: number;
	readonly recommendedCutoffMs: number;
	readonly minimumAttemptMs: number;
}

interface RecommendCutoffOptions {
	readonly fallbackMs: number;
	readonly minimumMs: number;
	readonly maximumMs: number;
}

const EXPLICIT_ACTION_LINE = /^\s*(?:\d+[.)]|\[[ xX]\])\s+(.+?)\s*$/;
const BULLET_ACTION_LINE = /^\s*[-*+]\s+(.+?)\s*$/;
const ACTION_VERB =
	/^(?:inspect|add|implement|create|fix|test|run|review|analy[sz]e|verify|update|refactor|migrate|remove|investigate|write|read|document|build|check)\b/i;
const MAX_PROFILE_SAMPLES = 24;
const PROFILE_ALPHA = 0.25;

export function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

export function estimateTaskDemand(task: string): TaskDemand {
	const actionUnits = task
		.split(/\r?\n/)
		.map(extractActionUnit)
		.filter((line): line is string => line !== undefined);
	const estimatedTokens = estimateTokens(task);
	const pathSignals = new Set(task.match(/(?:\.?\.?\/)?[\w.-]+(?:\/[\w.-]+)+/g) ?? []).size;
	const verificationSignals = (task.match(/\b(?:test|typecheck|build|lint|review|verify)\b/gi) ?? []).length;
	const workUnits = Math.max(1, actionUnits.length, Math.min(12, pathSignals + verificationSignals));
	const predictedMs = 45_000 + workUnits * 75_000 + Math.min(120_000, estimatedTokens * 20);
	return { estimatedTokens, workUnits, predictedMs, actionUnits };
}

export function planTaskShards(task: string, demand: TaskDemand, options: PlanTaskShardsOptions): TaskShard[] {
	if (demand.actionUnits.length < 2) return [{ id: "shard-1", index: 0, task, units: [task] }];
	const tokenShards = Math.ceil(demand.estimatedTokens / Math.max(1, options.maxTokensPerShard));
	const timeShards = Math.ceil(demand.predictedMs / Math.max(1, options.attemptCutoffMs));
	const shardCount = Math.min(options.maxTaskShards, demand.actionUnits.length, Math.max(1, tokenShards, timeShards));
	if (shardCount === 1) return [{ id: "shard-1", index: 0, task, units: demand.actionUnits }];

	const shards: TaskShard[] = [];
	for (let index = 0; index < shardCount; index++) {
		const start = Math.floor((index * demand.actionUnits.length) / shardCount);
		const end = Math.floor(((index + 1) * demand.actionUnits.length) / shardCount);
		const units = demand.actionUnits.slice(start, end);
		const current = units.map((unit, unitIndex) => `${unitIndex + 1}. ${unit}`).join("\n");
		shards.push({
			id: `shard-${index + 1}`,
			index,
			units,
			task: [
				"Original task context:",
				task,
				"",
				`Do only this execution shard (${index + 1}/${shardCount}):`,
				current,
				"Do not execute later shards; leave them for the runtime scheduler.",
			].join("\n"),
		});
	}
	return shards;
}

export function createExecutionBudget(options: CreateExecutionBudgetOptions): ExecutionBudget {
	const startedAtMs = options.nowMs ?? Date.now();
	const hardDeadlineMs = Math.max(1, Math.floor(options.hardDeadlineMs));
	return {
		startedAtMs,
		hardDeadlineMs,
		deadlineAtMs: startedAtMs + hardDeadlineMs,
		cleanupReserveMs: Math.max(0, Math.floor(options.cleanupReserveMs)),
		maxResumeAttempts: Math.max(0, Math.floor(options.maxResumeAttempts)),
		maxTaskShards: Math.max(1, Math.floor(options.maxTaskShards)),
	};
}

export function remainingExecutionMs(budget: ExecutionBudget, nowMs = Date.now()): number {
	return Math.max(0, budget.deadlineAtMs - nowMs);
}

export function allocateAttemptBudget(options: AllocateAttemptBudgetOptions): {
	readonly cutoffMs: number;
	readonly taskDeadlineAtMs: number;
	readonly usableMs: number;
} {
	const nowMs = options.nowMs ?? Date.now();
	const usableMs = Math.max(0, remainingExecutionMs(options.budget, nowMs) - options.budget.cleanupReserveMs);
	const taskShareMs = Math.floor(usableMs / Math.max(1, options.pendingSequentialTasks));
	const shardShareMs = Math.floor(taskShareMs / Math.max(1, options.pendingShards));
	const cutoffMs = Math.max(0, Math.min(options.recommendedCutoffMs, shardShareMs));
	return {
		cutoffMs: cutoffMs >= options.minimumAttemptMs ? cutoffMs : 0,
		taskDeadlineAtMs: nowMs + taskShareMs,
		usableMs,
	};
}

export function profileKey(provider: string, model: string): string {
	return `${provider.trim() || "unknown"}/${model.trim() || "default"}`;
}

export function getDeadlineProfile(
	db: DeadlineProfileDb | undefined,
	provider: string,
	model: string,
): DeadlineProfile | undefined {
	return db?.profiles[profileKey(provider, model)];
}

export function updateDeadlineProfiles(
	db: DeadlineProfileDb | undefined,
	sample: DeadlineProfileSample,
): DeadlineProfileDb {
	const key = profileKey(sample.provider, sample.model);
	const previous = db?.profiles[key];
	const elapsedMs = Math.max(1, Math.floor(sample.elapsedMs));
	const workUnits = Math.max(1, sample.workUnits);
	const next: DeadlineProfile = {
		provider: sample.provider,
		model: sample.model,
		samples: (previous?.samples ?? 0) + 1,
		completions: (previous?.completions ?? 0) + Number(sample.outcome === "completed"),
		cutoffs: (previous?.cutoffs ?? 0) + Number(sample.outcome === "cutoff"),
		aborts: (previous?.aborts ?? 0) + Number(sample.outcome === "aborted"),
		failures: (previous?.failures ?? 0) + Number(sample.outcome === "failed"),
		ewmaElapsedMs: ewma(previous?.ewmaElapsedMs, elapsedMs),
		ewmaMsPerWorkUnit: ewma(previous?.ewmaMsPerWorkUnit, elapsedMs / workUnits),
		completedDurationsMs: appendBounded(
			previous?.completedDurationsMs,
			sample.outcome === "completed" ? elapsedMs : undefined,
		),
		cutoffDurationsMs: appendBounded(
			previous?.cutoffDurationsMs,
			sample.outcome === "cutoff" ? elapsedMs : undefined,
		),
	};
	return { version: 1, profiles: { ...(db?.profiles ?? {}), [key]: next } };
}

export function recommendAttemptCutoff(profile: DeadlineProfile | undefined, options: RecommendCutoffOptions): number {
	const completed = percentile(profile?.completedDurationsMs ?? [], 0.9);
	const cutoff = percentile(profile?.cutoffDurationsMs ?? [], 0.25);
	const candidates = [options.fallbackMs];
	if (completed !== undefined) candidates.push(Math.round(completed * 1.5));
	if (cutoff !== undefined) candidates.push(Math.round(cutoff * 0.75));
	return Math.max(options.minimumMs, Math.min(options.maximumMs, ...candidates));
}

function extractActionUnit(line: string): string | undefined {
	const explicit = line.match(EXPLICIT_ACTION_LINE)?.[1]?.trim();
	if (explicit) return explicit;
	const bullet = line.match(BULLET_ACTION_LINE)?.[1]?.trim();
	return bullet && ACTION_VERB.test(bullet) ? bullet : undefined;
}

function ewma(previous: number | undefined, value: number): number {
	return Math.round(previous === undefined ? value : previous * (1 - PROFILE_ALPHA) + value * PROFILE_ALPHA);
}

function appendBounded(previous: readonly number[] | undefined, value: number | undefined): number[] {
	if (value === undefined) return [...(previous ?? [])];
	return [...(previous ?? []), value].slice(-MAX_PROFILE_SAMPLES);
}

function percentile(values: readonly number[], ratio: number): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}
