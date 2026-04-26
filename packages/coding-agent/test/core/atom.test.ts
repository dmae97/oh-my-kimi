import { describe, expect, it } from "bun:test";
import {
	type AtomEdit,
	type AtomToolEdit,
	applyAtomEdits,
	atomEditSchema,
	computeLineHash,
	HashlineMismatchError,
	resolveAtomEntryPaths,
	resolveAtomToolEdit,
} from "@oh-my-pi/pi-coding-agent/edit";
import type { Anchor } from "@oh-my-pi/pi-coding-agent/edit/modes/hashline";
import { Value } from "@sinclair/typebox/value";

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

describe("applyAtomEdits — pre/post", () => {
	it("pre inserts above the anchor", () => {
		const content = "aaa\nbbb\nccc";
		const edits: AtomEdit[] = [{ op: "pre", pos: tag(2, "bbb"), lines: ["NEW"] }];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("aaa\nNEW\nbbb\nccc");
	});

	it("post inserts below the anchor", () => {
		const content = "aaa\nbbb\nccc";
		const edits: AtomEdit[] = [{ op: "post", pos: tag(2, "bbb"), lines: ["NEW"] }];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("aaa\nbbb\nNEW\nccc");
	});

	it("pre + post on same anchor coexist with set", () => {
		const content = "aaa\nbbb\nccc";
		const edits: AtomEdit[] = [
			{ op: "pre", pos: tag(2, "bbb"), lines: ["B"] },
			{ op: "set", pos: tag(2, "bbb"), lines: ["BBB"] },
			{ op: "post", pos: tag(2, "bbb"), lines: ["A"] },
		];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("aaa\nB\nBBB\nA\nccc");
	});
});

describe("atom edit schema", () => {
	it("rejects sub edits", () => {
		expect(Value.Check(atomEditSchema, { loc: "1ab", sub: ["5000", "30_000"] })).toBe(false);
	});
});

