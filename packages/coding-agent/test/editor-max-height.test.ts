import { describe, expect, it } from "bun:test";
import { computeEditorMaxHeight } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";

describe("computeEditorMaxHeight", () => {
	it("caps the editor while preserving chrome rows on small terminals", () => {
		expect(computeEditorMaxHeight(30)).toBe(18);
		expect(computeEditorMaxHeight(18)).toBe(6);
		expect(computeEditorMaxHeight(8)).toBe(4);
		expect(computeEditorMaxHeight(5)).toBe(1);
		expect(computeEditorMaxHeight(Number.NaN)).toBe(12);
		expect(computeEditorMaxHeight(0)).toBe(12);

		for (let rows = 5; rows <= 18; rows += 1) {
			expect(rows - computeEditorMaxHeight(rows)).toBeGreaterThanOrEqual(4);
		}
	});
});
