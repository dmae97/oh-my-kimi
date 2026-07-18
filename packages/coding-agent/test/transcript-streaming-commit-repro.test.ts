import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { Markdown, type MarkdownTheme } from "@oh-my-pi/pi-tui/components/markdown";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { defaultMarkdownTheme } from "../../tui/test/test-themes.js";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

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

const diffMarkdownTheme: MarkdownTheme = {
	...defaultMarkdownTheme,
	codeBlock: text => text,
	codeBlockBorder: text => text,
	highlightCode: (source, lang) => {
		const normalizedLang = lang?.trim().toLowerCase();
		const highlighted: string[] = [];
		for (const line of source.split("\n")) {
			if (normalizedLang === "diff" && line.startsWith("+")) highlighted.push(`\x1b[32m${line}\x1b[39m`);
			else if (normalizedLang === "diff" && line.startsWith("-")) highlighted.push(`\x1b[31m${line}\x1b[39m`);
			else highlighted.push(line);
		}
		return highlighted;
	},
};

class StreamingMarkdownBlock implements Component {
	#finalized = false;
	#markdown = new Markdown("", 0, 0, diffMarkdownTheme);

	setStreamingText(text: string): void {
		this.#finalized = false;
		this.#markdown.transientRenderCache = true;
		this.#markdown.setText(text);
	}

	finalize(text: string): void {
		this.#finalized = true;
		this.#markdown.transientRenderCache = false;
		this.#markdown.setText(text);
	}

	render(width: number): readonly string[] {
		const lines = this.#markdown.render(width);
		return lines;
	}

	isTranscriptBlockFinalized(): boolean {
		const finalized = this.#finalized;
		return finalized;
	}

	getTranscriptBlockSettledRows(): number {
		const rows = this.#markdown.getLastRenderSettledRows();
		return rows;
	}
}

function foregroundColumnsForBufferRow(term: VirtualTerminal, bufferRow: number): number[] {
	const before = term.getBufferPosition();
	term.scrollLines(bufferRow - before.viewportY);
	const columns = term.getViewportRowForegroundColumns(0);
	const after = term.getBufferPosition();
	term.scrollLines(before.viewportY - after.viewportY);
	return columns;
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

	it("keeps diff foreground on rows committed while a streamed fence is still open", async () => {
		if (process.platform === "win32") return;
		const rows = 6;
		const term = new VirtualTerminal(48, rows);
		Object.defineProperty(term, "isNativeViewportAtBottom", { configurable: true, value: () => undefined });
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const chat = new TranscriptContainer();
		const block = new StreamingMarkdownBlock();
		const diffLines = Array.from({ length: 18 }, (_value, index) => {
			const sign = index % 2 === 0 ? "+" : "-";
			return `${sign}changed-${String(index).padStart(2, "0")}`;
		});
		const openFence = `\`\`\`diff\n${diffLines.join("\n")}\n`;
		const closedFence = `${openFence}\`\`\``;
		chat.addChild(block);
		tui.addChild(chat);

		try {
			tui.start();
			await scheduler.drain(term);

			block.setStreamingText(openFence);
			tui.requestRender();
			await scheduler.drain(term);

			const streamedRows = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			const streamedRow = streamedRows.findIndex(row => row.includes("+changed-00"));
			expect(streamedRow).toBeGreaterThanOrEqual(0);
			expect(streamedRow).toBeLessThan(term.getBufferPosition().baseY);

			block.finalize(closedFence);
			tui.requestRender();
			await scheduler.drain(term);

			const finalRows = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			const finalRow = finalRows.findIndex(row => row.includes("+changed-00"));
			expect(finalRow).toBe(streamedRow);
			expect(finalRow).toBeLessThan(term.getBufferPosition().baseY);
			expect(foregroundColumnsForBufferRow(term, finalRow).length).toBeGreaterThan(0);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("keeps the final closed diff row highlighted while following prose streams", async () => {
		if (process.platform === "win32") return;
		const rows = 6;
		const term = new VirtualTerminal(52, rows);
		Object.defineProperty(term, "isNativeViewportAtBottom", { configurable: true, value: () => undefined });
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const chat = new TranscriptContainer();
		const block = new StreamingMarkdownBlock();
		const diffLines = Array.from({ length: 18 }, (_value, index) => {
			const sign = index % 2 === 0 ? "-" : "+";
			return `${sign}closed-${String(index).padStart(2, "0")}`;
		});
		const finalDiffLine = "+closed-tail-no-extra-newline";
		const codeBlockSource = [...diffLines, finalDiffLine].join("\n");
		const streamingProse = Array.from(
			{ length: 12 },
			(_value, index) => `still streaming prose line ${String(index).padStart(2, "0")}`,
		).join("\n");
		const closedFenceWithLiveTail = `\`\`\`diff\n${codeBlockSource}\n\`\`\`\n${streamingProse}`;
		chat.addChild(block);
		tui.addChild(chat);

		try {
			tui.start();
			await scheduler.drain(term);

			block.setStreamingText(closedFenceWithLiveTail);
			tui.requestRender();
			await scheduler.drain(term);

			const streamedRows = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			const finalDiffRow = streamedRows.findIndex(row => row.includes(finalDiffLine));
			expect(finalDiffRow).toBeGreaterThanOrEqual(0);
			expect(finalDiffRow).toBeLessThan(term.getBufferPosition().baseY);
			expect(foregroundColumnsForBufferRow(term, finalDiffRow).length).toBeGreaterThan(0);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("renders a leading completed blank row in an open streamed diff body", () => {
		const block = new StreamingMarkdownBlock();
		block.setStreamingText("```diff\n\n+next");

		const rows = block.render(40).map(row => Bun.stripANSI(row).trimEnd());
		const fenceRow = rows.indexOf("```diff");

		expect(fenceRow).toBeGreaterThanOrEqual(0);
		expect(rows.slice(fenceRow, fenceRow + 4)).toEqual(["```diff", "", "  +next", "```"]);
	});

	it("appends a completed blank row when the streamed diff line cache grows", () => {
		const block = new StreamingMarkdownBlock();

		block.setStreamingText("```diff\n+a\n+streaming");
		const initialRows = block.render(40).map(row => Bun.stripANSI(row).trimEnd());
		const initialCodeRow = initialRows.indexOf("  +a");
		expect(initialCodeRow).toBeGreaterThanOrEqual(0);
		expect(initialRows.slice(initialCodeRow, initialCodeRow + 2)).toEqual(["  +a", "  +streaming"]);

		block.setStreamingText("```diff\n+a\n\n+streaming");

		const rows = block.render(40).map(row => Bun.stripANSI(row).trimEnd());
		const codeRow = rows.indexOf("  +a");

		expect(codeRow).toBeGreaterThanOrEqual(0);
		expect(rows.slice(codeRow, codeRow + 3)).toEqual(["  +a", "", "  +streaming"]);
	});

	it("does not duplicate a leading blank row when the streamed diff grows", () => {
		const block = new StreamingMarkdownBlock();

		block.setStreamingText("```diff\n\n+partial");
		block.render(40);

		block.setStreamingText("```diff\n\n+done\n-streaming");

		const rows = block.render(40).map(row => Bun.stripANSI(row).trimEnd());
		const fenceRow = rows.indexOf("```diff");

		expect(fenceRow).toBeGreaterThanOrEqual(0);
		expect(rows.slice(fenceRow, fenceRow + 5)).toEqual(["```diff", "", "  +done", "  -streaming", "```"]);
	});
});
