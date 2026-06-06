import { describe, expect, it } from "bun:test";
import { type Component, type NativeScrollbackLiveRegion, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

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

class LiveLineList extends LineList implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return 0;
	}
}

/**
 * A live block whose rendered rows only grow at the bottom and never re-layout
 * (a streaming assistant reply). Its entire body is append-only, so scrolled-off
 * head rows are safe to commit to native scrollback. `Infinity` is clamped to
 * the rendered length by TUI's aggregation.
 */
class AppendOnlyLiveLineList extends LiveLineList {
	getNativeScrollbackCommitSafeEnd(): number | undefined {
		return Number.POSITIVE_INFINITY;
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await Bun.sleep(20);
	await term.flush();
}

function capture(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	(term as unknown as { write: (s: string) => void }).write = (data: string) => {
		writes.push(data);
		realWrite(data);
	};
	return writes;
}

function overrideProbe(term: VirtualTerminal, answer: boolean | undefined): void {
	(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () => answer;
}

type MutableTerminalInfo = {
	eagerEraseScrollbackRisk: boolean;
};

const mutableTerminalInfo = TERMINAL as unknown as MutableTerminalInfo;

async function withTerminalRisk<T>(risk: boolean, run: () => T | Promise<T>): Promise<T> {
	const saved = TERMINAL.eagerEraseScrollbackRisk;
	mutableTerminalInfo.eagerEraseScrollbackRisk = risk;
	try {
		return await run();
	} finally {
		mutableTerminalInfo.eagerEraseScrollbackRisk = saved;
	}
}

const ERASE_SCROLLBACK = /\x1b\[3J/g;

function eraseScrollbackCount(writes: string[]): number {
	return writes.join("").match(ERASE_SCROLLBACK)?.length ?? 0;
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

describe("streaming scrollback defer", () => {
	it("keeps mutable live-region head rows out of native scrollback on ED3-risk terminals", async () => {
		if (process.platform === "win32") return;
		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(20, 4);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			const sealed = new LineList(rows("prior-", 12));
			const live = new LiveLineList([]);

			try {
				tui.addChild(sealed);
				tui.addChild(live);
				tui.start();
				await settle(term);

				const writes = capture(term);
				tui.setEagerNativeScrollbackRebuild(true);

				live.setLines(rows("think-", 6));
				tui.requestRender();
				await settle(term);

				// The sealed prefix is stable and may enter native scrollback. The
				// live block's head (think-0/think-1) has physically left the viewport,
				// but it is still mutable; committing it would leave stale rows in
				// history when the live block re-renders or collapses.
				expect(eraseScrollbackCount(writes)).toBe(0);
				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual([
					...rows("prior-", 12),
					...rows("think-", 6).slice(-4),
				]);

				live.setLines(rows("think-", 8));
				tui.requestRender();
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				expect(eraseScrollbackCount(writes)).toBe(0);
				expect(buffer).toEqual([...rows("prior-", 12), ...rows("think-", 8).slice(-4)]);
			} finally {
				tui.stop();
			}
		});
	});

	it("keeps a tall all-live block transient when no sealed prefix exists", async () => {
		if (process.platform === "win32") return;
		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(20, 4);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			// The only block is the live one (liveRegionStart === 0). Rows above
			// the viewport are mutable, so they must stay out of native scrollback
			// instead of being committed as stale history.
			const live = new LiveLineList([]);

			try {
				tui.addChild(live);
				tui.start();
				await settle(term);

				const writes = capture(term);
				tui.setEagerNativeScrollbackRebuild(true);

				live.setLines(rows("tool-", 10));
				tui.requestRender();
				await settle(term);

				// tool-0..tool-5 scrolled above the 4-row viewport, but the whole
				// block is mutable; only tool-6..tool-9 should remain in the native
				// buffer until a later checkpoint reconciles the full transcript.
				expect(eraseScrollbackCount(writes)).toBe(0);
				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(rows("tool-", 10).slice(-4));
			} finally {
				tui.stop();
			}
		});
	});

	it("commits the scrolled-off head of an append-only live block to native scrollback", async () => {
		if (process.platform === "win32") return;
		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(20, 4);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			// The only block is the live one (liveRegionStart === 0), but unlike a
			// volatile tool preview it is append-only (a streaming assistant reply).
			// Rows that scroll above the viewport must reach native scrollback rather
			// than vanishing — committed nowhere, repainted nowhere.
			const live = new AppendOnlyLiveLineList([]);

			try {
				tui.addChild(live);
				tui.start();
				await settle(term);

				const writes = capture(term);
				tui.setEagerNativeScrollbackRebuild(true);

				live.setLines(rows("text-", 10));
				tui.requestRender();
				await settle(term);

				// text-0..text-5 scrolled above the 4-row viewport; because the block
				// is append-only they enter native scrollback (via `\r\n`, no ED3
				// erase) instead of being dropped like the volatile case above.
				expect(eraseScrollbackCount(writes)).toBe(0);
				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(rows("text-", 10));
			} finally {
				tui.stop();
			}
		});
	});

	it("does not leave stale mutable live-region rows in native scrollback after a rerender", async () => {
		if (process.platform === "win32") return;
		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(24, 4);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			const sealed = new LineList(rows("prior-", 12));
			const live = new LiveLineList([]);

			try {
				tui.addChild(sealed);
				tui.addChild(live);
				tui.start();
				await settle(term);

				const writes = capture(term);
				tui.setEagerNativeScrollbackRebuild(true);

				live.setLines(rows("pending-stale-", 10));
				tui.requestRender();
				await settle(term);

				live.setLines(rows("running-fresh-", 10));
				tui.requestRender();
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				expect(eraseScrollbackCount(writes)).toBe(0);
				expect(buffer.some(line => line.startsWith("pending-stale-"))).toBe(false);
				expect(buffer).toContain("running-fresh-9");
			} finally {
				tui.stop();
			}
		});
	});

	it("defers scrollback growth during eager streaming on ED3-risk and reconciles at the checkpoint", async () => {
		if (process.platform === "win32") return;
		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(40, 10);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			const component = new LineList([...rows("init-", 10), "prompt"]);

			try {
				tui.addChild(component);
				tui.start();
				await settle(term);

				const writes = capture(term);
				const scrollbackBefore = term.getScrollBuffer().length;

				tui.setEagerNativeScrollbackRebuild(true);

				// Grow content past the viewport — capped, no rows enter native
				// scrollback during streaming, and no ED3 erase fires.
				component.setLines([...rows("stream-", 10), ...rows("more-", 30), "prompt"]);
				tui.requestRender();
				await settle(term);

				expect(eraseScrollbackCount(writes)).toBe(0);
				expect(term.getScrollBuffer().length).toBe(scrollbackBefore);
				expect(
					term
						.getViewport()
						.map(line => line.trim())
						.at(-1),
				).toBe("prompt");

				// Grow even more — still capped, still no ED3.
				component.setLines([...rows("stream-", 10), ...rows("more-", 50), "prompt"]);
				tui.requestRender();
				await settle(term);

				expect(eraseScrollbackCount(writes)).toBe(0);
				expect(term.getScrollBuffer().length).toBe(scrollbackBefore);

				// Unknown viewport checkpoints no longer replay destructively. The
				// renderer keeps native history dirty rather than treating a prompt
				// submit as proof that a real host viewport is at tail.
				expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(false);
				await settle(term);

				expect(eraseScrollbackCount(writes)).toBe(0);
				expect(term.getScrollBuffer().length).toBe(scrollbackBefore);
			} finally {
				tui.stop();
			}
		});
	});

	it("does not emit ED3 during streaming on ED3-risk terminals", async () => {
		if (process.platform === "win32") return;
		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(40, 10);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			const component = new LineList([...rows("init-", 10), "prompt"]);

			try {
				tui.addChild(component);
				tui.start();
				await settle(term);

				const writes = capture(term);

				tui.setEagerNativeScrollbackRebuild(true);

				component.setLines([...rows("grow-", 30), "prompt"]);
				tui.requestRender();
				await settle(term);

				expect(eraseScrollbackCount(writes)).toBe(0);

				// Disable on ED3-risk — no historyRebuild
				tui.setEagerNativeScrollbackRebuild(false);
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
	});

	it("does not duplicate committed sealed rows when the live region collapses mid-stream", async () => {
		if (process.platform === "win32") return;
		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(20, 4);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			// Sealed prefix above a live block: growth commits the sealed rows to
			// native scrollback; a later collapse must not repaint them back into the
			// viewport (which would duplicate them in history with no ED3 to erase).
			const sealed = new LineList(rows("prior-", 12));
			const live = new LiveLineList([]);

			try {
				tui.addChild(sealed);
				tui.addChild(live);
				tui.start();
				await settle(term);

				const writes = capture(term);
				tui.setEagerNativeScrollbackRebuild(true);

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
	});

	it("erases mis-wrapped native scrollback on resize even mid-stream on ED3-risk terminals", async () => {
		if (process.platform === "win32") return;
		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(40, 10);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			const component = new LineList([...rows("init-", 5), "prompt"]);

			try {
				tui.addChild(component);
				tui.start();
				await settle(term);

				const writes = capture(term);
				const scrollbackBefore = term.getScrollBuffer().length;
				tui.setEagerNativeScrollbackRebuild(true);

				// Stream past the viewport: the cap keeps transient rows out of native
				// history and no ED3 fires.
				component.setLines([...rows("stream-", 30), "prompt"]);
				tui.requestRender();
				await settle(term);
				expect(eraseScrollbackCount(writes)).toBe(0);
				expect(term.getScrollBuffer().length).toBe(scrollbackBefore);

				// Resize mid-stream. The terminal re-wrapped its saved lines at the old
				// width, so the rebuild must erase them (ED 3) rather than capping to a
				// viewport repaint that would leave the corrupt history on screen.
				term.resize(30, 10);
				await settle(term);

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
	});
});
