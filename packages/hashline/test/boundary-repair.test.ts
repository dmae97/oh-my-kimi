import { describe, expect, it } from "bun:test";
import { applyEdits, InMemorySnapshotStore, parsePatch, Recovery } from "@oh-my-pi/hashline";

function apply(text: string, diff: string): { text: string; warnings: string[] } {
	const result = applyEdits(text, parsePatch(diff).edits);
	return { text: result.text, warnings: result.warnings ?? [] };
}

describe("boundary-balance repair", () => {
	// The canonical incident: a range-replace whose payload restates the
	// fragment + paren close that still live just below the range, doubling
	// `</>` and `);`. `replace 11..31:` covers `const …` through the second `/>`.
	it("drops a duplicated multi-line closing block (the Root.tsx incident)", () => {
		const file = [
			'import type React from "react";',
			'import { Composition } from "remotion";',
			'import { Sizzle, type SizzleProps } from "./compositions/Sizzle";',
			'import { FPS, totalDurationInFrames } from "./lib/scenes";',
			"",
			"export const RemotionRoot: React.FC = () => {",
			"\tconst durationInFrames = totalDurationInFrames();",
			"\treturn (",
			"\t\t<>",
			"\t\t\t<Composition",
			'\t\t\t\tid="Sizzle"',
			"\t\t\t\tcomponent={Sizzle}",
			"\t\t\t\tdurationInFrames={durationInFrames}",
			"\t\t\t\twidth={1920}",
			'\t\t\t\tdefaultProps={{ layout: "landscape" }}',
			"\t\t\t/>",
			"\t\t</>",
			"\t);",
			"};",
		].join("\n");
		// Range 7..16 = `const …` through the first `/>`; payload restates the
		// `</>` + `);` that survive at lines 17-18.
		const diff = [
			"replace 7..16:",
			"+\treturn (",
			"+\t\t<>",
			"+\t\t\t<Composition",
			'+\t\t\t\tid="Sizzle"',
			"+\t\t\t\tcomponent={Sizzle}",
			"+\t\t\t\tdurationInFrames={durationInFrames}",
			"+\t\t\t\twidth={1920}",
			'+\t\t\t\tdefaultProps={{ layout: "landscape" } satisfies SizzleProps}',
			"+\t\t\t/>",
			"+\t\t</>",
			"+\t);",
		].join("\n");
		const { text, warnings } = apply(file, diff);
		// Exactly one `</>` and one `);` survive — no doubling.
		expect(text.split("\n").filter(l => l.trim() === "</>")).toHaveLength(1);
		expect(text.split("\n").filter(l => l.trim() === ");")).toHaveLength(1);
		expect(text.endsWith("\t\t</>\n\t);\n};")).toBe(true);
		expect(warnings.some(w => /delimiter-balance/.test(w))).toBe(true);
	});

	// Single structural-closer duplication: the range ends one line short and
	// the payload restates the `});` that survives just below it.
	it("drops a single duplicated structural closer (`});`)", () => {
		const file = ["it('a', () => {", "\tsetup();", "\trun();", "});", "after();"].join("\n");
		// `replace 2..3:` replaces the two body lines but the payload also restates the
		// `});` at line 4, which survives — a duplicate close.
		const diff = ["replace 2..3:", "+\tsetup2();", "+\trun2();", "+});"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["it('a', () => {", "\tsetup2();", "\trun2();", "});", "after();"].join("\n"));
		expect(warnings.some(w => /delimiter-balance/.test(w))).toBe(true);
	});

	// Genuine missing-closer: payload omits the trailing `});`.
	it("spares the deleted closing line when the payload omits it", () => {
		const file = ["const handlers = {", "\ta() {", "\t\treturn 1;", "\t},", "};"].join("\n");
		// `replace 5..5:` is the final `};`. Model inserts a new method but forgets to
		// restate `};`; sparing it keeps the object literal balanced.
		const diff = ["replace 5..5:", "+\tb() {", "+\t\treturn 2;", "+\t},"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(
			["const handlers = {", "\ta() {", "\t\treturn 1;", "\t},", "\tb() {", "\t\treturn 2;", "\t},", "};"].join(
				"\n",
			),
		);
		expect(warnings.some(w => /delimiter-balance/.test(w))).toBe(true);
	});

	// Balance-preserving edits are never touched, even when the payload's last
	// line coincidentally equals the line just below the range.
	it("leaves a balance-preserving replacement alone (no false positive)", () => {
		const file = ["foo();", "bar();", "bar();", "baz();"].join("\n");
		// Replace line 2 with two balanced statements; the tail `bar();` equals
		// the surviving line 3 but the payload is balanced — must NOT be dropped.
		const diff = ["replace 2..2:", "+qux();", "+bar();"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["foo();", "qux();", "bar();", "bar();", "baz();"].join("\n"));
		expect(warnings).toHaveLength(0);
	});

	// A duplicated full statement (balance-neutral) is left intact: dropping it
	// could discard intended content, and it does not break syntax.
	it("does not drop a balance-neutral duplicated statement", () => {
		const file = ["a = 1;", "b = 2;", "c = 3;"].join("\n");
		const diff = ["replace 1..1:", "+a = 1;", "+b = 2;"].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(["a = 1;", "b = 2;", "b = 2;", "c = 3;"].join("\n"));
		expect(warnings).toHaveLength(0);
	});

	// Brackets inside strings must not trigger a spurious balance mismatch.
	it("ignores brackets inside string literals", () => {
		const file = ['const a = "}";', 'const b = "x";', 'const c = "y";'].join("\n");
		const diff = ["replace 2..2:", '+const b = "}}}";'].join("\n");
		const { text, warnings } = apply(file, diff);
		expect(text).toBe(['const a = "}";', 'const b = "}}}";', 'const c = "y";'].join("\n"));
		expect(warnings).toHaveLength(0);
	});
});

describe("boundary-balance repair through stale-snapshot recovery", () => {
	const PATH = "/tmp/__hashline-boundary-recovery__.ts";

	// Recovery composes `applyEdits` to compute the intended change, so the
	// boundary repair runs there too. The snapshot (what the model read)
	// carries the structure; the live file has drifted far from the edit
	// region, so the stale-hash 3-way merge succeeds and the repaired
	// (de-duplicated) hunk lands without doubling the closer.
	it("de-duplicates a closer while recovering from a drifted file", () => {
		const snapshotLines = [
			'import { x } from "y";',
			"",
			"it('a', () => {",
			"\tsetup();",
			"\trun();",
			"});",
			"",
			"function filler1() { return 1; }",
			"function filler2() { return 2; }",
			"function filler3() { return 3; }",
			"function filler4() { return 4; }",
			"function filler5() { return 5; }",
			"const tail = 0;",
			"export { tail };",
		];
		const snapshotText = `${snapshotLines.join("\n")}\n`;
		// Live file drifted only at the tail (line 13) — far outside the edit
		// region (lines 4-6), so the 3-way merge applies cleanly.
		const currentText = snapshotText.replace("const tail = 0;", "const tail = 99;");

		const store = new InMemorySnapshotStore();
		const fileHash = store.record(PATH, snapshotText);

		// `replace 4..5:` replaces the body lines but the payload also restates the `});`
		// that survives at line 6 — the duplicate-closer mistake.
		const { edits } = parsePatch(["replace 4..5:", "+\tsetup2();", "+\trun2();", "+});"].join("\n"));
		const recovered = new Recovery(store).tryRecover({ path: PATH, currentText, fileHash, edits });

		expect(recovered).not.toBeNull();
		// Exactly one `});` — the duplicate was absorbed during recovery.
		expect(recovered?.text.split("\n").filter(l => l === "});")).toHaveLength(1);
		expect(recovered?.text).toContain("setup2();");
		expect(recovered?.text).toContain("run2();");
		// The unrelated drift on the live file survives the merge.
		expect(recovered?.text).toContain("const tail = 99;");
		// The repair warning propagates out through the recovery result.
		expect(recovered?.warnings.some(w => /delimiter-balance/.test(w))).toBe(true);
	});
});
