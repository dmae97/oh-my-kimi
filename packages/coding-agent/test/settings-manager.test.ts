import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import {
	type SettingPath,
	getDefault,
	onAppendOnlyModeChanged,
	onStatusLineSessionAccentChanged,
	resetSettingsForTest,
	Settings,
} from "@oh-my-pi/pi-coding-agent/config/settings";
import { getProjectAgentDir, Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

describe("Settings", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		// Reset global singleton so each test gets a fresh instance
		resetSettingsForTest();

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
	describe("defaults", () => {
		it("keeps eight inline images live by default", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("tui.maxInlineImages")).toBe(8);
		});
	});

	describe("get()", () => {
		it("resolves overrides, schema defaults, and falsey values", () => {
			const isolated = Settings.isolated({
				"display.showTokenUsage": false,
				setupVersion: 0,
				shellPath: "",
				enabledModels: [],
			});

			expect(isolated.get("display.showTokenUsage")).toBe(false);
			expect(isolated.get("setupVersion")).toBe(0);
			expect(isolated.get("shellPath")).toBe("");
			expect(isolated.get("enabledModels")).toEqual([]);
			expect(isolated.get("tui.maxInlineImages")).toBe(getDefault("tui.maxInlineImages"));
		});

		it("invalidates cached resolved values after set, override, and clearOverride", () => {
			const isolated = Settings.isolated();

			expect(isolated.get("display.showTokenUsage")).toBe(false);
			isolated.set("display.showTokenUsage", true);
			expect(isolated.get("display.showTokenUsage")).toBe(true);

			isolated.override("display.showTokenUsage", false);
			expect(isolated.get("display.showTokenUsage")).toBe(false);

			isolated.clearOverride("display.showTokenUsage");
			expect(isolated.get("display.showTokenUsage")).toBe(true);
		});

		it("re-resolves path-scoped arrays when cwd changes", async () => {
			const otherDir = path.join(testDir, "other-project");
			fs.mkdirSync(otherDir, { recursive: true });

			const settings = await Settings.init({
				cwd: projectDir,
				agentDir,
				inMemory: true,
				overrides: {
					enabledModels: [
						"always-model",
						{ path: projectDir, models: ["project-model"] },
						{ path: otherDir, models: ["other-model"] },
					],
					disabledProviders: [
						"always-provider",
						{ pathPrefix: projectDir, providers: ["project-provider"] },
						{ pathPrefix: otherDir, providers: ["other-provider"] },
					],
				},
			});

			expect(settings.get("enabledModels")).toEqual(["always-model", "project-model"]);
			expect(settings.get("disabledProviders")).toEqual(["always-provider", "project-provider"]);

			await settings.reloadForCwd(otherDir);

			expect(settings.get("enabledModels")).toEqual(["always-model", "other-model"]);
			expect(settings.get("disabledProviders")).toEqual(["always-provider", "other-provider"]);
		});

		it("migrates legacy snapcompact system prompt booleans to scoped modes", () => {
			expect(Settings.isolated({ "snapcompact.systemPrompt": true }).get("snapcompact.systemPrompt")).toBe("all");
			const nestedLegacy = { snapcompact: { systemPrompt: false } } as Partial<Record<SettingPath, unknown>>;
			expect(Settings.isolated(nestedLegacy).get("snapcompact.systemPrompt")).toBe("none");
		});
	});

	describe("statusLine.sessionAccent hooks", () => {
		it("notifies subscribers only when the effective value changes", () => {
			const isolated = Settings.isolated();
			const values: boolean[] = [];
			const unsubscribe = onStatusLineSessionAccentChanged(() => {
				values.push(isolated.get("statusLine.sessionAccent"));
			});

			try {
				isolated.set("statusLine.sessionAccent", true);
				expect(values).toEqual([]);

				isolated.set("statusLine.sessionAccent", false);
				expect(values).toEqual([false]);

				isolated.override("statusLine.sessionAccent", false);
				expect(values).toEqual([false]);

				isolated.override("statusLine.sessionAccent", true);
				expect(values).toEqual([false, true]);

				isolated.clearOverride("statusLine.sessionAccent");
				expect(values).toEqual([false, true, false]);
			} finally {
				unsubscribe();
			}

			isolated.set("statusLine.sessionAccent", true);
			expect(values).toEqual([false, true, false]);
		});
	});

	describe("provider.appendOnlyContext hooks", () => {
		it("isolates a throwing listener so the rest still receive the value", () => {
			const isolated = Settings.isolated();
			const received: string[] = [];
			const unsubscribeThrower = onAppendOnlyModeChanged(() => {
				throw new Error("boom");
			});
			const unsubscribeOk = onAppendOnlyModeChanged(value => {
				received.push(value);
			});

			try {
				expect(() => isolated.set("provider.appendOnlyContext", "on")).not.toThrow();
				expect(received).toEqual(["on"]);
			} finally {
				unsubscribeThrower();
				unsubscribeOk();
			}
		});
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

		it("filters model allow-list and disabled providers by current path prefix", async () => {
			const workDir = path.join(projectDir, "work", "service");
			const privateDir = path.join(projectDir, "private", "app");
			fs.mkdirSync(workDir, { recursive: true });
			fs.mkdirSync(privateDir, { recursive: true });

			await writeSettings({
				enabledModels: [
					"claude-sonnet-4-5",
					{ path: path.join(projectDir, "work"), values: ["anthropic/claude-opus-4-5"] },
					{ path: path.join(projectDir, "private"), values: ["openai/gpt-5.2-codex"] },
				],
				disabledProviders: [
					"ollama",
					{ path: path.join(projectDir, "work"), values: ["openai"] },
					{ path: path.join(projectDir, "private"), values: ["anthropic"] },
				],
			});

			const workSettings = await Settings.init({ cwd: workDir, agentDir });
			expect(workSettings.get("enabledModels")).toEqual(["claude-sonnet-4-5", "anthropic/claude-opus-4-5"]);
			expect(workSettings.get("disabledProviders")).toEqual(["ollama", "openai"]);

			resetSettingsForTest();
			const privateSettings = await Settings.init({ cwd: privateDir, agentDir });
			expect(privateSettings.get("enabledModels")).toEqual(["claude-sonnet-4-5", "openai/gpt-5.2-codex"]);
			expect(privateSettings.get("disabledProviders")).toEqual(["ollama", "anthropic"]);
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

	describe("model role overrides", () => {
		it("does not persist temporary default model overrides when another role is saved", async () => {
			await writeSettings({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");

			settings.setModelRole("smol", "anthropic/claude-haiku-4-5");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.modelRoles).toEqual({
				default: "anthropic/claude-sonnet-4-5",
				smol: "anthropic/claude-haiku-4-5",
			});
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");
			expect(settings.getModelRole("smol")).toBe("anthropic/claude-haiku-4-5");
		});

		it("restores persisted model roles after clearing runtime overrides", async () => {
			await writeSettings({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");

			settings.clearOverride("modelRoles");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4-5");
		});

		it("keeps the live role value aligned when saving over a runtime override", () => {
			const settings = Settings.isolated({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			settings.setModelRole("default", "anthropic/claude-opus-4-5");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5");

			settings.clearOverride("modelRoles");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5");
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

		it("migrates the legacy mnemosyne memory backend to mnemopi", async () => {
			await writeSettings({
				memory: { backend: "mnemosyne" },
				mnemosyne: { dbPath: "/tmp/old.db", scoping: "global" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("memory.backend")).toBe("mnemopi");
			expect(settings.get("mnemopi.dbPath")).toBe("/tmp/old.db");
			expect(settings.get("mnemopi.scoping")).toBe("global");
		});

		it("does not clobber an explicit mnemopi block when the legacy mnemosyne block is also present", async () => {
			await writeSettings({
				mnemosyne: { dbPath: "/tmp/old.db" },
				mnemopi: { dbPath: "/tmp/new.db" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("mnemopi.dbPath")).toBe("/tmp/new.db");
		});

		it("moves legacy lastChangelogVersion out of config.yml into the marker file", async () => {
			await writeSettings({ lastChangelogVersion: "0.40.0" });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Marker seeded from the legacy key.
			expect(fs.readFileSync(path.join(agentDir, "last-changelog-version"), "utf8")).toBe("0.40.0");

			// Key stripped from config.yml on the next save.
			settings.set("display.showTokenUsage", true);
			await settings.flush();
			const onDisk = await readSettings();
			expect("lastChangelogVersion" in onDisk).toBe(false);
			expect((onDisk.display as Record<string, unknown>).showTokenUsage).toBe(true);
		});

		it("never clobbers an existing marker with the legacy config value", async () => {
			fs.writeFileSync(path.join(agentDir, "last-changelog-version"), "0.41.0");
			await writeSettings({ lastChangelogVersion: "0.40.0" });

			await Settings.init({ cwd: projectDir, agentDir });

			expect(fs.readFileSync(path.join(agentDir, "last-changelog-version"), "utf8")).toBe("0.41.0");
		});
	});
});
