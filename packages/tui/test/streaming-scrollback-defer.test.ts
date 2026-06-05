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
	it("commits every row above the viewport (incl. the live-block head) without ED3 on ED3-risk terminals", async () => {
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

				// The live block (think-*) overflows the 4-row viewport. Every row that
				// scrolled above the viewport top — including the live block's own head
				// (think-0/think-1) — must enter native scrollback; only the visible tail
				// stays transient. No ED3 erase fires during streaming.
				expect(eraseScrollbackCount(writes)).toBe(0);
				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual([
					...rows("prior-", 12),
					...rows("think-", 6),
				]);

				live.setLines(rows("think-", 8));
				tui.requestRender();
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				expect(eraseScrollbackCount(writes)).toBe(0);
				expect(buffer).toEqual([...rows("prior-", 12), ...rows("think-", 8)]);
			} finally {
				tui.stop();
			}
		});
	});

	it("keeps the head of a tall live block that alone overflows the viewport (no sealed prefix)", async () => {
		if (process.platform === "win32") return;
		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(20, 4);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			// The only block is the live one (liveRegionStart === 0), so the entire
			// scrollback commit originates inside the live region. A clamp to the
			// sealed boundary would commit nothing and erase the block's head.
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

				// tool-0..tool-5 scrolled above the 4-row viewport and must be in
				// scrollback; tool-6..tool-9 fill the viewport. None are erased.
				expect(eraseScrollbackCount(writes)).toBe(0);
				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(rows("tool-", 10));
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

				// The prompt-submit checkpoint reconciles the deferred transcript with
				// a single ED3 + re-emit — even while eager is still active, because an
				// explicit reconcile is never deferred.
				expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(true);
				await settle(term);

				expect(eraseScrollbackCount(writes)).toBe(1);

				const scrollbackAfter = term.getScrollBuffer();
				expect(scrollbackAfter.length).toBeGreaterThan(scrollbackBefore);
				expect(scrollbackAfter.join("\n")).toContain("stream-");
				expect(scrollbackAfter.join("\n")).toContain("more-");
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
});
