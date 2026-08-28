/**
 * Regression: repairing a row that changed above the viewport must not cost
 * the whole transcript. The repair repaint re-emits every row from the changed
 * one down, and each re-emitted row evicts an older row from the terminal's
 * finite scrollback. In a long session (an earlier prompt box or a late tool
 * result mutating far above the viewport) a single changed row re-emitted
 * hundreds of rows and pushed the beginning of the current report out of
 * scrollback — the report looked truncated when scrolling back.
 *
 * The repaint is now bounded to a few viewport screens: recent history is
 * still repaired, older rows keep their stale copy instead of being "fixed"
 * at the cost of the transcript.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Must match TUI.REPAINT_BUDGET_SCREENS. */
const REPAINT_BUDGET_SCREENS = 4;

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

function bufferRows(terminal: VirtualTerminal): string[] {
	return terminal.getScrollBuffer().map((row) => row.trimEnd());
}

function occurrences(rows: string[], probe: string): number {
	return rows.filter((row) => row === probe).length;
}

describe("above-viewport repaint budget regression", () => {
	it("keeps the report's beginning in scrollback when a row above the viewport changes", async () => {
		const height = 10;
		const terminal = new VirtualTerminal(80, height);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		// A long report, taller than the terminal's scrollback headroom
		// (xterm-headless keeps 1000 rows).
		component.lines = [
			"PROMPT BOX: write the report",
			...Array.from({ length: 900 }, (_, index) => `REPORT ${String(index + 1).padStart(3, "0")}`),
		];
		tui.start();
		await terminal.waitForRender();

		const before = bufferRows(terminal);
		assert.ok(before.includes("REPORT 001"), "precondition: report start is in the buffer");

		// A row deep inside the transcript but above the viewport mutates — a late
		// tool result replacing its loader, a code fence restyled on close, or an
		// earlier prompt box being re-rendered.
		component.lines[450] = "REPORT 450 (updated)";
		tui.requestRender();
		await terminal.waitForRender();

		const after = bufferRows(terminal);
		assert.ok(
			after.includes("REPORT 001"),
			"report start was evicted from scrollback by the repair repaint (report looks truncated)",
		);
		assert.ok(
			after.length - before.length <= height * REPAINT_BUDGET_SCREENS,
			`repair repaint churned ${after.length - before.length} rows (budget ${height * REPAINT_BUDGET_SCREENS})`,
		);
		// Rows outside the budget window are never re-emitted, so history older
		// than the budget is not duplicated either.
		assert.strictEqual(occurrences(after, "REPORT 700"), 1, "row outside the budget window was duplicated");
		tui.stop();
	});

	it("still repairs changes inside the budget", async () => {
		const height = 10;
		const terminal = new VirtualTerminal(80, height);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		component.lines = Array.from({ length: 30 }, (_, index) => `L${index + 1}`);
		tui.start();
		await terminal.waitForRender();

		// Row 13 sits above the viewport (top row 20) but well inside the budget.
		const updated = [...component.lines];
		updated[12] = "L13-UPDATED";
		component.lines = updated;
		tui.requestRender();
		await terminal.waitForRender();

		const rows = bufferRows(terminal);
		while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
		assert.ok(rows.includes("L13-UPDATED"), "in-budget above-viewport change was never repainted");
		const expectedTail = updated.slice(12);
		assert.deepStrictEqual(rows.slice(rows.length - expectedTail.length), expectedTail);
		tui.stop();
	});
});
