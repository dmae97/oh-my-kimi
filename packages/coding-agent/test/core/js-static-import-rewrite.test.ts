import { describe, expect, it } from "bun:test";

import { rewriteImports } from "../../src/eval/js/context-manager";

// Test fixtures embed user-supplied `import(...)` syntax that the rewriter must
// transform. The strings are split so static-analysis heuristics don't read them
// as real imports in this file.
const IMPORT = "import";
const dyn = (rest: string) => `${IMPORT}${rest}`;

describe("rewriteImports", () => {
	it("rewrites a top-level default import", () => {
		const out = rewriteImports(`${IMPORT} foo from "bar";\nconsole.log(foo);`);
		expect(out).toContain('await __omp_import__("bar")');
		expect(out).not.toContain(`${IMPORT} foo from "bar"`);
	});

	it("rewrites destructured named imports with renames", () => {
		const out = rewriteImports(`${IMPORT} { foo, bar as baz } from "pkg";`);
		expect(out).toContain('await __omp_import__("pkg")');
		expect(out).toContain("foo");
		expect(out).toContain("bar: baz");
	});

	it("rewrites namespace imports", () => {
		const out = rewriteImports(`${IMPORT} * as ns from "pkg";`);
		expect(out).toContain('const ns = await __omp_import__("pkg")');
	});

	it("rewrites combined default + namespace", () => {
		const out = rewriteImports(`${IMPORT} def, * as ns from "pkg";`);
		expect(out).toContain('const ns = await __omp_import__("pkg")');
		expect(out).toContain("const def = ns.default");
	});

	it("rewrites combined default + named", () => {
		const out = rewriteImports(`${IMPORT} def, { foo, bar as baz } from "pkg";`);
		expect(out).toContain('await __omp_import__("pkg")');
		expect(out).toContain("default: def");
		expect(out).toContain("bar: baz");
	});

	it("rewrites side-effect-only imports", () => {
		const out = rewriteImports(`${IMPORT} "polyfill";`);
		expect(out).toContain('await __omp_import__("polyfill")');
	});

	it("preserves import attributes via the dynamic import options bag", () => {
		const out = rewriteImports(`${IMPORT} data from "./d.json" with { type: "json" };`);
		expect(out).toContain('await __omp_import__("./d.json", { with: { type: "json" } })');
		expect(out).toContain("const data =");
	});

	it("rewrites bare dynamic import() so its specifier resolves against the session cwd", () => {
		const out = rewriteImports(`const m = await ${dyn('("./foo.ts")')};`);
		expect(out).toContain('await __omp_import__("./foo.ts")');
		expect(out).not.toContain(dyn('("./foo.ts")'));
	});

	it("rewrites dynamic import() with an options bag (passes options through unchanged)", () => {
		const out = rewriteImports(`const m = await ${dyn('("./d.json", { with: { type: "json" } })')};`);
		expect(out).toContain('__omp_import__("./d.json", { with: { type: "json" } })');
	});

	it("rewrites nested and chained dynamic import() calls", () => {
		const out = rewriteImports(
			`Promise.all([${dyn('("./a.ts")')}, ${dyn('("./b.ts")')}]).then(([a, b]) => a.run(b));`,
		);
		expect(out).toContain('__omp_import__("./a.ts")');
		expect(out).toContain('__omp_import__("./b.ts")');
		expect(out).not.toContain(dyn('("./a.ts")'));
	});

	it("rewrites dynamic import() with a non-literal specifier", () => {
		const out = rewriteImports(`const m = await ${dyn("(spec)")};`);
		expect(out).toContain("__omp_import__(spec)");
	});

	it("does not rewrite import statements embedded in template literals (the bug)", () => {
		const code = ["const generated = `", `${IMPORT} { foo } from "./foo";`, "export const bar = foo + 1;", "`;"].join(
			"\n",
		);
		const out = rewriteImports(code);
		expect(out).toContain(`${IMPORT} { foo } from "./foo";`);
		expect(out).toContain("export const bar = foo + 1;");
		expect(out).not.toContain("await __omp_import__(");
	});

	it("does not rewrite import statements inside block comments", () => {
		const code = `/*\n${IMPORT} foo from "bar";\n*/\nconst x = 1;`;
		const out = rewriteImports(code);
		expect(out).toContain(`${IMPORT} foo from "bar";`);
		expect(out).not.toContain('await __omp_import__("bar")');
	});

	it("does not rewrite import statements inside double-quoted strings using line continuation", () => {
		const code = `const code = "${IMPORT} foo from \\\n'bar'";\nconsole.log(code);`;
		const out = rewriteImports(code);
		expect(out).not.toContain("await __omp_import__");
	});

	it("rewrites real top-level imports while leaving template-embedded look-alikes alone", () => {
		const code = [
			`${IMPORT} a from "alpha";`,
			"const code = `",
			`${IMPORT} b from "beta";`,
			"`;",
			`${IMPORT} c from "gamma";`,
		].join("\n");
		const out = rewriteImports(code);
		expect(out).toContain('await __omp_import__("alpha")');
		expect(out).toContain('await __omp_import__("gamma")');
		expect(out).not.toContain('await __omp_import__("beta")');
		expect(out).toContain(`${IMPORT} b from "beta";`);
	});

	it("returns the input unchanged when there are no imports", () => {
		const code = "const x = 1 + 2;\nreturn x;";
		expect(rewriteImports(code)).toBe(code);
	});

	it("returns the input unchanged when the parser cannot make sense of the code", () => {
		const code = `${IMPORT} { foo from broken syntax 'unterminated`;
		// Should not throw; should fall through to the VM which will surface the syntax error.
		expect(() => rewriteImports(code)).not.toThrow();
	});
});
