import { afterEach, describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const TEST_AGENTS = [
	{
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled" as const,
	},
];

const ALL_MODES = ["default", "schema-free", "independent"] as const;

function createSession(overrides: Partial<Record<string, unknown>> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(overrides),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
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

function mockDiscovery(): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: TEST_AGENTS,
		projectAgentsDir: null,
	});
}

describe("task.simple", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exposes the custom schema input only in default mode", async () => {
		mockDiscovery();

		const defaultTool = await TaskTool.create(createSession({ "task.simple": "default" }));
		expect(getSchemaProperties(defaultTool).schema).toBeDefined();
		expect(defaultTool.description).toContain("- `schema`:");

		for (const mode of ["schema-free", "independent"] as const) {
			const tool = await TaskTool.create(createSession({ "task.simple": mode }));
			expect(getSchemaProperties(tool).schema).toBeUndefined();
			expect(tool.description).not.toContain("- `schema`:");
		}
	});

	it("never exposes batch tasks or shared context inputs in any mode", async () => {
		mockDiscovery();

		for (const mode of ALL_MODES) {
			const tool = await TaskTool.create(createSession({ "task.simple": mode }));
			const properties = getSchemaProperties(tool);
			expect(properties.tasks).toBeUndefined();
			expect(properties.context).toBeUndefined();
			// The flat single-spawn contract is what replaced them.
			expect(properties.assignment).toBeDefined();
			expect(properties.resume).toBeDefined();
		}
	});

	it("describes the non-blocking spawn and resume contract", async () => {
		mockDiscovery();

		const tool = await TaskTool.create(createSession({ "task.simple": "default" }));
		expect(tool.description).toContain("Spawning is non-blocking");
		expect(tool.description).toContain("revives an idle/parked agent");
	});

	it("rejects a direct schema input when the mode disables it", async () => {
		mockDiscovery();

		for (const mode of ["schema-free", "independent"] as const) {
			const tool = await TaskTool.create(createSession({ "task.simple": mode }));

			// Execution-time guard: raw params carrying `schema` are refused.
			const result = await tool.execute(`tool-${mode}`, {
				agent: "task",
				id: "One",
				description: "label",
				assignment: "Do the thing.",
				schema: '{"properties":{"ok":{"type":"boolean"}}}',
			} as TaskParams);
			expect(getFirstText(result)).toContain("does not accept `schema`");

			// Round-trip guard: wire validation passes the extraneous `schema`
			// through, so the execution-time check must still refuse it.
			const validated = validateToolArguments(tool, {
				type: "toolCall",
				id: `tool-${mode}-validated`,
				name: tool.name,
				arguments: {
					agent: "task",
					id: "One",
					description: "label",
					assignment: "Do the thing.",
					schema: '{"properties":{"ok":{"type":"boolean"}}}',
				},
			}) as TaskParams;
			const validatedResult = await tool.execute(`tool-${mode}-validated`, validated);
			expect(getFirstText(validatedResult)).toContain("does not accept `schema`");
		}
	});
});
