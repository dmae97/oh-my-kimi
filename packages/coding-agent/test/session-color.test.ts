import { describe, expect, it } from "bun:test";
import { getSessionAccentHex } from "../src/utils/session-color";
import { formatSessionTerminalTitle } from "../src/utils/title-generator";

describe("getSessionAccentHex", () => {
	it("returns a stable hex for the same name", () => {
		expect(getSessionAccentHex("Named session")).toBe(getSessionAccentHex("Named session"));
	});
});

describe("formatSessionTerminalTitle", () => {
	it("uses the session name when present", () => {
		expect(formatSessionTerminalTitle("Manual title", "/work/pi")).toBe("π: Manual title");
	});

	it("falls back to the cwd basename when the session name is missing", () => {
		expect(formatSessionTerminalTitle(undefined, "/work/pi")).toBe("π: pi");
	});
});
