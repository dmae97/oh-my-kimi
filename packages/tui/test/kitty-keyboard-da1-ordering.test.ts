import { afterEach, describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";

// Progressive-enhancement probe ordering contract. omp sends `CSI ? u \\ CSI c`
// at startup: the kitty reply (`CSI ? <flags> u`) authoritatively says the
// terminal speaks the kitty keyboard protocol; the DA1 reply (`CSI ? ... c`)
// is only a sentinel that guarantees a reply even from terminals that ignore
// `CSI ? u`. Some terminals (Superset / xterm-on-Electron) answer DA1 first;
// the kitty reply must still be honored regardless of ordering.

class ModalProbe implements Component {
	invalidate(): void {}
	render(): string[] {
		return ["modal"];
	}
}
describe("ProcessTerminal kitty keyboard progressive-enhancement ordering", () => {
	let harness: ProcessTerminalRenderHarness | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("enables kitty when the kitty reply arrives before the DA1 sentinel", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		expect(harness.writes.join("")).toContain("\x1b[?u\x1b[c");
		harness.writes.length = 0;

		await harness.feed("\x1b[?0u", "\x1b[?1;2c");

		const out = harness.writes.join("");
		expect(harness.terminal.kittyProtocolActive).toBe(true);
		expect(out).toContain("\x1b[>1u");
		expect(out).not.toContain("\x1b[>4;2m");
	});

	it("enables kitty when the DA1 sentinel arrives before the kitty reply (#2042)", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		harness.writes.length = 0;

		// Superset/Electron-xterm answers DA1 before `CSI ? u`. The kitty reply
		// must override the premature modifyOtherKeys fallback.
		await harness.feed("\x1b[?1;2c", "\x1b[?0u");

		const out = harness.writes.join("");
		expect(harness.terminal.kittyProtocolActive).toBe(true);
		expect(out).toContain("\x1b[>1u");
		const enableIdx = out.indexOf("\x1b[>4;2m");
		const disableIdx = out.indexOf("\x1b[>4;0m");
		const kittyIdx = out.indexOf("\x1b[>1u");
		expect(enableIdx).toBeGreaterThanOrEqual(0);
		expect(disableIdx).toBeGreaterThan(enableIdx);
		expect(kittyIdx).toBeGreaterThan(enableIdx);
	});

	it("keeps the modifyOtherKeys fallback when only DA1 ever replies", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		harness.writes.length = 0;

		// Terminals that ignore `CSI ? u` answer DA1 only — modifyOtherKeys is
		// the right answer there.
		await harness.feed("\x1b[?1;2c");

		const out = harness.writes.join("");
		expect(harness.terminal.kittyProtocolActive).toBe(false);
		expect(out).toContain("\x1b[>4;2m");
		expect(out).not.toContain("\x1b[>1u");
	});

	it("reasserts modifyOtherKeys fallback when fullscreen overlays enter the alternate screen", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		harness.writes.length = 0;

		await harness.feed("\x1b[?1;2c");
		expect(harness.writes.join("")).toContain("\x1b[>4;2m");
		harness.writes.length = 0;

		const overlay = harness.tui.showOverlay(new ModalProbe(), {
			fullscreen: true,
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		await harness.settle();

		const out = harness.writes.join("");
		expect(out).toContain("\x1b[?1049h\x1b[>4;2m");
		overlay.hide();
	});
});
