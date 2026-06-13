import { beforeAll, describe, expect, it, vi } from "bun:test";
import {
	CustomEditor,
	extractBracketedImagePastePath,
	extractBracketedImagePastePaths,
} from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { defaultEditorTheme } from "../../tui/test/test-themes";

beforeAll(async () => {
	// CustomEditor.decorateText resolves theme colors during shimmer rendering;
	// load a deterministic theme so colour-mode-dependent palettes are cached.
	await initTheme(false);
});

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

describe("CustomEditor bracketed image path paste", () => {
	it("routes a single pasted image path to the image-path handler", () => {
		const editor = createEditor();
		const paths: string[] = [];
		editor.onPasteImagePath = path => {
			paths.push(path);
		};

		editor.handleInput("\x1b[200~/tmp/screenshot.png\x1b[201~");

		expect(paths).toEqual(["/tmp/screenshot.png"]);
		expect(editor.getText()).toBe("");
	});

	it("routes multiple pasted image paths to the image-path handler in order", async () => {
		const editor = createEditor();
		const paths: string[] = [];
		editor.onPasteImagePath = path => {
			paths.push(path);
		};

		editor.handleInput("\x1b[200~/tmp/first.png /tmp/second.webp\x1b[201~");
		await Promise.resolve();

		expect(paths).toEqual(["/tmp/first.png", "/tmp/second.webp"]);
		expect(editor.getText()).toBe("");
	});

	it("keeps spaces inside pasted image paths when splitting a multi-image paste", () => {
		expect(
			extractBracketedImagePastePaths("\x1b[200~/tmp/My First Screenshot.png /tmp/second image.jpg\x1b[201~"),
		).toEqual(["/tmp/My First Screenshot.png", "/tmp/second image.jpg"]);
	});

	it("unescapes shell-escaped spaces in pasted image paths", () => {
		expect(extractBracketedImagePastePaths("\x1b[200~/tmp/My\\ First.png /tmp/second.gif\x1b[201~")).toEqual([
			"/tmp/My First.png",
			"/tmp/second.gif",
		]);
	});

	it("leaves ordinary bracketed paste text on the editor path", () => {
		expect(extractBracketedImagePastePath("\x1b[200~not an image.txt\x1b[201~")).toBeUndefined();
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

describe("CustomEditor model selector and display reset keybindings", () => {
	it("uses Alt+M for the model selector and Ctrl+L for display reset by default", () => {
		const editor = createEditor();
		const onSelectModel = vi.fn();
		const onDisplayReset = vi.fn();
		editor.onSelectModel = onSelectModel;
		editor.onDisplayReset = onDisplayReset;

		editor.handleInput("\x1bm");
		expect(onSelectModel).toHaveBeenCalledTimes(1);
		expect(onDisplayReset).not.toHaveBeenCalled();

		editor.handleInput(ctrl("l"));
		expect(onSelectModel).toHaveBeenCalledTimes(1);
		expect(onDisplayReset).toHaveBeenCalledTimes(1);
	});

	it("lets display reset win when an old model remap also uses Ctrl+L", () => {
		const editor = createEditor();
		const onSelectModel = vi.fn();
		const onDisplayReset = vi.fn();
		editor.onSelectModel = onSelectModel;
		editor.onDisplayReset = onDisplayReset;
		editor.setActionKeys("app.model.select", ["ctrl+l"]);
		editor.setActionKeys("app.display.reset", ["ctrl+l"]);

		editor.handleInput(ctrl("l"));

		expect(onDisplayReset).toHaveBeenCalledTimes(1);
		expect(onSelectModel).not.toHaveBeenCalled();
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

describe("CustomEditor configurable key dispatch precedence", () => {
	it("checks backward model cycling before forward cycling when both use the same key", () => {
		const editor = createEditor();
		const onCycleModelBackward = vi.fn();
		const onCycleModelForward = vi.fn();
		editor.onCycleModelBackward = onCycleModelBackward;
		editor.onCycleModelForward = onCycleModelForward;
		editor.setActionKeys("app.model.cycleBackward", ["ctrl+p"]);
		editor.setActionKeys("app.model.cycleForward", ["ctrl+p"]);

		editor.handleInput(ctrl("p"));

		expect(onCycleModelBackward).toHaveBeenCalledTimes(1);
		expect(onCycleModelForward).not.toHaveBeenCalled();
	});

	it("runs a built-in action before a colliding custom handler", () => {
		const editor = createEditor();
		const onClear = vi.fn();
		const customHandler = vi.fn();
		editor.onClear = onClear;
		editor.setActionKeys("app.clear", ["ctrl+x"]);
		editor.setCustomKeyHandler("ctrl+x", customHandler);

		editor.handleInput(ctrl("x"));

		expect(onClear).toHaveBeenCalledTimes(1);
		expect(customHandler).not.toHaveBeenCalled();
	});

	it("falls through a guarded built-in action to a custom handler", () => {
		const editor = createEditor();
		const customHandler = vi.fn();
		editor.setActionKeys("app.clear", ["ctrl+x"]);
		editor.setCustomKeyHandler("ctrl+x", customHandler);

		editor.handleInput(ctrl("x"));

		expect(customHandler).toHaveBeenCalledTimes(1);
	});

	it("always consumes exit even when no exit callback is installed", () => {
		const editor = createEditor();
		const customHandler = vi.fn();
		editor.setActionKeys("app.exit", ["x"]);
		editor.setCustomKeyHandler("x", customHandler);

		editor.handleInput("x");

		expect(customHandler).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});

	it("passes unparseable printable input to the parent editor path", () => {
		const editor = createEditor();
		const onClear = vi.fn();
		const customHandler = vi.fn();
		editor.onClear = onClear;
		editor.setActionKeys("app.clear", ["h"]);
		editor.setCustomKeyHandler("h", customHandler);

		editor.handleInput("hello");

		expect(onClear).not.toHaveBeenCalled();
		expect(customHandler).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("hello");
	});
});

describe("CustomEditor magic-keyword shimmer", () => {
	function createFocusedEditor() {
		const editor = new CustomEditor(defaultEditorTheme);
		editor.focused = true;
		return editor;
	}

	it("schedules a repaint frame after rendering a focused editor that contains a keyword", async () => {
		const editor = createFocusedEditor();
		const repaint = vi.fn();
		editor.setShimmerRepaintHandler(repaint);
		editor.setText("please ultrathink this carefully");

		// Drive a render frame: that's what arms the shimmer setTimeout chain.
		editor.render(80);
		await Bun.sleep(CustomEditor.SHIMMER_FRAME_MS + 30);

		expect(repaint).toHaveBeenCalledTimes(1);
		// Clean up so the next render does not arm a stray timer leaking into other tests.
		editor.setShimmerRepaintHandler(undefined);
	});

	it("does not schedule a repaint when the editor is not focused", async () => {
		const editor = new CustomEditor(defaultEditorTheme);
		editor.focused = false;
		const repaint = vi.fn();
		editor.setShimmerRepaintHandler(repaint);
		editor.setText("please ultrathink this carefully");

		editor.render(80);
		await Bun.sleep(CustomEditor.SHIMMER_FRAME_MS + 30);

		expect(repaint).not.toHaveBeenCalled();
		editor.setShimmerRepaintHandler(undefined);
	});

	it("does not schedule a repaint when no magic keyword is in the buffer", async () => {
		const editor = createFocusedEditor();
		const repaint = vi.fn();
		editor.setShimmerRepaintHandler(repaint);
		editor.setText("just a plain prompt");

		editor.render(80);
		await Bun.sleep(CustomEditor.SHIMMER_FRAME_MS + 30);

		expect(repaint).not.toHaveBeenCalled();
		editor.setShimmerRepaintHandler(undefined);
	});

	it("clears any pending shimmer frame when the handler is unbound", async () => {
		const editor = createFocusedEditor();
		const repaint = vi.fn();
		editor.setShimmerRepaintHandler(repaint);
		editor.setText("ultrathink please");

		editor.render(80);
		// Unbind the handler before the in-flight frame fires; the timer is dropped.
		editor.setShimmerRepaintHandler(undefined);
		await Bun.sleep(CustomEditor.SHIMMER_FRAME_MS + 30);

		expect(repaint).not.toHaveBeenCalled();
	});

	it("paints the keyword glyph through the trailing CURSOR_MARKER (no cursor seam)", () => {
		const editor = createFocusedEditor();
		editor.setText("ultrathink");

		const rendered = editor.render(40).join("\n");
		// The keyword is broken into per-character runs by SGR escapes once the
		// gradient paints it; with the cursor-seam bug the keyword would survive
		// verbatim. Strip ANSI to make the visible-width invariant explicit.
		expect(rendered).not.toContain("ultrathink");
		expect(rendered).toContain("\x1b[38");
	});

	it("respects the magicKeywords.enabled setting (no shimmer when disabled)", async () => {
		const { Settings, resetSettingsForTest } = await import("@oh-my-pi/pi-coding-agent/config/settings");
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "magicKeywords.enabled": false } });
		try {
			const editor = createFocusedEditor();
			const repaint = vi.fn();
			editor.setShimmerRepaintHandler(repaint);
			editor.setText("ultrathink please");

			editor.render(80);
			await Bun.sleep(CustomEditor.SHIMMER_FRAME_MS + 30);

			expect(repaint).not.toHaveBeenCalled();
			editor.setShimmerRepaintHandler(undefined);
		} finally {
			resetSettingsForTest();
		}
	});
});
