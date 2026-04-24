import { describe, expect, it } from "bun:test";
import {
	applyHashlineEdits,
	buildCompactHashlineDiffPreview,
	computeLineHash,
	formatHashLines,
	HashlineMismatchError,
	hashlineParseText,
	parseTag,
	streamHashLinesFromLines,
	streamHashLinesFromUtf8,
	stripHashlinePrefixes,
	stripNewLinePrefixes,
	validateLineRef,
} from "@oh-my-pi/pi-coding-agent/edit";
import type { Anchor, HashlineEdit } from "@oh-my-pi/pi-coding-agent/edit/modes/hashline";

function makeTag(line: number, content: string): Anchor {
	return {
		line,
		hash: computeLineHash(line, content),
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// computeLineHash
// ═══════════════════════════════════════════════════════════════════════════

describe("computeLineHash", () => {
	it("returns 2-4 character alphanumeric hash string", () => {
		const hash = computeLineHash(1, "hello");
		expect(hash).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/);
	});

	it("same content at same line produces same hash", () => {
		const a = computeLineHash(1, "hello");
		const b = computeLineHash(1, "hello");
		expect(a).toBe(b);
	});

	it("different content produces different hash", () => {
		const a = computeLineHash(1, "hello");
		const b = computeLineHash(1, "world");
		expect(a).not.toBe(b);
	});

	it("empty line produces valid hash", () => {
		const hash = computeLineHash(1, "");
		expect(hash).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/);
	});

	it("uses line number for symbol-only lines", () => {
		const a = computeLineHash(1, "***");
		const b = computeLineHash(2, "***");
		expect(a).not.toBe(b);
	});

	it("does not use line number for alphanumeric lines", () => {
		const a = computeLineHash(1, "hello");
		const b = computeLineHash(2, "hello");
		expect(a).toBe(b);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// formatHashLines
// ═══════════════════════════════════════════════════════════════════════════

describe("formatHashLines", () => {
	it("formats single line", () => {
		const result = formatHashLines("hello");
		const hash = computeLineHash(1, "hello");
		expect(result).toBe(`1#${hash}:hello`);
	});

	it("formats multiple lines with 1-indexed numbers", () => {
		const result = formatHashLines("foo\nbar\nbaz");
		const lines = result.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toStartWith("1#");
		expect(lines[1]).toStartWith("2#");
		expect(lines[2]).toStartWith("3#");
	});

	it("respects custom startLine", () => {
		const result = formatHashLines("foo\nbar", 10);
		const lines = result.split("\n");
		expect(lines[0]).toStartWith("10#");
		expect(lines[1]).toStartWith("11#");
	});

	it("handles empty lines in content", () => {
		const result = formatHashLines("foo\n\nbar");
		const lines = result.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[1]).toMatch(/^2#[ZPMQVRWSNKTXJBYH]{2}:$/);
	});

	it("round-trips with computeLineHash", () => {
		const content = "function hello() {\n  return 42;\n}";
		const formatted = formatHashLines(content);
		const lines = formatted.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const match = lines[i].match(/^(\d+)#([ZPMQVRWSNKTXJBYH]{2}):(.*)$/);
			expect(match).not.toBeNull();
			const lineNum = Number.parseInt(match![1], 10);
			const hash = match![2];
			const lineContent = match![3];
			expect(computeLineHash(lineNum, lineContent)).toBe(hash);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// streamHashLinesFromUtf8 / streamHashLinesFromLines
// ═══════════════════════════════════════════════════════════════════════════

describe("streamHashLinesFrom*", () => {
	async function collectText(gen: AsyncIterable<string>): Promise<string> {
		const parts: string[] = [];
		for await (const part of gen) {
			parts.push(part);
		}
		return parts.join("\n");
	}

	async function* utf8Chunks(text: string, chunkSize: number): AsyncGenerator<Uint8Array> {
		const bytes = new TextEncoder().encode(text);
		for (let i = 0; i < bytes.length; i += chunkSize) {
			yield bytes.slice(i, i + chunkSize);
		}
	}

	it("streamHashLinesFromUtf8 matches formatHashLines", async () => {
		const content = "foo\nbar\nbaz";
		const streamed = await collectText(streamHashLinesFromUtf8(utf8Chunks(content, 2), { maxChunkLines: 1 }));
		expect(streamed).toBe(formatHashLines(content));
	});

	it("streamHashLinesFromUtf8 handles empty content", async () => {
		const content = "";
		const streamed = await collectText(streamHashLinesFromUtf8(utf8Chunks(content, 2), { maxChunkLines: 1 }));
		expect(streamed).toBe(formatHashLines(content));
	});

	it("streamHashLinesFromLines matches formatHashLines (including trailing newline)", async () => {
		const content = "foo\nbar\n";
		const lines = ["foo", "bar", ""]; // match `content.split("\\n")`
		const streamed = await collectText(streamHashLinesFromLines(lines, { maxChunkLines: 2 }));
		expect(streamed).toBe(formatHashLines(content));
	});

	it("chunking respects maxChunkLines", async () => {
		const content = "a\nb\nc";
		const parts: string[] = [];
		for await (const part of streamHashLinesFromUtf8(utf8Chunks(content, 1), {
			maxChunkLines: 1,
			maxChunkBytes: 1024,
		})) {
			parts.push(part);
		}
		expect(parts).toHaveLength(3);
		expect(parts.join("\n")).toBe(formatHashLines(content));
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// parseTag
// ═══════════════════════════════════════════════════════════════════════════

describe("parseTag", () => {
	it("parses valid reference", () => {
		const ref = parseTag("5#QQ");
		expect(ref).toEqual({ line: 5, hash: "QQ" });
	});

	it("rejects single-character hash", () => {
		expect(() => parseTag("1#Q")).toThrow(/Invalid line reference/);
	});

	it("parses long hash by taking strict 2-char prefix", () => {
		const ref = parseTag("100#QQQQ");
		expect(ref).toEqual({ line: 100, hash: "QQ" });
	});

	it("rejects missing separator", () => {
		expect(() => parseTag("5QQ")).toThrow(/Invalid line reference/);
	});

	it("rejects non-numeric line", () => {
		expect(() => parseTag("abc#Q")).toThrow(/Invalid line reference/);
	});

	it("rejects non-alphanumeric hash", () => {
		expect(() => parseTag("5#$$$$")).toThrow(/Invalid line reference/);
	});

	it("rejects line number 0", () => {
		expect(() => parseTag("0#QQ")).toThrow(/Line number must be >= 1/);
	});

	it("rejects empty string", () => {
		expect(() => parseTag("")).toThrow(/Invalid line reference/);
	});

	it("rejects empty hash", () => {
		expect(() => parseTag("5#")).toThrow(/Invalid line reference/);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// validateLineRef
// ═══════════════════════════════════════════════════════════════════════════

describe("validateLineRef", () => {
	it("accepts valid ref with matching hash", () => {
		const lines = ["hello", "world"];
		const hash = computeLineHash(1, "hello");
		expect(() => validateLineRef({ line: 1, hash }, lines)).not.toThrow();
	});

	it("rejects line out of range (too high)", () => {
		const lines = ["hello"];
		const hash = computeLineHash(1, "hello");
		expect(() => validateLineRef({ line: 2, hash }, lines)).toThrow(/does not exist/);
	});

	it("rejects line out of range (zero)", () => {
		const lines = ["hello"];
		expect(() => validateLineRef({ line: 0, hash: "aaaa" }, lines)).toThrow(/does not exist/);
	});

	it("rejects mismatched hash", () => {
		const lines = ["hello", "world"];
		expect(() => validateLineRef({ line: 1, hash: "0000" }, lines)).toThrow(/Edit rejected:.*has changed/);
	});

	it("validates last line correctly", () => {
		const lines = ["a", "b", "c"];
		const hash = computeLineHash(3, "c");
		expect(() => validateLineRef({ line: 3, hash }, lines)).not.toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — replace
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — replace", () => {
	it("replaces single line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "replace_line", pos: makeTag(2, "bbb"), lines: ["BBB"] }];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nBBB\nccc");
		expect(result.firstChangedLine).toBe(2);
	});

	it("range replace (shrink)", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HashlineEdit[] = [
			{ op: "replace_range", pos: makeTag(2, "bbb"), end: makeTag(3, "ccc"), lines: ["ONE"] },
		];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nONE\nddd");
	});

	it("range replace (same count)", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HashlineEdit[] = [
			{ op: "replace_range", pos: makeTag(2, "bbb"), end: makeTag(3, "ccc"), lines: ["XXX", "YYY"] },
		];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nXXX\nYYY\nddd");
		expect(result.firstChangedLine).toBe(2);
	});

	it("replaces first line", () => {
		const content = "first\nsecond\nthird";
		const edits: HashlineEdit[] = [{ op: "replace_line", pos: makeTag(1, "first"), lines: ["FIRST"] }];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("FIRST\nsecond\nthird");
		expect(result.firstChangedLine).toBe(1);
	});

	it("replaces last line", () => {
		const content = "first\nsecond\nthird";
		const edits: HashlineEdit[] = [{ op: "replace_line", pos: makeTag(3, "third"), lines: ["THIRD"] }];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("first\nsecond\nTHIRD");
		expect(result.firstChangedLine).toBe(3);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — delete
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — delete", () => {
	it("deletes single line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "replace_line", pos: makeTag(2, "bbb"), lines: [] }];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nccc");
		expect(result.firstChangedLine).toBe(2);
	});

	it("deletes range of lines", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HashlineEdit[] = [
			{ op: "replace_range", pos: makeTag(2, "bbb"), end: makeTag(3, "ccc"), lines: [] },
		];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nddd");
	});

	it("deletes first line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "replace_line", pos: makeTag(1, "aaa"), lines: [] }];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("bbb\nccc");
	});

	it("deletes last line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "replace_line", pos: makeTag(3, "ccc"), lines: [] }];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nbbb");
	});

	it("replaces line with blank line when lines is ['']", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "replace_line", pos: makeTag(2, "bbb"), lines: [""] }];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\n\nccc");
		expect(result.firstChangedLine).toBe(2);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — append
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — append", () => {
	it("inserts after a line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "append_at", pos: makeTag(1, "aaa"), lines: ["NEW"] }];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nNEW\nbbb\nccc");
		expect(result.firstChangedLine).toBe(2);
	});

	it("inserts multiple lines", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "append_at", pos: makeTag(1, "aaa"), lines: ["x", "y", "z"] }];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nx\ny\nz\nbbb");
	});

	it("inserts after last line", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "append_at", pos: makeTag(2, "bbb"), lines: ["NEW"] }];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nbbb\nNEW");
	});

	it("insert with empty dst inserts an empty line", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "append_at", pos: makeTag(1, "aaa"), lines: [] }];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\n\nbbb");
		expect(result.firstChangedLine).toBe(2);
	});

	it("inserts at EOF without anchors", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "append_file", lines: ["NEW"] }];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nbbb\nNEW");
		expect(result.firstChangedLine).toBe(3);
	});

	it("inserts at EOF into empty file without anchors", () => {
		const content = "";
		const edits: HashlineEdit[] = [{ op: "append_file", lines: ["NEW"] }];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("NEW");
		expect(result.firstChangedLine).toBe(1);
	});

	it("insert at EOF with empty dst inserts a trailing empty line", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "append_file", lines: [] }];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nbbb\n");
		expect(result.firstChangedLine).toBe(3);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — prepend
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — prepend", () => {
	it("inserts before a line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "prepend_at", pos: makeTag(2, "bbb"), lines: ["NEW"] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nNEW\nbbb\nccc");
		expect(result.firstChangedLine).toBe(2);
	});

	it("inserts multiple lines before", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "prepend_at", pos: makeTag(2, "bbb"), lines: ["x", "y", "z"] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nx\ny\nz\nbbb");
	});

	it("inserts before first line", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "prepend_at", pos: makeTag(1, "aaa"), lines: ["NEW"] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("NEW\naaa\nbbb");
	});

	it("prepends at BOF without anchor", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "prepend_file", lines: ["NEW"] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("NEW\naaa\nbbb");
		expect(result.firstChangedLine).toBe(1);
	});

	it("insert with before and empty text inserts an empty line", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "prepend_at", pos: makeTag(1, "aaa"), lines: [] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("\naaa\nbbb");
		expect(result.firstChangedLine).toBe(1);
	});

	it("insert before and insert after at same line produce correct order", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{ op: "prepend_at", pos: makeTag(2, "bbb"), lines: ["BEFORE"] },
			{ op: "append_at", pos: makeTag(2, "bbb"), lines: ["AFTER"] },
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nBEFORE\nbbb\nAFTER\nccc");
	});

	it("insert before with set at same line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{ op: "prepend_at", pos: makeTag(2, "bbb"), lines: ["BEFORE"] },
			{ op: "replace_line", pos: makeTag(2, "bbb"), lines: ["BBB"] },
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nBEFORE\nBBB\nccc");
	});
});

// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — heuristics
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — heuristics", () => {
	it("accepts polluted src that starts with LINE#ID but includes trailing content", () => {
		const content = "aaa\nbbb\nccc";
		const srcHash = computeLineHash(2, "bbb");
		const edits: HashlineEdit[] = [
			{
				op: "replace_line",
				pos: parseTag(`2#${srcHash}export function foo(a, b) {}`), // comma in trailing content
				lines: ["BBB"],
			},
		];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nBBB\nccc");
	});

	it("does not override model whitespace choices in replacement content", () => {
		const content = ["import { foo } from 'x';", "import { bar } from 'y';", "const x = 1;"].join("\n");
		const edits: HashlineEdit[] = [
			{
				op: "replace_range",
				pos: makeTag(1, "import { foo } from 'x';"),
				end: makeTag(2, "import { bar } from 'y';"),
				lines: ["import {foo} from 'x';", "import { bar } from 'y';", "// added"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		const outLines = result.lines.split("\n");
		// Model's whitespace choice is respected -- no longer overridden
		expect(outLines[0]).toBe("import {foo} from 'x';");
		expect(outLines[1]).toBe("import { bar } from 'y';");
		expect(outLines[2]).toBe("// added");
		expect(outLines[3]).toBe("const x = 1;");
	});

	it("treats same-line ranges as single-line replacements", () => {
		const content = "aaa\nbbb\nccc";
		const good = makeTag(2, "bbb");
		const edits: HashlineEdit[] = [{ op: "replace_range", pos: good, end: good, lines: ["BBB"] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nBBB\nccc");
	});

	it("preserves duplicated trailing closer lines exactly as provided", () => {
		const content = "if (ok) {\n  run();\n}\nafter();";
		const edits: HashlineEdit[] = [
			{
				op: "replace_range",
				pos: makeTag(1, "if (ok) {"),
				end: makeTag(2, "  run();"),
				lines: ["if (ok) {", "  runSafe();", "}"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("if (ok) {\n  runSafe();\n}\n}\nafter();");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings?.[0]).toContain("Possible boundary duplication");
		expect(result.warnings?.[0]).toContain("set `end` to 3#RZ");
	});

	it("preserves duplicated trailing content when replacement re-emits the next line", () => {
		const content = "start\n  oldCall();\nnextCall();\nafter();";
		const edits: HashlineEdit[] = [
			{
				op: "replace_range",
				pos: makeTag(1, "start"),
				end: makeTag(2, "  oldCall();"),
				lines: ["start", "  newCall();", "nextCall();"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("start\n  newCall();\nnextCall();\nnextCall();\nafter();");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings?.[0]).toContain("Possible boundary duplication");
		expect(result.warnings?.[0]).toContain("set `end` to 3#HR");
	});

	it("preserves duplicated leading content when replacement re-emits the previous line", () => {
		const content = "if (x) {\n  oldBody();\n}\nafter();";
		const edits: HashlineEdit[] = [
			{
				op: "replace_range",
				pos: makeTag(2, "  oldBody();"),
				end: makeTag(3, "}"),
				lines: ["if (x) {", "  newBody();", "}"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("if (x) {\nif (x) {\n  newBody();\n}\nafter();");
		expect(result.warnings).toBeUndefined();
	});

	it("auto-corrects leading escaped tab indentation by default", () => {
		const previous = Bun.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
		delete Bun.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
		try {
			const content = "root\n\tchild\n\t\tvalue\nend";
			const edits: HashlineEdit[] = [
				{ op: "replace_line", pos: makeTag(3, "\t\tvalue"), lines: ["\\t\\treplaced"] },
			];
			const result = applyHashlineEdits(content, edits);
			expect(result.lines).toBe("root\n\tchild\n\t\treplaced\nend");
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings?.[0]).toContain("Auto-corrected escaped tab indentation");
		} finally {
			if (previous === undefined) delete Bun.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
			else Bun.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS = previous;
		}
	});

	it("does not auto-correct escaped tab indentation when disabled by env", () => {
		const previous = Bun.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
		Bun.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS = "0";
		try {
			const content = "root\n\tchild\n\t\tvalue\nend";
			const edits: HashlineEdit[] = [
				{ op: "replace_line", pos: makeTag(3, "\t\tvalue"), lines: ["\\t\\treplaced"] },
			];
			const result = applyHashlineEdits(content, edits);
			expect(result.lines).toBe("root\n\tchild\n\\t\\treplaced\nend");
			expect(result.warnings).toBeUndefined();
		} finally {
			if (previous === undefined) delete Bun.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
			else Bun.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS = previous;
		}
	});

	it("preserves mixed real-tab and escaped-tab content verbatim", () => {
		const previous = Bun.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
		delete Bun.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
		try {
			const content = "root\n\tchild\n\t\tvalue\nend";
			const edits: HashlineEdit[] = [
				{
					op: "replace_line",
					pos: makeTag(3, "\t\tvalue"),
					lines: ["\t\talready-tab", "\\t\\tescaped-still-literal"],
				},
			];
			const result = applyHashlineEdits(content, edits);
			expect(result.lines).toBe("root\n\tchild\n\t\talready-tab\n\\t\\tescaped-still-literal\nend");
			expect(result.warnings).toBeUndefined();
		} finally {
			if (previous === undefined) delete Bun.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS;
			else Bun.env.PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS = previous;
		}
	});

	it("warns on literal \\uDDDD without changing content", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [{ op: "replace_line", pos: makeTag(2, "bbb"), lines: ["\\uDDDD"] }];
		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\n\\uDDDD\nccc");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings?.[0]).toContain("Detected literal \\uDDDD");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — multiple edits
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — multiple edits", () => {
	it("applies two non-overlapping replaces (bottom-up safe)", () => {
		const content = "aaa\nbbb\nccc\nddd\neee";
		const edits: HashlineEdit[] = [
			{ op: "replace_line", pos: makeTag(2, "bbb"), lines: ["BBB"] },
			{ op: "replace_line", pos: makeTag(4, "ddd"), lines: ["DDD"] },
		];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nBBB\nccc\nDDD\neee");
		expect(result.firstChangedLine).toBe(2);
	});

	it("applies replace + delete in one call", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HashlineEdit[] = [
			{ op: "replace_line", pos: makeTag(2, "bbb"), lines: ["BBB"] },
			{ op: "replace_line", pos: makeTag(4, "ddd"), lines: [] },
		];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nBBB\nccc");
	});

	it("applies replace + append in one call", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{ op: "replace_line", pos: makeTag(3, "ccc"), lines: ["CCC"] },
			{ op: "append_at", pos: makeTag(1, "aaa"), lines: ["INSERTED"] },
		];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\nINSERTED\nbbb\nCCC");
	});

	it("applies non-overlapping edits against original anchors when line counts change", () => {
		const content = "one\ntwo\nthree\nfour\nfive\nsix";
		const edits: HashlineEdit[] = [
			{
				op: "replace_range",
				pos: makeTag(2, "two"),
				end: makeTag(3, "three"),
				lines: ["TWO_THREE"],
			},
			{ op: "replace_line", pos: makeTag(6, "six"), lines: ["SIX"] },
		];

		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("one\nTWO_THREE\nfour\nfive\nSIX");
	});

	it("single-line replace expanding to multiple lines is not a noop", () => {
		const content = "aaa\n\nccc";
		const blankHash = computeLineHash(2, "");
		const edits: HashlineEdit[] = [
			{ op: "replace_line", pos: { line: 2, hash: blankHash }, lines: ["", "inserted", ""] },
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.lines).toBe("aaa\n\ninserted\n\nccc");
		expect(result.firstChangedLine).toBe(2);
	});

	it("empty edits array is a no-op", () => {
		const content = "aaa\nbbb";
		const result = applyHashlineEdits(content, []);
		expect(result.lines).toBe(content);
		expect(result.firstChangedLine).toBeUndefined();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// applyHashlineEdits — error cases
// ═══════════════════════════════════════════════════════════════════════════

describe("applyHashlineEdits — errors", () => {
	it("rejects stale hash", () => {
		const content = "aaa\nbbb\nccc";
		// Use a hash that doesn't match any line (avoid 00 — ccc hashes to 00)
		const edits: HashlineEdit[] = [{ op: "replace_line", pos: parseTag("2#QQ"), lines: ["BBB"] }];
		expect(() => applyHashlineEdits(content, edits)).toThrow(HashlineMismatchError);
	});

	it("stale hash error shows >>> markers with correct hashes", () => {
		const content = "aaa\nbbb\nccc\nddd\neee";
		const edits: HashlineEdit[] = [{ op: "replace_line", pos: parseTag("2#QQ"), lines: ["BBB"] }];

		try {
			applyHashlineEdits(content, edits);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HashlineMismatchError);
			const msg = (err as HashlineMismatchError).message;
			// Should contain >>> marker on the mismatched line
			expect(msg).toContain(">>>");
			// Should show the correct hash for line 2
			const correctHash = computeLineHash(2, "bbb");
			expect(msg).toContain(`2#${correctHash}:bbb`);
			// Context lines should NOT have >>> markers
			const lines = msg.split("\n");
			const contextLines = lines.filter(l => l.startsWith("    ") && !l.startsWith("    ...") && l.includes("#"));
			expect(contextLines.length).toBeGreaterThan(0);
		}
	});

	it("stale hash error collects all mismatches", () => {
		const content = "aaa\nbbb\nccc\nddd\neee";
		// Use hashes that don't match any line (avoid 00 — ccc hashes to 00)
		const edits: HashlineEdit[] = [
			{ op: "replace_line", pos: parseTag("2#ZZ"), lines: ["BBB"] },
			{ op: "replace_line", pos: parseTag("4#ZZ"), lines: ["DDD"] },
		];

		try {
			applyHashlineEdits(content, edits);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HashlineMismatchError);
			const e = err as HashlineMismatchError;
			expect(e.mismatches).toHaveLength(2);
			expect(e.mismatches[0].line).toBe(2);
			expect(e.mismatches[1].line).toBe(4);
			// Both lines should have >>> markers
			const markerLines = e.message.split("\n").filter(l => l.startsWith(">>>"));
			expect(markerLines).toHaveLength(2);
		}
	});

	it("does not relocate stale line refs even when hash uniquely matches another line", () => {
		const content = "aaa\nbbb\nccc";
		const staleButUnique = parseTag(`2#${computeLineHash(1, "ccc")}`);
		const edits: HashlineEdit[] = [{ op: "replace_line", pos: staleButUnique, lines: ["CCC"] }];
		try {
			applyHashlineEdits(content, edits);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(HashlineMismatchError);
			const e = err as HashlineMismatchError;
			expect(e.mismatches[0].line).toBe(2);
		}
	});

	it("does not relocate when expected hash is non-unique", () => {
		const content = "dup\nmid\ndup";
		const staleDuplicate = parseTag(`2#${computeLineHash(1, "dup")}`);
		const edits: HashlineEdit[] = [{ op: "replace_line", pos: staleDuplicate, lines: ["DUP"] }];

		expect(() => applyHashlineEdits(content, edits)).toThrow(HashlineMismatchError);
	});

	it("rejects out-of-range line", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [{ op: "replace_line", pos: parseTag("10#ZZ"), lines: ["X"] }];

		expect(() => applyHashlineEdits(content, edits)).toThrow(/does not exist/);
	});

	it("rejects range with start > end", () => {
		const content = "aaa\nbbb\nccc\nddd\neee";
		const edits: HashlineEdit[] = [
			{ op: "replace_range", pos: makeTag(5, "eee"), end: makeTag(2, "bbb"), lines: ["X"] },
		];

		expect(() => applyHashlineEdits(content, edits)).toThrow();
	});

	it("accepts append/prepend with empty text by inserting empty lines", () => {
		const content = "aaa\nbbb";
		const appendEdits: HashlineEdit[] = [{ op: "append_at", pos: makeTag(1, "aaa"), lines: [] }];
		expect(applyHashlineEdits(content, appendEdits).lines).toBe("aaa\n\nbbb");

		const prependEdits: HashlineEdit[] = [{ op: "prepend_at", pos: makeTag(1, "aaa"), lines: [] }];
		expect(applyHashlineEdits(content, prependEdits).lines).toBe("\naaa\nbbb");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// buildCompactHashlineDiffPreview
// ═══════════════════════════════════════════════════════════════════════════

describe("buildCompactHashlineDiffPreview", () => {
	it("keeps trailing context for first unchanged run and hashes visible lines", () => {
		const diff = ["  1|ctx-a", "  2|ctx-b", "  3|ctx-c", "  4|ctx-d", "+ 5|added"].join("\n");

		const preview = buildCompactHashlineDiffPreview(diff);

		expect(preview.preview).not.toContain("ctx-a");
		expect(preview.preview).not.toContain("ctx-b");
		expect(preview.preview).toContain(`  3#${computeLineHash(3, "ctx-c")}|ctx-c`);
		expect(preview.preview).toContain(`  4#${computeLineHash(4, "ctx-d")}|ctx-d`);
		expect(preview.preview).toContain(" ... 2 more unchanged lines");
		expect(preview.preview).toContain(`+ 5#${computeLineHash(5, "added")}|added`);
	});

	it("collapses long addition runs and leaves removed lines unhashed", () => {
		const diff = ["  1|head", "+ 2|one", "+ 3|two", "+ 4|three", "+ 5|four", "- 2|old"].join("\n");

		const preview = buildCompactHashlineDiffPreview(diff);

		expect(preview.preview).toContain(`+ 2#${computeLineHash(2, "one")}|one`);
		expect(preview.preview).toContain(`+ 3#${computeLineHash(3, "two")}|two`);
		expect(preview.preview).toContain(" ... 2 more added lines");
		expect(preview.preview).toContain("- 2   |old");
		expect(preview.preview).not.toContain(`- 2#${computeLineHash(2, "old")}|old`);
		expect(preview.addedLines).toBe(4);
		expect(preview.removedLines).toBe(1);
	});

	it("keeps leading context for last unchanged run and hashes visible lines", () => {
		const diff = ["-10|old", "+10|new", " 11|ctx-a", " 12|ctx-b", " 13|ctx-c", " 14|ctx-d"].join("\n");

		const preview = buildCompactHashlineDiffPreview(diff);

		expect(preview.preview).toContain(`+10#${computeLineHash(10, "new")}|new`);
		expect(preview.preview).toContain(` 11#${computeLineHash(11, "ctx-a")}|ctx-a`);
		expect(preview.preview).toContain(` 12#${computeLineHash(12, "ctx-b")}|ctx-b`);
		expect(preview.preview).not.toContain("ctx-c");
		expect(preview.preview).not.toContain("ctx-d");
		expect(preview.preview).toContain(" ... 2 more unchanged lines");
	});

	it("uses new-file line numbers for unchanged lines after insertions", () => {
		const diff = ["+2|inserted", " 2|bravo", " 3|charlie"].join("\n");

		const preview = buildCompactHashlineDiffPreview(diff);

		expect(preview.preview).toContain(`+2#${computeLineHash(2, "inserted")}|inserted`);
		expect(preview.preview).toContain(` 3#${computeLineHash(3, "bravo")}|bravo`);
		expect(preview.preview).toContain(` 4#${computeLineHash(4, "charlie")}|charlie`);
		expect(preview.preview).not.toContain(` 2#${computeLineHash(2, "bravo")}|bravo`);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// stripNewLinePrefixes — regression tests for DIFF_PLUS_RE
// ═══════════════════════════════════════════════════════════════════════════

describe("stripNewLinePrefixes", () => {
	it("strips leading '+' when majority of lines start with '+'", () => {
		const lines = ["+line one", "+line two", "+line three"];
		expect(stripNewLinePrefixes(lines)).toEqual(["line one", "line two", "line three"]);
	});

	it("does NOT strip leading '-' from Markdown list items", () => {
		const lines = ["- item one", "- item two", "- item three"];
		expect(stripNewLinePrefixes(lines)).toEqual(["- item one", "- item two", "- item three"]);
	});

	it("does NOT strip leading '-' from checkbox list items", () => {
		const lines = ["- [ ] task one", "- [x] task two", "- [ ] task three"];
		expect(stripNewLinePrefixes(lines)).toEqual(["- [ ] task one", "- [x] task two", "- [ ] task three"]);
	});

	it("does NOT strip when fewer than 50% of lines start with '+'", () => {
		const lines = ["+added", "regular", "regular", "regular"];
		expect(stripNewLinePrefixes(lines)).toEqual(["+added", "regular", "regular", "regular"]);
	});

	it("strips hashline prefixes when all non-empty lines carry them", () => {
		const lines = ["1#WQ:foo", "2#TZ:bar", "3#HX:baz"];
		expect(stripNewLinePrefixes(lines)).toEqual(["foo", "bar", "baz"]);
	});

	it("strips plus hashline prefixes when all non-empty lines carry them", () => {
		const lines = ["+WQ:foo", "+TZ:bar", "+HX:baz"];
		expect(stripNewLinePrefixes(lines)).toEqual(["foo", "bar", "baz"]);
	});

	it("strips plus hashline prefixes in mixed +/ - change style", () => {
		const lines = ["-**Storage location TBD:**", "+MW:**Storage location TBD:**"];
		expect(stripNewLinePrefixes(lines)).toEqual(["-**Storage location TBD:**", "**Storage location TBD:**"]);
	});

	it("does NOT strip hashline prefixes when any non-empty line is plain content", () => {
		const lines = ["1#WQ:foo", "bar", "3#HX:baz"];
		expect(stripNewLinePrefixes(lines)).toEqual(["1#WQ:foo", "bar", "3#HX:baz"]);
	});

	it("strips hash-only prefixes when all non-empty lines carry them", () => {
		const lines = ["#WQ:", "#TZ:{{/*", "#HX:OC deployment container livenessProbe template"];
		expect(stripNewLinePrefixes(lines)).toEqual(["", "{{/*", "OC deployment container livenessProbe template"]);
	});

	it("does NOT strip comment lines that look like hashline prefixes (# Word:)", () => {
		// Regression: HASHLINE_PREFIX_RE was too broad and matched '# Note:', '# TODO:', etc.
		// A single-line replacement whose content is a comment would have nonEmpty===hashPrefixCount===1,
		// triggering stripping and eating the '# Note: ' prefix from the written line.
		expect(stripNewLinePrefixes(["  # Note: Using a fixed version"])).toEqual(["  # Note: Using a fixed version"]);
		expect(stripNewLinePrefixes(["# TODO: remove this"])).toEqual(["# TODO: remove this"]);
		expect(stripNewLinePrefixes(["# FIXME: broken"])).toEqual(["# FIXME: broken"]);
		// Bash/Python/PS1 comment with colon (e.g. setup scripts)
		expect(stripNewLinePrefixes(["  # step: do thing"])).toEqual(["  # step: do thing"]);
	});

	it("does NOT strip '+' when line starts with '++'", () => {
		const lines = ["++conflict marker", "++another"];
		expect(stripNewLinePrefixes(lines)).toEqual(["++conflict marker", "++another"]);
	});

	it("strips hashline prefixes when truncation marker is present (anchor corruption bug)", () => {
		const lines = [
			"1#BQ:---",
			"2#XS:title: example",
			"3#BQ:---",
			"",
			"[Showing lines 1-300 of 332. Use sel=L301 to continue]",
		];
		const result = stripNewLinePrefixes(lines);
		expect(result).not.toContain("[Showing lines 1-300 of 332. Use sel=L301 to continue]");
		expect(result[0]).toBe("---");
		expect(result[1]).toBe("title: example");
	});

	it("strips hashline prefixes when generic read truncation notice is present", () => {
		const lines = [
			"1#BQ:line one",
			"2#XS:line two",
			"",
			"[42 more lines in file. Use sel=L3 to continue]",
		];
		const result = stripNewLinePrefixes(lines);
		expect(result[0]).toBe("line one");
		expect(result[1]).toBe("line two");
	});

	it("strips nested hashline prefixes (already-corrupted content re-read)", () => {
		const lines = [
			"1#NX:1#BQ:---",
			"2#TY:2#XS:title: example",
			"3#JZ:3#BQ:---",
		];
		const result = stripNewLinePrefixes(lines);
		expect(result[0]).toBe("---");
		expect(result[1]).toBe("title: example");
		expect(result[2]).toBe("---");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// stripHashlinePrefixes — used by Write tool
// ═══════════════════════════════════════════════════════════════════════════

describe("stripHashlinePrefixes", () => {
	it("strips when all non-empty lines have hashline prefixes", () => {
		const lines = ["1#BQ:---", "2#XS:title", "", "4#VV:content"];
		expect(stripHashlinePrefixes(lines)).toEqual(["---", "title", "", "content"]);
	});

	it("does NOT strip when lines are plain content", () => {
		const lines = ["hello", "world"];
		expect(stripHashlinePrefixes(lines)).toBe(lines);
	});

	it("strips hashline prefixes even when truncation marker is present (anchor corruption bug)", () => {
		const lines = [
			"1#BQ:---",
			"2#XS:title: example",
			"3#BQ:---",
			"",
			"[Showing lines 1-300 of 332. Use sel=L301 to continue]",
		];
		const result = stripHashlinePrefixes(lines);
		expect(result).not.toContain("[Showing lines 1-300 of 332. Use sel=L301 to continue]");
		expect(result[0]).toBe("---");
		expect(result[1]).toBe("title: example");
	});

	it("strips nested hashline prefixes from already-corrupted content", () => {
		const lines = [
			"1#NX:1#BQ:---",
			"2#TY:2#XS:title",
		];
		const result = stripHashlinePrefixes(lines);
		expect(result[0]).toBe("---");
		expect(result[1]).toBe("title");
	});

});

// ═══════════════════════════════════════════════════════════════════════════
// hashlineParseContent — string vs array input
// ═══════════════════════════════════════════════════════════════════════════

describe("hashlineParseContent", () => {
	it("returns empty array for null", () => {
		expect(hashlineParseText(null)).toEqual([]);
	});

	it("returns array input as-is when no strip heuristic applies", () => {
		const input = ["- [x] done", "- [ ] todo"];
		expect(hashlineParseText(input)).toBe(input);
	});

	it("strips hashline prefixes from array input when all non-empty lines are prefixed", () => {
		const input = ["259#WQ:", "260#TZ:{{/*", "261#HX:OC deployment container livenessProbe template"];
		expect(hashlineParseText(input)).toEqual(["", "{{/*", "OC deployment container livenessProbe template"]);
	});

	it("strips hash-only prefixes from array input when all non-empty lines are prefixed", () => {
		const input = ["#WQ:", "#TZ:{{/*", "#HX:OC deployment container livenessProbe template"];
		expect(hashlineParseText(input)).toEqual(["", "{{/*", "OC deployment container livenessProbe template"]);
	});

	it("splits string on newline and preserves Markdown list '-' prefix", () => {
		const result = hashlineParseText("- item one\n- item two\n- item three");
		expect(result).toEqual(["- item one", "- item two", "- item three"]);
	});

	it("strips '+' diff markers from string input", () => {
		const result = hashlineParseText("+line one\n+line two");
		expect(result).toEqual(["line one", "line two"]);
	});

	it("preserves [''] as a single blank line from array input", () => {
		expect(hashlineParseText([""])).toEqual([""]);
	});

	it("preserves trailing empty strings in array input", () => {
		expect(hashlineParseText(["foo", ""])).toEqual(["foo", ""]);
	});

	it("still strips trailing empty from string split", () => {
		expect(hashlineParseText("foo\n")).toEqual(["foo"]);
	});

	it("regression: set op with Markdown list string content preserves '-' in file", () => {
		// Reproducer for the bug where DIFF_PLUS_RE = /^[+-](?![+-])/ matched '-'
		// and stripped it from every line, corrupting list-item replacements.
		const fileContent = "# Title\n- old item\n- old item 2\nfooter";
		const edits: HashlineEdit[] = [
			{
				op: "replace_line",
				pos: makeTag(2, "- old item"),
				lines: hashlineParseText("- [x] new item"),
			},
		];
		const result = applyHashlineEdits(fileContent, edits);
		expect(result.lines).toBe("# Title\n- [x] new item\n- old item 2\nfooter");
	});

	it("regression: set op replacing multiple list items preserves all '-' prefixes", () => {
		// All replacement lines start with '- ', triggering the 50% heuristic when '-' matched.
		const fileContent = "- [x] done\n- [ ] pending\n- [ ] also pending";
		const newContent = hashlineParseText("- [x] done");
		const edits: HashlineEdit[] = [{ op: "replace_line", pos: makeTag(2, "- [ ] pending"), lines: newContent }];
		const result = applyHashlineEdits(fileContent, edits);
		expect(result.lines).toBe("- [x] done\n- [x] done\n- [ ] also pending");
	});

	it("preserves comment lines starting with '# Word:' through hashlineParseText", () => {
		// Regression: HASHLINE_PREFIX_RE matched '# Note:', '# TODO:', etc. because the
		// hash ID segment was [0-9a-zA-Z]{1,16} instead of [ZPMQVRWSNKTXJBYH]{2}.
		expect(hashlineParseText(["  # Note: Using version 1.24.x"])).toEqual(["  # Note: Using version 1.24.x"]);
		expect(hashlineParseText(["# TODO: remove this"])).toEqual(["# TODO: remove this"]);
		expect(hashlineParseText(["# step: install deps"])).toEqual(["# step: install deps"]);
		expect(hashlineParseText("  # Note: v1.24.x\n  # Requires: CUDA 12")).toEqual([
			"  # Note: v1.24.x",
			"  # Requires: CUDA 12",
		]);
	});

	it("regression: replacing a comment line preserves '# Note:' prefix in output file", () => {
		// Before fix: HASHLINE_PREFIX_RE matched '# Note:' as a hashline prefix.
		// With a single replacement line the strip heuristic fired (nonEmpty===1,
		// hashPrefixCount===1), eating the comment marker and writing bare text.
		const fileContent = ["  # cuDNN section", "  # Note: Using version 1.23.0", '  $Version = "1.23.0"'].join("\n");
		const edits: HashlineEdit[] = [
			{
				op: "replace_line",
				pos: makeTag(2, "  # Note: Using version 1.23.0"),
				lines: hashlineParseText(["  # Note: Using version 1.24.x"]),
			},
		];
		const result = applyHashlineEdits(fileContent, edits);
		expect(result.lines).toBe(
			["  # cuDNN section", "  # Note: Using version 1.24.x", '  $Version = "1.23.0"'].join("\n"),
		);
	});

	it("regression: replacing a TODO comment preserves '# TODO:' prefix", () => {
		const fileContent = "const x = 1;\n// TODO: old\n# TODO: remove this\nconst y = 2;";
		const edits: HashlineEdit[] = [
			{
				op: "replace_line",
				pos: makeTag(3, "# TODO: remove this"),
				lines: hashlineParseText(["# TODO: remove this -- done"]),
			},
		];
		const result = applyHashlineEdits(fileContent, edits);
		expect(result.lines).toBe("const x = 1;\n// TODO: old\n# TODO: remove this -- done\nconst y = 2;");
	});
});
