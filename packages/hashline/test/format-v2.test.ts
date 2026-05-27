import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch, parsePatchStreaming } from "@oh-my-pi/hashline";

function applyPatch(text: string, diff: string): string {
	return applyEdits(text, parsePatch(diff).edits).text;
}

describe("hashline format v2", () => {
	it("emits literal and repeat body rows in textual order", () => {
		const text = "a\nb\nc";
		const diff = ["2-2:", "+before", "^1-2", "+after"].join("\n");

		expect(applyPatch(text, diff)).toBe("a\nbefore\na\nb\nafter\nc");
	});

	it("repeats a single source line with explicit A-A syntax", () => {
		const text = "a\nb\nc";
		const diff = ["2-2:", "^3-3"].join("\n");

		expect(applyPatch(text, diff)).toBe("a\nc\nc");
	});

	it("keeps the file unchanged when a repeat covers the anchored range", () => {
		const text = "a\nb\nc\nd";
		const diff = ["2-3:", "^2-3"].join("\n");

		expect(applyPatch(text, diff)).toBe(text);
	});

	it("deletes a concrete range with inline delete", () => {
		const text = "a\nb\nc\nd";

		expect(applyPatch(text, "2-3:-")).toBe("a\nd");
	});

	it("rejects body rows after inline delete", () => {
		expect(() => parsePatch("2-2:-\n+x")).toThrow(/payload line has no preceding/);
	});

	it("treats an empty concrete block as a blank-line replacement", () => {
		const text = "a\nb\nc";

		expect(applyPatch(text, "2-2:")).toBe("a\n\nc");
	});

	it("treats empty BOF and EOF blocks as one blank-line insert", () => {
		const text = "a\nb";

		expect(applyPatch(text, "BOF:")).toBe("\na\nb");
		expect(applyPatch(text, "EOF:")).toBe("a\nb\n");
	});

	it("accepts `^A` repeat shorthand as `^A-A`", () => {
		const text = "a\nb\nc";
		// `^A` mirrors `^A-A`; we use it to keep line 2 unchanged while
		// also targeting it.
		expect(applyPatch(text, "2-2:\n^2")).toBe(text);
	});

	it("auto-pipes bare body rows (legacy sigils flow through as literal text)", () => {
		// `↑`/`↓` are no longer reserved sigils; bare body rows are
		// auto-prefixed with `|` as plain literal text.
		const text = "a\nb\nc";
		expect(applyPatch(text, "2-2:\n↑x")).toBe("a\n↑x\nc");
		expect(applyPatch(text, "2-2:\n↓x")).toBe("a\n↓x\nc");
		// And the warning is surfaced.
		const { warnings } = parsePatch("2-2:\n↑x");
		expect(warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("rejects removed standalone delete rows through the normal op diagnostic", () => {
		expect(() => parsePatch("-5")).toThrow(/unrecognized hashline block/);
		expect(() => parsePatch("-5..7")).toThrow(/unrecognized hashline block/);
	});

	it("validates repeat ranges against file bounds", () => {
		const edits = parsePatch("1-1:\n^4-4").edits;

		expect(() => applyEdits("a\nb", edits)).toThrow(/Line 4 does not exist/);
	});

	it("does not flush a streaming pending empty block", () => {
		const result = parsePatchStreaming("5-5:\n");

		expect(result.edits).toEqual([]);
	});
});
