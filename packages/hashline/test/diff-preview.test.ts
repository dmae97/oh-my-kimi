import { describe, expect, it } from "bun:test";
import { buildCompactDiffPreview } from "@oh-my-pi/hashline";

describe("buildCompactDiffPreview", () => {
	it("renders current lines and omits removed content while preserving counts", () => {
		const preview = buildCompactDiffPreview([" 1|alpha", "-2|beta", "+2|DELTA", "+3|EPSILON", " 3|gamma"].join("\n"));

		expect(preview).toEqual({
			preview: [" 1:alpha", "+2:DELTA", "+3:EPSILON", " 4:gamma"].join("\n"),
			addedLines: 2,
			removedLines: 1,
		});
	});


	it("renumbers context lines against the post-edit file after range expansion", () => {
		const diff = [
			" 1|a1",
			" 2|a2",
			"-3|a3",
			"-4|a4",
			"+3|X",
			"+4|Y",
			"+5|Z",
			" 5|a5",
			" 6|a6",
			" 7|a7",
		].join("\n");

		const preview = buildCompactDiffPreview(diff);

		expect(preview.preview.split("\n").filter(line => line.startsWith(" "))).toEqual([
			" 1:a1",
			" 2:a2",
			" 6:a5",
			" 7:a6",
			" 8:a7",
		]);
	});
	it("collapses long contiguous added runs to head, marker, and tail", () => {
		const diff = Array.from({ length: 7 }, (_, index) => `+${10 + index}|line ${index + 1}`).join("\n");

		const preview = buildCompactDiffPreview(diff);

		expect(preview.preview).toBe(["+10:line 1", "+11:line 2", "+12…", "+15:line 6", "+16:line 7"].join("\n"));
		expect(preview.addedLines).toBe(7);
		expect(preview.removedLines).toBe(0);
	});
});
