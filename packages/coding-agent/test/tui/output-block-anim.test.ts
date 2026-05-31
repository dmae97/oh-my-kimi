import { afterEach, describe, expect, it, vi } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { borderSegmentHead, renderOutputBlock } from "@oh-my-pi/pi-coding-agent/tui";

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

	it("paints a dark traversing segment distinct from the accent border while running", async () => {
		const theme = (await getThemeByName("dark"))!;
		const accent = theme.getFgAnsi("accent");
		// Pin the clock so the segment head sits at perimeter index 0 (top-left).
		vi.spyOn(Date, "now").mockReturnValue(0);

		const lines = renderOutputBlock(
			{ state: "running", sections: [{ lines: ["hello"] }], width: 30, animate: true },
			theme,
		);
		const [topLine, contentLine] = lines;

		// The top edge carries the base accent plus a second (segment) color.
		const topColors = new Set(fgEscapes(topLine!));
		expect(topColors.has(accent)).toBe(true);
		const segColor = [...topColors].find(c => c !== accent);
		expect(segColor).toBeDefined();

		// With the head at the top-left, the segment must not leak onto the side
		// borders of an interior row — only the outer edge animates.
		expect(contentLine).toContain(accent);
		expect(contentLine).not.toContain(segColor!);
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

describe("borderSegmentHead", () => {
	it("does not teleport when the box grows a row (no reset on new output/resize)", () => {
		// At a fixed instant, adding one content row (H+1, perimeter +2) must shift
		// the head by at most a couple of cells — the bug was a modulo remap that
		// flung the segment across the border whenever new data arrived.
		const W = 20;
		const now = 1830; // arbitrary mid-lap instant
		for (let H = 4; H < 12; H++) {
			const a = borderSegmentHead(W, H, now);
			const b = borderSegmentHead(W, H + 1, now);
			expect(Math.abs(b - a)).toBeLessThanOrEqual(2);
		}
	});

	it("moves non-linearly — slower at corners than mid-edge", () => {
		const W = 20;
		const H = 6;
		const P = 2 * W + 2 * H - 4;
		const steps: number[] = [];
		let prev = borderSegmentHead(W, H, 0);
		for (let ms = 80; ms <= 4000; ms += 80) {
			const cur = borderSegmentHead(W, H, ms);
			const d = (((cur - prev) % P) + P) % P;
			steps.push(d);
			prev = cur;
		}
		// A linear sweep would land on one constant step; easing yields a spread
		// (near-stationary frames at corners, faster frames mid-edge).
		expect(Math.min(...steps)).toBeLessThan(Math.max(...steps));
		expect(Math.min(...steps)).toBe(0);
		// One eased lap covers the whole perimeter exactly once.
		expect(steps.reduce((a, b) => a + b, 0)).toBe(P);
	});

	it("starts at the top-left corner at lap origin", () => {
		expect(borderSegmentHead(20, 6, 0)).toBe(0);
	});
});
