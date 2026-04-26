import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import chalk from "chalk";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import todoWriteDescription from "../prompts/tools/todo-write.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import type { SessionEntry } from "../session/session-manager";
import { renderStatusLine, renderTreeList } from "../tui";
import { PREVIEW_LIMITS } from "./render-utils";

// =============================================================================
// Types
// =============================================================================

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoItem {
	id: string;
	content: string;
	status: TodoStatus;
	notes?: string;
	details?: string;
}

export interface TodoPhase {
	id: string;
	name: string;
	tasks: TodoItem[];
}

export interface TodoWriteToolDetails {
	phases: TodoPhase[];
	storage: "session" | "memory";
}

// =============================================================================
// Schema
// =============================================================================

const InputTask = Type.Object({
	content: Type.String({ description: "task description", examples: ["Add unit tests"] }),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "abandoned"] as const, {
			description: "task status",
		}),
	),
	details: Type.Optional(Type.String({ description: "implementation details" })),
});

const InputPhase = Type.Object({
	name: Type.String({ description: "phase name", examples: ["Investigation", "Implementation"] }),
	tasks: Type.Optional(Type.Array(InputTask)),
});

const AddNoteEntry = Type.Object({
	id: Type.String({ description: "task id", examples: ["task-3"] }),
	notes: Type.String({ description: "notes to append" }),
});

const AddTaskEntry = Type.Object({
	phase: Type.String({ description: "phase name or id", examples: ["Investigation", "phase-1"] }),
	content: Type.String({ description: "task description", examples: ["Add unit tests"] }),
	details: Type.Optional(Type.String({ description: "implementation details" })),
});

const todoWriteSchema = Type.Object({
	phases: Type.Optional(Type.Array(InputPhase, { description: "replace todo list" })),
	start: Type.Optional(Type.String({ description: "task id to start", examples: ["task-3"] })),
	complete: Type.Optional(Type.Array(Type.String(), { description: "task ids to complete" })),
	abandon: Type.Optional(Type.Array(Type.String(), { description: "task ids to abandon" })),
	remove: Type.Optional(Type.Array(Type.String(), { description: "task ids to remove" })),
	add_notes: Type.Optional(Type.Array(AddNoteEntry, { description: "notes to append" })),
	add_tasks: Type.Optional(Type.Array(AddTaskEntry, { description: "tasks to add" })),
	add_phase: Type.Optional(InputPhase),
});

type TodoWriteParams = Static<typeof todoWriteSchema>;

// =============================================================================
// File format
// =============================================================================

interface TodoFile {
	phases: TodoPhase[];
	nextTaskId: number;
	nextPhaseId: number;
}

// =============================================================================
// State helpers
// =============================================================================

function makeEmptyFile(): TodoFile {
	return { phases: [], nextTaskId: 1, nextPhaseId: 1 };
}

function findTask(phases: TodoPhase[], id: string): TodoItem | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find(t => t.id === id);
		if (task) return task;
	}
	return undefined;
}

function buildPhaseFromInput(
	input: { name: string; tasks?: Array<{ content: string; status?: TodoStatus; details?: string }> },
	phaseId: string,
	nextTaskId: number,
): { phase: TodoPhase; nextTaskId: number } {
	const tasks: TodoItem[] = [];
	let tid = nextTaskId;
	for (const t of input.tasks ?? []) {
		tasks.push({
			id: `task-${tid++}`,
			content: t.content,
			status: t.status ?? "pending",
			details: t.details,
		});
	}
	return { phase: { id: phaseId, name: input.name, tasks }, nextTaskId: tid };
}

function getNextIds(phases: TodoPhase[]): { nextTaskId: number; nextPhaseId: number } {
	let maxTaskId = 0;
	let maxPhaseId = 0;

	for (const phase of phases) {
		const phaseMatch = /^phase-(\d+)$/.exec(phase.id);
		if (phaseMatch) {
			const value = Number.parseInt(phaseMatch[1], 10);
			if (Number.isFinite(value) && value > maxPhaseId) maxPhaseId = value;
		}

		for (const task of phase.tasks) {
			const taskMatch = /^task-(\d+)$/.exec(task.id);
			if (!taskMatch) continue;
			const value = Number.parseInt(taskMatch[1], 10);
			if (Number.isFinite(value) && value > maxTaskId) maxTaskId = value;
		}
	}

	return { nextTaskId: maxTaskId + 1, nextPhaseId: maxPhaseId + 1 };
}

function fileFromPhases(phases: TodoPhase[]): TodoFile {
	const { nextTaskId, nextPhaseId } = getNextIds(phases);
	return { phases, nextTaskId, nextPhaseId };
}

function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task => ({ ...task })) }));
}

