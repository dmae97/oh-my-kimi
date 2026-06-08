import { describe, expect, it } from "bun:test";
import { generateDiffString } from "../../src/edit/diff";

describe("generateDiffString", () => {
	it("collapses unchanged lines between distant edits", () => {
		const oldLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
		const newLines = [...oldLines];
		newLines[1] = "line 2 changed";
		newLines[17] = "line 18 changed";

		const result = generateDiffString(oldLines.join("\n"), newLines.join("\n"), 2);
		const diffLines = result.diff.split("\n");

		// The mid-skip emits no placeholder row; the jump from the leading
		// context (line 4) to the trailing context (line 16) conveys the gap.
		expect(diffLines.some(line => line.endsWith("|...") || line.endsWith("|…"))).toBe(false);
		expect(diffLines[diffLines.indexOf(" 4|line 4") + 1]).toBe(" 16|line 16");
		expect(diffLines).toContain("-2|line 2");
		expect(diffLines).toContain("+2|line 2 changed");
		expect(diffLines).toContain("-18|line 18");
		expect(diffLines).toContain("+18|line 18 changed");
		expect(diffLines).not.toContain(" 8|line 8");
		expect(diffLines).not.toContain(" 12|line 12");
	});

	it("adds an elided matching bracket line when context stops before the closer", () => {
		const oldLines = [
			"function outer() {",
			"  const value = 1;",
			"  const two = 2;",
			"  const three = 3;",
			"  const four = 4;",
			"  return value + two + three + four;",
			"}",
		];
		const newLines = [...oldLines];
		newLines[0] = "function renamed() {";
		const result = generateDiffString(oldLines.join("\n"), newLines.join("\n"), 1, { path: "sample.ts" });
		const diffLines = result.diff.split("\n");

		expect(diffLines).toContain("-1|function outer() {");
		expect(diffLines).toContain("+1|function renamed() {");
		expect(diffLines).toContain("...");
		expect(diffLines).toContain(" 7|}");
		expect(diffLines).not.toContain(" 5|  const four = 4;");
		expect(diffLines).not.toContain(" 6|  return value + two + three + four;");
	});
});
