import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import todoDescription from "../prompts/tools/todo.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import type { SessionEntry } from "../session/session-manager";
import { framedBlock, renderStatusLine, renderTreeList } from "../tui";
import { formatErrorDetail, PREVIEW_LIMITS } from "./render-utils";

// =============================================================================
// Types
// =============================================================================

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoItem {
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
	name: string;
	tasks: TodoItem[];
}

export interface TodoCompletionTransition {
	phase: string;
	content: string;
}

export interface TodoToolDetails {
	phases: TodoPhase[];
	storage: "session" | "memory";
	completedTasks?: TodoCompletionTransition[];
}

// =============================================================================
// Schema
// =============================================================================

const TodoOp = z
	.enum(["init", "start", "done", "rm", "drop", "append", "note", "view"] as const)
	.describe("operation to apply");

const InitListEntry = z.object({
	phase: z.string().describe("phase name"),
	items: z.array(z.string().describe("task content")).min(1).describe("tasks for this phase"),
});

const TodoOpEntry = z.object({
	op: TodoOp,
	list: z.array(InitListEntry).optional().describe("phased task list (init)"),
	task: z.string().optional().describe("task content"),
	phase: z.string().optional().describe("phase name"),
	items: z.array(z.string().describe("task content")).min(1).optional().describe("tasks to append"),
	text: z.string().optional().describe("note text"),
});

const todoSchema = z
	.object({
		ops: z.array(TodoOpEntry).min(1).describe("ordered todo operations"),
	})
	.describe("apply ordered todo operations");

type TodoParams = z.infer<typeof todoSchema>;
type TodoOpEntryValue = TodoParams["ops"][number];

// =============================================================================
// State helpers
// =============================================================================

function findTaskByContent(phases: TodoPhase[], content: string): { task: TodoItem; phase: TodoPhase } | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find(t => t.content === content);
		if (task) return { task, phase };
	}
	return undefined;
}

function findPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined {
	return phases.find(phase => phase.name === name);
}

function cloneTask(task: TodoItem): TodoItem {
	const out: TodoItem = { content: task.content, status: task.status };
	if (task.notes && task.notes.length > 0) out.notes = [...task.notes];
	return out;
}

function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({ name: phase.name, tasks: phase.tasks.map(cloneTask) }));
}

function todoTransitionKey(phase: string, content: string): string {
	return `${phase}\u0000${content}`;
}

function getCompletionTransitions(previous: TodoPhase[], updated: TodoPhase[]): TodoCompletionTransition[] {
	const previousStatuses = new Map<string, TodoStatus>();
	for (const phase of previous) {
		for (const task of phase.tasks) {
			previousStatuses.set(todoTransitionKey(phase.name, task.content), task.status);
		}
	}

	const transitions: TodoCompletionTransition[] = [];
	for (const phase of updated) {
		for (const task of phase.tasks) {
			if (task.status !== "completed") continue;
			const previousStatus = previousStatuses.get(todoTransitionKey(phase.name, task.content));
			if (previousStatus && previousStatus !== "completed") {
				transitions.push({ phase: phase.name, content: task.content });
			}
		}
	}
	return transitions;
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
		if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) continue;

		const details = message.details as { phases?: unknown } | undefined;
		if (!details || !Array.isArray(details.phases)) continue;

		return clonePhases(details.phases as TodoPhase[]);
	}

	return [];
}

/**
 * Pick the actionable window of tasks to display in the sticky todo panel.
 *
 * Returns up to `maxVisible` open (pending / in_progress) tasks in their
 * original phase order, plus the count of remaining open tasks not shown so
 * the caller can render a `+N more` hint. When every task in `tasks` is
 * closed (completed or abandoned), returns the trailing `maxVisible` tasks
 * with `hiddenOpenCount = 0`, so the panel keeps useful context until the
 * active-phase pointer advances on the next `todo`.
 *
 * Task identity and order are preserved — this is a slice, never a sort.
 */
