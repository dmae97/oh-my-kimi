import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class StaticOverlay implements Component {
	private readonly marker: string;
	constructor(marker: string) {
		this.marker = marker;
	}
	render(): string[] {
		return [this.marker];
	}
	invalidate(): void {}
}

class EmptyContent implements Component {
	render(): string[] {
		return [];
	}
	invalidate(): void {}
}

async function renderAndFlush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
}

function viewportText(terminal: VirtualTerminal): string {
	return terminal.getViewport().join("\n");
}

describe("TUI hideOverlaysExcept", () => {
	it("keeps pinned chrome when called with nothing above it (session-resume regression)", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const rail = new StaticOverlay("STATUS_RAIL_MARKER");
		const dialog = new StaticOverlay("DIALOG_MARKER");

		tui.addChild(new EmptyContent());
		tui.showOverlay(rail, { anchor: "top-right", nonCapturing: true });
		tui.start();
		await renderAndFlush(tui, terminal);
		assert.ok(viewportText(terminal).includes("STATUS_RAIL_MARKER"), "rail visible before reset");

		// Dialog opens on top, then closes — the resume/new/fork reset path used to
		// blind-pop the topmost overlay here and evict the rail for good.
		const dialogHandle = tui.showOverlay(dialog, { width: 20 });
		dialogHandle.hide();
		tui.hideOverlaysExcept(rail);
		await renderAndFlush(tui, terminal);

		assert.ok(tui.hasOverlay(), "an overlay remains");
		assert.ok(viewportText(terminal).includes("STATUS_RAIL_MARKER"), "rail still visible after reset");
		tui.stop();
	});

	it("pops transient overlays above the kept component", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const rail = new StaticOverlay("STATUS_RAIL_MARKER");
		const dialog = new StaticOverlay("DIALOG_MARKER");

		tui.addChild(new EmptyContent());
		tui.showOverlay(rail, { anchor: "top-right", nonCapturing: true });
		tui.showOverlay(dialog, { width: 20 });
		tui.start();
		await renderAndFlush(tui, terminal);
		assert.ok(viewportText(terminal).includes("DIALOG_MARKER"), "dialog visible before reset");

		tui.hideOverlaysExcept(rail);
		await renderAndFlush(tui, terminal);

		const text = viewportText(terminal);
		assert.ok(text.includes("STATUS_RAIL_MARKER"), "rail kept");
		assert.ok(!text.includes("DIALOG_MARKER"), "dialog popped");
		tui.stop();
	});

	it("pops everything when no component is given (legacy catch-all behavior)", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const rail = new StaticOverlay("STATUS_RAIL_MARKER");
		const dialog = new StaticOverlay("DIALOG_MARKER");

		tui.addChild(new EmptyContent());
		tui.showOverlay(rail, { anchor: "top-right", nonCapturing: true });
		tui.showOverlay(dialog, { width: 20 });
		tui.start();
		await renderAndFlush(tui, terminal);

		tui.hideOverlaysExcept();
		await renderAndFlush(tui, terminal);

		assert.ok(!tui.hasOverlay(), "all overlays popped");
		tui.stop();
	});

	it("pops everything when the kept component is not in the stack", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const rail = new StaticOverlay("STATUS_RAIL_MARKER");
		const stranger = new StaticOverlay("STRANGER_MARKER");

		tui.addChild(new EmptyContent());
		tui.showOverlay(rail, { anchor: "top-right", nonCapturing: true });
		tui.start();
		await renderAndFlush(tui, terminal);

		tui.hideOverlaysExcept(stranger);
		assert.ok(!tui.hasOverlay(), "all overlays popped");
		tui.stop();
	});
});
