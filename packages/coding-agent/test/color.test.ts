import { describe, expect, it } from "bun:test";
import { colorLuminance, hexLuminance, paletteLuminance } from "../src/utils/color";

describe("hexLuminance", () => {
	it("parses #rrggbb at the extremes", () => {
		expect(hexLuminance("#000000")).toBeCloseTo(0, 5);
		expect(hexLuminance("#ffffff")).toBeCloseTo(1, 5);
	});

	it("parses #rgb shorthand identically to its expanded form", () => {
		expect(hexLuminance("#fff")).toBe(hexLuminance("#ffffff"));
		expect(hexLuminance("#000")).toBe(hexLuminance("#000000"));
		expect(hexLuminance("#abc")).toBe(hexLuminance("#aabbcc"));
	});

	it("returns undefined for malformed input", () => {
		expect(hexLuminance("fff")).toBeUndefined();
		expect(hexLuminance("#ff")).toBeUndefined();
		expect(hexLuminance("#gggggg")).toBeUndefined();
		expect(hexLuminance("")).toBeUndefined();
	});
});

describe("paletteLuminance", () => {
	it("classifies the 16 base ANSI colors", () => {
		expect(paletteLuminance(0)).toBeCloseTo(0, 5); // black
		expect(paletteLuminance(15)).toBeGreaterThan(0.9); // bright white
		expect(paletteLuminance(15)).toBeGreaterThan(0.5);
		expect((paletteLuminance(0) ?? 1) > 0.5).toBe(false);
	});

	it("classifies the 6x6x6 color cube", () => {
		expect(paletteLuminance(16)).toBeCloseTo(0, 5); // cube black
		expect(paletteLuminance(231)).toBeCloseTo(1, 5); // cube white
	});

	it("classifies the grayscale ramp", () => {
		expect(paletteLuminance(232)).toBeLessThan(0.1); // near-black
		expect(paletteLuminance(255)).toBeGreaterThan(0.9); // near-white
	});

	it("returns undefined out of range / non-integer", () => {
		expect(paletteLuminance(-1)).toBeUndefined();
		expect(paletteLuminance(256)).toBeUndefined();
		expect(paletteLuminance(1.5)).toBeUndefined();
	});
});

describe("colorLuminance", () => {
	it("dispatches on hex strings and palette indices", () => {
		expect(colorLuminance("#ffffff")).toBe(hexLuminance("#ffffff"));
		expect(colorLuminance(15)).toBe(paletteLuminance(15));
		expect(colorLuminance(undefined)).toBeUndefined();
		expect(colorLuminance("primary")).toBeUndefined(); // var ref, not a color
	});
});
