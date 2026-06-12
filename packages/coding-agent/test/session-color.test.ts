import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

import { getSessionAccentHex } from "@oh-my-pi/pi-coding-agent/utils/session-color";
import { hexToHsv, relativeLuminance } from "@oh-my-pi/pi-utils";

const NO_THEME_COLORS: string[] = [];

const lum = (hex: string): number => relativeLuminance(hex) ?? 0;
const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const saturatedThemeHues = (colors: string[]): number[] => {
	const hues: number[] = [];
	for (const color of colors) {
		const { h, s } = hexToHsv(color);
		if (s >= 0.1) hues.push(h);
	}
	return hues;
};

const names = Array.from({ length: 600 }, (_, i) => `analyze-debian-trixie-${i}`);

const SURFACES: Record<string, number> = {
	"light-catppuccin crust (#dce0e8)": lum("#dce0e8"),
	"light-poimandres (#7390aa)": lum("#7390aa"),
};

describe("getSessionAccentHex", () => {
	it("is deterministic per name and parameters", () => {
		expect(getSessionAccentHex("analyze debian trixie", NO_THEME_COLORS)).toBe(
			getSessionAccentHex("analyze debian trixie", NO_THEME_COLORS),
		);
		expect(getSessionAccentHex("x", NO_THEME_COLORS, 0.7)).toBe(getSessionAccentHex("x", NO_THEME_COLORS, 0.7));
	});

	it("uses warm hues (0-120) on dark themes", () => {
		for (const name of names) {
			const h = hexToHsv(getSessionAccentHex(name, NO_THEME_COLORS)).h;
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThanOrEqual(120);
		}
	});

	it("uses cool hues (180-300) on light themes", () => {
		for (const name of names) {
			const h = hexToHsv(getSessionAccentHex(name, NO_THEME_COLORS, 0.5)).h;
			expect(h).toBeGreaterThanOrEqual(180);
			expect(h).toBeLessThanOrEqual(300);
		}
	});

	it("keeps vivid (bright) accents on dark themes (undefined surface)", () => {
		const maxDark = Math.max(...names.map(n => lum(getSessionAccentHex(n, NO_THEME_COLORS))));
		expect(maxDark).toBeGreaterThan(0.5);
	});

	it("clears AA-large WCAG contrast against light surfaces, including mid-light", () => {
		for (const bg of Object.values(SURFACES)) {
			for (const name of names) {
				const hex = getSessionAccentHex(name, NO_THEME_COLORS, bg);
				expect(contrast(lum(hex), bg)).toBeGreaterThanOrEqual(2.99);
			}
		}
	});

	it("never produces a lighter accent on light themes than on dark for the same name", () => {
		const nearWhite = SURFACES["light-catppuccin crust (#dce0e8)"];
		for (const name of names) {
			expect(lum(getSessionAccentHex(name, NO_THEME_COLORS, nearWhite))).toBeLessThanOrEqual(
				lum(getSessionAccentHex(name, NO_THEME_COLORS)) + 1e-9,
			);
		}
	});
});

describe("getSessionAccentHex with real Theme", () => {
	it("stays in the cool band and avoids theme hues on light-catppuccin", async () => {
		const theme = await getThemeByName("light-catppuccin");
		if (!theme) return; // skip if theme not found
		const colors = theme.getMajorThemeColorHexes();
		const surface = theme.accentSurfaceLuminance;
		const themeHues = saturatedThemeHues(colors);

		for (const name of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]) {
			const hex = getSessionAccentHex(name, colors, surface);
			const h = hexToHsv(hex).h;
			expect(h).toBeGreaterThanOrEqual(180);
			expect(h).toBeLessThanOrEqual(300);
			for (const th of themeHues) {
				const dist = Math.min(Math.abs(h - th), 360 - Math.abs(h - th));
				expect(dist).toBeGreaterThanOrEqual(10);
			}
		}
	});

	it("stays in the warm band and avoids theme hues on dark-catppuccin", async () => {
		const theme = await getThemeByName("dark-catppuccin");
		if (!theme) return;
		const colors = theme.getMajorThemeColorHexes();
		const themeHues = saturatedThemeHues(colors);

		for (const name of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]) {
			const hex = getSessionAccentHex(name, colors);
			const h = hexToHsv(hex).h;
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThanOrEqual(120);
			for (const th of themeHues) {
				const dist = Math.min(Math.abs(h - th), 360 - Math.abs(h - th));
				expect(dist).toBeGreaterThanOrEqual(10);
			}
		}
	});
});
