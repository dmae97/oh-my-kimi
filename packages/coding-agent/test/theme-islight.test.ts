import { describe, expect, it } from "bun:test";
import {
	getResolvedThemeColors,
	getThemeByName,
	isLightTheme,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

describe("Theme.isLight", () => {
	it("classifies built-in themes by their status-line surface", async () => {
		// porcelain styles a dark chat bubble (userMessageBg) on an otherwise-light
		// theme with a light status line. Session accents render on the status line,
		// so it must read as light — classifying by userMessageBg got this wrong.
		expect((await getThemeByName("porcelain"))?.isLight).toBe(true);
		expect((await getThemeByName("light-catppuccin"))?.isLight).toBe(true);
		expect((await getThemeByName("dark-catppuccin"))?.isLight).toBe(false);
	});

	it("exposes the status-line surface luminance for accent sizing", async () => {
		const light = await getThemeByName("light-catppuccin");
		const dark = await getThemeByName("dark-catppuccin");
		// Light themes hand the real surface luminance to getSessionAccentHex...
		expect(light?.accentSurfaceLuminance).toBeGreaterThan(0.5);
		// ...dark themes pass undefined so accents stay vivid.
		expect(dark?.accentSurfaceLuminance).toBeUndefined();
	});
});

describe("isLightTheme (standalone)", () => {
	// Regression for #2516: the standalone helper used to classify on
	// userMessageBg, mismatching Theme.isLight (statusLineBg) and the HTML
	// export's defaultText. porcelain is the canonical mismatch (dark bubble,
	// light status line); sandstone/limestone exercise the custom-light path.
	it.each([
		["sandstone", true],
		["limestone", true],
		["porcelain", true],
		["light", true],
		["dark", false],
		["dark-catppuccin", false],
	])("classifies %s as isLight=%s", (name, expected) => {
		expect(isLightTheme(name)).toBe(expected);
	});
});

describe("getResolvedThemeColors HTML export defaults", () => {
	// Regression for #2516: empty color tokens fell back to #e5e5e7 (the
	// dark-theme grey) for every theme not literally named "light", making the
	// session transcript text illegible on every custom light theme.
	it("uses near-black for empty text tokens on light themes", async () => {
		const colors = await getResolvedThemeColors("sandstone");
		expect(colors.text).toBe("#000000");
		expect(colors.userMessageText).toBe("#000000");
		expect(colors.customMessageText).toBe("#000000");
		expect(colors.toolTitle).toBe("#000000");
	});

	it("uses light grey for empty text tokens on dark themes", async () => {
		const colors = await getResolvedThemeColors("dark");
		expect(colors.text).toBe("#e5e5e7");
		expect(colors.userMessageText).toBe("#e5e5e7");
	});
});
