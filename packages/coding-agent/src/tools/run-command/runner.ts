import { ToolError } from "../tool-errors";

export interface RunnerTask {
	name: string;
	doc?: string;
	/** Parameter names only; used for the `name foo bar` signature line in the description. */
	parameters: string[];
	/** Override for this specific task, e.g. `cargo run --package crate --bin`. */
	commandPrefix?: string;
	/** Token passed to the runner command; defaults to `name`. Used when display names are namespaced. */
	commandName?: string;
}

export interface DetectedRunner {
	id: string;
	label: string;
	/** Resolved shell prefix, e.g. "just" or "bun run" or "make". */
	commandPrefix: string;
	tasks: RunnerTask[];
}

export interface TaskRunner {
	id: string;
	label: string;
	/**
	 * Probe `cwd` for the manifest, the binary, and the task list.
	 * Returns null when this runner does not apply.
	 */
	detect(cwd: string): Promise<DetectedRunner | null>;
}

interface ParsedOp {
	head: string;
	tail: string;
}

interface PromptTaskModel {
	name: string;
	paramSig?: string;
	command?: string;
	doc?: string;
}

interface PromptRunnerModel {
	id: string;
	label: string;
	commandPrefix: string;
	tasks: PromptTaskModel[];
}

export interface RunCommandPromptModel {
	[key: string]: unknown;
	hasMultipleRunners: boolean;
	ambiguityExampleRunner?: string;
	ambiguityExampleTask?: string;
	runners: PromptRunnerModel[];
}

function parseOp(op: string): ParsedOp {
	const trimmedStart = op.trimStart();
	if (trimmedStart.length === 0) return { head: "", tail: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(trimmedStart);
	return { head: match?.[1] ?? "", tail: match?.[2] ?? "" };
}

function findRunnerById(id: string, runners: DetectedRunner[]): DetectedRunner | undefined {
	return runners.find(runner => runner.id === id);
}

function hasTask(runner: DetectedRunner, taskName: string): boolean {
	return runner.tasks.some(task => task.name === taskName);
}

function findMatchingRunners(taskName: string, runners: DetectedRunner[]): DetectedRunner[] {
	return runners.filter(runner => hasTask(runner, taskName));
}

function formatAvailableTasks(runners: DetectedRunner[]): string {
	return runners
		.map(runner => {
			const names = runner.tasks.map(task => task.name).join(", ");
			return `- ${runner.id}: ${names || "(no tasks)"}`;
		})
		.join("\n");
}

function formatRunnerIds(runners: DetectedRunner[]): string {
	return runners.map(runner => runner.id).join(", ");
}

function buildCommand(commandPrefix: string, taskName: string, tail: string): string {
	return [commandPrefix, taskName, tail]
		.filter(part => part.trim().length > 0)
		.join(" ")
		.trim();
}

function resolveRunnerAndTask(
	op: string,
	runners: DetectedRunner[],
): { runner: DetectedRunner; task: RunnerTask; tail: string } {
	const { head, tail } = parseOp(op);
	if (!head) {
		throw new ToolError(`run_command op is empty. Available tasks:\n${formatAvailableTasks(runners)}`);
	}

	const colonIndex = head.indexOf(":");
	if (colonIndex > 0) {
		const maybeRunnerId = head.slice(0, colonIndex);
		const explicitRunner = findRunnerById(maybeRunnerId, runners);
		if (explicitRunner) {
			const taskName = head.slice(colonIndex + 1);
			const explicitTask = explicitRunner.tasks.find(task => task.name === taskName);
			if (!taskName || !explicitTask) {
				throw new ToolError(
					`Task \`${taskName || "(empty)"}\` not found in runner \`${explicitRunner.id}\`. Available tasks:\n${formatAvailableTasks(runners)}`,
				);
			}
			return { runner: explicitRunner, task: explicitTask, tail };
		}
	}

	const matches = findMatchingRunners(head, runners);
	if (matches.length === 1) {
		return { runner: matches[0]!, task: matches[0]!.tasks.find(task => task.name === head)!, tail };
	}
	if (matches.length > 1) {
		const ids = matches.map(runner => runner.id).join(", ");
		throw new ToolError(
			`Task \`${head}\` exists in multiple runners (${ids}). Use \`<runner-id>:<task>\`, for example \`${matches[0]!.id}:${head}\`. Available tasks:\n${formatAvailableTasks(runners)}`,
		);
	}

	throw new ToolError(
		`No runner task named \`${head}\`. Use one of the available runner ids (${formatRunnerIds(runners)}) as a prefix when needed, e.g. \`pkg:${head}\`. Available tasks:\n${formatAvailableTasks(runners)}`,
	);
}

export function resolveCommand(op: string, runners: DetectedRunner[]): string {
	const { runner, task, tail } = resolveRunnerAndTask(op, runners);
	return buildCommand(task.commandPrefix ?? runner.commandPrefix, task.commandName ?? task.name, tail);
}

export function commandFromOp(op: string | undefined, runners: DetectedRunner[]): string | undefined {
	if (!op) return undefined;
	try {
		return resolveCommand(op, runners);
	} catch {
		return undefined;
	}
}

export function titleFromOp(op: string | undefined, runners: DetectedRunner[]): string {
	if (!op) return "Run";
	const { head } = parseOp(op);
	if (!head) return "Run";
	const colonIndex = head.indexOf(":");
	if (colonIndex > 0) {
		const runner = findRunnerById(head.slice(0, colonIndex), runners);
		return runner?.label ?? "Run";
	}
	const matches = findMatchingRunners(head, runners);
	return matches.length === 1 ? matches[0]!.label : "Run";
}

function findAmbiguityExample(runners: DetectedRunner[]): { runner: string; task: string } | undefined {
	const seen = new Map<string, string>();
	for (const runner of runners) {
		for (const task of runner.tasks) {
			const previousRunner = seen.get(task.name);
			if (previousRunner) return { runner: previousRunner, task: task.name };
			seen.set(task.name, runner.id);
		}
	}
	const firstRunner = runners[0];
	const firstTask = firstRunner?.tasks[0];
	return firstRunner && firstTask ? { runner: firstRunner.id, task: firstTask.name } : undefined;
}

export function buildPromptModel(runners: DetectedRunner[]): RunCommandPromptModel {
	const ambiguityExample = findAmbiguityExample(runners);
	return {
		hasMultipleRunners: runners.length > 1,
		ambiguityExampleRunner: ambiguityExample?.runner,
		ambiguityExampleTask: ambiguityExample?.task,
		runners: runners.map(runner => ({
			id: runner.id,
			label: runner.label,
			commandPrefix: runner.commandPrefix,
			tasks: runner.tasks.map(task => ({
				name: task.name,
				paramSig: task.parameters.length > 0 ? task.parameters.join(" ") : undefined,
				command: buildCommand(task.commandPrefix ?? runner.commandPrefix, task.commandName ?? task.name, ""),
				doc: task.doc,
			})),
		})),
	};
}
