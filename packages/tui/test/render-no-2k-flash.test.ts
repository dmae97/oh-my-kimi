/**
 * Regression guard for the BSU-split blank-flash fix.
 *
 * Two render paths in `tui.ts` previously emitted `\x1b[2K` (erase entire
 * line) BEFORE the new content, all wrapped in BSU (`\x1b[?2026h…l`):
 *
 *   1. Differential render — per changed line.
 *   2. `viewportRefresh()` — per line when a row above the viewport changed.
 *
 * When BSU mode 2026 splits across PTY reads in tmux + ghostty (~4 KB
 * chunks), the erase reaches the terminal before the content arrives — the
 * user sees the line blank for a frame. The fix moves the erase to AFTER
 * the content (`\x1b[m\x1b[K`): old content stays on screen until new
 * content overwrites it, so a BSU split never leaves a transient blank.
 *
 * These tests intercept every `write()` to a CapturingTerminal, drive the
 * TUI through a sequence that triggers each path, and assert no
 * `\x1b[2K` byte sequence appears in any of the post-startup frames.
 */
import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class CapturingTerminal extends VirtualTerminal {
	public readonly writes: string[] = [];
	/**
	 * Snapshots `writes.length` at the time of the call; all writes recorded
	 * after this point can be retrieved via `framesSince()`.
	 */
	mark(): number {
		return this.writes.length;
	}
	framesSince(idx: number): string {
		return this.writes.slice(idx).join("");
	}
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

class MutableLineComponent implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = [...lines];
	}
	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return [...this.#lines];
	}
}

describe("TUI render — erase-after-content (no `\x1b[2K` flash)", () => {
	it("differential render emits no `\\x1b[2K` when a single line changes", async () => {
		const term = new CapturingTerminal(80, 24);
		const tui = new TUI(term);
		const comp = new MutableLineComponent(["line-0", "line-1", "line-2"]);
		tui.addChild(comp);

		tui.start();
		await Bun.sleep(0);
		await term.waitForRender();

		// Snapshot AFTER startup full render. We only care about subsequent
		// differential frames — the startup `fullRender(false)` path is
		// allowed to use `\x1b[2J` etc.; the regression target is the
		// per-keystroke differential path.
		const mark = term.mark();

		// Flip one line — drives the differential render path.
		comp.setLines(["line-0", "CHANGED", "line-2"]);
		tui.invalidate();
		tui.requestRender();
		await Bun.sleep(0);
		await term.waitForRender();

		const frames = term.framesSince(mark);
		// Sanity: the differential path actually fired (the test itself is
		// exercising something, not just a no-op).
		expect(frames).toContain("CHANGED");
		// Regression target: no `\x1b[2K` anywhere in the emitted frames.
		expect(frames).not.toContain("\x1b[2K");
		// And the replacement pattern emits `\x1b[m\x1b[K` after content.
		expect(frames).toContain("\x1b[m\x1b[K");

		tui.stop();
	});

	it("trailing-extra-line clear path uses `\\x1b[m\\x1b[K`, not `\\x1b[2K`", async () => {
		const term = new CapturingTerminal(80, 24);
		const tui = new TUI(term);
		const comp = new MutableLineComponent(["a", "b", "c", "d", "e"]);
		tui.addChild(comp);

		tui.start();
		await Bun.sleep(0);
		await term.waitForRender();
		// Force the differential trailing-clear branch (not the eager
		// `clearOnShrink` full-render shortcut).
		tui.setClearOnShrink(false);
		const mark = term.mark();

		// Shrink to 2 lines — drives the `previousLines.length > newLines.length`
		// branch that clears trailing extra rows.
		comp.setLines(["a", "b"]);
		tui.invalidate();
		tui.requestRender();
		await Bun.sleep(0);
		await term.waitForRender();

		const frames = term.framesSince(mark);
		expect(frames.length).toBeGreaterThan(0);
		expect(frames).not.toContain("\x1b[2K");

		tui.stop();
	});

	it("viewportRefresh path emits no `\\x1b[2K`", async () => {
		const term = new CapturingTerminal(80, 6);
		const tui = new TUI(term);
		const comp = new MutableLineComponent(["v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9"]);
		tui.addChild(comp);

		tui.start();
		await Bun.sleep(0);
		await term.waitForRender();
		const mark = term.mark();

		// Mutate a line ABOVE the viewport — drives `firstChanged <
		// prevViewportTop`, which triggers `viewportRefresh()`.
		comp.setLines(["V0-CHANGED", "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9"]);
		tui.invalidate();
		tui.requestRender();
		await Bun.sleep(0);
		await term.waitForRender();

		const frames = term.framesSince(mark);
		expect(frames.length).toBeGreaterThan(0);
		expect(frames).not.toContain("\x1b[2K");

		tui.stop();
	});
});
