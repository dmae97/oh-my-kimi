import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type Component,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackLiveRegion,
	TUI,
} from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Law-encoding suite for native-scrollback commits.
//
// The tape is the terminal's visual record: whatever scrolls above the window
// enters history exactly once, in order. The component seam
// (`getNativeScrollbackLiveRegionStart`) classifies HOW a row commits:
//   ► below the boundary — exact-final bytes, hard-verified, audited;
//   ► above the boundary — a frozen snapshot of what was on screen, exempt
//     from re-anchoring while its source stays live (a collapsing preview can
//     never spray duplicates mid-run);
//   ► when the boundary rises past frozen snapshots (the block finalized, a
//     barrier cleared), they are strict-scanned exactly once: a divergence
//     re-anchors and recommits the final content below the frozen snapshot —
//     duplication, never loss; rows are never committed-nowhere-and-painted-
//     nowhere.

class LineList implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}
}

/**
 * Live block with a settable exactness boundary:
 *   0         — nothing declared final (a volatile tool preview);
 *   Infinity  — everything rendered so far is final (an append-only streaming
 *               reply; the engine clamps to the rendered length);
 *   undefined — no seam (finalized block / plain shell content).
 */
class SeamLineList extends LineList implements NativeScrollbackLiveRegion {
	seam: number | undefined = 0;

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.seam;
	}
}

/**
 * Records the engine's committed-row claim visible at each render() call.
 * Pins the propagation contract: the claim must be fed *before* render so the
 * child (e.g. the transcript container) can skip re-deriving blocks that
 * already live in immutable native scrollback.
 */
class CommittedRowsProbe extends SeamLineList implements NativeScrollbackCommittedRows {
	#committedRows = 0;
	committedRowsAtRender: number[] = [];

	constructor(lines: string[]) {
		super(lines);
		this.seam = Number.POSITIVE_INFINITY;
	}

	setNativeScrollbackCommittedRows(rows: number): void {
		this.#committedRows = rows;
	}

