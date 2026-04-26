import * as fs from "node:fs/promises";
import {
	applyOpsToPhases,
	getLatestTodoPhasesFromEntries,
	markdownToPhases,
	phasesToMarkdown,
	type TodoItem,
	type TodoPhase,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "../../tools/todo-write";
import { resolveToCwd } from "../../tools/path-utils";
import { copyToClipboard } from "../../utils/clipboard";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import type { InteractiveModeContext } from "../types";

const USAGE = [
	"Usage: /todo <verb> [args]",
	"  /todo                              Show current todos",
	"  /todo edit                         Open todos in $EDITOR",
	"  /todo copy                         Copy todos as Markdown to clipboard",
	"  /todo export <path>                Write todos as Markdown to <path>",
	"  /todo import <path>                Replace todos from Markdown at <path>",
	"  /todo append [<phase>] <task...>   Append a task; phase fuzzy-matched or auto-created",
	"  /todo start  <task>                Mark task in_progress (id or fuzzy content)",
	"  /todo done   [<task|phase>]        Mark task/phase/all completed",
	"  /todo drop   [<task|phase>]        Mark task/phase/all abandoned",
	"  /todo rm     [<task|phase>]        Remove task/phase/all",
].join("\n");

// =============================================================================
// Argument tokenizer (respects double-quoted strings)
// =============================================================================

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	let inQuote = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "\\" && i + 1 < input.length) {
			cur += input[++i];
			continue;
		}
		if (ch === '"') {
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && /\s/.test(ch)) {
			if (cur) {
				tokens.push(cur);
				cur = "";
			}
			continue;
		}
		cur += ch;
	}
	if (cur) tokens.push(cur);
	return tokens;
}

// =============================================================================
// Roman numerals + name normalization
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

function toRoman(n: number): string {
	if (n <= 0) return "I";
	let out = "";
	let rem = n;
	for (const [value, sym] of ROMAN_PAIRS) {
		while (rem >= value) {
			out += sym;
			rem -= value;
		}
	}
	return out;
}

const PHASE_PREFIX_RE = /^([IVXLCDM]+|[A-Z]|\d+)\.\s*/i;

function stripPrefix(name: string): string {
	return name.replace(PHASE_PREFIX_RE, "").trim();
}

function titleCase(s: string): string {
	return s
		.split(/\s+/)
		.filter(Boolean)
		.map(word => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

function buildPhaseName(rawName: string, existingPhases: TodoPhase[]): string {
	const stripped = stripPrefix(rawName.trim());
	if (!stripped) return `${toRoman(existingPhases.length + 1)}. Todos`;
	const titled = titleCase(stripped);
	return `${toRoman(existingPhases.length + 1)}. ${titled}`;
}

// =============================================================================
// Fuzzy matching
// =============================================================================

function findPhaseFuzzy(phases: TodoPhase[], query: string): TodoPhase | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	// Exact id
	const byId = phases.find(p => p.id.toLowerCase() === q);
	if (byId) return byId;
	// Exact name (case-insensitive)
	const byName = phases.find(p => p.name.toLowerCase() === q);
	if (byName) return byName;
	// Stripped name match
	const strippedQ = stripPrefix(q);
	const byStripped = phases.find(p => stripPrefix(p.name).toLowerCase() === strippedQ);
	if (byStripped) return byStripped;
	// Substring (prefer prefix match on stripped name)
	const prefixMatches = phases.filter(p => stripPrefix(p.name).toLowerCase().startsWith(strippedQ));
	if (prefixMatches.length === 1) return prefixMatches[0];
	const subMatches = phases.filter(p => stripPrefix(p.name).toLowerCase().includes(strippedQ));
	if (subMatches.length === 1) return subMatches[0];
	return undefined;
}

function findTaskFuzzy(
	phases: TodoPhase[],
	query: string,
): { task: TodoItem; phase: TodoPhase } | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.id.toLowerCase() === q) return { task, phase };
		}
	}
	const matches: Array<{ task: TodoItem; phase: TodoPhase }> = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase().includes(q)) {
				matches.push({ task, phase });
			}
		}
	}
	if (matches.length === 1) return matches[0];
	// Prefer single in_progress/pending hit when ambiguous
	const active = matches.filter(
		m => m.task.status === "in_progress" || m.task.status === "pending",
	);
	if (active.length === 1) return active[0];
	return undefined;
}

