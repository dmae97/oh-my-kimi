import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch, parsePatchStreaming } from "@oh-my-pi/hashline";

function applyPatch(text: string, diff: string): string {
	return applyEdits(text, parsePatch(diff).edits).text;
}

describe("hashline format v4", () => {
	it("replaces a concrete range with literal body rows in textual order", () => {
		const text = "a\nb\nc";
		const diff = ["XCHG 2..2:", "+before", "+after"].join("\n");

		expect(applyPatch(text, diff)).toBe("a\nbefore\nafter\nc");
	});

	it("deletes a single source line", () => {
		const text = "a\nb\nc";
		expect(applyPatch(text, "DEL 2")).toBe("a\nc");
	});

	it("deletes a concrete range", () => {
		const text = "a\nb\nc\nd";
		expect(applyPatch(text, "DEL 2..3")).toBe("a\nd");
	});

	it("inserts before and after concrete anchors", () => {
		const text = "a\nb\nc";
		const diff = ["INS.PRE 2:", "+before", "INS.POST 2:", "+after"].join("\n");
		expect(applyPatch(text, diff)).toBe("a\nbefore\nb\nafter\nc");
	});

	it("inserts at head and tail", () => {
		const text = "a\nb";
		expect(applyPatch(text, "INS.HEAD:\n+HEAD")).toBe("HEAD\na\nb");
		expect(applyPatch(text, "INS.TAIL:\n+TAIL")).toBe("a\nb\nTAIL");
	});

	it("treats an empty replace hunk as a delete and still rejects empty inserts", () => {
		const text = "a\nb\nc";
		expect(applyPatch(text, "XCHG 2..2:")).toBe("a\nc");
		expect(() => parsePatch("INS.HEAD:")).toThrow(/needs at least one/);
	});

	it("rejects body rows under delete", () => {
		expect(() => parsePatch("DEL 2\n+replacement")).toThrow(/does not take body rows/);
	});

	it("auto-pipes bare body rows as literal text", () => {
		const text = "a\nb\nc";
		expect(applyPatch(text, "XCHG 2..2:\nraw")).toBe("a\nraw\nc");
		const { warnings } = parsePatch("XCHG 2..2:\nraw");
		expect(warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("strips read-output line number prefix from auto-piped bare body rows", () => {
		const text = "a\nb\nc";
		// Without this fix, "3:text" becomes literal "3:text" in the file.
		// With the fix, the "3:" prefix is stripped, yielding just "text".
		const { edits, warnings } = parsePatch("XCHG 2..2:\n3:replaced");
		expect(applyEdits(text, edits).text).toBe("a\nreplaced\nc");
		expect(warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("validates insert anchors against file bounds", () => {
		const edits = parsePatch("INS.PRE 4:\n+x").edits;
		expect(() => applyEdits("a\nb", edits)).toThrow(/Line 4 does not exist/);
	});

	it("ignores deleting the trailing blank sentinel of a newline-terminated file", () => {
		// "a\nb\n" splits into ["a", "b", ""]; line 3 is the phantom sentinel.
		const edits = parsePatch("DEL 3").edits;
		expect(applyEdits("a\nb\n", edits).text).toBe("a\nb\n");
	});

	it("treats a delete range ending at the trailing sentinel as ending at the last real line", () => {
		const edits = parsePatch("DEL 2..3").edits;
		expect(applyEdits("a\nb\n", edits).text).toBe("a\n");
	});

	it("treats a replace range ending at the trailing sentinel as ending at the last real line", () => {
		const edits = parsePatch("XCHG 2..3:\n+B").edits;
		expect(applyEdits("a\nb\n", edits).text).toBe("a\nB\n");
	});

	it("still allows inserts anchored on the trailing blank sentinel", () => {
		const edits = parsePatch("INS.POST 3:\n+tail").edits;
		expect(applyEdits("a\nb\n", edits).text).toBe("a\nb\n\ntail");
	});

	it("still deletes a genuine empty last line of a non-newline-terminated file", () => {
		// "a\nb" has no sentinel; line 2 is real content.
		const edits = parsePatch("DEL 2").edits;
		expect(applyEdits("a\nb", edits).text).toBe("a");
	});

	it("does not flush a trailing streaming pending empty replace hunk", () => {
		const result = parsePatchStreaming("XCHG 5..5:\n");
		expect(result.edits).toEqual([]);
	});

	it("flushes a streaming empty replace hunk when another hunk starts", () => {
		const result = parsePatchStreaming("XCHG 2..2:\nINS.TAIL:\n");
		expect(result.edits).toEqual([{ kind: "delete", anchor: { line: 2 }, lineNum: 1, index: 0 }]);
	});
});