	override render(width: number): string[] {
		this.committedRowsAtRender.push(this.#committedRows);
		return super.render(width);
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(40);
	await term.flush();
}

// The non-multiplexer resize fast path paints the viewport at once and defers
// the authoritative full replay (the ED3 scrollback rebuild) until the drag has
// been quiet for the resize settle window (120 ms). This is an integration test
// against the real render scheduler, so the window is driven with a real delay.
async function settleResize(term: VirtualTerminal): Promise<void> {
	await Bun.sleep(160);
	await settle(term);
}

function capture(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	term.write = (data: string) => {
		writes.push(data);
		realWrite(data);
	};
	return writes;
}

function overrideProbe(term: VirtualTerminal, answer: boolean | undefined): void {
	// The probe is not on VirtualTerminal's public type; shadow it so the
	// scrollback math stays deterministic in headless runs.
	const probeHost = term as unknown as { isNativeViewportAtBottom: () => boolean | undefined };
	probeHost.isNativeViewportAtBottom = () => answer;
}

const ERASE_SCROLLBACK = /\x1b\[3J/g;

function eraseScrollbackCount(writes: string[]): number {
	return writes.join("").match(ERASE_SCROLLBACK)?.length ?? 0;
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

/** Scrollback history + active grid, right-trimmed, trailing blank rows dropped. */
function tape(term: VirtualTerminal): string[] {
	const buffer = term.getScrollBuffer().map(line => line.trimEnd());
	while (buffer.length > 0 && buffer.at(-1) === "") buffer.pop();
	return buffer;
}

/** Indices in `buffer` where `needle` begins as a contiguous run. */
function contiguousAt(buffer: string[], needle: string[]): number[] {
	const hits: number[] = [];
	for (let i = 0; i + needle.length <= buffer.length; i++) {
		let match = true;
		for (let j = 0; j < needle.length; j++) {
			if (buffer[i + j] !== needle[j]) {
				match = false;
				break;
			}
		}
		if (match) hits.push(i);
	}
	return hits;
}

function saveTerminalEnv(): Record<string, string | undefined> {
	// A resize on Warp takes the in-place path (no ED3), so neutralize the
	// ambient terminal identity to keep the direct-terminal scrollback
	// assertions deterministic on any dev machine.
	const saved: Record<string, string | undefined> = {};
	for (const key of ["TERM_PROGRAM", "PI_TUI_RESIZE_IN_PLACE"]) {
		saved[key] = Bun.env[key];
		delete Bun.env[key];
	}
	return saved;
}

function restoreTerminalEnv(saved: Record<string, string | undefined>): void {
	for (const key in saved) {
		const value = saved[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
}

describe("streaming scrollback — visual record", () => {
	let savedTerminalEnv: Record<string, string | undefined> = {};
	beforeEach(() => {
		savedTerminalEnv = saveTerminalEnv();
	});
	afterEach(() => {
		restoreTerminalEnv(savedTerminalEnv);
		savedTerminalEnv = {};
	});

	it("records a volatile live block's scrolled rows and never duplicates them on finalize", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("prior-", 12));
		const live = new SeamLineList([]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("think-", 6));
			tui.requestRender();
			await settle(term);

			// The live block's head scrolls above the 4-row viewport and is
			// recorded as a frozen snapshot — nothing that was painted vanishes.
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(tape(term)).toEqual([...rows("prior-", 12), ...rows("think-", 6)]);

			// Append-only growth: recorded rows are byte-identical, so nothing
			// re-anchors; the new tail just extends.
			live.setLines(rows("think-", 8));
			tui.requestRender();
			await settle(term);
			expect(tape(term)).toEqual([...rows("prior-", 12), ...rows("think-", 8)]);

			// Finalize: the recorded snapshots match the final render, so the
			// one-time strict verification passes and NOTHING recommits.
			live.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(buffer).toEqual([...rows("prior-", 12), ...rows("think-", 8)]);
		} finally {
			tui.stop();
		}
	});

	it("records a tall all-live block's scrolled head", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const live = new SeamLineList([]);

		try {
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("tool-", 10));
			tui.requestRender();
			await settle(term);

			// tool-0..tool-5 scrolled above the 4-row viewport and are recorded;
			// tool-6..tool-9 stay in the viewport. Nothing is lost.
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(tape(term)).toEqual(rows("tool-", 10));

			live.seam = undefined;
			tui.requestRender();
			await settle(term);
			expect(tape(term)).toEqual(rows("tool-", 10));
		} finally {
			tui.stop();
		}
	});

	it("commits an append-only declared-final block's scrolled head as exact rows", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// An append-only streaming reply declares every rendered row final
		// (Infinity clamps to the rendered length): its scrolled-off head enters
		// the verified zone and never needs a finalize-time repair.
		const live = new SeamLineList([]);
		live.seam = Number.POSITIVE_INFINITY;

		try {
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("text-", 10));
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(tape(term)).toEqual(rows("text-", 10));

			live.seam = undefined;
			tui.requestRender();
			await settle(term);
			expect(tape(term)).toEqual(rows("text-", 10));
		} finally {
			tui.stop();
		}
	});