// =============================================================================
// Build system reminder
// =============================================================================

function buildSystemReminder(action: string, phases: TodoPhase[]): string {
	const md = phases.length === 0 ? "(empty)" : phasesToMarkdown(phases).trimEnd();
	return [
		"<system-reminder>",
		`The user manually modified the todo list (${action}).`,
		"Current todo list (note task ids may have been reassigned by /todo edit):",
		"",
		md,
		"</system-reminder>",
	].join("\n");
}

export class TodoCommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	/**
	 * True latest todo state for the user-facing /todo verbs. Reads from session
	 * entries so that completed/abandoned tasks remain visible after resume
	 * (where `session.getTodoPhases()` would have stripped them).
	 */
	#currentPhases(): TodoPhase[] {
		const fromEntries = getLatestTodoPhasesFromEntries(this.ctx.sessionManager.getBranch());
		if (fromEntries.length > 0) return fromEntries;
		return this.ctx.session.getTodoPhases();
	}

	async handleTodoCommand(args: string): Promise<void> {
		const trimmed = args.trim();
		if (!trimmed) {
			this.#showCurrent();
			return;
		}

		const spaceIdx = trimmed.search(/\s/);
		const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
		const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

		switch (verb) {
			case "edit":
				await this.#editInExternalEditor();
				return;
			case "copy":
				this.#copyMarkdown();
				return;
			case "export":
				await this.#exportToFile(rest);
				return;
			case "import":
				await this.#importFromFile(rest);
				return;
			case "help":
			case "?":
				this.ctx.showStatus(USAGE);
				return;
			case "append":
				this.#append(rest);
				return;
			case "start":
				this.#start(rest);
				return;
			case "done":
				this.#mutateStatus(rest, "completed");
				return;
			case "drop":
				this.#mutateStatus(rest, "abandoned");
				return;
			case "rm":
				this.#remove(rest);
				return;
			default:
				this.ctx.showError(`Unknown /todo verb "${verb}".\n${USAGE}`);
		}
	}

	#showCurrent(): void {
		const phases = this.#currentPhases();
		if (phases.length === 0) {
			this.ctx.showStatus("No todos. Use /todo append <task> to start one.");
			return;
		}
		this.ctx.showStatus(phasesToMarkdown(phases).trimEnd());
	}

	#copyMarkdown(): void {
		const phases = this.#currentPhases();
		if (phases.length === 0) {
			this.ctx.showWarning("No todos to copy.");
			return;
		}
		try {
			copyToClipboard(phasesToMarkdown(phases));
			this.ctx.showStatus("Copied todos as Markdown to clipboard.");
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	#resolveTodoPath(rest: string): string {
		const trimmed = rest.trim();
		const raw = trimmed || "TODO.md";
		return resolveToCwd(raw, this.ctx.sessionManager.getCwd());
	}

	async #exportToFile(rest: string): Promise<void> {
		const phases = this.#currentPhases();
		if (phases.length === 0) {
			this.ctx.showWarning("No todos to export.");
			return;
		}
		const target = this.#resolveTodoPath(rest);
		try {
			await fs.writeFile(target, phasesToMarkdown(phases), "utf8");
			this.ctx.showStatus(`Wrote todos to ${target}`);
		} catch (error) {
			this.ctx.showError(`Failed to write ${target}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #importFromFile(rest: string): Promise<void> {
		const source = this.#resolveTodoPath(rest);
		let content: string;
		try {
			content = await fs.readFile(source, "utf8");
		} catch (error) {
			this.ctx.showError(`Failed to read ${source}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const { phases, errors } = markdownToPhases(content);
		if (errors.length > 0) {
			this.ctx.showError(`Could not parse ${source}:\n  ${errors.join("\n  ")}`);
			return;
		}
		this.#commit(phases, `/todo import ${source}`);
		const taskCount = phases.reduce((sum, p) => sum + p.tasks.length, 0);
		this.ctx.showStatus(`Imported ${phases.length} phase(s), ${taskCount} task(s) from ${source}.`);
	}

	// ------------------------------------------------------------- append

	#append(rest: string): void {
		const tokens = tokenize(rest);
		if (tokens.length === 0) {
			this.ctx.showError("Usage: /todo append [<phase>] <task...>");
			return;
		}

		const current = this.#currentPhases();
		let phaseName: string | undefined;
		let content: string;

		if (tokens.length === 1) {
			content = tokens[0];
		} else {
			phaseName = tokens[0];
			content = tokens.slice(1).join(" ");
		}

		const next = current.map(phase => ({ ...phase, tasks: phase.tasks.slice() }));
		let targetPhase: TodoPhase | undefined;

		if (phaseName) {
			targetPhase = findPhaseFuzzy(next, phaseName);
			if (!targetPhase) {
				const newName = buildPhaseName(phaseName, next);
				targetPhase = { id: `phase-${next.length + 1}`, name: newName, tasks: [] };
				next.push(targetPhase);
			}
		} else if (next.length > 0) {
			targetPhase = next[next.length - 1];
		} else {
			targetPhase = { id: "phase-1", name: `${toRoman(1)}. Todos`, tasks: [] };
			next.push(targetPhase);
		}

		const usedTaskIds = new Set(next.flatMap(p => p.tasks.map(t => t.id)));
		let n = 1;
		while (usedTaskIds.has(`task-${n}`)) n++;
		targetPhase.tasks.push({
			id: `task-${n}`,
			content: titleCaseSentence(content),
			status: "pending",
		});

		this.#commit(next, `/todo append → ${targetPhase.name}`);
		this.ctx.showStatus(`Appended to ${targetPhase.name}: ${content}`);
	}

	// ------------------------------------------------------------- start / done / drop / rm

	#start(rest: string): void {
		if (!rest) {
			this.ctx.showError("Usage: /todo start <task>");
			return;
		}
		const current = this.#currentPhases();
		const hit = findTaskFuzzy(current, rest);
		if (!hit) {
			this.ctx.showError(`No task matched "${rest}". Use /todo to list current tasks.`);
			return;
		}
		const { phases, errors } = applyOpsToPhases(current, [{ op: "start", task: hit.task.id }]);
		if (errors.length > 0) {
			this.ctx.showError(errors.join("; "));
			return;
		}
		this.#commit(phases, `/todo start ${hit.task.id}`);
		this.ctx.showStatus(`Started: ${hit.task.content}`);
	}

	#mutateStatus(rest: string, target: "completed" | "abandoned"): void {
		const op = target === "completed" ? "done" : "drop";
		const current = this.#currentPhases();
		const trimmed = rest.trim();
		if (!trimmed) {
			// no-arg: apply to all
			const { phases, errors } = applyOpsToPhases(current, [{ op }]);
			if (errors.length > 0) {
				this.ctx.showError(errors.join("; "));
				return;
			}
			this.#commit(phases, `/todo ${op} (all)`);
			this.ctx.showStatus(`Marked all tasks ${target}.`);
			return;
		}

		const taskHit = findTaskFuzzy(current, trimmed);
		if (taskHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op, task: taskHit.task.id }]);
			if (errors.length > 0) {
				this.ctx.showError(errors.join("; "));
				return;
			}
			this.#commit(phases, `/todo ${op} ${taskHit.task.id}`);
			this.ctx.showStatus(`Marked ${target}: ${taskHit.task.content}`);
			return;
		}

		const phaseHit = findPhaseFuzzy(current, trimmed);
		if (phaseHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op, phase: phaseHit.id }]);
			if (errors.length > 0) {
				this.ctx.showError(errors.join("; "));
				return;
			}
			this.#commit(phases, `/todo ${op} ${phaseHit.name}`);
			this.ctx.showStatus(`Marked phase ${phaseHit.name} ${target}.`);
			return;
		}

		this.ctx.showError(`No task or phase matched "${trimmed}".`);
	}

	#remove(rest: string): void {
		const current = this.#currentPhases();
		const trimmed = rest.trim();
		if (!trimmed) {
			this.#commit([], "/todo rm (all)");
			this.ctx.showStatus("Cleared all todos.");
			return;
		}
		const taskHit = findTaskFuzzy(current, trimmed);
		if (taskHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op: "rm", task: taskHit.task.id }]);
			if (errors.length > 0) {
				this.ctx.showError(errors.join("; "));
				return;
			}
			this.#commit(phases, `/todo rm ${taskHit.task.id}`);
			this.ctx.showStatus(`Removed: ${taskHit.task.content}`);
			return;
		}
		const phaseHit = findPhaseFuzzy(current, trimmed);
		if (phaseHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op: "rm", phase: phaseHit.id }]);
			if (errors.length > 0) {
				this.ctx.showError(errors.join("; "));
				return;
			}
			this.#commit(phases, `/todo rm ${phaseHit.name}`);
			this.ctx.showStatus(`Removed phase: ${phaseHit.name}`);
			return;
		}
		this.ctx.showError(`No task or phase matched "${trimmed}".`);
	}

	// ------------------------------------------------------------- editor

	async #editInExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const current = this.#currentPhases();
		const initialMarkdown =
			current.length > 0
				? phasesToMarkdown(current)
				: "# I. Todos\n- [ ] (replace this with your tasks)\n";

		const fileHandle = await this.#openTtyHandle();
		this.ctx.ui.stop();
		try {
			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = fileHandle
				? [fileHandle.fd, fileHandle.fd, fileHandle.fd]
				: ["inherit", "inherit", "inherit"];
			const result = await openInEditor(editorCmd, initialMarkdown, {
				extension: ".todo.md",
				stdio,
			});
			if (result === null) {
				this.ctx.showWarning("Editor exited without saving; todos unchanged.");
				return;
			}
			const { phases: parsed, errors } = markdownToPhases(result);
			if (errors.length > 0) {
				this.ctx.showError(`Could not parse Markdown:\n  ${errors.join("\n  ")}`);
				return;
			}
			this.#commit(parsed, "/todo edit");
			const taskCount = parsed.reduce((sum, p) => sum + p.tasks.length, 0);
			this.ctx.showStatus(`Todos updated from editor: ${parsed.length} phase(s), ${taskCount} task(s).`);
		} catch (error) {
			this.ctx.showWarning(
				`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (fileHandle) {
				await fileHandle.close().catch(() => {});
			}
			this.ctx.ui.start();
			this.ctx.ui.requestRender();
		}
	}

	async #openTtyHandle(): Promise<fs.FileHandle | null> {
		const stdinPath = (process.stdin as unknown as { path?: string }).path;
		const candidate = typeof stdinPath === "string" ? stdinPath : undefined;
		if (!candidate) return null;
		try {
			return await fs.open(candidate, "r+");
		} catch {
			return null;
		}
	}

	#commit(nextPhases: TodoPhase[], action: string): void {
		// 1. In-memory + UI state
		this.ctx.session.setTodoPhases(nextPhases);
		this.ctx.setTodos(nextPhases);

		// 2. Persist for reload survival via custom session entry.
		this.ctx.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: nextPhases });

		// 3. Inject system reminder so the agent learns about the change next turn.
		const reminderText = buildSystemReminder(action, nextPhases);
		const message = {
			role: "developer" as const,
			content: [{ type: "text" as const, text: reminderText }],
			attribution: "user" as const,
			timestamp: Date.now(),
		};
		this.ctx.agent.appendMessage(message);
		this.ctx.sessionManager.appendMessage(message);
	}
}

/** Capitalize first letter only — keeps acronyms / casing in the rest of the sentence intact. */
function titleCaseSentence(s: string): string {
	const trimmed = s.trim();
	if (!trimmed) return trimmed;
	return trimmed[0].toUpperCase() + trimmed.slice(1);
}
