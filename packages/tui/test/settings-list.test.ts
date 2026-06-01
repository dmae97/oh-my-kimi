import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings";

const testTheme: SettingsListTheme = {
	label: (text: string) => text,
	value: (text: string) => text,
	description: (text: string) => text,
	cursor: "→ ",
	hint: (text: string) => text,
};

describe("SettingsList", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	it("cycles the selected value when Enter arrives as LF", () => {
		const changes: Array<[string, string]> = [];
		const list = new SettingsList(
			[
				{
					id: "mode",
					label: "Mode",
					currentValue: "off",
					values: ["off", "on"],
				},
			],
			5,
			testTheme,
			(id, value) => {
				changes.push([id, value]);
			},
			() => {
				throw new Error("cancel should not be called");
			},
		);

		list.handleInput("\n");

		expect(changes).toEqual([["mode", "on"]]);
	});

	it("passes changed state to item label and value renderers", () => {
		const themed: SettingsListTheme = {
			label: (text: string, _selected: boolean, changed: boolean) => (changed ? `[changed-label]${text}` : text),
			value: (text: string, _selected: boolean, changed: boolean) => (changed ? `[changed-value]${text}` : text),
			description: (text: string) => text,
			cursor: "→ ",
			hint: (text: string) => text,
		};
		const list = new SettingsList(
			[
				{ id: "default", label: "Default", currentValue: "off", values: ["off", "on"] },
				{ id: "changed", label: "Changed", currentValue: "on", values: ["off", "on"], changed: true },
			],
			5,
			themed,
			() => {},
			() => {},
		);

		const output = list.render(80).join("\n");

		expect(output).toContain("[changed-label]Changed");
		expect(output).toContain("[changed-value]on");
		expect(output).not.toContain("[changed-label]Default");
	});
});
