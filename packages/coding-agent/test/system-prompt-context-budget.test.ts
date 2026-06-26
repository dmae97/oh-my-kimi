import { describe, expect, it } from "vitest";
import type { Skill } from "../src/core/skills.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

const sourceInfo: SourceInfo = {
	source: "test",
	scope: "project",
	origin: "top-level",
	path: "/skills/test",
};

function makeSkill(index: number): Skill {
	return {
		name: `skill-${index}`,
		description: `Description for skill ${index}. ${"extra detail ".repeat(30)}`,
		filePath: `/skills/skill-${index}/SKILL.md`,
		baseDir: `/skills/skill-${index}`,
		sourceInfo,
		disableModelInvocation: false,
		contentHash: `hash-${index}`,
	};
}

describe("buildSystemPrompt context budget", () => {
	it("preserves legacy output when no budget is supplied", () => {
		const legacy = buildSystemPrompt({
			selectedTools: ["read"],
			contextFiles: [],
			skills: [makeSkill(0)],
			cwd: "/repo",
		});

		expect(legacy).toContain("<available_skills>");
		expect(legacy).toContain("Description for skill 0");
		expect(legacy).not.toContain("<context_budget>");
	});

	it("limits resource inventory while keeping active skills and pointers", () => {
		const skills = Array.from({ length: 40 }, (_, index) => makeSkill(index));
		const prompt = buildSystemPrompt({
			selectedTools: ["read"],
			toolSnippets: { read: "Read files" },
			contextFiles: [
				{
					path: "/repo/AGENTS.md",
					content: "Important project convention. ".repeat(200),
					isGlobal: false,
				},
			],
			skills,
			cwd: "/repo",
			contextBudget: {
				maxPromptTokens: 1700,
				activeSkillNames: ["skill-0"],
				includeFullContextFiles: false,
			},
		});

		expect(prompt).toContain("<context_file_pointer");
		expect(prompt).toContain("<context_budget>");
		expect(prompt).toContain("<policy>context-budget-v2</policy>");
		expect(prompt).toContain("<name>skill-0</name>");
		expect(prompt).not.toContain("<name>skill-39</name>");
		expect(prompt).toContain("Current working directory: /repo");
	});
});
