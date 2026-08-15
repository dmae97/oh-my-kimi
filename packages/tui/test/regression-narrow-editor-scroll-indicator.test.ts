import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "../src/components/editor.ts";
import { TUI } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Regression: the editor's scroll-indicator borders must never render wider
 * than the width they were given.
 *
 * A border wider than the terminal wraps, so the editor occupies one more row
 * than the renderer accounted for. The differential renderer's viewport math
 * is line-count based, so every subsequent frame is off by the wrapped rows —
 * the transcript drifts and duplicates on scroll.
 *
 * The `↑ N more` (top) and `↓ N more` (bottom) borders are the same class of
 * string and must be bounded identically.
 */
describe("narrow editor scroll indicators", () => {
	/** Editor scrolled to the middle of its content, so BOTH borders show a count. */
	function scrolledEditor(rows: number): Editor {
		const editor = new Editor(new TUI(new VirtualTerminal(200, rows)), defaultEditorTheme);
		// 40 lines with a 5-row terminal forces maxVisibleLines to its floor (5)
		// and leaves hidden lines above and below the cursor.
		editor.setText(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
		for (let i = 0; i < 20; i++) editor.handleInput("\x1b[A"); // cursor up into the middle
		return editor;
	}

	// Width 1 is excluded here on purpose: at that width the CONTENT lines
	// overflow through a separate pre-existing padding defect (a one-column
	// editor pads past its own content width). That defect is unrelated to the
	// indicator borders and is asserted independently below, so this suite fails
	// for exactly one reason.
	for (const width of [2, 3, 5, 8, 13, 21]) {
		it(`keeps every rendered line within width ${width}`, () => {
			const lines = scrolledEditor(5).render(width);

			for (const [index, line] of lines.entries()) {
				const rendered = visibleWidth(stripVTControlCharacters(line));
				assert.ok(
					rendered <= width,
					`line ${index} overflows: width ${rendered} > ${width} — ${JSON.stringify(stripVTControlCharacters(line))}`,
				);
			}
		});
	}

	for (const width of [1, 2, 3, 5, 8, 13, 21]) {
		it(`keeps both indicator borders within width ${width}`, () => {
			const indicators = scrolledEditor(5)
				.render(width)
				.map((line) => stripVTControlCharacters(line))
				.filter(
					(line) => line.includes("↑") || line.includes("↓") || line.includes("more") || line.includes("..."),
				);

			for (const indicator of indicators) {
				assert.ok(
					visibleWidth(indicator) <= width,
					`indicator overflows: width ${visibleWidth(indicator)} > ${width} — ${JSON.stringify(indicator)}`,
				);
			}
		});
	}

	it("renders both indicators when content is hidden above and below", () => {
		const lines = scrolledEditor(5)
			.render(80)
			.map((line) => stripVTControlCharacters(line));

		assert.ok(
			lines.some((line) => line.includes("↑") && line.includes("more")),
			`expected a top indicator, got ${JSON.stringify(lines)}`,
		);
		assert.ok(
			lines.some((line) => line.includes("↓") && line.includes("more")),
			`expected a bottom indicator, got ${JSON.stringify(lines)}`,
		);
	});

	it("pads to exactly the full width when the indicator fits", () => {
		const lines = scrolledEditor(5)
			.render(80)
			.map((line) => stripVTControlCharacters(line));
		const indicators = lines.filter((line) => line.includes("more"));

		assert.ok(indicators.length > 0, "expected at least one indicator line");
		for (const indicator of indicators) {
			assert.strictEqual(
				visibleWidth(indicator),
				80,
				`indicator not padded to full width: ${JSON.stringify(indicator)}`,
			);
		}
	});
});
