import { describe, expect, it } from "bun:test";
import { validateFindPathInputs } from "../../src/tools/find";

describe("validateFindPathInputs", () => {
	it("accepts a normal array of glob entries", () => {
		expect(() => validateFindPathInputs(["src/**/*.ts", "test/**/*.ts"])).not.toThrow();
	});

	it('rejects comma-joined entries (the `["a,b"]` shape)', () => {
		expect(() => validateFindPathInputs(["a.py,b.py"])).toThrow(/paths is an array/);
	});

	it("allows commas inside brace expansion", () => {
		expect(() => validateFindPathInputs(["src/{a,b}/*.ts"])).not.toThrow();
		expect(() => validateFindPathInputs(["{foo,bar,baz}.md"])).not.toThrow();
	});

	it("allows backslash-escaped commas at top level (matches search.ts:containsTopLevelComma)", () => {
		// Backslash-escapes a literal comma in a filename — must not trip the
		// array-vs-string heuristic.
		expect(() => validateFindPathInputs(["weird\\,name.txt"])).not.toThrow();
		expect(() => validateFindPathInputs(["a\\,b\\,c"])).not.toThrow();
	});

	it("still rejects unescaped top-level commas mixed with escaped ones", () => {
		// `a\,b,c` — the second comma is unescaped, so the heuristic should fire.
		expect(() => validateFindPathInputs(["a\\,b,c"])).toThrow(/paths is an array/);
	});

	it("allows a trailing backslash without crashing", () => {
		// `foo\\` is a backslash at end-of-string; the i+1<length guard must hold.
		expect(() => validateFindPathInputs(["foo\\"])).not.toThrow();
	});

	it("treats `\\{a,b}` as an escaped brace, so the inner comma is still top-level", () => {
		// Skip-next semantics: the backslash consumes the `{`, so braceDepth stays 0
		// and the unescaped `,` between `a` and `b` rejects. This pins the literal
		// behavior of the new escape-skip, which intentionally does NOT model glob
		// brace semantics — it only mirrors search.ts's containsTopLevelComma.
		expect(() => validateFindPathInputs(["\\{a,b}"])).toThrow(/paths is an array/);
	});
});
