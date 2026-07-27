import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkills } from "../src/core/skills.ts";
import {
	cachedSkillScan,
	fingerprintSkillDir,
	readSkillCatalog,
	writeSkillCatalog,
} from "../src/core/skills-catalog-cache.ts";

const SKILL_MD = `---
name: cache-probe
description: probe skill
---
# Cache Probe
`;

describe("skills catalog cache", () => {
	let root: string;
	let agentDir: string;
	let skillsDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-skills-cache-"));
		agentDir = join(root, "agent");
		skillsDir = join(agentDir, "skills", "cache-probe");
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(join(skillsDir, "SKILL.md"), SKILL_MD);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("fingerprint changes when a file is added or edited", () => {
		const before = fingerprintSkillDir(agentDir);
		writeFileSync(join(skillsDir, "extra.md"), "# note\n");
		const afterAdd = fingerprintSkillDir(agentDir);
		expect(afterAdd.files).toBe(before.files + 1);
		writeFileSync(join(skillsDir, "extra.md"), "# changed note\n");
		const afterEdit = fingerprintSkillDir(agentDir);
		expect(afterEdit.totalSize).not.toBe(afterAdd.totalSize);
	});

	it("reuses the cached catalog on an unchanged tree", () => {
		let scans = 0;
		const scan = () => {
			scans++;
			return { skills: [{ name: "a" }], diagnostics: [] };
		};
		const first = cachedSkillScan(agentDir, join(agentDir, "skills"), scan);
		writeSkillCatalog(agentDir, first.store ?? {});
		expect(scans).toBe(1);
		const second = cachedSkillScan(agentDir, join(agentDir, "skills"), scan);
		expect(scans).toBe(1); // cache hit — scan not invoked
		expect(second.result).toEqual(first.result);
		// And a mutation invalidates:
		writeFileSync(join(skillsDir, "another.md"), "# new\n");
		const third = cachedSkillScan(agentDir, join(agentDir, "skills"), scan);
		expect(scans).toBe(2);
		expect(third.store).toBeDefined();
	});

	it("loadSkills end-to-end: second call hits the persistent cache", () => {
		const options = { cwd: root, agentDir, skillPaths: [] as string[], includeDefaults: true, catalogCache: true };
		const first = loadSkills(options);
		expect(first.skills.map((s) => s.name)).toContain("cache-probe");
		expect(Object.keys(readSkillCatalog(agentDir)).length).toBeGreaterThan(0);
		const second = loadSkills(options);
		expect(second.skills.map((s) => s.name)).toEqual(first.skills.map((s) => s.name));
		// New skill appears after invalidation without any manual cache clearing.
		mkdirSync(join(agentDir, "skills", "second-skill"), { recursive: true });
		writeFileSync(
			join(agentDir, "skills", "second-skill", "SKILL.md"),
			SKILL_MD.replace("cache-probe", "second-skill"),
		);
		const third = loadSkills(options);
		expect(third.skills.map((s) => s.name)).toContain("second-skill");
	});

	it("does not write the catalog under test runners unless opted in", () => {
		const options = { cwd: root, agentDir, skillPaths: [] as string[], includeDefaults: true };
		loadSkills(options);
		expect(existsSync(join(agentDir, "cache", "skill-catalog-v1.json"))).toBe(false);
	});

	it("corrupt cache file degrades to a clean miss", () => {
		mkdirSync(join(agentDir, "cache"), { recursive: true });
		writeFileSync(join(agentDir, "cache", "skill-catalog-v1.json"), "{not json");
		expect(readSkillCatalog(agentDir)).toEqual({});
		expect(() => writeSkillCatalog(agentDir, {})).not.toThrow();
	});
});
