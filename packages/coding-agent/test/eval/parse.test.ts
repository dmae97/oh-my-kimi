import { describe, expect, it } from "bun:test";
import { parseEvalInput } from "../../src/eval/parse";

describe("parseEvalInput", () => {
	it("parses a single fenced cell with positional title and timeout", () => {
		const result = parseEvalInput(`\`\`\`py setup 15s
print("hi")
\`\`\`
`);

		expect(result.cells).toEqual([
			{
				index: 0,
				title: "setup",
				code: 'print("hi")',
				language: "python",
				languageOrigin: "fence",
				timeoutMs: 15_000,
				reset: false,
			},
		]);
	});

	it("treats rst=true as a per-language kernel wipe for that cell", () => {
		const result = parseEvalInput(`\`\`\`py rst=true id="bootstrap"
import json
\`\`\`

\`\`\`js rst=true
const x = 1;
\`\`\`
`);

		expect(result.cells.map(cell => [cell.language, cell.reset, cell.title])).toEqual([
			["python", true, "bootstrap"],
			["js", true, undefined],
		]);
	});

	it("inherits language and runs without reset for empty fence info", () => {
		const result = parseEvalInput(`\`\`\`js
const a = 1;
\`\`\`

\`\`\`
const b = a + 1;
\`\`\`
`);

		expect(result.cells.map(cell => [cell.language, cell.languageOrigin, cell.code, cell.reset])).toEqual([
			["js", "fence", "const a = 1;", false],
			["js", "fence", "const b = a + 1;", false],
		]);
	});

	it("supports tilde fences and case-insensitive language tokens including ipython aliases", () => {
		const result = parseEvalInput(`~~~TypeScript
const a = 1;
~~~

\`\`\`IPython
print("ipy")
\`\`\`
`);

		expect(result.cells.map(cell => [cell.language, cell.languageOrigin])).toEqual([
			["js", "fence"],
			["python", "fence"],
		]);
	});

	it("uses canonical id and t attributes, with explicit attrs winning over positional", () => {
		const result = parseEvalInput(`\`\`\`py 5s some words t=2m id="explicit win"
print(1)
\`\`\`
`);

		expect(result.cells[0]).toMatchObject({
			title: "explicit win",
			timeoutMs: 120_000,
			language: "python",
		});
	});

	it("accepts fallback aliases for id, t, and rst keys", () => {
		const cases = [
			{ key: "title", expectTitle: "alpha" },
			{ key: "name", expectTitle: "alpha" },
			{ key: "cell", expectTitle: "alpha" },
			{ key: "file", expectTitle: "alpha" },
			{ key: "label", expectTitle: "alpha" },
		];
		for (const { key, expectTitle } of cases) {
			const result = parseEvalInput(`\`\`\`py ${key}="alpha"\nprint(1)\n\`\`\`\n`);
			expect(result.cells[0].title).toBe(expectTitle);
		}

		const timeoutAliases = ["timeout", "duration", "time"];
		for (const key of timeoutAliases) {
			const result = parseEvalInput(`\`\`\`py ${key}=2m\nprint(1)\n\`\`\`\n`);
			expect(result.cells[0].timeoutMs).toBe(120_000);
		}

		const resetAliases = ["reset"];
		for (const key of resetAliases) {
			const result = parseEvalInput(`\`\`\`py ${key}=true\nprint(1)\n\`\`\`\n`);
			expect(result.cells[0].reset).toBe(true);
		}
	});

	it("first occurrence wins when canonical and alias collide", () => {
		const canonicalFirst = parseEvalInput(`\`\`\`py id="canon" title="alias"
print(1)
\`\`\`
`);
		const aliasFirst = parseEvalInput(`\`\`\`py title="alias" id="canon"
print(1)
\`\`\`
`);

		expect(canonicalFirst.cells[0].title).toBe("canon");
		expect(aliasFirst.cells[0].title).toBe("alias");
	});

	it("parses millisecond, second, and minute durations", () => {
		const result = parseEvalInput(`\`\`\`py 500ms
a = 1
\`\`\`

\`\`\`py 5
a = 2
\`\`\`

\`\`\`py 2m
a = 3
\`\`\`
`);

		expect(result.cells.map(cell => cell.timeoutMs)).toEqual([500, 5_000, 120_000]);
	});

	it("treats unrecognized fence info as title and inherits the language", () => {
		const result = parseEvalInput(`\`\`\`ruby
puts "no"
\`\`\`
`);

		expect(result.cells[0]).toMatchObject({
			title: "ruby",
			code: 'puts "no"',
			language: "python",
			languageOrigin: "default",
		});
	});

	it("joins multiple positional title fragments with spaces", () => {
		const result = parseEvalInput(`\`\`\`py compute totals
print(1)
\`\`\`
`);

		expect(result.cells[0].title).toBe("compute totals");
	});

	it("accepts back-to-back fenced cells without blank separators", () => {
		const result = parseEvalInput(`\`\`\`py id=a
print("a")
\`\`\`
\`\`\`py id=b
print("b")
\`\`\`
`);

		expect(result.cells.map(cell => [cell.title, cell.code])).toEqual([
			["a", 'print("a")'],
			["b", 'print("b")'],
		]);
	});

	it("wraps bare code with no fences in a single implicit cell", () => {
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

	it("surfaces raw inter-fence content as its own implicit cell that inherits language", () => {
		const result = parseEvalInput(`\`\`\`js
const x = 1;
\`\`\`

inherited tail
`);

		expect(result.cells.map(cell => [cell.language, cell.languageOrigin, cell.code])).toEqual([
			["js", "fence", "const x = 1;"],
			["js", "fence", "inherited tail"],
		]);
	});

	it("treats unclosed fences leniently and closes them at end of input", () => {
		const result = parseEvalInput(`\`\`\`py
print("still typing")`);

		expect(result.cells).toHaveLength(1);
		expect(result.cells[0]).toMatchObject({
			code: 'print("still typing")',
			language: "python",
			languageOrigin: "fence",
			reset: false,
		});
	});

	it("ignores unknown attribute keys without erroring", () => {
		const result = parseEvalInput(`\`\`\`py mystery=123 id=ok
print(1)
\`\`\`
`);

		expect(result.cells[0]).toMatchObject({ title: "ok", language: "python" });
	});

	it("rejects an invalid rst value", () => {
		expect(() =>
			parseEvalInput(`\`\`\`py rst=maybe
print(1)
\`\`\`
`),
		).toThrow("invalid rst value");
	});

	it("rejects an invalid t value", () => {
		expect(() =>
			parseEvalInput(`\`\`\`py t=forever
print(1)
\`\`\`
`),
		).toThrow("invalid duration");
	});
});
