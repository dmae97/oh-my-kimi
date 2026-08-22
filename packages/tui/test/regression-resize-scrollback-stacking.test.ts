/**
 * Regression: full clearing redraws (resize, viewport jumps) must repaint
 * only the visible tail. Re-printing the entire transcript pushed a fresh
 * copy of already-finalized history into the terminal's scrollback on every
 * height-resize cycle, so scrolling up showed the transcript repeated
 * ("TV-wall" stacking) — e.g. a mid-history line appeared 5x after two
 * shrink/grow cycles.
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

function occurrences(rows: string[], probe: string): number {
	return rows.map((row) => row.trimEnd()).filter((row) => row === probe).length;
}

describe("resize scrollback stacking regression", () => {
	it("does not stack duplicate history across height resize cycles", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		component.lines = mkLines(60);
		tui.start();
		await terminal.waitForRender();

		for (const rows of [10, 24, 10, 24]) {
			terminal.resize(80, rows);
			await terminal.waitForRender().catch(() => terminal.flush());
		}

		const buffer = terminal.getScrollBuffer();
		for (const probe of ["L30", "L45", "L60"]) {
			const count = occurrences(buffer, probe);
			assert.ok(count <= 2, `${probe} appears ${count}x in scrollback after resize cycles (stacking)`);
		}
		tui.stop();
	});

	it("keeps the viewport tail correct and history intact after resize plus append", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		component.lines = mkLines(40);
		tui.start();
		await terminal.waitForRender();

		terminal.resize(80, 10);
		await terminal.waitForRender().catch(() => terminal.flush());
		component.lines = mkLines(41);
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport().map((row) => row.trimEnd());
		assert.ok(viewport.includes("L41"), `viewport tail missing L41: ${JSON.stringify(viewport.slice(-5))}`);
		const buffer = terminal.getScrollBuffer();
		for (const probe of ["L39", "L40", "L41"]) {
			assert.strictEqual(occurrences(buffer, probe), 1, `${probe} must appear exactly once`);
		}
		tui.stop();
	});

	it("still prints everything on the clean first render", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		component.lines = mkLines(30);
		tui.start();
		await terminal.waitForRender();

		const buffer = terminal.getScrollBuffer();
		for (let index = 1; index <= 30; index++) {
			assert.strictEqual(occurrences(buffer, `L${index}`), 1, `L${index} must appear exactly once`);
		}
		tui.stop();
	});
});
