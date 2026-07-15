import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { type Component, Text } from "@oh-my-pi/pi-tui";

// Models a transcript block that re-lays-out (tool preview collapsing, assistant
// message finalizing, late async result) after newer blocks were appended below
// it — the window must always reflect its current content.
class MutableBlock implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = lines;
	}
	set(lines: string[]): void {
		this.#lines = lines;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return [...this.#lines];
	}
}

// A block that can declare itself still-mutating (a foreground tool awaiting its
// result). The container must keep such a block in the repaintable live region —
// even with finalized blocks below it — until it finalizes.
class StreamingBlock implements Component {
	#lines: string[];
	#finalized: boolean;
	constructor(lines: string[], finalized = false) {
		this.#lines = lines;
		this.#finalized = finalized;
	}
	set(lines: string[]): void {
		this.#lines = lines;
	}
	finalize(lines?: string[]): void {
		if (lines) this.#lines = lines;
		this.#finalized = true;
	}
	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}
	invalidate(): void {}
	renderCount = 0;
	render(_width: number): string[] {
		this.renderCount++;
		return [...this.#lines];
	}
}

// A still-live block that can declare a byte-stable rendered prefix. The
// transcript container may commit only those declared rows before finalization.
class DeclaredSettledStreamingBlock extends StreamingBlock {
	#settledRows: number;

	constructor(lines: string[], settledRows: number) {
		super(lines);
		this.#settledRows = settledRows;
	}

	setSettledRows(rows: number): void {
		this.#settledRows = rows;
	}

	getTranscriptBlockSettledRows(): number {
		return this.#settledRows;
	}
}

class CountingFinalizedBlock implements Component {
	renderCount = 0;
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	set(lines: string[]): void {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		this.renderCount++;
		return [...this.#lines];
	}
}

// A finalized block that can still mutate afterwards (an assistant message whose
// suppressed inline error is restored at the next turn, late tool-result images)
// and reports each mutation through the transcript block version protocol.
class VersionedFinalizedBlock implements Component {
	renderCount = 0;
	#lines: string[];
	#version = 0;

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	mutate(lines: string[]): void {
		this.#lines = lines;
		this.#version++;
	}

	isTranscriptBlockFinalized(): boolean {
		return true;
	}

