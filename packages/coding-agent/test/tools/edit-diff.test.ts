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

		expect(diffLines).toContain(" 5|...");
		expect(diffLines).toContain("-2|line 2");
		expect(diffLines).toContain("+2|line 2 changed");
		expect(diffLines).toContain("-18|line 18");
		expect(diffLines).toContain("+18|line 18 changed");
		expect(diffLines).not.toContain(" 8|line 8");
		expect(diffLines).not.toContain(" 12|line 12");
	});
});
