import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, type NativeScrollbackLiveRegion, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// Regression for a streaming block whose committed sealed prefix collapses on
// abort while the editor is below it. The editor must stay at the viewport
// bottom instead of leaving a blank gap underneath.

class Transcript implements Component, NativeScrollbackLiveRegion {
	lines: string[] = [];
	/** Declared-final boundary: rows above it may enter native scrollback. */
	seam = 0;

	invalidate(): void {}

	render(_width: number): readonly string[] {
		return this.lines;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.seam;
	}
}

class Editor implements Component, Focusable {
	focused = false;
	text = "> ";

	invalidate(): void {}

	setUseTerminalCursor(): void {}

	render(_width: number): readonly string[] {
		return [this.text + CURSOR_MARKER];
	}
}

function rows(prefix: string, n: number, from = 0): string[] {
	return Array.from({ length: n }, (_, i) => `${prefix}${from + i}`);
}

describe("abort-collapse gap regression", () => {
	it("keeps the editor bottom-aligned after a committed live block collapses", async () => {
		const height = 10;
		const term = new VirtualTerminal(40, height, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const transcript = new Transcript();
		const editor = new Editor();
		tui.addChild(transcript);
		tui.addChild(editor);
		tui.setFocus(editor);

		// 20 finalized rows + live block streaming.
		transcript.lines = [...rows("hist-", 20), ...rows("live-", 4)];
		transcript.seam = 20; // nothing of the live block declared final yet

		try {
			tui.start();
			await scheduler.drain(term);

			// Stream: live block grows, its declared-final prefix advances behind
			// the tail (a streaming reply's settled markdown prefix).
			for (let grow = 8; grow <= 24; grow += 4) {
				transcript.lines = [...rows("hist-", 20), ...rows("live-", grow)];
				transcript.seam = 20 + grow - 2; // declared-final prefix trails by 2
				tui.requestRender();
				await scheduler.drain(term);
			}

			// ABORT: the live block collapses after some of its declared-final
			// prefix reached native scrollback. The viewport should pull the short
			// tail back down instead of pinning the editor near the top with blank
			// rows underneath.
			transcript.lines = [...rows("hist-", 20), "aborted!", "interrupted"];
			transcript.seam = 22;
			tui.requestRender();
			await scheduler.drain(term);

			expect(term.getViewport().map(row => Bun.stripANSI(row).trimEnd())).toEqual([
				"hist-13",
				"hist-14",
				"hist-15",
				"hist-16",
				"hist-17",
				"hist-18",
				"hist-19",
				"aborted!",
				"interrupted",
				">",
			]);

			editor.text = "> a";
			tui.requestRender();
			await scheduler.drain(term);

			expect(term.getViewport().map(row => Bun.stripANSI(row).trimEnd())).toEqual([
				"hist-13",
				"hist-14",
				"hist-15",
				"hist-16",
				"hist-17",
				"hist-18",
				"hist-19",
				"aborted!",
				"interrupted",
				"> a",
			]);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});
