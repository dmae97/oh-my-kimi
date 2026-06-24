import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { $ } from "bun";
import { getEditorTheme, initTheme } from "../theme/theme";
import {
	CustomEditor,
	extractBracketedImagePastePaths,
	extractBracketedPastePaths,
	SPACE_HOLD_MECHANICAL_RUN,
	SPACE_HOLD_RELEASE_MS,
	SPACE_REPEAT_MAX_GAP_MS,
} from "./custom-editor";

function makeEditor() {
	const editor = new CustomEditor(getEditorTheme());
	const events: string[] = [];
	editor.sttHoldEnabled = () => true;
	editor.onSpaceHoldStart = () => events.push("start");
	editor.onSpaceHoldEnd = () => events.push("end");
	return { editor, events };
}

/** A gap below SPACE_REPEAT_MAX_GAP_MS — looks like OS key auto-repeat (a held bar). */
const REPEAT_GAP_MS = 30;
/** A gap above the threshold — looks like a deliberate keypress. */
const TAP_GAP_MS = SPACE_REPEAT_MAX_GAP_MS + 80;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function bracketedPaste(text: string): string {
	return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

/** Feed `count` spaces `gapMs` apart on the fake clock. The first space of a run has no prior
 *  space, so its gap is effectively infinite and it always reads as a deliberate tap. */
function feedSpaces(editor: CustomEditor, count: number, gapMs: number): void {
	for (let i = 0; i < count; i++) {
		vi.advanceTimersByTime(gapMs);
		editor.handleInput(" ");
	}
}

/** Feed spaces at explicit per-press gaps (ms) on the fake clock — for simulating an irregular cadence. */
function feedGaps(editor: CustomEditor, gaps: number[]): void {
	for (const gapMs of gaps) {
		vi.advanceTimersByTime(gapMs);
		editor.handleInput(" ");
	}
}

async function decorateInFreshProcess(text: string, imageLinks?: readonly string[]): Promise<string> {
	const customEditorUrl = new URL("./custom-editor.ts", import.meta.url).href;
	const script = `
import { CustomEditor } from ${JSON.stringify(customEditorUrl)};
const editor = new CustomEditor({});
editor.imageLinks = ${JSON.stringify(imageLinks)};
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

	it("renders linked image placeholders before theme and settings initialization", async () => {
		const output = await decorateInFreshProcess("[Image #1]", ["/tmp/example.png"]);
		expect(output).toBe("[Image #1]");
	});
});

describe("CustomEditor bracketed path paste", () => {
	it("leaves a pasted bare .png filename on the normal text path", () => {
		expect(extractBracketedImagePastePaths(bracketedPaste("icon-photo-default.png"))).toBeUndefined();
	});

	it("extracts explicit local image paths for attachment", () => {
		expect(extractBracketedImagePastePaths(bracketedPaste("/tmp/icon-photo-default.png"))).toEqual([
			"/tmp/icon-photo-default.png",
		]);
		expect(extractBracketedImagePastePaths(bracketedPaste("C:\\Users\\me\\icon-photo-default.png"))).toEqual([
			"C:\\Users\\me\\icon-photo-default.png",
		]);
	});

	it("extracts explicit non-image paths without classifying them as image paths", () => {
		expect(extractBracketedPastePaths(bracketedPaste("/tmp/report.csv"))).toEqual(["/tmp/report.csv"]);
		expect(extractBracketedImagePastePaths(bracketedPaste("/tmp/report.csv"))).toBeUndefined();
	});

	it("routes non-image path pastes through the file-path hook", async () => {
		const { editor } = makeEditor();
		const pasted = Promise.withResolvers<string>();
		editor.onPasteFilePath = path => pasted.resolve(path);

		editor.handleInput(bracketedPaste("/tmp/report.csv"));

		expect(await pasted.promise).toBe("/tmp/report.csv");
		expect(editor.getText()).toBe("");
	});
});

describe("CustomEditor space-hold push-to-talk", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("types deliberate space taps without triggering, even several in a row", () => {
		const { editor, events } = makeEditor();
		feedSpaces(editor, 3, TAP_GAP_MS);
		expect(editor.getText()).toBe("   ");
		expect(events).toEqual([]);
	});

	it("recognizes a held bar from a steady fast cadence and tracks back the burst", () => {
		const { editor, events } = makeEditor();
		editor.handleInput("h");
		editor.handleInput("i");
		// Metronomic auto-repeat: the few pre-burst spaces typed are tracked back out when the hold is
		// recognized, leaving only the pre-burst text.
		feedSpaces(editor, SPACE_HOLD_MECHANICAL_RUN + 2, REPEAT_GAP_MS);
		expect(editor.getText()).toBe("hi");
		expect(events).toEqual(["start"]);
		// Continued auto-repeat while the bar is held is swallowed: no spam, no re-trigger.
		feedSpaces(editor, 5, REPEAT_GAP_MS);
		expect(editor.getText()).toBe("hi");
		expect(events).toEqual(["start"]);
		// An idle gap with no further repeats means the bar was released -> stop + transcribe.
		vi.advanceTimersByTime(SPACE_HOLD_RELEASE_MS + 1);
		expect(events).toEqual(["start", "end"]);
	});

	it("does not trigger when the space bar is smashed at an irregular cadence", () => {
		const { editor, events } = makeEditor();
		// Fast but jittery, the way a human mashes — not the metronomic delta of OS auto-repeat.
		const gaps = [40, 95, 45, 100, 35, 90, 50, 105];
		feedGaps(editor, gaps);
		expect(events).toEqual([]);
		// Nothing is eaten: every smashed space still types a real space.
		expect(editor.getText()).toBe(" ".repeat(gaps.length));
	});

	it("does not trigger on steady but slow spacing", () => {
		const { editor, events } = makeEditor();
		// Even cadence, but slower than auto-repeat: consistent deltas alone must not start recording.
		feedSpaces(editor, 6, TAP_GAP_MS);
		expect(events).toEqual([]);
		expect(editor.getText()).toBe(" ".repeat(6));
	});

	it("does not trigger when a non-space breaks the run", () => {
		const { editor, events } = makeEditor();
		// Each partial run climbs the mechanical counter one short of the threshold; the non-space
		// resets it so they never combine into a hold.
		feedSpaces(editor, 3, REPEAT_GAP_MS);
		editor.handleInput("x");
		feedSpaces(editor, 3, REPEAT_GAP_MS);
		expect(events).toEqual([]);
	});

	it("leaves the space bar typing normally when the gesture is disabled", () => {
		const { editor, events } = makeEditor();
		editor.sttHoldEnabled = () => false;
		feedSpaces(editor, 8, REPEAT_GAP_MS);
		expect(editor.getText()).toBe(" ".repeat(8));
		expect(events).toEqual([]);
	});
});
