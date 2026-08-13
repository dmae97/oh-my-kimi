export interface GraphTask {
	readonly id: string;
	readonly agent: string;
	readonly task: string;
	readonly cwd?: string;
	readonly dependsOn?: readonly string[];
}

export interface TaskGraphPlan {
	readonly tasks: ReadonlyMap<string, GraphTask>;
	readonly waves: readonly (readonly string[])[];
}

export class GraphValidationError extends Error {
	constructor(message: string) {
		super(`Invalid task graph: ${message}`);
		this.name = "GraphValidationError";
	}
}

export function planTaskGraph(tasks: readonly GraphTask[]): TaskGraphPlan {
	if (tasks.length === 0) throw new GraphValidationError("at least one node is required");

	const byId = new Map<string, GraphTask>();
	for (const task of tasks) {
		if (task.id.trim() === "") throw new GraphValidationError("node id must not be empty");
		if (byId.has(task.id)) throw new GraphValidationError(`duplicate node id '${task.id}'`);
		byId.set(task.id, task);
	}

	const dependents = new Map<string, string[]>();
	const remainingDependencies = new Map<string, number>();
	for (const task of tasks) {
		const dependencies = new Set(task.dependsOn ?? []);
		if (dependencies.has(task.id)) throw new GraphValidationError(`node '${task.id}' cannot depend on itself`);
		for (const dependency of dependencies) {
			if (!byId.has(dependency)) {
				throw new GraphValidationError(`node '${task.id}' depends on unknown node '${dependency}'`);
			}
			const targets = dependents.get(dependency) ?? [];
			targets.push(task.id);
			dependents.set(dependency, targets);
		}
		remainingDependencies.set(task.id, dependencies.size);
	}

	const waves: string[][] = [];
	let ready = tasks.filter((task) => remainingDependencies.get(task.id) === 0).map((task) => task.id);
	let visited = 0;
	while (ready.length > 0) {
		waves.push(ready);
		visited += ready.length;
		const next = new Set<string>();
		for (const id of ready) {
			for (const dependent of dependents.get(id) ?? []) {
				const remaining = (remainingDependencies.get(dependent) ?? 0) - 1;
				remainingDependencies.set(dependent, remaining);
				if (remaining === 0) next.add(dependent);
			}
		}
		ready = tasks.filter((task) => next.has(task.id)).map((task) => task.id);
	}

	if (visited !== tasks.length) {
		const cycleNodes = tasks.filter((task) => (remainingDependencies.get(task.id) ?? 0) > 0).map((task) => task.id);
		throw new GraphValidationError(`cycle detected: ${cycleNodes.join(", ")}`);
	}
	return { tasks: byId, waves };
}

const MAX_DEPENDENCY_OUTPUT_BYTES = 16 * 1024;

function truncateUtf8(value: string): string {
	const encoded = Buffer.from(value, "utf8");
	if (encoded.length <= MAX_DEPENDENCY_OUTPUT_BYTES) return value;
	const suffix = "\n\n[dependency output truncated]";
	const bodyLimit = MAX_DEPENDENCY_OUTPUT_BYTES - Buffer.byteLength(suffix, "utf8");
	let body = encoded.subarray(0, bodyLimit).toString("utf8");
	if (body.endsWith("�")) body = body.slice(0, -1);
	return `${body}${suffix}`;
}

export function renderDependencyContext(task: GraphTask, outputs: ReadonlyMap<string, string>): string {
	if (!task.task.includes("{dependencies}")) return task.task;
	const context = (task.dependsOn ?? [])
		.map((id) => `### ${id}\n${truncateUtf8(outputs.get(id) ?? "(no output)")}`)
		.join("\n\n");
	return task.task.split("{dependencies}").join(context || "(no dependencies)");
}
