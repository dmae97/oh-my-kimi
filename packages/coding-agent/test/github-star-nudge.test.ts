import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	githubStarNudgeBody,
	githubStarNudgeTitle,
	OMK_GITHUB_STAR_URL,
	shouldShowGithubStarNudge,
} from "../src/core/github-star-nudge.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("github star nudge", () => {
	const testDir = join(process.cwd(), "test-github-star-nudge-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".omk"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("shows for fresh installs and anyone who has not marked starred", () => {
		expect(shouldShowGithubStarNudge({})).toBe(true);
		expect(shouldShowGithubStarNudge({ githubStarred: false })).toBe(true);
		expect(shouldShowGithubStarNudge({ githubStarred: undefined })).toBe(true);
	});

	it("hides only after githubStarred is true", () => {
		expect(shouldShowGithubStarNudge({ githubStarred: true })).toBe(false);
	});

	it("persists githubStarred in global settings only", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getGithubStarred()).toBe(false);

		manager.setGithubStarred(true);
		await manager.flush();

		const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as {
			githubStarred?: boolean;
		};
		expect(saved.githubStarred).toBe(true);
		expect(existsSync(join(projectDir, ".omk", "settings.json"))).toBe(false);

		const reloaded = SettingsManager.create(projectDir, agentDir);
		expect(reloaded.getGithubStarred()).toBe(true);

		reloaded.setGithubStarred(false);
		await reloaded.flush();
		expect(SettingsManager.create(projectDir, agentDir).getGithubStarred()).toBe(false);
	});

	it("ignores project-scoped githubStarred so the nag cannot be silenced by a shared project file", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ githubStarred: false }, null, 2));
		writeFileSync(join(projectDir, ".omk", "settings.json"), JSON.stringify({ githubStarred: true }, null, 2));

		const manager = SettingsManager.create(projectDir, agentDir);
		// Getter reads globalSettings only — project true must not suppress the nudge.
		expect(manager.getGithubStarred()).toBe(false);
		expect(shouldShowGithubStarNudge({ githubStarred: manager.getGithubStarred() })).toBe(true);
	});

	it("keeps copy and slash command discoverable", () => {
		expect(githubStarNudgeTitle()).toContain("Star");
		expect(githubStarNudgeBody()).toContain(OMK_GITHUB_STAR_URL);
		expect(githubStarNudgeBody()).toContain("/star");
		expect(BUILTIN_SLASH_COMMANDS.some((c) => c.name === "star")).toBe(true);
	});
});
