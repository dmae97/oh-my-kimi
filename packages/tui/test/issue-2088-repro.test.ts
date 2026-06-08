import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/2088
//
// Closing a tmux horizontal split widens the surviving pane. SIGWINCH fires
// on the host process before tmux finishes repainting the pane buffer at
// the new size, and drag-resize/pane-close animations also fire several
// SIGWINCHes in flight. Forcing an immediate render on every event raced
// those mid-reflow paints — tmux's catch-up paint then partially overwrote
// the TUI output, which the user saw as a viewport flash or blank screen
// before the next throttled frame arrived.
//
// Fix: coalesce SIGWINCHes inside a multiplexer settle window so a single
// forced render fires once the pane is quiet. `#resizeEventPending` is set
// on every event so the eventual render still classifies as a resize.

// Pad the production debounce by 30 ms so the test consistently observes the
// settled render without re-encoding the constant.
const DEBOUNCE_SETTLE_WAIT_MS = 80;

class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

async function withEnvPatch<T>(patch: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const key in patch) {
		saved[key] = Bun.env[key];
		const value = patch[key];
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
	try {
		return await run();
	} finally {
		for (const key in saved) {
			const value = saved[key];
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(1);
	await term.flush();
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

const TMUX_ENV: Record<string, string | undefined> = { TMUX: "1", STY: undefined, ZELLIJ: undefined };
const NO_MULTIPLEXER_ENV: Record<string, string | undefined> = { TMUX: undefined, STY: undefined, ZELLIJ: undefined };

describe("issue #2088: tmux pane-resize race produces viewport flash", () => {
	let monotonicNow = 0;

	beforeEach(() => {
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 40;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("coalesces a burst of multiplexer resize events into a single settled render", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			try {
				tui.start();
				await settle(term);

				const baselineRedraws = tui.fullRedraws;
				const writes = captureWrites(term);

				// Simulate a tmux pane-close animation: several SIGWINCHes arrive
				// while tmux is still mid-reflow, each carrying an intermediate
				// width. Only the final width should be painted, and only once.
				term.resize(60, 10);
				term.resize(75, 10);
				term.resize(80, 10);

				// Inside the debounce window: no new paint must have landed yet,
				// otherwise the TUI would be writing into a pane tmux has not
				// finished reflowing.
				await Bun.sleep(10);
				expect(tui.fullRedraws).toBe(baselineRedraws);
				expect(writes.length).toBe(0);

				// After the settle window the single coalesced render fires at the
				// final geometry — exactly one paint covering 80×10.
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(tui.fullRedraws - baselineRedraws).toBe(1);
				expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
			} finally {
				tui.stop();
			}
		});
	});

	it("renders immediately on resize outside a multiplexer", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			try {
				tui.start();
				await settle(term);

				const baselineRedraws = tui.fullRedraws;
				term.resize(80, 10);
				await settle(term);
				expect(tui.fullRedraws).toBeGreaterThan(baselineRedraws);
				expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
			} finally {
				tui.stop();
			}
		});
	});

	it("cancels a pending multiplexer resize timer on stop()", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			tui.start();
			await settle(term);

			const writes = captureWrites(term);
			term.resize(80, 10);
			tui.stop();

			// stop() must cancel the pending debounce; no render bytes appear
			// after the settle window has elapsed, even though the resize was
			// armed only moments ago.
			await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
			const lateRepaintBytes = writes.filter(chunk => chunk.includes("\x1b[H")).length;
			expect(lateRepaintBytes).toBe(0);
		});
	});

	it("supersedes a throttled render queued just before a multiplexer SIGWINCH", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			const lines = Array.from({ length: 20 }, (_v, i) => `line-${i}`);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const baselineRedraws = tui.fullRedraws;
				const writes = captureWrites(term);

				// A streamed token lands in the same 30fps frame as the SIGWINCH:
				// `requestRender(false)` arms `#renderTimer`, then `term.resize`
				// fires the SIGWINCH that arms the multiplexer debounce. If the
				// queued throttled render were left active it would fire inside
				// the 50 ms settle window and paint mid-reflow.
				lines[19] = "line-19 streamed";
				component.setLines(lines);
				tui.requestRender();
				term.resize(80, 10);

				// During the debounce window: no paint must land. The queued
				// throttled timer was canceled and any follow-on
				// `requestRender(false)` is held off until the multiplexer
				// settles.
				await Bun.sleep(10);
				expect(tui.fullRedraws).toBe(baselineRedraws);
				expect(writes.length).toBe(0);

				// After the settle window: exactly one forced render lands, at
				// the new geometry, with the streamed token visible.
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(tui.fullRedraws - baselineRedraws).toBe(1);
				expect(visible(term).at(-1)).toBe("line-19 streamed");
			} finally {
				tui.stop();
			}
		});
	});

	it("defers a forced repaint that lands inside the multiplexer settle window", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			try {
				tui.start();
				await settle(term);

				const baselineRedraws = tui.fullRedraws;
				const writes = captureWrites(term);

				// A SIGWINCH starts the debounce. Then a `requestRender(true)`
				// (e.g. from finishSixelProbe or an image-budget eviction)
				// arrives mid-window. Without deferral it would paint
				// immediately into a still-reflowing pane.
				term.resize(80, 10);
				await Bun.sleep(10);
				tui.requestRender(true);

				// Inside the window: still no paint. The forced render was
				// folded into the in-flight debounce.
				await Bun.sleep(20);
				expect(tui.fullRedraws).toBe(baselineRedraws);
				expect(writes.length).toBe(0);

				// After the window: exactly one settled paint at the final
				// geometry.
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(tui.fullRedraws - baselineRedraws).toBe(1);
				expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
			} finally {
				tui.stop();
			}
		});
	});

	it("defers resetDisplay() that lands inside the multiplexer settle window", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			try {
				tui.start();
				await settle(term);

				const baselineRedraws = tui.fullRedraws;
				const writes = captureWrites(term);

				term.resize(80, 10);
				await Bun.sleep(10);
				tui.resetDisplay();

				// resetDisplay normally repaints synchronously; here it must
				// route through the multiplexer debounce so no paint lands
				// while tmux is still reflowing.
				await Bun.sleep(20);
				expect(tui.fullRedraws).toBe(baselineRedraws);
				expect(writes.length).toBe(0);

				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(tui.fullRedraws - baselineRedraws).toBe(1);
				expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
			} finally {
				tui.stop();
			}
		});
	});
});