describe("resolveAtomToolEdit — loc syntax", () => {
	it('loc:"$" appends at EOF', () => {
		const content = "aaa\nbbb";
		const resolved = resolveAtomToolEdit({ loc: "$", post: ["ccc"] });
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.op).toBe("append_file");
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nbbb\nccc");
	});

	it('loc:"$" + pre prepends to the file', () => {
		const content = "aaa\nbbb";
		const resolved = resolveAtomToolEdit({ loc: "$", pre: ["ZZZ"] });
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.op).toBe("prepend_file");
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("ZZZ\naaa\nbbb");
	});

	it('loc:"$" + sed substitutes across all lines', () => {
		const content = "aaa\nfoo\nbar foo";
		const resolved = resolveAtomToolEdit({ loc: "$", sed: "s/foo/FOO/" });
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.op).toBe("sed_file");
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nFOO\nbar FOO");
	});

	it('loc:"$" + sed preserves trailing newline', () => {
		const content = "aaa\nbbb\n";
		const resolved = resolveAtomToolEdit({ loc: "$", sed: "s/bbb/BBB/" });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nBBB\n");
	});

	it('loc:"$" + sed throws when no line matches', () => {
		const content = "aaa\nbbb";
		const resolved = resolveAtomToolEdit({ loc: "$", sed: "s/zzz/yyy/" });
		expect(() => applyAtomEdits(content, resolved)).toThrow(/did not match any line/);
	});

	it('loc:"$" + pre + post + sed combined', () => {
		const content = "aaa\nbbb";
		const resolved = resolveAtomToolEdit({ loc: "$", pre: ["PRE"], sed: "s/bbb/BBB/", post: ["POST"] });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("PRE\naaa\nBBB\nPOST");
	});

	it('loc:"$" rejects set', () => {
		expect(() => resolveAtomToolEdit({ loc: "$", set: ["X"] })).toThrow(/supports pre, post, and sed/);
	});

	it('loc:"^" is no longer supported', () => {
		expect(() => resolveAtomToolEdit({ loc: "^", pre: ["ZZZ"] })).toThrow();
	});

	it("expands pre + set + post from one entry", () => {
		const content = "aaa\nbbb\nccc";
		const loc = `2${computeLineHash(2, "bbb")}`;
		const resolved = resolveAtomToolEdit({ loc, pre: ["B"], set: ["BBB"], post: ["A"] });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nB\nBBB\nA\nccc");
	});

	it("set: [] deletes the anchor line", () => {
		const content = "aaa\nbbb\nccc";
		const loc = `2${computeLineHash(2, "bbb")}`;
		const resolved = resolveAtomToolEdit({ loc, set: [] });
		expect(resolved[0]?.op).toBe("del");
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nccc");
	});

	it('set:[""] preserves a blank line', () => {
		const content = "aaa\nbbb\nccc";
		const loc = `2${computeLineHash(2, "bbb")}`;
		const resolved = resolveAtomToolEdit({ loc, set: [""] });
		expect(resolved[0]?.op).toBe("set");
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\n\nccc");
	});

	it("ignores null optional verb fields", () => {
		const content = "aaa\nbbb\nccc";
		const loc = `2${computeLineHash(2, "bbb")}`;
		const toolEdit = { loc, pre: null, set: "BBB", post: null } as unknown as AtomToolEdit;
		const resolved = resolveAtomToolEdit(toolEdit);
		expect(resolved).toEqual([{ op: "set", pos: tag(2, "bbb"), lines: ["BBB"] }]);

		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nBBB\nccc");
	});

	it("supports path override inside loc", () => {
		const resolved = resolveAtomEntryPaths([{ loc: "a.ts:1ab", set: ["X"] }], undefined);
		expect(resolved[0]?.path).toBe("a.ts");
		expect(resolved[0]?.loc).toBe("1ab");
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
		const toolEdit = { path: "a.ts", loc: "2XG", set: ["BRAVO"] };
		const resolved = resolveAtomToolEdit(toolEdit);
		expect(() => applyAtomEdits(content, resolved)).toThrow(HashlineMismatchError);
		try {
			applyAtomEdits(content, resolved);
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toMatch(/^\d+[a-z]{2}:/m);
			expect(msg).toContain("bravo");
			expect(msg).toContain(`2${computeLineHash(2, "bravo")}`);
		}
	});

	it("surfaces correct anchor + content when the model omits the hash entirely", () => {
		const content = "alpha\nbravo\ncharlie";
		const toolEdit = { path: "a.ts", loc: "2", set: ["BRAVO"] };
		const resolved = resolveAtomToolEdit(toolEdit);
		expect(() => applyAtomEdits(content, resolved)).toThrow(HashlineMismatchError);
	});

	it("surfaces correct anchor when the model uses pipe-separator (LINE|content) form", () => {
		const content = "alpha\nbravo\ncharlie";
		const toolEdit = { path: "a.ts", loc: "2|bravo", set: ["BRAVO"] };
		const resolved = resolveAtomToolEdit(toolEdit);
		expect(() => applyAtomEdits(content, resolved)).toThrow(HashlineMismatchError);
	});

	it("throws a usage-style error when no line number can be extracted", () => {
		const toolEdit = { path: "a.ts", loc: "  if (!x) return;", set: ["x"] };
		expect(() => resolveAtomToolEdit(toolEdit)).toThrow(/Could not find a line number/);
	});
});
describe("atom range locators", () => {
	it("resolveAtomToolEdit rejects range loc with set", () => {
		expect(() => resolveAtomToolEdit({ loc: "1xx-4yy", set: ["X"] })).toThrow(
			/does not support line ranges/,
		);
	});

	it("resolveAtomToolEdit rejects range loc even when the verb would otherwise be valid", () => {
		expect(() => resolveAtomToolEdit({ loc: "1xx-4yy", pre: ["X"] })).toThrow(
			/does not support line ranges/,
		);
	});

	it("resolveAtomEntryPaths still peels off a path override before range validation", () => {
		const [resolved] = resolveAtomEntryPaths([{ loc: "a.ts:1xx-4yy", set: ["X"] }], undefined);
		expect(resolved?.path).toBe("a.ts");
		expect(resolved?.loc).toBe("1xx-4yy");
		expect(() => resolveAtomToolEdit(resolved!)).toThrow(/does not support line ranges/);
	});

	it("accepts a single anchor even when the line content contains `--`", () => {
		// Models sometimes paste line content after the anchor, e.g.
		// `loc: "82zu|  for (let i = 0; i--; ...) {"`. The bare `--` in the content
		// must not be mistaken for range syntax.
		const content = "alpha\nbravo\ncharlie";
		const loc = `2${computeLineHash(2, "bravo")}|  for (let i = 0; i--; ...) {`;
		const resolved = resolveAtomToolEdit({ loc, set: ["BRAVO"] });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("alpha\nBRAVO\ncharlie");
	});

	it("resolveAtomEntryPaths peels off path even when the loc content suffix contains colons", () => {
		// Mimics a real failure: model wrote `image-input.ts:263ti| " const data: x"`.
		// `lastIndexOf(":")` would have picked the colon inside `data:` and broken the split.
		const [resolved] = resolveAtomEntryPaths(
			[{ loc: 'image-input.ts:263ti| " const data: x"', sed: "s/x/y/" }],
			undefined,
		);
		expect(resolved?.path).toBe("image-input.ts");
		expect(resolved?.loc).toBe('263ti| " const data: x"');
	});
});

