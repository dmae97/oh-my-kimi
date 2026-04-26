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
	/**
	 * Append-only list of freeform notes attached by `op: "note"`.
	 * Each element is one note and may itself be multi-line.
	 * Rendered as text only when the task is in_progress; otherwise shown as a
	 * dim marker indicating the task has notes.
	 */
	notes?: string[];
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

const TodoOp = StringEnum(["replace", "start", "done", "rm", "drop", "append", "note"] as const, {
	description: "operation to apply",
});

const InputTask = Type.Object({
	content: Type.String({ description: "task description", examples: ["Add unit tests"] }),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "abandoned"] as const, {
			description: "task status",
		}),
	),
});

const InputPhase = Type.Object({
	name: Type.String({ description: "phase name", examples: ["I. Foundation", "II. Auth", "III. Verification"] }),
	tasks: Type.Optional(Type.Array(InputTask)),
});

const AppendItem = Type.Object({
	id: Type.String({ description: "task id", examples: ["task-3"] }),
	label: Type.String({ description: "task label", examples: ["Run tests"] }),
});

const TodoOpEntry = Type.Object({
	op: TodoOp,
	phases: Type.Optional(Type.Array(InputPhase, { description: "replacement todo list for op=replace" })),
	task: Type.Optional(Type.String({ description: "task id for start/done/rm/drop", examples: ["task-3"] })),
	phase: Type.Optional(
		Type.String({ description: "phase id for done/rm/drop/append", examples: ["Implementation", "phase-1"] }),
	),
	items: Type.Optional(Type.Array(AppendItem, { minItems: 1, description: "items to append for op=append" })),
	text: Type.Optional(Type.String({ description: "note text for op=note (appended with newline)" })),
});

const todoWriteSchema = Type.Object(
	{
		ops: Type.Array(TodoOpEntry, {
			minItems: 1,
			description: "ordered todo operations",
		}),
	},
	{ description: "Apply ordered todo operations" },
);

type TodoWriteParams = Static<typeof todoWriteSchema>;
type TodoOpEntryValue = TodoWriteParams["ops"][number];

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

function findPhase(phases: TodoPhase[], idOrName: string): TodoPhase | undefined {
	return phases.find(phase => phase.id === idOrName || phase.name === idOrName);
}

function buildPhaseFromInput(
	input: { name: string; tasks?: Array<{ content: string; status?: TodoStatus }> },
	phaseId: string,
	nextTaskId: number,
): { phase: TodoPhase; nextTaskId: number } {
	const tasks: TodoItem[] = [];
	let tid = nextTaskId;
	for (const task of input.tasks ?? []) {
		tasks.push({
			id: `task-${tid++}`,
			content: task.content,
			status: task.status ?? "pending",
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

function cloneTask(task: TodoItem): TodoItem {
	const out: TodoItem = { id: task.id, content: task.content, status: task.status };
	if (task.notes && task.notes.length > 0) out.notes = [...task.notes];
	return out;
}

function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({ ...phase, tasks: phase.tasks.map(cloneTask) }));
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

export const USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit";

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
			const data = entry.data as { phases?: unknown } | undefined;
			if (data && Array.isArray(data.phases)) {
				return clonePhases(data.phases as TodoPhase[]);
			}
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; toolName?: string; details?: unknown; isError?: boolean };
		if (message.role !== "toolResult" || message.toolName !== "todo_write" || message.isError) continue;

		const details = message.details as { phases?: unknown } | undefined;
		if (!details || !Array.isArray(details.phases)) continue;

		return clonePhases(details.phases as TodoPhase[]);
	}

	return [];
}

function resolveTaskOrError(phases: TodoPhase[], id: string | undefined, errors: string[]): TodoItem | undefined {
	if (!id) {
		errors.push("Missing task id");
		return undefined;
	}
	const task = findTask(phases, id);
	if (!task) {
		const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
		const hint = totalTasks === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
		errors.push(`Task "${id}" not found${hint}`);
	}
	return task;
}

function resolvePhaseOrError(
	phases: TodoPhase[],
	idOrName: string | undefined,
	errors: string[],
): TodoPhase | undefined {
	if (!idOrName) {
		errors.push("Missing phase id");
		return undefined;
	}
	const phase = findPhase(phases, idOrName);
	if (!phase) errors.push(`Phase "${idOrName}" not found`);
	return phase;
}

