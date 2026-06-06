import { afterEach, describe, expect, it } from "bun:test";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";

// Geometry-reflow contract for the *real* terminal driven through the *real*
// renderer. These exercise the seam VirtualTerminal cannot model: the OS channel
// (SIGWINCH) and the DEC 2048 in-band channel disagreeing. The observable
// contract is `probe.last` — the width the transcript actually reflowed to.
describe("ProcessTerminal geometry reflow through the renderer", () => {
	let harness: ProcessTerminalRenderHarness | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("reflows to the OS width on resize when in-band resize is inactive", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		expect(harness.probe.last).toBe(100);

		await harness.osResize(160, 40);

		expect(harness.terminal.columns).toBe(160);
		expect(harness.probe.last).toBe(160);
	});

	it("reflows to the OS width when the post-resize in-band report is missed", async () => {
		// The regression: SIGWINCH fires and process.stdout dims update, but the
		// matching DEC 2048 report is dropped/malformed. Before the fix the getter
		// stayed pinned to the cached report and the transcript reflowed at the old
		// width — content never resized.
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.feed("\x1b[?2048;1$y"); // DECRPM: 2048 supported -> in-band active
		await harness.inBand(30, 100, 600, 1000); // seed cached geometry at 100 cols
		expect(harness.probe.last).toBe(100);

		await harness.osResize(160, 40); // no follow-up in-band report

		expect(harness.terminal.columns).toBe(160);
		expect(harness.probe.last).toBe(160);
	});

	it("reflows to in-band geometry that disagrees with the OS (in-band stays authoritative)", async () => {
		// No OS resize: process.stdout stays at 100, but an in-band report claims
		// 140. The getter must keep preferring in-band (it can be more accurate than
		// ioctl under some multiplexers), so the reconcile fix must not make the OS
		// channel unconditionally win.
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.feed("\x1b[?2048;1$y");
		await harness.inBand(30, 100, 600, 1000);

		await harness.inBand(30, 140, 700, 1400);

		expect(harness.terminal.columns).toBe(140);
		expect(harness.probe.last).toBe(140);
	});

	it("reflows when an in-band report is split across stdin reads", async () => {
		// A report fragmented mid-sequence must be reassembled by StdinBuffer within
		// the flush window and still drive a reflow — exercises the parser through
		// the full ProcessTerminal -> TUI stack.
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.feed("\x1b[?2048;1$y");
		await harness.inBand(30, 100, 600, 1000);

		await harness.feed("\x1b[48;40;160", ";800;1600t");

		expect(harness.terminal.columns).toBe(160);
		expect(harness.probe.last).toBe(160);
	});
});
