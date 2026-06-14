import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import {
	getTaskSchema,
	oneLineLabel,
	ROLE_INPUT_MAX,
	resolveSubagentDisplayName,
} from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { prompt } from "@oh-my-pi/pi-utils";
import subagentSystemPromptTemplate from "../../src/prompts/system/subagent-system-prompt.md" with { type: "text" };

// Contract: a per-spawn `role` gives a subagent a tailored identity. The role
// becomes its registry/roster display name and is injected as a system-prompt
// specialization preamble; an absent/blank role falls back to the agent type.

describe("resolveSubagentDisplayName", () => {
	it("uses the role as the display name when one is given", () => {
		expect(resolveSubagentDisplayName("Rust async-runtime specialist", "task")).toBe("Rust async-runtime specialist");
	});

	it("falls back to the agent name for an absent role", () => {
		expect(resolveSubagentDisplayName(undefined, "task")).toBe("task");
	});

	it("falls back to the agent name for an empty or whitespace role", () => {
		expect(resolveSubagentDisplayName("", "explore")).toBe("explore");
		expect(resolveSubagentDisplayName("   \n\t ", "explore")).toBe("explore");
	});

	it("collapses internal whitespace so a multi-line role stays one roster line", () => {
		expect(resolveSubagentDisplayName("Auth\n  flow   reviewer", "task")).toBe("Auth flow reviewer");
	});

	it("caps an overlong role label with an ellipsis", () => {
		const long = "x".repeat(200);
		const label = resolveSubagentDisplayName(long, "task");
		expect(label.length).toBe(80);
		expect(label.endsWith("…")).toBe(true);
	});
});

describe("oneLineLabel", () => {
	it("returns short text unchanged", () => {
		expect(oneLineLabel("DB migration specialist")).toBe("DB migration specialist");
	});

	it("collapses control and zero-width characters that \\s alone misses", () => {
		// U+0085 (NEL) and U+200B (zero-width space) are NOT matched by \s, so a
		// bare replace(/\s+/) would leak them into a prompt/roster field.
		const out = oneLineLabel("Auth\u0085flow\u200breviewer");
		expect(out).toBe("Auth flow reviewer");
		expect(out).not.toMatch(/[\p{Cc}\p{Cf}]/u);
	});

	it("respects a minimal cap without a negative-slice blowup", () => {
		expect(oneLineLabel("abcdef", 1)).toBe("…");
		expect(oneLineLabel("abcdef", 0)).toBe("…");
	});

	it("truncates on a code-point boundary without splitting a surrogate pair", () => {
		// The cut would land mid-emoji at the default cap; the result must stay
		// well-formed (a lone surrogate makes encodeURIComponent throw).
		const out = oneLineLabel(`${"a".repeat(78)}😀tail`);
		expect(out.endsWith("…")).toBe(true);
		expect(() => encodeURIComponent(out)).not.toThrow();
	});
});

describe("subagent system prompt role preamble", () => {
	function render(role: string): string {
		return prompt.render(subagentSystemPromptTemplate, { agent: "Base worker body.", role });
	}

	it("injects the specialization preamble when a role is provided", () => {
		const out = render("Rust async-runtime specialist");
		expect(out).toContain("specializing as: **Rust async-runtime specialist**");
	});

	it("omits the preamble entirely when the role is blank", () => {
		expect(render("")).not.toContain("specializing as");
	});
});

describe("task schema accepts role", () => {
	it("keeps role on the flat single-spawn shape", () => {
		const parsed = taskSchema.safeParse({ agent: "task", assignment: "x", role: "Rust specialist" });
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.role).toBe("Rust specialist");
		}
	});

	it("keeps role on batch task items", () => {
		const batch = getTaskSchema({ isolationEnabled: false, batchEnabled: true });
		const parsed = batch.safeParse({
			agent: "task",
			context: "ctx",
			tasks: [{ assignment: "x", role: "DB migration specialist" }],
		});
		expect(parsed.success).toBe(true);
		if (parsed.success && "tasks" in parsed.data) {
			const tasks = parsed.data.tasks as Array<{ role?: string }>;
			expect(tasks[0]?.role).toBe("DB migration specialist");
		}
	});

	it("rejects a role longer than the schema bound", () => {
		const parsed = taskSchema.safeParse({ agent: "task", assignment: "x", role: "x".repeat(ROLE_INPUT_MAX + 1) });
		expect(parsed.success).toBe(false);
	});

	it("accepts a role at the schema bound", () => {
		const parsed = taskSchema.safeParse({ agent: "task", assignment: "x", role: "x".repeat(ROLE_INPUT_MAX) });
		expect(parsed.success).toBe(true);
	});
});

// Contract: a role shapes the spawned subagent's system prompt and identity, so
// an approval-gated session must surface it before the user authorizes the spawn.
describe("task approval details surface role", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function makeTool(): Promise<TaskTool> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		return TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "task.isolation.mode": "none", "task.batch": false }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession);
	}

	it("includes the role line for a flat spawn", async () => {
		const tool = await makeTool();
		const lines = tool.formatApprovalDetails({ agent: "task", role: "Security reviewer", assignment: "x" });
		expect(lines).toContain("Role: Security reviewer");
	});

	it("includes the role line for the first batch task", async () => {
		const tool = await makeTool();
		const lines = tool.formatApprovalDetails({
			agent: "task",
			tasks: [{ role: "DB migration specialist", assignment: "x" }],
		});
		expect(lines).toContain("Role: DB migration specialist");
	});
});
