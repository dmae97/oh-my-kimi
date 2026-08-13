import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

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
