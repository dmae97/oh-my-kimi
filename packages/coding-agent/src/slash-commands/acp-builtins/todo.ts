import * as path from "node:path";
import type { TodoPhase } from "../../tools/todo-write";
import { applyOpsToPhases, markdownToPhases, phasesToMarkdown } from "../../tools/todo-write";
import { commandConsumed, parseSubcommand, usage } from "./shared";
import {
	commitTodos,
	copyPhases,
	currentPhases,
	findPhaseFuzzy,
	findTaskFuzzy,
	titleCase,
	titleCaseSentence,
	tokenize,
} from "./todo-state";
import type { AcpBuiltinCommandRuntime, AcpBuiltinCommandSpec } from "./types";

type TodoMutationVerb = "done" | "drop" | "rm";

function todoHelpText(): string {
	return [
		"Usage: /todo <verb> [args]",
		"  /todo                              Show current todos",
		"  /todo edit                         (TUI only) open in $EDITOR",
		"  /todo copy                         Print todos as Markdown",
		"  /todo export [<path>]              Write todos to file (default: TODO.md)",
		"  /todo import [<path>]              Replace todos from file (default: TODO.md)",
		"  /todo append [<phase>] <task...>   Append a task",
		"  /todo start  <task>                Mark task in_progress (fuzzy match)",
		"  /todo done   [<task|phase>]        Mark task/phase/all completed",
		"  /todo drop   [<task|phase>]        Mark task/phase/all abandoned",
		"  /todo rm     [<task|phase>]        Remove task/phase/all",
	].join("\n");
}

async function handleTodoCopyCommand(runtime: AcpBuiltinCommandRuntime) {
	const phases = currentPhases(runtime);
	const markdown = phases.length === 0 ? "" : phasesToMarkdown(phases).trimEnd();
	await runtime.output(`Copy not available in ACP mode; printing instead:\n\n${markdown || "No todos."}`);
	return commandConsumed();
}

async function handleTodoExportCommand(restArgs: string, runtime: AcpBuiltinCommandRuntime) {
	const phases = currentPhases(runtime);
	if (phases.length === 0) {
		await runtime.output("No todos to export.");
		return commandConsumed();
	}
	const target = restArgs ? path.resolve(runtime.cwd, restArgs) : path.resolve(runtime.cwd, "TODO.md");
	await Bun.write(target, phasesToMarkdown(phases));
	await runtime.output(`Wrote todos to ${target}`);
	return commandConsumed();
}

async function handleTodoImportCommand(restArgs: string, runtime: AcpBuiltinCommandRuntime) {
	const target = restArgs ? path.resolve(runtime.cwd, restArgs) : path.resolve(runtime.cwd, "TODO.md");
	let content: string;
	try {
		content = await Bun.file(target).text();
	} catch (err) {
		return usage(`Failed to read ${target}: ${err instanceof Error ? err.message : String(err)}`, runtime);
	}
	const { phases, errors } = markdownToPhases(content);
	if (errors.length > 0) return usage(`Could not parse ${target}:\n  ${errors.join("\n  ")}`, runtime);
	commitTodos(runtime, phases);
	const taskCount = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
	await runtime.output(`Imported ${phases.length} phase(s), ${taskCount} task(s) from ${target}.`);
	return commandConsumed();
}

async function handleTodoAppendCommand(restArgs: string, runtime: AcpBuiltinCommandRuntime) {
	const tokens = tokenize(restArgs);
	if (tokens.length === 0) return usage("Usage: /todo append [<phase>] <task...>", runtime);

	const current = currentPhases(runtime);
	const phaseName = tokens.length === 1 ? undefined : tokens[0];
	const content = tokens.length === 1 ? tokens[0]! : tokens.slice(1).join(" ");
	const next = copyPhases(current);
	let targetPhase: TodoPhase;

	if (phaseName) {
		const existing = findPhaseFuzzy(next, phaseName);
		targetPhase = existing ?? { name: titleCase(phaseName), tasks: [] };
		if (!existing) next.push(targetPhase);
	} else if (next.length > 0) {
		targetPhase = next[next.length - 1]!;
	} else {
		targetPhase = { name: "Todos", tasks: [] };
		next.push(targetPhase);
	}

	const finalContent = titleCaseSentence(content);
	targetPhase.tasks.push({ content: finalContent, status: "pending" });
	commitTodos(runtime, next);
	await runtime.output(`Appended to ${targetPhase.name}: ${finalContent}`);
	return commandConsumed();
}

