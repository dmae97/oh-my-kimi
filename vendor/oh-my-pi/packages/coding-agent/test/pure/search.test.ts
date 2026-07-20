import { describe, expect, it } from "bun:test";
import {
	planSearch,
	presentSearch,
	SEARCH_DEFAULT_LIMIT,
	type SearchConflict,
	type SearchHostMatch,
	type SearchIssue,
	type SearchPlan,
	type SearchPlanResult,
	type SearchPresentation,
	type SearchPresentResult,
} from "@oh-my-pi/pi-coding-agent/pure/search";

function planOf(result: SearchPlanResult): SearchPlan {
	if (!result.ok) throw new Error(`expected ok plan, got issues: ${JSON.stringify(result.issues)}`);
	return result.plan;
}

function issuesOf(result: SearchPlanResult): readonly SearchIssue[] {
	if (result.ok) throw new Error("expected issues, got ok plan");
	return result.issues;
}

function issueShapes(result: SearchPlanResult): Array<{ field: string; code: string }> {
	return issuesOf(result).map(entry => ({ field: entry.field, code: entry.code }));
}

function presentationOf(result: SearchPresentResult): SearchPresentation {
	if (!result.ok) throw new Error(`expected ok presentation, got conflicts: ${JSON.stringify(result.conflicts)}`);
	return result.presentation;
}

function conflictsOf(result: SearchPresentResult): readonly SearchConflict[] {
	if (result.ok) throw new Error("expected conflicts, got ok presentation");
	return result.conflicts;
}

const basePlan: SearchPlan = { pattern: "x", path: ".", ignoreCase: false, literal: false, context: 0, limit: 100 };

