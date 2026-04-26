import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type TodoPhase, TodoWriteTool } from "@oh-my-pi/pi-coding-agent/tools";

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

describe("TodoWriteTool auto-start behavior", () => {
	it("auto-starts the first task after replace", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", [
			{
				op: "replace",
				phases: [
					{
						name: "Execution",
						tasks: [{ content: "status" }, { content: "diagnostics" }],
					},
				],
			},
		]);

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
		const summary = result.content.find(part => part.type === "text");
		if (!summary || summary.type !== "text") throw new Error("Expected text summary from todo_write");
		expect(summary.text).toContain("Remaining items (2):");
		expect(summary.text).toContain("task-1 status [in_progress] (Execution)");
		expect(summary.text).toContain("task-2 diagnostics [pending] (Execution)");
	});

	it("auto-promotes the next pending task when current task is completed", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", [
			{
				op: "replace",
				phases: [
					{
						name: "Execution",
						tasks: [{ content: "status" }, { content: "diagnostics" }],
					},
				],
			},
		]);

		const result = await tool.execute("call-2", [{ op: "done", task: "task-1" }]);

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
		const summary = result.content.find(part => part.type === "text");
		if (!summary || summary.type !== "text") throw new Error("Expected text summary from todo_write");
		expect(summary.text).toContain("Remaining items (1):");
		expect(summary.text).toContain("task-2 diagnostics [in_progress] (Execution)");

		const completedResult = await tool.execute("call-3", [{ op: "done", task: "task-2" }]);
		const completedSummary = completedResult.content.find(part => part.type === "text");
		if (!completedSummary || completedSummary.type !== "text") {
			throw new Error("Expected text summary from todo_write");
		}
		expect(completedSummary.text).toContain("Remaining items: none.");
	});

	it("keeps only one in_progress task when replace input contains multiples", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", [
			{
				op: "replace",
				phases: [
					{
						name: "Execution",
						tasks: [
							{ content: "status", status: "in_progress" },
							{ content: "diagnostics", status: "in_progress" },
						],
					},
				],
			},
		]);

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
	});
});

describe("TodoWriteTool array operations", () => {
	it("jumps to a specific task out of order", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", [
			{
				op: "replace",
				phases: [
					{
						name: "Phase A",
						tasks: [{ content: "first" }, { content: "second" }, { content: "third" }],
					},
				],
			},
		]);

		const result = await tool.execute("call-2", [{ op: "start", task: "task-3" }]);

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
	});

	it("demotes the current in_progress task when starting another", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", [
			{
				op: "replace",
				phases: [
					{ name: "A", tasks: [{ content: "a1" }, { content: "a2" }] },
					{ name: "B", tasks: [{ content: "b1" }] },
				],
			},
		]);

		const result = await tool.execute("call-2", [{ op: "start", task: "task-3" }]);

		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
	});

	it("appends items to an existing phase", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", [{ op: "replace", phases: [{ name: "Work", tasks: [{ content: "First" }] }] }]);

		const result = await tool.execute("call-2", [
			{
				op: "append",
				phase: "phase-1",
				items: [{ id: "task-9", label: "Second" }],
			},
		]);

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => ({ id: task.id, content: task.content, status: task.status }))).toEqual([
			{ id: "task-1", content: "First", status: "in_progress" },
			{ id: "task-9", content: "Second", status: "pending" },
		]);
	});

	it("creates a phase when append targets a missing phase", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", [{ op: "replace", phases: [{ name: "Work", tasks: [{ content: "First" }] }] }]);

		const result = await tool.execute("call-2", [
			{
				op: "append",
				phase: "Cleanup",
				items: [{ id: "task-10", label: "Remove dead code" }],
			},
		]);

		expect(result.details?.phases.map(phase => ({ id: phase.id, name: phase.name }))).toEqual([
			{ id: "phase-1", name: "Work" },
			{ id: "Cleanup", name: "Cleanup" },
		]);
		expect(result.details?.phases[1]?.tasks.map(task => task.id)).toEqual(["task-10"]);
	});

	it("marks all tasks in a phase done", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", [
			{
				op: "replace",
				phases: [
					{ name: "Work", tasks: [{ content: "First" }, { content: "Second" }] },
					{ name: "Later", tasks: [{ content: "Third" }] },
				],
			},
		]);

		const result = await tool.execute("call-2", [{ op: "done", phase: "phase-1" }]);
		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["completed", "completed", "in_progress"]);
	});

	it("removes all tasks when rm omits task and phase", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", [
			{
				op: "replace",
				phases: [{ name: "Work", tasks: [{ content: "First" }, { content: "Second" }] }],
			},
		]);

		const result = await tool.execute("call-2", [{ op: "rm" }]);
		expect(result.details?.phases[0]?.tasks).toEqual([]);
		const summary = result.content.find(part => part.type === "text");
		if (!summary || summary.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Todo list cleared.");
	});

	it("drops all tasks in a phase", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", [
			{
				op: "replace",
				phases: [{ name: "Work", tasks: [{ content: "First" }, { content: "Second" }] }],
			},
		]);

		const result = await tool.execute("call-2", [{ op: "drop", phase: "phase-1" }]);
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["abandoned", "abandoned"]);
	});
});