export function selectStickyTodoWindow(
	tasks: TodoItem[],
	maxVisible = 5,
): { visible: TodoItem[]; hiddenOpenCount: number } {
	const openTasks = tasks.filter(t => t.status === "pending" || t.status === "in_progress");
	if (openTasks.length > 0) {
		const visible = openTasks.slice(0, maxVisible);
		return { visible, hiddenOpenCount: openTasks.length - visible.length };
	}
	const start = Math.max(0, tasks.length - maxVisible);
	return { visible: tasks.slice(start), hiddenOpenCount: 0 };
}

/** Minimum overlap (after normalization) required for a substring match.
 * Picked at six chars to admit single-word identifiers like "review" /
 * "Sonnet" without admitting tiny common substrings like "test" / "fix"
 * that would collide across unrelated todos. */
const TODO_DESCRIPTION_MIN_OVERLAP = 6;

function normalizeForTodoMatch(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * Report whether `content` likely names the same work as any entry in
 * `descriptions`. Used by the sticky todo panel to light up a pending todo
 * when an in-flight subagent is doing the work for it, without requiring
 * the caller to flip the todo's status.
 *
 * Matching is normalize-then-equal first (lowercased; punctuation and
 * whitespace runs both collapsed to a single space; trimmed), with a
 * substring fallback in either direction so minor wording drift
 * ("Sonnet #2: bug scan" vs "Sonnet #2") still links up. The substring
 * fallback requires at least {@link TODO_DESCRIPTION_MIN_OVERLAP} chars on
 * the contained side.
 */
export function todoMatchesAnyDescription(content: string, descriptions: readonly string[]): boolean {
	const target = normalizeForTodoMatch(content);
	if (!target) return false;
	for (const desc of descriptions) {
		const candidate = normalizeForTodoMatch(desc);
		if (!candidate) continue;
		if (target === candidate) return true;
		if (target.length >= TODO_DESCRIPTION_MIN_OVERLAP && candidate.includes(target)) return true;
		if (candidate.length >= TODO_DESCRIPTION_MIN_OVERLAP && target.includes(candidate)) return true;
	}
	return false;
}

function resolveTaskOrError(
	phases: TodoPhase[],
	content: string | undefined,
	errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
	if (!content) {
		errors.push("Missing task content");
		return undefined;
	}
	const hit = findTaskByContent(phases, content);
	if (!hit) {
		if (/^task-\d+$/.test(content)) {
			errors.push(
				`Task "${content}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`,
			);
		} else {
			const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
			const hint = totalTasks === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
			errors.push(`Task "${content}" not found${hint}`);
		}
	}
	return hit;
}

function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = findPhaseByName(phases, name);
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}

function getTaskTargets(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoItem[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		return hit ? [hit.task] : [];
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		return phase ? [...phase.tasks] : [];
	}
	return phases.flatMap(phase => phase.tasks);
}

function initPhases(entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (!entry.list) {
		errors.push("Missing list for init operation");
		return [];
	}
	// Duplicate phase names / task contents would be permanently unaddressable
	// (every targeting op resolves the first match), so reject them up front.
	const seenPhases = new Set<string>();
	const seenTasks = new Set<string>();
	for (const listEntry of entry.list) {
		if (seenPhases.has(listEntry.phase)) {
			errors.push(`Duplicate phase "${listEntry.phase}" in init list`);
		}
		seenPhases.add(listEntry.phase);
		for (const content of listEntry.items) {
			if (seenTasks.has(content)) {
				errors.push(`Duplicate task "${content}" in init list`);
			}
			seenTasks.add(content);
		}
	}
	return entry.list.map(listEntry => ({
		name: listEntry.phase,
		tasks: listEntry.items.map<TodoItem>(content => ({ content, status: "pending" })),
	}));
}

function appendItems(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (!entry.phase) {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}

	// Validate the whole batch before mutating so a failing op reports every
	// duplicate and leaves nothing half-applied.
	const seen = new Set<string>();
	let hasDuplicate = false;
	for (const content of entry.items) {
		if (seen.has(content) || findTaskByContent(phases, content)) {
			errors.push(`Task "${content}" already exists`);
			hasDuplicate = true;
		}
		seen.add(content);
	}
	if (hasDuplicate) return phases;

	let phase = findPhaseByName(phases, entry.phase);
	if (!phase) {
		phase = { name: entry.phase, tasks: [] };
		phases.push(phase);
	}

	for (const content of entry.items) {
		phase.tasks.push({ content, status: "pending" });
	}
	return phases;
}

