import { afterEach, describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { Settings } from "../../src/config/settings";
import { TaskTool } from "../../src/task";
import * as discoveryModule from "../../src/task/discovery";
import type { TaskParams } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const TEST_AGENTS = [
	{
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled" as const,
	},
];

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

describe("task.simple", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("removes only the custom schema input in schema-free mode", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(createSession({ "task.simple": "schema-free" }));
		const properties = getSchemaProperties(tool);

		expect(properties.context).toBeDefined();
		expect(properties.schema).toBeUndefined();
		expect(tool.description).toContain("`context` or `assignment`");
		expect(tool.description).toContain("- `context`:");
		expect(tool.description).not.toContain("- `schema`:");
	});

	it("removes both context and schema inputs in independent mode", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(createSession({ "task.simple": "independent" }));
		const properties = getSchemaProperties(tool);

		expect(properties.context).toBeUndefined();
		expect(properties.schema).toBeUndefined();
		expect(tool.description).toContain("each `assignment`");
		expect(tool.description).not.toContain("- `context`:");
		expect(tool.description).not.toContain("- `schema`:");
	});

	it("rejects direct schema and context fields when the mode disables them", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: TEST_AGENTS,
			projectAgentsDir: null,
		});

		const schemaFreeTool = await TaskTool.create(createSession({ "task.simple": "schema-free" }));
		const schemaFreeResult = await schemaFreeTool.execute("tool-1", {
			agent: "task",
			schema: '{"properties":{"ok":{"type":"boolean"}}}',
			tasks: [{ id: "One", description: "label", assignment: "Do the thing." }],
		} as TaskParams);
		expect(getFirstText(schemaFreeResult)).toContain("does not accept `schema`");
		const validatedSchemaFreeParams = validateToolArguments(schemaFreeTool, {
			type: "toolCall",
			id: "tool-1-validated",
			name: schemaFreeTool.name,
			arguments: {
				agent: "task",
				schema: '{"properties":{"ok":{"type":"boolean"}}}',
				tasks: [{ id: "One", description: "label", assignment: "Do the thing." }],
			},
		});
		const validatedSchemaFreeResult = await schemaFreeTool.execute("tool-1-validated", validatedSchemaFreeParams);
		expect(getFirstText(validatedSchemaFreeResult)).toContain("does not accept `schema`");

		const independentTool = await TaskTool.create(createSession({ "task.simple": "independent" }));
		const independentResult = await independentTool.execute("tool-2", {
			agent: "task",
			context: "Shared background",
			tasks: [{ id: "Two", description: "label", assignment: "Do the independent thing." }],
		} as TaskParams);
		expect(getFirstText(independentResult)).toContain("does not accept `context`");
		const validatedIndependentParams = validateToolArguments(independentTool, {
			type: "toolCall",
			id: "tool-2-validated",
			name: independentTool.name,
			arguments: {
				agent: "task",
				context: "Shared background",
				tasks: [{ id: "Two", description: "label", assignment: "Do the independent thing." }],
			},
		});
		const validatedIndependentResult = await independentTool.execute("tool-2-validated", validatedIndependentParams);
		expect(getFirstText(validatedIndependentResult)).toContain("does not accept `context`");
	});
});