	it("repairs a wholesale-replaced live block once at finalize — full result, single stale fragment", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(24, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("prior-", 12));
		const live = new SeamLineList([]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("pending-stale-", 10));
			tui.requestRender();
			await settle(term);

			// Head recorded as frozen snapshots.
			expect(tape(term)).toEqual([...rows("prior-", 12), ...rows("pending-stale-", 10)]);

			// Wholesale replace while still live: frozen snapshots are exempt —
			// no mid-run re-anchor, no spray. The tape keeps the recorded head;
			// the window shows the fresh tail.
			live.setLines(rows("running-fresh-", 10));
			tui.requestRender();
			await settle(term);
			expect(tape(term)).toEqual([
				...rows("prior-", 12),
				...rows("pending-stale-", 6),
				...rows("running-fresh-", 10).slice(6),
			]);

			// Finalize: the one-time strict verification catches the divergence
			// and recommits the final content below the frozen fragment. Every
			// fresh row is on the tape (no loss); the stale fragment appears
			// exactly once (no spray).
			live.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(buffer).toEqual([...rows("prior-", 12), ...rows("pending-stale-", 6), ...rows("running-fresh-", 10)]);
		} finally {
			tui.stop();
		}
	});

	it("keeps the topmost seam when a lower sibling also reports one", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(24, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("prior-", 12));
		const live = new SeamLineList([]);
		// Status loader below the transcript: also reports a seam. Exactness is
		// prefix-only, so the engine must keep the TOPMOST seam — letting the
		// lower sibling's seam win would verify the transcript's still-mutable
		// rows as final.
		const loader = new SeamLineList(["Working..."]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.addChild(loader);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("pending-stale-", 10));
			tui.requestRender();
			await settle(term);

			live.setLines(rows("running-fresh-", 10));
			tui.requestRender();
			await settle(term);

			live.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(eraseScrollbackCount(writes)).toBe(0);
			// Full fresh content present in order (no loss), stale head fragment
			// exactly once (no spray), loader still live at the bottom.
			expect(contiguousAt(buffer, rows("running-fresh-", 10))).toHaveLength(1);
			expect(buffer.filter(line => line.startsWith("pending-stale-"))).toEqual(rows("pending-stale-", 7));
			expect(buffer.at(-1)).toBe("Working...");
		} finally {
			tui.stop();
		}
	});

	it("commits scrolled streaming rows to history exactly once without ED3 (shell semantics)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(40, 10);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const component = new LineList([...rows("init-", 10), "prompt"]);

		try {
			tui.addChild(component);
			tui.start();
			await settle(term);

			const writes = capture(term);

			const frame1 = [...rows("init-", 10), ...rows("stream-", 30), "prompt"];
			component.setLines(frame1);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);
			let buffer = term.getScrollBuffer().map(line => line.trimEnd());
			expect(buffer).toEqual(frame1.slice(0, buffer.length));
			expect(
				term
					.getViewport()
					.map(line => line.trim())
					.at(-1),
			).toBe("prompt");

			const frame2 = [...rows("init-", 10), ...rows("stream-", 50), "prompt"];
			component.setLines(frame2);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);
			buffer = term.getScrollBuffer().map(line => line.trimEnd());
			expect(buffer).toEqual(frame2.slice(0, buffer.length));
			expect(buffer.length).toBeGreaterThan(frame1.length - 10);
		} finally {
			tui.stop();
		}
	});

	it("does not emit ED3 during streaming", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(40, 10);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const component = new LineList([...rows("init-", 10), "prompt"]);

		try {
			tui.addChild(component);
			tui.start();
			await settle(term);

			const writes = capture(term);

			component.setLines([...rows("grow-", 30), "prompt"]);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);

			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(
				term
					.getViewport()
					.map(line => line.trim())
					.at(-1),
			).toBe("prompt");
		} finally {
			tui.stop();
		}
	});

	it("does not duplicate committed sealed rows when the live region collapses mid-stream", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("prior-", 12));
		const live = new SeamLineList([]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("think-", 30));
			tui.requestRender();
			await settle(term);
			expect(term.getScrollBuffer().filter(line => line.startsWith("prior-"))).toEqual(rows("prior-", 12));

			// Live block collapses to its compact result. The bottom-anchored
			// viewport would re-expose committed sealed rows; the pin must clamp
			// the repaint to the committed boundary instead of duplicating them.
			live.setLines(["done"]);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(term.getScrollBuffer().filter(line => line.startsWith("prior-"))).toEqual(rows("prior-", 12));
		} finally {
			tui.stop();
		}
	});

	it("keeps committed prefix accounting after a capped streaming frame", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(24, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("base-", 12));

		try {
			tui.addChild(sealed);
			tui.start();
			await settle(term);

			const writes = capture(term);

			sealed.setLines([...rows("base-", 12), ...rows("transient-", 30)]);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);

			// A later frame introduces a live region after the same sealed prefix.
			// The already-committed base rows must stay accounted — never appended
			// to native history a second time.
			const live = new SeamLineList(rows("live-", 20));
			sealed.setLines(rows("base-", 12));
			tui.addChild(live);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(term.getScrollBuffer().filter(line => line.startsWith("base-"))).toEqual(rows("base-", 12));
		} finally {
			tui.stop();
		}
	});

	it("erases mis-wrapped native scrollback on resize even mid-stream", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(40, 10);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const component = new LineList([...rows("init-", 5), "prompt"]);

		try {
			tui.addChild(component);
			tui.start();
			await settle(term);

			const writes = capture(term);

			component.setLines([...rows("stream-", 30), "prompt"]);
			tui.requestRender();
			await settle(term);
			expect(eraseScrollbackCount(writes)).toBe(0);
			const streamed = term.getScrollBuffer().map(line => line.trimEnd());
			expect(streamed).toEqual([...rows("stream-", 30), "prompt"].slice(0, streamed.length));

			// Resize mid-stream. The terminal re-wrapped its saved lines at the old
			// width, so the authoritative rebuild must erase them (ED 3) rather than
			// leaving the corrupt history on screen. That rebuild is deferred until
			// the drag settles; while in flight only the viewport is repainted.
			term.resize(30, 10);
			await settleResize(term);

			expect(eraseScrollbackCount(writes)).toBeGreaterThan(0);
			expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual([...rows("stream-", 30), "prompt"]);
			expect(
				term
					.getViewport()
					.map(line => line.trim())
					.at(-1),
			).toBe("prompt");
		} finally {
			tui.stop();
		}
	});

	it("feeds committed native scrollback rows to interested children before render", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const probe = new CommittedRowsProbe([]);

		try {
			tui.addChild(probe);
			tui.start();
			await settle(term);

			probe.setLines(rows("out-", 12));
			tui.requestRender();
			await settle(term);

			// The next compose must surface the engine's committed claim to the
			// child before render(). A severed wire here silently disables the
			// transcript's committed-block bypass (rows stay 0 forever).
			tui.requestRender();
			await settle(term);

			expect(probe.committedRowsAtRender.at(-1)!).toBeGreaterThan(0);
		} finally {
			tui.stop();
		}
	});

	it("never re-anchors a re-laying-out live block mid-run, repairs once at finalize", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// A block that rewrites an interior row every frame (a streaming table
		// re-aligning, a collapsing preview). Its scrolled rows are frozen
		// snapshots: drift never sprays re-anchors; the single strict scan at
		// finalize recommits the final form once.
		const live = new SeamLineList([]);

		try {
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			for (let n = 4; n <= 12; n++) {
				const lines = rows("tbl-", n);
				lines[1] = `tbl-1 [w${n}]`; // interior row re-lays-out every frame
				live.setLines(lines);
				tui.requestRender();
				await settle(term);
			}

			// Mid-run: exactly the scrolled snapshots + the grid — one copy each,
			// no spray despite nine drift frames.
			const streaming = tape(term);
			expect(streaming).toHaveLength(12);
			expect(streaming.filter(line => line.startsWith("tbl-1 ")).length).toBe(1);

			live.seam = undefined;
			tui.requestRender();
			await settle(term);

			// Finalize: one repair recommits the final layout below the frozen
			// snapshot; the final form of the drifted row is on the tape.
			const buffer = tape(term);
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(buffer.join("\n")).toContain("tbl-1 [w12]");
			// Bounded: 8 snapshots + one repair recommit (7 rows) + 4 grid rows.
			expect(buffer.length).toBeLessThanOrEqual(19);

			// Stability: identical follow-up frames must not grow the tape.
			tui.requestRender();
			await settle(term);
			expect(tape(term)).toEqual(buffer);
		} finally {
			tui.stop();
		}
	});

	it("repairs a declared-final violation by re-anchoring once, never spraying", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// The block declares its whole body final, commits, then violates the
		// contract by rewriting TWO committed rows (alignment breaks, so the
		// tail-sample tolerance cannot absorb it). The audit re-anchors and
		// recommits — duplication, never loss — and stays quiet afterwards.
		const live = new SeamLineList(rows("row-", 12));
		live.seam = Number.POSITIVE_INFINITY;

		try {
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);
			const violated = rows("row-", 12);
			violated[5] = "row-5 [edited]";
			violated[6] = "row-6 [edited]";
			live.setLines(violated);
			tui.requestRender();
			await settle(term);

			const afterViolation = tape(term);
			expect(afterViolation).toContain("row-5 [edited]");
			expect(afterViolation).toContain("row-6 [edited]");

			for (let i = 0; i < 5; i++) {
				tui.requestRender();
				await settle(term);
			}
			expect(tape(term)).toEqual(afterViolation);
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});
});

