import { describe, expect, it } from "vitest";
import { assembleSessionSystemPrompt } from "../src/core/session-system-prompt.ts";

function input(overrides: Partial<Parameters<typeof assembleSessionSystemPrompt>[0]> = {}) {
	return {
		cwd: "/tmp/project",
		toolNames: ["read", "bash", "ghost"],
		hasTool: (name: string) => name !== "ghost",
		toolPromptSnippets: new Map([
			["read", "Read a file"],
			["bash", "Run a command"],
			["ghost", "never"],
		]),
		toolPromptGuidelines: new Map([
			["read", ["Prefer offset/limit"]],
			["bash", ["Quote paths"]],
		]),
		customPrompt: undefined,
		appendSystemPrompt: ["loader extra"],
		providerAppend: "provider extra",
		skills: [],
		contextFiles: [],
		contextBudget: undefined,
		...overrides,
	};
}

describe("assembleSessionSystemPrompt", () => {
	it("filters unknown tools and keeps registration order for snippets and guidelines", () => {
		const assembled = assembleSessionSystemPrompt(input());
		expect(assembled.options.selectedTools).toEqual(["read", "bash"]);
		expect(assembled.options.toolSnippets).toEqual({ read: "Read a file", bash: "Run a command" });
		expect(assembled.options.promptGuidelines).toEqual(["Prefer offset/limit", "Quote paths"]);
	});

	it("joins loader and provider appends, and omits the section when both are empty", () => {
		expect(assembleSessionSystemPrompt(input()).options.appendSystemPrompt).toBe("loader extra\n\nprovider extra");
		expect(
			assembleSessionSystemPrompt(input({ appendSystemPrompt: [], providerAppend: undefined })).options
				.appendSystemPrompt,
		).toBeUndefined();
		expect(assembleSessionSystemPrompt(input({ appendSystemPrompt: undefined })).options.appendSystemPrompt).toBe(
			"provider extra",
		);
	});

	it("returns the exact options object the plan builder consumed", () => {
		const assembled = assembleSessionSystemPrompt(input());
		expect(assembled.options.cwd).toBe("/tmp/project");
		expect(assembled.prompt).toContain("Prefer offset/limit");
		expect(assembled.prompt).toContain("provider extra");
		expect(assembled.prompt.length).toBeGreaterThan(0);
		expect(assembled.cacheBoundary).toBeGreaterThan(0);
		expect(assembled.cacheBoundary).toBeLessThanOrEqual(assembled.prompt.length);
	});
});
