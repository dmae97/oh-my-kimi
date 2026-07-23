import { describe, expect, it } from "vitest";
import { createMemoryContextBudgetCacheProviderV2 } from "../src/core/context-budget-governor-v2.ts";
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
					content: `SECRET_CONTEXT_BUDGET_RAW_RESOURCE_TEXT ${"Important project convention. ".repeat(200)}`,
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
		expect(prompt).toContain("<decision_observability>");
		expect(prompt).toMatch(
			/<counts selected="\d+" omitted="\d+" pointer="\d+" compressed="\d+" full="\d+" retrieval_fallbacks="\d+" \/>/u,
		);
		expect(prompt).toMatch(/<tokens available="\d+" used="\d+" raw="\d+" omitted="\d+" token_savings="\d+" \/>/u);
		expect(prompt).toMatch(
			/<cache_decision plan_hit="false" selected_hits="\d+" misses="\d+" stale_rejects="\d+" negative_hits="\d+" writes="\d+" \/>/u,
		);
		expect(prompt).toContain("<diagnostic_reasons");
		expect(prompt).toContain(
			'<token_optimizer optimizer_id="legacy-token-optimizer" status="quarantined_compatibility" active="false" active_context_budget_optimizer="context-budget-v2" compatibility_only="true" />',
		);
		expect(prompt).toContain("<name>skill-0</name>");
		expect(prompt).not.toContain("<name>skill-39</name>");
		expect(prompt).not.toContain("SECRET_CONTEXT_BUDGET_RAW_RESOURCE_TEXT");
		expect(prompt).toContain("Current working directory: /repo");
	});

	it("escapes budgeted full context before prompt assembly", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["read"],
			toolSnippets: { read: "Read files" },
			contextFiles: [
				{
					path: `/repo/A&B"'.md`,
					content: "Markup: <example>fish & chips</example>.",
					isGlobal: false,
				},
			],
			skills: [],
			cwd: "/repo",
			contextBudget: {
				maxPromptTokens: 6000,
				includeFullContextFiles: true,
			},
		});

		expect(prompt).toContain(
			'<project_instructions path="/repo/A&amp;B&quot;&apos;.md">\nMarkup: &lt;example&gt;fish &amp; chips&lt;/example&gt;.\n</project_instructions>',
		);
		expect(prompt).not.toContain("Markup: <example>");
		expect(prompt.indexOf("<runtime_trust_boundary>")).toBeLessThan(prompt.indexOf("<project_instructions"));
	});

	it("renders bounded cache decision observability without cached raw text", () => {
		const cacheProvider = createMemoryContextBudgetCacheProviderV2();
		const budget = {
			maxPromptTokens: 1700,
			cacheProvider,
			includeFullContextFiles: false,
			queryContext: "cache surface",
		};
		const input = {
			selectedTools: ["read"],
			toolSnippets: { read: "Read files" },
			contextFiles: [
				{
					path: "/repo/cache.md",
					content: `SECRET_CACHE_SURFACE_TEXT ${"cache surface detail. ".repeat(200)}`,
					isGlobal: false,
				},
			],
			skills: [makeSkill(0)],
			cwd: "/repo",
			contextBudget: budget,
		};

		const first = buildSystemPrompt(input);
		const second = buildSystemPrompt(input);

		expect(first).toMatch(/<cache_decision plan_hit="false" selected_hits="0" misses="\d+"/u);
		expect(second).toMatch(/<cache_decision plan_hit="true" selected_hits="0" misses="0"/u);
		expect(second).not.toContain("SECRET_CACHE_SURFACE_TEXT");
	});
});
