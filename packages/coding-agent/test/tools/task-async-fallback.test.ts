import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
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

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

describe("task.async-fallback", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	it("falls back to sync execution when async is enabled but no manager is registered", async () => {
		// Two-stage spy: the initial discovery during `TaskTool.create` advertises
		// `task` so the tool builds; the executor's later call (inside
		// `#executeSync`) advertises *nothing*, forcing the unique "Unknown agent"
		// message — which is only reachable from the sync codepath. Hitting it
		// proves we fell back instead of returning the old hard error.
		const discoverSpy = vi.spyOn(discoveryModule, "discoverAgents");
		discoverSpy.mockResolvedValueOnce({
			agents: [
				{
					name: "task",
					description: "General-purpose task agent",
					systemPrompt: "You are a task agent.",
					source: "bundled",
				},
			],
			projectAgentsDir: null,
		});
		discoverSpy.mockResolvedValue({ agents: [], projectAgentsDir: null });

		AsyncJobManager.resetForTests();
		expect(AsyncJobManager.instance()).toBeUndefined();

		const tool = await TaskTool.create(createSession({ "async.enabled": true }));

		const result = await tool.execute("tool-1", {
			agent: "task",
			tasks: [{ id: "One", description: "label", assignment: "Do the thing." }],
		} as TaskParams);

		const text = getFirstText(result);
		expect(text).toContain('Unknown agent "task"');
		expect(text).not.toContain("no async job manager is available");
	});
});
