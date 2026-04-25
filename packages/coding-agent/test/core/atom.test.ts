import { describe, expect, it } from "bun:test";
import {
	type AtomEdit,
	applyAtomEdits,
	computeLineHash,
	HashlineMismatchError,
	resolveAtomToolEdit,
} from "@oh-my-pi/pi-coding-agent/edit";
import type { Anchor } from "@oh-my-pi/pi-coding-agent/edit/modes/hashline";

function tag(line: number, content: string): Anchor {
	return { line, hash: computeLineHash(line, content) };
}

describe("applyAtomEdits — set", () => {
	it("replaces a single line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: AtomEdit[] = [{ op: "set", pos: tag(2, "bbb"), lines: ["BBB"] }];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("aaa\nBBB\nccc");
		expect(result.firstChangedLine).toBe(2);
	});

	it("expands one line into many", () => {
		const content = "aaa\nbbb\nccc";
		const edits: AtomEdit[] = [{ op: "set", pos: tag(2, "bbb"), lines: ["X", "Y", "Z"] }];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("aaa\nX\nY\nZ\nccc");
	});

	it("rejects on stale hash", () => {
		const content = "aaa\nbbb\nccc";
		const edits: AtomEdit[] = [{ op: "set", pos: { line: 2, hash: "ZZ" }, lines: ["BBB"] }];
		expect(() => applyAtomEdits(content, edits)).toThrow(HashlineMismatchError);
	});
});

describe("applyAtomEdits — del", () => {
	it("removes a line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: AtomEdit[] = [{ op: "del", pos: tag(2, "bbb") }];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("aaa\nccc");
	});

	it("multiple deletes apply bottom-up so anchors stay valid", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: AtomEdit[] = [
			{ op: "del", pos: tag(2, "bbb") },
			{ op: "del", pos: tag(3, "ccc") },
		];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("aaa\nddd");
	});
});

describe("applyAtomEdits — before/after", () => {
	it("before inserts above the anchor", () => {
		const content = "aaa\nbbb\nccc";
		const edits: AtomEdit[] = [{ op: "before", pos: tag(2, "bbb"), lines: ["NEW"] }];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("aaa\nNEW\nbbb\nccc");
	});

	it("after inserts below the anchor", () => {
		const content = "aaa\nbbb\nccc";
		const edits: AtomEdit[] = [{ op: "after", pos: tag(2, "bbb"), lines: ["NEW"] }];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("aaa\nbbb\nNEW\nccc");
	});

	it("before + after on same anchor coexist with set", () => {
		const content = "aaa\nbbb\nccc";
		const edits: AtomEdit[] = [
			{ op: "before", pos: tag(2, "bbb"), lines: ["B"] },
			{ op: "set", pos: tag(2, "bbb"), lines: ["BBB"] },
			{ op: "after", pos: tag(2, "bbb"), lines: ["A"] },
		];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("aaa\nB\nBBB\nA\nccc");
	});
});

describe("applyAtomEdits — sub", () => {
	it("replaces a unique substring", () => {
		const content = "const timeout = 5000;";
		const edits: AtomEdit[] = [{ op: "sub", pos: tag(1, content), find: "5000", to: "30_000" }];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("const timeout = 30_000;");
	});

	it("errors when find is absent", () => {
		const content = "const timeout = 5000;";
		const edits: AtomEdit[] = [{ op: "sub", pos: tag(1, content), find: "missing", to: "x" }];
		expect(() => applyAtomEdits(content, edits)).toThrow(/not found/);
	});

	it("errors when find is non-unique", () => {
		const content = "abc abc";
		const edits: AtomEdit[] = [{ op: "sub", pos: tag(1, content), find: "abc", to: "Z" }];
		expect(() => applyAtomEdits(content, edits)).toThrow(/more than once/);
	});

	it("rejects conflict with set on same anchor", () => {
		const content = "abc";
		const edits: AtomEdit[] = [
			{ op: "sub", pos: tag(1, "abc"), find: "abc", to: "x" },
			{ op: "set", pos: tag(1, "abc"), lines: ["y"] },
		];
		expect(() => applyAtomEdits(content, edits)).toThrow(/Conflicting ops/);
	});
});