function getTaskTargets(file: TodoFile, entry: TodoOpEntryValue, errors: string[]): TodoItem[] {
	if (entry.task) {
		const task = resolveTaskOrError(file.phases, entry.task, errors);
		return task ? [task] : [];
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(file.phases, entry.phase, errors);
		return phase ? [...phase.tasks] : [];
	}
	return file.phases.flatMap(phase => phase.tasks);
}

function replaceFile(entry: TodoOpEntryValue, errors: string[]): TodoFile {
	const next = makeEmptyFile();
	for (const inputPhase of entry.phases ?? []) {
		const phaseId = `phase-${next.nextPhaseId++}`;
		const { phase, nextTaskId } = buildPhaseFromInput(inputPhase, phaseId, next.nextTaskId);
		next.phases.push(phase);
		next.nextTaskId = nextTaskId;
	}
	if (!entry.phases) errors.push("Missing phases for replace operation");
	return next;
}

function appendItems(file: TodoFile, entry: TodoOpEntryValue, errors: string[]): void {
	if (!entry.phase) {
		errors.push("Missing phase id for append operation");
		return;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return;
	}

	let phase = findPhase(file.phases, entry.phase);
	if (!phase) {
		phase = { id: entry.phase, name: entry.phase, tasks: [] };
		file.phases.push(phase);
	}

	for (const item of entry.items) {
		if (findTask(file.phases, item.id)) {
			errors.push(`Task "${item.id}" already exists`);
			continue;
		}
		phase.tasks.push({ id: item.id, content: item.label, status: "pending" });
	}
}

function removeTasks(file: TodoFile, entry: TodoOpEntryValue, errors: string[]): void {
	if (entry.task) {
		const task = resolveTaskOrError(file.phases, entry.task, errors);
		if (!task) return;
		for (const phase of file.phases) {
			phase.tasks = phase.tasks.filter(candidate => candidate.id !== task.id);
		}
		return;
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(file.phases, entry.phase, errors);
		if (!phase) return;
		phase.tasks = [];
		return;
	}
	for (const phase of file.phases) {
		phase.tasks = [];
	}
}

function applyEntry(file: TodoFile, entry: TodoOpEntryValue, errors: string[]): TodoFile {
	switch (entry.op) {
		case "replace":
			return replaceFile(entry, errors);
		case "start": {
			const task = resolveTaskOrError(file.phases, entry.task, errors);
			if (!task) return file;
			for (const phase of file.phases) {
				for (const candidate of phase.tasks) {
					if (candidate.status === "in_progress" && candidate.id !== task.id) {
						candidate.status = "pending";
					}
				}
			}
			task.status = "in_progress";
			return file;
		}
		case "done": {
			for (const task of getTaskTargets(file, entry, errors)) {
				task.status = "completed";
			}
			return file;
		}
		case "drop": {
			for (const task of getTaskTargets(file, entry, errors)) {
				task.status = "abandoned";
			}
			return file;
		}
		case "rm": {
			removeTasks(file, entry, errors);
			return file;
		}
		case "note": {
			const task = resolveTaskOrError(file.phases, entry.task, errors);
			if (!task) return file;
			const text = (entry.text ?? "").replace(/\s+$/u, "");
			if (!text) {
				errors.push("Missing text for note operation");
				return file;
			}
			task.notes = task.notes ? [...task.notes, text] : [text];
			return file;
		}
		case "append": {
			appendItems(file, entry, errors);
			return file;
		}
	}
}

function applyParams(file: TodoFile, params: TodoWriteParams): { file: TodoFile; errors: string[] } {
	const errors: string[] = [];
	for (const entry of params.ops) {
		file = applyEntry(file, entry, errors);
	}
	normalizeInProgressTask(file.phases);
	return { file, errors };
}
/** Apply an array of `todo_write`-style ops to existing phases. Used by /todo slash command. */
export function applyOpsToPhases(
	currentPhases: TodoPhase[],
	ops: TodoWriteParams["ops"],
): { phases: TodoPhase[]; errors: string[] } {
	const startFile = fileFromPhases(currentPhases);
	const { file, errors } = applyParams(startFile, { ops });
	return { phases: file.phases, errors };
}

// =============================================================================
// Markdown round-trip
// =============================================================================

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
	pending: " ",
	in_progress: "/",
	completed: "x",
	abandoned: "-",
};

