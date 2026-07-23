import { describe, expect, it } from "vitest";
import {
	allocateAttemptBudget,
	createExecutionBudget,
	estimateTaskDemand,
	getDeadlineProfile,
	planTaskShards,
	recommendAttemptCutoff,
	remainingExecutionMs,
	updateDeadlineProfiles,
} from "./deadline-budget.ts";

describe("subagent dual budget planning", () => {
	it("shards an explicit action list when token and wall-clock demand exceed one attempt", () => {
		const task = [
			"Upgrade the runtime:",
			"1. Inspect the provider boundary.",
			"2. Add typed deadline metadata.",
			"3. Implement checkpoint persistence.",
			"4. Add bounded resume prompts.",
			"5. Run fixture tests.",
			"6. Review process cleanup.",
		].join("\n");
		const demand = estimateTaskDemand(task);
		const shards = planTaskShards(task, demand, {
			attemptCutoffMs: 180_000,
			maxTaskShards: 3,
			maxTokensPerShard: 40,
		});

		expect(demand.workUnits).toBeGreaterThanOrEqual(6);
		expect(shards).toHaveLength(3);
		expect(shards.flatMap((shard) => shard.units)).toEqual([
			"Inspect the provider boundary.",
			"Add typed deadline metadata.",
			"Implement checkpoint persistence.",
			"Add bounded resume prompts.",
			"Run fixture tests.",
			"Review process cleanup.",
		]);
		expect(shards.every((shard) => shard.task.includes("Do only this execution shard"))).toBe(true);
	});

	it("recognizes explicit CJK numbered actions without relying on English verbs", () => {
		const task = [
			"런타임 업그레이드:",
			"1. 프로세스 경계를 분석한다.",
			"2. 체크포인트 재개를 구현한다.",
			"3. fixture 테스트를 실행한다.",
		].join("\n");
		const demand = estimateTaskDemand(task);
		const shards = planTaskShards(task, demand, {
			attemptCutoffMs: 100_000,
			maxTaskShards: 3,
			maxTokensPerShard: 20,
		});

		expect(demand.actionUnits).toEqual([
			"프로세스 경계를 분석한다.",
			"체크포인트 재개를 구현한다.",
			"fixture 테스트를 실행한다.",
		]);
		expect(shards.length).toBeGreaterThan(1);
	});

	it("keeps an indivisible task as one shard even when it is expensive", () => {
		const task = "Investigate and fix the runtime without repeating completed side effects.";
		const demand = estimateTaskDemand(task);
		const shards = planTaskShards(task, demand, {
			attemptCutoffMs: 1,
			maxTaskShards: 3,
			maxTokensPerShard: 1,
		});

		expect(shards).toEqual([{ id: "shard-1", index: 0, task, units: [task] }]);
	});

	it("reserves cleanup time and divides a sequential deadline among pending work", () => {
		const budget = createExecutionBudget({
			nowMs: 1_000,
			hardDeadlineMs: 900,
			cleanupReserveMs: 100,
			maxResumeAttempts: 1,
			maxTaskShards: 3,
		});

		expect(remainingExecutionMs(budget, 1_250)).toBe(650);
		expect(
			allocateAttemptBudget({
				budget,
				nowMs: 1_250,
				pendingSequentialTasks: 2,
				pendingShards: 1,
				recommendedCutoffMs: 1_000,
				minimumAttemptMs: 1,
			}),
		).toEqual({ cutoffMs: 275, taskDeadlineAtMs: 1_525, usableMs: 550 });
	});
});

describe("provider/model deadline learning", () => {
	it("learns completion and cutoff history independently per provider and model", () => {
		let db = updateDeadlineProfiles(undefined, {
			provider: "openai-codex",
			model: "gpt-5.6",
			outcome: "completed",
			elapsedMs: 120_000,
			estimatedTokens: 2_000,
			workUnits: 2,
		});
		db = updateDeadlineProfiles(db, {
			provider: "openai-codex",
			model: "gpt-5.6",
			outcome: "cutoff",
			elapsedMs: 600_000,
			estimatedTokens: 2_000,
			workUnits: 2,
		});
		db = updateDeadlineProfiles(db, {
			provider: "anthropic",
			model: "claude-sonnet",
			outcome: "completed",
			elapsedMs: 40_000,
			estimatedTokens: 500,
			workUnits: 1,
		});

		const codex = getDeadlineProfile(db, "openai-codex", "gpt-5.6");
		const anthropic = getDeadlineProfile(db, "anthropic", "claude-sonnet");
		expect(codex).toMatchObject({ samples: 2, completions: 1, cutoffs: 1 });
		expect(anthropic).toMatchObject({ samples: 1, completions: 1, cutoffs: 0 });
		expect(recommendAttemptCutoff(codex, { fallbackMs: 600_000, minimumMs: 1, maximumMs: 800_000 })).toBe(180_000);
		expect(recommendAttemptCutoff(anthropic, { fallbackMs: 600_000, minimumMs: 1, maximumMs: 800_000 })).toBe(60_000);
	});
});
