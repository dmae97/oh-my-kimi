import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SettingsList, type SettingsListTheme } from "@oh-my-pi/pi-tui/components/settings-list";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui/keybindings";

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

	it("renders long settings tabs through a scrollbar viewport", () => {
		const list = new SettingsList(
			Array.from({ length: 6 }, (_, i) => ({
				id: `item-${i}`,
				label: `Item ${i}`,
				currentValue: `value-${i}`,
				values: [`value-${i}`],
			})),
			3,
			{
				...testTheme,
				label: (text: string, selected: boolean) => (selected ? `[selected]${text}` : text),
				hint: (text: string) => `[dim]${text}`,
			},
			() => {},
			() => {},
		);

		const output = list.render(32);

		expect(output.slice(0, 3).join("\n")).toContain("[selected]");
		expect(output.slice(0, 3).join("\n")).toContain("[dim]");
		expect(output).not.toContain("(1/6)");
	});

	it("does not reserve a scrollbar column when all settings fit", () => {
		const list = new SettingsList(
			[{ id: "mode", label: "Mode", currentValue: "123456", values: ["123456"] }],
			3,
			testTheme,
			() => {},
			() => {},
		);

		expect(list.render(16)[0]).toBe("→ Mode  123456");
	});

	it("filters settings with printable search text", () => {
		const list = new SettingsList(
			[
				{ id: "mode", label: "Mode", currentValue: "off", values: ["off", "on"] },
				{ id: "theme.dark", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
				{
					id: "browser.path",
					label: "Browser Path",
					description: "Executable used for browser launches",
					currentValue: "",
				},
			],
			5,
			testTheme,
			() => {},
			() => {},
		);

		list.handleInput("b");

		const output = list.render(80).join("\n");
		expect(output).toContain("Search: b");
		expect(output).toContain("Browser Path");
		expect(output).not.toContain("Theme");
		expect(output).not.toContain("Mode");
	});

	it("clears active search on Escape before canceling", () => {
		let cancelCount = 0;
		const list = new SettingsList(
			[
				{ id: "mode", label: "Mode", currentValue: "off", values: ["off", "on"] },
				{ id: "browser.path", label: "Browser Path", currentValue: "" },
			],
			5,
			testTheme,
			() => {},
			() => {
				cancelCount++;
			},
		);

		list.handleInput("b");
		expect(list.hasSearchQuery()).toBe(true);

		list.handleInput("\x1b");
		expect(list.hasSearchQuery()).toBe(false);
		expect(cancelCount).toBe(0);

		list.handleInput("\x1b");
		expect(cancelCount).toBe(1);
	});
});
