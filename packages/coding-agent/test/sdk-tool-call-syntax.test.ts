import { describe, expect, it } from "bun:test";
import { resolveToolCallSyntax } from "@oh-my-pi/pi-coding-agent/sdk";

describe("resolveToolCallSyntax", () => {
	it("uses GLM in auto mode only for models known not to support native tools", () => {
		expect(resolveToolCallSyntax("auto", { supportsTools: false })).toBe("glm");
		expect(resolveToolCallSyntax("auto", { supportsTools: true })).toBeUndefined();
		expect(resolveToolCallSyntax("auto", {})).toBeUndefined();
		expect(resolveToolCallSyntax("auto", undefined)).toBeUndefined();
	});

	it("keeps native unset and passes explicit in-band syntaxes through", () => {
		expect(resolveToolCallSyntax("native", { supportsTools: false })).toBeUndefined();
		expect(resolveToolCallSyntax("qwen3", undefined)).toBe("qwen3");
	});
});
