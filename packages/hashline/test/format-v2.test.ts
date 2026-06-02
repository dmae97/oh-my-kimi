import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch, parsePatchStreaming } from "@oh-my-pi/hashline";

function applyPatch(text: string, diff: string): string {
	return applyEdits(text, parsePatch(diff).edits).text;
}

describe("hashline format v4", () => {
	it("replaces a concrete range with literal body rows in textual order", () => {
		const text = "a\nb\nc";
		const diff = ["replace 2..2:", "+before", "+after"].join("\n");

		expect(applyPatch(text, diff)).toBe("a\nbefore\nafter\nc");
	});

	it("deletes a single source line", () => {
		const text = "a\nb\nc";
		expect(applyPatch(text, "delete 2")).toBe("a\nc");
	});

	it("deletes a concrete range", () => {
		const text = "a\nb\nc\nd";
		expect(applyPatch(text, "delete 2..3")).toBe("a\nd");
	});

	it("inserts before and after concrete anchors", () => {
		const text = "a\nb\nc";
		const diff = ["insert before 2:", "+before", "insert after 2:", "+after"].join("\n");
		expect(applyPatch(text, diff)).toBe("a\nbefore\nb\nafter\nc");
	});

	it("inserts at head and tail", () => {
		const text = "a\nb";
		expect(applyPatch(text, "insert head:\n+HEAD")).toBe("HEAD\na\nb");
		expect(applyPatch(text, "insert tail:\n+TAIL")).toBe("a\nb\nTAIL");
	});

	it("rejects empty body-bearing hunks", () => {
		expect(() => parsePatch("replace 2..2:")).toThrow(/needs at least one/);
		expect(() => parsePatch("insert head:")).toThrow(/needs at least one/);
	});

	it("rejects body rows under delete", () => {
		expect(() => parsePatch("delete 2\n+replacement")).toThrow(/does not take body rows/);
	});

	it("auto-pipes bare body rows as literal text", () => {
		const text = "a\nb\nc";
		expect(applyPatch(text, "replace 2..2:\nraw")).toBe("a\nraw\nc");
		const { warnings } = parsePatch("replace 2..2:\nraw");
		expect(warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("validates insert anchors against file bounds", () => {
		const edits = parsePatch("insert before 4:\n+x").edits;
		expect(() => applyEdits("a\nb", edits)).toThrow(/Line 4 does not exist/);
	});

	it("does not flush a streaming pending empty replace block", () => {
		const result = parsePatchStreaming("replace 5..5:\n");
		expect(result.edits).toEqual([]);
	});
});
