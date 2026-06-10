import { describe, expect, it } from "bun:test";
import { generateDiffString } from "@oh-my-pi/pi-coding-agent/edit/diff";

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
		// Gap between non-contiguous regions is a blank row, not a "..." marker.
		expect(diffLines).toContain("");
		expect(diffLines).not.toContain("...");
		expect(diffLines).toContain(" 7|}");
		expect(diffLines).not.toContain(" 5|  const four = 4;");
		expect(diffLines).not.toContain(" 6|  return value + two + three + four;");
	});

	it("never emits adjacent gap rows when block context lands between hunks", () => {
		// Hunk 1 covers alpha's opener, so alpha's closer (line 7) is pulled
		// down into the gap between the hunks; hunk 2 covers beta's closer, so
		// beta's opener (line 9) is pulled up into the same gap. Each insertion
		// adds its own gap rows from a snapshot of the diff, which used to
		// stack two "..." markers back to back.
		const oldLines = [
			"function alpha() {",
			"  const a1 = 1;",
			"  const a2 = 2;",
			"  const a3 = 3;",
			"  const a4 = 4;",
			"  return a1;",
			"}",
			"// spacer",
			"function beta() {",
			"  const b1 = 1;",
			"  const b2 = 2;",
			"  const b3 = 3;",
			"  const b4 = 4;",
			"  return b1;",
			"}",
		];
		const newLines = [...oldLines];
		newLines[1] = "  const a1 = 100;";
		newLines[13] = "  return b1 + 1;";
		const result = generateDiffString(oldLines.join("\n"), newLines.join("\n"), 1, { path: "sample.ts" });
		const diffLines = result.diff.split("\n");

		// Every elided region around the boundary rows is marked by exactly
		// one blank gap row — no "..." markers, no stacked separators.
		const closer = diffLines.indexOf(" 7|}");
		const opener = diffLines.indexOf(" 9|function beta() {");
		expect(closer).toBeGreaterThan(-1);
		expect(opener).toBeGreaterThan(closer);
		expect(diffLines[closer - 1]).toBe("");
		expect(diffLines[closer + 1]).toBe("");
		expect(diffLines[opener - 1]).toBe("");
		expect(diffLines[opener + 1]).toBe("");
		expect(diffLines).not.toContain("...");
		for (let i = 0; i + 1 < diffLines.length; i++) {
			expect(diffLines[i] === "" && diffLines[i + 1] === "").toBe(false);
		}
		expect(diffLines[0]).not.toBe("");
		expect(diffLines[diffLines.length - 1]).not.toBe("");
	});

	it("drops a gap row stranded between contiguous boundary rows", () => {
		// alpha's closer (7) and beta's opener (8) are contiguous. The first
		// insertion adds a trailing gap row toward the far hunk; the second
		// boundary then lands after it, stranding a separator between two
		// adjacent lines.
		const oldLines = [
			"function alpha() {",
			"  const a1 = 1;",
			"  const a2 = 2;",
			"  const a3 = 3;",
			"  const a4 = 4;",
			"  return a1;",
			"}",
			"function beta() {",
			"  const b1 = 1;",
			"  const b2 = 2;",
			"  const b3 = 3;",
			"  const b4 = 4;",
			"  return b1;",
			"}",
		];
		const newLines = [...oldLines];
		newLines[1] = "  const a1 = 100;";
		newLines[12] = "  return b1 + 1;";
		const result = generateDiffString(oldLines.join("\n"), newLines.join("\n"), 1, { path: "sample.ts" });
		const diffLines = result.diff.split("\n");

		const closer = diffLines.indexOf(" 7|}");
		const opener = diffLines.indexOf(" 8|function beta() {");
		expect(closer).toBeGreaterThan(-1);
		expect(opener).toBe(closer + 1);
		expect(diffLines).not.toContain("...");
	});

	it("emits bracket context under pre-edit numbers when edits shift line offsets", () => {
		// Two change runs around an unchanged line, net +2 lines before the
		// closing brace. The closer is discovered via the NEW file's block
		// boundaries, so it must be translated back to its pre-edit number
		// (compact-preview renumbering contract). Regression: it used to be
		// either dropped (broken new-file visibility window) or re-inserted
		// under its post-edit number — duplicated and out of order.
		const oldLines = [
			"function outer() {",
			"  const a = 1;",
			"  const keep = 2;",
			"  const b = 3;",
			"  return a + keep + b;",
			"}",
		];
		const newLines = [
			"function outer() {",
			"  const a = 10;",
			"  const a2 = 11;",
			"  const keep = 2;",
			"  const b = 30;",
			"  const b2 = 31;",
			"  return a + keep + b;",
			"}",
		];
		const result = generateDiffString(oldLines.join("\n"), newLines.join("\n"), 1, { path: "sample.ts" });
		const diffLines = result.diff.split("\n");

		expect(diffLines.filter(line => line.endsWith("|}"))).toEqual([" 6|}"]);
		// Context rows must stay in pre-edit order — no duplicate of the
		// shifted unchanged line under another number.
		const contextNumbers = diffLines
			.filter(line => line.startsWith(" "))
			.map(line => Number.parseInt(line.slice(1), 10));
		expect(contextNumbers).toEqual([...contextNumbers].sort((a, b) => a - b));
		expect(diffLines.filter(line => line.includes("|  const keep = 2;"))).toEqual([" 3|  const keep = 2;"]);
	});
});
