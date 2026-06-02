import { describe, expect, it } from "bun:test";
import { getSessionAccentHex } from "../src/utils/session-color";

function luminance(hex: string): number {
	const r = parseInt(hex.slice(1, 3), 16) / 255;
	const g = parseInt(hex.slice(3, 5), 16) / 255;
	const b = parseInt(hex.slice(5, 7), 16) / 255;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: number, b: number): number {
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const names = Array.from({ length: 600 }, (_, i) => `analyze-debian-trixie-${i}`);

// Shipped light statusLineBg surfaces, near-white through mid-light.
const SURFACES: Record<string, number> = {
	"light-catppuccin crust (#dce0e8)": luminance("#dce0e8"),
	"light-poimandres (#7390aa)": luminance("#7390aa"),
};

describe("getSessionAccentHex", () => {
	it("is deterministic per name and surface", () => {
		expect(getSessionAccentHex("analyze debian trixie")).toBe(getSessionAccentHex("analyze debian trixie"));
		expect(getSessionAccentHex("x", 0.9)).toBe(getSessionAccentHex("x", 0.9));
	});

	it("keeps vivid (bright) accents on dark themes (undefined surface)", () => {
		const maxDark = Math.max(...names.map(n => luminance(getSessionAccentHex(n))));
		expect(maxDark).toBeGreaterThan(0.5);
	});

	it("clears AA-large contrast against light surfaces, including mid-light backgrounds", () => {
		for (const bg of Object.values(SURFACES)) {
			for (const name of names) {
				const hex = getSessionAccentHex(name, bg);
				expect(contrast(luminance(hex), bg)).toBeGreaterThanOrEqual(2.99); // ~3:1, float margin
			}
		}
	});

	it("never produces a lighter accent on light themes than on dark for the same name", () => {
		const nearWhite = SURFACES["light-catppuccin crust (#dce0e8)"];
		for (const name of names) {
			expect(luminance(getSessionAccentHex(name, nearWhite))).toBeLessThanOrEqual(
				luminance(getSessionAccentHex(name)) + 1e-9,
			);
		}
	});
});
