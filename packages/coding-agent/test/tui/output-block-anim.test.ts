import { afterEach, describe, expect, it, vi } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { borderSegmentHeadCol, renderOutputBlock } from "@oh-my-pi/pi-coding-agent/tui";

// Matches both truecolor (38;2;r;g;b) and 256-color (38;5;n) foreground escapes
// so the assertions hold regardless of the detected terminal color mode.
const FG = /\x1b\[38;(?:2;\d+;\d+;\d+|5;\d+)m/g;

function fgEscapes(text: string): string[] {
	return text.match(FG) ?? [];
}

describe("renderOutputBlock animated border", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("paints a dark traversing segment on the bottom edge distinct from the accent border", async () => {
		const theme = (await getThemeByName("dark"))!;
		const accent = theme.getFgAnsi("accent");
		// Pin the clock so the segment sits at the left wall of the bottom edge.
		vi.spyOn(Date, "now").mockReturnValue(0);

		const lines = renderOutputBlock(
			{ state: "running", sections: [{ lines: ["hello"] }], width: 30, animate: true },
			theme,
		);
		const topLine = lines[0]!;
		const bottomLine = lines[lines.length - 1]!;

		// The bottom edge carries the base accent plus a second (segment) color.
		const bottomColors = new Set(fgEscapes(bottomLine));
		expect(bottomColors.has(accent)).toBe(true);
		const segColor = [...bottomColors].find(c => c !== accent);
		expect(segColor).toBeDefined();

		// Only the bottom edge animates — the top edge and interior rows stay accent.
		expect(topLine).toContain(accent);
		expect(topLine).not.toContain(segColor!);
		for (const line of lines.slice(1, -1)) {
			expect(line).not.toContain(segColor!);
		}
	});

	it("keeps the border a single accent color when animation is off", async () => {
		const theme = (await getThemeByName("dark"))!;
		const accent = theme.getFgAnsi("accent");
		const lines = renderOutputBlock(
			{ state: "running", sections: [{ lines: ["hello"] }], width: 30, animate: false },
			theme,
		);
		expect(new Set(fgEscapes(lines[0]!))).toEqual(new Set([accent]));
	});

	it("ignores animation for terminal (non-pending) states", async () => {
		const theme = (await getThemeByName("dark"))!;
		vi.spyOn(Date, "now").mockReturnValue(0);
		const animated = renderOutputBlock(
			{ state: "success", sections: [{ lines: ["hello"] }], width: 30, animate: true },
			theme,
		).join("\n");
		const plain = renderOutputBlock(
			{ state: "success", sections: [{ lines: ["hello"] }], width: 30, animate: false },
			theme,
		).join("\n");
		expect(animated).toBe(plain);
	});
});

describe("borderSegmentHeadCol", () => {
	it("does not teleport when the box grows a column (smooth on resize)", () => {
		// At a fixed instant, widening by one column must nudge the center by at
		// most one cell — position is derived from the clock, not remapped.
		const now = 1830; // arbitrary mid-cycle instant
		for (let W = 10; W < 40; W++) {
			const a = borderSegmentHeadCol(W, now);
			const b = borderSegmentHeadCol(W + 1, now);
			expect(Math.abs(b - a)).toBeLessThanOrEqual(1);
		}
	});

	it("bounces the full width and eases at each wall", () => {
		const W = 30;
		const centers: number[] = [];
		// 6000ms spans at least one full there-and-back bounce.
		for (let ms = 0; ms <= 6000; ms += 50) centers.push(borderSegmentHeadCol(W, ms));
		// Sweeps the whole bottom edge: reaches both walls.
		expect(Math.min(...centers)).toBeLessThan(1);
		expect(Math.max(...centers)).toBeGreaterThan(W - 2);
		// Eased: per-step speed varies (near-stationary at the walls, faster mid-sweep).
		const steps: number[] = [];
		for (let i = 1; i < centers.length; i++) steps.push(Math.abs(centers[i]! - centers[i - 1]!));
		expect(Math.min(...steps)).toBeLessThan(Math.max(...steps));
	});

	it("starts at the left wall at cycle origin", () => {
		expect(borderSegmentHeadCol(20, 0)).toBe(0);
	});
});
