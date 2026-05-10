import { describe, expect, it } from "bun:test";
import { parseEvalInput } from "../../src/eval/parse";

describe("parseEvalInput", () => {
	it("parses a single cell with title and timeout", () => {
		const result = parseEvalInput(`*** Begin PY
*** Title: setup
*** Timeout: 15s
print("hi")
*** End PY
`);

		expect(result.cells).toHaveLength(1);
		expect(result.cells[0]).toMatchObject({
			index: 0,
			title: "setup",
			code: 'print("hi")',
			language: "python",
			languageOrigin: "header",
			timeoutMs: 15_000,
			reset: false,
		});
	});

	it("treats *** Reset as a per-cell kernel wipe", () => {
		const result = parseEvalInput(`*** Begin PY
*** Title: bootstrap
*** Reset
import json
*** End PY
*** Begin JS
*** Reset
const x = 1;
*** End JS
`);

		expect(result.cells).toHaveLength(2);
		expect(result.cells[0]).toMatchObject({ language: "python", title: "bootstrap", reset: true });
		expect(result.cells[1]).toMatchObject({ language: "js", reset: true, title: undefined });
	});

	it("accepts JS, TS, and PY language tokens (case-insensitive)", () => {
		const result = parseEvalInput(`*** Begin TS
const a = 1;
*** End TS
*** Begin py
print("py")
*** End py
`);

		expect(result.cells.map(c => c.language)).toEqual(["js", "python"]);
	});

	it("parses millisecond, second, and minute durations", () => {
		const result = parseEvalInput(`*** Begin PY
*** Timeout: 500ms
a = 1
*** End PY
*** Begin PY
*** Timeout: 5
a = 2
*** End PY
*** Begin PY
*** Timeout: 2m
a = 3
*** End PY
`);

		expect(result.cells.map(c => c.timeoutMs)).toEqual([500, 5_000, 120_000]);
	});

	it("attribute order is flexible and only the first wins", () => {
		const result = parseEvalInput(`*** Begin PY
*** Timeout: 1s
*** Title: first
*** Title: ignored
*** Timeout: 9s
print(1)
*** End PY
`);

		expect(result.cells[0]).toMatchObject({ title: "first", timeoutMs: 1_000 });
	});

	it("preserves blank lines inside the cell body", () => {
		const result = parseEvalInput(`*** Begin JS
const x = 1;

const y = 2;
*** End JS
`);

		expect(result.cells[0].code).toBe("const x = 1;\n\nconst y = 2;");
	});

	it("treats blank lines between cells as separators, not code", () => {
		const result = parseEvalInput(`*** Begin PY
print("a")
*** End PY


*** Begin PY
print("b")
*** End PY
`);

		expect(result.cells).toHaveLength(2);
		expect(result.cells[0].code).toBe('print("a")');
		expect(result.cells[1].code).toBe('print("b")');
	});

	it("falls back to language sniffing when the begin marker has no recognized language", () => {
		const result = parseEvalInput(`*** Begin RUBY
const x = 1;
console.log(x);
*** End
`);
		expect(result.cells[0]).toMatchObject({ language: "js", languageOrigin: "default" });
	});

	it("accepts `**Begin` (two stars) as well as `***Begin`", () => {
		const result = parseEvalInput(`**Begin PY
print(1)
**End
`);
		expect(result.cells[0]).toMatchObject({ language: "python", code: "print(1)" });
	});

	it("implicitly closes a cell when a new *** Begin appears without an *** End", () => {
		const result = parseEvalInput(`*** Begin PY
print("a")
*** Begin JS
const x = 1;
*** End JS
`);
		expect(result.cells).toHaveLength(2);
		expect(result.cells[0]).toMatchObject({ language: "python", code: 'print("a")' });
		expect(result.cells[1]).toMatchObject({ language: "js", code: "const x = 1;" });
	});

	it("ignores the language token on `*** End` (leniency)", () => {
		const result = parseEvalInput(`*** Begin PY
print(1)
*** End JS
`);
		expect(result.cells[0]).toMatchObject({ language: "python", code: "print(1)" });
	});

	it("accepts long-form language aliases (Python, JavaScript, TypeScript)", () => {
		const result = parseEvalInput(`*** Begin Python
print(1)
*** End
*** begin javascript
const x = 1;
*** End
`);
		expect(result.cells.map(c => c.language)).toEqual(["python", "js"]);
	});

	it("tolerates whitespace and case variations on directives", () => {
		const result = parseEvalInput(`***\tBegin\tPY
***title:   tabby
***\tTimeout:\t250ms
***reset
print(1)
***End
`);
		expect(result.cells[0]).toMatchObject({
			title: "tabby",
			timeoutMs: 250,
			reset: true,
			language: "python",
			code: "print(1)",
		});
	});

	it("implicitly closes the final cell at EOF when *** End is missing", () => {
		const result = parseEvalInput(`*** Begin PY
print(1)
`);
		expect(result.cells).toHaveLength(1);
		expect(result.cells[0]).toMatchObject({ language: "python", code: "print(1)" });
	});

	it("treats bare code without any *** Begin as a single implicit cell", () => {
		const result = parseEvalInput(`def greet():\n    print('hi')\ngreet()\n`);
		expect(result.cells).toHaveLength(1);
		expect(result.cells[0]).toMatchObject({
			language: "python",
			languageOrigin: "default",
			code: "def greet():\n    print('hi')\ngreet()",
		});
	});

	it("strips a markdown code fence wrapper and uses its language tag", () => {
		const result = parseEvalInput("```js\nconst x = 1;\n```\n");
		expect(result.cells).toHaveLength(1);
		expect(result.cells[0]).toMatchObject({
			language: "js",
			languageOrigin: "header",
			code: "const x = 1;",
		});
	});

	it("rejects invalid duration", () => {
		expect(() =>
			parseEvalInput(`*** Begin PY
*** Timeout: forever
print(1)
*** End PY
`),
		).toThrow(/invalid duration/);
	});
	describe("*** Abort recovery sentinel (harmony-leak mitigation)", () => {
		it("drops the in-progress cell and stops parsing", () => {
			const result = parseEvalInput(`*** Begin PY
print("a")
*** End PY
*** Begin JS
const partial = 1;  /* contamination starts mid-cell */
*** Abort
*** Begin TS
const never_runs = 1;
`);
			expect(result.aborted).toBe(true);
			expect(result.cells).toHaveLength(1);
			expect(result.cells[0].language).toBe("python");
			expect(result.cells[0].code).toBe('print("a")');
		});

		it("between cells: keeps preceding cells, sets aborted, drops trailing cells", () => {
			const result = parseEvalInput(`*** Begin PY
print("a")
*** End PY

*** Abort

*** Begin PY
print("never")
*** End PY
`);
			expect(result.aborted).toBe(true);
			expect(result.cells).toHaveLength(1);
			expect(result.cells[0].code).toBe('print("a")');
		});

		it("implicit-cell input containing *** Abort is rejected entirely", () => {
			const result = parseEvalInput(`print("partial")
*** Abort
`);
			expect(result.aborted).toBe(true);
			expect(result.cells).toHaveLength(0);
		});

		it("appended sentinel from harmony-leak truncation: abort flag set, prior cell preserved", () => {
			// Mirrors the exact shape harmony-leak emits: original input truncated
			// at the contaminated line, then "\n*** Abort\n" appended.
			const truncated = `*** Begin PY\nprint("ok")\n*** End PY\n*** Abort\n`;
			const result = parseEvalInput(truncated);
			expect(result.aborted).toBe(true);
			expect(result.cells).toHaveLength(1);
			expect(result.cells[0].code).toBe('print("ok")');
		});

		it("absent sentinel: aborted is undefined (not falsely set)", () => {
			const result = parseEvalInput(`*** Begin PY
print(1)
*** End PY
`);
			expect(result.aborted).toBeUndefined();
		});
	});
});
