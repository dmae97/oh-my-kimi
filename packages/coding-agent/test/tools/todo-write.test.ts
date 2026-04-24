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
		const result = await tool.execute("call-1", {
			phases: [
				{
					name: "Execution",
					tasks: [{ content: "status" }, { content: "diagnostics" }],
				},
			],
		});

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
		await tool.execute("call-1", {
			phases: [
				{
					name: "Execution",
					tasks: [{ content: "status" }, { content: "diagnostics" }],
				},
			],
		});

		const result = await tool.execute("call-2", {
			complete: ["task-1"],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
		const summary = result.content.find(part => part.type === "text");
		if (!summary || summary.type !== "text") throw new Error("Expected text summary from todo_write");
		expect(summary.text).toContain("Remaining items (1):");
		expect(summary.text).toContain("task-2 diagnostics [in_progress] (Execution)");

		const completedResult = await tool.execute("call-3", {
			complete: ["task-2"],
		});
		const completedSummary = completedResult.content.find(part => part.type === "text");
		if (!completedSummary || completedSummary.type !== "text") {
			throw new Error("Expected text summary from todo_write");
		}
		expect(completedSummary.text).toContain("Remaining items: none.");
	});

	it("keeps only one in_progress task when replace input contains multiples", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			phases: [
				{
					name: "Execution",
					tasks: [
						{ content: "status", status: "in_progress" },
						{ content: "diagnostics", status: "in_progress" },
					],
				},
			],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
	});
});

describe("TodoWriteTool start behavior", () => {
	it("jumps to a specific task out of order", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			phases: [
				{
					name: "Phase A",
					tasks: [{ content: "first" }, { content: "second" }, { content: "third" }],
				},
			],
		});

		const result = await tool.execute("call-2", {
			start: "task-3",
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
	});

	it("demotes the current in_progress task when starting another", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			phases: [
				{ name: "A", tasks: [{ content: "a1" }, { content: "a2" }] },
				{ name: "B", tasks: [{ content: "b1" }] },
			],
		});

		// task-1 is auto-promoted; now jump to task-3 in phase B
		const result = await tool.execute("call-2", {
			start: "task-3",
		});

		const allTasks = result.details?.phases.flatMap(p => p.tasks) ?? [];
		expect(allTasks.map(t => t.status)).toEqual(["pending", "pending", "in_progress"]);
	});
});

describe("TodoWriteTool details field", () => {
	it("preserves details through replace", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			phases: [
				{
					name: "Work",
					tasks: [{ content: "Fix parser", details: "Update src/parser.ts line 42" }, { content: "Add tests" }],
				},
			],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks[0].details).toBe("Update src/parser.ts line 42");
		expect(tasks[1].details).toBeUndefined();
	});

	it("preserves details through add_tasks", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			phases: [{ name: "Work", tasks: [{ content: "First" }] }],
		});

		const result = await tool.execute("call-2", {
			add_tasks: [{ phase: "phase-1", content: "Second", details: "Check edge cases" }],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks[1].details).toBe("Check edge cases");
	});

	it("appends notes via add_notes", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			phases: [{ name: "Work", tasks: [{ content: "Fix bug", details: "Old details" }] }],
		});

		const result = await tool.execute("call-2", {
			add_notes: [{ id: "task-1", notes: "New observation" }],
		});

		const task = result.details?.phases[0]?.tasks[0];
		expect(task?.notes).toBe("New observation");
	});

	it("includes notes in summary output", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			phases: [
				{
					name: "Work",
					tasks: [{ content: "Fix bug" }, { content: "Add tests" }],
				},
			],
		});

		const result = await tool.execute("call-2", {
			add_notes: [{ id: "task-1", notes: "Found edge case in parser" }],
		});

		const summary = result.content.find(part => part.type === "text");
		if (!summary || summary.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Note: Found edge case in parser");
	});

	it("includes details in summary for in_progress tasks", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			phases: [
				{
					name: "Work",
					tasks: [{ content: "Fix parser", details: "Edit src/parser.ts" }],
				},
			],
		});

		const summary = result.content.find(part => part.type === "text");
		if (!summary || summary.type !== "text") throw new Error("Expected text summary");
		// Task is auto-promoted to in_progress, so details should appear in summary
		expect(summary.text).toContain("Edit src/parser.ts");
	});
});