describe("scrollback commit gap — live barriers", () => {
	let savedTerminalEnv: Record<string, string | undefined> = {};
	beforeEach(() => {
		savedTerminalEnv = saveTerminalEnv();
	});
	afterEach(() => {
		restoreTerminalEnv(savedTerminalEnv);
		savedTerminalEnv = {};
	});

	it("does not drop the tail when a pending barrier above it is removed (S5/S6)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamLineList([]);

		try {
			tui.addChild(root);
			tui.start();
			await settle(term);
			const writes = capture(term);

			// Small pending barrier above a long finalized tail, overflowing the
			// 4-row viewport. Scrolled rows are recorded as frozen snapshots.
			root.setLines(["[tool pending]", ...rows("ans-", 8)]);
			root.seam = 0;
			tui.requestRender();
			await settle(term);
			expect(tape(term)).toEqual(["[tool pending]", ...rows("ans-", 8)]);

			// Barrier removed: the tail shifts up. The one-time strict scan
			// catches the shift and recommits — every ans row survives, in order,
			// contiguous at the tape bottom.
			root.setLines(rows("ans-", 8));
			root.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(buffer.slice(-8)).toEqual(rows("ans-", 8));
			expect(buffer.filter(line => line === "[tool pending]")).toHaveLength(1);
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(rows("ans-", 8).slice(-4));
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("does not drop result rows when a provisional preview is replaced by its result (S4)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamLineList([]);

		try {
			tui.addChild(root);
			tui.start();
			await settle(term);
			const writes = capture(term);

			const preview = rows("preview-", 10);
			root.setLines(preview);
			root.seam = 0;
			tui.requestRender();
			await settle(term);
			expect(tape(term)).toEqual(preview);

			const result = rows("result-", 9);
			root.setLines(result);
			root.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			// Full result contiguous at the bottom; the recorded preview head
			// stays above it as the visual record — once, no spray.
			expect(buffer.slice(-9)).toEqual(result);
			expect(contiguousAt(buffer, result)).toHaveLength(1);
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(result.slice(-4));
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("does not drop rows when a barrier partially collapses above a long tail (S10)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamLineList([]);

		try {
			tui.addChild(root);
			tui.start();
			await settle(term);
			const writes = capture(term);

			const f1 = [...rows("bar-", 3), ...rows("tail-", 8)];
			root.setLines(f1);
			root.seam = 0;
			tui.requestRender();
			await settle(term);
			expect(tape(term)).toEqual(f1);

			// Barrier collapses to 1 row but the frame stays longer than the
			// committed prefix (NOT the shrink-into-prefix branch); the strict
			// scan must catch the upward tail shift.
			const f2 = ["bar-collapsed", ...rows("tail-", 8)];
			root.setLines(f2);
			root.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(buffer.slice(-9)).toEqual(f2);
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(f2.slice(-4));
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("keeps a finalized tail in order when its live barrier sibling is removed (multi-child S6)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 5);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const barrier = new SeamLineList(["[tool pending]"]);
		const tail = new LineList(rows("out-", 10));

		try {
			tui.addChild(barrier);
			tui.addChild(tail);
			tui.start();
			await settle(term);
			const writes = capture(term);

			// Force overflow: 11 rows over a 5-row viewport. Scrolled rows are
			// recorded (frozen — the topmost seam is at the barrier).
			tui.requestRender();
			await settle(term);
			expect(tape(term)).toEqual(["[tool pending]", ...rows("out-", 10)]);

			// Remove the barrier. The tail shifts up by one row; the strict scan
			// recommits so every out-* row remains, in order, contiguous at the
			// tape bottom.
			tui.removeChild(barrier);
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(buffer.slice(-10)).toEqual(rows("out-", 10));
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(rows("out-", 10).slice(-5));
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("survives a streaming-then-removed barrier across many frames without loss", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 5);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamLineList([]);

		try {
			tui.addChild(root);
			tui.start();
			await settle(term);

			for (let n = 1; n <= 20; n++) {
				const frame = ["[pending]", ...rows("row-", n)];
				root.setLines(frame);
				root.seam = 0;
				tui.requestRender();
				await settle(term);
				// Visual record mid-run: everything that scrolled is on the tape.
				expect(tape(term)).toEqual(frame);
			}

			const final = rows("row-", 20);
			root.setLines(final);
			root.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(buffer.slice(-20)).toEqual(final);
			expect(buffer.filter(line => line === "[pending]")).toHaveLength(1);
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(final.slice(-5));
		} finally {
			tui.stop();
		}
	});

	it("commits a declared-final prose head exactly, with zero finalize repair", async () => {
		if (process.platform === "win32") return;
		// A streaming block whose settled head is declared final (the
		// transcript's settled-prefix path) while its last row re-wraps in place
		// and a live card renders below. The head commits as verified exact rows
		// — so finalize needs NO repair and the tape never duplicates a byte.
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamLineList([]);

		try {
			tui.addChild(root);
			tui.start();
			await settle(term);
			const writes = capture(term);

			for (let n = 0; n < 12; n++) {
				const prose = rows("prose-", 8);
				prose[7] = `prose-7 [w${n}]`; // volatile tail re-wraps in place
				root.setLines([...prose, "card-0", "card-1"]);
				root.seam = 7; // declared-final through prose-6
				tui.requestRender();
				await settle(term);
			}

			const streaming = tape(term);
			expect(contiguousAt(streaming, ["prose-0", "prose-1", "prose-2"])).toHaveLength(1);

			root.seam = undefined;
			tui.requestRender();
			await settle(term);

			// Zero repair: the tape is byte-identical to the streaming state.
			const buffer = tape(term);
			expect(buffer).toEqual(streaming);
			expect(contiguousAt(buffer, ["prose-0", "prose-1", "prose-2"])).toHaveLength(1);
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("does not lose a single-row finalize edit above an unchanged tail (#4124)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamLineList([]);

		try {
			tui.addChild(root);
			tui.start();
			await settle(term);
			const writes = capture(term);

			const f1 = ["preview", ...rows("tail-", 8)];
			root.setLines(f1);
			root.seam = 0;
			tui.requestRender();
			await settle(term);
			expect(tape(term)).toEqual(f1);

			// Finalize: ONLY row 0 changes (preview → result); the whole tail is
			// byte-identical. The tail-sample tolerance alone would eat the single
			// mismatch and "result" would never reach the tape; the strict scan of
			// the newly-final span forces the recommit.
			const f2 = ["result", ...rows("tail-", 8)];
			root.setLines(f2);
			root.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(buffer).toContain("result");
			expect(buffer.filter(line => line === "result")).toHaveLength(1);
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(f2.slice(-4));
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("does not lose a single-row finalize edit far above a long unchanged tail (deep tail)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamLineList([]);

		try {
			tui.addChild(root);
			tui.start();
			await settle(term);
			const writes = capture(term);

			// The changed row sits ~30 rows above the commit boundary with an
			// unchanged tail — far outside the 24-row tail-sample lookback, so
			// only the FULL scan of the newly-final span catches it.
			root.setLines(["preview", ...rows("tail-", 30)]);
			root.seam = 0;
			tui.requestRender();
			await settle(term);

			root.setLines(["result", ...rows("tail-", 30)]);
			root.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(buffer).toContain("result");
			expect(buffer.filter(line => line === "result")).toHaveLength(1);
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});
});
