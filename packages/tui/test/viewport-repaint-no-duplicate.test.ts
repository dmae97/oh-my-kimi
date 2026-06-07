import { describe, expect, it } from "bun:test";
import { type Component, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// A non-destructive viewport repaint (the path foreground-tool completion takes on
// ED3-risk terminals with an unprobeable viewport) must never re-paint rows that
// are byte-identical to what is already committed to native scrollback above the
// viewport. Doing so stacks a second copy of the committed prefix into the active
// grid — the "transcript on top of itself" / header-reappears duplication the user
// hit. The renderer clamps the repaint anchor to the committed-and-unchanged
// prefix (`min(firstChanged, #scrollbackHighWater)`).

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

async function settle(term: VirtualTerminal): Promise<void> {
	const tick = Promise.withResolvers<void>();
	process.nextTick(tick.resolve);
	await tick.promise;
	await Bun.sleep(20);
	await term.flush();
}

function overrideProbe(term: VirtualTerminal, answer: boolean | undefined): void {
	(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () => answer;
}

const count = (lines: string[], needle: string): number => lines.filter(line => line.includes(needle)).length;

describe("viewport repaint committed-prefix clamp", () => {
	it("does not duplicate a committed header when the live block collapses", async () => {
		const savedRisk = TERMINAL.eagerEraseScrollbackRisk;
		TERMINAL.eagerEraseScrollbackRisk = true;
		const term = new VirtualTerminal(40, 10);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// Row 0 is a stable header that scrolls into native scrollback; the rest is a
		// live block (a tall streaming tool preview).
		const tall = ["PINNED-HEADER", ...Array.from({ length: 24 }, (_v, i) => `live-${i}`)];
		const component = new LineList(tall);
		tui.addChild(component);
		try {
			tui.start();
			await settle(term);
			// Foreground streaming is active; the tool then completes, collapsing the
			// live block to a short settled result while the header stays unchanged.
			tui.setEagerNativeScrollbackRebuild(true);
			component.setLines(["PINNED-HEADER", ...Array.from({ length: 7 }, (_v, i) => `settled-${i}`)]);
			tui.requestRender();
			await settle(term);

			const scrollback = term.getScrollBuffer();
			const viewport = term.getViewport();
			const combined = [...scrollback, ...viewport];
			// The committed header exists exactly once across saved history + viewport.
			expect(count(combined, "PINNED-HEADER")).toBe(1);
			// The settled result is visible.
			expect(count(viewport, "settled-6")).toBe(1);
		} finally {
			tui.stop();
			TERMINAL.eagerEraseScrollbackRisk = savedRisk;
		}
	});
});