/** Render todo phases as a Markdown checklist suitable for editing/copying. */
export function phasesToMarkdown(phases: TodoPhase[]): string {
	if (phases.length === 0) return "# I. Todos\n";
	const out: string[] = [];
	for (let i = 0; i < phases.length; i++) {
		if (i > 0) out.push("");
		out.push(`# ${phases[i].name}`);
		for (const task of phases[i].tasks) {
			out.push(`- [${STATUS_TO_MARKER[task.status]}] ${task.content}`);
			if (task.notes && task.notes.length > 0) {
				for (let j = 0; j < task.notes.length; j++) {
					if (j > 0) out.push("  >");
					for (const noteLine of task.notes[j].split("\n")) {
						out.push(noteLine === "" ? "  >" : `  > ${noteLine}`);
					}
				}
			}
		}
	}
	return `${out.join("\n")}\n`;
}

const MARKER_TO_STATUS: Record<string, TodoStatus> = {
	" ": "pending",
	"": "pending",
	x: "completed",
	X: "completed",
	"/": "in_progress",
	">": "in_progress",
	"-": "abandoned",
	"~": "abandoned",
};

/**
 * Parse a Markdown checklist back into todo phases. Task and phase ids are
 * regenerated; the agent observes the new ids in the system reminder.
 */
export function markdownToPhases(md: string): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const phases: TodoPhase[] = [];
	let currentPhase: TodoPhase | undefined;
	let currentTask: TodoItem | undefined;
	let noteBuf: string[] = [];
	let nextPhaseId = 1;
	let nextTaskId = 1;

	const flushNote = () => {
		if (!currentTask || noteBuf.length === 0) {
			noteBuf = [];
			return;
		}
		while (noteBuf.length > 0 && noteBuf[noteBuf.length - 1] === "") noteBuf.pop();
		if (noteBuf.length === 0) return;
		const joined = noteBuf.join("\n");
		currentTask.notes = currentTask.notes ? [...currentTask.notes, joined] : [joined];
		noteBuf = [];
	};

	const lines = md.split(/\r?\n/);
	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const raw = lines[lineNum];

		// Blockquote line attached to the current task: `  > text` or `  >`
		const noteMatch = /^\s*>\s?(.*)$/.exec(raw);
		if (noteMatch && currentTask) {
			const noteLine = noteMatch[1];
			if (noteLine === "") {
				// Blank `>` separates two distinct notes
				flushNote();
			} else {
				noteBuf.push(noteLine);
			}
			continue;
		}

		const trimmed = raw.trim();
		if (!trimmed) continue;

		const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
		if (headingMatch) {
			flushNote();
			currentTask = undefined;
			currentPhase = { id: `phase-${nextPhaseId++}`, name: headingMatch[1].trim(), tasks: [] };
			phases.push(currentPhase);
			continue;
		}

		const taskMatch = /^[-*+]\s*\[(.?)\]\s+(.+?)\s*$/.exec(trimmed);
		if (taskMatch) {
			flushNote();
			if (!currentPhase) {
				currentPhase = { id: `phase-${nextPhaseId++}`, name: "I. Todos", tasks: [] };
				phases.push(currentPhase);
			}
			const marker = taskMatch[1];
			const status = MARKER_TO_STATUS[marker];
			if (!status) {
				errors.push(`Line ${lineNum + 1}: unknown status marker "[${marker}]" (use [ ], [x], [/], [-])`);
				currentTask = undefined;
				continue;
			}
			currentTask = { id: `task-${nextTaskId++}`, content: taskMatch[2].trim(), status };
			currentPhase.tasks.push(currentTask);
			continue;
		}

		flushNote();
		currentTask = undefined;
		errors.push(`Line ${lineNum + 1}: unrecognized syntax "${trimmed}"`);
	}
	flushNote();

	normalizeInProgressTask(phases);
	return { phases, errors };
}

