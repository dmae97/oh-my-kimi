import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry, SingleResult } from "@oh-my-pi/pi-coding-agent";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent";

// Stub runSubprocess to capture options without actually running an agent
const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue({
	index: 0,
	id: "test-agent-0",
	agent: "test",
	agentSource: "project",
	task: "test task",
	exitCode: 0,
	output: "ok",
	stderr: "",
	truncated: false,
	durationMs: 100,
	tokens: 0,
} as SingleResult);

afterEach(() => {
	runSubprocessSpy.mockClear();
});

describe("executeSwarmAgent", () => {
	it("does not pass authStorage to runSubprocess when modelRegistry is provided", async () => {
		const { executeSwarmAgent } = await import("../executor");
		const { StateTracker } = await import("../state");

		const mockModelRegistry = {
			authStorage: { discover: vi.fn() },
		} as unknown as ModelRegistry;

		const workspace = path.join(os.tmpdir(), "test-workspace");
		const stateTracker = new StateTracker(workspace, "test-swarm");
		await stateTracker.init(["test-agent"], 1, "parallel");

		const agent = {
			name: "test-agent",
			role: "tester",
			task: "do something",
			reportsTo: [],
			waitsFor: [],
		};

		await executeSwarmAgent(agent, 0, {
			workspace,
			swarmName: "test-swarm",
			iteration: 0,
			modelRegistry: mockModelRegistry,
			stateTracker,
		});

		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		const passedOptions = runSubprocessSpy.mock.calls[0][0];
		expect(passedOptions.authStorage).toBeUndefined();
		expect(passedOptions.modelRegistry).toBe(mockModelRegistry);
	});
});
