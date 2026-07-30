import { fauxAssistantMessage } from "omk-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResourceLoader } from "../../src/index.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const CONTEXT_GOVERNOR_ENV = "OMK_CONTEXT_GOVERNOR";
const MAX_PROMPT_TOKENS_ENV = "OMK_CONTEXT_GOVERNOR_MAX_PROMPT_TOKENS";
let previousContextGovernor: string | undefined;
let previousMaxPromptTokens: string | undefined;

function expectPlanCacheHit(prompt: string, expected: boolean): void {
	expect(prompt).toContain(`<cache_decision plan_hit="${expected}"`);
}

function rebuildSystemPrompt(harness: Harness): string {
	harness.session.setActiveToolsByName(harness.session.getActiveToolNames());
	return harness.session.systemPrompt;
}

describe("AgentSession context-budget cache", () => {
	beforeEach(() => {
		previousContextGovernor = process.env[CONTEXT_GOVERNOR_ENV];
		previousMaxPromptTokens = process.env[MAX_PROMPT_TOKENS_ENV];
		process.env[CONTEXT_GOVERNOR_ENV] = "1";
	});

	afterEach(() => {
		if (previousContextGovernor === undefined) delete process.env[CONTEXT_GOVERNOR_ENV];
		else process.env[CONTEXT_GOVERNOR_ENV] = previousContextGovernor;
		if (previousMaxPromptTokens === undefined) delete process.env[MAX_PROMPT_TOKENS_ENV];
		else process.env[MAX_PROMPT_TOKENS_ENV] = previousMaxPromptTokens;
	});

	it("reuses the plan cache when rebuilding a system prompt in one session", async () => {
		const harness = await createHarness();
		const freshHarness = await createHarness();
		try {
			expectPlanCacheHit(harness.session.systemPrompt, false);
			expectPlanCacheHit(rebuildSystemPrompt(harness), true);
			expectPlanCacheHit(freshHarness.session.systemPrompt, false);
		} finally {
			harness.cleanup();
			freshHarness.cleanup();
		}
	});

	it("rebuilds query-aware context for the current user turn", async () => {
		process.env[MAX_PROMPT_TOKENS_ENV] = "100000";
		const baseLoader = createTestResourceLoader();
		const skills = Array.from({ length: 40 }, (_, index) => ({
			name: `skill-${index}`,
			description: index === 39 ? "query-unique-7f1e framework cache audit specialist" : `generic skill ${index}`,
			filePath: `/skills/skill-${index}/SKILL.md`,
			baseDir: `/skills/skill-${index}`,
			sourceInfo: {
				source: "test",
				scope: "project" as const,
				origin: "top-level" as const,
				path: `/skills/skill-${index}`,
			},
			disableModelInvocation: false,
			contentHash: `hash-${index}`,
		}));
		const resourceLoader = {
			...baseLoader,
			getSkills: () => ({ skills, diagnostics: [] }),
		} satisfies ResourceLoader;
		const harness = await createHarness({ resourceLoader });
		let providerSystemPrompt = "";
		try {
			expect(harness.session.systemPrompt).not.toContain("<name>skill-39</name>");
			harness.setResponses([
				(context) => {
					providerSystemPrompt = context.systemPrompt ?? "";
					return fauxAssistantMessage("ok");
				},
			]);

			await harness.session.prompt("query-unique-7f1e framework cache audit");

			expect(providerSystemPrompt).toContain("<name>skill-39</name>");
		} finally {
			harness.cleanup();
		}
	});

	it("enables the context budget from global settings without an environment variable", async () => {
		delete process.env[CONTEXT_GOVERNOR_ENV];
		const harness = await createHarness({ settings: { contextBudget: { enabled: true } } });
		try {
			expect(harness.session.systemPrompt).toContain("<context_budget>");
		} finally {
			harness.cleanup();
		}
	});

	it("lets an environment opt-out disable the global context budget", async () => {
		process.env[CONTEXT_GOVERNOR_ENV] = "0";
		const harness = await createHarness({ settings: { contextBudget: { enabled: true } } });
		try {
			expect(harness.session.systemPrompt).not.toContain("<context_budget>");
		} finally {
			harness.cleanup();
		}
	});
});
