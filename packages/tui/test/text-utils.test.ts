import { describe, expect, it } from "bun:test";
import { extractSegments, sliceWithWidth, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui/utils";

describe("text utils", () => {
	it("computes visible width for ANSI and tabs", () => {
		const text = `\x1b[31mhi\tthere\x1b[0m`;
		expect(visibleWidth(text)).toBe(2 + 3 + 5);
	});

	it("does not double-count pure ASCII tabs", () => {
		expect(visibleWidth("a\tb")).toBe(1 + 3 + 1);
	});

	it("treats Arabic combining marks as zero-width", () => {
		expect(visibleWidth("بَسِمَ")).toBe(3);
	});
	it("ignores OSC hyperlinks in visible width", () => {
		const text = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
		expect(visibleWidth(text)).toBe(4);
	});

	it("counts a styled ZWJ emoji the same as the unstyled emoji (ANSI is zero-width)", () => {
		// Family emoji built from ZWJ-joined code points renders as a single
		// 2-cell grapheme. Wrapping it in SGR styling must not change its width:
		// the grapheme fallback splits ANSI into separate segments, and the
		// native scanner only skips ANSI when handed the complete escape — so
		// the SGR bytes (`[`, `3`, `1`, `m`, …) must be excised before
		// segmentation, not counted as visible cells.
		const emoji = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}";
		const styled = `\x1b[31m${emoji}\x1b[0m`;
		expect(visibleWidth(emoji)).toBe(2);
		expect(visibleWidth(styled)).toBe(visibleWidth(emoji));
		// Styling around only part of a ZWJ-containing span is also zero-width.
		expect(visibleWidth(`a\x1b[1m${emoji}\x1b[22mb`)).toBe(1 + 2 + 1);
		// Plain styled ASCII is unaffected — ANSI strips to its visible text.
		expect(visibleWidth("\x1b[31mhello\x1b[0m")).toBe(visibleWidth("hello"));
	});

	it("truncates ANSI text with ellipsis", () => {
		const text = "\x1b[31mhello world\x1b[0m";
		const result = truncateToWidth(text, 6);
		expect(result.includes("\x1b[0m…")).toBe(true);
		expect(visibleWidth(result)).toBe(6);
	});

	it("slices visible columns while preserving ANSI", () => {
		const text = "\x1b[31mhello\x1b[0m world";
		const result = sliceWithWidth(text, 1, 4, true);
		expect(result.text.startsWith("\x1b[31mello")).toBe(true);
		expect(result.width).toBe(4);
	});

	it("extracts segments with inherited styling", () => {
		const text = "\x1b[31mhello world\x1b[0m";
		const result = extractSegments(text, 3, 6, 5, true);
		expect(result.before).toContain("hel");
		expect(result.after.startsWith("\x1b[31m")).toBe(true);
		expect(result.afterWidth).toBeGreaterThan(0);
	});
});
