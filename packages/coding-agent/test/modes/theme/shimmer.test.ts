import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as settingsModule from "../../../src/config/settings";
import { type ShimmerPalette, shimmerText } from "../../../src/modes/theme/shimmer";
import type { Theme } from "../../../src/modes/theme/theme";

const testTheme = {
	bold(text: string): string {
		return `\x1b[1m${text}\x1b[22m`;
	},
	fg(color: Parameters<Theme["fg"]>[0], text: string): string {
		return `${this.getFgAnsi(color)}${text}\x1b[39m`;
	},
	getFgAnsi(color: Parameters<Theme["getFgAnsi"]>[0]): string {
		const codes = {
			accent: "\x1b[36m",
			dim: "\x1b[2m",
			muted: "\x1b[90m",
		};
		return codes[color as "accent" | "dim" | "muted"] ?? "";
	},
};

// Distinct, non-bold color per tier so each rendered cell is classifiable by the
// SGR code that precedes it (31=low, 32=mid, 33=high).
const probe: ShimmerPalette = {
	low: { ansi: "\x1b[31m" },
	mid: { ansi: "\x1b[32m" },
	high: { ansi: "\x1b[33m" },
};

/**
 * Visible cell indexes painted with the crest (high, code 33) color. Walks the
 * coalesced `ESC[<code>m<chars>` runs that {@link shimmerText} emits.
 */
function highIndices(rendered: string): number[] {
	const indices: number[] = [];
	const run = /\x1b\[(\d+)m([^\x1b]*)/g;
	let idx = 0;
	let m: RegExpExecArray | null = run.exec(rendered);
	while (m !== null) {
		const len = [...m[2]].length;
		if (m[1] === "33") {
			for (let i = 0; i < len; i++) indices.push(idx + i);
		}
		idx += len;
		m = run.exec(rendered);
	}
	return indices;
}

function crestCenter(rendered: string): number | undefined {
	const indices = highIndices(rendered);
	const first = indices[0];
	const last = indices[indices.length - 1];
	if (first === undefined || last === undefined) return undefined;
	return (first + last) / 2;
}

describe("shimmerText", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses a supplied raw ANSI color for the shimmer crest", () => {
		vi.spyOn(settingsModule, "isSettingsInitialized").mockReturnValue(false);
		// At the beginning of the shared sweep the crest is on the first cell.
		vi.spyOn(Date, "now").mockReturnValue(0);

		const rendered = shimmerText("x", testTheme, {
			low: "dim",
			mid: { ansi: "\x1b[38;2;12;34;56m" },
			high: { ansi: "\x1b[38;2;12;34;56m" },
			bold: true,
		});

		expect(rendered).toContain("\x1b[38;2;12;34;56m");
		expect(Bun.stripANSI(rendered)).toBe("x");
	});
});

describe("shimmer phase alignment", () => {
	const FRAME_MS = 1000 / 30;
	const SWEEP_MS = 2000;
	let nowMs = 0;

	beforeEach(() => {
		nowMs = 0;
		// Deterministic classic mode regardless of global settings state.
		vi.spyOn(settingsModule, "isSettingsInitialized").mockReturnValue(false);
		vi.spyOn(Date, "now").mockImplementation(() => nowMs);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function renderLength(length: number): string {
		return shimmerText("x".repeat(length), testTheme, probe);
	}

	it("starts every string at the first cell and lands at the last cell", () => {
		for (const length of [8, 40, 80]) {
			nowMs = 0;
			expect(highIndices(renderLength(length))).toContain(0);

			nowMs = SWEEP_MS - 1;
			expect(highIndices(renderLength(length))).toContain(length - 1);
		}
	});

	it("keeps the crest at the same normalized position across string lengths", () => {
		nowMs = 15 * FRAME_MS;
		const shortCenter = crestCenter(renderLength(20));
		const longCenter = crestCenter(renderLength(60));

		expect(shortCenter).toBeDefined();
		expect(longCenter).toBeDefined();
		const shortPhase = shortCenter! / (20 - 1);
		const longPhase = longCenter! / (60 - 1);

		expect(Math.abs(shortPhase - longPhase)).toBeLessThanOrEqual(0.02);
	});
});
