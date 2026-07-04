import { describe, expect, it } from "bun:test";
import { type Component, type NativeScrollbackLiveRegion, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/2130
//
// Inside tmux (and other multiplexers), `requestRender(true, { clearScrollback: true })`
// dispatches the `sessionReplace` intent, which re-emits the entire transcript
// through `#emitFullPaint` with `options.clearScrollback === false` (ED 3 is a
// no-op in pane history). Before the fix, `#emitFullPaint` only reset
// `#scrollbackHighWater` inside the `clearScrollback` branch and otherwise
// raised it monotonically (`if (pushedNow > #scrollbackHighWater)`), so the
// high-water from a tall pre-rewind streamed reply survived the shrink. On
// the next frame `#planLiveRegionPinnedRender` saw `#scrollbackHighWater`
// far above the new natural viewport top and anchored `renderViewportTop`
// past the actual content — repainting every visible row blank and parking
// the cursor at the pane top, persistent until session end.
//
// A full repaint with `clearViewport: true` physically re-emits the entire
// transcript from row 0, so the rows committed to native scrollback by that
// paint are exactly `Math.max(0, lines.length - height)` regardless of
// whether ED 3 cleared pre-paint scrollback. Assigning instead of monotonic-
// max keeps the renderer's bookkeeping in sync with the freshly painted
// transcript in both mux and non-mux modes.

class StreamingLiveRegion implements Component, NativeScrollbackLiveRegion {
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

	getNativeScrollbackLiveRegionStart(): number | undefined {
		// Append-only stream: every rendered row is declared final.
		return this.#lines.length;
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(40);
	await term.flush();
}

async function withTmuxEnv<T>(run: () => T | Promise<T>): Promise<T> {
	const saved = { TMUX: Bun.env.TMUX, STY: Bun.env.STY, ZELLIJ: Bun.env.ZELLIJ };
	Bun.env.TMUX = "tmux-2130";
	delete Bun.env.STY;
	delete Bun.env.ZELLIJ;
	try {
		return await run();
	} finally {
		if (saved.TMUX === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = saved.TMUX;
		if (saved.STY === undefined) delete Bun.env.STY;
		else Bun.env.STY = saved.STY;
		if (saved.ZELLIJ === undefined) delete Bun.env.ZELLIJ;
		else Bun.env.ZELLIJ = saved.ZELLIJ;
	}
}

describe("issue #2130: tmux rewind/branch leaves the viewport anchored to the pane top", () => {
	it("recovers normal rendering after a clearScrollback render shrinks a tall transcript", async () => {
		if (process.platform === "win32") return;

		await withTmuxEnv(async () => {
			const term = new VirtualTerminal(40, 8, 10_000);
			// Real tmux/ProcessTerminal does not implement the at-bottom
			// probe; match production by returning undefined.
			(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () =>
				undefined;

			const tui = new TUI(term);
			const stream = new StreamingLiveRegion([]);
			tui.addChild(stream);

			try {
				tui.start();
				await settle(term);

				// Stream a tall reply so `#planLiveRegionPinnedRender` ramps
				// `#scrollbackHighWater` past the viewport boundary.
				const tall = Array.from({ length: 25 }, (_unused, i) => `TALL-${String(i).padStart(3, "0")}`);
				for (let chunk = 5; chunk <= tall.length; chunk += 5) {
					stream.setLines(tall.slice(0, chunk));
					tui.requestRender();
					await settle(term);
				}

				// Branch/rewind: the coding-agent replaces the transcript with
				// the shorter pre-branch slice and forces a clearScrollback
				// render (the same path `selector-controller.handleRewind`
				// and friends take). The new content fits entirely inside
				// the viewport (4 rows vs height = 8).
				stream.setLines(["A", "B", "C", "D"]);
				tui.requestRender(true, { clearScrollback: true });
				await settle(term);

				// Any subsequent frame after the rewind would re-route through
				// `#planLiveRegionPinnedRender`. Before the fix the stale
				// `#scrollbackHighWater` (~17, from streaming) made the
				// planner pick `liveRegionPinned` with `renderViewportTop`
				// at 5, so the emitter clamped `viewportTop` to
				// `lines.length` and wrote eight blank rows.
				stream.setLines(["A", "B", "C", "D", "E"]);
				tui.requestRender();
				await settle(term);

				const viewport = term.getViewport().map(row => Bun.stripANSI(row).trimEnd());

				// The visible viewport is bottom-anchored to the new content:
				// five live rows followed by three blank rows below the live
				// tail. Pre-fix: every row was blank.
				expect(viewport.slice(0, 5)).toEqual(["A", "B", "C", "D", "E"]);

				// The cursor lands on the last content row, not at the pane
				// top. Pre-fix: `parkUp` from the pinned emitter dragged the
				// cursor up to screen row 0.
				expect(term.getCursor().row).toBe(4);
			} finally {
				tui.stop();
				await term.flush();
			}
		});
	});
});
