import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import { runEvalAgent } from "../../src/eval/agent-bridge";
import type { LocalProtocolOptions } from "../../src/internal-urls";
import type { MCPManager } from "../../src/mcp";
import * as taskDiscovery from "../../src/task/discovery";
import * as taskExecutor from "../../src/task/executor";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

function createResult(): SingleResult {
	return {
		index: 0,
		id: "0-Task",
		agent: "task",
		agentSource: "bundled",
		task: "do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
	};
}

describe("runEvalAgent", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards session-scoped MCP and local protocol options", async () => {
		const agent: AgentDefinition = {
			name: "task",
			description: "Task agent",
			systemPrompt: "Handle task",
			source: "bundled",
		};
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult());

		const mcpManager = { sentinel: "mcp" } as unknown as MCPManager;
		const localProtocolOptions: LocalProtocolOptions = {
			getArtifactsDir: () => "/tmp/parent-artifacts",
			getSessionId: () => "parent-session",
		};
		const session = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
			mcpManager,
			localProtocolOptions,
		} as unknown as ToolSession;

		await runEvalAgent({ prompt: "do work", agentType: "task" }, { session });

		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		const options = runSubprocessSpy.mock.calls[0]?.[0];
		expect(options?.mcpManager).toBe(mcpManager);
		expect(options?.localProtocolOptions).toBe(localProtocolOptions);
	});
});
