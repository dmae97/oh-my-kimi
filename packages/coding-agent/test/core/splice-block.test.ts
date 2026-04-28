import { describe, expect, it } from "bun:test";
import { type AtomEdit, applyAtomEdits, computeLineHash, resolveAtomToolEdit } from "@oh-my-pi/pi-coding-agent/edit";
import type { Anchor } from "@oh-my-pi/pi-coding-agent/edit/modes/hashline";

function tag(line: number, content: string): Anchor {
	return { line, hash: computeLineHash(line, content) };
}

describe("splice_block — single-line block", () => {
	it("stays inline when body is one line", () => {
		const content = "function foo(): number { return 1; }\n";
		const edits: AtomEdit[] = [
			{
				op: "splice_block",
				pos: tag(1, "function foo(): number { return 1; }"),
				spec: { body: ["return 42;"], kind: "{" },
				bracket: "body",
			},
		];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toBe("function foo(): number { return 42; }\n");
	});

	it("expands when body is multi-line", () => {
		const content = "function foo() { return 1; }\n";
		const edits: AtomEdit[] = [
			{
				op: "splice_block",
				pos: tag(1, "function foo() { return 1; }"),
				spec: { body: ["if (cond) {", "    return 0;", "}", "return 1;"], kind: "{" },
				bracket: "body",
			},
		];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toContain("function foo() {");
		expect(result.lines).toContain("if (cond) {");
		expect(result.lines).toContain("return 1;");
		expect(result.lines.split("\n").pop()).toBe("");
	});
});

describe("splice_block — multi-line block", () => {
	const content = ["function bar(x: number) {", "\tif (x > 0) {", "\t\treturn x;", "\t}", "\treturn 0;", "}", ""].join(
		"\n",
	);

	it("replaces the innermost { } when anchor is inside the inner block", () => {
		const edits: AtomEdit[] = [
			{
				op: "splice_block",
				pos: tag(3, "\t\treturn x;"),
				spec: { body: ["return x * 2;"], kind: "{" },
				bracket: "body",
			},
		];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toContain("\t\treturn x * 2;");
		expect(result.lines).not.toContain("\t\treturn x;\n");
	});
});

describe("splice_block — indent normalization", () => {
	it("strips agent's common indent and applies destination indent", () => {
		const content = ["function f() {", "\treturn 1;", "}", ""].join("\n");
		const edits: AtomEdit[] = [
			{
				op: "splice_block",
				pos: tag(2, "\treturn 1;"),
				spec: { body: ["    if (cond) {", "        return 0;", "    }", "    return 2;"], kind: "{" },
				bracket: "body",
			},
		];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toContain("\treturn 2;");
		expect(result.lines).toContain("\tif (cond) {");
	});
});

describe("splice_block — validation", () => {
	it("rejects when no enclosing block contains the line", () => {
		const content = "const x = 1;\nconst y = 2;\n";
		const edits: AtomEdit[] = [
			{
				op: "splice_block",
				pos: tag(1, "const x = 1;"),
				spec: { body: ["..."], kind: "{" },
				bracket: "body",
			},
		];
		expect(() => applyAtomEdits(content, edits)).toThrow(/No enclosing/);
	});

	it("rejects when body has unbalanced delimiters of the chosen kind", () => {
		const content = "function f() {\n\treturn 1;\n}\n";
		const edits: AtomEdit[] = [
			{
				op: "splice_block",
				pos: tag(2, "\treturn 1;"),
				spec: { body: ["return 1;", "}"], kind: "{" },
				bracket: "body",
			},
		];
		expect(() => applyAtomEdits(content, edits)).toThrow(/unbalanced/);
	});
});

