import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

/**
 * Finalized history block. With `tracked`, reports a post-finalize content
 * version like `AssistantMessageComponent`; otherwise it is version-untracked
 * like most tool blocks.
 */
class HistoryBlock implements Component {
	#lines: readonly string[];
	getTranscriptBlockVersion?: () => number;
	constructor(lines: readonly string[], tracked: boolean) {
		this.#lines = lines;
		if (tracked) this.getTranscriptBlockVersion = () => 1;
	}
	render(width: number): readonly string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
	isTranscriptBlockFinalized(): boolean {
		return true;
	}
}

/** Streaming live block with a settled prefix, like a streaming assistant reply. */
class LiveBlock implements Component {
	lines: string[] = ["live-000"];
	settled = 0;
	render(width: number): readonly string[] {
		return this.lines.map(line => line.slice(0, width));
	}
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
	getTranscriptBlockSettledRows(): number {
		return this.settled;
	}
}

// Streams a live block behind a run of small finalized history blocks until the
// history fully commits to native scrollback, then verifies exactly-once history
// on the terminal tape. Regression guard: transcript-side committed-prefix
// compaction (dropping committed rows from the local frame) shifted the frame
// under the engine's committed-prefix ledger, the audit re-anchored, and
// already-taped rows were recommitted below their first copy — visibly
// duplicated blocks. The transcript now always keeps its full local frame.
async function streamPastCommit(tracked: boolean): Promise<Map<string, number>> {
	const term = new VirtualTerminal(40, 6);
	Object.defineProperty(term, "isNativeViewportAtBottom", { configurable: true, value: () => undefined });
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	const chat = new TranscriptContainer();
	const historyRows: string[] = [];
	for (let i = 0; i < 6; i++) {
		const rows = [`box-${i}-alpha`, `box-${i}-beta`];
		historyRows.push(...rows);
		chat.addChild(new HistoryBlock(rows, tracked));
	}
	const live = new LiveBlock();
	chat.addChild(live);
	tui.addChild(chat);

	try {
		tui.start();
		await scheduler.drain(term);
		// Grow the live block one row per frame with the settled prefix trailing
		// by one, pushing the finalized history through commit and compaction.
		for (let i = 1; i < 40; i++) {
			live.lines.push(`live-${String(i).padStart(3, "0")}`);
			live.settled = live.lines.length - 1;
			tui.requestRender();
			await scheduler.drain(term);
		}
	} finally {
		tui.stop();
		await term.flush();
	}

	const counts = new Map<string, number>();
	for (const row of term.getScrollBuffer()) {
		const text = Bun.stripANSI(row).trimEnd();
		if (text.length === 0) continue;
		counts.set(text, (counts.get(text) ?? 0) + 1);
	}
	// Loss check alongside the duplication check: every history row must have
	// reached the tape exactly once.
	for (const row of historyRows) expect(counts.get(row) ?? 0).toBe(1);
	return counts;
}

describe("transcript committed history", () => {
	it("keeps version-tracked committed history exactly once on the tape", async () => {
		const counts = await streamPastCommit(true);
		expect([...counts.entries()].filter(([, count]) => count > 1)).toEqual([]);
	});

	it("keeps version-untracked committed history exactly once on the tape", async () => {
		const counts = await streamPastCommit(false);
		expect([...counts.entries()].filter(([, count]) => count > 1)).toEqual([]);
	});
});