describe("planSearch", () => {
	it("rejects non-record input with a single input/not_record issue", () => {
		for (const input of [null, undefined, 3, "pattern", ["pattern"]]) {
			expect(issueShapes(planSearch(input))).toEqual([{ field: "input", code: "not_record" }]);
		}
	});

	it("requires pattern and rejects non-string or blank patterns", () => {
		expect(issueShapes(planSearch({}))).toEqual([{ field: "pattern", code: "missing" }]);
		expect(issueShapes(planSearch({ pattern: 7 }))).toEqual([{ field: "pattern", code: "not_string" }]);
		expect(issueShapes(planSearch({ pattern: "   " }))).toEqual([{ field: "pattern", code: "empty" }]);
	});

	it("rejects invalid regex only when literal is false", () => {
		expect(issueShapes(planSearch({ pattern: "(" }))).toEqual([{ field: "pattern", code: "invalid_regex" }]);
		expect(issueShapes(planSearch({ pattern: "(", literal: false }))).toEqual([
			{ field: "pattern", code: "invalid_regex" },
		]);
		const literalPlan = planOf(planSearch({ pattern: "(", literal: true }));
		expect(literalPlan.pattern).toBe("(");
		expect(literalPlan.literal).toBe(true);
	});

	it("applies OMK grep defaults and omits glob when absent", () => {
		expect(SEARCH_DEFAULT_LIMIT).toBe(100);
		const plan = planOf(planSearch({ pattern: "foo" }));
		expect(plan).toEqual({
			pattern: "foo",
			path: ".",
			ignoreCase: false,
			literal: false,
			context: 0,
			limit: SEARCH_DEFAULT_LIMIT,
		});
		expect("glob" in plan).toBe(false);
	});

	it("passes through explicit fields preserving pattern/path/glob bytes", () => {
		expect(
			planOf(
				planSearch({
					pattern: " a|b ",
					path: " src ",
					glob: "**/*.ts",
					ignoreCase: true,
					literal: true,
					context: 2,
					limit: 5,
				}),
			),
		).toEqual({
			pattern: " a|b ",
			path: " src ",
			glob: "**/*.ts",
			ignoreCase: true,
			literal: true,
			context: 2,
			limit: 5,
		});
	});

	it("rejects non-string or blank path/glob", () => {
		expect(issueShapes(planSearch({ pattern: "a", path: 42 }))).toEqual([{ field: "path", code: "not_string" }]);
		expect(issueShapes(planSearch({ pattern: "a", path: " " }))).toEqual([{ field: "path", code: "empty" }]);
		expect(issueShapes(planSearch({ pattern: "a", glob: 42 }))).toEqual([{ field: "glob", code: "not_string" }]);
		expect(issueShapes(planSearch({ pattern: "a", glob: "" }))).toEqual([{ field: "glob", code: "empty" }]);
	});

	it("rejects non-boolean ignoreCase/literal", () => {
		expect(issueShapes(planSearch({ pattern: "a", ignoreCase: "yes" }))).toEqual([
			{ field: "ignoreCase", code: "not_boolean" },
		]);
		expect(issueShapes(planSearch({ pattern: "a", literal: 1 }))).toEqual([
			{ field: "literal", code: "not_boolean" },
		]);
	});

	it("validates context/limit as safe integers with context >= 0 and limit >= 1", () => {
		expect(planOf(planSearch({ pattern: "a", context: 0, limit: 1 }))).toMatchObject({ context: 0, limit: 1 });
		expect(issueShapes(planSearch({ pattern: "a", context: -1 }))).toEqual([
			{ field: "context", code: "out_of_range" },
		]);
		expect(issueShapes(planSearch({ pattern: "a", limit: 0 }))).toEqual([{ field: "limit", code: "out_of_range" }]);
		expect(issueShapes(planSearch({ pattern: "a", context: 1.5, limit: 2 ** 53 }))).toEqual([
			{ field: "context", code: "not_integer" },
			{ field: "limit", code: "not_integer" },
		]);
	});

	it("collects all issues in field order", () => {
		expect(
			issueShapes(planSearch({ pattern: "(", path: "", glob: 1, ignoreCase: "y", context: -2, limit: 0 })),
		).toEqual([
			{ field: "pattern", code: "invalid_regex" },
			{ field: "path", code: "empty" },
			{ field: "glob", code: "not_string" },
			{ field: "ignoreCase", code: "not_boolean" },
			{ field: "context", code: "out_of_range" },
			{ field: "limit", code: "out_of_range" },
		]);
	});

	it("returns deeply frozen results", () => {
		const ok = planSearch({ pattern: "a" });
		expect(Object.isFrozen(ok)).toBe(true);
		expect(Object.isFrozen(planOf(ok))).toBe(true);
		const bad = planSearch({});
		expect(Object.isFrozen(issuesOf(bad))).toBe(true);
		expect(Object.isFrozen(issuesOf(bad)[0])).toBe(true);
	});
});