describe("applyAtomEdits — ins", () => {
	it("replaces from anchor to end-of-line (vim-insert style)", () => {
		const content = `const tag = "DO NOT SHIP";`;
		const edits: AtomEdit[] = [{ op: "ins", pos: tag(1, content), find: "DO", to: 'OK";' }];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe('const tag = "OK";');
	});

	it("appends after find when find is at end-of-line", () => {
		const content = "foo bar";
		const edits: AtomEdit[] = [{ op: "ins", pos: tag(1, content), find: "bar", to: "BAZ" }];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("foo BAZ");
	});

	it("errors when find is absent", () => {
		const content = "abc def";
		const edits: AtomEdit[] = [{ op: "ins", pos: tag(1, content), find: "missing", to: "x" }];
		expect(() => applyAtomEdits(content, edits)).toThrow(/not found/);
	});

	it("errors when find is non-unique", () => {
		const content = "abc abc";
		const edits: AtomEdit[] = [{ op: "ins", pos: tag(1, content), find: "abc", to: "Z" }];
		expect(() => applyAtomEdits(content, edits)).toThrow(/more than once/);
	});

	it("rejects conflict with sub on same anchor", () => {
		const content = "abc def";
		const edits: AtomEdit[] = [
			{ op: "sub", pos: tag(1, content), find: "abc", to: "x" },
			{ op: "ins", pos: tag(1, content), find: "def", to: "y" },
		];
		expect(() => applyAtomEdits(content, edits)).toThrow(/Conflicting ops/);
	});
});

describe("applyAtomEdits — file-scoped", () => {
	it("append_file appends at EOF", () => {
		const content = "aaa\nbbb";
		const edits: AtomEdit[] = [{ op: "append_file", lines: ["ccc"] }];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("aaa\nbbb\nccc");
	});

	it("prepend_file prepends at BOF", () => {
		const content = "aaa\nbbb";
		const edits: AtomEdit[] = [{ op: "prepend_file", lines: ["ZZZ"] }];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("ZZZ\naaa\nbbb");
	});

	it("append to empty file replaces empty line", () => {
		const content = "";
		const edits: AtomEdit[] = [{ op: "append_file", lines: ["aaa"] }];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("aaa");
	});
});

describe("applyAtomEdits — out of range", () => {
	it("rejects line beyond file length", () => {
		const content = "aaa\nbbb";
		const edits: AtomEdit[] = [{ op: "set", pos: { line: 99, hash: "ZZ" }, lines: ["x"] }];
		expect(() => applyAtomEdits(content, edits)).toThrow(/does not exist/);
	});
});

describe("parseAnchor (atom tolerant) + applyAtomEdits", () => {
	it("surfaces correct anchor + content when the model invents an out-of-alphabet hash", () => {
		const content = "alpha\nbravo\ncharlie";
		// `XG` is not in the alphabet; should be rejected with the actual anchor exposed.
		const toolEdit = { path: "a.ts", set: "2#XG", lines: "BRAVO" };
		const resolved = resolveAtomToolEdit(toolEdit) as AtomEdit;
		expect(() => applyAtomEdits(content, [resolved])).toThrow(HashlineMismatchError);
		try {
			applyAtomEdits(content, [resolved]);
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toContain(">>>");
			expect(msg).toContain("bravo");
			expect(msg).toContain(`2#${computeLineHash(2, "bravo")}`);
		}
	});

	it("surfaces correct anchor + content when the model omits the hash entirely", () => {
		const content = "alpha\nbravo\ncharlie";
		const toolEdit = { path: "a.ts", set: "2", lines: "BRAVO" };
		const resolved = resolveAtomToolEdit(toolEdit) as AtomEdit;
		expect(() => applyAtomEdits(content, [resolved])).toThrow(HashlineMismatchError);
	});

	it("surfaces correct anchor when the model uses pipe-separator (LINE|content) form", () => {
		const content = "alpha\nbravo\ncharlie";
		const toolEdit = { path: "a.ts", set: "2|bravo", lines: "BRAVO" };
		const resolved = resolveAtomToolEdit(toolEdit) as AtomEdit;
		expect(() => applyAtomEdits(content, [resolved])).toThrow(HashlineMismatchError);
	});

	it("throws a usage-style error when no line number can be extracted", () => {
		const toolEdit = { path: "a.ts", set: "  if (!x) return;", lines: "x" };
		expect(() => resolveAtomToolEdit(toolEdit)).toThrow(/could not extract a line number/);
	});
});


