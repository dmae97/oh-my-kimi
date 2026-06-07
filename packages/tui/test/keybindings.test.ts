import { describe, expect, it } from "bun:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui/keybindings";

describe("KeybindingsManager", () => {
	it("does not evict selector confirm when input submit is rebound", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": ["enter", "ctrl+enter"],
		});

		expect(keybindings.getKeys("tui.input.submit")).toEqual(["enter", "ctrl+enter"]);
		expect(keybindings.getKeys("tui.select.confirm")).toEqual(["enter"]);
	});

	it("does not evict cursor bindings when another action reuses the same key", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.select.up": ["up", "ctrl+p"],
		});

		expect(keybindings.getKeys("tui.select.up")).toEqual(["up", "ctrl+p"]);
		expect(keybindings.getKeys("tui.editor.cursorUp")).toEqual(["up"]);
	});

	it("preserves Shift when matching printable uppercase letters", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.copy": "shift+a",
		});

		expect(keybindings.matches("A", "tui.input.copy")).toBe(true);
		expect(keybindings.matches("a", "tui.input.copy")).toBe(false);
	});

	it("still reports direct user binding conflicts without evicting defaults", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": "ctrl+x",
			"tui.select.confirm": "ctrl+x",
		});

		expect(keybindings.getConflicts()).toEqual([
			{
				key: "ctrl+x",
				keybindings: ["tui.input.submit", "tui.select.confirm"],
			},
		]);
		expect(keybindings.getKeys("tui.editor.cursorLeft")).toEqual(["left", "ctrl+b"]);
	});
});
