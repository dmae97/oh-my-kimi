import { describe, expect, it } from "bun:test";
import { type Component, TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/643
//
// Arabic text with tashkeel (nonspacing diacritics, Unicode category Mn) was
// over-measured: each mark counted as 1 column instead of 0. A line of Quranic
// text with N marks therefore reported a width N columns larger than what the
// terminal actually renders, and the renderer crashed with "Rendered line
// exceeds terminal width" (13.19.0) once enough marks accumulated.
//
// Root cause: `Bun.stringWidth` counts Mn marks as 1 column (still true as of
// Bun 1.3.x). The fix routes every non-ASCII line through the native width
// engine (Rust `unicode-width`), which measures nonspacing marks as 0 — in
// agreement with xterm.js (BMP_COMBINING tables) and real terminals.
//
// The contract defended here: tashkeel marks contribute zero columns, so a
// marked-up line whose letter width exactly equals the terminal width renders
// unclipped on a single row. Over-measurement would either truncate trailing
// letters (today's fitting behavior) or crash (the original report).

// Tashkeel samples from the issue, with their correct letter-cell widths.
const TASHKEEL_SAMPLES: ReadonlyArray<readonly [text: string, width: number]> = [
	["بِسْمِ", 3], // 3 letters + 3 marks
	["سَابِقُوا", 6], // 6 letters + 3 marks
	["فَتَبَيَّنُوا", 7], // 7 letters + 5 marks (incl. shadda)
];

class RawLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(): string[] {
		return [...this.#lines];
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(20);
	await term.flush();
}

describe("issue #643: Arabic tashkeel width measurement", () => {
	it("measures nonspacing tashkeel marks as zero columns", () => {
		for (const [text, width] of TASHKEEL_SAMPLES) {
			expect(visibleWidth(text)).toBe(width);
		}
		// Mixed ASCII + tashkeel stays on the non-ASCII measurement path.
		expect(visibleWidth(`ayah: ${TASHKEEL_SAMPLES[1][0]}`)).toBe(6 + TASHKEEL_SAMPLES[1][1]);
	});

	it("renders a full-width tashkeel line unclipped on a single terminal row", async () => {
		// "quran: " (7 cells) + 6-cell word = 13 cells — an exact fit at width 13.
		// The original bug measured the word as 9 (6 letters + 3 marks), making the
		// line appear 3 columns too wide, so the renderer's width fitting would
		// truncate real trailing letters before writing.
		const word = TASHKEEL_SAMPLES[1][0];
		const line = `quran: ${word}`;
		const width = 13;
		expect(visibleWidth(line)).toBe(width);

		const term = new VirtualTerminal(width, 6);
		const tui = new TUI(term);
		const component = new RawLinesComponent(["header", line, "tail"]);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);

			const viewport = term.getViewport().map(row => row.trimEnd());
			// The full marked-up text survives the round trip: no truncation by the
			// renderer, no clipping or wrapping by the terminal.
			expect(viewport[1]).toBe(line);
			expect(viewport[0]).toBe("header");
			expect(viewport[2]).toBe("tail");
			// Exactly one terminal row per logical row — the marks did not push the
			// line across the right margin.
			expect(term.getScrollBuffer().length).toBe(6);
		} finally {
			tui.stop();
		}
	});

	it("keeps row accounting exact when tashkeel rows scroll into native history", async () => {
		const word = TASHKEEL_SAMPLES[2][0];
		const width = 24;
		const height = 5;
		const term = new VirtualTerminal(width, height);
		const tui = new TUI(term);
		const tashkeelRows = Array.from({ length: 8 }, (_v, i) => `ayah-${i} ${word}`);
		const component = new RawLinesComponent(tashkeelRows);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);

			// 8 content rows at height 5 → 3 rows pushed into scrollback.
			const buffer = term.getScrollBuffer().map(row => row.trimEnd());
			expect(buffer.length).toBe(tashkeelRows.length);
			for (let i = 0; i < tashkeelRows.length; i++) {
				expect(buffer[i]).toBe(tashkeelRows[i]);
			}
		} finally {
			tui.stop();
		}
	});
});
