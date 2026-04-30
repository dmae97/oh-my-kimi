import { describe, expect, it } from "bun:test";
import { getSessionAccentHex, getSessionAccentHexForTitle } from "../src/utils/session-color";
import { formatSessionTerminalTitle } from "../src/utils/title-generator";

describe("getSessionAccentHexForTitle", () => {
	it("ignores auto-generated titles", () => {
		expect(getSessionAccentHexForTitle("Auto title", "auto")).toBeUndefined();
	});

	it("keeps explicit and legacy titles color-stable", () => {
		const expected = getSessionAccentHex("Named session");

		expect(getSessionAccentHexForTitle("Named session", "user")).toBe(expected);
		expect(getSessionAccentHexForTitle("Named session", undefined)).toBe(expected);
	});
});

describe("formatSessionTerminalTitle", () => {
	it("falls back to cwd when the session title was auto-generated", () => {
		expect(formatSessionTerminalTitle("Auto title", "/work/pi", "auto")).toBe("π: pi");
	});

	it("shows explicit session renames in the terminal title", () => {
		expect(formatSessionTerminalTitle("Manual title", "/work/pi", "user")).toBe("π: Manual title");
	});
});