describe("applyAtomEdits — between", () => {
	it("replaces lines strictly between two surviving anchors (function body, keep braces)", () => {
		const content = "function alpha() {\n\told();\n\tmore();\n}";
		const edits: AtomEdit[] = [
			{
				op: "between",
				after: tag(1, "function alpha() {"),
				before: tag(4, "}"),
				lines: ["\tvalidate();", "\tlog();", "\tcleanup();"],
			},
		];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("function alpha() {\n\tvalidate();\n\tlog();\n\tcleanup();\n}");
		expect(result.firstChangedLine).toBe(2);
	});

	it("deletes the body when lines is empty", () => {
		const content = "function alpha() {\n\told();\n\tmore();\n}";
		const edits: AtomEdit[] = [
			{ op: "between", after: tag(1, "function alpha() {"), before: tag(4, "}"), lines: [] },
		];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("function alpha() {\n}");
	});

	it("is a pure insertion when after.line + 1 == before.line", () => {
		const content = "top\nbottom";
		const edits: AtomEdit[] = [
			{ op: "between", after: tag(1, "top"), before: tag(2, "bottom"), lines: ["middle"] },
		];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("top\nmiddle\nbottom");
	});

	it("rejects when after.line >= before.line", () => {
		const content = "a\nb\nc";
		const edits: AtomEdit[] = [
			{ op: "between", after: tag(2, "b"), before: tag(2, "b"), lines: ["x"] },
		];
		expect(() => applyAtomEdits(content, edits)).toThrow(/after\.line < before\.line/);
	});

	it("rejects when another op targets a line strictly inside the region", () => {
		const content = "open\nbody1\nbody2\nclose";
		const edits: AtomEdit[] = [
			{ op: "between", after: tag(1, "open"), before: tag(4, "close"), lines: ["X"] },
			{ op: "set", pos: tag(2, "body1"), lines: ["Y"] },
		];
		expect(() => applyAtomEdits(content, edits)).toThrow(/inside a `between` region/);
	});

	it("rejects overlapping between regions", () => {
		const content = "a\nb\nc\nd\ne";
		const edits: AtomEdit[] = [
			{ op: "between", after: tag(1, "a"), before: tag(4, "d"), lines: ["X"] },
			{ op: "between", after: tag(3, "c"), before: tag(5, "e"), lines: ["Y"] },
		];
		expect(() => applyAtomEdits(content, edits)).toThrow(/Overlapping `between` ops/);
	});

	it("coexists with set on the closing-anchor line (the anchor is preserved by between, then set rewrites it)", () => {
		const content = "open\nbody\nclose";
		const edits: AtomEdit[] = [
			{ op: "between", after: tag(1, "open"), before: tag(3, "close"), lines: ["X", "Y"] },
			{ op: "set", pos: tag(3, "close"), lines: ["END"] },
		];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("open\nX\nY\nEND");
	});

	it("coexists with set on the opening-anchor line", () => {
		const content = "open\nbody\nclose";
		const edits: AtomEdit[] = [
			{ op: "between", after: tag(1, "open"), before: tag(3, "close"), lines: ["X", "Y"] },
			{ op: "set", pos: tag(1, "open"), lines: ["BEGIN"] },
		];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("BEGIN\nX\nY\nclose");
	});

	it("rejects on stale hash for either anchor", () => {
		const content = "open\nbody\nclose";
		const edits: AtomEdit[] = [
			{ op: "between", after: { line: 1, hash: "ZZ" }, before: tag(3, "close"), lines: ["X"] },
		];
		expect(() => applyAtomEdits(content, edits)).toThrow(HashlineMismatchError);
	});

	it("resolveAtomToolEdit accepts `set: [open, close]` tuple and parses both anchors", () => {
		const toolEdit = {
			path: "a.ts",
			set: ["1#xx", "4#yy"] as [string, string],
			lines: ["X"],
		};
		const resolved = resolveAtomToolEdit(toolEdit) as AtomEdit;
		expect(resolved.op).toBe("between");
		if (resolved.op !== "between") throw new Error("unreachable");
		expect(resolved.after.line).toBe(1);
		expect(resolved.before.line).toBe(4);
		expect(resolved.lines).toEqual(["X"]);
	});

	it("resolveAtomToolEdit rejects `set` arrays with non-string elements", () => {
		const toolEdit = { path: "a.ts", set: [1, 2] as unknown as [string, string], lines: ["X"] };
		expect(() => resolveAtomToolEdit(toolEdit)).toThrow(/2-tuple requires both elements to be anchor strings/);
	});
});