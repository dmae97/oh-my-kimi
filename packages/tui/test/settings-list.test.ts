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
	it("skips heading rows during navigation and starts on the first selectable item", () => {
		const changes: Array<[string, string]> = [];
		const list = new SettingsList(
			[
				{ id: "__heading:a", label: "Group A", currentValue: "", heading: true },
				{ id: "alpha", label: "Alpha", currentValue: "off", values: ["off", "on"] },
				{ id: "__heading:b", label: "Group B", currentValue: "", heading: true },
				{ id: "beta", label: "Beta", currentValue: "off", values: ["off", "on"] },
			],
			10,
			testTheme,
			(id, value) => {
				changes.push([id, value]);
			},
			() => {},
		);

		// Initial selection lands past the leading heading
		list.handleInput("\n");
		expect(changes).toEqual([["alpha", "on"]]);

		// Down crosses the Group B heading directly to Beta
		list.handleInput("\x1b[B");
		list.handleInput("\n");
		expect(changes).toEqual([
			["alpha", "on"],
			["beta", "on"],
		]);

		// Down from the last item wraps past the leading heading back to Alpha
		list.handleInput("\x1b[B");
		list.handleInput("\n");
		expect(changes).toEqual([
			["alpha", "on"],
			["beta", "on"],
			["alpha", "off"],
		]);
	});

	it("excludes heading rows from search results", () => {
		const list = new SettingsList(
			[
				{ id: "__heading:group", label: "Group Alpha", currentValue: "", heading: true },
				{ id: "alpha", label: "Alpha Mode", currentValue: "off", values: ["off", "on"] },
				{ id: "beta", label: "Beta Mode", currentValue: "off", values: ["off", "on"] },
			],
			5,
			testTheme,
			() => {},
			() => {},
		);

		// "group" fuzzy-matches the heading label but headings are not searchable
		for (const ch of "group") list.handleInput(ch);

		const output = list.render(80).join("\n");
		expect(output).not.toContain("Group Alpha");
		expect(output).toContain("No matching settings");
	});
	function sectionedItems() {
		return [
			{ id: "__heading:a", label: "Group A", currentValue: "", heading: true },
			{ id: "alpha", label: "Alpha", currentValue: "off", values: ["off", "on"] },
			{ id: "alpha2", label: "Alpha Two", currentValue: "off", values: ["off", "on"] },
			{ id: "__heading:b", label: "Group B", currentValue: "", heading: true },
			{ id: "beta", label: "Beta", currentValue: "off", values: ["off", "on"] },
			{ id: "__heading:c", label: "Group C", currentValue: "", heading: true },
			{ id: "gamma", label: "Gamma", currentValue: "off", values: ["off", "on"] },
		];
	}

	it("jumps between sections with PgDn/PgUp, wrapping at the ends", () => {
		const changes: Array<[string, string]> = [];
		const list = new SettingsList(
			sectionedItems(),
			10,
			testTheme,
			(id, value) => {
				changes.push([id, value]);
			},
			() => {},
		);

		// PgDn from Alpha jumps to the first item of Group B
		list.handleInput("\x1b[6~");
		list.handleInput("\n");
		expect(changes).toEqual([["beta", "on"]]);

		// PgUp twice wraps from Group A to Group C
		list.handleInput("\x1b[5~");
		list.handleInput("\x1b[5~");
		list.handleInput("\n");
		expect(changes).toEqual([
			["beta", "on"],
			["gamma", "on"],
		]);
	});

	it("renders a section sidebar at wide widths showing only the active section's items", () => {
		const list = new SettingsList(
			sectionedItems(),
			10,
			testTheme,
			() => {},
			() => {},
		);

		const output = list.render(120).join("\n");
		// Sidebar lists every section beside the pane separator
		expect(output).toMatch(/Group A\s+│/);
		expect(output).toMatch(/Group B\s+│/);
		expect(output).toMatch(/Group C\s+│/);
		// Pane shows the active section's items only
		expect(output).toContain("Alpha");
		expect(output).not.toContain("Beta");
		expect(output).not.toContain("Gamma");

		// Jump to Group B: the pane swaps to its items
		list.handleInput("\x1b[6~");
		const after = list.render(120).join("\n");
		expect(after).toContain("Beta");
		expect(after).not.toContain("Alpha");
	});

	it("falls back to inline heading rows when the width cannot fit the sidebar", () => {
		const list = new SettingsList(
			sectionedItems(),
			10,
			testTheme,
			() => {},
			() => {},
		);

		const output = list.render(60);
		const joined = output.join("\n");
		// No split separator; headings render as standalone rows and every item is inline
		expect(joined).not.toContain("│");
		expect(joined).toContain("Group A");
		expect(joined).toContain("Group C");
		expect(joined).toContain("Alpha");
		expect(joined).toContain("Gamma");
	});

	it("pages through items with PgDn when the list has no sections", () => {
		const changes: Array<[string, string]> = [];
		const items = Array.from({ length: 12 }, (_, i) => ({
			id: `item${i}`,
			label: `Item ${i}`,
			currentValue: "off",
			values: ["off", "on"] as string[],
		}));
		const list = new SettingsList(
			items,
			5,
			testTheme,
			(id, value) => {
				changes.push([id, value]);
			},
			() => {},
		);

		// PgDn advances by one viewport (5); PgDn again clamps to the last item.
		list.handleInput("\x1b[6~");
		list.handleInput("\n");
		expect(changes).toEqual([["item5", "on"]]);

		list.handleInput("\x1b[6~");
		list.handleInput("\x1b[6~");
		list.handleInput("\n");
		expect(changes).toEqual([
			["item5", "on"],
			["item11", "on"],
		]);
	});
});
