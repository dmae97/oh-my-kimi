import { describe, expect, it } from "bun:test";
import { buildCompactDiffPreview } from "@oh-my-pi/hashline";

describe("buildCompactDiffPreview", () => {
	it("renders current lines and omits removed content while preserving counts", () => {
		const preview = buildCompactDiffPreview([" 1|alpha", "-2|beta", "+2|DELTA", "+3|EPSILON", " 3|gamma"].join("\n"));

		expect(preview).toEqual({
			preview: ["1:alpha", "2:DELTA", "3:EPSILON", "4:gamma"].join("\n"),
			addedLines: 2,
			removedLines: 1,
		});
	});

	it("renumbers context lines against the post-edit file after range expansion", () => {
		const diff = [" 1|a1", " 2|a2", "-3|a3", "-4|a4", "+3|X", "+4|Y", "+5|Z", " 5|a5", " 6|a6", " 7|a7"].join("\n");

		const preview = buildCompactDiffPreview(diff);

		expect(preview.preview.split("\n")).toEqual(["1:a1", "2:a2", "3:X", "4:Y", "5:Z", "6:a5", "7:a6", "8:a7"]);
	});
	it("collapses long contiguous added runs to head, marker, and tail", () => {
		const diff = Array.from({ length: 7 }, (_, index) => `+${10 + index}|line ${index + 1}`).join("\n");

		const preview = buildCompactDiffPreview(diff);

		expect(preview.preview).toBe(["10:line 1", "11:line 2", "…", "15:line 6", "16:line 7"].join("\n"));
		expect(preview.addedLines).toBe(7);
		expect(preview.removedLines).toBe(0);
	});

	it("normalizes adjacent elision markers to one unicode marker", () => {
		const preview = buildCompactDiffPreview([" 1|alpha", "...", "...", "…", " 20|omega"].join("\n"));

		expect(preview.preview).toBe(["1:alpha", "…", "20:omega"].join("\n"));
	});

	it("dedupes blank gap rows left adjacent by omitted removed lines and trims edge separators", () => {
		const diff = ["", " 1|alpha", "", "-5|beta", "", " 9|gamma", "", "-12|omitted"].join("\n");

		const preview = buildCompactDiffPreview(diff);

		// `-5|beta` is omitted from the preview, leaving its two surrounding
		// gap rows adjacent; only one survives. The leading separator and the
		// one stranded at the end (after `-12` is dropped) are trimmed.
		expect(preview.preview).toBe(["1:alpha", "", "8:gamma"].join("\n"));
		expect(preview.removedLines).toBe(2);
	});
});
