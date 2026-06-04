import { describe, expect, it } from "bun:test";
import { getTerminalInfo, TERMINAL } from "../src/terminal-capabilities";
import { type Component, type NativeScrollbackLiveRegion, TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

class LineList implements Component, NativeScrollbackLiveRegion {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = lines;
	}
	setLines(lines: string[]): void {
		this.#lines = lines;
	}
	invalidate(): void {}
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return 0;
	}
	render(_width: number): string[] {
		return this.#lines;
	}
}

// A non-live (sealed) block: it does NOT report a live region, so the TUI treats
// it as committable native scrollback below the live boundary.
class LineListSealed implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = lines;
	}
	setLines(lines: string[]): void {
		this.#lines = lines;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.#lines;
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await term.waitForRender();
}

function overrideProbe(term: VirtualTerminal, answer: boolean | undefined): void {
	(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () => answer;
}

type MutableTerminalInfo = { eagerEraseScrollbackRisk: boolean };
const MUX_KEYS = ["TMUX", "STY", "ZELLIJ"] as const;

async function withGhostty(run: () => Promise<void>): Promise<void> {
	const mut = TERMINAL as unknown as MutableTerminalInfo;
	const prev = mut.eagerEraseScrollbackRisk;
	const prevEnv: Record<string, string | undefined> = {};
	for (const key of MUX_KEYS) {
		prevEnv[key] = Bun.env[key];
		delete (Bun.env as Record<string, string | undefined>)[key];
	}
	mut.eagerEraseScrollbackRisk = getTerminalInfo("ghostty").eagerEraseScrollbackRisk;
	try {
		await run();
	} finally {
		mut.eagerEraseScrollbackRisk = prev;
		for (const key of MUX_KEYS) {
			if (prevEnv[key] === undefined) delete (Bun.env as Record<string, string | undefined>)[key];
			else (Bun.env as Record<string, string | undefined>)[key] = prevEnv[key];
		}
	}
}

function dupNonblank(lines: string[]): string[] {
	const seen = new Set<string>();
	const dups: string[] = [];
	for (const line of lines.map(l => l.trimEnd())) {
		if (line.length === 0) continue;
		if (seen.has(line)) dups.push(line);
		seen.add(line);
	}
	return dups;
}

describe("foreground-stream scrollback duplication on ED3-risk ghostty", () => {
	it("does not duplicate history rows when overflowing content then shrinks", async () => {
		await withGhostty(async () => {
			const term = new VirtualTerminal(20, 4);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			const list = new LineList([]);
			tui.addChild(list);
			try {
				tui.start();
				await settle(term);
				tui.setEagerNativeScrollbackRebuild(true); // foreground stream turn

				// Grow past the viewport so rows scroll into native history.
				const grown = Array.from({ length: 10 }, (_v, i) => `row-${i}`);
				list.setLines(grown);
				tui.requestRender();
				await settle(term);

				// Re-layout shrink (e.g. preview/reasoning collapses), still overflowing.
				const shrunk = Array.from({ length: 7 }, (_v, i) => `row-${i}`);
				list.setLines(shrunk);
				tui.requestRender();
				await settle(term);
				const streamingBuffer = term.getScrollBuffer();
				expect(dupNonblank(streamingBuffer)).toEqual([]);

				tui.setEagerNativeScrollbackRebuild(false);
				tui.requestRender();
				await settle(term);
				expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(true);
				await settle(term);
				const checkpointBuffer = term.getScrollBuffer();
				expect(checkpointBuffer.map(line => line.trimEnd())).toEqual(shrunk);
				expect(dupNonblank(checkpointBuffer)).toEqual([]);
			} finally {
				tui.stop();
			}
		});
	});

	it("never emits a full-screen erase (ED2/ED3) while pinning the live region", async () => {
		await withGhostty(async () => {
			const term = new VirtualTerminal(20, 4);
			overrideProbe(term, undefined);
			let captured = "";
			const realWrite = term.write.bind(term);
			(term as unknown as { write: (s: string) => void }).write = (s: string) => {
				captured += s;
				realWrite(s);
			};
			const tui = new TUI(term);
			const list = new LineList([]);
			tui.addChild(list);
			try {
				tui.start();
				await settle(term);
				tui.setEagerNativeScrollbackRebuild(true);
				captured = ""; // focus on the streaming frames

				// Grow the live block well past the viewport, one line at a time, then
				// re-layout shrink — the exact pattern that snapped the view before.
				const acc: string[] = [];
				for (let n = 1; n <= 24; n++) {
					acc.push(`line-${n}`);
					list.setLines([...acc]);
					tui.requestRender();
					await settle(term);
				}
				list.setLines(acc.slice(0, 18));
				tui.requestRender();
				await settle(term);

				// The pin must repaint incrementally. A full-screen erase (ED2) or a
				// scrollback wipe (ED3) snaps a scrolled-up Ghostty reader to the tail.
				expect(captured.includes("\x1b[2J")).toBe(false);
				expect(captured.includes("\x1b[3J")).toBe(false);
				// Sanity: the pin actually ran (otherwise the assertions are vacuous).
				expect(tui.fullRedraws).toBeGreaterThan(0);
			} finally {
				tui.stop();
			}
		});
	});

	it("keeps a scrolled reader's viewport fixed while the live region streams", async () => {
		await withGhostty(async () => {
			const term = new VirtualTerminal(20, 4);
			overrideProbe(term, undefined);
			const tui = new TUI(term);
			const sealed = new LineListSealed(Array.from({ length: 12 }, (_v, i) => `prior-${i}`));
			const live = new LineList([]);
			tui.addChild(sealed);
			tui.addChild(live);
			try {
				tui.start();
				await settle(term);
				// Commit the prior conversation to native history (checkpoint), then
				// begin a streaming turn and scroll up into that history.
				expect(tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true })).toBe(false);
				tui.setEagerNativeScrollbackRebuild(true);
				live.setLines(Array.from({ length: 6 }, (_v, i) => `think-${i}`));
				tui.requestRender();
				await settle(term);
				term.scrollLines(-3); // user scrolls up into history
				const before = term.getBufferPosition().viewportY;
				for (let n = 7; n <= 20; n++) {
					live.setLines(Array.from({ length: n }, (_v, i) => `think-${i}`));
					tui.requestRender();
					await settle(term);
				}
				// Streaming output must not drag the scrolled viewport down.
				expect(term.getBufferPosition().viewportY).toBe(before);
			} finally {
				tui.stop();
			}
		});
	});
});
