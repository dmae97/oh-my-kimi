import { afterEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { latexToBlock } from "@oh-my-pi/pi-tui/latex-block";
import { TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";

const originalTrueColor = TERMINAL.trueColor;
afterEach(() => {
	Object.assign(TERMINAL, { trueColor: originalTrueColor });
});

describe("latexToBlock (stacked display fractions)", () => {
	it("stacks a simple fraction with a centered bar", () => {
		expect(latexToBlock("\\frac{1}{2}")).toEqual([" 1 ", "───", " 2 "]);
	});

	it("sizes the bar to the wider of numerator and denominator", () => {
		expect(latexToBlock("\\frac{a+b}{c}")).toEqual([" a+b ", "─────", "  c  "]);
	});

	it("aligns surrounding text to the fraction bar", () => {
		expect(latexToBlock("x = \\frac{a+b}{c}")).toEqual(["     a+b ", "x = ─────", "      c  "]);
	});

	it("nests fractions (numerator is itself a fraction)", () => {
		// (a/b) over c → the inner fraction occupies the numerator rows.
		expect(latexToBlock("\\frac{\\frac{a}{b}}{c}")).toEqual(["  a  ", " ─── ", "  b  ", "─────", "  c  "]);
	});

	it("keeps a fully convertible expression on a single line", () => {
		expect(latexToBlock("x^2 + y_1 = 0")).toEqual(["x² + y₁ = 0"]);
	});

	it("raises a non-convertible exponent as a block (Euler's identity)", () => {
		expect(latexToBlock("e^{i\\pi} + 1 = 0").map(line => line.trimEnd())).toEqual([" iπ", "e   + 1 = 0"]);
	});

	it("stacks fractions inside wrapper environments (equation)", () => {
		expect(latexToBlock("\\begin{equation} x = \\frac{a+b}{c} \\end{equation}")).toEqual([
			"     a+b ",
			"x = ─────",
			"      c  ",
		]);
	});

	it("skips the column-count preamble of alignat", () => {
		const lines = latexToBlock("\\begin{alignat}{2} a &= \\frac{1}{2} \\end{alignat}");
		// The `{2}` argument must not appear in the rendered rows.
		expect(lines.join("\n")).not.toContain("{2}");
		expect(lines.some(line => line.includes("───"))).toBe(true);
		expect(lines[0].trim()).toBe("1");
	});

	it("stacks each row of an aligned environment", () => {
		const lines = latexToBlock("\\begin{aligned} y &= \\frac{1}{2} \\\\ z &= \\frac{3}{4} \\end{aligned}");
		// Two stacked fractions → six rows; bars on rows 1 and 4.
		expect(lines.length).toBe(6);
		expect(lines[1]).toContain("───");
		expect(lines[4]).toContain("───");
		expect(stripVTControlCharacters(lines[0])).toContain("1");
		expect(stripVTControlCharacters(lines[5])).toContain("4");
	});

	it("renders matrix environments as center-baselined grids in stretched brackets", () => {
		expect(latexToBlock("\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}")).toEqual([
			"⎡ a  b ⎤",
			"⎢      ⎥",
			"⎣ c  d ⎦",
		]);
		expect(latexToBlock("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}")).toEqual([
			"⎛ a  b ⎞",
			"⎜      ⎟",
			"⎝ c  d ⎠",
		]);
		// Single-row matrices stay flat.
		expect(latexToBlock("\\begin{pmatrix} a & b & c \\end{pmatrix}")).toEqual(["(a  b  c)"]);
	});

	it("centers using visible width, ignoring ANSI color codes in a numerator", () => {
		Object.assign(TERMINAL, { trueColor: true });
		const lines = latexToBlock("\\frac{\\textcolor{red}{a}}{b}");
		// The bar width follows the visible glyph (1), not the ANSI byte length.
		expect(stripVTControlCharacters(lines[1])).toBe("───");
		expect(lines.map(stripVTControlCharacters)).toEqual([" a ", "───", " b "]);
		expect(lines[0]).toContain("\x1b"); // numerator really is colored
	});

	it("returns no lines for empty input", () => {
		expect(latexToBlock("")).toEqual([]);
		expect(latexToBlock("   ")).toEqual([]);
	});
});
describe("latexToBlock (2-D layout)", () => {
	it("baseline-aligns matrix cells containing fractions", () => {
		expect(latexToBlock("\\begin{bmatrix} \\frac{1}{2} & x \\\\ y & z \\end{bmatrix}")).toEqual([
			"⎡  1     ⎤",
			"⎢ ───  x ⎥",
			"⎢  2     ⎥",
			"⎢        ⎥",
			"⎣  y   z ⎦",
		]);
	});

	it("centers surrounding text on the matrix middle", () => {
		expect(latexToBlock("A = \\begin{bmatrix} a \\\\ b \\end{bmatrix}")).toEqual([
			"    ⎡ a ⎤",
			"A = ⎢   ⎥",
			"    ⎣ b ⎦",
		]);
	});

	it("renders vmatrix with full-height bars", () => {
		expect(latexToBlock("\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}")).toEqual([
			"│ a  b │",
			"│      │",
			"│ c  d │",
		]);
	});

	it("honors the array column specification", () => {
		expect(
			latexToBlock("\\begin{array}{lcr} 1 & 22 & 333 \\\\ aaa & b & c \\end{array}").map(line => line.trimEnd()),
		).toEqual(["1    22  333", "", "aaa  b     c"]);
	});

	it("renders cases with a stretched left brace and left-aligned columns", () => {
		const lines = latexToBlock("f(x) = \\begin{cases} x & x > 0 \\\\ 0 & \\text{otherwise} \\end{cases}");
		expect(lines.map(line => line.trimEnd())).toEqual(["       ⎧ x  x > 0", "f(x) = ⎨", "       ⎩ 0  otherwise"]);
	});

	it("stacks big-operator limits above and below the symbol", () => {
		expect(latexToBlock("\\sum_{i=0}^{n} i^2")).toEqual([" n    ", " ∑  i²", "i=0   "]);
	});

	it("places \\lim scripts underneath", () => {
		const lines = latexToBlock("\\lim_{x \\to 0} \\frac{\\sin x}{x}");
		expect(lines[1]).toContain("lim");
		expect(lines[2]).toContain("x → 0");
		expect(lines[1]).toContain("───"); // fraction bar on the lim baseline row
	});

	it("keeps integral bounds beside the symbol unless \\limits is given", () => {
		expect(latexToBlock("\\int_a^b f(x) dx")).toEqual(["∫ₐᵇ f(x) dx"]);
		expect(latexToBlock("\\int\\limits_a^b f(x) dx").map(line => line.trimEnd())).toEqual(["b", "∫ f(x) dx", "a"]);
	});

	it("stretches \\left…\\right delimiters around tall content and pins corner scripts", () => {
		expect(latexToBlock("\\left( \\frac{a+b}{c} \\right)^2").map(line => line.trimEnd())).toEqual([
			"⎛  a+b  ⎞²",
			"⎜ ───── ⎟",
			"⎝   c   ⎠",
		]);
	});

	it("stretches bare parentheses around a fraction", () => {
		expect(latexToBlock("( \\frac{a}{b} )")).toEqual(["⎛   a   ⎞", "⎜  ───  ⎟", "⎝   b   ⎠"]);
	});

	it("leaves unbalanced interval brackets on the baseline", () => {
		expect(latexToBlock("[0, 1)")).toEqual(["[0, 1)"]);
	});

	it("renders \\middle delimiters at full height inside \\left…\\right", () => {
		const lines = latexToBlock("\\left\\{ x \\middle| \\frac{x}{2} \\in \\mathbb{Z} \\right\\}");
		expect(lines.length).toBe(3);
		expect(lines[1].startsWith("⎨")).toBe(true);
		expect(lines[1]).toContain("│");
		expect(lines[1].endsWith("⎬")).toBe(true);
	});

	it("always draws the radical roof in display math", () => {
		expect(latexToBlock("\\sqrt{\\frac{a+1}{b}}").map(line => line.trimEnd())).toEqual([
			" ┌──────",
			" │  a+1",
			" │ ─────",
			"╲│   b",
		]);
		expect(latexToBlock("\\sqrt{x}").map(line => line.trimEnd())).toEqual([" ┌──", "╲│ x"]);
	});

	it("stacks \\binom inside stretched parentheses", () => {
		expect(latexToBlock("\\binom{n}{k}")).toEqual(["⎛ n ⎞", "⎜   ⎟", "⎝ k ⎠"]);
	});

	it("raises a block superscript containing a fraction", () => {
		expect(latexToBlock("e^{\\frac{x}{2}}").map(line => line.trimEnd())).toEqual(["  x", " ───", "  2", "e"]);
	});
	it("raises/lowers one-line scripts that have no Unicode form", () => {
		// `q` has no superscript/subscript code point; a real box replaces `^(q)`.
		expect(latexToBlock("x^q").map(line => line.trimEnd())).toEqual([" q", "x"]);
		expect(latexToBlock("x_q").map(line => line.trimEnd())).toEqual(["x", " q"]);
		expect(latexToBlock("x_q^q").map(line => line.trimEnd())).toEqual([" q", "x", " q"]);
	});

	it("pins both scripts of a tall base in one shared column", () => {
		expect(latexToBlock("\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}_0^T").map(line => line.trimEnd())).toEqual([
			"⎡ a  b ⎤ᵀ",
			"⎢      ⎥",
			"⎣ c  d ⎦₀",
		]);
	});

	it("aligns align-environment rows on the & column", () => {
		expect(
			latexToBlock("\\begin{align} f(x) &= x^2 + 1 \\\\ g(x) &= \\frac{x}{2} \\end{align}").map(line =>
				line.trimEnd(),
			),
		).toEqual(["f(x) = x² + 1", "        x", "g(x) = ───", "        2"]);
	});

	it("centers gather-environment rows", () => {
		expect(latexToBlock("\\begin{gather} a = b \\\\ longer = expression \\end{gather}")).toEqual([
			"       a = b       ",
			"longer = expression",
		]);
	});

	it("splits top-level \\\\ into vertical rows", () => {
		expect(latexToBlock("a \\\\ b")).toEqual(["a", "b"]);
	});

	it("keeps \\color scope across a stacked fraction, painting the bar", () => {
		Object.assign(TERMINAL, { trueColor: true });
		const lines = latexToBlock("\\color{red} x + \\frac{a}{b}");
		expect(lines.map(stripVTControlCharacters).map(line => line.trimEnd())).toEqual([
			"      a",
			" x + ───",
			"      b",
		]);
		expect(lines[0]).toContain("\x1b[38;"); // numerator run is colored
		expect(lines[1]).toContain("\x1b[38;"); // "x + " run and the bar are colored
	});

	it("paints textcolor-scoped structural glyphs (fraction bar)", () => {
		Object.assign(TERMINAL, { trueColor: true });
		const lines = latexToBlock("\\textcolor{red}{\\frac{a}{b}}");
		expect(lines.map(stripVTControlCharacters)).toEqual([" a ", "───", " b "]);
		expect(lines[1]).toContain("\x1b[38;"); // the synthesized bar inherits the scope color
	});

	it("styles fonts across a stacked fraction (\\mathbf)", () => {
		expect(latexToBlock("\\mathbf{\\frac{a}{b}}")).toEqual([" 𝐚 ", "───", " 𝐛 "]);
	});

	it("stacks limit operators inside styling wrappers", () => {
		Object.assign(TERMINAL, { trueColor: true });
		const lines = latexToBlock("\\textcolor{red}{\\sum_{i=1}^n}");
		expect(lines.map(stripVTControlCharacters).map(line => line.trimEnd())).toEqual([" n", " ∑", "i=1"]);
	});
});
