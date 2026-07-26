import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Records the width it was asked to render at and fills the row edge-to-edge. */
class WidthProbe implements Component {
	widths: number[] = [];
	render(width: number): string[] {
		this.widths.push(width);
		return [`L${"~".repeat(Math.max(0, width - 2))}R`];
	}
	invalidate(): void {}
}

class Rail implements Component {
	render(width: number): string[] {
		return Array.from({ length: 3 }, () => `|${"#".repeat(Math.max(0, width - 2))}|`);
	}
	invalidate(): void {}
}

describe("TUI right gutter (pinned rail layout reservation)", () => {
	it("renders children at full width when no gutter is set", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const probe = new WidthProbe();
		tui.addChild(probe);

		tui.start();
		await terminal.waitForRender();
		tui.stop();

		assert.strictEqual(probe.widths.at(-1), 80);
	});

	it("reserves the gutter: children render at columns - gutter", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const probe = new WidthProbe();
		tui.addChild(probe);
		tui.setRightGutter(20);

		tui.start();
		await terminal.waitForRender();
		tui.stop();

		assert.strictEqual(probe.widths.at(-1), 60);
		assert.strictEqual(tui.contentWidth, 60);
	});

	it("keeps overlays at full-terminal coordinates so a rail owns the gutter", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const probe = new WidthProbe();
		tui.addChild(probe);

		tui.setRightGutter(21); // 20-column rail + 1 gap
		tui.showOverlay(new Rail(), { anchor: "top-right", width: 20, nonCapturing: true });

		tui.start();
		await terminal.waitForRender();
		tui.stop();

		assert.strictEqual(probe.widths.at(-1), 59);

		const viewport = terminal.getViewport();
		const railRow = viewport.find((line) => line.includes("|##"));
		assert.ok(railRow, "rail overlay should be composited");
		// Rail occupies the last 20 columns; content stays in the first 59.
		assert.strictEqual(railRow.slice(60, 80), `|${"#".repeat(18)}|`);
		const contentRow = viewport.find((line) => line.startsWith("L~"));
		assert.ok(contentRow, "content row should render");
		assert.strictEqual(contentRow.slice(0, 59), `L${"~".repeat(57)}R`);
	});

	it("supports a responsive width callback on overlays, in lockstep with the gutter", async () => {
		const terminal = new VirtualTerminal(120, 24);
		const tui = new TUI(terminal);
		const probe = new WidthProbe();
		tui.addChild(probe);

		const railWidths: number[] = [];
		class WidthTrackingRail implements Component {
			render(width: number): string[] {
				railWidths.push(width);
				return [`|${"#".repeat(Math.max(0, width - 2))}|`];
			}
			invalidate(): void {}
		}
		const railWidth = (w: number) => Math.max(20, Math.min(30, Math.floor(w * 0.25)));
		tui.showOverlay(new WidthTrackingRail(), { anchor: "top-right", width: (w) => railWidth(w), nonCapturing: true });
		tui.setRightGutter((w) => railWidth(w) + 1);

		tui.start();
		await terminal.waitForRender();
		tui.stop();

		// floor(120 * 0.25) = 30 → rail renders at 30, content at 120 - 31.
		assert.strictEqual(railWidths.at(-1), 30);
		assert.strictEqual(probe.widths.at(-1), 89);
	});

	it("supports a size-aware callback and clamps to keep minimal content width", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const probe = new WidthProbe();
		tui.addChild(probe);
		tui.setRightGutter((termWidth) => (termWidth >= 100 ? 30 : 0));

		tui.start();
		await terminal.waitForRender();
		tui.stop();
		// 80 < 100 → callback returns 0 → full width.
		assert.strictEqual(probe.widths.at(-1), 80);

		// An absurd gutter is clamped so content keeps a readable minimum.
		tui.setRightGutter(500);
		assert.strictEqual(tui.contentWidth, 20);
	});
});
