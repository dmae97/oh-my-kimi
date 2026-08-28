import { describe, expect, it } from "vitest";
import { DEFAULT_BUILTIN_TOOL_TIMEOUTS } from "../src/core/agent-tool-settings.ts";
import { createBashTool } from "../src/core/tools/bash.ts";

/**
 * The bash tool's advertised timeout must match the one the runtime enforces.
 *
 * A model only asks for a longer timeout when it knows a limit exists. The
 * schema used to say "no default timeout" while `DEFAULT_BUILTIN_TOOL_TIMEOUTS`
 * capped bash at five minutes, so long-running work — downloading a dataset,
 * training a model — was killed mid-command with nothing in the prompt that
 * would have prompted the model to raise the bound. Two Terminal-Bench tasks
 * (`caffe-cifar-10`, `train-fasttext`) were lost exactly this way.
 *
 * These tests pin the description to the constant so the two cannot drift apart
 * again.
 */
describe("bash tool timeout disclosure", () => {
	const timeoutDescription = (): string => {
		const tool = createBashTool(process.cwd());
		const properties = (tool.parameters as { properties?: Record<string, { description?: string }> }).properties;
		return properties?.timeout?.description ?? "";
	};

	it("documents a default rather than claiming there is none", () => {
		expect(timeoutDescription()).not.toMatch(/no default timeout/i);
	});

	it("states the default the runtime actually enforces", () => {
		const defaultSeconds = DEFAULT_BUILTIN_TOOL_TIMEOUTS.bash / 1000;
		expect(timeoutDescription()).toContain(String(defaultSeconds));
	});

	it("keeps the parameter optional", () => {
		const tool = createBashTool(process.cwd());
		const required = (tool.parameters as { required?: string[] }).required ?? [];
		expect(required).not.toContain("timeout");
	});

	it("exposes a positive bash default for the loop to enforce", () => {
		expect(DEFAULT_BUILTIN_TOOL_TIMEOUTS.bash).toBeGreaterThan(0);
	});
});