function normalizeInProgressTask(phases: TodoPhase[]): void {
	const orderedTasks = phases.flatMap(phase => phase.tasks);
	if (orderedTasks.length === 0) return;

	const inProgressTasks = orderedTasks.filter(task => task.status === "in_progress");
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressTasks.length > 0) return;

	const firstPendingTask = orderedTasks.find(task => task.status === "pending");
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		const message = entry.message as { role?: string; toolName?: string; details?: unknown; isError?: boolean };
		if (message.role !== "toolResult" || message.toolName !== "todo_write" || message.isError) continue;

		const details = message.details as { phases?: unknown } | undefined;
		if (!details || !Array.isArray(details.phases)) continue;

		return clonePhases(details.phases as TodoPhase[]);
	}

	return [];
}

function resolveTaskOrError(phases: TodoPhase[], id: string, errors: string[]): TodoItem | undefined {
	const task = findTask(phases, id);
	if (!task) {
		const totalTasks = phases.reduce((sum, p) => sum + p.tasks.length, 0);
		const hint = totalTasks === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
		errors.push(`Task "${id}" not found${hint}`);
	}
	return task;
}

function applyParams(file: TodoFile, params: TodoWriteParams): { file: TodoFile; errors: string[] } {
	const errors: string[] = [];

	// Replace (must be first — replaces entire state)
	if (params.phases) {
		const next = makeEmptyFile();
		for (const inputPhase of params.phases) {
			const phaseId = `phase-${next.nextPhaseId++}`;
			const { phase, nextTaskId } = buildPhaseFromInput(inputPhase, phaseId, next.nextTaskId);
			next.phases.push(phase);
			next.nextTaskId = nextTaskId;
		}
		file = next;
	}

	if (params.add_phase) {
		const phaseId = `phase-${file.nextPhaseId++}`;
		const { phase, nextTaskId } = buildPhaseFromInput(params.add_phase, phaseId, file.nextTaskId);
		file.phases.push(phase);
		file.nextTaskId = nextTaskId;
	}

	if (params.add_tasks) {
		for (const entry of params.add_tasks) {
			const target = file.phases.find(p => p.id === entry.phase || p.name === entry.phase);
			if (!target) {
				errors.push(`Phase "${entry.phase}" not found`);
				continue;
			}
			target.tasks.push({
				id: `task-${file.nextTaskId++}`,
				content: entry.content,
				status: "pending",
				details: entry.details,
			});
		}
	}

	if (params.complete) {
		for (const id of params.complete) {
			const task = resolveTaskOrError(file.phases, id, errors);
			if (task) task.status = "completed";
		}
	}

	if (params.abandon) {
		for (const id of params.abandon) {
			const task = resolveTaskOrError(file.phases, id, errors);
			if (task) task.status = "abandoned";
		}
	}

	if (params.remove) {
		for (const id of params.remove) {
			let removed = false;
			for (const phase of file.phases) {
				const idx = phase.tasks.findIndex(t => t.id === id);
				if (idx !== -1) {
					phase.tasks.splice(idx, 1);
					removed = true;
					break;
				}
			}
			if (!removed) {
				const totalTasks = file.phases.reduce((sum, p) => sum + p.tasks.length, 0);
				const hint = totalTasks === 0 ? " (todo list is empty)" : "";
				errors.push(`Task "${id}" not found${hint}`);
			}
		}
	}

	if (params.add_notes) {
		for (const entry of params.add_notes) {
			const task = resolveTaskOrError(file.phases, entry.id, errors);
			if (task) {
				task.notes = task.notes ? `${task.notes}\n${entry.notes}` : entry.notes;
			}
		}
	}

	if (params.start) {
		const task = resolveTaskOrError(file.phases, params.start, errors);
		if (task) {
			// Demote any currently in_progress tasks before promoting the target
			for (const phase of file.phases) {
				for (const t of phase.tasks) {
					if (t.status === "in_progress" && t.id !== task.id) {
						t.status = "pending";
					}
				}
			}
			task.status = "in_progress";
		}
	}

	normalizeInProgressTask(file.phases);
	return { file, errors };
}

