import { describe, expect, it } from "bun:test";
import { convertToLlm, SKILL_PROMPT_MESSAGE_TYPE, type CustomMessage, type SkillPromptDetails } from "./messages";

function customMessage(
	customType: string,
	attribution: "agent" | "user",
): CustomMessage<SkillPromptDetails> {
	return {
		role: "custom",
		customType,
		content: "Use this skill.",
		display: true,
		details: { name: "atomic-commit", path: "/tmp/SKILL.md", lineCount: 1 },
		attribution,
		timestamp: 1,
	};
}

describe("convertToLlm", () => {
	it("presents user-invoked skill prompts as user turns", () => {
		const [message] = convertToLlm([customMessage(SKILL_PROMPT_MESSAGE_TYPE, "user")]);

		expect(message?.role).toBe("user");
		if (message?.role !== "user") {
			throw new Error(`Expected user role, received ${message?.role ?? "none"}`);
		}
		expect(message.attribution).toBe("user");
	});

	it("keeps auto-applied skill prompts and other custom messages as developer turns", () => {
		const [autoSkill, otherCustom] = convertToLlm([
			customMessage(SKILL_PROMPT_MESSAGE_TYPE, "agent"),
			customMessage("extension-note", "user"),
		]);

		expect(autoSkill?.role).toBe("developer");
		expect(otherCustom?.role).toBe("developer");
	});
});
