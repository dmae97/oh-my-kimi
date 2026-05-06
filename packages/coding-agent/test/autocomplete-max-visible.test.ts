import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDefault } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { getProjectAgentDir, Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

describe("autocompleteMaxVisible setting", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		_resetSettingsForTest();
		testDir = path.join(os.tmpdir(), "test-autocomplete-settings", Snowflake.next());
		agentDir = path.join(testDir, "agent");
		projectDir = path.join(testDir, "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(() => {
		_resetSettingsForTest();
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true });
		}
	});

	it("should have default value of 5", () => {
		expect(getDefault("autocompleteMaxVisible")).toBe(5);
	});

	it("should return default when not configured", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(settings.get("autocompleteMaxVisible")).toBe(5);
	});

	it("should persist and read back a configured value", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.set("autocompleteMaxVisible", 10);
		await settings.flush();

		// Re-init to verify persistence
		_resetSettingsForTest();
		const settings2 = await Settings.init({ cwd: projectDir, agentDir });
		expect(settings2.get("autocompleteMaxVisible")).toBe(10);
	});

	it("should read from config.yml", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ autocompleteMaxVisible: 15 }, null, 2));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(settings.get("autocompleteMaxVisible")).toBe(15);
	});
 
	it("should let project config.yml override global config.yml", async () => {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ autocompleteMaxVisible: 15 }, null, 2));
		await Bun.write(path.join(getProjectAgentDir(projectDir), "config.yml"), YAML.stringify({ autocompleteMaxVisible: 20 }, null, 2));
 
		const settings = await Settings.init({ cwd: projectDir, agentDir });
 
		expect(settings.get("autocompleteMaxVisible")).toBe(20);
	});

	it("should coerce submenu string values for live editor updates", () => {
		const setAutocompleteMaxVisible = vi.fn();
		const controller = new SelectorController({
			editor: { setAutocompleteMaxVisible },
		} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		controller.handleSettingChange("autocompleteMaxVisible", "10");

		expect(setAutocompleteMaxVisible).toHaveBeenCalledWith(10);
	});

	it("should work with isolated instances", () => {
		const settings = Settings.isolated({ autocompleteMaxVisible: 12 });
		expect(settings.get("autocompleteMaxVisible")).toBe(12);
	});
});
