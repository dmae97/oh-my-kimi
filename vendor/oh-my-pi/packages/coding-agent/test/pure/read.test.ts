import { describe, expect, it } from "bun:test";
import {
	planRead,
	presentRead,
	READ_DEFAULT_LIMIT,
	READ_MAX_LIMIT,
	type ReadDigestConflict,
	type ReadIssue,
	type ReadPlan,
	type ReadPlanResult,
	type ReadPresentation,
	type ReadPresentResult,
} from "@oh-my-pi/pi-coding-agent/pure/read";

function planOf(result: ReadPlanResult): ReadPlan {
	if (!result.ok) throw new Error(`expected ok plan, got issues: ${JSON.stringify(result.issues)}`);
	return result.plan;
}

function issuesOf(result: ReadPlanResult): readonly ReadIssue[] {
	if (result.ok) throw new Error("expected issues, got ok plan");
	return result.issues;
}

function issueShapes(result: ReadPlanResult): Array<{ field: string; code: string }> {
	return issuesOf(result).map(entry => ({ field: entry.field, code: entry.code }));
}

function presentationOf(result: ReadPresentResult): ReadPresentation {
	if (!result.ok) throw new Error(`expected ok presentation, got conflicts: ${JSON.stringify(result.conflicts)}`);
	return result.presentation;
}

function conflictsOf(result: ReadPresentResult): readonly ReadDigestConflict[] {
	if (result.ok) throw new Error("expected conflicts, got ok presentation");
	return result.conflicts;
}

describe("planRead", () => {
	it("rejects non-record input with a single input/not_record issue", () => {
		for (const input of [null, undefined, "x", 42, ["path"]]) {
			expect(issueShapes(planRead(input))).toEqual([{ field: "input", code: "not_record" }]);
		}
	});

	it("requires path", () => {
		expect(issueShapes(planRead({}))).toEqual([{ field: "path", code: "missing" }]);
	});

	it("rejects non-string path", () => {
		expect(issueShapes(planRead({ path: 42 }))).toEqual([{ field: "path", code: "not_string" }]);
		expect(issueShapes(planRead({ path: null }))).toEqual([{ field: "path", code: "not_string" }]);
	});

	it("rejects empty or whitespace-only path", () => {
		expect(issueShapes(planRead({ path: "" }))).toEqual([{ field: "path", code: "empty" }]);
		expect(issueShapes(planRead({ path: "   " }))).toEqual([{ field: "path", code: "empty" }]);
	});

	it("preserves nonblank path bytes verbatim", () => {
		expect(planOf(planRead({ path: " src/a b.ts " })).path).toBe(" src/a b.ts ");
	});

	it("applies safe defaults for offset and limit", () => {
		expect(READ_DEFAULT_LIMIT).toBe(2000);
		expect(planOf(planRead({ path: "src/a.ts" }))).toEqual({
			path: "src/a.ts",
			offset: 1,
			limit: READ_DEFAULT_LIMIT,
		});
	});

	it("passes through explicit offset and limit", () => {
		expect(planOf(planRead({ path: "a", offset: 5, limit: 10 }))).toEqual({ path: "a", offset: 5, limit: 10 });
	});

	it("rejects non-integer and unsafe-integer offset/limit in field order", () => {
		expect(issueShapes(planRead({ path: "a", offset: 1.5, limit: "ten" }))).toEqual([
			{ field: "offset", code: "not_integer" },
			{ field: "limit", code: "not_integer" },
		]);
		expect(issueShapes(planRead({ path: "a", offset: 2 ** 53 }))).toEqual([{ field: "offset", code: "not_integer" }]);
	});

	it("rejects offset/limit below 1 as out_of_range", () => {
		expect(issueShapes(planRead({ path: "a", offset: 0 }))).toEqual([{ field: "offset", code: "out_of_range" }]);
		expect(issueShapes(planRead({ path: "a", limit: -5 }))).toEqual([{ field: "limit", code: "out_of_range" }]);
	});

	it("clamps limit above READ_MAX_LIMIT to READ_MAX_LIMIT", () => {
		expect(planOf(planRead({ path: "a", limit: 99_999 })).limit).toBe(READ_MAX_LIMIT);
		expect(planOf(planRead({ path: "a", limit: READ_MAX_LIMIT })).limit).toBe(READ_MAX_LIMIT);
	});

	it("returns deeply frozen results", () => {
		const ok = planRead({ path: "a" });
		expect(Object.isFrozen(ok)).toBe(true);
		expect(Object.isFrozen(planOf(ok))).toBe(true);
		const bad = planRead({});
		expect(Object.isFrozen(bad)).toBe(true);
		expect(Object.isFrozen(issuesOf(bad))).toBe(true);
		expect(Object.isFrozen(issuesOf(bad)[0])).toBe(true);
	});
});

