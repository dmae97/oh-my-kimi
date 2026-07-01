import { describe, expect, it } from "bun:test";
import { findCommittedPrefixResync } from "@oh-my-pi/pi-tui";

// Regression coverage for the committed-prefix resync seam that decides where the
// engine re-anchors #committedRows after a live block re-lays-out at settle.
//
// Contract, condensed from the tui.ts doc:
//   findCommittedPrefixResync(frame, prefix, auditTo, exemptFrom, exemptTo, permanentEnd)
//     ► returns -1  when frame is aligned with prefix
//     ► returns i   the earliest AUDITED row index where they diverge
//     ► rows in [exemptFrom, exemptTo) are exempt — durable in-place drift
//     ► rows in [exemptTo, permanentEnd) are hard-scanned in FULL — a settle-time
//        edit there re-anchors even when the tail sample would tolerate it
//     ► one non-hard mismatch in the tail sample (last 24 audited rows / 8
//       non-blank samples) is tolerated (offscreen spinner, single in-place edit)
//     ► frame.length < prefix.length always re-anchors at frame.length so the
//       shrunk tail is dropped from history (duplication, never loss)
//
// Issue #4124: a formerly forced-overflow row that later becomes permanent AND
// changes MUST re-anchor at the EARLIEST audited mismatch, not somewhere later
// and not never — otherwise a settle transition strands stale pending chrome
// (e.g. `⏳ SSH: [host]`) above the final settled block.

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

	it("re-anchors at the earliest audited mismatch even when a later hard mismatch triggers the audit", () => {
		// Issue #4124 core: a formerly forced-overflow row later becomes
		// permanent and its content changes. The hard scan detects the
		// permanent-zone change and forces the audit; the re-anchor loop must
		// walk from row 0 and return the FIRST audited mismatch, not the hard
		// scan's stop position — otherwise an earlier stranded pending row
		// (e.g. `⏳ SSH: [host]`) is left uncommitted-behind above the settled
		// block.
		//
		// Geometry: auditRows=5 (byte-stable zone [0,5)), durableRows=10 (exempt
		// window [5,10)), durableBoundary=15 rose past three previously
		// forced-overflow rows (hard-scanned suffix [10,15)). Row 3 changed
		// (byte-stable) AND row 12 changed (in the hard-scanned newly-permanent
		// zone). The hard scan trips on row 12, but the re-anchor MUST return
		// row 3 — the earliest audited divergence.
		const prefix = rows("r", 20);
		const frame = [...prefix];
		frame[3] = "r3-changed";
		frame[12] = "r12-permanent-now-changed";
		const auditTo = 20;
		const exemptFrom = 5;
		const exemptTo = 10;
		const permanentEnd = 15;
		expect(findCommittedPrefixResync(frame, prefix, auditTo, exemptFrom, exemptTo, permanentEnd)).toBe(3);
	});

	it("hard-scans the newly-permanent forced suffix in full, escaping tail-sample tolerance", () => {
		// A single mismatch inside the forced suffix that just became permanent
		// (durableBoundary rose past it this frame) MUST re-anchor, even though
		// one non-hard mismatch would otherwise be tolerated. This is what
		// prevents a pending SSH header from silently swallowing its settled
		// replacement — the header row was forced-overflow while streaming, now
		// the block finalized, and the tolerance would otherwise eat it.
		//
		// Geometry: byte-stable zone [0,3), exempt window [3,7), hard-scan zone
		// [7,12) — the barrier just finalized past row 11 so those rows are
		// declared permanent this frame. Row 10 flips content: the hard scan
		// catches it and re-anchors at row 10.
		const prefix = rows("r", 20);
		const frame = [...prefix];
		frame[10] = "r10-settled";
		const auditTo = 20;
		const exemptFrom = 3;
		const exemptTo = 7;
		const permanentEnd = 12;
		expect(findCommittedPrefixResync(frame, prefix, auditTo, exemptFrom, exemptTo, permanentEnd)).toBe(10);
	});

	it("keeps drift inside the exempt window silent (durable in-place snapshot)", () => {
		// Rows in [exemptFrom, exemptTo) are durable snapshots that legitimately
		// drift in place (a streaming table re-aligning columns). Their
		// mismatch must NOT re-anchor — otherwise every column-realign frame
		// sprays duplicate snapshots.
		const prefix = rows("r", 20);
		const frame = [...prefix];
		frame[6] = "r6-realigned";
		frame[7] = "r7-realigned";
		const auditTo = 20;
		const exemptFrom = 5;
		const exemptTo = 15;
		const permanentEnd = 5;
		expect(findCommittedPrefixResync(frame, prefix, auditTo, exemptFrom, exemptTo, permanentEnd)).toBe(-1);
	});

	it("re-anchors at the earliest audited mismatch outside the exempt window", () => {
		// The exempt window is scoped drift: a mismatch OUTSIDE it (byte-stable
		// audited zone [0, exemptFrom) or the forced suffix [exemptTo,
		// committed)) still re-anchors, and it does so at the earliest audited
		// row — even when the earliest is in the byte-stable zone above the
		// exempt window.
		const prefix = rows("r", 20);
		const frame = [...prefix];
		frame[2] = "r2-shift";
		frame[16] = "r16-shift";
		frame[17] = "r17-shift";
		const auditTo = 20;
		const exemptFrom = 5;
		const exemptTo = 15;
		const permanentEnd = 5;
		expect(findCommittedPrefixResync(frame, prefix, auditTo, exemptFrom, exemptTo, permanentEnd)).toBe(2);
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

	it("still re-anchors when a mismatch straddles the byte-stable/forced-suffix boundary", () => {
		// exempt=[5,15); mismatches at row 4 (byte-stable) and row 16 (forced
		// suffix). The re-anchor MUST return 4 (earliest audited), never 16 —
		// this guards against a bug where the re-anchor loop started at exTo
		// instead of 0.
		const prefix = rows("r", 20);
		const frame = [...prefix];
		frame[4] = "r4-changed";
		frame[16] = "r16-changed";
		const auditTo = 20;
		const exemptFrom = 5;
		const exemptTo = 15;
		const permanentEnd = 5;
		expect(findCommittedPrefixResync(frame, prefix, auditTo, exemptFrom, exemptTo, permanentEnd)).toBe(4);
	});
});