	getTranscriptBlockVersion(): number {
		return this.#version;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		this.renderCount++;
		return [...this.#lines];
	}
}

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

afterEach(() => {
	resetSettingsForTest();
});

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Continuing." }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

function plain(lines: readonly string[]): string {
	return stripVTControlCharacters(lines.join("\n"));
}

describe("TranscriptContainer", () => {
	it("always renders a block's current content, even after newer blocks append below it", () => {
		const container = new TranscriptContainer();
		const a = new MutableBlock(["a1"]);
		container.addChild(a);
		expect(container.render(40)).toEqual(["a1"]);

		a.set(["a2"]);
		expect(container.render(40)).toEqual(["a2"]);

		const b = new MutableBlock(["b1"]);
		container.addChild(b);
		expect(container.render(40)).toEqual(["a2", "", "b1"]);

		// A late re-layout of `a` (collapse, late async result, expand toggle) is
		// reflected immediately: committed history keeps its old bytes, but the
		// visible window always shows the present state.
		a.set(["a3-collapsed"]);
		expect(container.render(40)).toEqual(["a3-collapsed", "", "b1"]);

		b.set(["b2"]);
		expect(container.render(40)).toEqual(["a3-collapsed", "", "b2"]);

		// Width changes recompute like any other frame.
		a.set(["a-reflowed"]);
		expect(container.render(80)).toEqual(["a-reflowed", "", "b2"]);
	});

	it("reports undefined as the native scrollback boundary when every block is finalized", () => {
		const container = new TranscriptContainer();
		const a = new MutableBlock(["a1", "a2"]);
		const b = new MutableBlock(["b1"]);
		container.addChild(a);
		container.addChild(b);

		expect(container.render(40)).toEqual(["a1", "a2", "", "b1"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBeUndefined();

		b.set(["b1", "b2"]);
		expect(container.render(40)).toEqual(["a1", "a2", "", "b1", "b2"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBeUndefined();
	});

	it("keeps an unfinalized block below the seam when a finalized block is appended below it", () => {
		const container = new TranscriptContainer();
		// A foreground tool whose args are still streaming (no result yet).
		const tool = new StreamingBlock(["write (streaming)"]);
		container.addChild(tool);
		expect(container.render(40)).toEqual(["write (streaming)"]);

		// An out-of-band card (TTSR/todo reminder) is appended below the in-flight
		// tool while it is still streaming. The tool's rows must not commit here.
		const card = new MutableBlock(["rule card"]);
		container.addChild(card);
		expect(container.render(40)).toEqual(["write (streaming)", "", "rule card"]);
		// The live region begins at the unfinalized tool, not the bottom card.
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(0);

		// The tool's result lands after the card is already below it.
		tool.finalize(["✔ write: 4 lines"]);
		expect(container.render(40)).toEqual(["✔ write: 4 lines", "", "rule card"]);
		// All blocks are finalized; the whole rendered frame is committable.
		expect(container.getNativeScrollbackLiveRegionStart()).toBeUndefined();

		// Even after finalizing, a late re-layout still repaints in the window.
		tool.set(["collapsed"]);
		expect(container.render(40)).toEqual(["collapsed", "", "rule card"]);
	});

	it("keeps a streaming assistant live so final interrupted content can land after status rows below it", () => {
		const container = new TranscriptContainer();
		const assistant = new AssistantMessageComponent();
		assistant.updateContent(
			makeAssistantMessage({
				content: [{ type: "text", text: "The config file write went through." }],
			}),
		);
		container.addChild(assistant);
		expect(assistant.isTranscriptBlockFinalized()).toBe(false);
		expect(plain(container.render(80))).toContain("The config file write went through.");

		// Status/notice rows can arrive below the still-streaming assistant before
		// message_end finalizes the interrupted message. The assistant must stay repaintable.
		container.addChild(new Text("Copied raw SSE stream", 0, 0));
		expect(plain(container.render(80))).toContain("Copied raw SSE stream");
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(0);

		assistant.updateContent(
			makeAssistantMessage({
				content: [{ type: "text", text: "The config file write went through despite the interruption." }],
				stopReason: "aborted",
				errorMessage: USER_INTERRUPT_LABEL,
			}),
		);
		assistant.markTranscriptBlockFinalized();

		const rendered = plain(container.render(80));
		expect(rendered).toContain("The config file write went through despite the interruption.");
		expect(rendered).toContain("Copied raw SSE stream");
		expect(container.getNativeScrollbackLiveRegionStart()).toBeUndefined();
	});

	it("starts the live region at the earliest of several unfinalized blocks", () => {
		const container = new TranscriptContainer();
		const sealed = new StreamingBlock(["done"], true);
		const pending = new StreamingBlock(["pending"]);
		const card = new MutableBlock(["card"]);
		container.addChild(sealed);
		container.addChild(pending);
		container.addChild(card);
		expect(container.render(40)).toEqual(["done", "", "pending", "", "card"]);
		// Live region starts at the pending block (offset 1), so the already-sealed
		// leading block can commit while pending + card stay repaintable.
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(2);

		// The sealed block's late re-layout still renders current content; the
		// seam is unaffected (it keys off finalization, not row diffs).
		sealed.set(["done-collapsed"]);
		expect(container.render(40)).toEqual(["done-collapsed", "", "pending", "", "card"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(2);

		// The pending block updates freely while live.
		pending.finalize(["pending-final"]);
		expect(container.render(40)).toEqual(["done-collapsed", "", "pending-final", "", "card"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBeUndefined();
	});

	it("stops the boundary at the first unfinalized block's first content row when no rows are settled", () => {
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["history"]));
		const live = new StreamingBlock(["live-0", "live-1"]);
		container.addChild(live);
		container.addChild(new MutableBlock(["below"]));

		expect(container.render(40)).toEqual(["history", "", "live-0", "live-1", "", "below"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(2);

		live.set(["live-0 updated", "live-1"]);
		expect(container.render(40)).toEqual(["history", "", "live-0 updated", "live-1", "", "below"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(2);
	});

	it("extends the boundary through declared settled rows after stripping leading blank padding", () => {
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["history"]));
		const live = new DeclaredSettledStreamingBlock(["", "settled-a", "settled-b", "live-tail", ""], 3);
		container.addChild(live);

		expect(container.render(40)).toEqual(["history", "", "settled-a", "settled-b", "live-tail"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(4);
	});

	it("returns undefined after the first unfinalized block finalizes", () => {
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["history"]));
		const live = new StreamingBlock(["live"]);
		container.addChild(live);

		expect(container.render(40)).toEqual(["history", "", "live"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(2);

		live.finalize(["done"]);
		expect(container.render(40)).toEqual(["history", "", "done"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBeUndefined();
	});

	it("pins the boundary at an empty unfinalized block's row position", () => {
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["history"]));
		container.addChild(new StreamingBlock([]));
		container.addChild(new MutableBlock(["below"]));

		expect(container.render(40)).toEqual(["history", "", "below"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(1);
	});

	it("does not let finalized blocks below the first unfinalized block extend the boundary", () => {
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["history"]));
		container.addChild(new StreamingBlock(["live"]));
		container.addChild(new StreamingBlock(["finalized-below-0", "finalized-below-1"], true));

		expect(container.render(40)).toEqual(["history", "", "live", "", "finalized-below-0", "finalized-below-1"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(2);
	});
	it("drops committed finalized head rows and rehydrates them for a full replay", () => {
		const container = new TranscriptContainer();
		const history = new CountingFinalizedBlock(["committed-history"]);
		const tail = new CountingFinalizedBlock(["retained-tail"]);
		container.addChild(history);
		container.addChild(tail);

		expect(container.render(40)).toEqual(["committed-history", "", "retained-tail"]);
		container.setNativeScrollbackCommittedRows(2);
		expect(container.render(40)).toEqual(["retained-tail"]);
		expect(history.renderCount).toBe(1);

		container.prepareNativeScrollbackReplay();
		// The TUI supplies its previous committed count immediately before the
		// replay render; the complete frame must still survive this one compose.
		container.setNativeScrollbackCommittedRows(2);
		expect(container.render(40)).toEqual(["committed-history", "", "retained-tail"]);
		expect(history.renderCount).toBe(2);
	});

	it("does not re-render finalized rows already committed to native scrollback", () => {
		const container = new TranscriptContainer();
		const committed = new CountingFinalizedBlock(["committed"]);
		const liveTail = new CountingFinalizedBlock(["tail"]);
		container.addChild(committed);
		container.addChild(liveTail);

		expect(container.render(40)).toEqual(["committed", "", "tail"]);
		expect(committed.renderCount).toBe(1);
		expect(liveTail.renderCount).toBe(1);

		container.setNativeScrollbackCommittedRows(1);
		expect(container.render(40)).toEqual(["committed", "", "tail"]);
		expect(committed.renderCount).toBe(1);
		expect(liveTail.renderCount).toBe(2);

		container.invalidate();
		expect(container.render(40)).toEqual(["committed", "", "tail"]);
		expect(committed.renderCount).toBe(2);
	});
	it("re-renders a committed finalized block when its version changes", () => {
		const container = new TranscriptContainer();
		const block = new VersionedFinalizedBlock(["original"]);
		container.addChild(block);

		expect(container.render(40)).toEqual(["original"]);
		container.setNativeScrollbackCommittedRows(1);
		expect(container.render(40)).toEqual(["original"]);
		expect(block.renderCount).toBe(1);

		// Post-finalize mutation (e.g. setErrorPinned(false) restoring the inline
		// error) must surface even though the rows sit in committed scrollback —
		// the render is what lets the TUI's committed-prefix audit re-anchor.
		block.mutate(["original", "Error: boom"]);
		expect(container.render(40)).toEqual(["original", "Error: boom"]);
		expect(block.renderCount).toBe(2);

		// Once observed, the bypass re-engages at the new version.
		container.setNativeScrollbackCommittedRows(2);
		expect(container.render(40)).toEqual(["original", "Error: boom"]);
		expect(block.renderCount).toBe(2);
	});
	it("renders once after a block finalizes with rows already inside committed scrollback", () => {
		const container = new TranscriptContainer();
		const block = new StreamingBlock(["streaming"]);
		const counting = new CountingFinalizedBlock(["tail"]);
		container.addChild(block);
		container.addChild(counting);

		expect(container.render(40)).toEqual(["streaming", "", "tail"]);

		// The block's rows settle into committed scrollback while it is still
		// live (append-only commit path), then it finalizes with different bytes.
		// The first post-transition frame must render — the previous segment was
		// produced by a non-finalized render and is not trustworthy history.
		container.setNativeScrollbackCommittedRows(3);
		block.finalize(["streaming", "done"]);
		const rendersBeforeTransition = block.renderCount;
		expect(container.render(40)).toEqual(["streaming", "done", "", "tail"]);
		expect(block.renderCount).toBe(rendersBeforeTransition + 1);

		// The post-finalize render is now trustworthy history: once its rows are
		// committed, the bypass replays it without calling render().
		container.setNativeScrollbackCommittedRows(2);
		const rendersAfterTransition = block.renderCount;
		expect(container.render(40)).toEqual(["streaming", "done", "", "tail"]);
		expect(block.renderCount).toBe(rendersAfterTransition);
	});
	it("reports a new assistant block version after post-finalize error unpinning", () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now(),
			stopReason: "error",
			errorMessage: "boom",
		} as AssistantMessage;
		const component = new AssistantMessageComponent(message);
		expect(component.isTranscriptBlockFinalized()).toBe(true);

		component.setErrorPinned(true);
		const pinnedVersion = component.getTranscriptBlockVersion();
		// The restore path at the next turn's agent_start must be observable by
		// the transcript container's committed-scrollback bypass.
		component.setErrorPinned(false);
		expect(component.getTranscriptBlockVersion()).toBeGreaterThan(pinnedVersion);
	});
});

describe("TranscriptContainer spacing", () => {
	it("inserts exactly one blank line between consecutive blocks", () => {
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["a"]));
		container.addChild(new MutableBlock(["b"]));
		container.addChild(new MutableBlock(["c"]));
		// One separator between each block; none above the first.
		expect(container.render(40)).toEqual(["a", "", "b", "", "c"]);
	});

	it("strips a block's plain-blank top/bottom padding", () => {
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["a"]));
		// Leading Spacer rows + a trailing paddingY row collapse to just the body.
		container.addChild(new MutableBlock(["", "   ", "body", ""]));
		expect(container.render(40)).toEqual(["a", "", "body"]);
	});

	it("preserves background-colored padding rows (block-internal design)", () => {
		const bgPad = "\x1b[48;2;0;0;0m   \x1b[0m";
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["a"]));
		// The ANSI-bearing padding row is not "plain blank", so it survives stripping.
		container.addChild(new MutableBlock([bgPad, "x", bgPad]));
		expect(container.render(40)).toEqual(["a", "", bgPad, "x", bgPad]);
	});

	it("does not double the gap when a block carries its own trailing blank", () => {
		const container = new TranscriptContainer();
		// The trailing blank is stripped, so only the container's separator remains.
		container.addChild(new MutableBlock(["note", ""]));
		container.addChild(new MutableBlock(["b"]));
		expect(container.render(40)).toEqual(["note", "", "b"]);
	});

	it("does not inject separators within a single block's rows", () => {
		const container = new TranscriptContainer();
		// An IRC card / file-mention list wrapped as one block stays tight inside.
		container.addChild(new MutableBlock(["header", "  body1", "  body2"]));
		expect(container.render(40)).toEqual(["header", "  body1", "  body2"]);
	});

	it("drops a blank-only block without leaving a stray gap", () => {
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["a"]));
		container.addChild(new MutableBlock(["", "  "]));
		container.addChild(new MutableBlock(["b"]));
		expect(container.render(40)).toEqual(["a", "", "b"]);
	});

	it("counts the separator into the committed prefix below the live region (ED3-risk)", () => {
		const container = new TranscriptContainer();
		// A finalized block, then a still-live block below it.
		container.addChild(new MutableBlock(["a1", "a2"]));
		container.addChild(new StreamingBlock(["b"]));
		// Separator sits at index 2; the live block's content begins at index 3.
		expect(container.render(40)).toEqual(["a1", "a2", "", "b"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(3);
	});
});

// The consumable stable-prefix floor (RenderStablePrefix): render() returns
// the SAME persistent array every call, mutated in place, so the engine relies
// on this report — not reference equality — to know which leading rows
// survived. Reading consumes the report (re-bases the baseline to the current
// array state); between reads the floor accumulates the MIN across renders.
// `Text` children are ref-stable per (text, width), so an unchanged block's
// segment is reused and counts toward the floor.
describe("TranscriptContainer getRenderStablePrefixRows", () => {
	it("reports 0 until a second render proves the rows, then the full length", () => {
		const container = new TranscriptContainer();
		container.addChild(new Text("alpha", 0, 0));
		container.addChild(new Text("beta", 0, 0));

		// First render only pushed rows; nothing is proven stable yet.
		expect(container.render(40)).toHaveLength(3); // alpha, separator, beta
		expect(container.getRenderStablePrefixRows()).toBe(0);

		// Unchanged finalized blocks: the second render reuses every row.
		const second = container.render(40);
		expect(container.getRenderStablePrefixRows()).toBe(second.length);
	});

	it("keeps the previous rows stable when a finalized block is appended", () => {
		const container = new TranscriptContainer();
		container.addChild(new Text("alpha", 0, 0));
		container.addChild(new Text("beta", 0, 0));
		const before = container.render(40).length;
		container.getRenderStablePrefixRows(); // consume: re-base to the current rows

		container.addChild(new Text("gamma", 0, 0));
		const grown = container.render(40);
		expect(grown.length).toBeGreaterThan(before);
		// Only the appended block's separator + body are new rows.
		expect(container.getRenderStablePrefixRows()).toBe(before);
	});

	it("lowers the report to a mutated early block's start row", () => {
		const container = new TranscriptContainer();
		const beta = new Text("beta", 0, 0);
		container.addChild(new Text("alpha", 0, 0));
		container.addChild(beta);
		container.addChild(new Text("gamma", 0, 0));
		expect(container.render(40)).toHaveLength(5);
		container.getRenderStablePrefixRows(); // consume: re-base to the current rows

		beta.setText("beta-edited");
		container.render(40);
		// alpha's single row survives; beta's segment (separator + body, start
		// row 1) and everything below it was re-pushed.
		expect(container.getRenderStablePrefixRows()).toBe(1);
	});

	it("accumulates the minimum across renders between reads", () => {
		const container = new TranscriptContainer();
		const gamma = new Text("gamma", 0, 0);
		container.addChild(new Text("alpha", 0, 0));
		container.addChild(new Text("beta", 0, 0));
		container.addChild(gamma);
		expect(container.render(40)).toHaveLength(5);
		container.getRenderStablePrefixRows(); // consume: re-base to the current rows

		// First render after the edit drops the floor to gamma's segment start
		// (row 3); a second, fully stable render must NOT lift it back — an
		// out-of-band render between engine frames can only lower the report.
		gamma.setText("gamma-edited");
		container.render(40);
		container.render(40);
		expect(container.getRenderStablePrefixRows()).toBe(3);
	});

	it("reports 0 after a width change", () => {
		const container = new TranscriptContainer();
		container.addChild(new Text("alpha", 0, 0));
		container.addChild(new Text("beta", 0, 0));
		container.render(40);
		container.getRenderStablePrefixRows(); // consume: re-base to the current rows

		// A width change re-renders every block; no row carries over.
		container.render(80);
		expect(container.getRenderStablePrefixRows()).toBe(0);
	});

	it("consumes on read: an immediate second read re-bases to the current rows", () => {
		const container = new TranscriptContainer();
		container.addChild(new Text("alpha", 0, 0));
		container.addChild(new Text("beta", 0, 0));
		container.render(40);
		container.getRenderStablePrefixRows(); // consume: re-base to the current rows

		const reflowed = container.render(80);
		expect(container.getRenderStablePrefixRows()).toBe(0);
		// The read above re-based the baseline to the just-returned state, so
		// without any render in between the full array now counts as stable.
		expect(container.getRenderStablePrefixRows()).toBe(reflowed.length);
	});
});

describe("TranscriptContainer isBlockInLiveRegion", () => {
	it("opens at the first still-mutating block and includes everything below it", () => {
		const container = new TranscriptContainer();
		const above = new StreamingBlock(["above"], true);
		const live = new StreamingBlock(["live"], false);
		const below = new StreamingBlock(["below"], true);
		container.addChild(above);
		container.addChild(live);
		container.addChild(below);

		expect(container.isBlockInLiveRegion(above)).toBe(false);
		expect(container.isBlockInLiveRegion(live)).toBe(true);
		expect(container.isBlockInLiveRegion(below)).toBe(true);
	});

	it("anchors on the tail block when every block has finalized", () => {
		const container = new TranscriptContainer();
		const first = new StreamingBlock(["first"], true);
		const tail = new StreamingBlock(["tail"], false);
		container.addChild(first);
		container.addChild(tail);

		expect(container.isBlockInLiveRegion(tail)).toBe(true);
		tail.finalize();
		// All finalized: only the tail anchors the live region — a finalized
		// block above it is commit-eligible history (a detached task block
		// stops animating exactly on this transition).
		expect(container.isBlockInLiveRegion(first)).toBe(false);
		expect(container.isBlockInLiveRegion(tail)).toBe(true);
	});

	it("returns false for a component that is not a child", () => {
		const container = new TranscriptContainer();
		container.addChild(new StreamingBlock(["a"], true));
		expect(container.isBlockInLiveRegion(new StreamingBlock(["x"], false))).toBe(false);
	});
});

describe("TranscriptContainer isBlockUncommitted", () => {
	it("returns true for a block that has never rendered", () => {
		const container = new TranscriptContainer();
		const block = new MutableBlock(["not painted yet"]);
		container.addChild(block);

		expect(container.isBlockUncommitted(block)).toBe(true);
	});

	it("tracks whether committed rows have reached a rendered block", () => {
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["history"]));
		const block = new MutableBlock(["target-0", "target-1"]);
		container.addChild(block);

		expect(container.render(40)).toEqual(["history", "", "target-0", "target-1"]);
		container.setNativeScrollbackCommittedRows(1);
		expect(container.isBlockUncommitted(block)).toBe(true);

		container.setNativeScrollbackCommittedRows(3);
		expect(container.isBlockUncommitted(block)).toBe(false);
	});

	it("keeps compacted committed blocks marked committed", () => {
		const container = new TranscriptContainer();
		const committed = new StreamingBlock(["committed"], true);
		container.addChild(committed);
		container.addChild(new StreamingBlock(["tail"], true));

		expect(container.render(40)).toEqual(["committed", "", "tail"]);
		container.setNativeScrollbackCommittedRows(2);
		expect(container.render(40)).toEqual(["tail"]);

		expect(container.isBlockUncommitted(committed)).toBe(false);
	});

	it("keeps empty-render blocks uncommitted after committed rows advance", () => {
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["history"]));
		const empty = new MutableBlock([]);
		container.addChild(empty);
		container.addChild(new MutableBlock(["tail"]));

		expect(container.render(40)).toEqual(["history", "", "tail"]);
		expect(container.isBlockUncommitted(empty)).toBe(true);
		container.setNativeScrollbackCommittedRows(100);
		expect(container.isBlockUncommitted(empty)).toBe(true);
	});

	it("survives sparse compacted segment holes when checking uncommitted status", () => {
		const container = new TranscriptContainer();
		const committed = new StreamingBlock(["committed"], true);
		const live = new StreamingBlock(["live"], true);
		container.addChild(committed);
		container.addChild(live);

		expect(container.render(40)).toEqual(["committed", "", "live"]);
		container.setNativeScrollbackCommittedRows(2);
		// Compaction first rewrites the compacted prefix into zero-row placeholders.
		expect(container.render(40)).toEqual(["live"]);
		// The next render only repopulates from #compactedChildStart, leaving a
		// sparse hole at the compacted index. Retiring IRC/ephemeral cards walks
		// every segment and must not crash on those undefined entries.
		expect(container.render(40)).toEqual(["live"]);
		expect(() => container.isBlockUncommitted(live)).not.toThrow();
		expect(() => container.isBlockUncommitted(committed)).not.toThrow();
		expect(container.isBlockUncommitted(committed)).toBe(false);
	});
});

describe("TranscriptContainer renderViewportTail", () => {
	const W = 40;
	// Four two-row blocks. A full render joins them with one blank separator:
	//   b0a b0b ""  b1a b1b ""  b2a b2b ""  b3a b3b   → 11 rows.
	function fourBlocks(): { container: TranscriptContainer; blocks: CountingFinalizedBlock[] } {
		const blocks = [0, 1, 2, 3].map(i => new CountingFinalizedBlock([`b${i}a`, `b${i}b`]));
		const container = new TranscriptContainer();
		for (const b of blocks) container.addChild(b);
		return { container, blocks };
	}

	it("returns exactly the bottom rows of a full render", () => {
		const { container } = fourBlocks();
		const full = [...container.render(W)];
		expect(full).toEqual(["b0a", "b0b", "", "b1a", "b1b", "", "b2a", "b2b", "", "b3a", "b3b"]);
		// A clean block boundary (the separator before b2) lands at the fold.
		expect([...container.renderViewportTail(W, 5)]).toEqual(full.slice(full.length - 5));
		// A mid-block fold still yields the exact bottom rows.
		expect([...container.renderViewportTail(W, 4)]).toEqual(full.slice(full.length - 4));
		expect([...container.renderViewportTail(W, 1)]).toEqual(["b3b"]);
	});

	it("renders only the blocks needed to fill the request", () => {
		const { container, blocks } = fourBlocks();
		container.render(W);
		for (const b of blocks) b.renderCount = 0;
		// Bottom 4 rows span b3 (whole) and b2 (its last row visible): blocks
		// above the fold must never be rendered.
		container.renderViewportTail(W, 4);
		expect(blocks.map(b => b.renderCount)).toEqual([0, 0, 1, 1]);
	});

	it("returns the whole transcript top-aligned when it is shorter than the request", () => {
		const { container } = fourBlocks();
		const full = [...container.render(W)];
		expect([...container.renderViewportTail(W, 100)]).toEqual(full);
	});

	it("never mutates persistent full-compose state", () => {
		const { container } = fourBlocks();
		const before = [...container.render(W)];
		const liveBefore = container.getNativeScrollbackLiveRegionStart();
		// Interleave tail renders at other widths and sizes.
		container.renderViewportTail(80, 3);
		container.renderViewportTail(20, 7);
		container.renderViewportTail(W, 2);
		const after = [...container.render(W)];
		expect(after).toEqual(before);
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(liveBefore);
	});

	it("handles empty and zero-row requests", () => {
		const empty = new TranscriptContainer();
		expect([...empty.renderViewportTail(W, 10)]).toEqual([]);
		const { container } = fourBlocks();
		expect([...container.renderViewportTail(W, 0)]).toEqual([]);
	});
});

// A displaceable snapshot (todo/poll card): kept unfinalized only so a matching
// follow-up call can retract it. Mirrors ToolExecutionComponent.seal — sealing
// finalizes the block in place and it stops reporting displaceable. A pending
// tool starts non-displaceable and becomes a displaceable snapshot only when
// its successful result arrives (`makeDisplaceable`).
class DisplaceableBlock implements Component {
	sealCount = 0;
	#sealed = false;
	#displaceable: boolean;
	#lines: string[];
	constructor(lines: string[], displaceable = true) {
		this.#lines = lines;
		this.#displaceable = displaceable;
	}
	makeDisplaceable(): void {
		this.#displaceable = true;
	}
	isTranscriptBlockFinalized(): boolean {
		return this.#sealed;
	}
	isDisplaceableBlock(): boolean {
		return this.#displaceable && !this.#sealed;
	}
	seal(): void {
		this.sealCount++;
		this.#sealed = true;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return [...this.#lines];
	}
}

// Seal-on-commit: rows on the native-scrollback tape are immutable, so once the
// commit boundary covers any of a displaceable snapshot's rows the container
// must seal it in place — retracting it would strand an orphaned copy in
// terminal history, and left unfinalized it would pin the live-region seam
// open. setNativeScrollbackCommittedRows is a pure store; the seal walk runs at
// the start of the NEXT render, over the previous frame's segments (the
// geometry the committed count was computed against), before the seam scan so
// the seam unpins in that same frame.
describe("TranscriptContainer seal-on-commit", () => {
	const W = 40;

	// history(0) | sep(1) | todo-header(2) | todo-body(3); the leading
	// separator row belongs to the card's segment (segment.startRow = 1).
	function cardAfterHistory(displaceable = true): { container: TranscriptContainer; card: DisplaceableBlock } {
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["history"]));
		const card = new DisplaceableBlock(["todo-header", "todo-body"], displaceable);
		container.addChild(card);
		expect(container.render(W)).toEqual(["history", "", "todo-header", "todo-body"]);
		return { container, card };
	}

