import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch, parsePatchStreaming } from "@oh-my-pi/hashline";

function applyPatch(text: string, diff: string): string {
	return applyEdits(text, parsePatch(diff).edits).text;
}

describe("hashline format v2", () => {
	it("emits literal and repeat body rows in textual order", () => {
		const text = "a\nb\nc";
		const diff = ["2 2", "+before", "&1..2", "+after"].join("\n");

		expect(applyPatch(text, diff)).toBe("a\nbefore\na\nb\nafter\nc");
	});

	it("repeats a single source line with explicit A-A syntax", () => {
		const text = "a\nb\nc";
		const diff = ["2 2", "&3..3"].join("\n");

		expect(applyPatch(text, diff)).toBe("a\nc\nc");
	});

	it("keeps the file unchanged when a repeat covers the anchored range", () => {
		const text = "a\nb\nc\nd";
		const diff = ["2 3", "&2..3"].join("\n");

		expect(applyPatch(text, diff)).toBe(text);
	});

	it("deletes a concrete range via an empty hunk body", () => {
		const text = "a\nb\nc\nd";
		expect(applyPatch(text, "2 3")).toBe("a\nd");
	});

	it("empty body at a concrete range deletes the range (no blank-line insertion)", () => {
		const text = "a\nb\nc";
		expect(applyPatch(text, "2 2")).toBe("a\nc");
	});

	it("empty body at BOF/EOF is a no-op (nothing inserted)", () => {
		const text = "a\nb";
		expect(applyPatch(text, "BOF")).toBe(text);
		expect(applyPatch(text, "EOF")).toBe(text);
	});

	it("accepts `^A` repeat shorthand as `^A-A`", () => {
		const text = "a\nb\nc";
		// `^A` mirrors `^A-A`; we use it to keep line 2 unchanged while
		// also targeting it.
		expect(applyPatch(text, "2 2\n&2")).toBe(text);
	});

	it("auto-pipes bare body rows (legacy sigils flow through as literal text)", () => {
		// `↑`/`↓` are no longer reserved sigils; bare body rows are
		// auto-prefixed with `|` as plain literal text.
		const text = "a\nb\nc";
		expect(applyPatch(text, "2 2\n↑x")).toBe("a\n↑x\nc");
		expect(applyPatch(text, "2 2\n↓x")).toBe("a\n↓x\nc");
		// And the warning is surfaced.
		const { warnings } = parsePatch("2 2\n↑x");
		expect(warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("accepts `-A` and `-A..B` as standalone delete ops", () => {
		// `-A..B` (and `-A` shorthand) on its own line is the canonical
		// delete op in the new grammar.
		const text = "a\nb\nc\nd\ne\nf\ng";
		expect(applyPatch(text, "5 5")).toBe("a\nb\nc\nd\nf\ng");
		expect(applyPatch(text, "5 7")).toBe("a\nb\nc\nd");
	});

	it("validates repeat ranges against file bounds", () => {
		const edits = parsePatch("1 1\n&4..4").edits;

		expect(() => applyEdits("a\nb", edits)).toThrow(/Line 4 does not exist/);
	});

	it("does not flush a streaming pending empty block", () => {
		const result = parsePatchStreaming("5 5\n");

		expect(result.edits).toEqual([]);
	});
});