describe("splice_block — locator forms", () => {
	const content = [
		"function split() {",
		"\tconst a = 1;",
		"\tconst b = 2;",
		"\tconst c = 3;",
		"\treturn a + b + c;",
		"}",
		"",
	].join("\n");

	it("replaces the tail from anchor through closer with [anchor", () => {
		const result = applyAtomEdits(content, [
			{
				op: "splice_block",
				pos: tag(3, "\tconst b = 2;"),
				spec: { body: ["return a;"], kind: "{" },
				bracket: "left_incl",
			},
		]);
		expect(result.lines.split("\n")).toEqual(["function split() {", "\tconst a = 1;", "\treturn a;", "}", ""]);
	});

	it("replaces the tail after anchor with (anchor", () => {
		const result = applyAtomEdits(content, [
			{
				op: "splice_block",
				pos: tag(3, "\tconst b = 2;"),
				spec: { body: ["return b;"], kind: "{" },
				bracket: "left_excl",
			},
		]);
		expect(result.lines.split("\n")).toEqual([
			"function split() {",
			"\tconst a = 1;",
			"\tconst b = 2;",
			"\treturn b;",
			"}",
			"",
		]);
	});

	it("replaces the head through anchor with anchor]", () => {
		const result = applyAtomEdits(content, [
			{
				op: "splice_block",
				pos: tag(3, "\tconst b = 2;"),
				spec: { body: ["const z = 0;"], kind: "{" },
				bracket: "right_incl",
			},
		]);
		expect(result.lines.split("\n")).toEqual([
			"function split() {",
			"\tconst z = 0;",
			"\tconst c = 3;",
			"\treturn a + b + c;",
			"}",
			"",
		]);
	});

	it("replaces the head before anchor with anchor)", () => {
		const result = applyAtomEdits(content, [
			{
				op: "splice_block",
				pos: tag(3, "\tconst b = 2;"),
				spec: { body: ["const z = 0;"], kind: "{" },
				bracket: "right_excl",
			},
		]);
		expect(result.lines.split("\n")).toEqual([
			"function split() {",
			"\tconst z = 0;",
			"\tconst b = 2;",
			"\tconst c = 3;",
			"\treturn a + b + c;",
			"}",
			"",
		]);
	});
});

describe("splice (bracketed locator) \u2014 resolveAtomToolEdit", () => {
	it("resolves bare anchor + splice as a line splice op (not splice_block)", () => {
		const resolved = resolveAtomToolEdit({
			loc: "2gj|\treturn 1;",
			splice: ["return 2;"],
		});
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.op).toBe("splice");
	});

	it("resolves (anchor) bracket as splice_block region (body scope)", () => {
		const resolved = resolveAtomToolEdit({ loc: "(2gj|\treturn 1;)", splice: ["return 2;"] }, 0, "foo.ts");
		expect(resolved).toHaveLength(1);
		const op = resolved[0]!;
		expect(op.op).toBe("splice_block");
		if (op.op === "splice_block") {
			expect(op.bracket).toBe("body");
			expect(op.spec.kind).toBe("{");
		}
	});

	it("resolves [anchor] bracket as splice_block region (whole node)", () => {
		const resolved = resolveAtomToolEdit({ loc: "[2gj|\treturn 1;]", splice: ["function f() {}"] }, 0, "foo.ts");
		const op = resolved[0]!;
		expect(op.op).toBe("splice_block");
		if (op.op === "splice_block") expect(op.bracket).toBe("node");
	});

	it("rejects mixed bracket locator forms", () => {
		expect(() => resolveAtomToolEdit({ loc: "(2gj]", splice: ["x"] })).toThrow(/mixed bracket/);
	});

	it("rejects bracket locators paired with pre/post/sed", () => {
		expect(() => resolveAtomToolEdit({ loc: "[2gj", pre: ["x"] })).toThrow(/splice-only/);
	});

	it("rejects bracket locator without splice", () => {
		expect(() => resolveAtomToolEdit({ loc: "[2gj" } as never)).toThrow(/missing verb|requires/);
	});

	it("defaults delimiter to '{' when no path is provided", () => {
		const resolved = resolveAtomToolEdit({ loc: "[2gj|\treturn 1;]", splice: ["x"] });
		const op = resolved[0]!;
		if (op.op === "splice_block") expect(op.spec.kind).toBe("{");
	});
});

describe("splice_block — string/comment safety", () => {
	it("ignores braces inside strings when finding the enclosing block", () => {
		const content = ["function f() {", '\tconst s = "{}";', "\treturn s;", "}", ""].join("\n");
		const edits: AtomEdit[] = [
			{
				op: "splice_block",
				pos: tag(3, "\treturn s;"),
				spec: { body: ['return "replaced";'], kind: "{" },
				bracket: "body",
			},
		];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toContain('return "replaced";');
		expect(result.lines.split("\n")).toEqual(["function f() {", '\treturn "replaced";', "}", ""]);
	});
});
