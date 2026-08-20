import { afterEach, describe, expect, it } from "vitest";
import { selectContextFilesForModel } from "../src/core/model-prompt-policy.ts";
import type { ContextFile } from "../src/core/resource-loader.ts";

const originalClaudeContextFiles = process.env.OMK_CLAUDE_CONTEXT_FILES;

const contextFiles: readonly ContextFile[] = [
	{ path: "/workspace/AGENTS.md", content: "Project instructions", isGlobal: false },
];

afterEach(() => {
	if (originalClaudeContextFiles === undefined) {
		delete process.env.OMK_CLAUDE_CONTEXT_FILES;
	} else {
		process.env.OMK_CLAUDE_CONTEXT_FILES = originalClaudeContextFiles;
	}
});

describe("model prompt context policy", () => {
	it.each([
		{ provider: "anthropic", id: "claude-fable-5" },
		{ provider: "openrouter", id: "anthropic/claude-sonnet-5" },
	])("uses clean context for $provider/$id", (model) => {
		delete process.env.OMK_CLAUDE_CONTEXT_FILES;

		expect(selectContextFilesForModel(contextFiles, model)).toEqual([]);
	});

	it.each([
		{ provider: "xai", id: "grok-4.5" },
		{ provider: "custom", id: "claudette-code" },
	])("keeps context files for $provider/$id", (model) => {
		expect(selectContextFilesForModel(contextFiles, model)).toBe(contextFiles);
	});

	it("restores Claude context files through the explicit override", () => {
		process.env.OMK_CLAUDE_CONTEXT_FILES = "1";

		expect(selectContextFilesForModel(contextFiles, { provider: "anthropic", id: "claude-fable-5" })).toBe(
			contextFiles,
		);
	});
});
