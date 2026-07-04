import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import type { Component } from "@oh-my-pi/pi-tui";

class MutableLiveBlock implements Component {
	#lines: string[];
	#settledRows: number;

	constructor(lines: string[], settledRows: number) {
		this.#lines = [...lines];
		this.#settledRows = settledRows;
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
	getTranscriptBlockSettledRows(): number {
		return this.#settledRows;
	}
}

describe("transcript streaming commit (assistant text)", () => {
	it("commits only the declared settled head while the trailing line grows", () => {
		const chat = new TranscriptContainer();
		// Models a streaming assistant reply: stable head rows plus a current
		// line that grows token-by-token without adding a new row. The head is
		// committable only because the block explicitly declares those rows settled.
		const block = new MutableLiveBlock(["para one", "para two", "the quick brown"], 2);
		chat.addChild(block);

		chat.render(80);
		expect(chat.getNativeScrollbackLiveRegionStart()).toBe(2);

		block.setLines(["para one", "para two", "the quick brown fox"]);
		chat.render(80);

		expect(chat.getNativeScrollbackLiveRegionStart()).toBe(2);
	});
});
