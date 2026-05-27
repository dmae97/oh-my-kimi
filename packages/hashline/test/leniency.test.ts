import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@oh-my-pi/hashline";

function applyPatch(text: string, diff: string): string {
	return applyEdits(text, parsePatch(diff).edits).text;
}

const FILE = "a\nb\nc\nd\ne";

describe("hashline leniency L1 — bare `A:` shorthand", () => {
	it("treats `A:` as `A-A:`", () => {
		expect(applyPatch(FILE, "2:\n+B")).toBe("a\nB\nc\nd\ne");
	});

	it("treats `A:-` as `A-A:-`", () => {
		expect(applyPatch(FILE, "2:-")).toBe("a\nc\nd\ne");
	});

	it("preserves the inline-payload rejection on `A:content`", () => {
		expect(() => parsePatch("2:hello")).toThrow(/Inline payload on the anchor line is rejected/);
	});

	it("still rejects `LINE:content` rows pasted in the middle of a payload", () => {
		// First block is fine; the second line looks like another op-block
		// with inline payload (after L1 it parses as `3-3:` with body
		// `    ddd`), which triggers the inline-payload diagnostic.
		expect(() => parsePatch("2-2:\n+first\n3:    ddd")).toThrow(/Inline payload on the anchor line is rejected/);
	});
});

