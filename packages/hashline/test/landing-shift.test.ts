import { describe, expect, it } from "bun:test";
import { applyEdits, type BlockResolver, type BlockSpan, Patch, parsePatch } from "@oh-my-pi/hashline";

/**
 * After-insert landing correction: an `insert after N:` body indented
 * shallower than line N slides past the structural closer lines below the
 * anchor until depth returns to the body's level. Contract under test: the
 * shift fires only on a comparable, strictly-shallower depth claim, crosses
 * closers only, respects other hunks' targets, and always reports a warning.
 */

const FILE = [
	"function f() {", // 1
	"    if (x) {", // 2
	"        a();", // 3
	"    }", // 4
	"    b();", // 5
	"}", // 6
	"",
].join("\n");

function apply(text: string, patch: string): { text: string; warnings: string[] } {
	const { edits } = parsePatch(patch);
	const result = applyEdits(text, edits);
	return { text: result.text, warnings: result.warnings ?? [] };
}

describe("after-insert landing shift", () => {
	it("slides a shallower body past the closing line and warns", () => {
		const { text, warnings } = apply(FILE, "insert after 3:\n+    c();");

		expect(text).toBe(
			["function f() {", "    if (x) {", "        a();", "    }", "    c();", "    b();", "}", ""].join("\n"),
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/insert after 3: .*moved past 1 closing line to after line 4/);
	});

	it("crosses multiple closer levels and stops when depth returns to the body's", () => {
		const nested = [
			"function f() {", // 1
			"    if (x) {", // 2
			"        for (y) {", // 3
			"            a();", // 4
			"        }", // 5
			"    }", // 6
			"    b();", // 7
			"}", // 8
			"",
		].join("\n");

		// Body at depth 4 escapes both the `for` and the `if`.
		const outer = apply(nested, "insert after 4:\n+    c();");
		expect(outer.text.split("\n")[6]).toBe("    c();");
		expect(outer.warnings[0]).toMatch(/moved past 2 closing lines to after line 6/);

		// Body at depth 8 escapes only the `for`, staying inside the `if`.
		const inner = apply(nested, "insert after 4:\n+        c();");
		expect(inner.text.split("\n")[5]).toBe("        c();");
		expect(inner.warnings[0]).toMatch(/moved past 1 closing line to after line 5/);
	});

	it("does not shift when the body matches the anchor's depth", () => {
		const { text, warnings } = apply(FILE, "insert after 3:\n+        c();");
		expect(text.split("\n")[3]).toBe("        c();");
		expect(warnings).toHaveLength(0);
	});

	it("never crosses content lines (indentation-only languages stay put)", () => {
		const py = ["def f():", "    if x:", "        a()", "    b()", ""].join("\n");
		const { text, warnings } = apply(py, "insert after 3:\n+    c()");
		expect(text).toBe(["def f():", "    if x:", "        a()", "    c()", "    b()", ""].join("\n"));
		expect(warnings).toHaveLength(0);
	});

	it("treats a body of pure closers as depth-neutral", () => {
		const { text, warnings } = apply(FILE, "insert after 3:\n+    }");
		expect(text.split("\n")[3]).toBe("    }");
		expect(warnings).toHaveLength(0);
	});

	it("skips incomparable indentation styles (tabs file, spaces body)", () => {
		const tabs = ["function f() {", "\tif (x) {", "\t\ta();", "\t}", "\tb();", "}", ""].join("\n");
		const { text, warnings } = apply(tabs, "insert after 3:\n+    c();");
		expect(text.split("\n")[3]).toBe("    c();");
		expect(warnings).toHaveLength(0);
	});

	it("refuses to cross a line targeted by another hunk", () => {
		const { text, warnings } = apply(FILE, "insert after 3:\n+    c();\ndelete 4");
		// The closer on line 4 is owned by the delete; the insert stays put.
		expect(text).toBe(["function f() {", "    if (x) {", "        a();", "    c();", "    b();", "}", ""].join("\n"));
		expect(warnings).toHaveLength(0);
	});

	it("looks past blank lines between the anchor and the closer", () => {
		const gapped = ["function f() {", "    if (x) {", "        a();", "", "    }", "    b();", "}", ""].join("\n");
		const { text, warnings } = apply(gapped, "insert after 3:\n+    c();");
		expect(text).toBe(
			["function f() {", "    if (x) {", "        a();", "", "    }", "    c();", "    b();", "}", ""].join("\n"),
		);
		expect(warnings[0]).toMatch(/after line 5/);
	});

	it("leaves `insert before N:` untouched", () => {
		const { text, warnings } = apply(FILE, "insert before 4:\n+    c();");
		expect(text.split("\n")[3]).toBe("    c();");
		expect(warnings).toHaveLength(0);
	});

	it("composes with `insert after block N:` to escape enclosing closers", () => {
		// stub: block beginning on N spans [N, N+1] → `block 2` ends on line 3.
		const stubResolver: BlockResolver = ({ line }): BlockSpan => ({ start: line, end: line + 1 });
		const text = ["function f() {", "    const t = mk({", "    });", "}", "x();", ""].join("\n");
		const section = Patch.parseSingle("[x.ts#1A2B]\ninsert after block 2:\n+ref = t;");

		const result = section.applyTo(text, stubResolver);

		// after_anchor lands on span.end (line 3); the depth-0 body then slides
		// past the function's closing `}` on line 4.
		expect(result.text).toBe(
			["function f() {", "    const t = mk({", "    });", "}", "ref = t;", "x();", ""].join("\n"),
		);
		expect(result.warnings?.some(w => /moved past 1 closing line to after line 4/.test(w))).toBe(true);
	});
});