function removeTasks(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		if (!hit) return phases;
		hit.phase.tasks = hit.phase.tasks.filter(candidate => candidate !== hit.task);
		return phases;
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		if (!phase) return phases;
		phase.tasks = [];
		return phases;
	}
	for (const phase of phases) {
		phase.tasks = [];
	}
	return phases;
}

function applyEntry(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	switch (entry.op) {
		case "init":
			return initPhases(entry, errors);
		case "start": {
			const hit = resolveTaskOrError(phases, entry.task, errors);
			if (!hit) return phases;
			for (const phase of phases) {
				for (const candidate of phase.tasks) {
					if (candidate.status === "in_progress" && candidate !== hit.task) {
						candidate.status = "pending";
					}
				}
			}
			hit.task.status = "in_progress";
			return phases;
		}
		case "done": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				task.status = "completed";
			}
			return phases;
		}
		case "drop": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				task.status = "abandoned";
			}
			return phases;
		}
		case "rm":
			return removeTasks(phases, entry, errors);
		case "note": {
			const hit = resolveTaskOrError(phases, entry.task, errors);
			if (!hit) return phases;
			const text = (entry.text ?? "").replace(/\s+$/u, "");
			if (!text) {
				errors.push("Missing text for note operation");
				return phases;
			}
			hit.task.notes = hit.task.notes ? [...hit.task.notes, text] : [text];
			return phases;
		}
		case "append":
			return appendItems(phases, entry, errors);
		case "view":
			return phases;
	}
}

function applyParams(phases: TodoPhase[], params: TodoParams): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	let next = phases;
	for (const entry of params.ops) {
		next = applyEntry(next, entry, errors);
	}
	normalizeInProgressTask(next);
	return { phases: next, errors };
}

