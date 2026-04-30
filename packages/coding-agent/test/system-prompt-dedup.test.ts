import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	buildSystemPrompt,
	loadProjectContextFiles,
	loadSystemPromptFiles,
} from "@oh-my-pi/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("SYSTEM.md prompt assembly", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-system-prompt-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-system-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("renders SYSTEM.md exactly once when it is used as the custom base prompt", async () => {
		const projectDir = path.join(tempDir, "project");
		const systemDir = path.join(projectDir, ".omp");
		const systemPrompt = "You are the project SYSTEM prompt.";
		fs.mkdirSync(systemDir, { recursive: true });
		fs.writeFileSync(path.join(systemDir, "SYSTEM.md"), systemPrompt);

		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir: projectDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			systemPrompt,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			const formatted = session.formatSessionAsText();
			const matches = formatted.match(new RegExp(escapeRegExp(systemPrompt), "g")) ?? [];
			expect(matches).toHaveLength(1);
		} finally {
			await session.dispose();
		}
	});

	it("prefers project SYSTEM.md over user SYSTEM.md", async () => {
		const projectDir = path.join(tempDir, "project");
		fs.mkdirSync(path.join(projectDir, ".omp"), { recursive: true });
		fs.mkdirSync(path.join(tempHomeDir, ".omp", "agent"), { recursive: true });
		fs.writeFileSync(path.join(tempHomeDir, ".omp", "agent", "SYSTEM.md"), "User SYSTEM prompt");
		fs.writeFileSync(path.join(projectDir, ".omp", "SYSTEM.md"), "Project SYSTEM prompt");

		await expect(loadSystemPromptFiles({ cwd: projectDir })).resolves.toBe("Project SYSTEM prompt");
	});
	it("drops identical explicit context entries even when file names differ", async () => {
		const farPath = path.join(tempDir, "far", "AGENTS.md");
		const nearPath = path.join(tempDir, "near", "CLAUDE.md");
		const sharedContent = "Shared context instructions";

		const prompt = await buildSystemPrompt({
			cwd: tempDir,
			customPrompt: "Base prompt",
			contextFiles: [
				{ path: farPath, content: sharedContent, depth: 2 },
				{ path: nearPath, content: sharedContent, depth: 0 },
			],
			skills: [],
			rules: [],
			toolNames: [],
		});

		const matches = prompt.match(new RegExp(escapeRegExp(sharedContent), "g")) ?? [];
		expect(matches).toHaveLength(1);
		expect(prompt).not.toContain(`<file path="${farPath}">`);
		expect(prompt).toContain(`<file path="${nearPath}">`);
	});

	it("drops identical discovered context entries and keeps the closest copy", async () => {
		const projectDir = path.join(tempDir, "project");
		const appDir = path.join(projectDir, "packages", "app");
		const sharedContent = "Shared context instructions";

		fs.mkdirSync(appDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, "AGENTS.md"), sharedContent);
		fs.writeFileSync(path.join(appDir, "AGENTS.md"), sharedContent);

		const contextFiles = await loadProjectContextFiles({ cwd: appDir });
		const discoveredFiles = contextFiles.filter(file => file.path.startsWith(projectDir));

		expect(discoveredFiles).toHaveLength(1);
		expect(discoveredFiles[0]?.path).toBe(path.join(appDir, "AGENTS.md"));
	});

	it("keeps distinct context entries when their contents differ", async () => {
		const farPath = path.join(tempDir, "far", "AGENTS.md");
		const nearPath = path.join(tempDir, "near", "CLAUDE.md");

		const prompt = await buildSystemPrompt({
			cwd: tempDir,
			customPrompt: "Base prompt",
			contextFiles: [
				{ path: farPath, content: "Root context instructions", depth: 2 },
				{ path: nearPath, content: "Near context instructions", depth: 0 },
			],
			skills: [],
			rules: [],
			toolNames: [],
		});

		expect(prompt).toContain("Root context instructions");
		expect(prompt).toContain("Near context instructions");
	});
});