function formatSummary(phases: TodoPhase[], errors: string[]): string {
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) return errors.length > 0 ? `Errors: ${errors.join("; ")}` : "Todo list cleared.";

	const remainingByPhase = phases
		.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.filter(task => task.status === "pending" || task.status === "in_progress"),
		}))
		.filter(phase => phase.tasks.length > 0);
	const remainingTasks = remainingByPhase.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name })));

	let currentIdx = phases.findIndex(phase =>
		phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
	);
	if (currentIdx === -1) currentIdx = phases.length - 1;
	const current = phases[currentIdx];
	const done = current.tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remainingTasks.length}):`);
		for (const task of remainingTasks) {
			lines.push(`  - ${task.id} ${task.content} [${task.status}] (${task.phase})`);
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
			const noteCount = task.notes?.length ?? 0;
			const noteMarker = noteCount > 0 ? ` (+${noteCount} note${noteCount === 1 ? "" : "s"})` : "";
			lines.push(`    ${sym} ${task.id} ${task.content}${noteMarker}`);
			if (task.status === "in_progress" && task.notes && task.notes.length > 0) {
				for (let j = 0; j < task.notes.length; j++) {
					if (j > 0) lines.push("        ---");
					for (const noteLine of task.notes[j].split("\n")) {
						lines.push(`        ${noteLine}`);
					}
				}
			}
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
	readonly nointent = true;

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

type TodoWriteRenderArgs = {
	ops?: Array<{
		op?: string;
		task?: string;
		phase?: string;
		items?: Array<{ id?: string; label?: string }>;
	}>;
};

const SUP_DIGITS: Record<string, string> = {
	"0": "\u2070",
	"1": "\u00b9",
	"2": "\u00b2",
	"3": "\u00b3",
	"4": "\u2074",
	"5": "\u2075",
	"6": "\u2076",
	"7": "\u2077",
	"8": "\u2078",
	"9": "\u2079",
};

function toSuperscript(n: number): string {
	return n
		.toString()
		.split("")
		.map(d => SUP_DIGITS[d] ?? d)
		.join("");
}

function noteMarker(count: number, uiTheme: Theme): string {
	if (count <= 0) return "";
	return uiTheme.fg("dim", chalk.italic(` \u207a${toSuperscript(count)}`));
}

function formatTodoLine(item: TodoItem, uiTheme: Theme, prefix: string): string {
	const checkbox = uiTheme.checkbox;
	const marker = noteMarker(item.notes?.length ?? 0, uiTheme);
	switch (item.status) {
		case "completed":
			return uiTheme.fg("success", `${prefix}${checkbox.checked} ${chalk.strikethrough(item.content)}`) + marker;
		case "in_progress":
			return uiTheme.fg("accent", `${prefix}${checkbox.unchecked} ${item.content}`) + marker;
		case "abandoned":
			return uiTheme.fg("error", `${prefix}${checkbox.unchecked} ${chalk.strikethrough(item.content)}`) + marker;
		default:
			return uiTheme.fg("dim", `${prefix}${checkbox.unchecked} ${item.content}`) + marker;
	}
}

function renderNoteAttachments(phases: TodoPhase[], uiTheme: Theme): string[] {
	const lines: string[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status !== "in_progress" || !task.notes || task.notes.length === 0) continue;
			const bar = uiTheme.fg("dim", uiTheme.tree.vertical);
			const title = uiTheme.fg("dim", chalk.italic(`\u00a7 notes \u2014 ${task.content}`));
			lines.push("");
			lines.push(`  ${title}`);
			for (let j = 0; j < task.notes.length; j++) {
				if (j > 0) lines.push(`  ${bar}`);
				for (const noteLine of task.notes[j].split("\n")) {
					lines.push(`  ${bar} ${uiTheme.fg("dim", noteLine)}`);
				}
			}
		}
	}
	return lines;
}

export const todoWriteToolRenderer = {
	renderCall(args: TodoWriteRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const ops = args?.ops?.map(entry => {
			const parts = [entry.op ?? "update"];
			if (entry.task) parts.push(entry.task);
			if (entry.phase) parts.push(entry.phase);
			if (entry.items?.length) parts.push(`${entry.items.length} item${entry.items.length === 1 ? "" : "s"}`);
			return parts.join(" ");
		}) ?? ["update"];
		const text = renderStatusLine({ icon: "pending", title: "Todo Write", meta: ops }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TodoWriteToolDetails },
		options: RenderResultOptions,
		uiTheme: Theme,
		_args?: TodoWriteRenderArgs,
	): Component {
		const phases = (result.details?.phases ?? []).filter(phase => phase.tasks.length > 0);
		const allTasks = phases.flatMap(phase => phase.tasks);
		const header = renderStatusLine(
			{ icon: "success", title: "Todo Write", meta: [`${allTasks.length} tasks`] },
			uiTheme,
		);
		if (allTasks.length === 0) {
			const fallback = result.content?.find(content => content.type === "text")?.text ?? "No todos";
			return new Text(`${header}\n${uiTheme.fg("dim", fallback)}`, 0, 0);
		}

		const { expanded } = options;
		const lines: string[] = [header];
		for (let p = 0; p < phases.length; p++) {
			const phase = phases[p];
			if (p > 0) lines.push("");
			if (phases.length > 1) {
				lines.push(uiTheme.fg("accent", chalk.bold(`  ${phase.name}`)));
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
			for (const line of treeLines) {
				lines.push(`  ${line}`);
			}
		}
		lines.push(...renderNoteAttachments(phases, uiTheme));
		return new Text(lines.join("\n"), 0, 0);
	},
	mergeCallAndResult: true,
};
