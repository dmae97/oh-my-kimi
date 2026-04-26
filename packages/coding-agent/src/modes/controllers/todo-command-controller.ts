import * as fs from "node:fs/promises";
import {
	applyOpsToPhases,
	markdownToPhases,
	phasesToMarkdown,
	type TodoPhase,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "../../tools/todo-write";
import { copyToClipboard } from "../../utils/clipboard";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import type { InteractiveModeContext } from "../types";

const SHORTHAND_VERBS = new Set(["start", "done", "drop", "rm"]);
const JSON_REQUIRED_VERBS = new Set(["replace", "append"]);

type TodoOp = {
	op: "replace" | "start" | "done" | "drop" | "rm" | "append";
	task?: string;
	phase?: string;
	items?: Array<{ id: string; label: string }>;
	phases?: Array<{ name: string; tasks?: Array<{ content: string; status?: string }> }>;
};

const USAGE = [
	"Usage: /todo <verb> [args]",
	"  /todo                              Show current todos",
	"  /todo edit                         Open todos in $EDITOR",
	"  /todo copy                         Copy todos as Markdown to clipboard",
	"  /todo start <task-id>              Mark task in_progress",
	"  /todo done [task-id|phase-name]    Mark task/phase/all completed",
	"  /todo drop [task-id|phase-name]    Mark task/phase/all abandoned",
	"  /todo rm   [task-id|phase-name]    Remove task/phase/all",
	'  /todo append {"phase":"…","items":[{"id":"task-N","label":"…"}]}',
	'  /todo replace {"phases":[…]}       Replace entire list (JSON)',
].join("\n");

function parseShorthand(args: string): { task?: string; phase?: string } {
	const trimmed = args.trim();
	if (!trimmed) return {};
	if (/^task-\d+$/.test(trimmed)) return { task: trimmed };
	return { phase: trimmed };
}

/** Parse `/todo` args into a single op. Returns null on parse error (msg shown). */
function parseTodoArgs(args: string, ctx: InteractiveModeContext): TodoOp | null {
	const trimmed = args.trim();
	const spaceIdx = trimmed.search(/\s/);
	const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
	const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

	if (!["replace", "start", "done", "drop", "rm", "append"].includes(verb)) {
		ctx.showError(`Unknown verb "${verb}". ${USAGE}`);
		return null;
	}

	const op = verb as TodoOp["op"];

	if (rest.startsWith("{")) {
		try {
			const parsed = JSON.parse(rest) as Partial<TodoOp>;
			return { ...parsed, op };
		} catch (err) {
			ctx.showError(`Invalid JSON for /todo ${verb}: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	if (JSON_REQUIRED_VERBS.has(op)) {
		ctx.showError(`/todo ${verb} requires a JSON payload. Example:\n  /todo ${verb} {…}`);
		return null;
	}

	if (op === "start") {
		if (!rest) {
			ctx.showError("Usage: /todo start <task-id>");
			return null;
		}
		return { op, task: rest };
	}

	if (SHORTHAND_VERBS.has(op)) {
		return { op, ...parseShorthand(rest) };
	}

	return { op };
}

function buildSystemReminder(action: string, phases: TodoPhase[]): string {
	const md = phases.length === 0 ? "(empty)" : phasesToMarkdown(phases).trimEnd();
	return [
		"<system-reminder>",
		`The user manually modified the todo list (${action}).`,
		"Current todo list (note task ids may have been reassigned by /todo edit/replace):",
		"",
		md,
		"</system-reminder>",
	].join("\n");
}

export class TodoCommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	async handleTodoCommand(args: string): Promise<void> {
		const trimmed = args.trim();
		if (!trimmed) {
			this.#showCurrent();
			return;
		}

		const spaceIdx = trimmed.search(/\s/);
		const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();

		if (verb === "edit") {
			await this.#editInExternalEditor();
			return;
		}
		if (verb === "copy") {
			this.#copyMarkdown();
			return;
		}
		if (verb === "help" || verb === "?") {
			this.ctx.showStatus(USAGE);
			return;
		}

		const opInput = parseTodoArgs(trimmed, this.ctx);
		if (!opInput) return;

		const current = this.ctx.session.getTodoPhases();
		const { phases: nextPhases, errors } = applyOpsToPhases(current, [opInput as Parameters<typeof applyOpsToPhases>[1][number]]);

		if (errors.length > 0) {
			this.ctx.showError(`/todo ${verb}: ${errors.join("; ")}`);
			return;
		}

		this.#commit(nextPhases, `/todo ${verb}`);
		this.ctx.showStatus(`Todo updated (${verb}).`);
	}

	#showCurrent(): void {
		const phases = this.ctx.session.getTodoPhases();
		if (phases.length === 0) {
			this.ctx.showStatus("No todos. Use /todo replace {…} or call todo_write to create one.");
			return;
		}
		this.ctx.showStatus(phasesToMarkdown(phases).trimEnd());
	}

	#copyMarkdown(): void {
		const phases = this.ctx.session.getTodoPhases();
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

	async #editInExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const current = this.ctx.session.getTodoPhases();
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
