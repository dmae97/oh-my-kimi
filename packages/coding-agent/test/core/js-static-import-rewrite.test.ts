import { describe, expect, it } from "bun:test";

import { rewriteStaticImports } from "../../src/eval/js/context-manager";

describe("rewriteStaticImports", () => {
	it("rewrites a top-level default import", () => {
		const out = rewriteStaticImports('import foo from "bar";\nconsole.log(foo);');
		expect(out).toContain('await import("bar")');
		expect(out).not.toContain('import foo from "bar"');
	});

	it("rewrites destructured named imports with renames", () => {
		const out = rewriteStaticImports('import { foo, bar as baz } from "pkg";');
		expect(out).toContain('await import("pkg")');
		expect(out).toContain("foo");
		expect(out).toContain("bar: baz");
	});

	it("rewrites namespace imports", () => {
		const out = rewriteStaticImports('import * as ns from "pkg";');
		expect(out).toContain('const ns = await import("pkg")');
	});

	it("rewrites combined default + namespace", () => {
		const out = rewriteStaticImports('import def, * as ns from "pkg";');
		expect(out).toContain('const ns = await import("pkg")');
		expect(out).toContain("const def = ns.default");
	});

	it("rewrites combined default + named", () => {
		const out = rewriteStaticImports('import def, { foo, bar as baz } from "pkg";');
		expect(out).toContain('await import("pkg")');
		expect(out).toContain("default: def");
		expect(out).toContain("foo");
		expect(out).toContain("bar: baz");
	});

	it("rewrites side-effect-only imports", () => {
		const out = rewriteStaticImports('import "polyfill";');
		expect(out).toContain('await import("polyfill")');
	});

	it("preserves import attributes via the dynamic import options bag", () => {
		const out = rewriteStaticImports('import data from "./d.json" with { type: "json" };');
		expect(out).toContain('await import("./d.json", { with: { type: "json" } })');
		expect(out).toContain("const data =");
	});

	it("does not rewrite import statements embedded in template literals (the bug)", () => {
		const code = ["const generated = `", 'import { foo } from "./foo";', "export const bar = foo + 1;", "`;"].join(
			"\n",
		);
		const out = rewriteStaticImports(code);
		expect(out).toContain('import { foo } from "./foo";');
		expect(out).toContain("export const bar = foo + 1;");
		expect(out).not.toContain("await import(");
	});

	it("does not rewrite import statements inside block comments", () => {
		const code = '/*\nimport foo from "bar";\n*/\nconst x = 1;';
		const out = rewriteStaticImports(code);
		expect(out).toContain('import foo from "bar";');
		expect(out).not.toContain('await import("bar")');
	});

	it("does not rewrite import statements inside double-quoted strings using line continuation", () => {
		const code = "const code = \"import foo from \\\n'bar'\";\nconsole.log(code);";
		const out = rewriteStaticImports(code);
		expect(out).not.toContain("await import");
	});

	it("rewrites real top-level imports while leaving template-embedded look-alikes alone", () => {
		const code = [
			'import a from "alpha";',
			"const code = `",
			'import b from "beta";',
			"`;",
			'import c from "gamma";',
		].join("\n");
		const out = rewriteStaticImports(code);
		expect(out).toContain('await import("alpha")');
		expect(out).toContain('await import("gamma")');
		expect(out).not.toContain('await import("beta")');
		expect(out).toContain('import b from "beta";');
	});

	it("returns the input unchanged when there are no imports", () => {
		const code = "const x = 1 + 2;\nreturn x;";
		expect(rewriteStaticImports(code)).toBe(code);
	});

	it("returns the input unchanged when the parser cannot make sense of the code", () => {
		const code = "import { foo from broken syntax 'unterminated";
		// Should not throw; should fall through to the VM which will surface the syntax error.
		expect(() => rewriteStaticImports(code)).not.toThrow();
	});
});
