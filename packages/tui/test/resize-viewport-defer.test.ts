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

const NO_MULTIPLEXER_ENV: Record<string, string | undefined> = { TMUX: undefined, STY: undefined, ZELLIJ: undefined };

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
// instead of waiting on the wall clock. `scheduleImmediate` callbacks are the
// per-event viewport paints; `scheduleRender` callbacks are delayed timers (the
// settle). `flushImmediates` paints the mid-drag state without firing the
// settle; `flushAll` fires the settle and the authoritative replay it queues.
class DeferScheduler implements RenderScheduler {
	#time = 0;
	#immediates: (() => void)[] = [];
	#renders = new Map<number, () => void>();
	#nextId = 0;

	now(): number {
		this.#time += 20;
		return this.#time;
	}

	scheduleImmediate(callback: () => void): void {
		this.#immediates.push(callback);
	}

	scheduleRender(callback: () => void, _delayMs: number): RenderTimer {
		const id = this.#nextId++;
		this.#renders.set(id, callback);
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
			for (const callback of renders) callback();
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
});