describe("hashline leniency L2 — bare `^A` repeat shorthand", () => {
	it("treats `^A` as `^A-A`", () => {
		// `^2-2` keeps the original line 2 between the inserted rows.
		expect(applyPatch(FILE, "2-2:\n+ABOVE\n^2\n+BELOW")).toBe("a\nABOVE\nb\nBELOW\nc\nd\ne");
	});

	it("auto-pipes `^A-` (malformed range) as literal text via L3", () => {
		// `^2-` is not a valid repeat row (missing end number). The
		// tokenizer classifies it as raw; L3's uniformly-bare auto-pipe
		// then folds it back into the block as a literal. The model sees
		// the warning and can re-issue with a well-formed repeat.
		const result = parsePatch("2-2:\n^2-");
		expect(applyEdits(FILE, result.edits).text).toBe("a\n^2-\nc\nd\ne");
		expect(result.warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});
});

describe("hashline leniency L3 — auto-pipe uniformly bare bodies", () => {
	it("accepts a block whose body is uniformly unprefixed", () => {
		const result = parsePatch("2-2:\n  hello\n  world");
		expect(applyEdits(FILE, result.edits).text).toBe("a\n  hello\n  world\nc\nd\ne");
		expect(result.warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("rejects literal-then-bare mixed blocks at the bare row's line", () => {
		expect(() => parsePatch("2-2:\n+first\nsecond")).toThrow(/line 3: payload row in a hashline block/);
	});

	it("rejects bare-then-literal mixed blocks at the bare row's line", () => {
		// The bare `first` is buffered on line 2; on line 3 the `|second`
		// arrives and triggers a retro-rejection pointed at line 2.
		expect(() => parsePatch("2-2:\nfirst\n+second")).toThrow(/line 2: payload row in a hashline block/);
	});

	it("does NOT auto-pipe across block boundaries", () => {
		// `2-2:` accumulates `foo` as a bare row; `4-4:` flushes the first
		// block (auto-pipe fires) and starts a new pending. The second
		// block's `bar` row is also bare → second auto-pipe.
		const result = parsePatch("2-2:\nfoo\n4-4:\nbar");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nfoo\nc\nbar\ne");
	});
});

describe("hashline leniency L4 — lone `-` body row as delete", () => {
	it("retroactively converts a lone `-` row to a `:-` delete", () => {
		const result = parsePatch("2-3:\n-");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nd\ne");
		expect(result.warnings.some(w => /Converted a lone `-` body row/.test(w))).toBe(true);
	});

	it("does NOT fire when the block already has `|` rows", () => {
		// L4 only triggers on a totally-bare pending block; once a literal
		// row arrives, the `-` is a regular mixed-block bare row → reject.
		expect(() => parsePatch("2-2:\n+X\n-")).toThrow(/payload row in a hashline block must start with/);
	});

	it("does NOT fire when the block already has bare raw rows", () => {
		// `foo` is bare and buffered. The `-` row arrives next; pendingRaws
		// is non-empty so L4 does not retro-convert. The block is uniformly
		// bare so it auto-pipes both rows (so `-` becomes literal text).
		const result = parsePatch("2-2:\nfoo\n-");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nfoo\n-\nc\nd\ne");
	});
});

describe("hashline leniency L5 — overlapping bare/concrete coalesce", () => {
	it("coalesces `A-B:` + `A-B:-` (identical-range before-then-delete) into a delete", () => {
		const result = parsePatch("2-3:\n2-3:-");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nd\ne");
		expect(result.warnings.some(w => /overlapping bare hashline block/.test(w))).toBe(true);
	});

	it("coalesces an overlapping (not identical) bare anchor followed by `:-`", () => {
		// Bare `2-3:` overlaps with the later `3-4:-`. Drop the bare
		// pending (which would have replaced 2-3 with a blank), emit only
		// the deletes for 3-4.
		const result = parsePatch("2-3:\n3-4:-");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nb\ne");
		expect(result.warnings.some(w => /overlapping bare hashline block/.test(w))).toBe(true);
	});

	it("coalesces an overlapping bare anchor followed by a concrete replace", () => {
		// Bare `2-3:` overlaps with the concrete `3-4:` (has payload).
		// Drop the bare pending, keep the concrete one.
		const result = parsePatch("2-3:\n3-4:\n+NEW");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nb\nNEW\ne");
		expect(result.warnings.some(w => /overlapping bare hashline block/.test(w))).toBe(true);
	});

	it("still rejects two concrete overlapping replaces", () => {
		// Both pending blocks have payload → no L5 short-circuit. The
		// post-hoc validator catches the line-3 collision.
		expect(() => parsePatch("2-3:\n+X\n+Y\n3-4:\n+Z")).toThrow(/anchor line 3 is already targeted by another op/);
	});
});

describe("hashline leniency L6 — stacked blank-body `A-A:` warning", () => {
	it("warns once when two or more consecutive `A-A:` blocks have empty bodies", () => {
		const result = parsePatch("2-2:\n3-3:");
		// Both lines became blank.
		expect(applyEdits(FILE, result.edits).text).toBe("a\n\n\nd\ne");
		expect(result.warnings.some(w => /run of single-line empty-body blocks/.test(w))).toBe(true);
	});

	it("does NOT warn when only one blank `A-A:` block exists", () => {
		const result = parsePatch("2-2:");
		expect(result.warnings.some(w => /run of single-line empty-body blocks/.test(w))).toBe(false);
	});

	it("does NOT warn when blank blocks are interleaved with non-blank blocks", () => {
		const result = parsePatch("2-2:\n3-3:\n+X");
		// Run interrupted on the second block; counter resets.
		expect(result.warnings.some(w => /run of single-line empty-body blocks/.test(w))).toBe(false);
	});
});

describe("hashline leniency L8 — apply_patch / unified-diff contamination", () => {
	it("rejects `*** Update File:` sentinels at top level", () => {
		expect(() => parsePatch("*** Update File: a.ts\n2-2:\n+X")).toThrow(/apply_patch sentinel/);
	});

	it("rejects `*** Add File:` sentinels", () => {
		expect(() => parsePatch("*** Add File: a.ts\n2-2:\n+X")).toThrow(/apply_patch sentinel/);
	});

	it("rejects unified-diff hunk headers (`@@`)", () => {
		expect(() => parsePatch("@@ -1,3 +1,3 @@\n2-2:\n+X")).toThrow(/unified-diff hunk header/);
		expect(() => parsePatch("@@\n2-2:\n+X")).toThrow(/unified-diff hunk header/);
	});

	it("rejects `-N-M:` / `-N:` apply_patch hunk anchors", () => {
		// `+`-prefixed shapes are no longer flagged because `+` is now the
		// canonical payload sigil; `+2-2:` tokenizes as a literal payload
		// row containing `2-2:` and either lands inside a pending block or
		// throws the standard orphan-payload error.
		expect(() => parsePatch("-2-3:\n+X")).toThrow(/apply_patch line prefix/);
		expect(() => parsePatch("-2:\n+X")).toThrow(/apply_patch line prefix/);
	});

	it("treats top-level `+TEXT` as an orphan literal payload", () => {
		// `+` is the payload sigil — at top level (no pending anchor) this
		// surfaces the standard "no preceding A-B:" error rather than the
		// apply_patch-specific one, so the model still gets a clear pointer
		// to add an anchor above the body row.
		expect(() => parsePatch("+   const X = 1;\n2-2:")).toThrow(
			/payload line has no preceding A-B:, BOF:, or EOF: anchor/,
		);
	});

	it("keeps `-N` bare delete rejection on the legacy unrecognized-block diagnostic", () => {
		// `-5` and `-5..7` are the legacy "removed standalone delete row"
		// shapes — they still throw with the existing unrecognized-block
		// diagnostic, not the apply_patch one.
		expect(() => parsePatch("-5")).toThrow(/unrecognized hashline block/);
		expect(() => parsePatch("-5..7")).toThrow(/unrecognized hashline block/);
	});

	it("gives a focused message for a lone `-` outside any pending block", () => {
		expect(() => parsePatch("-")).toThrow(/a lone "-" is not a valid hashline op/);
	});
});

describe("hashline leniency — composite scenarios from the benchmark dumps", () => {
	it("recovers GLM's `LINE:` paste + bare body (chat-simple.ts shape)", () => {
		const text = "aaa\nbbb\nccc\nddd";
		// Authored: bare `2:` anchor followed by a uniformly-bare body
		// pasted from `read` output. L1 promotes `2:` to `2-2:`; L3
		// auto-pipes the bare body rows.
		const result = parsePatch("2:\n  NEW_LINE_ONE\n  NEW_LINE_TWO");
		expect(applyEdits(text, result.edits).text).toBe("aaa\n  NEW_LINE_ONE\n  NEW_LINE_TWO\nccc\nddd");
		expect(result.warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("recovers gpt-5-spark's identical-range `89-90: ⏎ 89-90:-` shape", () => {
		const text = "aaa\nbbb\nccc\nddd";
		// Identical-range before-then-delete: should delete lines 2-3.
		const result = parsePatch("2-3:\n2-3:-");
		expect(applyEdits(text, result.edits).text).toBe("aaa\nddd");
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("recovers gpt-5-spark's `+^A-B` shape (model prefixed a repeat with +)", () => {
		const text = "aaa\nbbb\nccc";
		// Authored: `2-2: +NEW +^2-2`. The second body row is a repeat row
		// the model mistakenly prefixed with `+`. It should be silently
		// rerouted as `^2-2` so the patch effectively inserts NEW above
		// the original line 2, with a warning.
		const result = parsePatch("2-2:\n+NEW\n+^2-2");
		expect(applyEdits(text, result.edits).text).toBe("aaa\nNEW\nbbb\nccc");
		expect(result.warnings.some(w => /A body row started with `\+\^A-B`/.test(w))).toBe(true);
	});

	it("accepts `+^A-B` with leading whitespace inside the literal text", () => {
		// gpt-5-spark / chat-simple.ts shape: `+    ^85-85` — the model
		// added indentation between `+` and `^A-B`. We trim before checking.
		const text = "aaa\nbbb\nccc";
		const result = parsePatch("2-2:\n+NEW\n+    ^2-2");
		expect(applyEdits(text, result.edits).text).toBe("aaa\nNEW\nbbb\nccc");
		expect(result.warnings.some(w => /A body row started with `\+\^A-B`/.test(w))).toBe(true);
	});

	it("accepts `+^A` shorthand (single line)", () => {
		const text = "aaa\nbbb\nccc";
		const result = parsePatch("2-2:\n+NEW\n+^2");
		expect(applyEdits(text, result.edits).text).toBe("aaa\nNEW\nbbb\nccc");
		expect(result.warnings.some(w => /A body row started with `\+\^A-B`/.test(w))).toBe(true);
	});

	it("does NOT misclassify `+^literal-text` (not a valid repeat shape)", () => {
		// `+^hello` is just a literal payload row whose text is `^hello`.
		// No range follows the `^`, so it's not a repeat — emit the literal
		// as-is, no warning.
		const text = "aaa\nbbb\nccc";
		const result = parsePatch("2-2:\n+^hello");
		expect(applyEdits(text, result.edits).text).toBe("aaa\n^hello\nccc");
		expect(result.warnings.some(w => /A body row started with `\+\^A-B`/.test(w))).toBe(false);
	});
});

describe("hashline leniency — BOF/EOF range suffix", () => {
	it("accepts `BOF-BOF:` as `BOF:`", () => {
		expect(applyPatch(FILE, "BOF-BOF:\n+HEAD")).toBe("HEAD\na\nb\nc\nd\ne");
	});

	it("accepts `EOF-EOF:` as `EOF:`", () => {
		expect(applyPatch(FILE, "EOF-EOF:\n+TAIL")).toBe("a\nb\nc\nd\ne\nTAIL");
	});

	it("accepts `BOF-EOF:` (degenerate but harmless)", () => {
		expect(applyPatch(FILE, "BOF-EOF:\n+HEAD")).toBe("HEAD\na\nb\nc\nd\ne");
	});
});
