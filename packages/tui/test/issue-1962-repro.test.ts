import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Component, type Focusable, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

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

class ArrowSelectorComponent implements Component, Focusable {
	focused = true;
	#selectedIndex = 0;

	handleInput(data: string): void {
		if (data === "\x1b[B") this.#selectedIndex = 1;
		if (data === "\x1b[A") this.#selectedIndex = 0;
	}

	invalidate(): void {}

	render(): string[] {
		return [this.#selectedIndex === 0 ? "> first" : "  first", this.#selectedIndex === 1 ? "> second" : "  second"];
	}
}

class UnknownViewportTerminal extends VirtualTerminal {
	isNativeViewportAtBottom(): undefined {
		return undefined;
	}
}

type MutableTerminalInfo = {
	eagerEraseScrollbackRisk: boolean;
};

const mutableTerminalInfo = TERMINAL as unknown as MutableTerminalInfo;
const ERASE_SCROLLBACK = /\x1b\[3J/g;

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(20);
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

async function withTerminalRisk<T>(risk: boolean, run: () => T | Promise<T>): Promise<T> {
	const saved = TERMINAL.eagerEraseScrollbackRisk;
	mutableTerminalInfo.eagerEraseScrollbackRisk = risk;
	try {
		return await run();
	} finally {
		mutableTerminalInfo.eagerEraseScrollbackRisk = saved;
	}
}

describe("issue #1962: arrow navigation after dirty scrollback", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not clear and replay the whole transcript for a focused arrow-key frame", async () => {
		await withTerminalRisk(true, async () => {
			const term = new UnknownViewportTerminal(40, 6);
			const tui = new TUI(term);
			const transcript = new MutableLinesComponent(
				Array.from({ length: 12 }, (_value, index) => `history-${index}`),
			);
			const selector = new ArrowSelectorComponent();
			tui.addChild(transcript);
			tui.addChild(selector);
			tui.setFocus(selector);

			try {
				tui.start();
				await settle(term);

				tui.setEagerNativeScrollbackRebuild(true);
				transcript.setLines([
					"history-0 updated",
					...Array.from({ length: 11 }, (_value, index) => `history-${index + 1}`),
				]);
				tui.requestRender();
				await settle(term);
				tui.setEagerNativeScrollbackRebuild(false);

				const writes = captureWrites(term);
				term.sendInput("\x1b[B");
				await settle(term);

				const output = writes.join("");
				expect(output.match(ERASE_SCROLLBACK) ?? []).toHaveLength(0);
				expect(output).not.toContain("history-0 updated");
				expect(term.getViewport().map(line => line.trimEnd())).toEqual([
					"history-8",
					"history-9",
					"history-10",
					"history-11",
					"  first",
					"> second",
				]);
			} finally {
				tui.stop();
			}
		});
	});

	it("does not clear and replay the whole transcript for a focused arrow-key frame inside an overlay", async () => {
		await withTerminalRisk(true, async () => {
			const term = new UnknownViewportTerminal(40, 6);
			const tui = new TUI(term);
			const transcript = new MutableLinesComponent(
				Array.from({ length: 12 }, (_value, index) => `history-${index}`),
			);
			tui.addChild(transcript);
			const selector = new ArrowSelectorComponent();
			tui.showOverlay(selector);

			try {
				tui.start();
				await settle(term);

				tui.setEagerNativeScrollbackRebuild(true);
				transcript.setLines([
					"history-0 updated",
					...Array.from({ length: 11 }, (_value, index) => `history-${index + 1}`),
				]);
				tui.requestRender();
				await settle(term);
				tui.setEagerNativeScrollbackRebuild(false);

				const writes = captureWrites(term);
				term.sendInput("\x1b[B");
				await settle(term);

				const output = writes.join("");
				expect(output.match(ERASE_SCROLLBACK) ?? []).toHaveLength(0);
				expect(output).not.toContain("history-0 updated");
				expect(term.getViewport().map(line => line.trimEnd())).toContain("> second");
			} finally {
				tui.stop();
			}
		});
	});
});
