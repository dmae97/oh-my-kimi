import { describe, expect, it } from "bun:test";
import { getSessionAccentHex } from "@oh-my-pi/pi-coding-agent/utils/session-color";
import { relativeLuminance } from "@oh-my-pi/pi-utils";

const lum = (hex: string): number => relativeLuminance(hex) ?? 0;
const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

const names = Array.from({ length: 600 }, (_, i) => `analyze-debian-trixie-${i}`);

// Shipped light statusLineBg surfaces (WCAG luminance), near-white through mid-light.
const SURFACES: Record<string, number> = {
	"light-catppuccin crust (#dce0e8)": lum("#dce0e8"),
	"light-poimandres (#7390aa)": lum("#7390aa"),
};

describe("getSessionAccentHex", () => {
	it("is deterministic per name and surface", () => {
		expect(getSessionAccentHex("analyze debian trixie")).toBe(getSessionAccentHex("analyze debian trixie"));
		expect(getSessionAccentHex("x", 0.7)).toBe(getSessionAccentHex("x", 0.7));
	});

	it("keeps vivid (bright) accents on dark themes (undefined surface)", () => {
		const maxDark = Math.max(...names.map(n => lum(getSessionAccentHex(n))));
		expect(maxDark).toBeGreaterThan(0.5);
	});

	it("clears AA-large WCAG contrast against light surfaces, including mid-light", () => {
		for (const bg of Object.values(SURFACES)) {
			for (const name of names) {
				const hex = getSessionAccentHex(name, bg);
				expect(contrast(lum(hex), bg)).toBeGreaterThanOrEqual(2.99); // ~3:1, float margin
			}
		}
	});

	it("never produces a lighter accent on light themes than on dark for the same name", () => {
		const nearWhite = SURFACES["light-catppuccin crust (#dce0e8)"];
		for (const name of names) {
			expect(lum(getSessionAccentHex(name, nearWhite))).toBeLessThanOrEqual(lum(getSessionAccentHex(name)) + 1e-9);
		}
	});
});
