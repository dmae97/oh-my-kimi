import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@oh-my-pi/hashline";

function applyPatch(text: string, diff: string): string {
	return applyEdits(text, parsePatch(diff).edits).text;
}

const FILE = "a\nb\nc\nd\ne";

describe("hashline core — hunk header forms", () => {
	it("rejects a bare single-number hunk header (single-line shorthand removed)", () => {
		expect(() => parsePatch("2\n+B")).toThrow(/single-number hunk header/);
	});

	it("an empty `A A` deletes the line", () => {
		expect(applyPatch(FILE, "2 2")).toBe("a\nc\nd\ne");
	});

	it("accepts hyphen as a range separator (`A-B`)", () => {
		// Models reflexively type `301-314` when copying a `read` range.
		expect(applyPatch(FILE, "2-3\n+X")).toBe("a\nX\nd\ne");
	});

	it("accepts `..` as a range separator (`A..B`)", () => {
		expect(applyPatch(FILE, "2..3\n+X")).toBe("a\nX\nd\ne");
	});

	it("accepts unicode ellipsis as a range separator (`A…B`)", () => {
		expect(applyPatch(FILE, "2\u20263\n+X")).toBe("a\nX\nd\ne");
	});

	it("tolerates whitespace around the separator (`A - B`)", () => {
		expect(applyPatch(FILE, "2 - 3\n+X")).toBe("a\nX\nd\ne");
	});

	it("rejects `LINE=content` rows pasted from old format as orphan payload", () => {
		expect(() => parsePatch("2=hello")).toThrow(/payload line has no preceding hunk header/);
	});

	it("auto-pipes mid-payload bare rows in a mixed block (was previously rejected)", () => {
		const result = parsePatch("2 2\n+first\n3=    ddd");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nfirst\n3=    ddd\nc\nd\ne");
		expect(result.warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});
});

describe("hashline leniency L2 — bare `^A` repeat shorthand", () => {
	it("treats `^A` as `^A-A`", () => {
		// `^2-2` keeps the original line 2 between the inserted rows.
		expect(applyPatch(FILE, "2 2\n+ABOVE\n&2\n+BELOW")).toBe("a\nABOVE\nb\nBELOW\nc\nd\ne");
	});

	it("auto-pipes `^A-` (malformed range) as literal text via L3", () => {
		// `^2-` is not a valid repeat row (missing end number). The
		// tokenizer classifies it as raw; L3's uniformly-bare auto-pipe
		// then folds it back into the block as a literal. The model sees
		// the warning and can re-issue with a well-formed repeat.
		const result = parsePatch("2 2\n&2-");
		expect(applyEdits(FILE, result.edits).text).toBe("a\n&2-\nc\nd\ne");
		expect(result.warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});
});

describe("hashline leniency L3 — auto-pipe uniformly bare bodies", () => {
	it("accepts a block whose body is uniformly unprefixed", () => {
		const result = parsePatch("2 2\n  hello\n  world");
		expect(applyEdits(FILE, result.edits).text).toBe("a\n  hello\n  world\nc\nd\ne");
		expect(result.warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("auto-pipes a bare row after a `+` row (was previously rejected)", () => {
		const result = parsePatch("2 2\n+first\nsecond");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nfirst\nsecond\nc\nd\ne");
		expect(result.warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("auto-pipes a bare row before a `+` row (was previously rejected)", () => {
		// `first` is buffered. When `+second` arrives, we auto-pipe both rows.
		const result = parsePatch("2 2\nfirst\n+second");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nfirst\nsecond\nc\nd\ne");
		expect(result.warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("does NOT auto-pipe across block boundaries", () => {
		// `2 2` accumulates `foo` as a bare row; `4 4` flushes the first
		// block (auto-pipe fires) and starts a new pending. The second
		// block's `bar` row is also bare → second auto-pipe.
		const result = parsePatch("2 2\nfoo\n4 4\nbar");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nfoo\nc\nbar\ne");
	});
});

describe("hashline leniency L9 — unified-diff body conversion", () => {
	it("drops `-`-prefixed body rows (already deleted by the hunk range)", () => {
		// Classic apply_patch / unified-diff shape: -old / +new pair.
		// Model expects the `-` row to mark line for deletion; hashline's
		// `A..B` already deletes the range, so we drop the `-` row
		// and keep the `+` row.
		const result = parsePatch("2 2\n-original line\n+replacement");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nreplacement\nc\nd\ne");
		expect(result.warnings.some(w => /Hunk body contained unified-diff-style rows/.test(w))).toBe(true);
	});

	it("strips the unified-diff metadata-space from context rows once a `-` row is seen", () => {
		// Body has a context row ` keep this`, a `-old` row, a `+new` row.
		// Result: lines 2..3 replaced with [keep this, new].
		const text = "a\nb\nc\nd";
		const result = parsePatch("2 3\n keep this\n-original\n+new");
		expect(applyEdits(text, result.edits).text).toBe("a\nkeep this\nnew\nd");
	});

	it("retroactively strips the metadata-space from context rows that arrived BEFORE the `-` row", () => {
		// Streaming order: context first, then `-`. The `-` is what tells us
		// we are in unified-diff mode; we must go back and strip the space
		// from the context row.
		const text = "a\nb\nc\nd";
		const result = parsePatch("2 3\n keep this\n+new\n-original");
		expect(applyEdits(text, result.edits).text).toBe("a\nkeep this\nnew\nd");
	});
});

describe("hashline leniency L5 — overlapping bare/concrete coalesce", () => {
	it("coalesces two identical-range hunks (last-wins)", () => {
		// Two `2 3` hunks back-to-back. The first has no body, the
		// second has a payload. We drop the first and emit only the second.
		const result = parsePatch("2 3\n2 3\n+X");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nX\nd\ne");
		expect(result.warnings.some(w => /identical-range hashline hunks/.test(w))).toBe(true);
	});

	it("coalesces an overlapping bare hunk followed by a concrete hunk", () => {
		// Bare `2 3` overlaps with the concrete `3 4`. Drop the
		// bare pending; keep the concrete one.
		const result = parsePatch("2 3\n3 4\n+NEW");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nb\nNEW\ne");
		expect(result.warnings.some(w => /overlapping bare hashline hunk/.test(w))).toBe(true);
	});

	it("still rejects two concrete overlapping replaces", () => {
		// Both pending hunks have payload → no L5 short-circuit. The
		// post-hoc validator catches the line-3 collision.
		expect(() => parsePatch("2 3\n+X\n+Y\n3 4\n+Z")).toThrow(/anchor line 3 is already targeted by another hunk/);
	});
});

describe("hashline — apply_patch / unified-diff contamination", () => {
	it("rejects `*** Update File:` sentinels as contamination", () => {
		expect(() => parsePatch("*** Update File: a.ts\n2 2\n+X")).toThrow(/apply_patch sentinel/);
	});

	it("rejects `*** Add File:` sentinels as contamination", () => {
		expect(() => parsePatch("*** Add File: a.ts\n2 2\n+X")).toThrow(/apply_patch sentinel/);
	});

	it("rejects unified-diff hunk headers (`-N,M +N,M`) as contamination", () => {
		expect(() => parsePatch("@@ -1,3 +1,3 @@\n2 2\n+X")).toThrow(/unified-diff hunk header/);
	});

	it("treats top-level `+TEXT` as an orphan literal payload", () => {
		expect(() => parsePatch("+   const X = 1;\n2 2")).toThrow(/payload line has no preceding hunk header/);
	});
});

describe("hashline leniency — composite scenarios from the benchmark dumps", () => {
	it("recovers GLM's `LINE=`-shaped paste + bare body (chat-simple.ts shape)", () => {
		const text = "aaa\nbbb\nccc\nddd";
		// Authored: bare `2 2` anchor followed by a uniformly-bare body
		// pasted from `read` output. L1 promotes `2 2` to `2 2`; L3
		// auto-pipes the bare body rows.
		const result = parsePatch("2 2\n  NEW_LINE_ONE\n  NEW_LINE_TWO");
		expect(applyEdits(text, result.edits).text).toBe("aaa\n  NEW_LINE_ONE\n  NEW_LINE_TWO\nccc\nddd");
		expect(result.warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("two back-to-back identical-range hunks coalesce last-wins", () => {
		const text = "aaa\nbbb\nccc\nddd";
		// Two `2 3` hunks; the first has no body, the second is the
		// "real" deletion. The first should be dropped via the identical-
		// range coalesce, leaving the deletion to fire.
		const result = parsePatch("2 3\n2 3");
		expect(applyEdits(text, result.edits).text).toBe("aaa\nddd");
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("recovers gpt-5-spark's `+&A..B` shape (model prefixed a repeat with +)", () => {
		const text = "aaa\nbbb\nccc";
		// Authored: `2-2: +NEW +&2..2`. The second body row is a repeat row
		// the model mistakenly prefixed with `+`. It should be silently
		// rerouted as `^2-2` so the patch effectively inserts NEW above
		// the original line 2, with a warning.
		const result = parsePatch("2 2\n+NEW\n+&2..2");
		expect(applyEdits(text, result.edits).text).toBe("aaa\nNEW\nbbb\nccc");
		expect(result.warnings.some(w => /A body row started with `\+&A\.\.B`/.test(w))).toBe(true);
	});

	it("accepts `+&A..B` with leading whitespace inside the literal text", () => {
		// gpt-5-spark / chat-simple.ts shape: `+    ^85-85` — the model
		// added indentation between `+` and `^A-B`. We trim before checking.
		const text = "aaa\nbbb\nccc";
		const result = parsePatch("2 2\n+NEW\n+    &2..2");
		expect(applyEdits(text, result.edits).text).toBe("aaa\nNEW\nbbb\nccc");
		expect(result.warnings.some(w => /A body row started with `\+&A\.\.B`/.test(w))).toBe(true);
	});

	it("accepts `+^A` shorthand (single line)", () => {
		const text = "aaa\nbbb\nccc";
		const result = parsePatch("2 2\n+NEW\n+&2");
		expect(applyEdits(text, result.edits).text).toBe("aaa\nNEW\nbbb\nccc");
		expect(result.warnings.some(w => /A body row started with `\+&A\.\.B`/.test(w))).toBe(true);
	});

	it("does NOT misclassify `+^literal-text` (not a valid repeat shape)", () => {
		// `+&hello` is just a literal payload row whose text is `^hello`.
		// No range follows the `^`, so it's not a repeat — emit the literal
		// as-is, no warning.
		const text = "aaa\nbbb\nccc";
		const result = parsePatch("2 2\n+&hello");
		expect(applyEdits(text, result.edits).text).toBe("aaa\n&hello\nccc");
		expect(result.warnings.some(w => /A body row started with `\+&A\.\.B`/.test(w))).toBe(false);
	});
});

describe("hashline leniency — BOF/EOF range suffix", () => {
	it("accepts `BOF..BOF=` as `BOF`", () => {
		expect(applyPatch(FILE, "BOF\n+HEAD")).toBe("HEAD\na\nb\nc\nd\ne");
	});

	it("accepts `EOF..EOF=` as `EOF`", () => {
		expect(applyPatch(FILE, "EOF\n+TAIL")).toBe("a\nb\nc\nd\ne\nTAIL");
	});

	it("accepts `BOF..EOF=` (degenerate but harmless)", () => {
		expect(applyPatch(FILE, "BOF\n+HEAD")).toBe("HEAD\na\nb\nc\nd\ne");
	});
});

describe("hashline apply — duplicate boundary payloads", () => {
	it("keeps replacement boundary echoes literal", () => {
		const text = ["// one", "// two", "old();"].join("\n");
		const diff = "3 3\n+// one\n+// two\n+new();";

		expect(applyPatch(text, diff)).toBe(["// one", "// two", "// one", "// two", "new();"].join("\n"));
	});

	it("keeps pure-insert context echoes literal", () => {
		const text = ["aaa", "bbb", "ccc"].join("\n");
		const diff = "EOF\n+bbb\n+ccc\n+NEW";

		expect(applyPatch(text, diff)).toBe("aaa\nbbb\nccc\nbbb\nccc\nNEW");
	});
});
