/**
 * Byte-level snapshot guard for the differential render emit pattern.
 *
 * Existing visual-regression tests assert on the FINAL viewport state.
 * A render path that achieves the right final state via a transient blank
 * frame passes those tests — which is exactly how the BSU-split flash bug
 * (commit 4d412b63a) slipped past CI before we caught it from a user
 * recording. This test asserts on the EMITTED BYTES, not the final state.
 */
import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class CapturingTerminal extends VirtualTerminal {
	public readonly writes: string[] = [];
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

function assertSmallDiffInvariants(frames: string, expectedNewContent: string): void {
	expect(frames).not.toContain("\x1b[2K");
	expect(frames).not.toContain("\x1b[2J");
	expect(frames).toContain(expectedNewContent);
	expect(frames.includes("\x1b[?2026l")).toBe(true);
}

describe("TUI render emit snapshots", () => {
	it("differential render of single-line mutation: no \\x1b[2K, no \\x1b[2J", async () => {
		const term = new CapturingTerminal(80, 24);
		const tui = new TUI(term);
		const comp = new MutableLineComponent(["line-0", "line-1", "line-2"]);
		tui.addChild(comp);
		tui.start();
		await Bun.sleep(0);
		await term.waitForRender();
		const mark = term.mark();
		comp.setLines(["line-0", "MUTATED", "line-2"]);
		tui.invalidate();
		tui.requestRender();
		await Bun.sleep(0);
		await term.waitForRender();
		const frames = term.framesSince(mark);
		assertSmallDiffInvariants(frames, "MUTATED");
		tui.stop();
	});

	it("streaming append (new lines below existing): no \\x1b[2K, no \\x1b[2J", async () => {
		const term = new CapturingTerminal(80, 24);
		const tui = new TUI(term);
		const comp = new MutableLineComponent(["intro", "body-a"]);
		tui.addChild(comp);
		tui.start();
		await Bun.sleep(0);
		await term.waitForRender();
		const mark = term.mark();
		comp.setLines(["intro", "body-a", "body-b-NEW"]);
		tui.invalidate();
		tui.requestRender();
		await Bun.sleep(0);
		await term.waitForRender();
		const frames = term.framesSince(mark);
		assertSmallDiffInvariants(frames, "body-b-NEW");
		tui.stop();
	});

	it("above-viewport mutation (viewportRefresh): no \\x1b[2K", async () => {
		const term = new CapturingTerminal(80, 6);
		const tui = new TUI(term);
		const initial = Array.from({ length: 10 }, (_v, i) => `v${i}`);
		const comp = new MutableLineComponent(initial);
		tui.addChild(comp);
		tui.start();
		await Bun.sleep(0);
		await term.waitForRender();
		const mark = term.mark();
		const next = [...initial];
		next[0] = "v0-CHANGED";
		comp.setLines(next);
		tui.invalidate();
		tui.requestRender();
		await Bun.sleep(0);
		await term.waitForRender();
		const frames = term.framesSince(mark);
		expect(frames).not.toContain("\x1b[2K");
		expect(frames).not.toContain("\x1b[2J");
		expect(frames.includes("\x1b[?2026l")).toBe(true);
		tui.stop();
	});

	it("trailing-line clear (shrink): no \\x1b[2K", async () => {
		const term = new CapturingTerminal(80, 24);
		const tui = new TUI(term);
		const comp = new MutableLineComponent(["a", "b", "c", "d", "e"]);
		tui.addChild(comp);
		tui.start();
		await Bun.sleep(0);
		await term.waitForRender();
		tui.setClearOnShrink(false);
		const mark = term.mark();
		comp.setLines(["a", "b"]);
		tui.invalidate();
		tui.requestRender();
		await Bun.sleep(0);
		await term.waitForRender();
		const frames = term.framesSince(mark);
		expect(frames).not.toContain("\x1b[2K");
		expect(frames).not.toContain("\x1b[2J");
		expect(frames.includes("\x1b[?2026l")).toBe(true);
		tui.stop();
	});
});
