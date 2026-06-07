import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, TERMINAL, Text } from "@oh-my-pi/pi-tui";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";
import { AssistantMessageComponent } from "../../../src/modes/components/assistant-message";
import { TranscriptContainer } from "../../../src/modes/components/transcript-container";
import { initTheme } from "../../../src/modes/theme/theme";
import { USER_INTERRUPT_LABEL } from "../../../src/session/messages";

// Models a transcript block that re-lays-out (tool preview collapsing, assistant
// message finalizing, late async result) after it has scrolled past the live
// region — the mutation that leaves a stale duplicate on ED3-risk terminals.
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

const riskFlag = TERMINAL as unknown as { eagerEraseScrollbackRisk: boolean };
const original = riskFlag.eagerEraseScrollbackRisk;

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

afterEach(() => {
	riskFlag.eagerEraseScrollbackRisk = original;
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

function plain(lines: string[]): string {
	return stripVTControlCharacters(lines.join("\n"));
}

describe("TranscriptContainer", () => {
	it("freezes a block at its last live render once a newer block is appended (ED3-risk)", () => {
		riskFlag.eagerEraseScrollbackRisk = true;
		const container = new TranscriptContainer();
		const a = new MutableBlock(["a1"]);
		container.addChild(a);
		expect(container.render(40)).toEqual(["a1"]);

		// While `a` is still the live (bottom-most) block its render tracks updates.
		a.set(["a2"]);
		expect(container.render(40)).toEqual(["a2"]);

		// A newer block makes `a` non-live; it now replays its last live render.
		const b = new MutableBlock(["b1"]);
		container.addChild(b);
		expect(container.render(40)).toEqual(["a2", "", "b1"]);

		// A post-freeze mutation of `a` (its collapse/re-layout) is NOT reflected —
		// the committed rows stay stable so no stale duplicate enters scrollback.
		a.set(["a3-collapsed"]);
		expect(container.render(40)).toEqual(["a2", "", "b1"]);

		// The live block still updates freely.
		b.set(["b2"]);
		expect(container.render(40)).toEqual(["a2", "", "b2"]);
	});

	it("reports the live block start for native scrollback pinning (ED3-risk)", () => {
		riskFlag.eagerEraseScrollbackRisk = true;
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

	it("seals the prior block at its final content when finalize+append coalesce (ED3-risk)", () => {
		riskFlag.eagerEraseScrollbackRisk = true;
		const container = new TranscriptContainer();
		const a = new MutableBlock(["Nat"]);
		container.addChild(a);
		// `a` streamed a partial chunk and rendered while live.
		expect(container.render(40)).toEqual(["Nat"]);

		// TUI render coalescing: `a` finalizes AND a newer block is appended within
		// one throttled frame, so no render happens between the two mutations.
		a.set(["Natives built, now..."]);
		const b = new MutableBlock(["b1"]);
		container.addChild(b);

		// The transition frame must seal `a` at its final content, not the stale
		// mid-stream snapshot ("Nat") it last rendered while live.
		expect(container.render(40)).toEqual(["Natives built, now...", "", "b1"]);

		// Once sealed, a later re-layout of `a` stays frozen until the next thaw.
		a.set(["a-collapsed"]);
		expect(container.render(40)).toEqual(["Natives built, now...", "", "b1"]);
	});

	it("thaw() reconciles frozen blocks to their current state", () => {
		riskFlag.eagerEraseScrollbackRisk = true;
		const container = new TranscriptContainer();
		const a = new MutableBlock(["a1"]);
		const b = new MutableBlock(["b1"]);
		container.addChild(a);
		container.addChild(b);
		container.render(40);
		a.set(["a-final"]);
		expect(container.render(40)).toEqual(["a1", "", "b1"]); // frozen

		container.thaw();
		expect(container.render(40)).toEqual(["a-final", "", "b1"]); // reconciled
	});

	it("invalidate() retires frozen snapshots so resetDisplay reflects current state", () => {
		// resetDisplay() (Ctrl+L, and the Ctrl+O expand path) reflows by calling
		// TUI.invalidate(), which propagates to this container. That must retire the
		// frozen snapshots the same way thaw() does, or a forced full replay would
		// still emit the pre-mutation (e.g. collapsed) render.
		riskFlag.eagerEraseScrollbackRisk = true;
		const container = new TranscriptContainer();
		const a = new MutableBlock(["a-collapsed"]);
		const b = new MutableBlock(["b1"]);
		container.addChild(a);
		container.addChild(b);
		container.render(40);
		a.set(["a-expanded-1", "a-expanded-2"]);
		expect(container.render(40)).toEqual(["a-collapsed", "", "b1"]); // frozen

		container.invalidate();
		expect(container.render(40)).toEqual(["a-expanded-1", "a-expanded-2", "", "b1"]);
	});

	it("recomputes a frozen block on a width change", () => {
		riskFlag.eagerEraseScrollbackRisk = true;
		const container = new TranscriptContainer();
		const a = new MutableBlock(["a1"]);
		const b = new MutableBlock(["b1"]);
		container.addChild(a);
		container.addChild(b);
		container.render(40);
		a.set(["a-reflowed"]);
		expect(container.render(40)).toEqual(["a1", "", "b1"]); // frozen at width 40
		// A resize is an explicit rebuild that reconciles history, so recompute.
		expect(container.render(80)).toEqual(["a-reflowed", "", "b1"]);
	});

	it("renders every block live on terminals that can rebuild history", () => {
		riskFlag.eagerEraseScrollbackRisk = false;
		const container = new TranscriptContainer();
		const a = new MutableBlock(["a1"]);
		const b = new MutableBlock(["b1"]);
		container.addChild(a);
		container.addChild(b);
		container.render(40);
		// No freezing: a non-live block's mutation is reflected (the renderer can
		// rebuild committed history on these terminals).
		a.set(["a-updated"]);
		expect(container.render(40)).toEqual(["a-updated", "", "b1"]);
	});

	it("keeps an unfinalized block live when a finalized block is appended below it (ED3-risk)", () => {
		riskFlag.eagerEraseScrollbackRisk = true;
		const container = new TranscriptContainer();
		// A foreground tool whose args are still streaming (no result yet).
		const tool = new StreamingBlock(["write (streaming)"]);
		container.addChild(tool);
		expect(container.render(40)).toEqual(["write (streaming)"]);

		// An out-of-band card (TTSR/todo reminder) is appended below the in-flight
		// tool while it is still streaming. The tool must NOT freeze here.
		const card = new MutableBlock(["rule card"]);
		container.addChild(card);
		expect(container.render(40)).toEqual(["write (streaming)", "", "rule card"]);
		// The live region begins at the unfinalized tool, not the bottom card.
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(0);

		// The tool's result lands after the card is already below it. Because the
		// tool was kept live, its final content is reflected — the bug was it
		// freezing on the streaming preview and never showing the result.
		tool.finalize(["✔ write: 4 lines"]);
		expect(container.render(40)).toEqual(["✔ write: 4 lines", "", "rule card"]);

		// Now finalized, it freezes: a later re-layout stays put until the next thaw.
		tool.set(["collapsed"]);
		expect(container.render(40)).toEqual(["✔ write: 4 lines", "", "rule card"]);
	});

	it("keeps a streaming assistant live so an abort label can land after status rows below it (ED3-risk)", () => {
		riskFlag.eagerEraseScrollbackRisk = true;
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
		// message_end stamps the abort label. The assistant must stay repaintable.
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
		expect(rendered).toContain(USER_INTERRUPT_LABEL);
		expect(rendered).toContain("Copied raw SSE stream");
		expect(container.getNativeScrollbackLiveRegionStart()).not.toBe(0);
	});

	it("seals the live region at the earliest of several unfinalized blocks (ED3-risk)", () => {
		riskFlag.eagerEraseScrollbackRisk = true;
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

		// The leading sealed block freezes; its re-layout is not reflected.
		sealed.set(["done-collapsed"]);
		expect(container.render(40)).toEqual(["done", "", "pending", "", "card"]);

		// The pending block updates freely while live.
		pending.finalize(["pending-final"]);
		expect(container.render(40)).toEqual(["done", "", "pending-final", "", "card"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(4);
	});
});

describe("TranscriptContainer spacing", () => {
	it("inserts exactly one blank line between consecutive blocks", () => {
		riskFlag.eagerEraseScrollbackRisk = false;
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["a"]));
		container.addChild(new MutableBlock(["b"]));
		container.addChild(new MutableBlock(["c"]));
		// One separator between each block; none above the first.
		expect(container.render(40)).toEqual(["a", "", "b", "", "c"]);
	});

	it("strips a block's plain-blank top/bottom padding", () => {
		riskFlag.eagerEraseScrollbackRisk = false;
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["a"]));
		// Leading Spacer rows + a trailing paddingY row collapse to just the body.
		container.addChild(new MutableBlock(["", "   ", "body", ""]));
		expect(container.render(40)).toEqual(["a", "", "body"]);
	});

	it("preserves background-colored padding rows (block-internal design)", () => {
		riskFlag.eagerEraseScrollbackRisk = false;
		const bgPad = "\x1b[48;2;0;0;0m   \x1b[0m";
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["a"]));
		// The ANSI-bearing padding row is not "plain blank", so it survives stripping.
		container.addChild(new MutableBlock([bgPad, "x", bgPad]));
		expect(container.render(40)).toEqual(["a", "", bgPad, "x", bgPad]);
	});

	it("does not double the gap when a block carries its own trailing blank", () => {
		riskFlag.eagerEraseScrollbackRisk = false;
		const container = new TranscriptContainer();
		// The trailing blank is stripped, so only the container's separator remains.
		container.addChild(new MutableBlock(["note", ""]));
		container.addChild(new MutableBlock(["b"]));
		expect(container.render(40)).toEqual(["note", "", "b"]);
	});

	it("does not inject separators within a single block's rows", () => {
		riskFlag.eagerEraseScrollbackRisk = false;
		const container = new TranscriptContainer();
		// An IRC card / file-mention list wrapped as one block stays tight inside.
		container.addChild(new MutableBlock(["header", "  body1", "  body2"]));
		expect(container.render(40)).toEqual(["header", "  body1", "  body2"]);
	});

	it("drops a blank-only block without leaving a stray gap", () => {
		riskFlag.eagerEraseScrollbackRisk = false;
		const container = new TranscriptContainer();
		container.addChild(new MutableBlock(["a"]));
		container.addChild(new MutableBlock(["", "  "]));
		container.addChild(new MutableBlock(["b"]));
		expect(container.render(40)).toEqual(["a", "", "b"]);
	});

	it("counts the separator into the committed prefix below the live region (ED3-risk)", () => {
		riskFlag.eagerEraseScrollbackRisk = true;
		const container = new TranscriptContainer();
		// A finalized block, then a still-live block below it.
		container.addChild(new MutableBlock(["a1", "a2"]));
		container.addChild(new StreamingBlock(["b"]));
		// Separator sits at index 2; the live block's content begins at index 3.
		expect(container.render(40)).toEqual(["a1", "a2", "", "b"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(3);
	});
});
