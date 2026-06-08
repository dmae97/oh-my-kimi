import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as settingsModule from "@oh-my-pi/pi-coding-agent/config/settings";
import { type ShimmerPalette, shimmerText } from "@oh-my-pi/pi-coding-agent/modes/theme/shimmer";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

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
 * Index of the first visible cell painted with the crest (high, code 33) color,
 * or undefined when the band sits in the padding and no cell is lit. Walks the
 * coalesced `ESC[<code>m<chars>` runs that {@link shimmerText} emits.
 */
function crestStart(rendered: string): number | undefined {
	const run = /\x1b\[(\d+)m([^\x1b]*)/g;
	let idx = 0;
	let m: RegExpExecArray | null = run.exec(rendered);
	while (m !== null) {
		const len = [...m[2]].length;
		if (m[1] === "33" && len > 0) return idx;
		idx += len;
		m = run.exec(rendered);
	}
	return undefined;
}

describe("shimmerText", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses a supplied raw ANSI color for the shimmer crest", () => {
		vi.spyOn(settingsModule, "isSettingsInitialized").mockReturnValue(false);
		// t chosen so the fixed-velocity band (30 cells/s) crest sits on the char:
		// pos = (333/1000)*30 ≈ 10 = CLASSIC_PADDING, i.e. centered on index 0.
		vi.spyOn(Date, "now").mockReturnValue(333);

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

describe("shimmer band velocity", () => {
	const FRAME_MS = 1000 / 30;
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

	function crestTrack(length: number, startMs: number, frames: number): (number | undefined)[] {
		const text = "x".repeat(length);
		const out: (number | undefined)[] = [];
		for (let i = 0; i < frames; i++) {
			nowMs = startMs + i * FRAME_MS;
			out.push(crestStart(shimmerText(text, testTheme, probe)));
		}
		return out;
	}

	it("advances the crest by at most one cell per 30fps frame", () => {
		// L=40 → period 60 cells; at 30 cells/s that is a 2s sweep (60 frames).
		// 75 frames covers a full sweep plus the padding gap into the next one.
		const track = crestTrack(40, 0, 75);
		let compared = 0;
		for (let i = 1; i < track.length; i++) {
			const a = track[i - 1];
			const b = track[i];
			if (a === undefined || b === undefined) continue; // skip the padding gap
			expect(Math.abs(b - a)).toBeLessThanOrEqual(1);
			compared++;
		}
		// Fail loudly rather than vacuously pass if the crest were never detected.
		expect(compared).toBeGreaterThan(20);
	});

	it("moves the crest at a length-independent speed", () => {
		// Starting where the crest enters at index 0 (pos = CLASSIC_PADDING = 10),
		// the crest must travel the same number of cells over a fixed wall-clock
		// window regardless of string length — the contract of fixed-velocity
		// sweeping (a longer message must not shimmer faster).
		const startMs = (10 / 30) * 1000; // pos = 10 cells → crest at index 0
		const span = (track: (number | undefined)[]): number => {
			const def = track.filter((v): v is number => v !== undefined);
			return def.length ? def[def.length - 1] - def[0] : 0;
		};
		const shortSpan = span(crestTrack(20, startMs, 10));
		const longSpan = span(crestTrack(60, startMs, 10));
		expect(shortSpan).toBeGreaterThan(0);
		expect(Math.abs(shortSpan - longSpan)).toBeLessThanOrEqual(1);
	});
});
