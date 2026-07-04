import { describe, expect, it } from "bun:test";
import { findCommittedPrefixResync } from "@oh-my-pi/pi-tui";

// Regression coverage for the committed-prefix resync seam that decides where the
// engine re-anchors #committedRows after a component violates the declared-final
// contract (a budget-demoted image, a TTSR rewind, a post-finalize mutation).
//
// Contract, condensed from the tui.ts doc:
//   findCommittedPrefixResync(frame, prefix, auditTo)
//     ► returns -1  when frame is aligned with prefix
//     ► returns i   the earliest row index where they diverge
//     ► one mismatch in the tail sample (last 24 rows / 8 non-blank samples)
//       is tolerated (a no-seam root's offscreen animated row, a single
//       in-place edit) — the stale copy in history is the accepted artifact
//     ► frame.length < prefix.length always re-anchors at frame.length so the
//       shrunk tail is dropped from history (duplication, never loss)

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

describe("findCommittedPrefixResync", () => {
	it("returns -1 when the frame matches the committed prefix", () => {
		const prefix = rows("r", 20);
		const frame = rows("r", 20);
		expect(findCommittedPrefixResync(frame, prefix)).toBe(-1);
	});

	it("returns -1 for an empty committed prefix", () => {
		expect(findCommittedPrefixResync(["anything"], [])).toBe(-1);
	});

	it("tolerates a SGR-only restyle in the committed rows", () => {
		// Theme change repaints existing rows with different SGR codes but the
		// visible bytes are identical. rowsEquivalent() strips SGR before
		// comparing, so no resync is emitted — the stale styling in native
		// scrollback has always been the accepted artifact.
		const prefix = ["\x1b[31mred\x1b[0m", "row-1", "row-2"];
		const frame = ["\x1b[32mred\x1b[0m", "row-1", "row-2"];
		expect(findCommittedPrefixResync(frame, prefix)).toBe(-1);
	});

	it("tolerates a single-row in-place edit inside the tail sample window", () => {
		// The tail-sample tolerance keeps an offscreen still-live barrier (a
		// ticking spinner) and a genuine one-row restyle from spraying duplicate
		// snapshots every frame. Only ONE non-hard mismatch is tolerated.
		const prefix = rows("r", 20);
		const frame = [...prefix];
		frame[18] = "r18-edited";
		expect(findCommittedPrefixResync(frame, prefix)).toBe(-1);
	});

	it("resyncs at the earliest audited row when two rows shift in the tail sample", () => {
		// Two mismatches inside the sample window is a shift/insertion, not an
		// in-place edit — must re-anchor at the earliest audited divergence so
		// every shifted row recommits (duplication, never loss).
		const prefix = rows("r", 20);
		const frame = [...prefix];
		frame[14] = "r14-shift";
		frame[18] = "r18-shift";
		expect(findCommittedPrefixResync(frame, prefix)).toBe(14);
	});

	it("re-anchors at frame.length when the frame shrinks into the committed prefix", () => {
		// A shrink drops rows the prefix still holds. The engine has no way to
		// keep those rows painted — history keeps whatever scrolled off, and
		// the committed prefix must truncate to what the frame can still
		// support. Nothing else diverged, so the anchor is the shrink boundary.
		const prefix = rows("r", 20);
		const frame = rows("r", 12);
		expect(findCommittedPrefixResync(frame, prefix)).toBe(12);
	});

	it("re-anchors at the earliest audited mismatch when the frame shrank AND an earlier row changed", () => {
		// A shrink co-occurring with a real edit above must re-anchor at the
		// earlier position — otherwise the shifted rows past the edit would be
		// silently skipped (row loss, not just duplication).
		const prefix = rows("r", 20);
		const frame = rows("r", 12);
		frame[4] = "r4-changed";
		expect(findCommittedPrefixResync(frame, prefix)).toBe(4);
	});

	it("caps auditTo — rows past it are ignored", () => {
		// The committed audit is scoped to [0, auditTo); rows past auditTo are
		// still live/uncommitted and their drift is not the resync's concern.
		const prefix = rows("r", 20);
		const frame = [...prefix];
		frame[15] = "r15-still-live";
		// auditTo=10 means rows 10..19 are outside the audit
		expect(findCommittedPrefixResync(frame, prefix, 10)).toBe(-1);
	});
});
