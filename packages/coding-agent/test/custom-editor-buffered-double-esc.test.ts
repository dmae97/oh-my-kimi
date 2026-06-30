import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { StdinBuffer } from "@oh-my-pi/pi-tui/stdin-buffer";

/**
 * Regression for #3857.
 *
 * A fast double-Esc lands as one `"\x1b\x1b"` chunk on stdin. Before the fix,
 * `StdinBuffer` either held it as the buffered remainder and timer-flushed it
 * as one sequence, or emitted it as one sequence when followed by a non-CSI
 * byte. Either way `parseKey("\x1b\x1b")` returns `undefined`, so
 * `CustomEditor.handleInput` fell through to the base editor and never fired
 * the configured `onEscape` — breaking the double-escape gesture (and any
 * single-Esc handler the second press should have hit).
 *
 * The fix splits a bare `"\x1b\x1b"` into two ESC events at the buffer layer,
 * matching the existing split for `"\x1b" + "\x1b[<…"` SGR mouse reports.
 */
describe("buffered double-Esc reaches CustomEditor.onEscape", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("fires onEscape twice when a fast double-Esc arrives as one buffered chunk", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onEscape = vi.fn();
		editor.onEscape = onEscape;

		const buf = new StdinBuffer({ timeout: 5, partialHoldTimeout: 5 });
		buf.on("data", chunk => editor.handleInput(chunk));

		buf.process("\x1b\x1b");
		// Drain the flush timer chain (main timeout + zero-delay deferral).
		vi.runAllTimers();

		expect(onEscape).toHaveBeenCalledTimes(2);
		buf.destroy();
	});

	it("fires onEscape twice when a double-Esc arrives as one inline chunk followed by a non-CSI byte", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onEscape = vi.fn();
		editor.onEscape = onEscape;

		const forwardedToBase: string[] = [];
		const baseHandleInput = vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(editor)), "handleInput");
		baseHandleInput.mockImplementation(function (this: unknown, data: unknown) {
			forwardedToBase.push(data as string);
		});

		const buf = new StdinBuffer({ timeout: 5, partialHoldTimeout: 5 });
		buf.on("data", chunk => editor.handleInput(chunk));

		buf.process("\x1b\x1bX");
		vi.runAllTimers();

		expect(onEscape).toHaveBeenCalledTimes(2);
		// The trailing printable still reaches the base editor in order, after
		// both ESC keypresses have fired their handler.
		expect(forwardedToBase).toEqual(["X"]);
		buf.destroy();
	});

	it("does not split a meta-CSI arrow into two ESC events", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onEscape = vi.fn();
		editor.onEscape = onEscape;

		const buf = new StdinBuffer({ timeout: 5, partialHoldTimeout: 5 });
		buf.on("data", chunk => editor.handleInput(chunk));

		buf.process("\x1b\x1b[A");
		vi.runAllTimers();

		// alt+up is its own keypress and must never look like two ESC keys.
		expect(onEscape).not.toHaveBeenCalled();
		buf.destroy();
	});
});
