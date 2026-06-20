import { describe, expect, it, mock } from "bun:test";
import { type Context, z } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Agent } from "../src/agent";
import type { AgentTool } from "../src/types";

describe("Agent — buildSideRequestContext", () => {
	const model = createMockModel({ responses: [] });
	const tool: AgentTool = {
		name: "test_tool",
		label: "Test Tool",
		description: "a cool tool",
		parameters: z.object({ arg: z.string() }) as unknown as AgentTool["parameters"],
		execute: async () => ({ content: [{ type: "text", text: "success" }], details: { value: "success" } }),
	};

	it("forwards the tool catalog for native providers", () => {
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["system"],
				tools: [tool],
			},
		});

		const context = agent.buildSideRequestContext([
			{ role: "user", content: [{ type: "text", text: "Q?" }], timestamp: Date.now() },
		]);

		expect(context.tools).toBeDefined();
		expect(context.tools!.length).toBe(1);
		expect(context.tools![0].name).toBe("test_tool");
		expect(context.systemPrompt).toEqual(["system"]);
	});

	it("returns empty tools when owned dialect is active", () => {
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["system"],
				tools: [tool],
			},
			dialect: "glm",
		});

		const context = agent.buildSideRequestContext([
			{ role: "user", content: [{ type: "text", text: "Q?" }], timestamp: Date.now() },
		]);

		expect(context.tools).toEqual([]);
		expect(context.systemPrompt).toEqual(["system"]);
	});

	it("invokes transformProviderContext filter if present", () => {
		const transformSpy = mock((ctx: Context): Context => {
			return {
				...ctx,
				systemPrompt: ["transformed-system"],
			};
		});

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["system"],
				tools: [tool],
			},
			transformProviderContext: transformSpy,
		});

		const context = agent.buildSideRequestContext([
			{ role: "user", content: [{ type: "text", text: "Q?" }], timestamp: Date.now() },
		]);

		expect(transformSpy).toHaveBeenCalledTimes(1);
		expect(context.systemPrompt).toEqual(["transformed-system"]);
	});
});