describe("presentRead", () => {
	const plan = (offset: number, limit: number): ReadPlan => ({ path: "f.ts", offset, limit });

	it("presents structured line records with truncation and no phantom trailing line", () => {
		const presentation = presentationOf(presentRead(plan(2, 2), { text: "alpha\nbravo\ncharlie\ndelta\n" }));
		expect(presentation.lines).toEqual([
			{ line: 2, text: "bravo" },
			{ line: 3, text: "charlie" },
		]);
		expect(presentation.window).toEqual({ startLine: 2, endLine: 3, totalLines: 4, truncated: true });
		expect(presentation.text).toBe("2|bravo\n3|charlie\n[+1 more lines]");
		expect(presentation.header).toBeUndefined();
	});

	it("renders a [PATH#sha256:<digest>] header when the host supplies a source digest", () => {
		const presentation = presentationOf(
			presentRead({ path: "src/a.ts", offset: 1, limit: 2000 }, { text: "one\ntwo", sourceDigest: "d1" }),
		);
		expect(presentation.header).toBe("[src/a.ts#sha256:d1]");
		expect(presentation.text).toBe("[src/a.ts#sha256:d1]\n1|one\n2|two");
		expect(presentationOf(presentRead(plan(1, 1), { text: "one", sourceDigest: "" })).header).toBeUndefined();
	});

	it("renders host line digests as N@sha256:<digest>|TEXT and carries them in records", () => {
		const presentation = presentationOf(
			presentRead(plan(1, 2000), {
				text: "one\ntwo\nthree",
				sourceDigest: "s0",
				lineDigests: [
					{ line: 3, digest: "h3" },
					{ line: 1, digest: "h1" },
					{ line: 1, digest: "h1" },
				],
			}),
		);
		expect(presentation.lines).toEqual([
			{ line: 1, text: "one", expectedLineHash: "h1" },
			{ line: 2, text: "two" },
			{ line: 3, text: "three", expectedLineHash: "h3" },
		]);
		expect(presentation.text).toBe("[f.ts#sha256:s0]\n1@sha256:h1|one\n2|two\n3@sha256:h3|three");
	});

	it("rejects disagreeing duplicate line digests without choosing one", () => {
		const result = presentRead(plan(1, 2000), {
			text: "one\ntwo",
			lineDigests: [
				{ line: 2, digest: "x" },
				{ line: 1, digest: "a" },
				{ line: 2, digest: "y" },
				{ line: 2, digest: "x" },
			],
		});
		expect(conflictsOf(result)).toEqual([{ line: 2, digests: ["x", "y"] }]);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(conflictsOf(result)[0]?.digests)).toBe(true);
	});

	it("reports beyond-EOF and empty files deterministically", () => {
		const beyond = presentationOf(presentRead(plan(10, 5), { text: "a\nb\nc" }));
		expect(beyond.lines).toEqual([]);
		expect(beyond.window).toEqual({ startLine: 10, endLine: 0, totalLines: 3, truncated: false });
		expect(beyond.text).toBe("[offset 10 beyond end of file (3 lines)]");
		const empty = presentationOf(presentRead(plan(1, 2000), { text: "" }));
		expect(empty.window).toEqual({ startLine: 1, endLine: 0, totalLines: 0, truncated: false });
		expect(empty.text).toBe("[empty file]");
	});

	it("normalizes CRLF/CR line endings and returns a deeply frozen presentation", () => {
		const result = presentRead(plan(1, 2000), { text: "a\r\nb\rc", lineDigests: [{ line: 2, digest: "hb" }] });
		const presentation = presentationOf(result);
		expect(presentation.lines).toEqual([
			{ line: 1, text: "a" },
			{ line: 2, text: "b", expectedLineHash: "hb" },
			{ line: 3, text: "c" },
		]);
		expect(presentation.window.truncated).toBe(false);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(presentation)).toBe(true);
		expect(Object.isFrozen(presentation.lines)).toBe(true);
		expect(Object.isFrozen(presentation.lines[1])).toBe(true);
		expect(Object.isFrozen(presentation.window)).toBe(true);
	});
});
