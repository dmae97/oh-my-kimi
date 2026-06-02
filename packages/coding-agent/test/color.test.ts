import { describe, expect, it } from "bun:test";
import { hexLuminance } from "../src/utils/color";

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
