import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	selectStickyTodoWindow,
	TODO_STRIKE_HOLD_FRAMES,
	type TodoItem,
	type TodoPhase,
	type TodoStatus,
	TodoTool,
	todoMatchesAnyDescription,
	todoToolRenderer,
} from "@oh-my-pi/pi-coding-agent/tools";

function createSession(initialPhases: TodoPhase[] = []): ToolSession {
	let phases = initialPhases;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("TodoTool auto-start behavior", () => {
	it("auto-starts the first task after init", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
				},
			],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo");
		expect(summary.text).toContain("Remaining items (2):");
		expect(summary.text).toContain("status [in_progress] (Execution)");
		expect(summary.text).toContain("diagnostics [pending] (Execution)");
	});

	it("auto-promotes the next pending task when current task is completed", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "done", task: "status" }] });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
		expect(result.details?.completedTasks).toEqual([{ phase: "Execution", content: "status" }]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo");
		expect(summary.text).toContain("Remaining items (1):");
		expect(summary.text).toContain("diagnostics [in_progress] (Execution)");
		const completedResult = await tool.execute("call-3", { ops: [{ op: "done", task: "diagnostics" }] });
		const completedSummary = completedResult.content.find(part => part.type === "text");
		if (completedSummary?.type !== "text") {
			throw new Error("Expected text summary from todo");
		}
		expect(completedSummary.text).toContain("Remaining items: none.");
	});
});

it("renders completed tasks as checked before revealing strikethrough", async () => {
	const tool = new TodoTool(createSession());
	await tool.execute("call-1", {
		ops: [{ op: "init", list: [{ phase: "Execution", items: ["finish"] }] }],
	});
	const result = await tool.execute("call-2", { ops: [{ op: "done", task: "finish" }] });
	const options = { expanded: true, isPartial: false, spinnerFrame: 0 };
	const component = todoToolRenderer.renderResult(result, options, theme);

	const firstFrame = component.render(120).join("\n");
	expect(Bun.stripANSI(firstFrame)).toContain("finish");
	expect(firstFrame).not.toContain("\x1b[9m");

	options.spinnerFrame = TODO_STRIKE_HOLD_FRAMES + 1;
	const revealFrame = component.render(120).join("\n");
	expect(Bun.stripANSI(revealFrame)).toContain("finish");
	expect(revealFrame).toContain("\x1b[9m");
});

describe("TodoTool ops operations", () => {
	it("jumps to a specific task out of order", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Phase A", items: ["first", "second", "third"] }],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "start", task: "third" }] });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
	});

	it("demotes the current in_progress task when starting another", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [
						{ phase: "A", items: ["a1", "a2"] },
						{ phase: "B", items: ["b1"] },
					],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "start", task: "b1" }] });

		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
	});

	it("appends items to an existing phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }],
		});

		const result = await tool.execute("call-2", {
			ops: [
				{
					op: "append",
					phase: "Work",
					items: ["Second"],
				},
			],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => ({ content: task.content, status: task.status }))).toEqual([
			{ content: "First", status: "in_progress" },
			{ content: "Second", status: "pending" },
		]);
	});

	it("creates a phase when append targets a missing phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }],
		});

		const result = await tool.execute("call-2", {
			ops: [
				{
					op: "append",
					phase: "Cleanup",
					items: ["Remove dead code"],
				},
			],
		});

		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Work", "Cleanup"]);
		expect(result.details?.phases[1]?.tasks.map(task => task.content)).toEqual(["Remove dead code"]);
	});

	it("marks all tasks in a phase done", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [
						{ phase: "Work", items: ["First", "Second"] },
						{ phase: "Later", items: ["Third"] },
					],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "done", phase: "Work" }] });
		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["completed", "completed", "in_progress"]);
	});

	it("removes all tasks when rm omits task and phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Work", items: ["First", "Second"] }],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "rm" }] });
		expect(result.details?.phases[0]?.tasks).toEqual([]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Todo list cleared.");
	});

	it("drops all tasks in a phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Work", items: ["First", "Second"] }],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "drop", phase: "Work" }] });
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["abandoned", "abandoned"]);
	});
});

