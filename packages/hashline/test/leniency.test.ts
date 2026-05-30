import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@oh-my-pi/hashline";

function applyPatch(text: string, diff: string): string {
	return applyEdits(text, parsePatch(diff).edits).text;
}

const FILE = "a\nb\nc\nd\ne";

describe("hashline core — verb header forms", () => {
	it("rejects a bare single-number hunk header with verb guidance", () => {
		expect(() => parsePatch("2\n+B")).toThrow(/hunk headers need a verb/);
	});

	it("rejects a bare numeric range with verb guidance", () => {
		expect(() => parsePatch("2 3\n+X")).toThrow(/Hunk headers need a verb/);
	});

	it("accepts canonical replace/delete/insert forms", () => {
		expect(applyPatch(FILE, "replace 2..3:\n+X")).toBe("a\nX\nd\ne");
		expect(applyPatch(FILE, "delete 2..3")).toBe("a\nd\ne");
		expect(applyPatch(FILE, "insert before 2:\n+X")).toBe("a\nX\nb\nc\nd\ne");
		expect(applyPatch(FILE, "insert after 2:\n+X")).toBe("a\nb\nX\nc\nd\ne");
		expect(applyPatch(FILE, "insert head:\n+X")).toBe("X\na\nb\nc\nd\ne");
		expect(applyPatch(FILE, "insert tail:\n+X")).toBe("a\nb\nc\nd\ne\nX");
	});

	it("accepts single-number replace and delete shorthand", () => {
		expect(applyPatch(FILE, "replace 2:\n+X")).toBe("a\nX\nc\nd\ne");
		expect(applyPatch(FILE, "delete 2")).toBe("a\nc\nd\ne");
	});

	it("accepts alternate replace range separators and missing colon", () => {
		expect(applyPatch(FILE, "replace 2-3:\n+X")).toBe("a\nX\nd\ne");
		expect(applyPatch(FILE, "replace 2\u20263:\n+X")).toBe("a\nX\nd\ne");
		expect(applyPatch(FILE, "replace 2 3:\n+X")).toBe("a\nX\nd\ne");
		expect(applyPatch(FILE, "replace 2..3\n+X")).toBe("a\nX\nd\ne");
	});

	it("accepts missing colon on insert headers", () => {
		expect(applyPatch(FILE, "insert before 2\n+X")).toBe("a\nX\nb\nc\nd\ne");
		expect(applyPatch(FILE, "insert head\n+X")).toBe("X\na\nb\nc\nd\ne");
	});
});

describe("hashline body contracts", () => {
	it("auto-pipes a bare body row while warning", () => {
		const result = parsePatch("replace 2..2:\n  hello");
		expect(applyEdits(FILE, result.edits).text).toBe("a\n  hello\nc\nd\ne");
		expect(result.warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("rejects `-` body rows with a teaching error", () => {
		expect(() => parsePatch("replace 2..2:\n-old\n+new")).toThrow(/`-` rows are not valid/);
	});

	it("allows literal text that begins with `-` or `+` when prefixed with `+`", () => {
		expect(applyPatch(FILE, "replace 2..2:\n+-literal\n++plus")).toBe("a\n-literal\n+plus\nc\nd\ne");
	});

	it("rejects empty replace and insert hunks", () => {
		expect(() => parsePatch("replace 2..2:")).toThrow(/To delete lines, use `delete/);
		expect(() => parsePatch("insert tail:")).toThrow(/`insert` needs/);
	});

	it("rejects delete with a body", () => {
		expect(() => parsePatch("delete 2\n+X")).toThrow(/does not take body rows/);
	});

	it("rejects delete with a colon", () => {
		expect(() => parsePatch("delete 2:\n+X")).toThrow(/has no colon/);
	});
});

describe("hashline — apply_patch / unified-diff contamination", () => {
	it("rejects apply_patch sentinels as contamination", () => {
		expect(() => parsePatch("*** Update File: a.ts\nreplace 2..2:\n+X")).toThrow(/apply_patch sentinel/);
		expect(() => parsePatch("*** Add File: a.ts\nreplace 2..2:\n+X")).toThrow(/apply_patch sentinel/);
	});

	it("rejects unified-diff hunk headers as contamination", () => {
		expect(() => parsePatch("@@ -1,3 +1,3 @@\nreplace 2..2:\n+X")).toThrow(/unified-diff hunk header/);
	});

	it("treats top-level `+TEXT` as an orphan literal payload", () => {
		expect(() => parsePatch("+const X = 1;\nreplace 2..2:")).toThrow(/payload line has no preceding hunk header/);
	});
});

describe("hashline apply — duplicate boundary payloads", () => {
	it("keeps replacement boundary echoes literal unless balance repair applies", () => {
		const text = ["// one", "// two", "old();"].join("\n");
		const diff = "replace 3..3:\n+// one\n+// two\n+new();";
		expect(applyPatch(text, diff)).toBe(["// one", "// two", "// one", "// two", "new();"].join("\n"));
	});

	it("keeps pure-insert context echoes literal", () => {
		const text = ["aaa", "bbb", "ccc"].join("\n");
		const diff = "insert tail:\n+bbb\n+ccc\n+NEW";
		expect(applyPatch(text, diff)).toBe("aaa\nbbb\nccc\nbbb\nccc\nNEW");
	});
});
