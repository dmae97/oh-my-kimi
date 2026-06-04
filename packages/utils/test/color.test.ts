import { describe, expect, it } from "bun:test";
import { colorLuma, hslToHex, relativeLuminance } from "../src/color";

describe("relativeLuminance (WCAG, linearized sRGB)", () => {
	it("hits the extremes", () => {
		expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
		expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
	});

	it("linearizes — mid-gray is WCAG-dark (~0.21), not 0.5", () => {
		// #808080 is perceptually mid (luma ~0.5) but WCAG-dark once linearized.
		expect(relativeLuminance("#808080") ?? 1).toBeLessThan(0.25);
		expect(colorLuma("#808080") ?? 0).toBeGreaterThan(0.45);
	});

	it("accepts #rgb shorthand and palette indices", () => {
		expect(relativeLuminance("#fff")).toBe(relativeLuminance("#ffffff"));
		expect(relativeLuminance(15)).toBeGreaterThan(0.9); // white
		expect(relativeLuminance(0)).toBeCloseTo(0, 5); // black
	});

	it("returns undefined for malformed / var-ref input", () => {
		expect(relativeLuminance("primary")).toBeUndefined();
		expect(relativeLuminance("#ff")).toBeUndefined();
		expect(relativeLuminance(256)).toBeUndefined();
	});
});

describe("colorLuma (perceptual classification)", () => {
	it("parses hex, shorthand, and palette indices", () => {
		expect(colorLuma("#000000")).toBeCloseTo(0, 5);
		expect(colorLuma("#ffffff")).toBeCloseTo(1, 5);
		expect(colorLuma("#fff")).toBe(colorLuma("#ffffff"));
		expect(colorLuma(15)).toBeGreaterThan(0.9);
	});

	it("returns undefined for malformed input", () => {
		expect(colorLuma("nope")).toBeUndefined();
		expect(colorLuma(-1)).toBeUndefined();
	});
});

describe("hslToHex", () => {
	it("maps primary hues at full saturation/half lightness", () => {
		expect(hslToHex(0, 1, 0.5)).toBe("#ff0000");
		expect(hslToHex(120, 1, 0.5)).toBe("#00ff00");
		expect(hslToHex(240, 1, 0.5)).toBe("#0000ff");
	});

	it("collapses to grayscale at zero saturation", () => {
		expect(hslToHex(0, 0, 0)).toBe("#000000");
		expect(hslToHex(210, 0, 1)).toBe("#ffffff");
	});
});