describe("selectStickyTodoWindow", () => {
	const makeTasks = (statuses: TodoStatus[]): TodoItem[] =>
		statuses.map((status, i) => ({ content: `task-${i + 1}`, status }));

	it("returns first 5 of 7 pending tasks with hiddenOpenCount = 2", () => {
		const tasks = makeTasks(["pending", "pending", "pending", "pending", "pending", "pending", "pending"]);
		const { visible, hiddenOpenCount } = selectStickyTodoWindow(tasks, 5);
		expect(visible.map(t => t.content)).toEqual(["task-1", "task-2", "task-3", "task-4", "task-5"]);
		expect(hiddenOpenCount).toBe(2);
	});

	it("slides the window past completed tasks so the next pending fills the top", () => {
		const tasks = makeTasks(["completed", "completed", "completed", "in_progress", "pending", "pending", "pending"]);
		const { visible, hiddenOpenCount } = selectStickyTodoWindow(tasks, 5);
		expect(visible.map(t => t.content)).toEqual(["task-4", "task-5", "task-6", "task-7"]);
		expect(hiddenOpenCount).toBe(0);
	});

	it("slides all the way down to the final two pending tasks", () => {
		const tasks = makeTasks(["completed", "completed", "completed", "completed", "completed", "pending", "pending"]);
		const { visible, hiddenOpenCount } = selectStickyTodoWindow(tasks, 5);
		expect(visible.map(t => t.content)).toEqual(["task-6", "task-7"]);
		expect(hiddenOpenCount).toBe(0);
	});

	it("falls back to the trailing window when every task is closed", () => {
		const tasks = makeTasks([
			"completed",
			"abandoned",
			"completed",
			"completed",
			"abandoned",
			"completed",
			"completed",
		]);
		const { visible, hiddenOpenCount } = selectStickyTodoWindow(tasks, 5);
		expect(visible.map(t => t.content)).toEqual(["task-3", "task-4", "task-5", "task-6", "task-7"]);
		expect(hiddenOpenCount).toBe(0);
	});

	it("returns an empty window for an empty task list", () => {
		const { visible, hiddenOpenCount } = selectStickyTodoWindow([], 5);
		expect(visible).toEqual([]);
		expect(hiddenOpenCount).toBe(0);
	});

	it("honours a custom maxVisible cap", () => {
		const tasks = makeTasks(["pending", "pending", "pending", "pending", "pending", "pending", "pending"]);
		const { visible, hiddenOpenCount } = selectStickyTodoWindow(tasks, 3);
		expect(visible.map(t => t.content)).toEqual(["task-1", "task-2", "task-3"]);
		expect(hiddenOpenCount).toBe(4);
	});
});

describe("todoMatchesAnyDescription", () => {
	it("matches identical strings", () => {
		expect(todoMatchesAnyDescription("Sonnet #1: AGENTS audit", ["Sonnet #1: AGENTS audit"])).toBe(true);
	});

	it("matches case- and whitespace-insensitively", () => {
		expect(todoMatchesAnyDescription("  Sonnet  #1: AGENTS Audit  ", ["sonnet #1: agents audit"])).toBe(true);
	});

	it("matches when description is a long-enough substring of the todo", () => {
		expect(todoMatchesAnyDescription("Sonnet #2: shallow bug scan of diff", ["Sonnet #2"])).toBe(true);
	});

	it("matches when the todo is a long-enough substring of a description", () => {
		expect(todoMatchesAnyDescription("Sonnet #3", ["Sonnet #3: git blame / history check"])).toBe(true);
	});

	it("rejects substring matches below the minimum overlap", () => {
		// "Fix" is 3 chars — too short to qualify on either side.
		expect(todoMatchesAnyDescription("Fix", ["Fix the auth module bug"])).toBe(false);
		expect(todoMatchesAnyDescription("Fix the auth module bug", ["Fix"])).toBe(false);
	});

	it("ignores empty inputs without throwing", () => {
		expect(todoMatchesAnyDescription("", ["Sonnet #1"])).toBe(false);
		expect(todoMatchesAnyDescription("Sonnet #1", [""])).toBe(false);
		expect(todoMatchesAnyDescription("Sonnet #1", [])).toBe(false);
	});

	it("returns true on the first match without scanning further descriptions", () => {
		expect(
			todoMatchesAnyDescription("Sonnet #2: shallow bug scan", ["unrelated agent task", "Sonnet #2", "Sonnet #3"]),
		).toBe(true);
	});

	it("returns false when no description overlaps the todo", () => {
		expect(todoMatchesAnyDescription("Sonnet #2: shallow bug scan", ["Reviewer1AgentsAdherence", "git blame"])).toBe(
			false,
		);
	});

	it("ignores punctuation differences in identifiers", () => {
		// One side has a method-prefix '#', the other doesn't. Reproduced
		// from a real run where 3 subagents were spawned but only 2 of 3
		// matched todos lit up because the matcher's normalizer collapsed
		// whitespace but left punctuation intact.
		expect(
			todoMatchesAnyDescription("Audit integration site in renderTodoList", [
				"Audit integration site in #renderTodoList",
			]),
		).toBe(true);
		// Dotted abbreviations like AGENTS.md collapse to a space too.
		expect(todoMatchesAnyDescription("Audit AGENTS.md compliance", ["Audit AGENTS md compliance"])).toBe(true);
	});
});
