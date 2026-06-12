import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import type { Component } from "@oh-my-pi/pi-tui";

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
});
