import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "open-multi-agent-kit";
import { afterEach, describe, expect, it } from "vitest";

interface SmokeToolResult {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly details?: unknown;
	readonly isError?: boolean;
}

interface SmokeTool {
	resolveTimeoutMs?(context: { thinkingLevel?: string }): number | undefined;
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal,
		onUpdate: undefined,
		context: unknown,
	): Promise<SmokeToolResult>;
}

interface SmokeDetails {
	readonly mode: string;
	readonly results: readonly {
		readonly output?: string;
		readonly exitCode: number;
		readonly deadline?: { readonly outcome: string; readonly attempts: readonly unknown[] };
	}[];
	readonly executionBudget: {
		readonly unbounded?: boolean;
		readonly hardDeadlineMs: number;
		readonly plannedShards: number;
		readonly completedShards: number;
		readonly resumeCount: number;
	};
	readonly graph?: { readonly waves: readonly (readonly string[])[]; readonly completedNodeIds: readonly string[] };
}

const cleanupPaths: string[] = [];
const originalArgvEntry = process.argv[1];
const originalAgentDir = process.env.OMK_CODING_AGENT_DIR;
const originalExpectedModel = process.env.OMK_EXPECTED_MODEL;

afterEach(async () => {
	process.argv[1] = originalArgvEntry;
	if (originalAgentDir === undefined) delete process.env.OMK_CODING_AGENT_DIR;
	else process.env.OMK_CODING_AGENT_DIR = originalAgentDir;
	if (originalExpectedModel === undefined) delete process.env.OMK_EXPECTED_MODEL;
	else process.env.OMK_EXPECTED_MODEL = originalExpectedModel;
	await Promise.all(cleanupPaths.splice(0).map((entry) => fs.promises.rm(entry, { recursive: true, force: true })));
});