	it("seals on the next render once the boundary covers the block's rows", () => {
		const { container, card } = cardAfterHistory();
		// The unsealed card pins the live-region seam at its own rows.
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(2);
		// Rows 0..2 (through the card's header) are immutable history now.
		container.setNativeScrollbackCommittedRows(3);
		// The setter is a pure store: sealing waits for the next compose.
		expect(card.sealCount).toBe(0);
		container.render(W);
		expect(card.sealCount).toBe(1);
		expect(container.isBlockUncommitted(card)).toBe(false);
		// The seal pre-pass ran before the seam scan: the SAME render already
		// reports the seam unpinned (no still-mutating block left).
		expect(container.getNativeScrollbackLiveRegionStart()).toBeUndefined();
	});

	it("does not seal while the boundary stays above the block", () => {
		const { container, card } = cardAfterHistory();
		// Only "history" committed; the card's rows are all still retractable.
		container.setNativeScrollbackCommittedRows(1);
		container.render(W);
		expect(card.sealCount).toBe(0);
		expect(container.isBlockUncommitted(card)).toBe(true);
	});

	it("never seals across same-value or decreasing republishes above the block", () => {
		const { container, card } = cardAfterHistory();
		// The engine republishes the committed count every frame (compose and
		// post-emit): repeated same-value and decreasing stores above the
		// card's rows never accumulate into a seal.
		container.setNativeScrollbackCommittedRows(1);
		container.render(W);
		container.setNativeScrollbackCommittedRows(1);
		container.render(W);
		container.setNativeScrollbackCommittedRows(0);
		container.render(W);
		expect(card.sealCount).toBe(0);
		expect(container.isBlockUncommitted(card)).toBe(true);
	});

