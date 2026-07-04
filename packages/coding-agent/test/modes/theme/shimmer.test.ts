import { afterEach, describe, expect, it, vi } from "bun:test";
import * as settingsModule from "@oh-my-pi/pi-coding-agent/config/settings";
import { shimmerText } from "@oh-my-pi/pi-coding-agent/modes/theme/shimmer";
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

	it("shimmers a mixed BMP + surrogate-pair message correctly (issue #4353 refactor)", () => {
		// #4353 replaced `Array.from(seg.text)` with in-place UTF-16 iteration to
		// drop the per-frame allocation that dominated the shimmer render cost.
		// A surrogate-pair emoji must still count as one code point (the band
		// index) and stay atomic in the output — an off-by-one would either
		// double-count the pair (mispositioning the band) or emit one lone
		// high-surrogate byte inside an ANSI run.
		vi.spyOn(settingsModule, "isSettingsInitialized").mockReturnValue(false);
		vi.spyOn(Date, "now").mockReturnValue(0);

		const rendered = shimmerText("a😀b", testTheme);
		// Strip ANSI: the visible payload must be the exact input, preserving the
		// surrogate pair intact.
		expect(Bun.stripANSI(rendered)).toBe("a😀b");
	});

	it("shimmers an all-emoji message without dropping any code point", () => {
		vi.spyOn(settingsModule, "isSettingsInitialized").mockReturnValue(false);
		vi.spyOn(Date, "now").mockReturnValue(0);

		const rendered = shimmerText("🎉🌟✨🚀", testTheme);
		expect(Bun.stripANSI(rendered)).toBe("🎉🌟✨🚀");
	});
});
