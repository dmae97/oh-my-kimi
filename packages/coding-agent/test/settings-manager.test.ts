import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getProjectAgentDir, Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

describe("Settings", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		// Reset global singleton so each test gets a fresh instance
		_resetSettingsForTest();

		// Use snowflake to isolate parallel test runs (SQLite files can't be shared)
		testDir = path.join(os.tmpdir(), "test-settings-tmp", Snowflake.next());
		agentDir = path.join(testDir, "agent");
		projectDir = path.join(testDir, "project");

		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	const getConfigPath = () => path.join(agentDir, "config.yml");

	const writeSettings = async (settings: Record<string, unknown>) => {
		await Bun.write(getConfigPath(), YAML.stringify(settings, null, 2));
	};

	const readSettings = async (): Promise<Record<string, unknown>> => {
		const file = Bun.file(getConfigPath());
		if (!(await file.exists())) return {};
		const content = await file.text();
		const parsed = YAML.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	};

	afterEach(() => {
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
	});

	// Tests that SettingsManager merges with DB state on save rather than blindly overwriting.
	// This ensures external edits (via AgentStorage directly) aren't lost when the app saves.
	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Seed initial settings in config.yml
			await writeSettings({
				theme: "dark",
				modelRoles: { default: "claude-sonnet" },
			});

			// Settings loads the initial state
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Simulate external edit (e.g., user modifying DB directly or another process)
			await writeSettings({
				theme: { dark: "anthracite" },
				modelRoles: { default: "claude-sonnet" },
				enabledModels: ["claude-opus-4-5", "gpt-5.2-codex"],
			});

			// Settings saves a change - should merge, not overwrite
			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
			expect(savedSettings.theme).toEqual({ dark: "anthracite" });
			expect((savedSettings.modelRoles as { default?: string } | undefined)?.default).toBe("claude-sonnet");
		});

		it("should preserve custom settings when changing theme", async () => {
			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
				shellPath: "/bin/zsh",
				extensions: ["/path/to/extension.ts"],
			});

			settings.set("theme.dark", "anthracite");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toEqual({ dark: "anthracite" });
		});

		it("should let in-memory changes override file changes for same key", async () => {
			await writeSettings({
				theme: { dark: "anthracite" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				theme: { dark: "anthracite" },
				defaultThinkingLevel: Effort.Low,
			});

			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
		});
	});

	describe("migrations", () => {
		it("maps removed atom edit mode settings to hashline", async () => {
			await writeSettings({
				edit: {
					mode: "atom",
					modelVariants: {
						"claude-opus": "atom",
						"gpt-5": "apply_patch",
					},
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("edit.mode")).toBe("hashline");
			expect(settings.getEditVariantForModel("claude-opus-4-5")).toBe("hashline");
			expect(settings.getEditVariantForModel("gpt-5.2")).toBe("apply_patch");
		});

		it("maps legacy hindsight.dynamicBankId=true onto hindsight.scoping=per-project", async () => {
			await writeSettings({
				hindsight: { dynamicBankId: true },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.scoping")).toBe("per-project");
		});

		it("does not override an explicit hindsight.scoping when migrating", async () => {
			await writeSettings({
				hindsight: { dynamicBankId: true, scoping: "global" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.scoping")).toBe("global");
		});

		it("promotes legacy hindsight.agentName onto hindsight.bankId when bankId is unset", async () => {
			await writeSettings({
				hindsight: { agentName: "ada-cli" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.bankId")).toBe("ada-cli");
		});
	});
});
