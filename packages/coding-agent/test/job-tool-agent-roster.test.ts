/**
 * The `job` tool's snapshot contract: `list` and empty-poll results must never
 * come back as empty text, and they must surface running subagents that have
 * no backing job (irc-woken/revived agents, spawns owned by another agent) so
 * the tool's picture matches the UI's running-agent count. Regression for the
 * QA report "job list returned no status output despite known running
 * background jobs and subagents".
 */
import { afterEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { JobTool } from "@oh-my-pi/pi-coding-agent/tools/job";

const managers: AsyncJobManager[] = [];

function createManager(): AsyncJobManager {
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	managers.push(manager);
	return manager;
}

function createToolSession(options: {
	manager?: AsyncJobManager;
	registry?: AgentRegistry;
	agentId?: string;
}): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: {
			get: (key: string) => (key === "async.pollWaitDuration" ? "5s" : undefined),
		},
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getAgentId: () => options.agentId ?? null,
		asyncJobManager: options.manager,
		agentRegistry: options.registry,
	} as unknown as ToolSession;
}

function registerRunningSub(registry: AgentRegistry, id: string, parentId = "Main"): void {
	registry.register({ id, displayName: id, kind: "sub", parentId, session: null });
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

const neverResolves = () => new Promise<string>(() => {});

afterEach(async () => {
	for (const manager of managers.splice(0)) {
		await manager.dispose({ timeoutMs: 200 });
	}
});

describe("job list snapshot", () => {
	test("empty list reports 'no jobs' instead of empty output", async () => {
		const tool = new JobTool(createToolSession({ manager: createManager(), agentId: "Main" }));

		const result = await tool.execute("call", { list: true });

		expect(resultText(result)).toBe("No background jobs.");
		expect(result.details?.jobs).toEqual([]);
	});

	test("list surfaces running subagents that have no backing job", async () => {
		const registry = new AgentRegistry();
		registerRunningSub(registry, "Worker");
		registerRunningSub(registry, "Idler");
		registry.setStatus("Idler", "idle");
		registry.register({ id: "advisor", displayName: "advisor", kind: "advisor", session: null });
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		const tool = new JobTool(createToolSession({ manager: createManager(), registry, agentId: "Main" }));

		const result = await tool.execute("call", { list: true });

		expect(result.details?.agents?.map(agent => agent.id)).toEqual(["Worker"]);
		const text = resultText(result);
		expect(text).toContain("Running Agents (1)");
		expect(text).toContain("Worker");
		expect(result.useless).toBeUndefined();
	});

	test("agents covered by the caller's running jobs are not double-listed", async () => {
		const manager = createManager();
		const registry = new AgentRegistry();
		// Task-style spawn: job id == agent id.
		manager.register("task", "AgentA", neverResolves, { id: "AgentA", agentId: "AgentA", ownerId: "Main" });
		registerRunningSub(registry, "AgentA");
		// Vibe-style turn job: job id differs from the agent id; linkage via agentId.
		manager.register("task", "vibe turn", neverResolves, { id: "vibe-1-t1", agentId: "vibe-1", ownerId: "Main" });
		registerRunningSub(registry, "vibe-1");
		// Woken via irc: running agent with no job at all.
		registerRunningSub(registry, "Loner");
		const tool = new JobTool(createToolSession({ manager, registry, agentId: "Main" }));

		const result = await tool.execute("call", { list: true });

		expect(result.details?.jobs.map(job => job.id).sort()).toEqual(["AgentA", "vibe-1-t1"]);
		expect(result.details?.agents?.map(agent => agent.id)).toEqual(["Loner"]);
		manager.cancel("AgentA");
		manager.cancel("vibe-1-t1");
	});

	test("a settled job in retention does not hide its re-woken agent", async () => {
		const manager = createManager();
		const registry = new AgentRegistry();
		manager.register("task", "AgentB", async () => "done", { id: "AgentB", agentId: "AgentB", ownerId: "Main" });
		await manager.waitForAll();
		// The agent was re-woken (e.g. via irc) after its job completed.
		registerRunningSub(registry, "AgentB");
		const tool = new JobTool(createToolSession({ manager, registry, agentId: "Main" }));

		const result = await tool.execute("call", { list: true });

		expect(result.details?.jobs.find(job => job.id === "AgentB")?.status).toBe("completed");
		expect(result.details?.agents?.map(agent => agent.id)).toEqual(["AgentB"]);
	});
});

describe("job poll with no matching jobs", () => {
	test("bare poll with nothing running stays a useless no-op message", async () => {
		const tool = new JobTool(createToolSession({ manager: createManager(), agentId: "Main" }));

		const result = await tool.execute("call", {});

		expect(resultText(result)).toBe("No running background jobs to wait for.");
		expect(result.useless).toBe(true);
	});

	test("bare poll reports running agents outside job control", async () => {
		const registry = new AgentRegistry();
		registerRunningSub(registry, "Worker");
		const tool = new JobTool(createToolSession({ manager: createManager(), registry, agentId: "Main" }));

		const result = await tool.execute("call", {});

		const text = resultText(result);
		expect(text).toContain("No running background jobs to wait for.");
		expect(text).toContain("Worker");
		expect(result.details?.agents?.map(agent => agent.id)).toEqual(["Worker"]);
		expect(result.useless).toBeUndefined();
	});

	test("polling an agent id that has no job explains the agent's state", async () => {
		const registry = new AgentRegistry();
		registerRunningSub(registry, "Worker");
		const tool = new JobTool(createToolSession({ manager: createManager(), registry, agentId: "Main" }));

		const result = await tool.execute("call", { poll: ["Worker"] });

		const text = resultText(result);
		expect(text).toContain("No matching jobs found for IDs: Worker");
		expect(text).toContain("running agent with no job entry");
		expect(text).toContain("history://Worker");
	});
});
