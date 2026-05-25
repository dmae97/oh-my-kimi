import { afterEach, describe, expect, it, vi } from "bun:test";
import { shimmerText } from "../../../src/modes/theme/shimmer";
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

describe("shimmerText", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses a supplied raw ANSI color for the shimmer crest", () => {
		vi.spyOn(Date, "now").mockReturnValue(667);

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
