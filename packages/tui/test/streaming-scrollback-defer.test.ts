import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type Component,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackLiveRegion,
	TUI,
} from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Law-encoding suite for gated native-scrollback commits.
//
// The engine commits a row to native scrollback only when the component seam
// declares it FINAL (`getNativeScrollbackLiveRegionStart`). Live rows that
// scroll above the window are neither painted nor committed — a deferred gap —
// and enter history later, in order, exactly once, when the boundary passes
// them. A root with no seam commits everything that scrolls (shell semantics).
// Consequences pinned here:
//   ► a volatile live block leaves NO trace on the tape until it finalizes —
//     no stale preview copies, ever;
//   ► an append-only stream that declares its rendered rows final commits its
//     scrolled-off head mid-stream;
//   ► removing/collapsing/replacing a live block backfills the tape with the
//     final content only;
//   ► a declared-final row that later mutates is a contract violation the
//     audit repairs by re-anchoring once (duplication, never loss).

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
 * Live block with a settable declared-final boundary:
 *   0         — nothing final (a volatile tool preview);
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

describe("streaming scrollback defer", () => {
	let savedTerminalEnv: Record<string, string | undefined> = {};
	beforeEach(() => {
		savedTerminalEnv = saveTerminalEnv();
	});
	afterEach(() => {
		restoreTerminalEnv(savedTerminalEnv);
		savedTerminalEnv = {};
	});

	it("defers a volatile live block's rows and commits them once on finalize", async () => {
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

			// The live block overflows the 4-row viewport, but none of its rows
			// are declared final: the finalized prefix commits, the window shows
			// the live tail, and the overflowed head (think-0/think-1) sits in
			// the deferred gap — on the tape NOWHERE yet. No ED3.
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(tape(term)).toEqual([...rows("prior-", 12), "think-2", "think-3", "think-4", "think-5"]);

			live.setLines(rows("think-", 8));
			tui.requestRender();
			await settle(term);
			expect(tape(term)).toEqual([...rows("prior-", 12), "think-4", "think-5", "think-6", "think-7"]);

			// Finalize: the seam clears and the deferred head backfills in order.
			live.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(buffer).toEqual([...rows("prior-", 12), ...rows("think-", 8)]);
			// Exactly once: no duplicate copies of any live row.
			for (const row of rows("think-", 8)) {
				expect(buffer.filter(line => line === row)).toHaveLength(1);
			}
		} finally {
			tui.stop();
		}
	});

	it("defers a tall all-live block's scrolled head and commits it in order on finalize", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// The only block is live with nothing declared final: rows that scroll
		// above the viewport wait in the deferred gap instead of entering
		// immutable history as a mutable preview.
		const live = new SeamLineList([]);

		try {
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("tool-", 10));
			tui.requestRender();
			await settle(term);

			// Nothing committed: the tape is exactly the visible window.
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(tape(term)).toEqual(["tool-6", "tool-7", "tool-8", "tool-9"]);

			live.seam = undefined;
			tui.requestRender();
			await settle(term);

			// The deferred head backfills in frame order, exactly once.
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(tape(term)).toEqual(rows("tool-", 10));
		} finally {
			tui.stop();
		}
	});

	it("commits the scrolled-off head of an append-only live block mid-stream", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// An append-only streaming reply declares every rendered row final
		// (Infinity clamps to the rendered length), so its scrolled-off head
		// reaches native scrollback mid-stream instead of waiting for finalize.
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
		} finally {
			tui.stop();
		}
	});

	it("leaves no stale copy when a volatile live block is replaced wholesale", async () => {
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

			live.setLines(rows("running-fresh-", 10));
			tui.requestRender();
			await settle(term);

			live.seam = undefined;
			tui.requestRender();
			await settle(term);

			// The provisional preview never touched the tape: after the wholesale
			// replace + finalize, history holds only the final content — no
			// stranded pending-stale fragment, no ED3, nothing lost.
			const buffer = tape(term);
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(buffer).toEqual([...rows("prior-", 12), ...rows("running-fresh-", 10)]);
			expect(buffer.some(line => line.startsWith("pending-stale-"))).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("keeps the topmost live seam when a lower sibling also reports one", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(24, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("prior-", 12));
		// Volatile live transcript block: nothing declared final.
		const live = new SeamLineList([]);
		// Status loader below the transcript: also reports a seam. Commits are
		// prefix-only, so the engine must keep the TOPMOST seam — letting the
		// lower sibling's seam win would move the boundary past the transcript's
		// still-mutable rows.
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

			// Boundary stops at the transcript block: only the sealed prefix is on
			// the tape (plus the visible window).
			expect(tape(term).filter(line => line.startsWith("pending-stale-"))).toEqual(
				tape(term)
					.slice(-4)
					.filter(line => line.startsWith("pending-stale-")),
			);

			live.setLines(rows("running-fresh-", 10));
			tui.requestRender();
			await settle(term);

			live.seam = undefined;
			tui.requestRender();
			await settle(term);

			// The transcript's final content commits; the loader (still live)
			// stays out of history at the tape bottom.
			const buffer = tape(term);
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(buffer).toEqual([...rows("prior-", 12), ...rows("running-fresh-", 10), "Working..."]);
			expect(buffer.some(line => line.startsWith("pending-stale-"))).toBe(false);
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

			// Grow content past the viewport — without a live-region seam the
			// scrolled-off rows commit to native history as they pass the seam
			// (shell semantics): exactly once, in frame order, with no ED3.
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

			// Grow further — history extends append-only: still no ED3, no
			// duplicates, and previously committed rows are untouched.
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
		// Sealed prefix above a live block: growth commits the sealed rows to
		// native scrollback; a later collapse must not repaint them back into the
		// viewport (which would duplicate them in history with no ED3 to erase).
		const sealed = new LineList(rows("prior-", 12));
		const live = new SeamLineList([]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			// Live block overflows the viewport — sealed prefix commits once.
			live.setLines(rows("think-", 30));
			tui.requestRender();
			await settle(term);
			expect(term.getScrollBuffer().filter(line => line.startsWith("prior-"))).toEqual(rows("prior-", 12));

			// Live block collapses to its compact result. The bottom-anchored
			// viewport would re-expose committed sealed rows; the pin must clamp the
			// repaint to the committed boundary instead of duplicating them.
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

			// No live-region seam yet: shell semantics commit the scrolled rows.
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

			// Stream past the viewport: scrolled rows commit to history in
			// order (shell semantics) and no ED3 fires.
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

			// Grow well past the 4-row viewport: the declared-final body lets the
			// engine commit the scrolled-off head to native scrollback.
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

	it("never commits intermediate layouts of a re-laying-out live block", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// A block that rewrites an interior row every frame (a streaming table
		// re-aligning its columns) declares nothing final. Under the old
		// heuristic law its head force-committed and every drift risked a
		// duplicate-snapshot spray; now nothing enters history until finalize.
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

			// Mid-stream: the tape is exactly the visible window — zero snapshots
			// of any intermediate layout.
			expect(tape(term)).toEqual(["tbl-8", "tbl-9", "tbl-10", "tbl-11"]);

			live.seam = undefined;
			tui.requestRender();
			await settle(term);

			// Finalize commits the FINAL layout exactly once.
			const final = rows("tbl-", 12);
			final[1] = "tbl-1 [w12]";
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(tape(term)).toEqual(final);
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
		// recommits — duplication, never loss — and stays quiet on the frames
		// after the violation (no per-frame spray).
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
			// No loss: the edited rows reached the tape in final form.
			expect(afterViolation).toContain("row-5 [edited]");
			expect(afterViolation).toContain("row-6 [edited]");

			// Stability: identical follow-up frames must not grow the tape.
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

describe("scrollback commit gap — deferred live barriers", () => {
	let savedTerminalEnv: Record<string, string | undefined> = {};
	beforeEach(() => {
		savedTerminalEnv = saveTerminalEnv();
	});
	afterEach(() => {
		restoreTerminalEnv(savedTerminalEnv);
		savedTerminalEnv = {};
	});

	it("defers everything under a pending barrier and backfills when it clears (S5/S6)", async () => {
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
			// 4-row viewport. The seam at 0 defers the whole frame.
			root.setLines(["[tool pending]", ...rows("ans-", 8)]);
			root.seam = 0;
			tui.requestRender();
			await settle(term);
			expect(tape(term)).toEqual(rows("ans-", 8).slice(-4));

			// Barrier removed (agent moved past the tool): the tail commits in
			// order; the pending row never existed on the tape.
			root.setLines(rows("ans-", 8));
			root.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(buffer).toEqual(rows("ans-", 8));
			expect(buffer).not.toContain("[tool pending]");
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(rows("ans-", 8).slice(-4));
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("commits only the result when a provisional preview is replaced (S4)", async () => {
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

			root.setLines(rows("preview-", 10));
			root.seam = 0;
			tui.requestRender();
			await settle(term);
			expect(tape(term)).toEqual(rows("preview-", 10).slice(-4));

			root.setLines(rows("result-", 9));
			root.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(buffer).toEqual(rows("result-", 9));
			expect(buffer.some(line => line.startsWith("preview-"))).toBe(false);
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(rows("result-", 9).slice(-4));
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

			// 3-row barrier over an 8-row tail (len 11), overflowing. All deferred.
			root.setLines([...rows("bar-", 3), ...rows("tail-", 8)]);
			root.seam = 0;
			tui.requestRender();
			await settle(term);

			// Barrier collapses to 1 row and finalizes: the whole final frame — and
			// only the final frame — reaches the tape.
			const f2 = ["bar-collapsed", ...rows("tail-", 8)];
			root.setLines(f2);
			root.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(buffer).toEqual(f2);
			expect(buffer.some(line => line.startsWith("bar-") && line !== "bar-collapsed")).toBe(false);
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
		// Realistic transcript shape: a still-live barrier block above a finalized
		// tail block. The topmost seam (the barrier at row 0) gates the boundary,
		// so the finalized tail below it is deferred too (commits are prefix-only).
		const barrier = new SeamLineList(["[tool pending]"]);
		const tail = new LineList(rows("out-", 10));

		try {
			tui.addChild(barrier);
			tui.addChild(tail);
			tui.start();
			await settle(term);
			const writes = capture(term);

			// Force overflow: 11 rows over a 5-row viewport. Nothing commits.
			tui.requestRender();
			await settle(term);
			expect(tape(term)).toEqual(rows("out-", 10).slice(-5));

			// Remove the barrier. The tail commits as one contiguous in-order run;
			// the pending row never reached the tape.
			tui.removeChild(barrier);
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(buffer).toEqual(rows("out-", 10));
			expect(buffer).not.toContain("[tool pending]");
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

			// Pending barrier above a tail that grows every frame, overflowing
			// further each tick; the barrier defers every row.
			for (let n = 1; n <= 20; n++) {
				root.setLines(["[pending]", ...rows("row-", n)]);
				root.seam = 0;
				tui.requestRender();
				await settle(term);
			}
			// Nothing has committed across 20 overflowing frames.
			expect(tape(term)).toEqual(rows("row-", 20).slice(-5));

			const final = rows("row-", 20);
			root.setLines(final);
			root.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(buffer).toEqual(final);
			expect(buffer).not.toContain("[pending]");
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(rows("row-", 20).slice(-5));
		} finally {
			tui.stop();
		}
	});

	it("commits a declared-final prose head once under a volatile tail and live card", async () => {
		if (process.platform === "win32") return;
		// Coexistence case: a streaming block whose settled head is declared
		// final (the transcript's settled-prefix path) while its last row
		// re-wraps in place every frame and a still-live card renders below.
		// The head must commit exactly once — no per-drift spray — and the
		// volatile tail + card stay off the tape until finalize.
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
			// The declared head committed exactly once.
			expect(contiguousAt(streaming, ["prose-0", "prose-1", "prose-2"])).toHaveLength(1);
			// The volatile row and the live card are only in the visible window.
			expect(streaming.filter(line => line === "card-0")).toHaveLength(1);
			expect(streaming.at(-2)).toBe("card-0");

			root.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			const final = rows("prose-", 8);
			final[7] = "prose-7 [w11]";
			expect(buffer).toEqual([...final, "card-0", "card-1"]);
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("shows the finalize edit of a deferred row instead of a stale committed copy", async () => {
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

			// Pending barrier row above an unchanged tail, overflowing. Deferred.
			root.setLines(["preview", ...rows("tail-", 8)]);
			root.seam = 0;
			tui.requestRender();
			await settle(term);

			// Finalize: ONLY row 0 changes (preview → result). Under the old
			// force-commit law the stale "preview" sat in history and only a
			// full-suffix hard scan recovered "result"; now the row was deferred,
			// so the tape simply receives the final content.
			const f2 = ["result", ...rows("tail-", 8)];
			root.setLines(f2);
			root.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(buffer).toEqual(f2);
			expect(buffer).not.toContain("preview");
			expect(buffer.filter(line => line === "result")).toHaveLength(1);
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("shows the finalize edit far above a long unchanged tail (deep backfill)", async () => {
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

			// The changed row ends up ~30 rows above the window at finalize —
			// far outside the audit's 24-row tail-sample lookback. Deferral makes
			// that irrelevant: the backfill emits the final bytes directly.
			root.setLines(["preview", ...rows("tail-", 30)]);
			root.seam = 0;
			tui.requestRender();
			await settle(term);

			const f2 = ["result", ...rows("tail-", 30)];
			root.setLines(f2);
			root.seam = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = tape(term);
			expect(buffer).toEqual(f2);
			expect(buffer).not.toContain("preview");
			expect(buffer.filter(line => line === "result")).toHaveLength(1);
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});
});
