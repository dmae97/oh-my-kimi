import { describe, expect, it } from "bun:test";
import { parseEvalInput } from "../../src/eval/parse";

describe("parseEvalInput", () => {
	it("parses a single header cell with title shorthand and t timeout", () => {
		const result = parseEvalInput(`===== py:"setup" t:15s =====
print("hi")
`);

		expect(result.cells).toEqual([
			{
				index: 0,
				title: "setup",
				code: 'print("hi")',
				language: "python",
				languageOrigin: "header",
				timeoutMs: 15_000,
				reset: false,
			},
		]);
	});

	it("treats bare rst as a per-language kernel wipe for that cell", () => {
		const result = parseEvalInput(`===== py rst id:"bootstrap" =====
import json
===== js rst =====
const x = 1;
`);

		expect(result.cells.map(cell => [cell.language, cell.reset, cell.title])).toEqual([
			["python", true, "bootstrap"],
			["js", true, undefined],
		]);
	});

	it("inherits language across consecutive cells when omitted", () => {
		const result = parseEvalInput(`===== js =====
const a = 1;
===== =====
const b = a + 1;
`);

		expect(result.cells.map(cell => [cell.language, cell.languageOrigin, cell.code, cell.reset])).toEqual([
			["js", "header", "const a = 1;", false],
			["js", "header", "const b = a + 1;", false],
		]);
	});

	it("accepts asymmetric bar runs and case-insensitive language tokens", () => {
		const result = parseEvalInput(`===== TypeScript ======
const a = 1;
====== IPython =====
print("ipy")
`);

		expect(result.cells.map(cell => [cell.language, cell.languageOrigin])).toEqual([
			["js", "header"],
			["python", "header"],
		]);
	});

	it("uses canonical id and t attributes, with explicit attrs winning over positional", () => {
		const result = parseEvalInput(`===== py 5s some words t:2m id:"explicit win" =====
print(1)
`);

		expect(result.cells[0]).toMatchObject({
			title: "explicit win",
			timeoutMs: 120_000,
			language: "python",
		});
	});

	it("accepts fallback aliases for id, t, and rst keys", () => {
		const idAliases = ["title", "name", "cell", "file", "label"];
		for (const key of idAliases) {
			const result = parseEvalInput(`===== py ${key}:"alpha" =====\nprint(1)\n`);
			expect(result.cells[0].title).toBe("alpha");
		}

		const timeoutAliases = ["timeout", "duration", "time"];
		for (const key of timeoutAliases) {
			const result = parseEvalInput(`===== py ${key}:2m =====\nprint(1)\n`);
			expect(result.cells[0].timeoutMs).toBe(120_000);
		}

		const result = parseEvalInput(`===== py reset:true =====\nprint(1)\n`);
		expect(result.cells[0].reset).toBe(true);
	});

	it("first occurrence wins when canonical and alias collide", () => {
		const canonicalFirst = parseEvalInput(`===== py id:"canon" title:"alias" =====
print(1)
`);
		const aliasFirst = parseEvalInput(`===== py title:"alias" id:"canon" =====
print(1)
`);

		expect(canonicalFirst.cells[0].title).toBe("canon");
		expect(aliasFirst.cells[0].title).toBe("alias");
	});

	it("parses millisecond, second, and minute durations", () => {
		const result = parseEvalInput(`===== py t:500ms =====
a = 1
===== py t:5 =====
a = 2
===== py t:2m =====
a = 3
`);

		expect(result.cells.map(cell => cell.timeoutMs)).toEqual([500, 5_000, 120_000]);
	});

	it("treats unrecognized header tokens as a title and inherits the language", () => {
		const result = parseEvalInput(`===== ruby =====
puts "no"
`);

		expect(result.cells[0]).toMatchObject({
			title: "ruby",
			code: 'puts "no"',
			language: "python",
			languageOrigin: "default",
		});
	});

	it("joins multiple positional title fragments with spaces", () => {
		const result = parseEvalInput(`===== py compute totals =====
print(1)
`);

		expect(result.cells[0].title).toBe("compute totals");
	});

	it("accepts back-to-back header cells without blank separators", () => {
		const result = parseEvalInput(`===== py id:"a" =====
print("a")
===== py id:"b" =====
print("b")
`);

		expect(result.cells.map(cell => [cell.title, cell.code])).toEqual([
			["a", 'print("a")'],
			["b", 'print("b")'],
		]);
	});

	it("wraps bare code with no headers in a single implicit cell", () => {
		const result = parseEvalInput(`print("hello")
print("world")
`);

		expect(result.cells).toEqual([
			{
				index: 0,
				title: undefined,
				code: 'print("hello")\nprint("world")',
				language: "python",
				languageOrigin: "default",
				timeoutMs: 30_000,
				reset: false,
			},
		]);
	});

	it("strips blank lines between cells from the preceding cell's code", () => {
		const result = parseEvalInput(`===== js =====
const x = 1;

===== =====
const y = 2;
`);

		expect(result.cells.map(cell => [cell.language, cell.languageOrigin, cell.code])).toEqual([
			["js", "header", "const x = 1;"],
			["js", "header", "const y = 2;"],
		]);
	});

	it("accepts an empty header introducing a default cell with no info", () => {
		const result = parseEvalInput(`=====
print("still typing")
`);

		expect(result.cells).toHaveLength(1);
		expect(result.cells[0]).toMatchObject({
			code: 'print("still typing")',
			language: "python",
			languageOrigin: "default",
			reset: false,
		});
	});

	it("ignores unknown attribute keys without erroring", () => {
		const result = parseEvalInput(`===== py mystery:123 id:"ok" =====
print(1)
`);

		expect(result.cells[0]).toMatchObject({ title: "ok", language: "python" });
	});

	it("rejects an invalid rst value", () => {
		expect(() =>
			parseEvalInput(`===== py rst:maybe =====
print(1)
`),
		).toThrow("invalid rst value");
	});

	it("rejects an invalid t value", () => {
		expect(() =>
			parseEvalInput(`===== py t:forever =====
print(1)
`),
		).toThrow("invalid duration");
	});

	it("does not treat lines that start with equals but have no closing bar as a header", () => {
		const result = parseEvalInput(`===== py =====
x = 1
===== not a header
y = 2
`);

		expect(result.cells).toHaveLength(1);
		expect(result.cells[0].code).toBe("x = 1\n===== not a header\ny = 2");
	});
});
