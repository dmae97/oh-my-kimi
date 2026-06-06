/**
 * Regression for the GitHub Copilot user-global discovery gaps:
 *   - #1913: ~/.copilot/copilot-instructions.md (user-global instructions)
 *   - #1915: COPILOT_HOME relocation + COPILOT_CUSTOM_INSTRUCTIONS_DIRS
 *   - #1916: *.prompt.md in .github/prompts/ and ~/.copilot/prompts/
 *
 * The `github` provider previously only scanned the project `.github/` tree. These
 * tests pin the user-global surface, driven through COPILOT_HOME so they never touch
 * the developer's real ~/.copilot directory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import type { ContextFile } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { Instruction } from "@oh-my-pi/pi-coding-agent/capability/instruction";
import type { Prompt } from "@oh-my-pi/pi-coding-agent/capability/prompt";
import "@oh-my-pi/pi-coding-agent/capability/context-file";
import "@oh-my-pi/pi-coding-agent/capability/instruction";
import "@oh-my-pi/pi-coding-agent/capability/prompt";
import "@oh-my-pi/pi-coding-agent/discovery/github";

const ENV_KEYS = ["COPILOT_HOME", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS"] as const;

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

describe("github discovery — Copilot user-global surface", () => {
	let tempDir!: string;
	let cwd!: string;
	let copilotHome!: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		clearCache();
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-github-copilot-"));
		cwd = path.join(tempDir, "project");
		copilotHome = path.join(tempDir, "copilot-home");
		fs.mkdirSync(cwd, { recursive: true });
		process.env.COPILOT_HOME = copilotHome;
		delete process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS;
	});

	afterEach(() => {
		clearCache();
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("loads user-global ~/.copilot/copilot-instructions.md via COPILOT_HOME (#1913)", async () => {
		write(path.join(copilotHome, "copilot-instructions.md"), "user-global guidance");

		const result = await loadCapability<ContextFile>("context-files", { cwd, providers: ["github"] });

		const found = result.all.find(f => f.path === path.join(copilotHome, "copilot-instructions.md"));
		expect(found).toBeDefined();
		expect(found?.content).toBe("user-global guidance");
		expect(found?.level).toBe("user");
		expect(found?._source.provider).toBe("github");
	});

	test("still loads project .github/copilot-instructions.md alongside user-global", async () => {
		write(path.join(cwd, ".github", "copilot-instructions.md"), "project guidance");
		write(path.join(copilotHome, "copilot-instructions.md"), "user guidance");

		const result = await loadCapability<ContextFile>("context-files", { cwd, providers: ["github"] });

		const project = result.all.find(f => f.level === "project");
		const user = result.all.find(f => f.level === "user");
		expect(project?.content).toBe("project guidance");
		expect(user?.content).toBe("user guidance");
	});

	test("loads copilot-instructions.md from COPILOT_CUSTOM_INSTRUCTIONS_DIRS (#1915)", async () => {
		const extraA = path.join(tempDir, "extra-a");
		const extraB = path.join(tempDir, "extra-b");
		write(path.join(extraA, "copilot-instructions.md"), "extra A");
		write(path.join(extraB, "copilot-instructions.md"), "extra B");
		process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS = `${extraA}, ${extraB}`;

		const result = await loadCapability<ContextFile>("context-files", { cwd, providers: ["github"] });

		const contents = result.all.filter(f => f.level === "user").map(f => f.content);
		expect(contents).toContain("extra A");
		expect(contents).toContain("extra B");
	});

	test("loads *.instructions.md from COPILOT_CUSTOM_INSTRUCTIONS_DIRS (#1915)", async () => {
		const extra = path.join(tempDir, "extra");
		write(path.join(extra, "style.instructions.md"), "---\napplyTo: '**/*.ts'\n---\nStyle rules");
		process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS = extra;

		const result = await loadCapability<Instruction>("instructions", { cwd, providers: ["github"] });

		const found = result.all.find(i => i.name === "style");
		expect(found).toBeDefined();
		expect(found?.applyTo).toBe("**/*.ts");
		expect(found?.content.trim()).toBe("Style rules");
		expect(found?._source.level).toBe("user");
	});

	test("discovers *.prompt.md from .github/prompts/ and ~/.copilot/prompts/ (#1916)", async () => {
		write(
			path.join(cwd, ".github", "prompts", "review.prompt.md"),
			"---\ndescription: Review helper\n---\nReview the diff.",
		);
		write(path.join(copilotHome, "prompts", "summarize.prompt.md"), "Summarize the changes.");
		// Plain markdown that is not a Copilot prompt file must be ignored.
		write(path.join(cwd, ".github", "prompts", "notes.md"), "not a prompt");

		const result = await loadCapability<Prompt>("prompts", { cwd, providers: ["github"] });

		const review = result.all.find(p => p.name === "review");
		const summarize = result.all.find(p => p.name === "summarize");
		expect(review).toBeDefined();
		expect(review?.content.trim()).toBe("Review the diff.");
		expect(review?._source.level).toBe("project");
		expect(summarize).toBeDefined();
		expect(summarize?._source.level).toBe("user");
		expect(result.all.find(p => p.name === "notes")).toBeUndefined();
	});
});
