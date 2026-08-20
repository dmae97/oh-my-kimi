import { describe, expect, it } from "vitest";
import {
	extractReverseSkillFactsFromMarkdown,
	formatReverseSkillFromSource,
	formatReverseSkillMarkdown,
	normalizeReverseSkillName,
	planReverseSkillToolChecks,
	REVERSE_SKILL_ROUTES,
	routeReverseSkill,
} from "../src/core/reverse-skill.ts";

describe("reverse skill routing", () => {
	it("routes repo-to-prompt reconstruction to gitreverse", () => {
		const decision = routeReverseSkill({
			query: "Turn https://github.com/vercel/next.js into one prompt I can paste into Cursor to vibe code it from scratch",
		});

		expect(decision.unmatched).toBe(false);
		expect(decision.primary?.route.id).toBe("gitreverse");
		expect(decision.primary?.confidence).toBeGreaterThan(0.5);
	});

	it("routes frontend signature recovery to js-reverse with browser MCP hints", () => {
		const decision = routeReverseSkill({
			query: "Find the frontend signature and encrypted params in a webpack app using CDP breakpoints",
		});

		expect(decision.unmatched).toBe(false);
		expect(decision.primary?.route.id).toBe("js-reverse");
		expect(decision.primary?.confidence).toBeGreaterThan(0.5);
		expect(decision.primary?.route.mcpHints).toEqual(expect.arrayContaining(["chrome-devtools", "playwright"]));
	});

	it("routes APK Frida tasks to apk-reverse and plans required tools first", () => {
		const decision = routeReverseSkill({
			query: "Decompile this Android APK, inspect smali, and prepare a Frida hook for SSL pinning validation",
		});
		const tools = planReverseSkillToolChecks(decision);

		expect(decision.primary?.route.id).toBe("apk-reverse");
		expect(tools.slice(0, 2)).toEqual(["jadx", "apktool"]);
		expect(tools).toEqual(expect.arrayContaining(["frida"]));
	});

	it("uses explicit dimensions to break ties", () => {
		const decision = routeReverseSkill({
			query: "Need imports, exports, strings, and offsets",
			targetType: "ELF binary",
			intent: "quick recon with CLI",
			toolchain: "rabin2 and radare2",
		});

		expect(decision.primary?.route.id).toBe("radare2");
		expect(decision.primary?.matched.toolchain).toEqual(expect.arrayContaining(["radare2", "rabin2"]));
	});

	it("marks unrelated tasks as unmatched", () => {
		const decision = routeReverseSkill({ query: "Summarize the team lunch menu and suggest desserts" });

		expect(decision.unmatched).toBe(true);
		expect(decision.primary).toBeUndefined();
	});
});

describe("reverse skill generation", () => {
	it("normalizes skill names to Agent Skills naming rules", () => {
		expect(normalizeReverseSkillName("APK Reverse!! Workflow__2026")).toBe("apk-reverse-workflow-2026");
	});

	it("generates valid skill markdown with route-derived hints", () => {
		const markdown = formatReverseSkillMarkdown({
			name: "JS Signature Skill",
			triggerSummary: "frontend signature recovery or encrypted request replay is needed",
			routeIds: ["js-reverse"],
		});

		expect(markdown).toContain("name: js-signature-skill");
		expect(markdown).toContain("description:");
		expect(markdown).toContain("chrome-devtools");
		expect(markdown).toContain("skills/js-reverse/SKILL.md");
	});

	it("extracts source facts and formats a skill from markdown", () => {
		const source = [
			"# Reverse Engineering Skills Master Control",
			"Read `skills/js-reverse/SKILL.md` before using `skills/scripts/bootstrap-reverse.sh`.",
			"Use jadx, apktool, Playwright MCP, and jshookmcp for matching tasks.",
		].join("\n");
		const facts = extractReverseSkillFactsFromMarkdown(source);
		const markdown = formatReverseSkillFromSource({ sourceText: source, name: "Imported Reverse Pack" });

		expect(facts.headings).toContain("Reverse Engineering Skills Master Control");
		expect(facts.skillPaths).toContain("skills/js-reverse/SKILL.md");
		expect(facts.tools).toEqual(expect.arrayContaining(["jadx", "apktool", "playwright", "jshookmcp"]));
		expect(markdown).toContain("name: imported-reverse-pack");
	});

	it("exposes the gitreverse route for repository-to-prompt workflows", () => {
		const route = REVERSE_SKILL_ROUTES.find((candidate) => candidate.id === "gitreverse");

		expect(route).toBeDefined();
		expect(route?.risk).toBe("passive-analysis");
		expect(route?.mcpHints).toEqual(expect.arrayContaining(["github", "filesystem"]));
	});
});
