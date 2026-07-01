import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../config/settings";
import type { ToolSession } from "../tools";
import * as taskDiscovery from "./discovery";
import { TaskTool } from "./index";
import type { AgentDefinition } from "./types";
import { getTaskSchema } from "./types";

const factFinderAgent = {
	name: "fact-finder",
	description: "Find facts.",
	systemPrompt: "Find facts.",
	source: "project",
} satisfies AgentDefinition;

const oracleAgent = {
	name: "oracle",
	description: "Answer hard questions.",
	systemPrompt: "Answer hard questions.",
	source: "bundled",
} satisfies AgentDefinition;

function makeSession(spawns: string): ToolSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.batch": true,
		"task.isolation.mode": "none",
	});
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => spawns,
	};
}

describe("task spawn policy surfaces", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses the first allowed spawn as the schema default", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false, defaultAgent: "fact-finder" });
		const parsed = schema({ assignment: "check" });

		expect(parsed).toEqual({ agent: "fact-finder", assignment: "check" });
	});

	it("renders the restricted spawn default in the task description", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [factFinderAgent, oracleAgent],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(makeSession("fact-finder,oracle"));
		const description = tool.description;

		expect(description).toContain("Defaults to `fact-finder`");
		expect(description).toContain("Current spawn policy allows: `fact-finder`, `oracle`.");
		expect(description).not.toContain("Defaults to `task`");
	});
});
