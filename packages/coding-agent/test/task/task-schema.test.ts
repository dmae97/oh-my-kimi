import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

// Contract (rework-contracts.md §3): the task tool spawns ONE agent per call.
// `tasks[]` and `context` are gone; `resume` continues an existing agent.

describe("task schema (single-spawn)", () => {
	it("accepts {agent, assignment}", () => {
		const parsed = taskSchema.safeParse({ agent: "explore", assignment: "Map the auth module." });
		expect(parsed.success).toBe(true);
	});

	it("accepts {resume, assignment}", () => {
		const parsed = taskSchema.safeParse({ resume: "AuthLoader", assignment: "Also check refresh tokens." });
		expect(parsed.success).toBe(true);
	});

	it("requires assignment", () => {
		const parsed = taskSchema.safeParse({ agent: "explore" });
		expect(parsed.success).toBe(false);
	});

	it("carries no tasks/context fields", () => {
		const parsed = taskSchema.safeParse({
			agent: "explore",
			assignment: "Map the auth module.",
			context: "shared background",
			tasks: [{ id: "A", assignment: "..." }],
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			// Unknown keys are stripped: the batch/context shape no longer exists.
			expect("tasks" in parsed.data).toBe(false);
			expect("context" in parsed.data).toBe(false);
		}
	});
});

describe("task spawn/resume validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createSession(): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "task.isolation.mode": "none" }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
	}

	async function executeText(params: unknown): Promise<string> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", params);
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	it("rejects resume + agent together", async () => {
		const text = await executeText({ agent: "explore", resume: "AuthLoader", assignment: "..." });
		expect(text).toContain("not both");
	});

	it("rejects neither resume nor agent", async () => {
		const text = await executeText({ assignment: "..." });
		expect(text).toContain("Missing `agent`");
	});

	it("rejects resume + isolated", async () => {
		const text = await executeText({ resume: "AuthLoader", isolated: true, assignment: "..." });
		expect(text).toContain("not resumable");
	});

	it("rejects a missing assignment", async () => {
		const text = await executeText({ agent: "explore" });
		expect(text).toContain("Missing `assignment`");
	});
});
