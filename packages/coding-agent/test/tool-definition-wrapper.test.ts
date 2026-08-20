import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

describe("tool definition wrapper", () => {
	it("resolves a context-sensitive timeout without losing the static fallback", () => {
		let thinkingLevel: ExtensionContext["thinkingLevel"] = "high";
		const definition: ToolDefinition = {
			name: "contextual-timeout",
			label: "Contextual timeout",
			description: "Test tool",
			parameters: Type.Object({}),
			timeoutMs: 123,
			resolveTimeoutMs: (ctx) => (ctx.thinkingLevel === "ultra" ? 0 : undefined),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const tool = wrapToolDefinition(definition, () => ({ thinkingLevel }) as unknown as ExtensionContext);

		expect(tool.timeoutMs).toBe(123);
		thinkingLevel = "ultra";
		expect(tool.timeoutMs).toBe(0);
	});

	it("preserves DAG resource claims through both wrapper directions", async () => {
		const resourceClaims = (_args: unknown, context: { readonly toolCallId: string }) => [
			{ kind: "session" as const, key: `task:${context.toolCallId}`, access: "write" as const },
		];
		const definition: ToolDefinition = {
			name: "claimed-tool",
			label: "Claimed tool",
			description: "Test tool",
			parameters: Type.Object({}),
			resourceClaims,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};

		const tool = wrapToolDefinition(definition);
		const roundTripped = createToolDefinitionFromAgentTool(tool);

		expect(tool.resourceClaims).toBe(resourceClaims);
		expect(await tool.resourceClaims?.({}, { cwd: "/workspace", toolCallId: "call-1" })).toEqual([
			{ kind: "session", key: "task:call-1", access: "write" },
		]);
		expect(roundTripped.resourceClaims).toBe(resourceClaims);
	});

	it.each([Number.NaN, -1, 0.5, 2_147_483_648])("rejects invalid resolved timeout %s", (timeoutMs) => {
		const definition: ToolDefinition = {
			name: "invalid-timeout",
			label: "Invalid timeout",
			description: "Test tool",
			parameters: Type.Object({}),
			resolveTimeoutMs: () => timeoutMs,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const tool = wrapToolDefinition(definition, () => ({}) as unknown as ExtensionContext);

		expect(() => tool.timeoutMs).toThrow('Invalid timeout for extension tool "invalid-timeout"');
	});
});
