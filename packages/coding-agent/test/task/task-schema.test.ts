import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

// Contract: the single-spawn schema (`task.batch: false`; the exported
// `taskSchema` instance) carries no batch fields. The batch shape (`tasks[]` +
// shared `context`) is gated by the `task.batch` setting (default on, covered
// by test/task/task-batch.test.ts), and a per-call `schema` input no longer
// exists at all; follow-ups go through `irc` messaging.

describe("task schema (single-spawn)", () => {
	it("accepts {agent, assignment}", () => {
		const parsed = taskSchema.safeParse({ agent: "explore", assignment: "Map the auth module." });
		expect(parsed.success).toBe(true);
	});

	it("requires agent", () => {
		const parsed = taskSchema.safeParse({ assignment: "Map the auth module." });
		expect(parsed.success).toBe(false);
	});

	it("requires assignment", () => {
		const parsed = taskSchema.safeParse({ agent: "explore" });
		expect(parsed.success).toBe(false);
	});

	it("strips tasks/context/schema from the single-spawn schema", () => {
		const parsed = taskSchema.safeParse({
			agent: "explore",
			assignment: "Map the auth module.",
			context: "shared background",
			tasks: [{ id: "A", assignment: "..." }],
			schema: '{"properties":{}}',
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			// Unknown keys are stripped: batch/context exist only on the batch
			// schema and the per-call schema input was removed outright.
			expect("tasks" in parsed.data).toBe(false);
			expect("context" in parsed.data).toBe(false);
			expect("schema" in parsed.data).toBe(false);
		}
	});
});

describe("task spawn validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createSession(): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "task.isolation.mode": "none", "task.batch": false }),
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

	it("rejects a missing agent", async () => {
		const text = await executeText({ assignment: "..." });
		expect(text).toContain("Missing `agent`");
	});

	it("rejects a missing assignment", async () => {
		const text = await executeText({ agent: "explore" });
		expect(text).toContain("Missing `assignment`");
	});
});
