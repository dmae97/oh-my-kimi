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
	render(_width: number): string[] {
		return [...this.#lines];
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

	it("reports the live block start that gates native scrollback commits", () => {
		const container = new TranscriptContainer();
		const a = new MutableBlock(["a1", "a2"]);
		const b = new MutableBlock(["b1"]);
		container.addChild(a);
		container.addChild(b);

		expect(container.render(40)).toEqual(["a1", "a2", "", "b1"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(3);

		b.set(["b1", "b2"]);
		expect(container.render(40)).toEqual(["a1", "a2", "", "b1", "b2"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(3);
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
		// The seam moves past the now-finalized tool.
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(2);

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
		expect(rendered).not.toContain(USER_INTERRUPT_LABEL);
		expect(rendered).toContain("Copied raw SSE stream");
		expect(container.getNativeScrollbackLiveRegionStart()).not.toBe(0);
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
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(4);
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