async function handleTodoStartCommand(restArgs: string, runtime: AcpBuiltinCommandRuntime) {
	if (!restArgs) return usage("Usage: /todo start <task>", runtime);
	const current = currentPhases(runtime);
	const query = tokenize(restArgs).join(" ") || restArgs;
	const hit = findTaskFuzzy(current, query);
	if (!hit) return usage(`No task matched "${restArgs}". Use /todo to list current tasks.`, runtime);
	const { phases } = applyOpsToPhases(current, [{ op: "start", task: hit.task.content }]);
	commitTodos(runtime, phases);
	await runtime.output(`Started: ${hit.task.content}`);
	return commandConsumed();
}

async function handleTodoMutationCommand(verb: TodoMutationVerb, restArgs: string, runtime: AcpBuiltinCommandRuntime) {
	const current = currentPhases(runtime);
	const trimmedArg = restArgs.trim();
	if (!trimmedArg) {
		if (verb === "rm") {
			commitTodos(runtime, []);
			await runtime.output("Cleared all todos.");
			return commandConsumed();
		}
		const { phases } = applyOpsToPhases(current, [{ op: verb }]);
		commitTodos(runtime, phases);
		await runtime.output(verb === "done" ? "Marked all tasks completed." : "Marked all tasks abandoned.");
		return commandConsumed();
	}

	const taskHit = findTaskFuzzy(current, trimmedArg);
	if (taskHit) {
		const { phases } = applyOpsToPhases(current, [{ op: verb, task: taskHit.task.content }]);
		commitTodos(runtime, phases);
		const label = verb === "done" ? "Marked completed" : verb === "drop" ? "Marked abandoned" : "Removed";
		await runtime.output(`${label}: ${taskHit.task.content}`);
		return commandConsumed();
	}

	const phaseHit = findPhaseFuzzy(current, trimmedArg);
	if (phaseHit) {
		const { phases } = applyOpsToPhases(current, [{ op: verb, phase: phaseHit.name }]);
		commitTodos(runtime, phases);
		const message =
			verb === "done"
				? `Marked phase ${phaseHit.name} completed.`
				: verb === "drop"
					? `Marked phase ${phaseHit.name} abandoned.`
					: `Removed phase: ${phaseHit.name}`;
		await runtime.output(message);
		return commandConsumed();
	}

	return usage(`No task or phase matched "${trimmedArg}".`, runtime);
}

export const todoCommand: AcpBuiltinCommandSpec = {
	name: "todo",
	description: "Manage todos",
	inputHint: "<subcommand>",
	handle: async (command, runtime) => {
		const trimmed = command.args.trim();
		if (!trimmed) {
			const phases = currentPhases(runtime);
			await runtime.output(
				phases.length === 0
					? "No todos. Use /todo append <task> to start one."
					: phasesToMarkdown(phases).trimEnd(),
			);
			return commandConsumed();
		}

		const { verb, rest } = parseSubcommand(trimmed);
		switch (verb) {
			case "copy":
				return await handleTodoCopyCommand(runtime);
			case "export":
				return await handleTodoExportCommand(rest, runtime);
			case "import":
				return await handleTodoImportCommand(rest, runtime);
			case "append":
				return await handleTodoAppendCommand(rest, runtime);
			case "start":
				return await handleTodoStartCommand(rest, runtime);
			case "done":
			case "drop":
			case "rm":
				return await handleTodoMutationCommand(verb, rest, runtime);
			case "edit":
				return usage(
					"/todo edit requires the TUI editor; use /todo export then /todo import for non-interactive edits.",
					runtime,
				);
			case "help":
			case "?":
				await runtime.output(todoHelpText());
				return commandConsumed();
			default:
				return usage("Unknown /todo subcommand. Use append, start, done, drop, rm, copy, export, import.", runtime);
		}
	},
};
