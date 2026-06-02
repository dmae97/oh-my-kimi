/**
 * Regression guard for the Hangul Compatibility Jamo width correction in
 * `visibleWidthRaw`.
 *
 * `Bun.stringWidth` (and the underlying UAX#11 EAW tables) classify Hangul
 * Compatibility Jamo (U+3131..U+318E) as Wide (2 cells), but every macOS
 * terminal we ship to (Ghostty, Terminal.app, iTerm2) actually renders them
 * as a single cell. Without the correction, `#extractCursorPosition` doubles
 * the column count for every jamo emitted by a Korean IME during
 * composition, displacing the hardware cursor (and therefore the IME
 * candidate window) `N_jamo` cells past the actual glyph.
 *
 * Hangul Syllables (U+AC00..U+D7A3, e.g. `안`) are correctly 2 cells in both
 * Bun and the terminal — make sure the fix did NOT regress that. The
 * Halfwidth Hangul block (U+FFA0..U+FFDC) is already classified as Narrow
 * by Bun, so it does not appear in the correction and the test below is a
 * regression sanity check.
 */
import { describe, expect, it } from "bun:test";
import { Ellipsis, sliceWithWidth, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui/utils";

// The macOS-only correction (see PR #1410) keeps jamo at 1 cell on darwin;
// every other platform follows UAX#11 and reports 2 cells per jamo.
const JAMO_CELLS = process.platform === "darwin" ? 1 : 2;

describe("visibleWidth — Hangul Compatibility Jamo correction", () => {
	it("single compatibility jamo is 1 cell on darwin, 2 elsewhere", () => {
		// U+3141 HANGUL LETTER MIEUM
		expect(visibleWidth("ㅁ")).toBe(JAMO_CELLS);
		// U+3134 HANGUL LETTER NIEUN
		expect(visibleWidth("ㄴ")).toBe(JAMO_CELLS);
		// U+3147 HANGUL LETTER IEUNG
		expect(visibleWidth("ㅇ")).toBe(JAMO_CELLS);
		// U+3142 HANGUL LETTER PIEUP
		expect(visibleWidth("ㅂ")).toBe(JAMO_CELLS);
		// U+3148 HANGUL LETTER JIEUJ
		expect(visibleWidth("ㅈ")).toBe(JAMO_CELLS);
	});

	it("range edges U+3131 and U+318E follow platform width", () => {
		// U+3131 HANGUL LETTER KIYEOK — first jamo in the block
		expect(visibleWidth("\u3131")).toBe(JAMO_CELLS);
		// U+318E HANGUL LETTER ARAEAE — last jamo in the block
		expect(visibleWidth("\u318e")).toBe(JAMO_CELLS);
	});

	it("U+3164 HANGUL FILLER (inside the corrected range) follows platform width", () => {
		// Often emitted by IME for empty-syllable placeholders. The filler is the
		// one code point in the block that UAX#11 / `unicode-width` classify as
		// zero-width, so off-darwin it measures 0 cells. On darwin the blanket
		// jamo correction (U+3131..U+318E → 1) forces it to a single cell.
		const fillerCells = process.platform === "darwin" ? 1 : 0;
		expect(visibleWidth("\u3164")).toBe(fillerCells);
	});

	it("string of 8 consecutive jamo is 8 cells on darwin, 16 elsewhere", () => {
		// Matches the user-typed sequence in the v2 screen recording —
		// before the macOS fix this returned 16 and produced an 8-cell gap.
		expect(visibleWidth("ㅁㄴㅁㄴㅇㅂㄴㅂ")).toBe(8 * JAMO_CELLS);
	});

	it("Hangul Syllables (U+AC00..U+D7A3) stay at 2 cells", () => {
		// `안` U+C548 — composed syllable, must remain 2 cells
		expect(visibleWidth("안")).toBe(2);
		// `녕` U+B155 — composed syllable
		expect(visibleWidth("녕")).toBe(2);
		// Whole word: 안녕 = 4 cells
		expect(visibleWidth("안녕")).toBe(4);
		// First & last in the block, for boundary coverage
		expect(visibleWidth("\uac00")).toBe(2); // 가
		expect(visibleWidth("\ud7a3")).toBe(2); // 힣
	});

	it("mixed ASCII + syllable + jamo strings add correctly", () => {
		// a (1) + 안 (2) + ㅂ (J) + b (1) = 4 + J
		expect(visibleWidth("a안ㅂb")).toBe(4 + JAMO_CELLS);
		// 11 ASCII letters + 1 syllable + 4 jamo = 11 + 2 + 4*J
		expect(visibleWidth("hello world안ㅁㄴㅇㅂ")).toBe(11 + 2 + 4 * JAMO_CELLS);
	});

	it("does not regress ASCII fast path or empty input", () => {
		expect(visibleWidth("")).toBe(0);
		expect(visibleWidth("hello")).toBe(5);
		expect(visibleWidth("a")).toBe(1);
		// Tab character (ASCII 0x09) inside the fast path expands to >2
		expect(visibleWidth("a\tb")).toBeGreaterThan(2);
	});

	it("does not change width for other CJK characters", () => {
		// Chinese: 漢字 (each 2 cells)
		expect(visibleWidth("漢字")).toBe(4);
		// Japanese hiragana: あい (each 2 cells)
		expect(visibleWidth("あい")).toBe(4);
		// Japanese katakana: アイ (each 2 cells)
		expect(visibleWidth("アイ")).toBe(4);
	});

	it("Halfwidth Hangul block is unaffected (already Narrow in Bun)", () => {
		// U+FFA1 HALFWIDTH HANGUL LETTER KIYEOK — Bun reports 1, untouched.
		expect(visibleWidth("\uffa1")).toBe(1);
		// U+FFDC HALFWIDTH HANGUL LETTER I
		expect(visibleWidth("\uffdc")).toBe(1);
	});
});

describe("native text helpers — Hangul Compatibility Jamo correction", () => {
	// These exercise the Rust-side `char_width_corrected` wrapper in
	// crates/pi-natives/src/text.rs. They will fail until the native
	// binding is rebuilt (`bun run build:native`); CI rebuilds natives so
	// they pass there. Mirrors the TS-side range U+3131..=U+318E.

	it("sliceWithWidth treats jamo per platform width", () => {
		// 8 jamo at JAMO_CELLS cells each must fit fully within the
		// platform's natural cell count.
		const input = "ㅁ".repeat(8);
		const { text, width } = sliceWithWidth(input, 0, 8 * JAMO_CELLS, true);
		expect(text).toBe(input);
		expect(width).toBe(8 * JAMO_CELLS);
	});

	it("truncateToWidth keeps 8 jamo within their platform budget", () => {
		// On darwin (1 cell/jamo) 8 jamo fit in 8 cells; off-darwin they need 16.
		const result = truncateToWidth("ㅁ".repeat(20), 8 * JAMO_CELLS, Ellipsis.Omit);
		// Strip any trailing pad to count jamo content.
		const jamo = result.replaceAll(/[^\u3131-\u318E]/g, "");
		expect(jamo.length).toBe(8);
	});

	it("native and TS visibleWidth agree on a jamo run", () => {
		// Cross-layer parity guard: without the native fix, the TS path
		// (Bun.stringWidth + manual correction) and the native path
		// (unicode_width) disagreed by a factor of 2.
		const input = "ㅁㄴㅇㅂㅈㄷㄱㅅ";
		expect(visibleWidth(input)).toBe(8 * JAMO_CELLS);
		expect(sliceWithWidth(input, 0, 8 * JAMO_CELLS, true).width).toBe(8 * JAMO_CELLS);
	});
});
