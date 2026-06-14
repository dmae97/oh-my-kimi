import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { $ } from "bun";
import { getEditorTheme, initTheme } from "../theme/theme";
import { CustomEditor, SPACE_HOLD_RELEASE_MS, SPACE_HOLD_THRESHOLD } from "./custom-editor";

function makeEditor() {
	const editor = new CustomEditor(getEditorTheme());
	const events: string[] = [];
	editor.sttHoldEnabled = () => true;
	editor.onSpaceHoldStart = () => events.push("start");
	editor.onSpaceHoldEnd = () => events.push("end");
	return { editor, events };
}

function holdSpace(editor: CustomEditor, count: number): void {
	for (let i = 0; i < count; i++) editor.handleInput(" ");
}

async function decorateInFreshProcess(text: string): Promise<string> {
	const customEditorUrl = new URL("./custom-editor.ts", import.meta.url).href;
	const script = `
import { CustomEditor } from ${JSON.stringify(customEditorUrl)};
const editor = new CustomEditor({});
process.stdout.write(editor.decorateText(${JSON.stringify(text)}));
`;
	const child = await $`bun -e ${script}`.quiet().nothrow();
	const stdout = child.stdout.toString();
	const stderr = child.stderr.toString();
	if (child.exitCode !== 0) throw new Error(stderr || stdout || `decorate subprocess exited with ${child.exitCode}`);
	return stdout;
}

describe("CustomEditor placeholder decoration", () => {
	it("renders paste placeholders before theme initialization", async () => {
		const output = await decorateInFreshProcess("[Paste #1, +30 lines]");
		expect(output).toBe("[Paste #1, +30 lines]");
	});

	it("renders image placeholders before theme initialization", async () => {
		const output = await decorateInFreshProcess("[Image #1]");
		expect(output).toBe("[Image #1]");
	});
});

describe("CustomEditor space-hold push-to-talk", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("inserts spaces normally below the hold threshold", () => {
		const { editor, events } = makeEditor();
		holdSpace(editor, SPACE_HOLD_THRESHOLD);
		expect(editor.getText()).toBe(" ".repeat(SPACE_HOLD_THRESHOLD));
		expect(events).toEqual([]);
	});

	it("tracks back the space burst and drives the hold lifecycle", () => {
		vi.useFakeTimers();
		const { editor, events } = makeEditor();
		editor.handleInput("h");
		editor.handleInput("i");
		// Crossing the threshold deletes the optimistically-inserted spaces and starts recording,
		// leaving only the pre-burst text behind.
		holdSpace(editor, SPACE_HOLD_THRESHOLD + 1);
		expect(editor.getText()).toBe("hi");
		expect(events).toEqual(["start"]);
		// Continued auto-repeat while the bar is held is swallowed: no spam, no re-trigger.
		holdSpace(editor, 5);
		expect(editor.getText()).toBe("hi");
		expect(events).toEqual(["start"]);
		// An idle gap with no further repeats means the bar was released -> stop + transcribe.
		vi.advanceTimersByTime(SPACE_HOLD_RELEASE_MS + 1);
		expect(events).toEqual(["start", "end"]);
	});

	it("does not trigger when a non-space breaks the run", () => {
		const { editor, events } = makeEditor();
		holdSpace(editor, SPACE_HOLD_THRESHOLD);
		editor.handleInput("x");
		holdSpace(editor, SPACE_HOLD_THRESHOLD);
		expect(events).toEqual([]);
		expect(editor.getText()).toBe(`${" ".repeat(SPACE_HOLD_THRESHOLD)}x${" ".repeat(SPACE_HOLD_THRESHOLD)}`);
	});

	it("leaves the space bar typing normally when the gesture is disabled", () => {
		const { editor, events } = makeEditor();
		editor.sttHoldEnabled = () => false;
		holdSpace(editor, SPACE_HOLD_THRESHOLD + 5);
		expect(editor.getText()).toBe(" ".repeat(SPACE_HOLD_THRESHOLD + 5));
		expect(events).toEqual([]);
	});
});
