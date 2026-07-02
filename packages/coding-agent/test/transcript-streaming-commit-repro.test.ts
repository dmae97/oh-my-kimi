import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import type { Component } from "@oh-my-pi/pi-tui";

class FinalizedBlock implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = [...lines];
	}
	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

class MutableLiveBlock implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = [...lines];
	}
	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
}

describe("transcript streaming commit (assistant text)", () => {
	it("treats in-place growth of the trailing line as append-only", () => {
		const chat = new TranscriptContainer();
		// Models a streaming assistant reply: stable head rows plus a current
		// line that grows token-by-token without adding a new row.
		const block = new MutableLiveBlock(["para one", "para two", "the quick brown"]);
		chat.addChild(block);

		chat.render(80);

		block.setLines(["para one", "para two", "the quick brown fox"]);
		chat.render(80);
		// The head rows never changed; only the trailing line grew. Its scrolled-
		// off head must be committable to native scrollback (tmux pane history).
		expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(3);
	});

	it("offers lower finalized siblings without making them durable", () => {
		const chat = new TranscriptContainer();
		const top = new FinalizedBlock(["top-0"]);
		const live = new MutableLiveBlock(["live-0"]);
		const tail = new FinalizedBlock(["tail-0", "tail-1"]);
		chat.addChild(top);
		chat.addChild(live);
		chat.addChild(tail);

		expect(chat.render(80)).toEqual(["top-0", "", "live-0", "", "tail-0", "tail-1"]);
		expect(chat.getNativeScrollbackLiveRegionStart()).toBe(2);
		expect(chat.getNativeScrollbackSnapshotSafeEnd()).toBe(3);
		expect(chat.getNativeScrollbackOfferSafeEnd()).toBe(6);
	});

	it("stops offered siblings at an intervening live block", () => {
		const chat = new TranscriptContainer();
		const top = new FinalizedBlock(["top-0"]);
		const firstLive = new MutableLiveBlock(["live-a"]);
		const firstTail = new FinalizedBlock(["tail-a-0", "tail-a-1"]);
		const secondLive = new MutableLiveBlock(["live-b"]);
		const laterTail = new FinalizedBlock(["tail-b-0"]);
		chat.addChild(top);
		chat.addChild(firstLive);
		chat.addChild(firstTail);
		chat.addChild(secondLive);
		chat.addChild(laterTail);

		expect(chat.render(80)).toEqual([
			"top-0",
			"",
			"live-a",
			"",
			"tail-a-0",
			"tail-a-1",
			"",
			"live-b",
			"",
			"tail-b-0",
		]);
		expect(chat.getNativeScrollbackLiveRegionStart()).toBe(2);
		expect(chat.getNativeScrollbackSnapshotSafeEnd()).toBe(3);
		expect(chat.getNativeScrollbackOfferSafeEnd()).toBe(6);
	});
});