describe("subagent extension registration and spawn smoke", () => {
	it("inherits the selected session model across the managed process boundary", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omk-subagent-extension-smoke-"));
		cleanupPaths.push(cwd);
		const projectAgentsDir = path.join(cwd, ".omk", "agents");
		const agentHome = path.join(cwd, "agent-home");
		await fs.promises.mkdir(projectAgentsDir, { recursive: true });
		await fs.promises.mkdir(agentHome, { recursive: true });
		await fs.promises.writeFile(
			path.join(projectAgentsDir, "fixture-agent.md"),
			"---\nname: fixture-agent\ndescription: Offline extension smoke fixture\n---\nReturn the fixture result.\n",
			"utf8",
		);
		process.argv[1] = path.join(import.meta.dirname, "fixtures", "fake-omk-json.mjs");
		process.env.OMK_CODING_AGENT_DIR = agentHome;
		process.env.OMK_EXPECTED_MODEL = "openai-codex/session-selected-model";

		let registered: unknown;
		const api = {
			registerTool(tool: unknown) {
				registered = tool;
			},
		} as unknown as ExtensionAPI;
		const { default: registerSubagent } = await import("./index.ts");
		registerSubagent(api);
		if (!isSmokeTool(registered)) throw new Error("subagent tool was not registered");

		const result = await registered.execute(
			"fixture-call",
			{
				agent: "fixture-agent",
				task: "Run the offline fixture.",
				agentScope: "project",
				confirmProjectAgents: false,
				executionBudgetMs: 120_000,
				maxResumeAttempts: 1,
			},
			new AbortController().signal,
			undefined,
			{ cwd, hasUI: false, model: { provider: "openai-codex", id: "session-selected-model" } },
		);
		const details = result.details as SmokeDetails;

		expect(result.isError).not.toBe(true);
		expect(result.content[0]?.text).toContain("fixture subagent completed");
		expect(details.mode).toBe("single");
		expect(details.results[0]).toMatchObject({
			exitCode: 0,
			output: "fixture subagent completed",
			deadline: { outcome: "completed" },
		});
		expect(details.results[0]?.deadline?.attempts).toHaveLength(1);
		expect(details.executionBudget).toMatchObject({
			hardDeadlineMs: 120_000,
			plannedShards: 1,
			completedShards: 1,
			resumeCount: 0,
		});
		expect(await fs.promises.stat(path.join(agentHome, "state", "subagent-deadline-profiles.json"))).toBeDefined();
	}, 120_000);

	it("prefers an explicit agent model over the inherited session model", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omk-subagent-model-smoke-"));
		cleanupPaths.push(cwd);
		const projectAgentsDir = path.join(cwd, ".omk", "agents");
		const agentHome = path.join(cwd, "agent-home");
		await fs.promises.mkdir(projectAgentsDir, { recursive: true });
		await fs.promises.mkdir(agentHome, { recursive: true });
		await fs.promises.writeFile(
			path.join(projectAgentsDir, "fixture-agent.md"),
			"---\nname: fixture-agent\ndescription: Offline extension smoke fixture\nmodel: agent-pinned-model\n---\nReturn the fixture result.\n",
			"utf8",
		);
		process.argv[1] = path.join(import.meta.dirname, "fixtures", "fake-omk-json.mjs");
		process.env.OMK_CODING_AGENT_DIR = agentHome;
		process.env.OMK_EXPECTED_MODEL = "agent-pinned-model";

		let registered: unknown;
		const api = {
			registerTool(tool: unknown) {
				registered = tool;
			},
		} as unknown as ExtensionAPI;
		const { default: registerSubagent } = await import("./index.ts");
		registerSubagent(api);
		if (!isSmokeTool(registered)) throw new Error("subagent tool was not registered");

		const result = await registered.execute(
			"fixture-model-call",
			{
				agent: "fixture-agent",
				task: "Run the pinned-model fixture.",
				agentScope: "project",
				confirmProjectAgents: false,
			},
			new AbortController().signal,
			undefined,
			{ cwd, hasUI: false, model: { id: "session-selected-model" } },
		);

		expect(result.isError).not.toBe(true);
		expect(result.content[0]?.text).toContain("fixture subagent completed");
	}, 120_000);

	it("runs validated graph waves and records the graph plan", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omk-subagent-graph-smoke-"));
		cleanupPaths.push(cwd);
		const projectAgentsDir = path.join(cwd, ".omk", "agents");
		const agentHome = path.join(cwd, "agent-home");
		await fs.promises.mkdir(projectAgentsDir, { recursive: true });
		await fs.promises.mkdir(agentHome, { recursive: true });
		await fs.promises.writeFile(
			path.join(projectAgentsDir, "fixture-agent.md"),
			"---\nname: fixture-agent\ndescription: Offline extension smoke fixture\n---\nReturn the fixture result.\n",
			"utf8",
		);
		process.argv[1] = path.join(import.meta.dirname, "fixtures", "fake-omk-json.mjs");
		process.env.OMK_CODING_AGENT_DIR = agentHome;

		let registered: unknown;
		const api = {
			registerTool(tool: unknown) {
				registered = tool;
			},
		} as unknown as ExtensionAPI;
		const { default: registerSubagent } = await import("./index.ts");
		registerSubagent(api);
		if (!isSmokeTool(registered)) throw new Error("subagent tool was not registered");

		const result = await registered.execute(
			"fixture-graph-call",
			{
				graph: [
					{ id: "research-a", agent: "fixture-agent", task: "Research A." },
					{ id: "research-b", agent: "fixture-agent", task: "Research B." },
					{
						id: "synthesize",
						agent: "fixture-agent",
						task: "Synthesize:\n{dependencies}",
						dependsOn: ["research-a", "research-b"],
					},
				],
				agentScope: "project",
				confirmProjectAgents: false,
				executionBudgetMs: 120_000,
			},
			new AbortController().signal,
			undefined,
			{ cwd, hasUI: false },
		);
		const details = result.details as SmokeDetails;

		expect(result.isError).not.toBe(true);
		expect(details.mode).toBe("graph");
		expect(details.results).toHaveLength(3);
		expect(details.graph).toEqual({
			waves: [["research-a", "research-b"], ["synthesize"]],
			completedNodeIds: ["research-a", "research-b", "synthesize"],
		});
	}, 120_000);

	it("honors an explicit internal execution budget in Ultra while removing parallel limits", async () => {
		const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omk-subagent-ultra-smoke-"));
		cleanupPaths.push(cwd);
		const projectAgentsDir = path.join(cwd, ".omk", "agents");
		const agentHome = path.join(cwd, "agent-home");
		await fs.promises.mkdir(projectAgentsDir, { recursive: true });
		await fs.promises.mkdir(agentHome, { recursive: true });
		await fs.promises.writeFile(
			path.join(projectAgentsDir, "fixture-agent.md"),
			"---\nname: fixture-agent\ndescription: Offline extension smoke fixture\n---\nReturn the fixture result.\n",
			"utf8",
		);
		process.argv[1] = path.join(import.meta.dirname, "fixtures", "fake-omk-json.mjs");
		process.env.OMK_CODING_AGENT_DIR = agentHome;

		let registered: unknown;
		const api = {
			registerTool(tool: unknown) {
				registered = tool;
			},
		} as unknown as ExtensionAPI;
		const { default: registerSubagent } = await import("./index.ts");
		registerSubagent(api);
		if (!isSmokeTool(registered)) throw new Error("subagent tool was not registered");

		expect(registered.resolveTimeoutMs?.({ thinkingLevel: "ultra" })).toBe(0);
		const result = await registered.execute(
			"fixture-ultra-call",
			{
				tasks: Array.from({ length: 9 }, (_, index) => ({
					agent: "fixture-agent",
					task: `Run bounded offline fixture ${index + 1}.`,
				})),
				agentScope: "project",
				confirmProjectAgents: false,
				executionBudgetMs: 120_000,
				maxResumeAttempts: 1,
			},
			new AbortController().signal,
			undefined,
			{ cwd, hasUI: false, thinkingLevel: "ultra" },
		);
		const details = result.details as SmokeDetails;

		expect(result.isError).not.toBe(true);
		expect(details.mode).toBe("parallel");
		expect(details.results).toHaveLength(9);
		expect(details.results.map((entry) => ({ exitCode: entry.exitCode, outcome: entry.deadline?.outcome }))).toEqual(
			Array.from({ length: 9 }, () => ({ exitCode: 0, outcome: "completed" })),
		);
		expect(details.executionBudget).toMatchObject({
			unbounded: false,
			hardDeadlineMs: 120_000,
			plannedShards: 9,
			completedShards: 9,
		});
	}, 120_000);
});

function isSmokeTool(value: unknown): value is SmokeTool {
	return typeof value === "object" && value !== null && "execute" in value && typeof value.execute === "function";
}
