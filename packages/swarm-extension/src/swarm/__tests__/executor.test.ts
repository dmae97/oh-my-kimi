import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry, SingleResult } from "@oh-my-pi/pi-coding-agent";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent";
import { executeSwarmAgent } from "../executor";
import { StateTracker } from "../state";

const mockResult = {
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
} as SingleResult;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("executeSwarmAgent", () => {
	it("does not pass authStorage to runSubprocess when modelRegistry is provided", async () => {
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(mockResult);

		const mockModelRegistry = {
			authStorage: { discover: vi.fn() },
		} as unknown as ModelRegistry;

		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-test-"));
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
