import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type Component,
	type RenderScheduler,
	type RenderTimer,
	TUI,
	type ViewportTailProvider,
} from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Outside a multiplexer a resize used to erase-and-replay the whole transcript
// on every SIGWINCH. A drag fires a burst of those, each at a fresh width that
// misses every per-width render cache, so the entire history is re-laid-out and
// re-pushed through scrollback dozens of times a second and discarded the
// instant the next event lands. The fast path instead paints ONLY the viewport
// while the drag is in flight — composing just the visible tail and skipping
// the off-screen history — and replays the rewrapped transcript once, after the
// drag settles.

const NO_MULTIPLEXER_ENV: Record<string, string | undefined> = {
	TMUX: undefined,
	STY: undefined,
	ZELLIJ: undefined,
	// Pin terminal identity so the alt-screen fast-path assertions below are
	// deterministic even when the suite runs inside Warp (which otherwise takes
	// the in-place path — see the Warp describe block at the bottom).
	TERM_PROGRAM: undefined,
	PI_TUI_RESIZE_IN_PLACE: undefined,
};
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";

async function withEnvPatch<T>(patch: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const key in patch) {
		saved[key] = Bun.env[key];
		const value = patch[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	try {
		return await run();
	} finally {
		for (const key in saved) {
			const value = saved[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	}
}

// Deterministic scheduler so the test drives the resize settle window itself
// instead of waiting on the wall clock. Resize viewport paints are synchronous;
// `scheduleImmediate` callbacks are ordinary follow-up renders, and
// `scheduleRender` callbacks are delayed timers (the settle). `flushAll` fires
// the settle and the authoritative replay it queues.
class DeferScheduler implements RenderScheduler {
	#time = 0;
	#immediates: (() => void)[] = [];
	#renders = new Map<number, { run: () => void; delay: number }>();
	#nextId = 0;

	now(): number {
		this.#time += 20;
		return this.#time;
	}

	scheduleImmediate(callback: () => void): void {
		this.#immediates.push(callback);
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const id = this.#nextId++;
		this.#renders.set(id, { run: callback, delay: delayMs });
		return {
			cancel: () => {
				this.#renders.delete(id);
			},
		};
	}

	get pendingRenders(): number {
		return this.#renders.size;
	}

	async flushImmediates(term: VirtualTerminal): Promise<void> {
		let rounds = 0;
		while (this.#immediates.length > 0) {
			if (++rounds > 100) throw new Error("immediates did not settle");
			const batch = this.#immediates;
			this.#immediates = [];
			for (const callback of batch) callback();
		}
		await term.flush();
	}

	// Fire immediates plus any throttled render whose delay is below `maxDelayMs`,
	// leaving longer timers (the 120ms resize settle) pending. Lets a test drive
	// an interleaved ordinary render — a spinner tick / streamed token, scheduled
	// at the ~33ms render throttle — mid-drag without ending the drag.
	async flushOrdinaryRenders(term: VirtualTerminal, maxDelayMs = 100): Promise<void> {
		let rounds = 0;
		for (;;) {
			if (++rounds > 100) throw new Error("ordinary renders did not settle");
			const immediates = this.#immediates;
			this.#immediates = [];
			for (const callback of immediates) callback();
			if (this.#immediates.length > 0) continue;
			const due = [...this.#renders.entries()].filter(([, entry]) => entry.delay < maxDelayMs);
			if (due.length === 0) break;
			for (const [id, entry] of due) {
				this.#renders.delete(id);
				entry.run();
			}
		}
		await term.flush();
	}

	async flushAll(term: VirtualTerminal): Promise<void> {
		let rounds = 0;
		while (this.#immediates.length > 0 || this.#renders.size > 0) {
			if (++rounds > 100) throw new Error("scheduler did not settle");
			const immediates = this.#immediates;
			this.#immediates = [];
			for (const callback of immediates) callback();
			if (this.#immediates.length > 0) continue;
			const renders = [...this.#renders.values()];
			this.#renders.clear();
			for (const entry of renders) entry.run();
		}
		await term.flush();
	}
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

function eraseScrollbackCount(writes: string[]): number {
	return writes.filter(chunk => chunk.includes("\x1b[3J")).length;
}

// A transcript block that records how many times it was laid out. Whole blocks
// render when they sit in (or partially in) the viewport tail; blocks above the
// fold must never be rendered during the drag.
class CountingBlock implements Component {
	renderCount = 0;
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = lines;
	}
	invalidate(): void {}
	render(width: number): string[] {
		this.renderCount++;
		return this.#lines.map(line => line.slice(0, width));
	}
}

// A minimal transcript: blocks concatenated with no separators, plus a bottom-up
// tail render that touches only the blocks needed to fill the request.
class TailTranscript implements Component, ViewportTailProvider {
	blocks: CountingBlock[];
	constructor(blocks: CountingBlock[]) {
		this.blocks = blocks;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const out: string[] = [];
		for (const block of this.blocks) out.push(...block.render(width));
		return out;
	}
	renderViewportTail(width: number, maxRows: number): readonly string[] {
		const tail: string[] = [];
		for (let i = this.blocks.length - 1; i >= 0 && tail.length < maxRows; i--) {
			const rows = this.blocks[i]!.render(width);
			for (let r = rows.length - 1; r >= 0 && tail.length < maxRows; r--) tail.unshift(rows[r]!);
		}
		return tail;
	}
}

describe("non-multiplexer resize viewport fast path", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// 15 two-row blocks (30 rows) over a 10-row viewport: only the last few rows
	// are ever on screen, so a drag must not re-lay-out the rows above the fold.
	function makeTui(term: VirtualTerminal): { tui: TUI; blocks: CountingBlock[]; scheduler: DeferScheduler } {
		const blocks = Array.from({ length: 15 }, (_v, i) => new CountingBlock([`b${i}-x`, `b${i}-y`]));
		const scheduler = new DeferScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new TailTranscript(blocks));
		return { tui, blocks, scheduler };
	}

	it("paints only the viewport during a drag and never re-lays-out off-screen history", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const { tui, blocks, scheduler } = makeTui(term);
			try {
				tui.start();
				await scheduler.flushImmediates(term);

				const baselineFull = tui.fullRedraws;
				const writes = captureWrites(term);
				for (const b of blocks) b.renderCount = 0;

				// A drag burst: several SIGWINCHes at intermediate widths, each
				// followed by its viewport paint but never the settle.
				term.resize(60, 10);
				await scheduler.flushImmediates(term);
				term.resize(75, 10);
				await scheduler.flushImmediates(term);
				term.resize(80, 10);
				await scheduler.flushImmediates(term);

				// In flight: viewport-only paints, no authoritative full redraw, and
				// crucially no ED3 — native scrollback is left untouched.
				expect(tui.resizeViewportActive).toBe(true);
				expect(tui.resizeViewportPaints).toBe(3);
				expect(tui.fullRedraws).toBe(baselineFull);
				expect(eraseScrollbackCount(writes)).toBe(0);

				// Blocks above the fold are never rendered during the drag; only the
				// visible tail is.
				expect(blocks.slice(0, 10).every(b => b.renderCount === 0)).toBe(true);
				expect(blocks.at(-1)!.renderCount).toBeGreaterThan(0);

				// The viewport still shows the bottom of the transcript, rewrapped
				// at the new width.
				expect(visible(term).at(-1)).toBe("b14-y");
			} finally {
				tui.stop();
			}
		});
	});

	it("replays the full rewrapped history once the drag settles", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const { tui, blocks, scheduler } = makeTui(term);
			try {
				tui.start();
				await scheduler.flushImmediates(term);

				const baselineFull = tui.fullRedraws;
				const writes = captureWrites(term);

				term.resize(60, 10);
				await scheduler.flushImmediates(term);
				term.resize(80, 10);
				await scheduler.flushImmediates(term);

				// Settle window elapses: exactly one authoritative full paint that
				// erases native scrollback (ED3) and replays every block.
				for (const b of blocks) b.renderCount = 0;
				await scheduler.flushAll(term);

				expect(tui.resizeViewportActive).toBe(false);
				// Exactly one authoritative full paint with exactly one ED3 — the
				// interleaved viewport-only frames must not have leaked a second
				// full replay or a stray scrollback erase into the settle.
				expect(tui.fullRedraws).toBe(baselineFull + 1);
				expect(eraseScrollbackCount(writes)).toBe(1);
				// The full replay lays out the whole transcript, off-screen blocks
				// included.
				expect(blocks.every(b => b.renderCount > 0)).toBe(true);

				// Scrollback holds the entire transcript exactly once — no
				// duplication from the interleaved viewport-only frames.
				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (let i = 0; i < blocks.length; i++) {
					expect(buffer.filter(line => line === `b${i}-x`).length).toBe(1);
					expect(buffer.filter(line => line === `b${i}-y`).length).toBe(1);
				}
				expect(visible(term).at(-1)).toBe("b14-y");
			} finally {
				tui.stop();
			}
		});
	});

	it("keeps an interleaved live-block render on the viewport fast path instead of flashing a normal-screen full paint", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const { tui, scheduler } = makeTui(term);
			try {
				tui.start();
				await scheduler.flushImmediates(term);

				// One drag SIGWINCH enters the fast path and borrows the alt screen.
				term.resize(60, 10);
				await scheduler.flushImmediates(term);
				expect(tui.resizeViewportActive).toBe(true);

				const baselineFull = tui.fullRedraws;
				const baselinePaints = tui.resizeViewportPaints;
				const writes = captureWrites(term);

				// A live block keeps animating mid-drag: a spinner tick / streamed
				// token fires an ordinary (non-forced) render before the 120ms settle
				// elapses. It must stay on the viewport fast path. Without the guard it
				// falls through to the geometry-rebuild full paint, which leaves the
				// borrowed alternate screen (ALT_SCREEN_EXIT) and erases native
				// scrollback (ED3) to repaint the whole transcript on the normal screen
				// for one frame — the flash — before the next SIGWINCH hides it again.
				tui.requestRender();
				await scheduler.flushOrdinaryRenders(term);

				// Still mid-drag, still on the alternate screen: a viewport-only paint,
				// no authoritative full redraw, no scrollback erase, no alt-screen exit.
				expect(tui.resizeViewportActive).toBe(true);
				expect(tui.resizeViewportPaints).toBeGreaterThan(baselinePaints);
				expect(tui.fullRedraws).toBe(baselineFull);
				expect(writes.join("")).not.toContain(ALT_SCREEN_EXIT);
				expect(eraseScrollbackCount(writes)).toBe(0);

				// The settle still fires exactly one authoritative full paint once the
				// drag goes quiet — the interleaved render did not consume or corrupt
				// the deferred geometry rebuild.
				await scheduler.flushAll(term);
				expect(tui.resizeViewportActive).toBe(false);
				expect(tui.fullRedraws).toBe(baselineFull + 1);
			} finally {
				tui.stop();
			}
		});
	});

	it("does not leave a pending settle paint after stop()", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const { tui, scheduler } = makeTui(term);
			tui.start();
			await scheduler.flushImmediates(term);

			const writes = captureWrites(term);
			term.resize(80, 10);
			tui.stop();

			// stop() cancels the settle timer, so the authoritative replay never
			// fires: no ED3 bytes land even after the scheduler is fully drained.
			await scheduler.flushAll(term);
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(scheduler.pendingRenders).toBe(0);
		});
	});

	it("uses the alternate screen during width-drag frames so terminal reflow cannot show wrapped fragments", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const scheduler = new DeferScheduler();
			const blocks = Array.from(
				{ length: 10 },
				(_v, i) => new CountingBlock([`row-${i}`.padEnd(40, String(i % 10))]),
			);
			const expected = Array.from({ length: 10 }, (_v, i) => `row-${i}`.padEnd(20, String(i % 10)));
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			tui.addChild(new TailTranscript(blocks));
			try {
				tui.start();
				await scheduler.flushImmediates(term);

				const writes = captureWrites(term);

				// Shrinking full-width normal-screen rows makes Ghostty reflow them
				// into wrapped fragments before the app writes again. The resize
				// handler must synchronously switch to the alternate screen and
				// repaint the new-width viewport in that same write.
				term.resize(20, 10);
				await term.flush();

				expect(tui.resizeViewportActive).toBe(true);
				expect(tui.resizeViewportPaints).toBe(1);
				const drag = writes.join("");
				expect(drag).toContain(ALT_SCREEN_ENTER);
				expect(drag).not.toContain("\x1b[2J");
				expect(drag).not.toContain("\x1b[3J");
				expect(visible(term)).toEqual(expected);

				const dragWrites = writes.length;
				await scheduler.flushAll(term);

				const settle = writes.slice(dragWrites).join("");
				expect(settle).toContain(ALT_SCREEN_EXIT);
				expect(settle.indexOf(ALT_SCREEN_EXIT)).toBeLessThan(settle.indexOf("\x1b[3J"));
				expect(visible(term)).toEqual(expected);
			} finally {
				tui.stop();
			}
		});
	});

	it("overwrites the viewport without a normal-screen clear mid-drag and still rewraps at settle", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const { tui, scheduler } = makeTui(term);
			try {
				tui.start();
				await scheduler.flushImmediates(term);

				const writes = captureWrites(term);

				// One mid-drag SIGWINCH: the fast path repaints just the viewport.
				term.resize(60, 10);

				expect(tui.resizeViewportActive).toBe(true);
				const drag = writes.join("");
				// The drag frame borrows the alternate screen and performs per-row
				// self-clearing rewrites there. It must not clear/replay the normal
				// screen, so even terminals that expose resize reflow between app
				// writes cannot show a blanked normal-screen frame.
				expect(drag).toContain(ALT_SCREEN_ENTER);
				expect(drag).not.toContain("\x1b[2J");
				expect(drag).not.toContain("\x1b[3J");
				expect(drag).toContain("\x1b[H");
				expect(drag).toContain("\x1b[K");
				expect(drag).toContain("b14-y");

				const dragWrites = writes.length;

				// Settle: the authoritative rewrap still fires once and erases native
				// scrollback (ED3) — the "rewrap on release" guarantee is preserved.
				await scheduler.flushAll(term);
				expect(tui.resizeViewportActive).toBe(false);
				const settle = writes.slice(dragWrites).join("");
				expect(settle).toContain("\x1b[3J");
			} finally {
				tui.stop();
			}
		});
	});
});