describe("presentSearch", () => {
	it("groups matches deterministically preserving column and line-hash records", () => {
		const matches: readonly SearchHostMatch[] = [
			{ file: "src/b.ts", line: 3, text: "const x = 1;", expectedLineHash: "hb3" },
			{ file: "src/a.ts", line: 10, column: 4, text: "foo()" },
			{ file: "src/b.ts", line: 1, text: "import x" },
			{ file: "src/a.ts", line: 2, text: "bar()", expectedLineHash: "ha2" },
		];
		const presentation = presentationOf(presentSearch(basePlan, matches, [{ path: "src/a.ts", digest: "da" }]));
		expect(presentation.groups.map(group => group.file)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(presentation.groups[0]?.digest).toBe("da");
		expect(presentation.groups[0]?.matches).toEqual([
			{ line: 2, text: "bar()", expectedLineHash: "ha2" },
			{ line: 10, column: 4, text: "foo()" },
		]);
		expect(presentation.groups[1]?.digest).toBeUndefined();
		expect(presentation.text).toBe(
			"[src/a.ts#sha256:da]\n2@sha256:ha2|bar()\n10|foo()\n\nsrc/b.ts\n1|import x\n3@sha256:hb3|const x = 1;",
		);
		expect(presentation).toMatchObject({ totalFiles: 2, totalMatches: 4, omittedMatches: 0, truncated: false });
	});

	it("merges duplicate file+line matches keeping the first occurrence and agreeing hashes", () => {
		const presentation = presentationOf(
			presentSearch(basePlan, [
				{ file: "a.ts", line: 1, column: 2, text: "x" },
				{ file: "a.ts", line: 1, text: "x again", expectedLineHash: "h1" },
				{ file: "a.ts", line: 2, text: "y" },
			]),
		);
		expect(presentation.totalMatches).toBe(2);
		expect(presentation.groups[0]?.matches).toEqual([
			{ line: 1, column: 2, text: "x", expectedLineHash: "h1" },
			{ line: 2, text: "y" },
		]);
	});

	it("rejects duplicate file+line matches with disagreeing expectedLineHash", () => {
		const result = presentSearch(basePlan, [
			{ file: "a.ts", line: 1, text: "x", expectedLineHash: "h1" },
			{ file: "a.ts", line: 1, text: "x", expectedLineHash: "h2" },
		]);
		expect(conflictsOf(result)).toEqual([{ kind: "line_hash", file: "a.ts", line: 1, hashes: ["h1", "h2"] }]);
		expect(Object.isFrozen(conflictsOf(result)[0])).toBe(true);
	});

	it("rejects conflicting duplicate source digests before line conflicts", () => {
		const result = presentSearch(
			basePlan,
			[
				{ file: "a.ts", line: 1, text: "x", expectedLineHash: "h1" },
				{ file: "a.ts", line: 1, text: "x", expectedLineHash: "h2" },
			],
			[
				{ path: "b.ts", digest: "d1" },
				{ path: "b.ts", digest: "d2" },
				{ path: "a.ts", digest: "da" },
				{ path: "a.ts", digest: "da" },
			],
		);
		expect(conflictsOf(result)).toEqual([
			{ kind: "source_digest", path: "b.ts", digests: ["d1", "d2"] },
			{ kind: "line_hash", file: "a.ts", line: 1, hashes: ["h1", "h2"] },
		]);
	});

	it("applies the global limit across files in deterministic order and reports truncation", () => {
		const matches: readonly SearchHostMatch[] = [
			{ file: "c.ts", line: 1, text: "c1" },
			{ file: "a.ts", line: 2, text: "a2" },
			{ file: "b.ts", line: 1, text: "b1" },
			{ file: "a.ts", line: 1, text: "a1" },
		];
		const presentation = presentationOf(presentSearch({ ...basePlan, limit: 3 }, matches));
		expect(presentation.groups.map(group => group.file)).toEqual(["a.ts", "b.ts"]);
		expect(presentation.groups[1]?.matches).toEqual([{ line: 1, text: "b1" }]);
		expect(presentation).toMatchObject({
			totalFiles: 3,
			totalMatches: 4,
			omittedMatches: 1,
			truncated: true,
		});
		expect(presentation.text).toBe("a.ts\n1|a1\n2|a2\n\nb.ts\n1|b1\n\n[+1 more matches]");
	});

	it("reports no matches deterministically and returns deeply frozen output", () => {
		const empty = presentationOf(presentSearch(basePlan, []));
		expect(empty.groups).toEqual([]);
		expect(empty).toMatchObject({ totalFiles: 0, totalMatches: 0, omittedMatches: 0, truncated: false });
		expect(empty.text).toBe("[no matches]");
		const result = presentSearch(basePlan, [{ file: "a.ts", line: 1, column: 3, text: "x" }]);
		const presentation = presentationOf(result);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(presentation)).toBe(true);
		expect(Object.isFrozen(presentation.groups)).toBe(true);
		expect(Object.isFrozen(presentation.groups[0])).toBe(true);
		expect(Object.isFrozen(presentation.groups[0]?.matches)).toBe(true);
		expect(Object.isFrozen(presentation.groups[0]?.matches[0])).toBe(true);
	});
});
