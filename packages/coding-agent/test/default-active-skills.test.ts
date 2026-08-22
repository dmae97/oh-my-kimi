import { fauxAssistantMessage } from "omk-ai";
import { describe, expect, it, vi } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { createSyntheticSourceInfo, type ResourceLoader, type Skill } from "../src/index.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

function createSkill(name: string, scope: "project" | "user" = "user", explicitOnly = false): Skill {
	const filePath = `/virtual/${name}/SKILL.md`;
	return {
		name,
		description: `${name} instructions`,
		filePath,
		baseDir: `/virtual/${name}`,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "sdk", scope }),
		disableModelInvocation: explicitOnly,
	};
}

function createSkillLoader(skills: readonly Skill[]): ResourceLoader {
	return {
		...createTestResourceLoader(),
		getSkills: () => ({ skills: [...skills], diagnostics: [] }),
	};
}

function activeSection(prompt: string): string {
	return prompt.split("<active_skills", 2)[1]?.split("</active_skills>", 1)[0] ?? "";
}

describe("default active skills", () => {
	it("defaults to an empty list, deduplicates names, and returns a defensive copy", () => {
		const empty = SettingsManager.inMemory();
		expect(empty.getDefaultActiveSkills()).toEqual([]);

		const configured = SettingsManager.inMemory({
			defaultActiveSkills: ["programming", "review-work", "programming"],
		});
		const names = configured.getDefaultActiveSkills();
		names.push("mutated");

		expect(configured.getDefaultActiveSkills()).toEqual(["programming", "review-work"]);
	});

	it("rejects malformed or oversized profiles", () => {
		expect(() => SettingsManager.inMemory({ defaultActiveSkills: ["Bad Name"] }).getDefaultActiveSkills()).toThrow(
			"defaultActiveSkills",
		);
		expect(() =>
			SettingsManager.inMemory({
				defaultActiveSkills: Array.from({ length: 65 }, (_, index) => `skill-${index}`),
			}).getDefaultActiveSkills(),
		).toThrow("defaultActiveSkills");
	});

	it("uses only the global profile when project settings provide another list", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ defaultActiveSkills: ["programming"] }));
		storage.withLock("project", () => JSON.stringify({ defaultActiveSkills: ["review-work"] }));

		expect(SettingsManager.fromStorage(storage).getDefaultActiveSkills()).toEqual(["programming"]);
	});

	it("marks trusted operator skills active without duplicating descriptions", async () => {
		const harness = await createHarness({
			settings: { defaultActiveSkills: ["programming", "omk-loop"] },
			resourceLoader: createSkillLoader([createSkill("programming"), createSkill("omk-loop", "user", true)]),
		});

		try {
			const section = activeSection(harness.session.systemPrompt);
			expect(harness.session.systemPrompt).toContain('<active_skills source="settings">');
			expect(section).toContain("<name>programming</name>");
			expect(section).toContain("<name>omk-loop</name>");
			expect(section).not.toContain("<description>");
			expect(section).not.toContain("<location>/virtual/programming/SKILL.md</location>");
			expect(section).toContain("<location>/virtual/omk-loop/SKILL.md</location>");
		} finally {
			harness.cleanup();
		}
	});

	it("does not let a project-scoped skill satisfy a global default", async () => {
		const harness = await createHarness({
			settings: { defaultActiveSkills: ["programming"] },
			resourceLoader: createSkillLoader([createSkill("programming", "project")]),
		});

		try {
			expect(activeSection(harness.session.systemPrompt)).toBe("");
		} finally {
			harness.cleanup();
		}
	});

	it("merges per-turn skills with configured defaults", async () => {
		const harness = await createHarness({
			settings: { defaultActiveSkills: ["programming"] },
			resourceLoader: createSkillLoader([createSkill("programming"), createSkill("review-work")]),
		});
		let providerPrompt = "";
		harness.setResponses([
			(context) => {
				providerPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("ok");
			},
		]);

		try {
			await harness.session.prompt("review", {
				activeSkillNames: ["review-work"],
				activeSkillSource: "test",
			});
			const section = activeSection(providerPrompt);
			expect(section).toContain("<name>programming</name>");
			expect(section).toContain("<name>review-work</name>");
		} finally {
			harness.cleanup();
		}
	});

	it("clears stale defaults before compaction or the next provider request", async () => {
		const harness = await createHarness({
			settings: { defaultActiveSkills: ["programming"] },
			resourceLoader: createSkillLoader([createSkill("programming")]),
		});
		let providerPrompt = "";
		let preCompactionPrompt = "";
		harness.setResponses([fauxAssistantMessage("first")]);

		try {
			await harness.session.prompt("first");
			harness.settingsManager.setDefaultActiveSkills([]);
			const internals = harness.session as unknown as {
				_checkCompaction: (...args: unknown[]) => Promise<boolean>;
			};
			vi.spyOn(internals, "_checkCompaction").mockImplementation(async () => {
				preCompactionPrompt = harness.session.systemPrompt;
				return false;
			});
			harness.setResponses([
				(context) => {
					providerPrompt = context.systemPrompt ?? "";
					return fauxAssistantMessage("second");
				},
			]);

			await harness.session.prompt("second");
			expect(activeSection(preCompactionPrompt)).toBe("");
			expect(activeSection(providerPrompt)).toBe("");
		} finally {
			harness.cleanup();
		}
	});

	it("preserves defaults when switching models", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { defaultActiveSkills: ["programming"] },
			resourceLoader: createSkillLoader([createSkill("programming")]),
		});

		try {
			await harness.session.setModel(harness.getModel("faux-2")!);
			expect(activeSection(harness.session.systemPrompt)).toContain("<name>programming</name>");
		} finally {
			harness.cleanup();
		}
	});
});