describe("resize repaints in place on terminals that re-report size on alt-screen toggle (Warp)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const WARP_ENV: Record<string, string | undefined> = { ...NO_MULTIPLEXER_ENV, TERM_PROGRAM: "WarpTerminal" };

	function makeTui(term: VirtualTerminal): { tui: TUI; blocks: CountingBlock[]; scheduler: DeferScheduler } {
		const blocks = Array.from({ length: 15 }, (_v, i) => new CountingBlock([`b${i}-x`, `b${i}-y`]));
		const scheduler = new DeferScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new TailTranscript(blocks));
		return { tui, blocks, scheduler };
	}

	// Warp reports a height one row different for the alternate screen buffer, so
	// the alt-screen-borrowing fast path would toggle the buffer, receive a fresh
	// SIGWINCH for free, and re-enter the fast path forever — a self-sustaining
	// ED3 repaint storm with completely stable geometry. The in-place path never
	// touches the alt buffer, so even a resize burst yields zero fast-path paints
	// and zero scrollback erases, leaving no alt<->normal toggle to feed back on.
	it("never borrows the alternate screen or emits ED3 across a resize burst", async () => {
		await withEnvPatch(WARP_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const { tui, scheduler } = makeTui(term);
			try {
				tui.start();
				await scheduler.flushImmediates(term);

				const writes = captureWrites(term);

				term.resize(60, 10);
				await scheduler.flushImmediates(term);
				term.resize(75, 10);
				await scheduler.flushImmediates(term);
				term.resize(80, 10);
				await scheduler.flushImmediates(term);

				// The fast path is never entered: no viewport-only paints, no alt buffer.
				expect(tui.resizeViewportActive).toBe(false);
				expect(tui.resizeViewportPaints).toBe(0);
				expect(writes.join("")).not.toContain(ALT_SCREEN_ENTER);

				// Settle the debounced in-place repaint: still no scrollback erase,
				// so there is no alt<->normal toggle for Warp to re-trigger on.
				await scheduler.flushAll(term);
				expect(eraseScrollbackCount(writes)).toBe(0);
				expect(writes.join("")).not.toContain(ALT_SCREEN_ENTER);
				expect(visible(term).at(-1)).toBe("b14-y");
			} finally {
				tui.stop();
			}
		});
	});

	it("PI_TUI_RESIZE_IN_PLACE=0 opts Warp back into the alt-screen fast path", async () => {
		await withEnvPatch({ ...WARP_ENV, PI_TUI_RESIZE_IN_PLACE: "0" }, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const { tui, scheduler } = makeTui(term);
			try {
				tui.start();
				await scheduler.flushImmediates(term);

				const writes = captureWrites(term);
				term.resize(60, 10);
				await scheduler.flushImmediates(term);

				expect(tui.resizeViewportActive).toBe(true);
				expect(writes.join("")).toContain(ALT_SCREEN_ENTER);
			} finally {
				tui.stop();
			}
		});
	});

	it("PI_TUI_RESIZE_IN_PLACE=1 forces the in-place path on an ordinary terminal", async () => {
		await withEnvPatch({ ...NO_MULTIPLEXER_ENV, PI_TUI_RESIZE_IN_PLACE: "1" }, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const { tui, scheduler } = makeTui(term);
			try {
				tui.start();
				await scheduler.flushImmediates(term);

				const writes = captureWrites(term);
				term.resize(60, 10);
				await scheduler.flushImmediates(term);

				expect(tui.resizeViewportActive).toBe(false);
				expect(tui.resizeViewportPaints).toBe(0);
				expect(writes.join("")).not.toContain(ALT_SCREEN_ENTER);

				await scheduler.flushAll(term);
				expect(eraseScrollbackCount(writes)).toBe(0);
			} finally {
				tui.stop();
			}
		});
	});
});
