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

	it("keeps a plain expression on a single line", () => {
		expect(latexToBlock("e^{i\\pi} + 1 = 0")).toEqual(["e^(iπ) + 1 = 0"]);
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

	it("renders matrices flat (grid environments are not stacked as fractions)", () => {
		const lines = latexToBlock("\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}");
		expect(lines.length).toBe(2);
		expect(lines[0].startsWith("[")).toBe(true);
		expect(lines[lines.length - 1].endsWith("]")).toBe(true);
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
