import { describe, expect, it } from "bun:test";
import { getSessionAccentHex } from "../src/utils/session-color";

function luminance(hex: string): number {
	const r = parseInt(hex.slice(1, 3), 16) / 255;
	const g = parseInt(hex.slice(3, 5), 16) / 255;
	const b = parseInt(hex.slice(5, 7), 16) / 255;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: number, b: number): number {
	const hi = Math.max(a, b);
	const lo = Math.min(a, b);
	return (hi + 0.05) / (lo + 0.05);
}

// catppuccin Latte "crust" = statusLineBg the session title renders on.
const LIGHT_STATUSLINE_BG = luminance("#dce0e8");
const LIGHT_LUMINANCE_CAP = 0.205; // generator caps at 0.2; small epsilon for the bisection.

const names = Array.from({ length: 600 }, (_, i) => `analyze-debian-trixie-${i}`);

describe("getSessionAccentHex", () => {
	it("is deterministic per name and mode", () => {
		expect(getSessionAccentHex("analyze debian trixie")).toBe(getSessionAccentHex("analyze debian trixie"));
		expect(getSessionAccentHex("analyze debian trixie", true)).toBe(
			getSessionAccentHex("analyze debian trixie", true),
		);
	});

	it("keeps vivid (bright) accents on dark themes", () => {
		const maxDark = Math.max(...names.map(n => luminance(getSessionAccentHex(n, false))));
		expect(maxDark).toBeGreaterThan(0.5);
	});

	it("caps perceived luminance on light themes so no hue washes out (incl. yellow)", () => {
		for (const name of names) {
			const hex = getSessionAccentHex(name, true);
			expect(luminance(hex)).toBeLessThanOrEqual(LIGHT_LUMINANCE_CAP);
			// Readable against a light statusline background (>= AA large-text 3:1).
			expect(contrast(luminance(hex), LIGHT_STATUSLINE_BG)).toBeGreaterThanOrEqual(3);
		}
	});

	it("never produces a lighter accent on light themes than on dark for the same name", () => {
		for (const name of names) {
			expect(luminance(getSessionAccentHex(name, true))).toBeLessThanOrEqual(
				luminance(getSessionAccentHex(name, false)) + 1e-9,
			);
		}
	});
});
