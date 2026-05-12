import { describe, expect, it } from "bun:test";
import { parseEvalInput } from "../../src/eval/parse";

describe("parseEvalInput", () => {
	it("parses a single cell with title and timeout", () => {
		const result = parseEvalInput(`*** Cell py:"setup" t:10s
print("hi")
`);
		expect(result.cells).toHaveLength(1);
		expect(result.cells[0]).toMatchObject({
			index: 0,
			title: "setup",
			language: "python",
			languageOrigin: "header",
			timeoutMs: 10_000,
			reset: false,
			code: 'print("hi")',
		});
	});

	it("treats rst as a per-cell kernel wipe", () => {
		const result = parseEvalInput(`*** Cell py:"bootstrap"
import json

*** Cell js:"" rst
const x = 1;
`);
		expect(result.cells).toHaveLength(2);
		expect(result.cells[0].reset).toBe(false);
		expect(result.cells[1].reset).toBe(true);
		expect(result.cells[1].language).toBe("js");
	});

	it("accepts case-insensitive language tokens (lenient)", () => {
		const result = parseEvalInput(`*** Cell JS:""
const a = 1;
*** Cell PY:""
print("py")
`);
		expect(result.cells).toHaveLength(2);
		expect(result.cells[0].language).toBe("js");
		expect(result.cells[1].language).toBe("python");
	});

	it("parses millisecond, second, and minute durations", () => {
		const result = parseEvalInput(`*** Cell py:"a" t:500ms
a = 1
*** Cell py:"b" t:5
a = 2
*** Cell py:"c" t:2m
a = 3
`);
		expect(result.cells.map(c => c.timeoutMs)).toEqual([500, 5000, 120_000]);
	});

	it("preserves blank lines inside the cell body", () => {
		const result = parseEvalInput(`*** Cell js:""
const x = 1;

const y = 2;
`);
		expect(result.cells).toHaveLength(1);
		expect(result.cells[0].code).toBe("const x = 1;\n\nconst y = 2;");
	});

	it("treats blank lines between cells as separators, not code", () => {
		const result = parseEvalInput(`*** Cell py:""
print("a")


*** Cell py:""
print("b")
`);
		expect(result.cells).toHaveLength(2);
		expect(result.cells[0].code).toBe('print("a")');
		expect(result.cells[1].code).toBe('print("b")');
	});

	it("falls back to language sniffing when the header has no recognized language", () => {
		// Bare `ruby` doesn't match LANG_TITLE, but the parser is lenient and
		// falls back to body sniffing.
		const result = parseEvalInput(`*** Cell ruby:"x"
const x = 1;
`);
		expect(result.cells).toHaveLength(1);
		expect(result.cells[0].languageOrigin).toBe("default");
		expect(result.cells[0].language).toBe("js");
	});

	it("accepts `**Cell` (two stars) as well as `***Cell`", () => {
		const result = parseEvalInput(`**Cell py:""
print(1)
`);
		expect(result.cells).toHaveLength(1);
		expect(result.cells[0].language).toBe("python");
	});

	it("implicitly closes a cell when a new *** Cell appears without *** End", () => {
		const result = parseEvalInput(`*** Cell py:""
print("a")
*** Cell js:""
const x = 1;
`);
		expect(result.cells).toHaveLength(2);
		expect(result.cells[0].code).toBe('print("a")');
		expect(result.cells[1].code).toBe("const x = 1;");
	});

	it("tolerates `*** End` as an optional cell terminator (GPT quirk)", () => {
		const result = parseEvalInput(`*** Cell py:""
print(1)
*** End
*** Cell js:""
const x = 1;
*** End
`);
		expect(result.cells).toHaveLength(2);
		expect(result.cells[0].code).toBe("print(1)");
		expect(result.cells[1].code).toBe("const x = 1;");
	});

	it("ignores anything trailing `*** End` (leniency)", () => {
		const result = parseEvalInput(`*** Cell py:""
print(1)
*** End py
`);
		expect(result.cells).toHaveLength(1);
		expect(result.cells[0].code).toBe("print(1)");
	});

	it("accepts long-form language aliases (Python, JavaScript, TypeScript)", () => {
		const result = parseEvalInput(`*** Cell Python:""
print(1)
*** Cell JavaScript:""
const a = 1;
*** Cell TypeScript:""
const b = 2;
`);
		expect(result.cells.map(c => c.language)).toEqual(["python", "js", "js"]);
	});

	it("implicitly closes the final cell at EOF when *** End is missing", () => {
		const result = parseEvalInput(`*** Cell py:""
print(1)
`);
		expect(result.cells).toHaveLength(1);
		expect(result.cells[0].code).toBe("print(1)");
	});

	it("treats bare code without any *** Cell as a single implicit cell", () => {
		const result = parseEvalInput(`def greet():\n    print('hi')\ngreet()\n`);
		expect(result.cells).toHaveLength(1);
		expect(result.cells[0]).toMatchObject({
			languageOrigin: "default",
			language: "python",
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
			parseEvalInput(`*** Cell py:"" t:forever
print(1)
`),
		).toThrow(/invalid duration/);
	});

	it("supports titles with embedded spaces", () => {
		const result = parseEvalInput(`*** Cell py:"load and validate config"
print(1)
`);
		expect(result.cells).toHaveLength(1);
		expect(result.cells[0].title).toBe("load and validate config");
	});

	it('treats empty title (`py:""`) as no title', () => {
		const result = parseEvalInput(`*** Cell py:""
print(1)
`);
		expect(result.cells).toHaveLength(1);
		expect(result.cells[0].title).toBeUndefined();
		expect(result.cells[0].language).toBe("python");
	});

	it("accepts bare language token without title (lenient form)", () => {
		// Parser is more permissive than the lark; bare `py` is accepted
		// even though the canonical form is `py:"title"`.
		const result = parseEvalInput(`*** Cell py
print(1)
`);
		expect(result.cells).toHaveLength(1);
		expect(result.cells[0].language).toBe("python");
		expect(result.cells[0].title).toBeUndefined();
	});

	describe("attribute leniency (accepted but not advertised)", () => {
		it("accepts id aliases (title/name/cell/file/label)", () => {
			const aliases = ["title", "name", "cell", "file", "label"];
			for (const alias of aliases) {
				const result = parseEvalInput(`*** Cell py ${alias}:"hi"\nprint(1)\n`);
				expect(result.cells[0].title).toBe("hi");
			}
		});

		it("accepts t aliases (timeout/duration/time)", () => {
			const aliases = ["timeout", "duration", "time"];
			for (const alias of aliases) {
				const result = parseEvalInput(`*** Cell py ${alias}:5s\nprint(1)\n`);
				expect(result.cells[0].timeoutMs).toBe(5000);
			}
		});

		it("accepts `reset` as an alias for `rst`", () => {
			const result = parseEvalInput(`*** Cell py reset\nprint(1)\n`);
			expect(result.cells[0].reset).toBe(true);
		});

		it("accepts `rst:true|false|1|0|yes|no|on|off`", () => {
			for (const v of ["true", "1", "yes", "on"]) {
				const r = parseEvalInput(`*** Cell py rst:${v}\nx\n`);
				expect(r.cells[0].reset).toBe(true);
			}
			for (const v of ["false", "0", "no", "off"]) {
				const r = parseEvalInput(`*** Cell py rst:${v}\nx\n`);
				expect(r.cells[0].reset).toBe(false);
			}
		});

		it("rejects an invalid rst value", () => {
			expect(() => parseEvalInput(`*** Cell py rst:maybe\nx\n`)).toThrow(/invalid rst/);
		});

		it("accepts single-quoted titles (`id:'hi'`)", () => {
			const result = parseEvalInput(`*** Cell py id:'hello world'\nprint(1)\n`);
			expect(result.cells[0].title).toBe("hello world");
		});

		it("accepts a bare positional duration token (e.g. `30s`)", () => {
			const result = parseEvalInput(`*** Cell py 2m\nprint(1)\n`);
			expect(result.cells[0].timeoutMs).toBe(120_000);
		});

		it("first occurrence wins for repeated keys (canonical or alias)", () => {
			const result = parseEvalInput(`*** Cell py id:"first" name:"second" t:1s timeout:5s\nprint(1)\n`);
			expect(result.cells[0].title).toBe("first");
			expect(result.cells[0].timeoutMs).toBe(1000);
		});

		it("unclassified bare tokens accumulate as a positional title", () => {
			const result = parseEvalInput(`*** Cell py setup phase\nprint(1)\n`);
			expect(result.cells[0].title).toBe("setup phase");
		});
	});

	describe("*** Abort recovery sentinel (harmony-leak mitigation)", () => {
		it("drops the in-progress cell and stops parsing", () => {
			const result = parseEvalInput(`*** Cell py:""
print("a")
*** Cell js:""
const partial = 1;  /* contamination starts mid-cell */
*** Abort
*** Cell js:""
const never_runs = 1;
`);
			expect(result.aborted).toBe(true);
			expect(result.cells).toHaveLength(1);
			expect(result.cells[0].language).toBe("python");
			expect(result.cells[0].code).toBe('print("a")');
		});

		it("`*** End` before `*** Abort` preserves the closed cell", () => {
			// Without `*** End`, the parser can't tell whether the cell was
			// complete before contamination — by design, since `*** End` is
			// optional and undocumented. Explicit `*** End` is the GPT quirk
			// that signals "cell is closed, abort is between cells".
			const result = parseEvalInput(`*** Cell py:""
print("a")
*** End

*** Abort

*** Cell py:""
print("never")
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

		it("appended sentinel from harmony-leak truncation: abort flag set, prior cell dropped", () => {
			const truncated = `*** Cell py:""\nprint("ok")\n*** Abort\n`;
			const result = parseEvalInput(truncated);
			expect(result.aborted).toBe(true);
			expect(result.cells).toHaveLength(0);
		});

		it("absent sentinel: aborted is undefined (not falsely set)", () => {
			const result = parseEvalInput(`*** Cell py:""
print(1)
`);
			expect(result.aborted).toBeUndefined();
		});
	});

	it("does not crash on stray non-marker lines between cells", () => {
		// Regression for "null is not an object (evaluating
		// 'BEGIN_RE.exec(lines[i])[1]')" — stray fragments must not crash.
		// Without `*** End`, the stray junk folds into the prior cell's body;
		// the contract for this test is just "don't crash".
		const result = parseEvalInput(`*** Cell py:""
print("a")
stray junk that is not a marker
*** Cell py:""
print("b")
`);
		expect(result.aborted).toBeUndefined();
		expect(result.cells).toHaveLength(2);
		expect(result.cells[0].code).toContain('print("a")');
		expect(result.cells[1].code).toBe('print("b")');
	});

	it("does not crash on trailing stray content after the final cell", () => {
		const result = parseEvalInput(`*** Cell py:""
print(1)
leftover model chatter
more junk
`);
		expect(result.aborted).toBeUndefined();
		expect(result.cells).toHaveLength(1);
		// Stray lines fold into the cell body (no terminator), which is fine —
		// the contract is just "don't crash".
		expect(result.cells[0].code).toContain("print(1)");
	});
});
