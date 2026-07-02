import { describe, expect, it, vi } from "bun:test";
import type { ExtensionUIContext } from "../../extensibility/extensions";
import { CustomEditor } from "../components/custom-editor";
import { getEditorTheme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { ExtensionUiController } from "./extension-ui-controller";

function makeHarness() {
	const editor = new CustomEditor(getEditorTheme());
	const requestRender = vi.fn();
	let uiContext: ExtensionUIContext | undefined;
	const ctx = {
		editor,
		ui: {
			requestRender,
		},
		session: {
			extensionRunner: undefined,
		},
		setToolUIContext(context: ExtensionUIContext, hasUI: boolean): void {
			expect(hasUI).toBe(true);
			uiContext = context;
		},
	} as unknown as InteractiveModeContext;

	return {
		editor,
		requestRender,
		async init(): Promise<ExtensionUIContext> {
			await new ExtensionUiController(ctx).initHooksAndCustomTools();
			expect(uiContext).toBeDefined();
			return uiContext!;
		},
	};
}

describe("ExtensionUiController editor UI", () => {
	it("requests a render after extension pasteToEditor mutates the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.pasteToEditor("hello");
		ui.pasteToEditor(" world");

		expect(harness.editor.getText()).toBe("hello world");
		expect(harness.requestRender).toHaveBeenCalledTimes(2);
	});

	it("requests a render after extension setEditorText replaces the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.setEditorText("hello");

		expect(harness.editor.getText()).toBe("hello");
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
	});
});
