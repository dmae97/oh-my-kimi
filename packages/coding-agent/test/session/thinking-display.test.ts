import { describe, expect, it } from "bun:test";
import { canonicalizeMessage } from "@oh-my-pi/pi-coding-agent/utils/thinking-display";

describe("canonicalizeMessage", () => {
	it("returns empty string for undefined, empty, or whitespace-only", () => {
		expect(canonicalizeMessage(undefined)).toBe("");
		expect(canonicalizeMessage("")).toBe("");
		expect(canonicalizeMessage("   ")).toBe("");
		expect(canonicalizeMessage("\n\n")).toBe("");
	});

	it("returns empty string for dot-only content", () => {
		expect(canonicalizeMessage(".")).toBe("");
		expect(canonicalizeMessage("...")).toBe("");
		expect(canonicalizeMessage(" . ")).toBe("");
		expect(canonicalizeMessage("\n.")).toBe("");
		expect(canonicalizeMessage("…")).toBe("");
	});

	it("returns normal canonical content for actual prose", () => {
		expect(canonicalizeMessage("hello")).toBe("hello");
		expect(canonicalizeMessage("hello.")).toBe("hello.");
		expect(canonicalizeMessage(". hello .")).toBe(". hello .");
		expect(canonicalizeMessage("a")).toBe("a");
	});
});
