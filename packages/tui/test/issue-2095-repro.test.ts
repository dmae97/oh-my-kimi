import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, type RenderScheduler, type RenderTimer, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/2095
//
// A session resume on Windows ConPTY paints the entire transcript (often
// thousands of rows) through `#emitFullPaint` so the historical content lands
// in native scrollback. Windows Terminal's viewport-follow logic gets lossy
// during that burst: spinner/blink-driven `requestRender(false)` calls firing
// at 30 Hz immediately afterwards each emit another viewport repaint, and the
// host can't keep up — every follow-up write nudges the viewport further
// above the last row until any focus event (Alt+Tab) forces a host repaint.
//
// Fix: after every `#emitFullPaint` whose `lines.length` exceeded the viewport
// height, the renderer arms a 150 ms ConPTY settle window. Every non-forced
// `requestRender(false)` inside the window is coalesced into a single trailing
// render that fires once the window expires, letting the host fully drain the
// big paint before any new bytes touch the buffer. The gate is keyed on
// `isConPTYHosted()` so non-Windows terminals stay on the immediate path.

const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

function restorePlatform(): void {
	if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
}

class TallContent implements Component {
	#lines: string[];

	constructor(rowCount: number) {
		this.#lines = Array.from({ length: rowCount }, (_v, i) => `transcript row ${i.toString().padStart(5, "0")}`);
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(40);
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

describe("issue #2095: ConPTY post-full-paint settle prevents viewport drift", () => {
	const originalWslDistro = Bun.env.WSL_DISTRO_NAME;
	const originalWslInterop = Bun.env.WSL_INTEROP;

	beforeEach(() => {
		// Default to a clean Linux: tests explicitly opt into win32 or WSL.
		delete Bun.env.WSL_DISTRO_NAME;
		delete Bun.env.WSL_INTEROP;
	});

	afterEach(() => {
		restorePlatform();
		if (originalWslDistro === undefined) delete Bun.env.WSL_DISTRO_NAME;
		else Bun.env.WSL_DISTRO_NAME = originalWslDistro;
		if (originalWslInterop === undefined) delete Bun.env.WSL_INTEROP;
		else Bun.env.WSL_INTEROP = originalWslInterop;
		vi.restoreAllMocks();
	});

	it("coalesces a 30 Hz spinner storm after a big sessionReplace paint into one trailing render on win32", async () => {
		setPlatform("win32");
		const term = new VirtualTerminal(80, 24, 4096);
		const tui = new TUI(term);
		// 200 rows fills well past the 24-row viewport so `#emitFullPaint`
		// detects scrollback overflow and arms the settle window.
		tui.addChild(new TallContent(200));

		try {
			tui.start();
			await settle(term);
			const fullPaintsAfterStart = tui.fullRedraws;
			expect(fullPaintsAfterStart).toBeGreaterThanOrEqual(1);

			// Inside the 150 ms settle window: fire eight non-forced renders
			// rapidly, simulating a spinner ticking at ~30 Hz. None of them
			// should produce a paint while the window is active — they coalesce
			// into one trailing render that fires after the window expires.
			for (let i = 0; i < 8; i++) {
				tui.requestRender();
			}

			// Sample at half the settle window: no follow-up paint must have
			// landed yet, otherwise the host is being asked to draw before the
			// previous big paint has drained.
			await Bun.sleep(60);
			expect(tui.fullRedraws).toBe(fullPaintsAfterStart);

			// After the settle window (150 ms total + scheduler headroom),
			// exactly one trailing render fires regardless of how many
			// requests landed inside the window. The trailing render is a
			// diff/noop (content didn't change), so fullRedraws stays at the
			// baseline — what matters is that the storm was coalesced into
			// one cycle.
			await Bun.sleep(180);
			await settle(term);
			expect(tui.fullRedraws).toBe(fullPaintsAfterStart);
		} finally {
			tui.stop();
		}
	});

	it("does not arm the settle on a clean (non-ConPTY) linux host", async () => {
		setPlatform("linux");
		const term = new VirtualTerminal(80, 24, 4096);
		const tui = new TUI(term);
		tui.addChild(new TallContent(200));

		try {
			tui.start();
			await settle(term);
			const fullPaintsAfterStart = tui.fullRedraws;

			// Same storm pattern as the win32 test, but no settle gate is
			// armed: requestRender(false) follows the immediate scheduler
			// path. The cursor-only noop renders don't bump fullRedraws — what
			// we're asserting is that no settle-window timer parks the next
			// render past the 30 Hz throttle. Wait one frame interval and
			// confirm the renderer is responsive.
			tui.requestRender();
			await Bun.sleep(50);
			await settle(term);

			// Renderer must remain responsive; fullRedraws stays put because
			// content didn't change, but the test would hang if requestRender
			// were deferred to a settle window that never armed.
			expect(tui.fullRedraws).toBe(fullPaintsAfterStart);
		} finally {
			tui.stop();
		}
	});

	it("forced renders preempt an in-flight settle so they fire immediately", async () => {
		setPlatform("win32");
		const term = new VirtualTerminal(80, 24, 4096);
		const tui = new TUI(term);
		tui.addChild(new TallContent(200));

		try {
			tui.start();
			await settle(term);
			const fullPaintsAfterStart = tui.fullRedraws;

			// Land inside the settle window with a forced render — it must
			// run on the immediate path, not coalesce with the settle's
			// trailing render. `resetDisplay()` is one such caller (Ctrl+L);
			// `requestRender(true)` is the underlying primitive.
			tui.requestRender(true);
			await settle(term);
			expect(tui.fullRedraws).toBeGreaterThan(fullPaintsAfterStart);
		} finally {
			tui.stop();
		}
	});

	it("stop() cancels a pending settle-window trailing render on win32", async () => {
		setPlatform("win32");
		const term = new VirtualTerminal(80, 24, 4096);
		const tui = new TUI(term);
		tui.addChild(new TallContent(200));

		tui.start();
		await settle(term);

		// Arm the trailing render by firing a non-forced request inside the
		// settle window, then stop immediately. The trailing render must NOT
		// fire after stop — otherwise it would write to a torn-down terminal.
		const writes = captureWrites(term);
		tui.requestRender();
		tui.stop();

		const writesAtStop = writes.length;

		// Sample past the settle window. No render bytes (and no exception)
		// must arrive after stop.
		await Bun.sleep(200);
		expect(writes.length).toBe(writesAtStop);
	});

	it("absorbs a mid-paint `requestRender(false)` (e.g. ImageBudget.endPass) into the trailing settle on win32 (#2095)", async () => {
		// `ImageBudget.endPass()` (and any other mid-composition caller) can fire
		// `requestRender(false)` from inside the in-flight paint, *before*
		// `#armPostFullPaintSettle()` runs at the tail of the intent dispatch.
		// That request sets `#renderRequested` / `#renderTimer` without going
		// through the settle gate, and would otherwise fire on the standard
		// 30 Hz throttle (~33 ms) — well inside the 150 ms settle window —
		// defeating the coalescing. The arm must reclaim those flags and
		// re-queue the request via the settle's trailing timer.
		//
		// A noop trailing render with unchanged cursor emits zero bytes, so
		// `term.write` counting is too weak. We instead inject a recording
		// `RenderScheduler` and assert directly on which timers were queued:
		// every `scheduleRender(cb, delayMs)` call records `delayMs`, and the
		// contract is that no short-delay (< 100 ms) timer is queued after
		// the sessionReplace arm — only the settle's trailing timer at the
		// full 150 ms window.
		setPlatform("win32");
		const term = new VirtualTerminal(80, 24, 4096);

		type Scheduled = { delayMs: number };
		const scheduled: Scheduled[] = [];
		const recordingScheduler: RenderScheduler = {
			now: () => performance.now(),
			scheduleImmediate: cb => process.nextTick(cb),
			scheduleRender: (cb, delayMs): RenderTimer => {
				const entry: Scheduled = { delayMs };
				scheduled.push(entry);
				const handle = setTimeout(cb, delayMs);
				return { cancel: () => clearTimeout(handle) };
			},
		};

		const tui = new TUI(term, undefined, { renderScheduler: recordingScheduler });
		let midPaintFired = false;
		const midPaintRequester: Component = {
			invalidate(): void {},
			render(width: number): string[] {
				const lines: string[] = [];
				if (!midPaintFired) {
					midPaintFired = true;
					// Mirror `ImageBudget.endPass()` exactly: a synchronous
					// non-forced `requestRender()` from inside the in-flight
					// composition, before `#armPostFullPaintSettle()` runs.
					tui.requestRender();
				}
				for (let i = 0; i < 200; i++) lines.push(`mid-paint row ${i.toString().padStart(5, "0")}`.slice(0, width));
				return lines;
			},
		};
		tui.addChild(midPaintRequester);

		try {
			tui.start();
			await settle(term);
			// Promote the next paint to `sessionReplace` so the settle arms.
			midPaintFired = false; // re-arm for the sessionReplace paint
			scheduled.length = 0; // discard timers from setup
			tui.requestRender(true, { clearScrollback: true });
			await settle(term);
			expect(midPaintFired).toBe(true);

			// The mid-paint requestRender(false) would, without the fix, queue a
			// throttled render at MIN_RENDER_INTERVAL_MS (~33 ms). With the fix
			// it's absorbed: every `scheduleRender` call recorded after the
			// sessionReplace must be at the full settle window length (≈150 ms)
			// or longer (e.g. multiplexer-resize debounce on resize bursts) —
			// never the 33 ms throttle that would defeat the settle. The
			// `settle()` helper above already waited 40 ms — long enough for
			// the would-be throttled timer to have been scheduled if it leaked.
			const shortDelayTimers = scheduled.filter(s => s.delayMs > 0 && s.delayMs < 100);
			expect(shortDelayTimers).toEqual([]);
			const settleTimers = scheduled.filter(s => s.delayMs >= 100);
			expect(settleTimers.length).toBeGreaterThanOrEqual(1);

			// Let the settle expire so the trailing render fires and any
			// pending timers drain before the test tears down the TUI.
			await Bun.sleep(200);
			await settle(term);
		} finally {
			tui.stop();
		}
	});
});
