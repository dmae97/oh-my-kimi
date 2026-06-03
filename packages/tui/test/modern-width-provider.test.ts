import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Calibration for the "modern" VirtualTerminal width model (ghostty / WezTerm /
// kitty / iTerm2 / Windows Terminal 1.22+ semantics).
//
// The stress suite's geometric oracles (viewport fidelity, truncation
// boundaries, exact buffer reconstruction) compare text the renderer wrote
// against text the terminal committed. That comparison is only cell-exact when
// the terminal's width model agrees with the renderer's native width engine.
// These tests pin that agreement; if either side drifts (an xterm.js upgrade
// changing the provider API/packing, or a native-engine width change), this
// file fails before the stress suite starts reporting confusing geometric
// mismatches.

/** Write `text` on a fresh line and return how many cells the cursor advanced. */
async function measure(term: VirtualTerminal, text: string): Promise<number> {
	term.write(`\r\x1b[2K${text}`);
	await term.flush();
	return term.getCursor().col;
}

/** Width samples that appear in stress content (render-stress-harness.ts). */
const STRESS_CONTENT_SAMPLES: ReadonlyArray<readonly [name: string, text: string]> = [
	["plain label", "root-a1"],
	["cjk", "界"],
	["hangul", "한"],
	["emoji presentation", "\u{1F642}"],
	["wideText shape", "w1界\u{1F642}한"],
	["warning + VS16", "\u26A0\uFE0F"],
	["info + VS16", "\u2139\uFE0F"],
	["keycap", "1\uFE0F\u20E3"],
	["emojiPresentationText shape", "ep1 \u26A0\uFE0F\u2139\uFE0F 1\uFE0F\u20E3"],
	["arabic tashkeel", "ar1-بَسِمَ-قُرْآن"],
	["longText shape", "L1-0界1界2界-L1"],
];

describe("modern width model calibration", () => {
	it("agrees with the renderer's width engine for every stress content shape", async () => {
		const term = new VirtualTerminal(80, 5, undefined, "modern");
		for (const [name, text] of STRESS_CONTENT_SAMPLES) {
			const cells = await measure(term, text);
			expect(`${name}: ${cells}`).toBe(`${name}: ${visibleWidth(text)}`);
		}
	});

	it("models the documented modern-terminal overrides on top of legacy widths", async () => {
		const modern = new VirtualTerminal(80, 5, undefined, "modern");
		const legacy = new VirtualTerminal(80, 5);

		// Emoji presentation: modern = 2 (kitty/ghostty/WezTerm), legacy V6 = 1.
		expect(await measure(modern, "\u{1F642}")).toBe(2);
		expect(await measure(legacy, "\u{1F642}")).toBe(1);

		// VS16 promotion: modern joins + widens the base cell to 2; legacy keeps 1.
		expect(await measure(modern, "\u26A0\uFE0F")).toBe(2);
		expect(await measure(legacy, "\u26A0\uFE0F")).toBe(1);

		// Text-default symbol without VS16 stays narrow in both models.
		expect(await measure(modern, "\u26A0")).toBe(1);
		expect(await measure(legacy, "\u26A0")).toBe(1);

		// Non-emoji content is identical across models (delegation to V6).
		for (const text of ["abc", "界", "한", "بِسْمِ", "e\u0301"]) {
			expect(await measure(modern, text)).toBe(await measure(legacy, text));
		}
	});

	it("preserves readback fidelity for joined VS16/keycap cells", async () => {
		const term = new VirtualTerminal(40, 5, undefined, "modern");
		const text = "warn \u26A0\uFE0F key 1\uFE0F\u20E3 end";
		term.write(`\r\x1b[2K${text}`);
		await term.flush();
		expect(term.getViewport()[0]).toBe(text);
	});
});
