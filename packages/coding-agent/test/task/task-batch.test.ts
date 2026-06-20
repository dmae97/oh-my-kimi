/**
 * Contracts: task.batch gating (batch spawning + shared context).
 *
 * 1. The wire schema is shape-swapped by `task.batch`: `{ agent, context,
 *    tasks[] }` when on (per-spawn fields — including `isolated` — live in the
 *    items), the flat `{ agent, ...item }` when off. Neither shape exposes a
 *    per-call `schema` input (structured output comes from agent frontmatter /
 *    inherited session schema / eval agent()).
 * 2. Shape validation rejects `schema` always, `tasks`/`context` while batch
 *    is disabled, top-level `assignment` in batch calls, empty/invalid items,
 *    duplicate ids, and a missing shared `context`.
 * 3. With `async.enabled=true`, a batch call registers one background job per
 *    item; with `async.enabled=false`, it blocks and returns merged results.
 *    Both modes forward the shared `context`; the flat form stays accepted at
 *    runtime for internal callers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function createSession(
	options: { manager?: AsyncJobManager; settings?: Record<string, unknown>; agentId?: string } = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => options.agentId ?? null,
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function getSchemaProperties(tool: TaskTool): Record<string, unknown> {
	const wire = toolWireSchema(tool) as { properties?: Record<string, unknown> };
	return wire.properties ?? {};
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function mockDiscovery(): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [taskAgent],
		projectAgentsDir: null,
	});
}

describe("task.batch schema gating", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("swaps between the flat and batch wire shapes", async () => {
		mockDiscovery();

		const off = await TaskTool.create(createSession({ settings: { "task.batch": false } }));
		const offProperties = getSchemaProperties(off);
		expect(offProperties.tasks).toBeUndefined();
		expect(offProperties.context).toBeUndefined();
		expect(offProperties.assignment).toBeDefined();
		expect(offProperties.id).toBeDefined();

		const on = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		const onProperties = getSchemaProperties(on);
		expect(onProperties.tasks).toBeDefined();
		expect(onProperties.context).toBeDefined();
		// The batch shape is { agent, context, tasks[] } — the per-spawn fields
		// live only inside the task items.
		expect(onProperties.assignment).toBeUndefined();
		expect(onProperties.id).toBeUndefined();
		expect(onProperties.description).toBeUndefined();
		const items = (onProperties.tasks as { items?: { properties?: Record<string, unknown> } }).items;
		expect(items?.properties?.assignment).toBeDefined();
		expect(items?.properties?.id).toBeDefined();
	});

	it("places isolated per item in the batch shape when isolation is enabled", async () => {
		mockDiscovery();

		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "task.isolation.mode": "auto" } }),
		);
		const properties = getSchemaProperties(tool);
		expect(properties.isolated).toBeUndefined();
		const items = (properties.tasks as { items?: { properties?: Record<string, unknown> } }).items;
		expect(items?.properties?.isolated).toBeDefined();
	});

	it("never exposes a per-call schema input", async () => {
		mockDiscovery();

		for (const settings of [{ "task.batch": false }, { "task.batch": true }]) {
			const tool = await TaskTool.create(createSession({ settings }));
			expect(getSchemaProperties(tool).schema).toBeUndefined();
		}
	});
});

describe("task.batch validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function executeText(params: unknown, settings: Record<string, unknown> = {}): Promise<string> {
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings }));
		const result = await tool.execute("tool-call", params);
		return getFirstText(result);
	}

	it("rejects a schema argument regardless of batch mode", async () => {
		for (const batch of [false, true]) {
			const text = await executeText(
				{ agent: "task", assignment: "Work.", schema: '{"properties":{}}' },
				{ "task.batch": batch },
			);
			expect(text).toContain("does not accept `schema`");
		}
	});

	it("rejects tasks and context while task.batch is disabled", async () => {
		const disabled = { "task.batch": false };
		const text = await executeText({ agent: "task", tasks: [{ assignment: "Work." }] }, disabled);
		expect(text).toContain("task.batch is disabled");

		const contextText = await executeText({ agent: "task", assignment: "Work.", context: "Background." }, disabled);
		expect(contextText).toContain("task.batch is disabled");
	});

	it("rejects top-level assignment in the batch shape", async () => {
		const text = await executeText(
			{ agent: "task", assignment: "Work.", tasks: [{ assignment: "Other." }] },
			{ "task.batch": true },
		);
		expect(text).toContain("not part of the batch shape");
	});

	it("rejects empty task arrays and items without assignments", async () => {
		const empty = await executeText({ agent: "task", tasks: [] }, { "task.batch": true });
		expect(empty).toContain("Missing `tasks`");

		const missing = await executeText(
			{ agent: "task", tasks: [{ assignment: "Work." }, { id: "Beta" }] },
			{ "task.batch": true },
		);
		expect(missing).toContain("Task 2 (`Beta`) is missing `assignment`");
	});

	it("requires a shared context for batch calls", async () => {
		const text = await executeText({ agent: "task", tasks: [{ assignment: "Work." }] }, { "task.batch": true });
		expect(text).toContain("Missing `context`");
	});

	it("rejects duplicate provided ids case-insensitively", async () => {
		const text = await executeText(
			{
				agent: "task",
				tasks: [
					{ id: "Anna", assignment: "A." },
					{ id: "anna", assignment: "B." },
				],
			},
			{ "task.batch": true },
		);
		expect(text).toContain("Duplicate task id");
	});
});

describe("task.batch spawning", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("spawns one background job per task item and forwards the shared context", async () => {
		mockDiscovery();
		const seen: Array<{ id?: string; context?: string; assignment?: string; parentAgentId?: string }> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({
				id: options.id,
				context: options.context,
				assignment: options.assignment,
				parentAgentId: options.parentAgentId,
			});
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, agentId: "ParentA", settings: { "async.enabled": true, "task.batch": true } }),
		);

		const result = await tool.execute("tc-batch", {
			agent: "task",
			context: "# Goal\nShared background.",
			tasks: [
				{ id: "Alpha", description: "first", assignment: "Do A." },
				{ id: "Beta", assignment: "Do B." },
			],
		} as TaskParams);

		const text = getFirstText(result);
		expect(text).toContain("Spawned 2 background agents");
		expect(text).toContain("- `Alpha`");
		expect(text).toContain("- `Beta`");
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha", "Beta"]);
		expect(result.details?.async?.state).toBe("running");

		const alphaJob = manager.getJob("Alpha");
		const betaJob = manager.getJob("Beta");
		expect(alphaJob).toBeDefined();
		expect(betaJob).toBeDefined();
		await alphaJob!.promise;
		await betaJob!.promise;

		expect(alphaJob!.status).toBe("completed");
		expect(betaJob!.status).toBe("completed");
		expect(alphaJob!.resultText).toContain("Alpha is now idle");
		expect(betaJob!.resultText).toContain("history://Beta");

		expect(seen).toHaveLength(2);
		for (const spawn of seen) {
			expect(spawn.context).toBe("# Goal\nShared background.");
		}
		expect(seen.map(spawn => spawn.assignment).sort()).toEqual(["Do A.", "Do B."]);
		// Every spawn is parented to the spawning agent (not to itself): the
		// registry "of <parent>" link must be the caller, never the child's id.
		for (const spawn of seen) expect(spawn.parentAgentId).toBe("ParentA");
	});

	it("treats a one-item batch as a single spawn and forwards context", async () => {
		mockDiscovery();
		let capturedContext: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			capturedContext = options.context;
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
		);

		const result = await tool.execute("tc-single", {
			agent: "task",
			context: "Shared notes.",
			tasks: [{ id: "Solo", assignment: "Do the thing." }],
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned agent `Solo`");
		const job = manager.getJob(result.details!.async!.jobId)!;
		await job.promise;
		expect(job.status).toBe("completed");
		expect(capturedContext).toBe("Shared notes.");
	});

	it("accepts the flat single-spawn form at runtime under batch mode", async () => {
		// Internal callers (e.g. the commit flow) and stale transcripts use the
		// flat shape directly; the wire schema is batch-only but runtime is not.
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? "?"));

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
		);

		const result = await tool.execute("tc-flat", {
			agent: "task",
			id: "Flat",
			assignment: "Do the thing.",
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned agent `Flat`");
		const job = manager.getJob(result.details!.async!.jobId)!;
		await job.promise;
		expect(job.status).toBe("completed");
	});

	it("blocks batch execution when async.enabled is false even with a job manager", async () => {
		mockDiscovery();
		const seen: Array<{ id?: string; context?: string; assignment?: string }> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({ id: options.id, context: options.context, assignment: options.assignment });
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": false, "task.batch": true } }),
		);

		const result = await tool.execute("tc-sync-batch", {
			agent: "task",
			context: "# Goal\nShared synchronous context.",
			tasks: [
				{ id: "Alpha", assignment: "Do A." },
				{ id: "Beta", assignment: "Do B." },
			],
		} as TaskParams);

		expect(getFirstText(result)).toContain("All done.");
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.results.map(item => item.id).sort()).toEqual(["Alpha", "Beta"]);
		expect(manager.getJob("Alpha")).toBeUndefined();
		expect(manager.getJob("Beta")).toBeUndefined();
		expect(seen.map(spawn => spawn.context)).toEqual([
			"# Goal\nShared synchronous context.",
			"# Goal\nShared synchronous context.",
		]);
	});
});
