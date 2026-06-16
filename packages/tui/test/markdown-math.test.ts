import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Markdown, renderInlineMarkdown } from "../src/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

/** Render markdown and return non-empty, ANSI-stripped, right-trimmed lines. */
function renderLines(md: string, width = 100): string[] {
	return new Markdown(md, 0, 0, defaultMarkdownTheme)
		.render(width)
		.map(line => stripVTControlCharacters(line).replace(/\s+$/, ""))
		.filter(line => line !== "");
}

describe("Markdown math rendering", () => {
	it("converts inline $…$ math inside prose", () => {
		const [line] = renderLines("the area is $A = \\pi r^2$ exactly");
		expect(line).toBe("the area is A = π r² exactly");
	});

	it("converts subscripts/superscripts in inline math without markdown mangling", () => {
		// `x_i^2` survives because intraword `_` is not emphasis and `^` is plain.
		const [line] = renderLines("energy $x_i^2 + y_j^2$ done");
		expect(line).toBe("energy xᵢ² + yⱼ² done");
	});

	it("renders an own-line $$…$$ matrix block across multiple lines", () => {
		const lines = renderLines("$$\n\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}\n$$");
		// Two rows, not collapsed onto one line.
		expect(lines.length).toBe(2);
		expect(lines[0].startsWith("[")).toBe(true);
		expect(lines[lines.length - 1].endsWith("]")).toBe(true);
		expect(lines.join("").replace(/[\s[\]]/g, "")).toBe("abcd");
	});

	it("renders a \\[…\\] display block (quadratic formula)", () => {
		const [line] = renderLines("\\[\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n\\]");
		expect(line).toBe("x = (-b ± √(b² - 4ac))/(2a)");
	});

	it("keeps display math inside a list item multi-line", () => {
		const lines = renderLines("- result:\n\n  $$\n  \\begin{bmatrix} a \\\\ b \\end{bmatrix}\n  $$");
		// The matrix rows must land on distinct lines (not flattened to "[a b]").
		const openRow = lines.findIndex(line => line.includes("[a"));
		const closeRow = lines.findIndex(line => line.includes("b]"));
		expect(openRow).toBeGreaterThanOrEqual(0);
		expect(closeRow).toBeGreaterThan(openRow);
	});

	it("leaves math inside an inline code span literal", () => {
		const [line] = renderLines("use `$x^2$` literally and $y^2$ as math");
		expect(line).toBe("use $x^2$ literally and y² as math");
	});

	it("leaves math inside a fenced code block literal", () => {
		const lines = renderLines("```\n$a$ and $b$\n```");
		expect(lines.some(l => l.includes("$a$ and $b$"))).toBe(true);
	});

	it("does not convert currency-style dollars", () => {
		const [line] = renderLines("it costs $5 and $10 total");
		expect(line).toBe("it costs $5 and $10 total");
	});

	it("renderInlineMarkdown converts inline math", () => {
		const out = stripVTControlCharacters(renderInlineMarkdown("energy $E=mc^2$ here", defaultMarkdownTheme));
		expect(out).toBe("energy E=mc² here");
	});

	it("renderInlineMarkdown handles a top-level display math token", () => {
		// A bare $$…$$ becomes a top-level `math` token; it must not leak raw LaTeX.
		const out = stripVTControlCharacters(renderInlineMarkdown("$$E = mc^2$$", defaultMarkdownTheme));
		expect(out).toBe("E = mc²");
	});
});
