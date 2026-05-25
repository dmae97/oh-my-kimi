import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Theme } from "../src/modes/theme/theme";
import { renderAsciiBar } from "../src/slash-commands/helpers/format";

const testTheme = {
	fg(color: Parameters<Theme["fg"]>[0], text: string): string {
		const codes = {
			accent: "\x1b[36m",
			dim: "\x1b[2m",
			muted: "\x1b[90m",
		};
		return `${codes[color as "accent" | "dim" | "muted"] ?? ""}${text}\x1b[39m`;
	},
	bold(text: string): string {
		return `\x1b[1m${text}\x1b[22m`;
	},
	getFgAnsi(color: Parameters<Theme["fg"]>[0]): string {
		const codes = {
			accent: "\x1b[36m",
			dim: "\x1b[2m",
			muted: "\x1b[90m",
		};
		return codes[color as "accent" | "dim" | "muted"] ?? "";
	},
};

describe("renderAsciiBar", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves the visible progress-bar contract", () => {
		vi.spyOn(Date, "now").mockReturnValue(834);

		const rendered = renderAsciiBar(0.5, 4, testTheme);

		expect(Bun.stripANSI(rendered)).toBe("[██░░] 50%");
	});

	it("colors the shimmer band with the theme accent", () => {
		vi.spyOn(Date, "now").mockReturnValue(834);

		const rendered = renderAsciiBar(undefined, 4, testTheme);

		expect(rendered).toContain("\x1b[36m");
		expect(Bun.stripANSI(rendered)).toBe("[····]");
	});
});
