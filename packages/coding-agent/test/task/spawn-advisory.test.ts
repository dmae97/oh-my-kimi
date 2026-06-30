import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { buildSpecializationAdvisory, TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskItem, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

// Contract: the task tool appends an advisory (never a rejection) steering the
// spawner toward tailored specialists when it spawns generic role-less workers
// and still holds spawn capacity (DepthCapacity). It is gated on depth so a
// leaf at max recursion is never nagged.

const item = (role?: string): TaskItem => ({ assignment: "do the thing", role });

describe("buildSpecializationAdvisory", () => {
	it("nudges a generic role-less spawn when depth capacity remains", () => {
		const advice = buildSpecializationAdvisory("task", [item()], true);
		expect(advice).toBeDefined();
		expect(advice).toContain("`role`");
	});

	it("stays silent at max depth even for a generic role-less spawn", () => {
		expect(buildSpecializationAdvisory("task", [item()], false)).toBeUndefined();
	});

	it("stays silent when the spawn already carries a role", () => {
		expect(buildSpecializationAdvisory("task", [item("Rust async-runtime specialist")], true)).toBeUndefined();
	});

	it("treats a whitespace-only role as absent and nudges", () => {
		expect(buildSpecializationAdvisory("sonic", [item("   ")], true)).toBeDefined();
	});

	it("nudges when one call clones the same agent twice without roles", () => {
		expect(buildSpecializationAdvisory("reviewer", [item(), item()], true)).toBeDefined();
	});

	it("stays silent for a single non-generic role-less spawn", () => {
		expect(buildSpecializationAdvisory("reviewer", [item()], true)).toBeUndefined();
	});
});

// Contract: the advisory rides the task-tool result for an interactive spawner,
// but a session that opts out (`suppressSpawnAdvisory` — internal/programmatic
// callers like the commit agent's file-analysis fan-out) gets a clean result so
// the nudge never contaminates code-consumed evidence.
describe("task tool advisory gating via suppressSpawnAdvisory", () => {
	const agent: AgentDefinition = {
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled",
	};

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function session(suppress: boolean): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			suppressSpawnAdvisory: suppress,
			settings: Settings.isolated({ "task.isolation.mode": "none", "task.batch": false }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
	}

	async function spawnText(suppress: boolean): Promise<string> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(
			async (options): Promise<SingleResult> => ({
				index: 0,
				id: options.id ?? "X",
				agent: "task",
				agentSource: "bundled",
				task: "t",
				assignment: "do the thing",
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 1,
			}),
		);
		const tool = await TaskTool.create(session(suppress));
		const result = await tool.execute("tc", { agent: "task", id: "X", assignment: "do the thing" } as TaskParams);
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	it("appends the specialization advisory for a generic role-less spawn", async () => {
		expect(await spawnText(false)).toContain("`role`");
	});

	it("omits the advisory entirely when the session suppresses it", async () => {
		expect(await spawnText(true)).not.toContain("`role`");
	});
});
