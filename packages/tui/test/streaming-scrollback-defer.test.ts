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
	it("keeps sealed prefix scrollable while deferring live-region rows on ED3-risk terminals", async () => {
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
				expect(buffer.filter(line => line.startsWith("prior-"))).toEqual(rows("prior-", 12));
				expect(buffer.slice(-4)).toEqual(rows("think-", 8).slice(-4));
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
});
