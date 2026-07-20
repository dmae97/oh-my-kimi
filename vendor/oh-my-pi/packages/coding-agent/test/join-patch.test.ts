import { describe, expect, test } from "bun:test";
import { patch } from "@oh-my-pi/pi-coding-agent/utils/git";

describe("joinPatch", () => {
	test("preserves space character in empty context line at end of patch", () => {
		// This simulates a hunk ending with an empty context line represented as " \n"
		const parts = [
			"@@ -1,2 +1,2 @@\n",
			"foo\n",
			"@@ -10,4 +10,4 @@\n",
			"line1\n",
			"-old\n",
			"+new\n",
			" \n", // Empty context line = space + newline
		];

		const result = patch.join(parts);

		// The result should end with a space character (the empty context line)
		// but NOT start/end with multiple newlines
		expect(result.endsWith(" \n")).toBe(true);
		expect(result.replace(/[ \t]+$/, "")).toEqual(result); // No trailing spaces should be removed
	});

	test("normalizes multiple trailing newlines in parts", () => {
		const parts = ["line1\n", "line2\n", "line3"];
		const result = patch.join(parts);

		// Should join with single newlines and end with one newline
		expect(result.endsWith("\n")).toBe(true);
	});

	test("adds newline to parts that are missing them", () => {
		const parts = ["line1", "line2"];
		const result = patch.join(parts);

		// Should add newlines to both parts
		expect(result.includes("line1\n")).toBe(true);
		expect(result.endsWith("line2\n")).toBe(true);
	});
});
