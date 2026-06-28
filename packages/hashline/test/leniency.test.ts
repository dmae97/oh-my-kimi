import { describe, expect, it } from "bun:test";
import { applyEdits, Patch, parsePatch } from "@oh-my-pi/hashline";

function applyPatch(text: string, diff: string): string {
	return applyEdits(text, parsePatch(diff).edits).text;
}

const FILE = "a\nb\nc\nd\ne";

describe("hashline section headers", () => {
	it("accepts paths with spaces in anchored section headers", () => {
		const section = Patch.parseSingle("[dir with spaces/file.ts#1a2b]\nSWAP 1.=1:\n+after");

		expect(section.path).toBe("dir with spaces/file.ts");
		expect(section.fileHash).toBe("1A2B");
		expect(section.applyTo("before").text).toBe("after");
	});

	it("recovers apply_patch-contaminated headers whose paths contain spaces", () => {
		const section = Patch.parseSingle("[*** Update File: dir with spaces/file.ts#1A2B]\nSWAP 1.=1:\n+after");

		expect(section.path).toBe("dir with spaces/file.ts");
		expect(section.fileHash).toBe("1A2B");
		expect(section.applyTo("before").text).toBe("after");
	});

	it("rejects trailing junk after a snapshot tag", () => {
		expect(() => Patch.parse("[src/a.ts#1A2B copied from read]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/);
		expect(() => Patch.parse("[src/a.ts#1A2B:812]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/);
	});

	it("rejects trailing junk after a snapshot tag even with apply_patch noise", () => {
		expect(() => Patch.parse("[Update File: src/a.ts#1A2B copied from read]\nSWAP 1.=1:\n+after")).toThrow(
			/Input header must be/,
		);
		expect(() => Patch.parse("[Update File: src/a.ts#1A2B:812]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/);
	});

	it("rejects malformed snapshot tags", () => {
		expect(() => Patch.parse("[src/a.ts#1A2]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/);
		expect(() => Patch.parse("[src/a.ts#1A2G]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/);
		expect(() => Patch.parse("[src/a.ts#1A2B5]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/);
	});

	it("rejects malformed snapshot tags even with apply_patch noise", () => {
		expect(() => Patch.parse("[Update File: src/a.ts#1A2G]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/);
	});

	it("reports bracket syntax with a 4-hex example when the header is missing", () => {
		try {
			Patch.parse("DEL 38.=40");
			throw new Error("expected missing-header error");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain('input must begin with "[PATH#HASH]"');
			expect(message).toContain('Example: "[src/foo.ts#1A2B]"');
			expect(message).not.toContain("#0A3");
		}
	});
});

describe("hashline core — verb header forms", () => {
	it("rejects a bare single-number hunk header with verb guidance", () => {
		expect(() => parsePatch("2\n+B")).toThrow(/hunk headers need a verb/);
	});

	it("rejects a bare numeric range with verb guidance", () => {
		expect(() => parsePatch("2 3\n+X")).toThrow(/Hunk headers need a verb/);
	});

	it("accepts canonical replace/delete/insert forms", () => {
		expect(applyPatch(FILE, "SWAP 2.=3:\n+X")).toBe("a\nX\nd\ne");
		expect(applyPatch(FILE, "DEL 2.=3")).toBe("a\nd\ne");
		expect(applyPatch(FILE, "INS.PRE 2:\n+X")).toBe("a\nX\nb\nc\nd\ne");
		expect(applyPatch(FILE, "INS.POST 2:\n+X")).toBe("a\nb\nX\nc\nd\ne");
		expect(applyPatch(FILE, "INS.HEAD:\n+X")).toBe("X\na\nb\nc\nd\ne");
		expect(applyPatch(FILE, "INS.TAIL:\n+X")).toBe("a\nb\nc\nd\ne\nX");
	});

	it("accepts single-number replace and delete shorthand", () => {
		expect(applyPatch(FILE, "SWAP 2:\n+X")).toBe("a\nX\nc\nd\ne");
		expect(applyPatch(FILE, "DEL 2")).toBe("a\nc\nd\ne");
	});

	it("accepts alternate replace range separators and missing colon", () => {
		expect(applyPatch(FILE, "SWAP 2-3:\n+X")).toBe("a\nX\nd\ne");
		expect(applyPatch(FILE, "SWAP 2\u20263:\n+X")).toBe("a\nX\nd\ne");
		expect(applyPatch(FILE, "SWAP 2 3:\n+X")).toBe("a\nX\nd\ne");
		expect(applyPatch(FILE, "SWAP 2..3:\n+X")).toBe("a\nX\nd\ne"); // legacy `..` still accepted
		expect(applyPatch(FILE, "SWAP 2.=3\n+X")).toBe("a\nX\nd\ne"); // missing colon
	});

	it("accepts missing colon on insert headers", () => {
		expect(applyPatch(FILE, "INS.PRE 2\n+X")).toBe("a\nX\nb\nc\nd\ne");
		expect(applyPatch(FILE, "INS.HEAD\n+X")).toBe("X\na\nb\nc\nd\ne");
	});

	it("tolerates GLM 5.2 stray dot before the trailing colon", () => {
		// GLM 5.2 inserts a `.` between the line number/range and `:`,
		// e.g. `SWAP 2.=3.:` instead of `SWAP 2.=3:`.
		expect(applyPatch(FILE, "SWAP 2.=3.:\n+X")).toBe("a\nX\nd\ne");
		expect(applyPatch(FILE, "SWAP 2.=2.:\n+X")).toBe("a\nX\nc\nd\ne");
		// `INS.POST 2.:` instead of `INS.POST 2:`
		expect(applyPatch(FILE, "INS.POST 2.:\n+X")).toBe("a\nb\nX\nc\nd\ne");
		expect(applyPatch(FILE, "INS.PRE 2.:\n+X")).toBe("a\nX\nb\nc\nd\ne");
		// `DEL 2.=3.` instead of `DEL 2.=3` (stray dot, no colon)
		expect(applyPatch(FILE, "DEL 2.=3.")).toBe("a\nd\ne");
		// `INS.HEAD.:` and `INS.TAIL.:` with stray dot
		expect(applyPatch(FILE, "INS.HEAD.:\n+X")).toBe("X\na\nb\nc\nd\ne");
		expect(applyPatch(FILE, "INS.TAIL.:\n+X")).toBe("a\nb\nc\nd\ne\nX");
	});
});

describe("hashline body contracts", () => {
	it("auto-pipes a bare body row while warning", () => {
		const result = parsePatch("SWAP 2.=2:\n  hello");
		expect(applyEdits(FILE, result.edits).text).toBe("a\n  hello\nc\nd\ne");
		expect(result.warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("strips read-output line number prefix from auto-piped bare body rows", () => {
		const result = parsePatch("SWAP 2.=2:\n2:hello");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nhello\nc\nd\ne");
		expect(result.warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});
	it("preserves `+N:` literal payloads without stripping", () => {
		const result = parsePatch("SWAP 2.=2:\n+3:keep");
		expect(applyEdits(FILE, result.edits).text).toBe("a\n3:keep\nc\nd\ne");
		expect(result.warnings.some(w => /Auto-prefixed/.test(w))).toBe(false);
	});
	it("strips only one N: prefix from bare body rows (preserves nested digits:colon)", () => {
		// "2:42:hello" → should yield "42:hello", NOT "hello" (recursive would over-strip)
		const result = parsePatch("SWAP 2.=2:\n2:42:hello");
		expect(applyEdits(FILE, result.edits).text).toBe("a\n42:hello\nc\nd\ne");
	});

	it("strips N: prefixes only when every bare body row carries one", () => {
		const result = parsePatch("SWAP 2.=3:\n2:foo\n3:bar");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nfoo\nbar\nd\ne");
	});

	it("leaves bare body rows untouched when only some carry an N: prefix", () => {
		// "3:keep" looks like a snapshot prefix but "plain" does not, so the body
		// is genuine content (not a pasted snapshot) — strip nothing.
		const result = parsePatch("SWAP 2.=3:\n3:keep\nplain");
		expect(applyEdits(FILE, result.edits).text).toBe("a\n3:keep\nplain\nd\ne");
	});

	it("keeps interior blank rows in a bare replace body", () => {
		const result = parsePatch("SWAP 2.=3:\nfoo\n\nbar");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nfoo\n\nbar\nd\ne");
	});

	it("drops trailing blank rows between a bare body and the next hunk", () => {
		const result = parsePatch("SWAP 2.=2:\nfoo\n\nSWAP 4.=4:\nbaz");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nfoo\nc\nbaz\ne");
	});

	it("skips blank rows when checking N: prefix uniformity", () => {
		const result = parsePatch("SWAP 2.=3:\n2:foo\n\n3:bar");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nfoo\n\nbar\nd\ne");
	});

	it("leaves numeric-keyed literal bodies untouched (dict/YAML shape)", () => {
		const result = parsePatch('SWAP 2.=3:\n1: "one",\n2: "two",');
		expect(applyEdits(FILE, result.edits).text).toBe('a\n1: "one",\n2: "two",\nd\ne');
	});

	it("rejects `-` body rows with a teaching error", () => {
		expect(() => parsePatch("SWAP 2.=2:\n-old\n+new")).toThrow(/`-` rows are not valid/);
	});

	it("allows literal text that begins with `-` or `+` when prefixed with `+`", () => {
		expect(applyPatch(FILE, "SWAP 2.=2:\n+-literal\n++plus")).toBe("a\n-literal\n+plus\nc\nd\ne");
	});

	it("treats empty replace as delete and still rejects empty insert", () => {
		expect(applyPatch(FILE, "SWAP 2.=2:")).toBe("a\nc\nd\ne");
		expect(() => parsePatch("INS.TAIL:")).toThrow(/`INS` needs/);
	});

	it("rejects delete with a body", () => {
		expect(() => parsePatch("DEL 2\n+X")).toThrow(/does not take body rows/);
	});

	it("rejects delete with a colon", () => {
		expect(() => parsePatch("DEL 2:\n+X")).toThrow(/has no colon/);
	});
});

describe("hashline — apply_patch / unified-diff contamination", () => {
	it("rejects apply_patch sentinels as contamination", () => {
		expect(() => parsePatch("*** Update File: a.ts\nSWAP 2.=2:\n+X")).toThrow(/apply_patch sentinel/);
		expect(() => parsePatch("*** Add File: a.ts\nSWAP 2.=2:\n+X")).toThrow(/apply_patch sentinel/);
	});

	it("rejects unified-diff hunk headers as contamination", () => {
		expect(() => parsePatch("@@ -1,3 +1,3 @@\nSWAP 2.=2:\n+X")).toThrow(/unified-diff hunk header/);
	});

	it("treats top-level `+TEXT` as an orphan literal payload", () => {
		expect(() => parsePatch("+const X = 1;\nSWAP 2.=2:")).toThrow(/payload line has no preceding hunk header/);
	});
});

describe("hashline apply — duplicate boundary payloads", () => {
	it("keeps replacement boundary echoes literal unless balance repair applies", () => {
		const text = ["// one", "// two", "old();"].join("\n");
		const diff = "SWAP 3.=3:\n+// one\n+// two\n+new();";
		expect(applyPatch(text, diff)).toBe(["// one", "// two", "// one", "// two", "new();"].join("\n"));
	});

	it("keeps pure-insert context echoes literal", () => {
		const text = ["aaa", "bbb", "ccc"].join("\n");
		const diff = "INS.TAIL:\n+bbb\n+ccc\n+NEW";
		expect(applyPatch(text, diff)).toBe("aaa\nbbb\nccc\nbbb\nccc\nNEW");
	});
});
