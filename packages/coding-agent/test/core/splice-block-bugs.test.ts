/**
 * Repro tests for the four `splice_block` defects surfaced by the
 * fixture-run review (omp-fixture-runs-20260426-235127). Each test guards
 * the repaired behavior.
 */
import { describe, expect, it } from "bun:test";
import { type AtomEdit, applyAtomEdits, computeLineHash } from "@oh-my-pi/pi-coding-agent/edit";
import type { Anchor } from "@oh-my-pi/pi-coding-agent/edit/modes/hashline";

function tag(line: number, content: string): Anchor {
	return { line, hash: computeLineHash(line, content) };
}

describe("BUG 1 — [anchor] must replace the whole node", () => {
	it("does not double the declaration line", () => {
		const content = ["class C {", "\tisRunning(): boolean {", "\t\treturn this.running;", "\t}", "}", ""].join("\n");
		const edits: AtomEdit[] = [
			{
				op: "splice_block",
				pos: tag(3, "\t\treturn this.running;"),
				spec: { body: ["isRunning(): boolean {", "\treturn this._running;", "}"], kind: "{" },
				bracket: "node",
			},
		];
		const result = applyAtomEdits(content, edits);
		const lines = result.lines.split("\n");
		const sigLines = lines.filter(l => l.includes("isRunning(): boolean"));
		expect(sigLines).toHaveLength(1);
		expect(result.lines).not.toMatch(/isRunning\(\): boolean\s+isRunning\(\): boolean/);
	});
});

describe("BUG 2 — false-positive unbalanced-`{` warning", () => {
	it("does not warn when post-edit file is syntactically valid (JS regex literal)", () => {
		const content = ["function f() {", "\tconst re = /[{]/g;", "\treturn re.test(s);", "}", ""].join("\n");
		const edits: AtomEdit[] = [
			{
				op: "splice_block",
				pos: tag(3, "\treturn re.test(s);"),
				spec: { body: ["return Boolean(re.exec(s));"], kind: "{" },
				bracket: "body",
			},
		];
		const result = applyAtomEdits(content, edits);
		const imbalanceWarnings = (result.warnings ?? []).filter(w => w.includes("unbalanced"));
		expect(imbalanceWarnings).toEqual([]);
	});
});

describe("BUG 3 — splice_block must surface the chosen block range", () => {
	it("surfaces the chosen block range so callers can verify intent", () => {
		const content = [
			"func Dispatch() error {",
			"\tvar errs []error",
			"\tfor _, sink := range sinks {",
			"\t\tif err := sink.Write(); err != nil {",
			"\t\t\terrs = append(errs, err)",
			"\t\t}",
			"\t}",
			"\tif len(errs) == 0 {",
			"\t\treturn nil",
			"\t}",
			"\treturn errors.Join(errs...)",
			"}",
			"",
		].join("\n");
		const edits: AtomEdit[] = [
			{
				op: "splice_block",
				pos: tag(11, "\treturn errors.Join(errs...)"),
				spec: { body: ["return joinAll(errs)"], kind: "{" },
				bracket: "body",
			},
		];
		const result = applyAtomEdits(content, edits);
		const hint = (result.warnings ?? []).find(w => /splice locator.*replaced.*lines? \d+/i.test(w));
		expect(hint).toBeDefined();
	});
});

describe("BUG 4 — kind:'(' must work on single-line calls", () => {
	it("finds a same-line `(` block by anchor on that line", () => {
		const content = ["def make():", "\treturn Config(host=host.strip(), port=int(port))", ""].join("\n");
		const edits: AtomEdit[] = [
			{
				op: "splice_block",
				pos: tag(2, "\treturn Config(host=host.strip(), port=int(port))"),
				spec: { body: ["host=host, port=port"], kind: "(" },
				bracket: "body",
			},
		];
		const result = applyAtomEdits(content, edits);
		expect(result.lines).toContain("Config(host=host, port=port)");
	});
});