/** Apply an array of `todo`-style ops to existing phases. Used by /todo slash command. */
export function applyOpsToPhases(
	currentPhases: TodoPhase[],
	ops: TodoParams["ops"],
): { phases: TodoPhase[]; errors: string[] } {
	return applyParams(clonePhases(currentPhases), { ops });
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
	if (phases.length === 0) return "# Todos\n";
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

/** Parse a Markdown checklist back into todo phases. */
export function markdownToPhases(md: string): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const phases: TodoPhase[] = [];
	let currentPhase: TodoPhase | undefined;
	let currentTask: TodoItem | undefined;
	let noteBuf: string[] = [];

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
			currentPhase = { name: headingMatch[1].trim(), tasks: [] };
			phases.push(currentPhase);
			continue;
		}

		const taskMatch = /^[-*+]\s*\[(.?)\]\s+(.+?)\s*$/.exec(trimmed);
		if (taskMatch) {
			flushNote();
			if (!currentPhase) {
				currentPhase = { name: "Todos", tasks: [] };
				phases.push(currentPhase);
			}
			const marker = taskMatch[1];
			const status = MARKER_TO_STATUS[marker];
			if (!status) {
				errors.push(`Line ${lineNum + 1}: unknown status marker "[${marker}]" (use [ ], [x], [/], [-])`);
				currentTask = undefined;
				continue;
			}
			currentTask = { content: taskMatch[2].trim(), status };
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

function formatSummary(phases: TodoPhase[], errors: string[], readOnly = false): string {
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) {
		if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
		return readOnly ? "Todo list is empty." : "Todo list cleared.";
	}

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
			lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
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
			lines.push(`    ${sym} ${task.content}${noteMarker}`);
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

export class TodoTool implements AgentTool<typeof todoSchema, TodoToolDetails> {
	readonly name = "todo";
	readonly approval = "read" as const;
	readonly label = "Todo";
	readonly summary = "Write a structured todo list to track progress within a session";
	readonly description: string;
	readonly parameters = todoSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(todoDescription);
	}

	async execute(
		_toolCallId: string,
		params: TodoParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoToolDetails>> {
		const previousPhases = clonePhases(this.session.getTodoPhases?.() ?? []);
		// Pure-view calls are reads: no normalization, no state write.
		const readOnly = params.ops.every(entry => entry.op === "view");
		const { phases: updated, errors } = readOnly
			? { phases: previousPhases, errors: [] as string[] }
			: applyParams(clonePhases(previousPhases), params);
		// A batch with any error is discarded wholesale: persisting a
		// half-applied batch makes the natural retry hit "already exists" for
		// the ops that did land. State and rendered summary stay at previous.
		const failed = errors.length > 0;
		const effective = failed ? previousPhases : updated;
		const completedTasks = readOnly || failed ? [] : getCompletionTransitions(previousPhases, updated);
		if (!readOnly && !failed) this.session.setTodoPhases?.(updated);
		const storage = this.session.getSessionFile() ? "session" : "memory";
		const details: TodoToolDetails = { phases: effective, storage };
		if (completedTasks.length > 0) details.completedTasks = completedTasks;

		return {
			content: [{ type: "text", text: formatSummary(effective, errors, readOnly) }],
			details,
			isError: errors.length > 0 ? true : undefined,
		};
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

type TodoRenderArgs = {
	ops?: Array<{
		op?: string;
		task?: string;
		phase?: string;
		items?: string[];
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

// =============================================================================
// Phase numbering (display-only)
// =============================================================================

const ROMAN_PAIRS: Array<[number, string]> = [
	[1000, "M"],
	[900, "CM"],
	[500, "D"],
	[400, "CD"],
	[100, "C"],
	[90, "XC"],
	[50, "L"],
	[40, "XL"],
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"],
];

/** One-based ASCII roman numeral for display (I, II, III, IV, …). */
export function phaseRomanNumeral(oneBasedIndex: number): string {
	if (oneBasedIndex <= 0) return "";
	let out = "";
	let rem = oneBasedIndex;
	for (const [value, sym] of ROMAN_PAIRS) {
		while (rem >= value) {
			out += sym;
			rem -= value;
		}
	}
	return out;
}

/** Display-only phase header: `I. Foundation`. State and prompts never see this. */
export function formatPhaseDisplayName(name: string, oneBasedIndex: number): string {
	return `${phaseRomanNumeral(oneBasedIndex)}. ${name}`;
}

function noteMarker(count: number, uiTheme: Theme): string {
	if (count <= 0) return "";
	return uiTheme.fg("dim", chalk.italic(` \u207a${toSuperscript(count)}`));
}

export const TODO_STRIKE_HOLD_FRAMES = 2;
export const TODO_STRIKE_REVEAL_FRAMES = 12;
export const TODO_STRIKE_TOTAL_FRAMES = TODO_STRIKE_HOLD_FRAMES + TODO_STRIKE_REVEAL_FRAMES;
const EMPTY_COMPLETION_KEYS = new Set<string>();
const STRIKE_START = "\x1b[9m";
const STRIKE_END = "\x1b[29m";

function strikethroughText(text: string): string {
	return `${STRIKE_START}${text}${STRIKE_END}`;
}

function partialStrikethrough(text: string, visibleChars: number): string {
	if (visibleChars <= 0) return text;
	const chars = [...text];
	if (visibleChars >= chars.length) return strikethroughText(text);
	return `${strikethroughText(chars.slice(0, visibleChars).join(""))}${chars.slice(visibleChars).join("")}`;
}

function strikeRevealCount(text: string, frame: number | undefined): number | undefined {
	if (frame === undefined) return undefined;
	if (frame <= TODO_STRIKE_HOLD_FRAMES) return 0;
	const chars = [...text];
	if (chars.length === 0) return undefined;
	const revealFrame = Math.min(frame - TODO_STRIKE_HOLD_FRAMES, TODO_STRIKE_REVEAL_FRAMES);
	return Math.ceil((chars.length * revealFrame) / TODO_STRIKE_REVEAL_FRAMES);
}

function formatTodoLine(
	item: TodoItem,
	uiTheme: Theme,
	prefix: string,
	completionKeys: Set<string>,
	frame: number | undefined,
): string {
	const checkbox = uiTheme.checkbox;
	const marker = noteMarker(item.notes?.length ?? 0, uiTheme);
	switch (item.status) {
		case "completed": {
			const revealCount = completionKeys.has(item.content) ? strikeRevealCount(item.content, frame) : undefined;
			const content =
				revealCount === undefined
					? strikethroughText(item.content)
					: partialStrikethrough(item.content, revealCount);
			return uiTheme.fg("success", `${prefix}${checkbox.checked} ${content}`) + marker;
		}
		case "in_progress":
			return uiTheme.fg("accent", `${prefix}${checkbox.unchecked} ${item.content}`) + marker;
		case "abandoned":
			return uiTheme.fg("error", `${prefix}${checkbox.unchecked} ${strikethroughText(item.content)}`) + marker;
		default:
			return uiTheme.fg("dim", `${prefix}${checkbox.unchecked} ${item.content}`) + marker;
	}
}

function renderNoteAttachments(phases: TodoPhase[], uiTheme: Theme, indent: string): string[] {
	const lines: string[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status !== "in_progress" || !task.notes || task.notes.length === 0) continue;
			lines.push("");
			lines.push(`${indent}${uiTheme.fg("dim", chalk.italic(`§ notes — ${task.content}`))}`);
			for (let j = 0; j < task.notes.length; j++) {
				if (j > 0) lines.push("");
				for (const noteLine of task.notes[j].split("\n")) {
					lines.push(`${indent}  ${uiTheme.fg("dim", noteLine)}`);
				}
			}
		}
	}
	return lines;
}

/**
 * Phases the latest update touched, plus the active (in_progress) phase.
 * Returns `null` when there is no usable signal, meaning "render every phase
 * fully" — this preserves the legacy view and the manual-expand path.
 */
function computeTouchedPhases(
	args: TodoRenderArgs | undefined,
	phases: TodoPhase[],
	completedTasks: TodoCompletionTransition[],
): Set<string> | null {
	const touched = new Set<string>();
	// The phase holding the in_progress task is where attention sits after the
	// auto-promotion that follows every completion.
	for (const phase of phases) {
		if (phase.tasks.some(task => task.status === "in_progress")) touched.add(phase.name);
	}
	// Phases with a task that just transitioned to completed in this update.
	for (const transition of completedTasks) touched.add(transition.phase);
	// Phases explicitly named by the ops that ran. `init` replaces the whole
	// list, so the entire plan is fresh and every phase counts as touched.
	const ops = Array.isArray(args?.ops) ? args.ops : [];
	for (const op of ops) {
		if (!op || typeof op !== "object") continue;
		if (op.op === "init") {
			for (const phase of phases) touched.add(phase.name);
			break;
		}
		if (typeof op.phase === "string" && op.phase) {
			const named = phases.find(phase => phase.name === op.phase);
			if (named) touched.add(named.name);
		}
		if (typeof op.task === "string" && op.task) {
			const located = findTaskByContent(phases, op.task);
			if (located) touched.add(located.phase.name);
		}
	}
	return touched.size > 0 ? touched : null;
}

/** One-line summary for a collapsed (untouched) phase: dim header + progress. */
function formatPhaseSummary(phase: TodoPhase, oneBasedIndex: number, uiTheme: Theme): string {
	const total = phase.tasks.length;
	const done = phase.tasks.filter(task => task.status === "completed").length;
	const name = uiTheme.fg("dim", chalk.bold(formatPhaseDisplayName(phase.name, oneBasedIndex)));
	return `${name}${uiTheme.fg("dim", `  ${done}/${total}`)}`;
}

export const todoToolRenderer = {
	renderCall(args: TodoRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		// `args` here is the raw partially-parsed JSON from the streaming
		// tool-call delta and may not satisfy `TodoRenderArgs` at runtime:
		// `parseStreamingJson` can hand back `{ ops: "[" }` mid-delta, or
		// entries that are `null` / strings before fields stream. Guard
		// against non-array `ops` and non-object entries so a malformed
		// delta never breaks the TUI render loop (#2005).
		const opsList = Array.isArray(args?.ops) ? args.ops : [];
		const ops =
			opsList.length === 0
				? ["update"]
				: opsList.map(entry => {
						const e = entry && typeof entry === "object" ? entry : ({} as NonNullable<typeof entry>);
						const parts = [e.op ?? "update"];
						if (e.task) parts.push(e.task);
						if (e.phase) parts.push(e.phase);
						if (Array.isArray(e.items) && e.items.length) {
							parts.push(`${e.items.length} item${e.items.length === 1 ? "" : "s"}`);
						}
						return parts.join(" ");
					});
		// No body worth boxing while the call streams — a lone status line reads
		// cleaner than an empty frame. The container renders it without chrome.
		const header = renderStatusLine(
			{ icon: "pending", spinnerFrame: options?.spinnerFrame, title: "Todo", meta: ops },
			uiTheme,
		);
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TodoToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: TodoRenderArgs,
	): Component {
		if (result.isError) {
			const errorText = result.content?.find(content => content.type === "text")?.text ?? "Todo operation failed";
			const header = renderStatusLine({ icon: "error", title: "Todo" }, uiTheme);
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: formatErrorDetail(errorText, uiTheme).split("\n") }],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const phases = (result.details?.phases ?? []).filter(phase => phase.tasks.length > 0);
		const completedTasks = result.details?.completedTasks ?? [];
		const completionKeysByPhase = new Map<string, Set<string>>();
		for (const task of completedTasks) {
			let keys = completionKeysByPhase.get(task.phase);
			if (!keys) {
				keys = new Set<string>();
				completionKeysByPhase.set(task.phase, keys);
			}
			keys.add(task.content);
		}
		const allTasks = phases.flatMap(phase => phase.tasks);
		const header = renderStatusLine(
			{
				iconOverride: uiTheme.styledSymbol("tool.todo", "accent"),
				title: "Todo",
				meta: [`${allTasks.length} tasks`],
			},
			uiTheme,
		);
		if (allTasks.length === 0) {
			const fallback = result.content?.find(content => content.type === "text")?.text ?? "No todos";
			return new Text(`${header}\n  ${uiTheme.fg("dim", fallback)}`, 0, 0);
		}

		return framedBlock(uiTheme, width => {
			const { expanded, spinnerFrame } = options;
			const multiPhase = phases.length > 1;
			const indent = multiPhase ? "  " : "";
			// Collapse phases this update didn't touch down to a one-line summary so
			// a single task flip doesn't redraw every phase's full task list. The
			// manual expand toggle (and the no-signal fallback) still shows all.
			const touched = expanded || !multiPhase ? null : computeTouchedPhases(args, phases, completedTasks);
			const bodyLines: string[] = [];
			for (let p = 0; p < phases.length; p++) {
				const phase = phases[p];
				if (touched && !touched.has(phase.name)) {
					bodyLines.push(formatPhaseSummary(phase, p + 1, uiTheme));
					continue;
				}
				if (multiPhase) {
					bodyLines.push(uiTheme.fg("accent", chalk.bold(formatPhaseDisplayName(phase.name, p + 1))));
				}
				const completionKeys = completionKeysByPhase.get(phase.name) ?? EMPTY_COMPLETION_KEYS;
				const treeLines = renderTreeList(
					{
						items: phase.tasks,
						expanded,
						maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
						itemType: "todo",
						renderItem: todo => formatTodoLine(todo, uiTheme, "", completionKeys, spinnerFrame),
					},
					uiTheme,
				);
				for (const line of treeLines) {
					bodyLines.push(`${indent}${line}`);
				}
			}
			bodyLines.push(...renderNoteAttachments(phases, uiTheme, indent));
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: options.isPartial ? "pending" : "success",
				borderColor: "borderMuted",
				applyBg: false,
				width,
			};
		});
	},
	mergeCallAndResult: true,
};