describe("applyAtomEdits — sed", () => {
	it("applies a regex substitution to the anchored line", () => {
		const content = "aaa\nfoo bar foo\nccc";
		const loc = `2${computeLineHash(2, "foo bar foo")}`;
		const resolved = resolveAtomToolEdit({ loc, sed: "s/foo/baz/" });
		expect(resolved[0]?.op).toBe("sed");
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nbaz bar foo\nccc");
	});

	it("applies the global flag", () => {
		const content = "foo foo foo";
		const loc = `1${computeLineHash(1, "foo foo foo")}`;
		const resolved = resolveAtomToolEdit({ loc, sed: "s/foo/bar/g" });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("bar bar bar");
	});

	it("supports alternative delimiters", () => {
		const content = "path = /usr/local/bin";
		const loc = `1${computeLineHash(1, "path = /usr/local/bin")}`;
		const resolved = resolveAtomToolEdit({ loc, sed: "s|/usr/local|/opt|" });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("path = /opt/bin");
	});

	it("F flag treats pattern as a literal string", () => {
		const content = "a.b.c";
		const loc = `1${computeLineHash(1, "a.b.c")}`;
		const resolved = resolveAtomToolEdit({ loc, sed: "s/./X/gF" });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aXbXc");
	});

	it("throws when pattern does not match the anchor line", () => {
		const content = "aaa\nbbb";
		const loc = `2${computeLineHash(2, "bbb")}`;
		const resolved = resolveAtomToolEdit({ loc, sed: "s/zzz/yyy/" });
		expect(() => applyAtomEdits(content, resolved)).toThrow(/did not match line 2/);
	});

	it("combines with pre and post on the same anchor", () => {
		const content = "aaa\nfoo\nccc";
		const loc = `2${computeLineHash(2, "foo")}`;
		const resolved = resolveAtomToolEdit({ loc, pre: ["BEFORE"], sed: "s/foo/FOO/", post: ["AFTER"] });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nBEFORE\nFOO\nAFTER\nccc");
	});

	it("prefers set when sed is also present on the same anchor", () => {
		const content = "aaa\nfoo\nccc";
		const loc = `2${computeLineHash(2, "foo")}`;
		const resolved = resolveAtomToolEdit({ loc, set: ["X"], sed: "s/foo/Y/" });
		// Models sometimes duplicate intent on the same line; the explicit `set`
		// wins and the redundant `sed` is dropped silently.
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nX\nccc");
	});

	it("tolerates a missing leading `s` when the body starts with a valid delimiter", () => {
		const content = "alpha\nfoo bar\nccc";
		const loc = `2${computeLineHash(2, "foo bar")}`;
		const resolved = resolveAtomToolEdit({ loc, sed: "/foo/baz/" });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("alpha\nbaz bar\nccc");
	});

	it("rejects malformed sed expressions", () => {
		const loc = "1ab";
		expect(() => resolveAtomToolEdit({ loc, sed: "foo/bar/" })).toThrow(
			/sed delimiter must be|must start with/,
		);
		expect(() => resolveAtomToolEdit({ loc, sed: "s/foo" })).toThrow(/Expected three/);
		expect(() => resolveAtomToolEdit({ loc, sed: "s/foo/bar/q" })).toThrow(/unknown sed flag/);
	});

	it("falls back to literal substring when regex parens consume incorrectly", () => {
		// Pattern `foo(a, b)` is valid regex but the `(a, b)` group does not match
		// the literal parens in the line. Falling back to literal lets the obvious
		// intent succeed.
		const content = "return wrap(foo(a, b));";
		const loc = `1${computeLineHash(1, content)}`;
		const resolved = resolveAtomToolEdit({ loc, sed: "s/foo(a, b)/foo(b, a)/" });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("return wrap(foo(b, a));");
		expect(result.warnings?.some(w => w.includes("literal substring substitution"))).toBe(true);
	});

	it("falls back to literal substring when regex fails to compile", () => {
		// Unbalanced `)` is invalid regex; literal fallback recovers.
		const content = "x = bar());";
		const loc = `1${computeLineHash(1, content)}`;
		const resolved = resolveAtomToolEdit({ loc, sed: "s/bar())/baz()/" });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("x = baz();");
	});

	it("reports compile error when literal fallback also misses", () => {
		const content = "hello world";
		const loc = `1${computeLineHash(1, content)}`;
		const resolved = resolveAtomToolEdit({ loc, sed: "s/zzz)/baz/" });
		expect(() => applyAtomEdits(content, resolved)).toThrow(/failed to compile/);
	});

	it("treats empty `set: []` as no-op when paired with sed", () => {
		const content = "aaa\nfoo\nccc";
		const loc = `2${computeLineHash(2, "foo")}`;
		const resolved = resolveAtomToolEdit({ loc, set: [], sed: "s/foo/FOO/" });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nFOO\nccc");
	});
});
