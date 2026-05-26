/**
 * Regression guard for Korean IME cursor positioning in the Input
 * component.
 *
 * Background: macOS Korean IME (2-bul keyboard) emits Hangul Compatibility
 * Jamo (U+3131..U+318E) during composition. Before commit 79e3170c6 the
 * Input.render() computed `cursorCols = visibleWidth(value.slice(0,
 * cursorIndex))` and `Bun.stringWidth` returned 2 for each jamo (per UAX
 * #11 EAW=W), while every macOS terminal renders them as 1 cell.
 *
 * The user-visible bug was a GROWING horizontal gap between the typed
 * jamo and the IME candidate window — every additional jamo doubled the
 * offset because `cursorCols` was N×2 instead of N×1. With 14 jamo typed,
 * the gap was ~14 cells.
 *
 * After the JS-side width correction, `cursorCols` is N×1. The Rust
 * `pi-natives` `sliceWithWidth` still treats jamo as 2 cells (binary
 * package; follow-up), so the cursor marker placement in `Input.render()`
 * has a residual ≤1-cell-per-jamo offset — but the user-visible "growing
 * gap" is gone because the JS-side `cursorCols` no longer doubles.
 *
 * What this test guards:
 *   - The cursor column for a value containing N jamo is **bounded above
 *     by `PROMPT_WIDTH + N`** (the correct cell count after the fix).
 *     Before the fix it would have been ~`PROMPT_WIDTH + 2N`, which is
 *     what the test catches.
 *   - Pure-ASCII and Hangul-syllable baselines are unchanged.
 *
 * What this test does NOT guard:
 *   - The Rust-side `sliceWithWidth` jamo discrepancy. Tracked as a
 *     follow-up; will tighten this test once the Rust crate is rebuilt.
 */
import { describe, expect, it } from "bun:test";
import { CURSOR_MARKER } from "@oh-my-pi/pi-tui";
import { Input } from "@oh-my-pi/pi-tui/components/input";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

/**
 * Drive `text` through `Input.handleInput()` one Unicode code point at a
 * time (mirrors what the IME does — one code point per emitted sequence),
 * then return the visual column where the hardware cursor marker lands
 * in the rendered output.
 */
function cursorColAfterTyping(text: string, width = 80): number {
	const input = new Input();
	(input as unknown as { focused: boolean }).focused = true;
	for (const char of text) {
		input.handleInput(char);
	}
	const [line] = input.render(width);
	const markerIdx = line.indexOf(CURSOR_MARKER);
	if (markerIdx < 0) {
		throw new Error(`CURSOR_MARKER not found in rendered line: ${JSON.stringify(line)}`);
	}
	return visibleWidth(line.slice(0, markerIdx));
}

const PROMPT_WIDTH = 2; // "> "

// The jamo-cursor regression (PR #1410 / origin issue) only applies on
// macOS, where terminals render Hangul Compatibility Jamo as 1 cell while
// UAX#11 (and `Bun.stringWidth`) report 2. Off-darwin both the terminal and
// the width helper agree on 2, so the doubling regression cannot occur.
const IS_DARWIN = process.platform === "darwin";

describe("Input cursor column does not grow at 2× per jamo", () => {
	it("ASCII baseline: cursor lands exactly after the typed text", () => {
		expect(cursorColAfterTyping("hello")).toBe(PROMPT_WIDTH + 5);
	});

	it("Hangul syllables: cursor lands exactly after typed text (2 cells each)", () => {
		expect(cursorColAfterTyping("안녕")).toBe(PROMPT_WIDTH + 4);
	});

	it.skipIf(!IS_DARWIN)("single jamo: cursor column is at most `PROMPT_WIDTH + 1`", () => {
		// Before fix: PROMPT_WIDTH + 2 = 4. After fix: ≤ 3.
		expect(cursorColAfterTyping("ㅁ")).toBeLessThanOrEqual(PROMPT_WIDTH + 1);
	});

	it.skipIf(!IS_DARWIN)("8 consecutive jamo: cursor column is at most `PROMPT_WIDTH + 8`", () => {
		// Before fix: PROMPT_WIDTH + 16 = 18. After fix: ≤ 10.
		expect(cursorColAfterTyping("ㅁㄴㅁㄴㅇㅂㄴㅂ")).toBeLessThanOrEqual(PROMPT_WIDTH + 8);
	});

	it.skipIf(!IS_DARWIN)("20 consecutive jamo: cursor column is at most `PROMPT_WIDTH + 20`", () => {
		// Before fix: PROMPT_WIDTH + 40 = 42 (catastrophic gap). After fix: ≤ 22.
		const jamo = "ㅁㄴㄷㅂㅈㅎㅋㅌㄱㄹ".repeat(2);
		expect(cursorColAfterTyping(jamo)).toBeLessThanOrEqual(PROMPT_WIDTH + 20);
	});

	it.skipIf(!IS_DARWIN)("cursor column grows by ≤1 per typed jamo (not 2)", () => {
		// The regression: each typed jamo would advance cursor by 2 columns
		// instead of 1, doubling the offset every keystroke. Assert the
		// per-step delta never exceeds 1.
		const input = new Input();
		(input as unknown as { focused: boolean }).focused = true;
		const jamo = "ㅁㄴㅇㅂㅈㅎㅋㅌㄷㄹ";
		let prevCol = PROMPT_WIDTH;
		for (let i = 0; i < jamo.length; i++) {
			input.handleInput(jamo[i]);
			const [line] = input.render(80);
			const markerIdx = line.indexOf(CURSOR_MARKER);
			const col = visibleWidth(line.slice(0, markerIdx));
			const delta = col - prevCol;
			expect(delta).toBeLessThanOrEqual(1);
			prevCol = col;
		}
	});
});
