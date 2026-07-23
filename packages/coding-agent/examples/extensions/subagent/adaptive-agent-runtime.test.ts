import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "omk-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type RunAttemptInput, runAdaptiveAgent } from "./adaptive-agent-runtime.ts";
import { createExecutionBudget } from "./deadline-budget.ts";
import { DeadlineProfileStore } from "./deadline-profile-store.ts";
import { emptyUsage, type SingleResult, type SubagentAttemptResult } from "./subagent-runtime-types.ts";

const cleanupPaths: string[] = [];

function assistant(text: string): Message {
	return { role: "assistant", content: [{ type: "text", text }] } as Message;
}

function attempt(input: RunAttemptInput, outcome: "completed" | "cutoff" | "failed", text = ""): SubagentAttemptResult {
	const exitCode = outcome === "completed" ? 0 : outcome === "failed" ? 1 : 124;
	const result: SingleResult = {
		agent: "reviewer",
		agentSource: "user",
		task: input.logicalTask,
		exitCode,
		messages: text === "" ? [] : [assistant(text)],
		stderr: "",
		usage: emptyUsage(),
		output: text,
		model: "openai-codex/gpt-5.6",
		...(outcome === "cutoff"
			? { stopReason: "deadline", errorMessage: "attempt cutoff" }
			: { stopReason: outcome === "failed" ? "error" : "end" }),
	};
	return {
		result,
		process: {
			reason: outcome === "failed" ? "completed" : outcome,
			elapsedMs: outcome === "completed" ? 10 : input.cutoffMs,
			cleanup: { termSent: outcome === "cutoff", killSent: false, processGroup: true },
		},
	};
}

afterEach(async () => {
	await Promise.all(cleanupPaths.splice(0).map((entry) => fs.promises.rm(entry, { recursive: true, force: true })));
});