function formatSummary(phases: TodoPhase[], errors: string[]): string {
	const tasks = phases.flatMap(p => p.tasks);
	if (tasks.length === 0) return errors.length > 0 ? `Errors: ${errors.join("; ")}` : "Todo list cleared.";

	const remainingByPhase = phases
		.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.filter(task => task.status === "pending" || task.status === "in_progress"),
		}))
		.filter(phase => phase.tasks.length > 0);
	const remainingTasks = remainingByPhase.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name })));

	// Find current phase
	let currentIdx = phases.findIndex(p => p.tasks.some(t => t.status === "pending" || t.status === "in_progress"));
	if (currentIdx === -1) currentIdx = phases.length - 1;
	const current = phases[currentIdx];
	const done = current.tasks.filter(t => t.status === "completed" || t.status === "abandoned").length;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remainingTasks.length}):`);
		for (const task of remainingTasks) {
			lines.push(`  - ${task.id} ${task.content} [${task.status}] (${task.phase})`);
			if (task.status === "in_progress" && task.details) {
				for (const line of task.details.split("\n")) {
					lines.push(`      ${line}`);
				}
			}
			if (task.notes) {
				for (const line of task.notes.split("\n")) {
					lines.push(`      Note: ${line}`);
				}
			}
		}
	}
	lines.push(
		`Phase ${currentIdx + 1}/${phases.length} "${current.name}" — ${done}/${current.tasks.length} tasks complete`,
	);
	for (const phase of phases) {
		lines.push(`  ${phase.name}:`);
		for (const task of phase.tasks) {
			const sym =
				task.status === "completed"
					? "✓"
					: task.status === "in_progress"
						? "→"
						: task.status === "abandoned"
							? "✗"
							: "○";
			lines.push(`    ${sym} ${task.id} ${task.content}`);
		}
	}
	return lines.join("\n");
}

// =============================================================================
// Tool Class
// =============================================================================

export class TodoWriteTool implements AgentTool<typeof todoWriteSchema, TodoWriteToolDetails> {
	readonly name = "todo_write";
	readonly label = "Todo Write";
	readonly description: string;
	readonly parameters = todoWriteSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(todoWriteDescription);
	}

	async execute(
		_toolCallId: string,
		params: TodoWriteParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoWriteToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoWriteToolDetails>> {
		const previousPhases = this.session.getTodoPhases?.() ?? [];
		const current = fileFromPhases(previousPhases);
		const { file: updated, errors } = applyParams(current, params);
		this.session.setTodoPhases?.(updated.phases);
		const storage = this.session.getSessionFile() ? "session" : "memory";

		return {
			content: [{ type: "text", text: formatSummary(updated.phases, errors) }],
			details: { phases: updated.phases, storage },
		};
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface TodoWriteRenderArgs {
	phases?: unknown;
	start?: string;
	complete?: string[];
	abandon?: string[];
	remove?: string[];
	add_notes?: unknown[];
	add_tasks?: unknown[];
	add_phase?: unknown;
}

function formatTodoLine(item: TodoItem, uiTheme: Theme, prefix: string): string {
	const checkbox = uiTheme.checkbox;
	switch (item.status) {
		case "completed":
			return uiTheme.fg("success", `${prefix}${checkbox.checked} ${chalk.strikethrough(item.content)}`);
		case "in_progress": {
			const main = uiTheme.fg("accent", `${prefix}${checkbox.unchecked} ${item.content}`);
			if (!item.details) return main;
			const detailLines = item.details.split("\n").map(l => uiTheme.fg("dim", `${prefix}  ${l}`));
			return [main, ...detailLines].join("\n");
		}
		case "abandoned":
			return uiTheme.fg("error", `${prefix}${checkbox.unchecked} ${chalk.strikethrough(item.content)}`);
		default:
			return uiTheme.fg("dim", `${prefix}${checkbox.unchecked} ${item.content}`);
	}
}

export const todoWriteToolRenderer = {
	renderCall(args: TodoWriteRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const ops: string[] = [];
		if (args.phases) ops.push("replace");
		if (args.complete?.length) ops.push(`complete ${args.complete.length}`);
		if (args.start) ops.push("start");
		if (args.abandon?.length) ops.push("abandon");
		if (args.remove?.length) ops.push("remove");
		if (args.add_notes?.length) ops.push("add_notes");
		if (args.add_tasks?.length) ops.push("add_tasks");
		if (args.add_phase) ops.push("add_phase");
		const label = ops.length > 0 ? ops.join(", ") : "update";
		const text = renderStatusLine({ icon: "pending", title: "Todo Write", meta: [label] }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TodoWriteToolDetails },
		options: RenderResultOptions,
		uiTheme: Theme,
		_args?: TodoWriteRenderArgs,
	): Component {
		const phases = (result.details?.phases ?? []).filter(p => p.tasks.length > 0);
		const allTasks = phases.flatMap(p => p.tasks);
		const header = renderStatusLine(
			{ icon: "success", title: "Todo Write", meta: [`${allTasks.length} tasks`] },
			uiTheme,
		);
		if (allTasks.length === 0) {
			const fallback = result.content?.find(c => c.type === "text")?.text ?? "No todos";
			return new Text(`${header}\n${uiTheme.fg("dim", fallback)}`, 0, 0);
		}

		const { expanded } = options;
		const lines: string[] = [header];
		for (const phase of phases) {
			if (phases.length > 1) {
				lines.push(uiTheme.fg("accent", `  ${uiTheme.tree.hook} ${phase.name}`));
			}
			const treeLines = renderTreeList(
				{
					items: phase.tasks,
					expanded,
					maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
					itemType: "todo",
					renderItem: todo => formatTodoLine(todo, uiTheme, ""),
				},
				uiTheme,
			);
			lines.push(...treeLines);
		}
		return new Text(lines.join("\n"), 0, 0);
	},
	mergeCallAndResult: true,
};
