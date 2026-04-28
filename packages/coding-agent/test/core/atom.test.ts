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

describe("applyAtomEdits — splice", () => {
	it("replaces a single line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: AtomEdit[] = [{ op: "splice", pos: tag(2, "bbb"), lines: ["BBB"] }];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("aaa\nBBB\nccc");
		expect(result.firstChangedLine).toBe(2);
	});

	it("expands one line into many", () => {
		const content = "aaa\nbbb\nccc";
		const edits: AtomEdit[] = [{ op: "splice", pos: tag(2, "bbb"), lines: ["X", "Y", "Z"] }];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("aaa\nX\nY\nZ\nccc");
	});

	it("rejects on stale hash", () => {
		const content = "aaa\nbbb\nccc";
		const edits: AtomEdit[] = [{ op: "splice", pos: { line: 2, hash: "ZZ" }, lines: ["BBB"] }];
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

	it("pre + post on same anchor coexist with splice", () => {
		const content = "aaa\nbbb\nccc";
		const edits: AtomEdit[] = [
			{ op: "pre", pos: tag(2, "bbb"), lines: ["B"] },
			{ op: "splice", pos: tag(2, "bbb"), lines: ["BBB"] },
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

	it("rejects bracketed loc forms (no longer supported)", () => {
		// `(A)` and `[A]` were dropped — they are valid at the schema level
		// (loc is a string) but the runtime parser rejects anything that isn't
		// a bare anchor or `$`.
		expect(() => resolveAtomToolEdit({ loc: "(2ab)", splice: ["X"] })).toThrow();
		expect(() => resolveAtomToolEdit({ loc: "[2ab]", splice: ["X"] })).toThrow();
	});

	it("rejects sed-shaped replace specs", () => {
		expect(Value.Check(atomEditSchema, { loc: "1ab", sed: { pat: "x", rep: "y" } })).toBe(false);
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

	it('loc:"$" + replace substitutes across all lines', () => {
		const content = "aaa\nfoo\nbar foo";
		const resolved = resolveAtomToolEdit({ loc: "$", replace: { find: "foo", with: "FOO" } });
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.op).toBe("replace_file");
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nFOO\nbar FOO");
	});

	it('loc:"$" + replace with all:true substitutes every occurrence', () => {
		const content = "aaa\nfoo foo\nbar foo";
		const resolved = resolveAtomToolEdit({ loc: "$", replace: { find: "foo", with: "FOO", all: true } });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nFOO FOO\nbar FOO");
	});

	it('loc:"$" + replace preserves trailing newline', () => {
		const content = "aaa\nbbb\n";
		const resolved = resolveAtomToolEdit({ loc: "$", replace: { find: "bbb", with: "BBB" } });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nBBB\n");
	});

	it('loc:"$" + replace throws when no line matches', () => {
		const content = "aaa\nbbb";
		const resolved = resolveAtomToolEdit({ loc: "$", replace: { find: "zzz", with: "yyy" } });
		expect(() => applyAtomEdits(content, resolved)).toThrow(/did not match any line/);
	});

	it('loc:"$" + pre + post + replace combined', () => {
		const content = "aaa\nbbb";
		const resolved = resolveAtomToolEdit({
			loc: "$",
			pre: ["PRE"],
			replace: { find: "bbb", with: "BBB" },
			post: ["POST"],
		});
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("PRE\naaa\nBBB\nPOST");
	});

	it('loc:"$" rejects splice', () => {
		expect(() => resolveAtomToolEdit({ loc: "$", splice: ["X"] })).toThrow(/supports pre, post, and replace/);
	});

	it('loc:"^" is no longer supported', () => {
		expect(() => resolveAtomToolEdit({ loc: "^", pre: ["ZZZ"] })).toThrow();
	});

	it("expands pre + splice + post from one entry", () => {
		const content = "aaa\nbbb\nccc";
		const loc = `2${computeLineHash(2, "bbb")}`;
		const resolved = resolveAtomToolEdit({ loc, pre: ["B"], splice: ["BBB"], post: ["A"] });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nB\nBBB\nA\nccc");
	});

	it("splice: [] deletes the anchor line", () => {
		const content = "aaa\nbbb\nccc";
		const loc = `2${computeLineHash(2, "bbb")}`;
		const resolved = resolveAtomToolEdit({ loc, splice: [] });
		expect(resolved[0]?.op).toBe("del");
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nccc");
	});

	it('splice: [""] preserves a blank line', () => {
		const content = "aaa\nbbb\nccc";
		const loc = `2${computeLineHash(2, "bbb")}`;
		const resolved = resolveAtomToolEdit({ loc, splice: [""] });
		expect(resolved[0]?.op).toBe("splice");
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\n\nccc");
	});

	it("ignores null optional verb fields", () => {
		const content = "aaa\nbbb\nccc";
		const loc = `2${computeLineHash(2, "bbb")}`;
		const toolEdit = { loc, pre: null, splice: "BBB", post: null } as unknown as AtomToolEdit;
		const resolved = resolveAtomToolEdit(toolEdit);
		expect(resolved).toEqual([{ op: "splice", pos: tag(2, "bbb"), lines: ["BBB"] }]);

		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nBBB\nccc");
	});

	it("supports path override inside loc", () => {
		const resolved = resolveAtomEntryPaths([{ loc: "a.ts:1ab", splice: ["X"] }], undefined);
		expect(resolved[0]?.path).toBe("a.ts");
		expect(resolved[0]?.loc).toBe("1ab");
	});

	it("accepts a content-suffix anchor and uses it for hint-based rebase", () => {
		// Models sometimes paste line content after the anchor, e.g.
		// `loc: "82zu|  for (let i = 0; i--; ...) {"`. The bare `--` in the content
		// must not break parsing.
		const content = "alpha\nbravo\ncharlie";
		const loc = `2${computeLineHash(2, "bravo")}|  for (let i = 0; i--; ...) {`;
		const resolved = resolveAtomToolEdit({ loc, splice: ["BRAVO"] });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("alpha\nBRAVO\ncharlie");
	});

	it("resolveAtomEntryPaths peels off path even when the loc content suffix contains colons", () => {
		// Mimics a real failure: model wrote `image-input.ts:263ti| " const data: x"`.
		// `lastIndexOf(":")` would have picked the colon inside `data:` and broken the split.
		const [resolved] = resolveAtomEntryPaths(
			[{ loc: 'image-input.ts:263ti| " const data: x"', replace: { find: "x", with: "y" } }],
			undefined,
		);
		expect(resolved?.path).toBe("image-input.ts");
		expect(resolved?.loc).toBe('263ti| " const data: x"');
	});
});

describe("applyAtomEdits — out of range", () => {
	it("rejects line beyond file length", () => {
		const content = "aaa\nbbb";
		const edits: AtomEdit[] = [{ op: "splice", pos: { line: 99, hash: "ZZ" }, lines: ["x"] }];
		expect(() => applyAtomEdits(content, edits)).toThrow(/does not exist/);
	});
});

describe("parseAnchor (atom tolerant) + applyAtomEdits", () => {
	it("surfaces correct anchor + content when the model invents an out-of-alphabet hash", () => {
		const content = "alpha\nbravo\ncharlie";
		// `XG` is not in the alphabet; should be rejected with the actual anchor exposed.
		const toolEdit = { path: "a.ts", loc: "2XG", splice: ["BRAVO"] };
		const resolved = resolveAtomToolEdit(toolEdit);
		expect(() => applyAtomEdits(content, resolved)).toThrow(HashlineMismatchError);
		try {
			applyAtomEdits(content, resolved);
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toMatch(/^\*\d+[a-z]{2}\|/m);
			expect(msg).toContain("bravo");
			expect(msg).toContain(`2${computeLineHash(2, "bravo")}`);
		}
	});

	it("surfaces correct anchor + content when the model omits the hash entirely", () => {
		const content = "alpha\nbravo\ncharlie";
		const toolEdit = { path: "a.ts", loc: "2", splice: ["BRAVO"] };
		const resolved = resolveAtomToolEdit(toolEdit);
		expect(() => applyAtomEdits(content, resolved)).toThrow(HashlineMismatchError);
	});

	it("surfaces correct anchor when the model uses pipe-separator (LINE|content) form", () => {
		const content = "alpha\nbravo\ncharlie";
		const toolEdit = { path: "a.ts", loc: "2|bravo", splice: ["BRAVO"] };
		const resolved = resolveAtomToolEdit(toolEdit);
		expect(() => applyAtomEdits(content, resolved)).toThrow(HashlineMismatchError);
	});

	it("throws a usage-style error when no line number can be extracted", () => {
		const toolEdit = { path: "a.ts", loc: "  if (!x) return;", splice: ["x"] };
		expect(() => resolveAtomToolEdit(toolEdit)).toThrow(/Could not find a line number/);
	});
});

describe("applyAtomEdits — replace", () => {
	it("applies a literal substring substitution to the anchored line (first occurrence by default)", () => {
		const content = "aaa\nfoo bar foo\nccc";
		const loc = `2${computeLineHash(2, "foo bar foo")}`;
		const resolved = resolveAtomToolEdit({ loc, replace: { find: "foo", with: "baz" } });
		expect(resolved[0]?.op).toBe("replace");
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nbaz bar foo\nccc");
	});

	it("`all: true` replaces every occurrence on the line", () => {
		const content = "foo foo foo";
		const loc = `1${computeLineHash(1, "foo foo foo")}`;
		const first = resolveAtomToolEdit({ loc, replace: { find: "foo", with: "bar" } });
		expect(applyAtomEdits(content, first).lines).toBe("bar foo foo");
		const all = resolveAtomToolEdit({ loc, replace: { find: "foo", with: "bar", all: true } });
		expect(applyAtomEdits(content, all).lines).toBe("bar bar bar");
	});

	it("treats regex metacharacters as literal", () => {
		// `(a, b)` would be a capture group in regex; here it must match the
		// literal parens in the source line.
		const content = "return wrap(foo(a, b));";
		const loc = `1${computeLineHash(1, content)}`;
		const resolved = resolveAtomToolEdit({ loc, replace: { find: "foo(a, b)", with: "foo(b, a)" } });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("return wrap(foo(b, a));");
	});

	it("treats unbalanced parens as literal characters, not as a regex error", () => {
		const content = "x = bar());";
		const loc = `1${computeLineHash(1, content)}`;
		const resolved = resolveAtomToolEdit({ loc, replace: { find: "bar())", with: "baz()" } });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("x = baz();");
	});

	it("throws when the literal substring is not present on the anchor line", () => {
		const content = "aaa\nbbb";
		const loc = `2${computeLineHash(2, "bbb")}`;
		const resolved = resolveAtomToolEdit({ loc, replace: { find: "zzz", with: "yyy" } });
		expect(() => applyAtomEdits(content, resolved)).toThrow(/did not match line 2/);
	});

	it("combines with pre and post on the same anchor", () => {
		const content = "aaa\nfoo\nccc";
		const loc = `2${computeLineHash(2, "foo")}`;
		const resolved = resolveAtomToolEdit({
			loc,
			pre: ["BEFORE"],
			replace: { find: "foo", with: "FOO" },
			post: ["AFTER"],
		});
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nBEFORE\nFOO\nAFTER\nccc");
	});

	it("prefers splice when replace is also present on the same anchor", () => {
		const content = "aaa\nfoo\nccc";
		const loc = `2${computeLineHash(2, "foo")}`;
		const resolved = resolveAtomToolEdit({ loc, splice: ["X"], replace: { find: "foo", with: "Y" } });
		// Models sometimes duplicate intent on the same line; the explicit `splice`
		// wins and the redundant `replace` is dropped silently.
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nX\nccc");
	});

	it("treats empty `splice: []` as no-op when paired with replace", () => {
		const content = "aaa\nfoo\nccc";
		const loc = `2${computeLineHash(2, "foo")}`;
		const resolved = resolveAtomToolEdit({ loc, splice: [], replace: { find: "foo", with: "FOO" } });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nFOO\nccc");
	});

	it("rejects replace.find containing a newline with a splice hint", () => {
		const loc = "1ab";
		expect(() => resolveAtomToolEdit({ loc, replace: { find: "a\nb", with: "x" } })).toThrow(
			/must be a single line.*splice/,
		);
	});

	it("supports replace.with containing a newline", () => {
		const content = "aaa\nfoo\nccc";
		const loc = `2${computeLineHash(2, "foo")}`;
		const resolved = resolveAtomToolEdit({ loc, replace: { find: "foo", with: "x\ny" } });
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("aaa\nx\ny\nccc");
	});

	it("drops cross-entry `del` when another edit replaces the same anchor", () => {
		// Models sometimes emit a `splice: []` cleanup alongside a `replace`/`splice` that
		// already replaces the line. Prefer the replacement and silently drop the del.
		const content = "aaa\nfoo\nccc";
		const loc = `2${computeLineHash(2, "foo")}`;
		const edits = [
			...resolveAtomToolEdit({ loc, replace: { find: "foo", with: "FOO" } }),
			...resolveAtomToolEdit({ loc, splice: [] }),
		];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("aaa\nFOO\nccc");
	});
});