describe("adaptive subagent execution", () => {
	it("resumes only the unfinished shard from bounded checkpoint evidence", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omk-adaptive-resume-"));
		cleanupPaths.push(dir);
		const calls: RunAttemptInput[] = [];
		const outputs = ["completed boundary inspection", "finished remaining cleanup"];
		const result = await runAdaptiveAgent({
			agentName: "reviewer",
			agentSource: "user",
			logicalTask: "Review and fix the process boundary.",
			model: "openai-codex/gpt-5.6",
			budget: createExecutionBudget({
				hardDeadlineMs: 5_000,
				cleanupReserveMs: 100,
				maxResumeAttempts: 1,
				maxTaskShards: 3,
			}),
			pendingSequentialTasks: 1,
			checkpointPrefix: path.join(dir, "checkpoint-"),
			profileStore: new DeadlineProfileStore(path.join(dir, "profiles.json")),
			policy: { fallbackAttemptMs: 1_000, minimumAttemptMs: 1, maxTokensPerShard: 6_000 },
			runAttempt: async (input) => {
				calls.push(input);
				return attempt(input, calls.length === 1 ? "cutoff" : "completed", outputs[calls.length - 1]);
			},
		});

		expect(calls).toHaveLength(2);
		expect(calls[1]?.task).toContain("completed boundary inspection");
		expect(calls[1]?.task).toContain("Do not repeat completed side effects");
		expect(result.deadline).toMatchObject({ outcome: "completed", resumeCount: 1, completedShardIds: ["shard-1"] });
		expect(result.output).toContain("completed boundary inspection");
		expect(result.output).toContain("finished remaining cleanup");
	});

	it("learns the provider/model observed from output when the agent inherits its model", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omk-adaptive-observed-model-"));
		cleanupPaths.push(dir);
		const store = new DeadlineProfileStore(path.join(dir, "profiles.json"));
		const result = await runAdaptiveAgent({
			agentName: "reviewer",
			agentSource: "user",
			logicalTask: "Review the process boundary.",
			budget: createExecutionBudget({
				hardDeadlineMs: 5_000,
				cleanupReserveMs: 100,
				maxResumeAttempts: 1,
				maxTaskShards: 3,
			}),
			pendingSequentialTasks: 1,
			checkpointPrefix: path.join(dir, "checkpoint-"),
			profileStore: store,
			policy: { fallbackAttemptMs: 1_000, minimumAttemptMs: 1, maxTokensPerShard: 6_000 },
			runAttempt: async (input) => attempt(input, "completed", "review complete"),
		});

		expect(result.deadline).toMatchObject({ provider: "openai-codex", model: "gpt-5.6" });
		expect(await store.profileFor("openai-codex", "gpt-5.6")).toMatchObject({ samples: 1, completions: 1 });
	});

	it("preserves process failures instead of labeling them as deadline cutoffs", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omk-adaptive-failure-"));
		cleanupPaths.push(dir);
		const result = await runAdaptiveAgent({
			agentName: "reviewer",
			agentSource: "user",
			logicalTask: "Run the failing fixture.",
			budget: createExecutionBudget({
				hardDeadlineMs: 5_000,
				cleanupReserveMs: 100,
				maxResumeAttempts: 1,
				maxTaskShards: 3,
			}),
			pendingSequentialTasks: 1,
			checkpointPrefix: path.join(dir, "checkpoint-"),
			profileStore: new DeadlineProfileStore(path.join(dir, "profiles.json")),
			policy: { fallbackAttemptMs: 1_000, minimumAttemptMs: 1, maxTokensPerShard: 6_000 },
			runAttempt: async (input) => attempt(input, "failed", ""),
		});

		expect(result).toMatchObject({ exitCode: 1, stopReason: "error", errorMessage: "Subagent process failed" });
		expect(result.deadline).toMatchObject({ outcome: "failed" });
	});

	it("does not retry a cutoff that produced no checkpoint or streamed progress", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omk-adaptive-duplicate-"));
		cleanupPaths.push(dir);
		let calls = 0;
		const result = await runAdaptiveAgent({
			agentName: "reviewer",
			agentSource: "user",
			logicalTask: "Review the process boundary.",
			model: "openai-codex/gpt-5.6",
			budget: createExecutionBudget({
				hardDeadlineMs: 5_000,
				cleanupReserveMs: 100,
				maxResumeAttempts: 2,
				maxTaskShards: 3,
			}),
			pendingSequentialTasks: 1,
			checkpointPrefix: path.join(dir, "checkpoint-"),
			profileStore: new DeadlineProfileStore(path.join(dir, "profiles.json")),
			policy: { fallbackAttemptMs: 1_000, minimumAttemptMs: 1, maxTokensPerShard: 6_000 },
			runAttempt: async (input) => {
				calls += 1;
				return attempt(input, "cutoff");
			},
		});

		expect(calls).toBe(1);
		expect(result.deadline).toMatchObject({ outcome: "cutoff", resumeCount: 0, duplicateResumeBlocked: true });
	});

	it("never re-executes shards that already completed", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omk-adaptive-shards-"));
		cleanupPaths.push(dir);
		const shardIds: string[] = [];
		const task = [
			"Upgrade runtime:",
			"1. Inspect the process.",
			"2. Add cleanup.",
			"3. Implement metadata.",
			"4. Run tests.",
		].join("\n");
		const result = await runAdaptiveAgent({
			agentName: "worker",
			agentSource: "user",
			logicalTask: task,
			model: "anthropic/claude-sonnet",
			budget: createExecutionBudget({
				hardDeadlineMs: 5_000,
				cleanupReserveMs: 100,
				maxResumeAttempts: 1,
				maxTaskShards: 3,
			}),
			pendingSequentialTasks: 1,
			checkpointPrefix: path.join(dir, "checkpoint-"),
			profileStore: new DeadlineProfileStore(path.join(dir, "profiles.json")),
			policy: { fallbackAttemptMs: 200, minimumAttemptMs: 1, maxTokensPerShard: 20 },
			runAttempt: async (input) => {
				shardIds.push(input.shardId);
				return attempt(input, "completed", `done ${input.shardId}`);
			},
		});

		expect(shardIds.length).toBeGreaterThan(1);
		expect(new Set(shardIds).size).toBe(shardIds.length);
		expect(result.deadline?.remainingShardIds).toEqual([]);
	});

	it("caps resume cost across the whole logical task rather than once per shard", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omk-adaptive-cost-cap-"));
		cleanupPaths.push(dir);
		const shardIds: string[] = [];
		const task = [
			"Upgrade runtime:",
			"1. Inspect the process.",
			"2. Add cleanup.",
			"3. Implement metadata.",
			"4. Run tests.",
		].join("\n");
		const result = await runAdaptiveAgent({
			agentName: "worker",
			agentSource: "user",
			logicalTask: task,
			model: "openai-codex/gpt-5.6",
			budget: createExecutionBudget({
				hardDeadlineMs: 5_000,
				cleanupReserveMs: 100,
				maxResumeAttempts: 1,
				maxTaskShards: 3,
			}),
			pendingSequentialTasks: 1,
			checkpointPrefix: path.join(dir, "checkpoint-"),
			profileStore: new DeadlineProfileStore(path.join(dir, "profiles.json")),
			policy: { fallbackAttemptMs: 200, minimumAttemptMs: 1, maxTokensPerShard: 20 },
			runAttempt: async (input) => {
				shardIds.push(input.shardId);
				const outcome = shardIds.length === 2 ? "completed" : "cutoff";
				return attempt(input, outcome, `progress ${input.shardId} ${shardIds.length}`);
			},
		});

		expect(shardIds).toEqual(["shard-1", "shard-1", "shard-2"]);
		expect(result.deadline).toMatchObject({ resumeCount: 1, outcome: "cutoff" });
		expect(result.deadline?.remainingShardIds).toContain("shard-2");
	});
});
