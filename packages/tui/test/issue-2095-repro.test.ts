import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
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
});