	it("seals exactly once as the boundary sweeps past the block in stages", () => {
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["history"]));
		const card = new DisplaceableBlock(["todo-header", "todo-body"]);
		container.addChild(card);
		container.addChild(new MutableBlock(["tail"]));
		expect(container.render(W)).toEqual(["history", "", "todo-header", "todo-body", "", "tail"]);
		// First crossing (through the header) seals; the sealed block stops
		// reporting displaceable.
		container.setNativeScrollbackCommittedRows(3);
		container.render(W);
		expect(card.sealCount).toBe(1);
		// A later sweep past the whole block, and every subsequent render at
		// that boundary, must not seal again.
		container.setNativeScrollbackCommittedRows(6);
		container.render(W);
		container.render(W);
		expect(card.sealCount).toBe(1);
	});

	it("never seals a displaceable block with an empty contribution", () => {
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["history"]));
		const empty = new DisplaceableBlock([]);
		container.addChild(empty);
		container.addChild(new MutableBlock(["tail"]));
		expect(container.render(W)).toEqual(["history", "", "tail"]);
		// None of the block's rows are on the tape: nothing to seal, ever.
		container.setNativeScrollbackCommittedRows(3);
		container.render(W);
		expect(empty.sealCount).toBe(0);
		expect(container.isBlockUncommitted(empty)).toBe(true);
	});

	it("walks past blocks without the displaceable protocol", () => {
		const container = new TranscriptContainer();
		const plain = new MutableBlock(["plain-block"]);
		container.addChild(plain);
		const card = new DisplaceableBlock(["todo-header"]);
		container.addChild(card);
		expect(container.render(W)).toEqual(["plain-block", "", "todo-header"]);
		container.setNativeScrollbackCommittedRows(3);
		// The pre-pass visits the plain block first (its rows also committed);
		// absent duck-typed methods are a no-op and the card below still seals.
		container.render(W);
		expect(card.sealCount).toBe(1);
		expect(container.isBlockUncommitted(plain)).toBe(false);
	});

	it("seals a block that became displaceable after its rows committed", () => {
		// A pending tool's preview rows scroll into native scrollback before
		// its successful result arrives; only then does the block become a
		// displaceable snapshot. The walk runs every render, so the flip is
		// caught on the next compose — not only when the boundary moves.
		const { container, card } = cardAfterHistory(false);
		container.setNativeScrollbackCommittedRows(3);
		container.render(W);
		// Rows committed while not displaceable: nothing to seal yet.
		expect(card.sealCount).toBe(0);
		card.makeDisplaceable();
		container.render(W);
		expect(card.sealCount).toBe(1);
	});
});
