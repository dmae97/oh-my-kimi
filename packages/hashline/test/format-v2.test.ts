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

	it("treats an empty replace hunk as a delete and still rejects empty inserts", () => {
		const text = "a\nb\nc";
		expect(applyPatch(text, "replace 2..2:")).toBe("a\nc");
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

	it("strips read-output line number prefix from auto-piped bare body rows", () => {
		const text = "a\nb\nc";
		// Without this fix, "3:text" becomes literal "3:text" in the file.
		// With the fix, the "3:" prefix is stripped, yielding just "text".
		const { edits, warnings } = parsePatch("replace 2..2:\n3:replaced");
		expect(applyEdits(text, edits).text).toBe("a\nreplaced\nc");
		expect(warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("validates insert anchors against file bounds", () => {
		const edits = parsePatch("insert before 4:\n+x").edits;
		expect(() => applyEdits("a\nb", edits)).toThrow(/Line 4 does not exist/);
	});

	it("rejects deleting the trailing blank sentinel of a newline-terminated file", () => {
		// "a\nb\n" splits into ["a", "b", ""]; line 3 is the phantom sentinel.
		const edits = parsePatch("delete 3").edits;
		expect(() => applyEdits("a\nb\n", edits)).toThrow(/trailing blank sentinel/);
	});

	it("rejects a replace range that spans the trailing blank sentinel", () => {
		const edits = parsePatch("replace 2..3:\n+B").edits;
		expect(() => applyEdits("a\nb\n", edits)).toThrow(/trailing blank sentinel/);
	});

	it("still allows inserts anchored on the trailing blank sentinel", () => {
		const edits = parsePatch("insert after 3:\n+tail").edits;
		expect(applyEdits("a\nb\n", edits).text).toBe("a\nb\n\ntail");
	});

	it("still deletes a genuine empty last line of a non-newline-terminated file", () => {
		// "a\nb" has no sentinel; line 2 is real content.
		const edits = parsePatch("delete 2").edits;
		expect(applyEdits("a\nb", edits).text).toBe("a");
	});

	it("does not flush a trailing streaming pending empty replace hunk", () => {
		const result = parsePatchStreaming("replace 5..5:\n");
		expect(result.edits).toEqual([]);
	});

	it("flushes a streaming empty replace hunk when another hunk starts", () => {
		const result = parsePatchStreaming("replace 2..2:\ninsert tail:\n");
		expect(result.edits).toEqual([{ kind: "delete", anchor: { line: 2 }, lineNum: 1, index: 0 }]);
	});
});
