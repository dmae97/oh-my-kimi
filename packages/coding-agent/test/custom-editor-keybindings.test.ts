import { describe, expect, it, vi } from "bun:test";
import { defaultEditorTheme } from "../../tui/test/test-themes";
import { CustomEditor } from "../src/modes/components/custom-editor";

function ctrl(key: string): string {
	return String.fromCharCode(key.toLowerCase().charCodeAt(0) & 31);
}

function createEditor() {
	return new CustomEditor(defaultEditorTheme);
}

describe("CustomEditor literal question mark input", () => {
	it("does not reserve ? as a hotkeys shortcut when the editor is empty", () => {
		const editor = createEditor();

		editor.handleInput("?");

		expect(editor.getText()).toBe("?");
	});
});

describe("CustomEditor temporary model selector keybinding", () => {
	it("triggers the temporary selector from a remapped action key instead of Alt+P", () => {
		const editor = createEditor();
		const onSelectModelTemporary = vi.fn();
		editor.onSelectModelTemporary = onSelectModelTemporary;
		editor.setActionKeys("app.model.selectTemporary", ["ctrl+y"]);

		editor.handleInput(ctrl("y"));
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);

		editor.handleInput("\x1bp");
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);
	});

	it("removes the default Alt+P shortcut when the action is disabled", () => {
		const editor = createEditor();
		const onSelectModelTemporary = vi.fn();
		editor.onSelectModelTemporary = onSelectModelTemporary;

		editor.handleInput("\x1bp");
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);

		editor.setActionKeys("app.model.selectTemporary", []);
		editor.handleInput("\x1bp");
		expect(onSelectModelTemporary).toHaveBeenCalledTimes(1);
	});
});

describe("CustomEditor escape key dispatch", () => {
	function installAutocompleteProvider(editor: CustomEditor) {
		editor.setAutocompleteProvider({
			async getSuggestions() {
				return { items: [{ label: "src/", value: "src/" }], prefix: "@" };
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
		});
	}

	it("dismisses the autocomplete popup on the first ESC and only fires onEscape on the second", async () => {
		const editor = createEditor();
		const onEscape = vi.fn();
		editor.onEscape = onEscape;
		installAutocompleteProvider(editor);

		editor.handleInput("@");
		// Yield so the async provider populates and the popup opens.
		await Bun.sleep(0);
		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("\x1b");
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(onEscape).not.toHaveBeenCalled();

		editor.handleInput("\x1b");
		expect(onEscape).toHaveBeenCalledTimes(1);
	});

	it("fires onEscape immediately when no autocomplete popup is visible", () => {
		const editor = createEditor();
		const onEscape = vi.fn();
		editor.onEscape = onEscape;

		editor.handleInput("\x1b");
		expect(onEscape).toHaveBeenCalledTimes(1);
	});
});
