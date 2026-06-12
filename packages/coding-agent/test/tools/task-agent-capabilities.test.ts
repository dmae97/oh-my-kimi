import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isReadOnlyAgent, TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function createSession(overrides: Partial<Record<string, unknown>> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(overrides),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

function agentByName(agents: AgentDefinition[], name: string): AgentDefinition {
	const agent = agents.find(candidate => candidate.name === name);
	expect(agent).toBeDefined();
	return agent as AgentDefinition;
}

describe("task agent capability descriptions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("classifies bundled explore as the only read-only delegated agent", () => {
		const agents = loadBundledAgents();

		expect(isReadOnlyAgent(agentByName(agents, "explore"))).toBe(true);
		for (const name of ["task", "quick_task", "plan", "reviewer", "oracle", "designer"]) {
			expect(isReadOnlyAgent(agentByName(agents, name))).toBe(false);
		}
	});

	it("disables read summarization for explore and librarian, leaves other agents summarizing", () => {
		const agents = loadBundledAgents();

		expect(agentByName(agents, "explore").readSummarize).toBe(false);
		expect(agentByName(agents, "librarian").readSummarize).toBe(false);
		for (const name of ["task", "quick_task", "plan", "reviewer", "oracle", "designer"]) {
			expect(agentByName(agents, name).readSummarize).toBeUndefined();
		}
	});

	it("marks read-only agents in the task description and keeps full agents unmarked", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [
				{
					name: "read_scout",
					description: "Read-only scout",
					systemPrompt: "Scout the codebase.",
					tools: ["read", "search", "find"],
					source: "project",
				},
				{
					name: "full_agent",
					description: "Full agent",
					systemPrompt: "Modify the codebase.",
					source: "project",
				},
			],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(createSession());
		const description = tool.description;

		expect(description).toContain("# read_scout — READ-ONLY (no edit/write/exec tools)\nRead-only scout");
		expect(description).toContain("# full_agent\nFull agent");
		expect(description).not.toContain("# full_agent — READ-ONLY");
		expect(description).toContain(
			"NEVER offload reasoning, analysis, design, or decision-making to `quick_task` or `explore`",
		);
	});
});
