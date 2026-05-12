import { describe, expect, it } from "bun:test";
import { TEMPLATE } from "../../src/export/html/template.generated";

// Regression: `String.prototype.replace(string, string)` treats `$'`, `$&`,
// `$$`, `$n`, etc. as substitution patterns. The inlined `<script>` body now
// contains JS regex literals like `'\\s*Cell\\b\\s*(.*)$'` whose trailing `$'`
// would be expanded to "the text after `<template-js/>`" (i.e. `</body></html>`)
// if the replacement is a plain string instead of a function. That spliced the
// closing HTML tags into the middle of a regex string and produced
// `Uncaught SyntaxError: Invalid or unexpected token` at runtime.
// The fix is to pass the replacement as a function in
// scripts/generate-template.ts (and the mirror in template.macro.ts).
describe("HTML export template script inlining", () => {
	function extractScript(): string {
		const match = TEMPLATE.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
		if (!match) throw new Error("inlined <script> block not found in TEMPLATE");
		return match[1];
	}

	it("preserves the literal `$'` regex anchor inside the inlined script", () => {
		const script = extractScript();
		// The eval-cell parser must still contain the raw `(.*)$'` and `End\\b.*$'`
		// regex sources — these are exactly the substrings that trigger the bug
		// when the replacement is treated as a substitution template.
		expect(script).toContain("\\\\s*Cell\\\\b\\\\s*(.*)$', 'i'");
		expect(script).toContain("\\\\s*End\\\\b.*$', 'i'");
	});

	it("does not splice closing HTML tags into the inlined script", () => {
		const script = extractScript();
		expect(script).not.toMatch(/<\/body>/i);
		expect(script).not.toMatch(/<\/html>/i);
	});

	it("produces a syntactically valid inlined script", () => {
		const script = extractScript();
		// `new Function(body)` parses without executing. Throws SyntaxError on
		// the spliced-tag corruption the substitution-pattern bug produces.
		expect(() => new Function(script)).not.toThrow();
	});
});
