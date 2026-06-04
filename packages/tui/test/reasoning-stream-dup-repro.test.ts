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
});
