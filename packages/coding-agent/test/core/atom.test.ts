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

	it('loc:"^" prepends at BOF', () => {
		const content = "aaa\nbbb";
		const resolved = resolveAtomToolEdit({ loc: "^", pre: ["ZZZ"] });
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.op).toBe("prepend_file");
		const result = applyAtomEdits(content, resolved);
		expect(result.lines).toBe("ZZZ\naaa\nbbb");
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
		expect(() => resolveAtomToolEdit({ path: "a.ts", loc: "1xx-4yy", set: ["X"] })).toThrow(
			/does not support line ranges/,
		);
	});

	it("resolveAtomToolEdit rejects range loc even when the verb would otherwise be valid", () => {
		expect(() => resolveAtomToolEdit({ path: "a.ts", loc: "1xx-4yy", pre: ["X"] })).toThrow(
			/does not support line ranges/,
		);
	});

	it("resolveAtomEntryPaths still peels off a path override before range validation", () => {
		const [resolved] = resolveAtomEntryPaths([{ loc: "a.ts:1xx-4yy", set: ["X"] }], undefined);
		expect(resolved?.path).toBe("a.ts");
		expect(resolved?.loc).toBe("1xx-4yy");
		expect(() => resolveAtomToolEdit(resolved!)).toThrow(/does not support line ranges/);
	});
});
