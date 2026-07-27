import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "os";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";
import type { ResourceDiagnostic } from "../src/core/diagnostics.ts";
import { formatSkillsForPrompt, loadSkills, loadSkillsFromDir, type Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

const fixturesDir = resolve(__dirname, "fixtures/skills");
const collisionFixturesDir = resolve(__dirname, "fixtures/skills-collision");

function createTestSkill(options: {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
	source?: string;
}): Skill {
	return {
		name: options.name,
		description: options.description,
		filePath: options.filePath,
		baseDir: options.baseDir,
		sourceInfo: createSyntheticSourceInfo(options.filePath, { source: options.source ?? "test" }),
		disableModelInvocation: options.disableModelInvocation ?? false,
	};
}

describe("skills", () => {
	describe("loadSkillsFromDir", () => {
		it("should load a valid skill", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
			expect(skills[0].description).toBe("A valid skill for testing purposes.");
			expect(skills[0].sourceInfo.source).toBe("test");
			expect(diagnostics).toHaveLength(0);
		});

		it("should allow names that don't match parent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "name-mismatch"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("different-name");
			expect(
				diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not match parent directory")),
			).toBe(false);
		});

		it("should warn when name contains invalid characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-name-chars"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("invalid characters"))).toBe(true);
		});

		it("should warn when name exceeds 64 characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "long-name"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("exceeds 64 characters"))).toBe(true);
		});

		it("should warn and skip skill when description is missing", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "missing-description"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should ignore unknown frontmatter fields", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "unknown-field"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics).toHaveLength(0);
		});

		it("should load nested skills recursively", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "nested"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("child-skill");
			expect(diagnostics).toHaveLength(0);
		});

		it("should discover nested skills in deterministic path order", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "skills-nested-order-"));
			try {
				const laterSkillDir = join(tempDir, "z-skill");
				const earlierSkillDir = join(tempDir, "a-skill");
				mkdirSync(laterSkillDir, { recursive: true });
				mkdirSync(earlierSkillDir, { recursive: true });
				writeFileSync(
					join(laterSkillDir, "SKILL.md"),
					`---
name: z-skill
description: Z skill
---
Z`,
				);
				writeFileSync(
					join(earlierSkillDir, "SKILL.md"),
					`---
name: a-skill
description: A skill
---
A`,
				);

				const { skills, diagnostics } = loadSkillsFromDir({ dir: tempDir, source: "test" });

				expect(diagnostics).toHaveLength(0);
				expect(skills.map((skill) => skill.name)).toEqual(["a-skill", "z-skill"]);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("should prefer a directory's root SKILL.md over nested SKILL.md files", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "root-skill-preferred"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("root-skill-preferred");
			expect(skills[0].description).toBe("Root skill should win.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should load SKILL.md with story-comment preamble before frontmatter", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "skills-preamble-"));
			try {
				const skillDir = join(tempDir, "audit-code");
				mkdirSync(skillDir, { recursive: true });
				writeFileSync(
					join(skillDir, "SKILL.md"),
					`# story: e51s04
<!-- story: e45s12 -->
---
name: audit-code
description: Self-review checklist for the coding agent
---
# Audit Code
`,
				);
				const { skills, diagnostics } = loadSkillsFromDir({ dir: tempDir, source: "test" });
				expect(diagnostics).toHaveLength(0);
				expect(skills).toHaveLength(1);
				expect(skills[0].name).toBe("audit-code");
				expect(skills[0].description).toContain("Self-review checklist");
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("should skip root README/CHANGELOG markdown that is not a skill", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "skills-readme-skip-"));
			try {
				writeFileSync(join(tempDir, "README.md"), "# Skills\n\nNot a skill.\n");
				writeFileSync(
					join(tempDir, "real-skill.md"),
					`---
name: real-skill
description: A real root skill file
---
Body`,
				);
				const { skills, diagnostics } = loadSkillsFromDir({ dir: tempDir, source: "test" });
				expect(diagnostics).toHaveLength(0);
				expect(skills.map((s) => s.name)).toEqual(["real-skill"]);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("should skip files without frontmatter", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "no-frontmatter"),
				source: "test",
			});

			// no-frontmatter has no description, so it should be skipped
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should warn and skip skill when YAML frontmatter is invalid", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-yaml"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("at line"))).toBe(true);
		});

		it("should not leak raw SKILL.md content in invalid YAML diagnostics", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "skills-invalid-yaml-"));
			try {
				const skillDir = join(tempDir, "invalid-yaml");
				mkdirSync(skillDir, { recursive: true });
				writeFileSync(
					join(skillDir, "SKILL.md"),
					`---
name: [SECRET_RAW_SKILL_CONTENT
---
Body that should also stay out of diagnostics`,
				);

				const { skills, diagnostics } = loadSkillsFromDir({ dir: skillDir, source: "test" });

				expect(skills).toHaveLength(0);
				expect(diagnostics).toHaveLength(1);
				expect(diagnostics[0].message).toContain("failed to parse skill file");
				expect(JSON.stringify(diagnostics)).not.toContain("SECRET_RAW_SKILL_CONTENT");
				expect(JSON.stringify(diagnostics)).not.toContain("Body that should also stay out of diagnostics");
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("should preserve multiline descriptions from YAML", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "multiline-description"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].description).toContain("\n");
			expect(skills[0].description).toContain("This is a multiline description.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when name contains consecutive hyphens", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "consecutive-hyphens"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("consecutive hyphens"))).toBe(true);
		});

		it("should load all skills from fixture directory", () => {
			const { skills } = loadSkillsFromDir({
				dir: fixturesDir,
				source: "test",
			});

			// Should load all skills that have descriptions (even with warnings)
			// valid-skill, name-mismatch, invalid-name-chars, long-name, unknown-field, nested/child-skill, consecutive-hyphens
			// NOT: missing-description, no-frontmatter (both missing descriptions)
			expect(skills.length).toBeGreaterThanOrEqual(6);
		});

		it("should return empty for non-existent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: "/non/existent/path",
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics).toHaveLength(0);
		});

		it("should use parent directory name when name not in frontmatter", () => {
			// The no-frontmatter fixture has no name in frontmatter, so it should use "no-frontmatter"
			// But it also has no description, so it won't load
			// Let's test with a valid skill that relies on directory name
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
		});

		it("should parse disable-model-invocation frontmatter field", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "disable-model-invocation"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("disable-model-invocation");
			expect(skills[0].disableModelInvocation).toBe(true);
			// Should not warn about unknown field
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("unknown frontmatter field"))).toBe(
				false,
			);
		});

		it("should default disableModelInvocation to false when not specified", () => {
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].disableModelInvocation).toBe(false);
		});
	});

	describe("formatSkillsForPrompt", () => {
		it("should return empty string for no skills", () => {
			const result = formatSkillsForPrompt([]);
			expect(result).toBe("");
		});

		it("should format skills as XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<available_skills>");
			expect(result).toContain("</available_skills>");
			expect(result).toContain("<skill>");
			expect(result).toContain("<name>test-skill</name>");
			expect(result).toContain("<description>A test skill.</description>");
			expect(result).toContain("<location>/path/to/skill/SKILL.md</location>");
		});

		it("should include intro text before XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);
			const xmlStart = result.indexOf("<available_skills>");
			const introText = result.substring(0, xmlStart);

			expect(introText).toContain("The following skills provide specialized instructions");
			expect(introText).toContain("Use the read tool to load a skill's file");
		});

		it("should escape XML special characters", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: 'A skill with <special> & "characters".',
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("&lt;special&gt;");
			expect(result).toContain("&amp;");
			expect(result).toContain("&quot;characters&quot;");
		});

		it("should format multiple skills", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "skill-one",
					description: "First skill.",
					filePath: "/path/one/SKILL.md",
					baseDir: "/path/one",
				}),
				createTestSkill({
					name: "skill-two",
					description: "Second skill.",
					filePath: "/path/two/SKILL.md",
					baseDir: "/path/two",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>skill-one</name>");
			expect(result).toContain("<name>skill-two</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(2);
		});

		it("should exclude skills with disableModelInvocation from prompt", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "visible-skill",
					description: "A visible skill.",
					filePath: "/path/visible/SKILL.md",
					baseDir: "/path/visible",
				}),
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>visible-skill</name>");
			expect(result).not.toContain("<name>hidden-skill</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(1);
		});

		it("should return empty string when all skills have disableModelInvocation", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);
			expect(result).toBe("");
		});
	});

	describe("loadSkills with options", () => {
		const emptyAgentDir = resolve(__dirname, "fixtures/empty-agent");
		const emptyCwd = resolve(__dirname, "fixtures/empty-cwd");

		it("should load from explicit skillPaths", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [join(fixturesDir, "valid-skill")],
				includeDefaults: true,
			});
			expect(skills).toHaveLength(1);
			expect(skills[0].sourceInfo.scope).toBe("temporary");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when skill path does not exist", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["/non/existent/path"],
				includeDefaults: true,
			});
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not exist"))).toBe(true);
		});

		it("should expand ~ in skillPaths", () => {
			const homeSkillsDir = join(homedir(), ".omk/agent/skills");
			const { skills: withTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["~/.omk/agent/skills"],
				includeDefaults: true,
			});
			const { skills: withoutTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [homeSkillsDir],
				includeDefaults: true,
			});
			expect(withTilde.length).toBe(withoutTilde.length);
		});

		it("should prefer project default skills over user default skills", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "skills-default-precedence-"));
			try {
				const agentDir = join(tempDir, "agent");
				const cwd = join(tempDir, "project");
				const userSkillDir = join(agentDir, "skills", "shared-skill");
				const projectSkillDir = join(cwd, ".omk", "skills", "shared-skill");
				mkdirSync(userSkillDir, { recursive: true });
				mkdirSync(projectSkillDir, { recursive: true });
				const userSkillPath = join(userSkillDir, "SKILL.md");
				const projectSkillPath = join(projectSkillDir, "SKILL.md");
				writeFileSync(
					userSkillPath,
					`---
name: shared-skill
description: User skill
---
User content`,
				);
				writeFileSync(
					projectSkillPath,
					`---
name: shared-skill
description: Project skill
---
Project content`,
				);

				const { skills, diagnostics } = loadSkills({
					agentDir,
					cwd,
					skillPaths: [],
					includeDefaults: true,
				});
				const collision = diagnostics.find((diagnostic) => diagnostic.collision?.name === "shared-skill");

				expect(skills).toHaveLength(1);
				expect(skills[0].filePath).toBe(projectSkillPath);
				expect(collision?.collision).toMatchObject({
					winnerPath: projectSkillPath,
					loserPath: userSkillPath,
					winnerSource: "local",
					loserSource: "local",
					winnerScope: "project",
					loserScope: "user",
					winnerOrigin: "top-level",
					loserOrigin: "top-level",
				});
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("collision handling", () => {
		it("should load skill files in deterministic path order", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "skills-order-"));
			try {
				writeFileSync(
					join(tempDir, "b-skill.md"),
					`---
name: b-skill
description: B skill
---
B`,
				);
				writeFileSync(
					join(tempDir, "a-skill.md"),
					`---
name: a-skill
description: A skill
---
A`,
				);

				const { skills } = loadSkillsFromDir({ dir: tempDir, source: "test" });

				expect(skills.map((skill) => skill.name)).toEqual(["a-skill", "b-skill"]);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("should report collision diagnostics with kept and skipped paths", () => {
			const { diagnostics } = loadSkills({
				agentDir: resolve(__dirname, "fixtures/empty-agent"),
				cwd: resolve(__dirname, "fixtures/empty-cwd"),
				skillPaths: [join(collisionFixturesDir, "first"), join(collisionFixturesDir, "second")],
				includeDefaults: false,
			});
			const collision = diagnostics.find((d) => d.type === "collision" && d.collision?.name === "calendar");

			expect(collision).toBeDefined();
			expect(collision?.message).toContain("kept");
			expect(collision?.message).toContain(collision?.collision?.winnerPath);
			expect(collision?.message).toContain("skipped");
			expect(collision?.message).toContain(collision?.collision?.loserPath);
		});

		it("should report collision diagnostics with source provenance and no skill content", () => {
			const { diagnostics } = loadSkills({
				agentDir: resolve(__dirname, "fixtures/empty-agent"),
				cwd: resolve(__dirname, "fixtures/empty-cwd"),
				skillPaths: [join(collisionFixturesDir, "first"), join(collisionFixturesDir, "second")],
				includeDefaults: false,
			});
			const collision = diagnostics.find((d) => d.type === "collision" && d.collision?.name === "calendar");

			expect(collision?.collision).toMatchObject({
				winnerSource: "local",
				loserSource: "local",
				winnerScope: "temporary",
				loserScope: "temporary",
				winnerOrigin: "top-level",
				loserOrigin: "top-level",
			});
			expect(JSON.stringify(collision)).not.toContain("This is the first calendar skill.");
			expect(JSON.stringify(collision)).not.toContain("This is the second calendar skill.");
		});

		it("should skip identical-content duplicate skill names without diagnostics", () => {
			const tempDir = mkdtempSync(join(tmpdir(), "skills-identical-"));
			try {
				const firstDir = join(tempDir, "first", "same-skill");
				const secondDir = join(tempDir, "second", "same-skill");
				mkdirSync(firstDir, { recursive: true });
				mkdirSync(secondDir, { recursive: true });
				const content = `---
name: same-skill
description: Same skill
---
Same content`;
				writeFileSync(join(firstDir, "SKILL.md"), content);
				writeFileSync(join(secondDir, "SKILL.md"), content);

				const { skills, diagnostics } = loadSkills({
					agentDir: resolve(__dirname, "fixtures/empty-agent"),
					cwd: resolve(__dirname, "fixtures/empty-cwd"),
					skillPaths: [join(tempDir, "first"), join(tempDir, "second")],
					includeDefaults: false,
				});

				expect(skills.map((skill) => skill.name)).toEqual(["same-skill"]);
				expect(diagnostics.filter((diagnostic) => diagnostic.type === "collision")).toEqual([]);
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("should detect name collisions and keep first skill", () => {
			// Load from first directory
			const first = loadSkillsFromDir({
				dir: join(collisionFixturesDir, "first"),
				source: "first",
			});

			const second = loadSkillsFromDir({
				dir: join(collisionFixturesDir, "second"),
				source: "second",
			});

			// Simulate the collision behavior from loadSkills()
			const skillMap = new Map<string, Skill>();
			const collisionWarnings: Array<{ skillPath: string; message: string }> = [];

			for (const skill of first.skills) {
				skillMap.set(skill.name, skill);
			}

			for (const skill of second.skills) {
				const existing = skillMap.get(skill.name);
				if (existing) {
					collisionWarnings.push({
						skillPath: skill.filePath,
						message: `name collision: "${skill.name}" already loaded from ${existing.filePath}`,
					});
				} else {
					skillMap.set(skill.name, skill);
				}
			}

			expect(skillMap.size).toBe(1);
			expect(skillMap.get("calendar")?.sourceInfo.source).toBe("first");
			expect(collisionWarnings).toHaveLength(1);
			expect(collisionWarnings[0].message).toContain("name collision");
		});
	});
});
