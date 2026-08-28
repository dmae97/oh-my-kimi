/**
 * Regression: clearing redraws must not dump the live frame into scrollback.
 *
 * conpty / Windows Terminal implement Erase All (\x1b[2J) by shifting the
 * entire viewport into scrollback and starting a new viewport below it
 * (microsoft/terminal#5683), unlike xterm which erases in place. Every
 * clearing redraw therefore buried a copy of the live chrome — prompt box,
 * footer, loader — in the user's history on WSL, so scrolling back through a
 * finished report kept running into stale prompt boxes chopping it apart.
 *
 * Clearing redraws now repaint in place (home + per-row erase + erase-to-end).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const ERASE_ALL = "\x1b[2J";
const PROMPT_MARKER = "| > prompt box";

/** Terminal whose Erase All behaves like conpty: viewport moves to scrollback. */
class ConptyVirtualTerminal extends VirtualTerminal {
	override write(data: string): void {
		if (!data.includes(ERASE_ALL)) {
			super.write(data);
			return;
		}
		const dumpViewport = `\x1b[${this.rows};1H${"\n".repeat(this.rows)}\x1b[H`;
		super.write(data.split(ERASE_ALL).join(dumpViewport));
	}
}

class Transcript implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

/** Pinned chrome: prompt box + footer, always the tail of the frame. */
class Chrome implements Component {
	render(width: number): string[] {
		return [`+${"-".repeat(Math.max(0, width - 2))}+`, PROMPT_MARKER, "ctx 12% | model | main"];
	}
	invalidate(): void {}
}

function promptCopies(terminal: VirtualTerminal): number {
	return terminal.getScrollBuffer().filter((row) => row.trimEnd() === PROMPT_MARKER).length;
}

describe("conpty viewport dump regression", () => {
	it("keeps a single prompt box in the buffer across clearing redraws", async () => {
		const terminal = new ConptyVirtualTerminal(60, 12);
		const tui = new TUI(terminal);
		const transcript = new Transcript();
		tui.addChild(transcript);
		tui.addChild(new Chrome());
		transcript.lines = Array.from({ length: 40 }, (_, index) => `REPORT ${String(index + 1).padStart(2, "0")}`);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(promptCopies(terminal), 1, "precondition: one live prompt box");

		// Clearing redraws: height resize cycle, then a repair above the viewport.
		for (const rows of [8, 12]) {
			terminal.resize(60, rows);
			await terminal.waitForRender();
		}
		transcript.lines[20] = "REPORT 21 (late tool result)";
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(
			promptCopies(terminal),
			1,
			"a clearing redraw buried the live prompt box in scrollback (report is chopped when scrolling back)",
		);
		tui.stop();
	});

	it("still repaints leftovers when the frame shrinks", async () => {
		const terminal = new ConptyVirtualTerminal(60, 12);
		const tui = new TUI(terminal);
		const transcript = new Transcript();
		tui.addChild(transcript);
		transcript.lines = Array.from({ length: 10 }, (_, index) => `L${index + 1}`);
		tui.start();
		await terminal.waitForRender();

		// Force a clearing redraw with fewer lines than the previous frame.
		transcript.lines = ["only line"];
		tui.requestRender(true);
		await terminal.waitForRender();

		const viewport = terminal.getViewport().map((row) => row.trimEnd());
		assert.strictEqual(viewport[0], "only line");
		assert.ok(
			viewport.slice(1).every((row) => row === ""),
			`stale rows left on screen: ${JSON.stringify(viewport.slice(1))}`,
		);
		tui.stop();
	});
});
