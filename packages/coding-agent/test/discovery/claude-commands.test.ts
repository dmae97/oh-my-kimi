import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { slashCommandCapability, type SlashCommand } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";

async function writeFile(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
}

describe("Claude Code slash command discovery", () => {
	let root = "";
	let home = "";
	let project = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		originalHome = process.env.HOME;
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-claude-commands-"));
		home = path.join(root, "home");
		project = path.join(root, "project");
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
	});

	afterEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await fs.rm(root, { recursive: true, force: true });
	});

	test("maps subdirectory commands to Claude Code namespace names", async () => {
		await writeFile(path.join(project, ".claude", "commands", "triage.md"), "Triage prompt\n");
		await writeFile(path.join(project, ".claude", "commands", "opsx", "apply.md"), "Apply prompt\n");
		await writeFile(path.join(home, ".claude", "commands", "team", "audit.md"), "Audit prompt\n");

		const result = await loadCapability<SlashCommand>(slashCommandCapability.id, {
			cwd: project,
			providers: ["claude"],
		});
		const names = result.items.map(command => command.name);

		expect(result.warnings).toEqual([]);
		expect(names).toContain("triage");
		expect(names).toContain("opsx:apply");
		expect(names).toContain("team:audit");
		expect(names).not.toContain("apply");
		expect(names).not.toContain("audit");
	});
});
