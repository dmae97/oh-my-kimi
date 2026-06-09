import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	createConventionalAnalysisTool,
	parseConventionalAnalysisResponse,
} from "@oh-my-pi/pi-coding-agent/commit/shared-llm";

describe("commit shared LLM parsing", () => {
	it("ignores harmless extra fields in conventional analysis tool output", () => {
		const tool = createConventionalAnalysisTool("Analyze a diff.");
		const message = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-analysis",
					name: tool.name,
					arguments: {
						type: "fix",
						scope: null,
						details: [],
						issue_refs: [],
						summary: "fix: handle parser edge case",
					},
				},
			],
		} as unknown as AssistantMessage;

		expect(parseConventionalAnalysisResponse(message, tool)).toEqual({
			type: "fix",
			scope: null,
			details: [],
			issueRefs: [],
		});
	});
});
