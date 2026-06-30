import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import "../../src/config/prompt-templates";
import subagentSystemPromptTemplate from "../../src/prompts/system/subagent-system-prompt.md" with { type: "text" };

describe("subagent system prompt", () => {
	it("revokes native output labels when caller schema overrides the agent", () => {
		const out = prompt.render(subagentSystemPromptTemplate, {
			agent: 'Use incremental yield with type: ["findings"].',
			outputSchemaOverridesAgent: true,
			outputSchema: {
				properties: {
					issue_key: { type: "string" },
					verdict: { enum: ["clean", "blockers"] },
				},
			},
		});

		expect(out).toContain("Caller schema overrides agent-native output instructions");
		expect(out).toContain("Ignore ROLE-provided output/yield labels");
		expect(out).toContain("omit `type` and terminal-yield the full `result.data` object");
	});
});
