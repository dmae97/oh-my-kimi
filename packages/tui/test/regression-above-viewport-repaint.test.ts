/**
 * Regression: when a change lands above the current viewport
 * (firstChanged < previousViewportTop), the renderer fell back to a
 * clearing full render that only repaints the visible tail. Rows that had
 * already scrolled into terminal scrollback kept their stale content and
 * the updated rows were never emitted at all — scrolling up showed old
 * partial content (clipped/corrupted assistant answers, phantom loaders).
 *
 * Real triggers: a streamed code block gaining syntax highlighting when its
 * closing fence arrives, a tool loader being replaced by its result, or a
 * thinking block collapsing — all after the affected rows left the viewport.
 *
 * The clearing redraw must instead reprint from the first changed row so
 * the newest copy of every changed row lands adjacent to the live viewport.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

function mkLines(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `L${index + 1}`);
}

/** Physical transcript rows with trailing blank viewport padding removed. */
function physicalTranscript(terminal: VirtualTerminal): string[] {
	const rows = terminal.getScrollBuffer().map((row) => row.trimEnd());
	while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
	return rows;
}

describe("above-viewport change repaint regression", () => {
	it("repaints rows mutated above the viewport instead of leaving stale scrollback", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		component.lines = mkLines(20); // 20 lines in a 10-row terminal: rows 0-9 scrolled off
		tui.start();
		await terminal.waitForRender();

		// A late restyle (e.g. code-fence close) rewrites L3 while streaming appends L21.
		const updated = mkLines(20);
		updated[2] = "L3-UPDATED";
		updated.push("L21");
		component.lines = updated;
		tui.requestRender();
		await terminal.waitForRender();

		const physical = physicalTranscript(terminal);
		assert.ok(physical.includes("L3-UPDATED"), "mutated above-viewport row was never painted to the terminal");

		// The newest copy of every row from firstChanged down must be contiguous at the end.
		const expectedTail = updated.slice(2);
		const actualTail = physical.slice(physical.length - expectedTail.length);
		assert.deepStrictEqual(actualTail, expectedTail);
		tui.stop();
	});

	it("repaints from the shrink point when content above the viewport is removed", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		component.lines = mkLines(30);
		tui.start();
		await terminal.waitForRender();

		// Loader swap with a smaller result: 3 middle rows replaced by 2 new
		// ones (mutation + shrink) while the transcript stays taller than the
		// viewport. Pure shrink alone lets stale scrollback rows coincide with
		// the shifted content; the mutation makes the stale region detectable.
		const shrunk = [...mkLines(10), "RESULT-A", "RESULT-B", ...mkLines(30).slice(13)];
		component.lines = shrunk;
		tui.requestRender();
		await terminal.waitForRender();

		const physical = physicalTranscript(terminal);
		// From the shrink point (index 10) down, the physical transcript must
		// match the new logical content exactly and contiguously.
		const expectedTail = shrunk.slice(10);
		const actualTail = physical.slice(physical.length - expectedTail.length);
		assert.deepStrictEqual(actualTail, expectedTail);
		tui.stop();
	});
});
