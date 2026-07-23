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
		readonly hardDeadlineMs: number;
		readonly plannedShards: number;
		readonly completedShards: number;
		readonly resumeCount: number;
	};
}

const cleanupPaths: string[] = [];
const originalArgvEntry = process.argv[1];
const originalAgentDir = process.env.OMK_CODING_AGENT_DIR;

afterEach(async () => {
	process.argv[1] = originalArgvEntry;
	if (originalAgentDir === undefined) delete process.env.OMK_CODING_AGENT_DIR;
	else process.env.OMK_CODING_AGENT_DIR = originalAgentDir;
	await Promise.all(cleanupPaths.splice(0).map((entry) => fs.promises.rm(entry, { recursive: true, force: true })));
});

describe("subagent extension registration and spawn smoke", () => {
	it("runs the registered tool through the managed process boundary without a provider API", async () => {
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
			{ cwd, hasUI: false },
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
});

function isSmokeTool(value: unknown): value is SmokeTool {
	return typeof value === "object" && value !== null && "execute" in value && typeof value.execute === "function";
}
