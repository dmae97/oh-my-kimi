import { afterEach, describe, expect, it } from "bun:test";
import { type Component, TERMINAL } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "../../../src/modes/components/transcript-container";

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

const riskFlag = TERMINAL as unknown as { eagerEraseScrollbackRisk: boolean };
const original = riskFlag.eagerEraseScrollbackRisk;

afterEach(() => {
	riskFlag.eagerEraseScrollbackRisk = original;
});

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
		expect(container.render(40)).toEqual(["a2", "b1"]);

		// A post-freeze mutation of `a` (its collapse/re-layout) is NOT reflected —
		// the committed rows stay stable so no stale duplicate enters scrollback.
		a.set(["a3-collapsed"]);
		expect(container.render(40)).toEqual(["a2", "b1"]);

		// The live block still updates freely.
		b.set(["b2"]);
		expect(container.render(40)).toEqual(["a2", "b2"]);
	});

	it("reports the live block start for native scrollback pinning (ED3-risk)", () => {
		riskFlag.eagerEraseScrollbackRisk = true;
		const container = new TranscriptContainer();
		const a = new MutableBlock(["a1", "a2"]);
		const b = new MutableBlock(["b1"]);
		container.addChild(a);
		container.addChild(b);

		expect(container.render(40)).toEqual(["a1", "a2", "b1"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(2);

		b.set(["b1", "b2"]);
		expect(container.render(40)).toEqual(["a1", "a2", "b1", "b2"]);
		expect(container.getNativeScrollbackLiveRegionStart()).toBe(2);
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
		expect(container.render(40)).toEqual(["Natives built, now...", "b1"]);

		// Once sealed, a later re-layout of `a` stays frozen until the next thaw.
		a.set(["a-collapsed"]);
		expect(container.render(40)).toEqual(["Natives built, now...", "b1"]);
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
		expect(container.render(40)).toEqual(["a1", "b1"]); // frozen

		container.thaw();
		expect(container.render(40)).toEqual(["a-final", "b1"]); // reconciled
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
		expect(container.render(40)).toEqual(["a1", "b1"]); // frozen at width 40
		// A resize is an explicit rebuild that reconciles history, so recompute.
		expect(container.render(80)).toEqual(["a-reflowed", "b1"]);
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
		expect(container.render(40)).toEqual(["a-updated", "b1"]);
	});
});
