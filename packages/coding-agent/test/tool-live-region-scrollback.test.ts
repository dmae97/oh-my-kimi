import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, TERMINAL, Text, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

type MutableTerminalInfo = {
	eagerEraseScrollbackRisk: boolean;
};

const mutableTerminalInfo = TERMINAL as unknown as MutableTerminalInfo;

async function withTerminalRisk<T>(risk: boolean, run: () => T | Promise<T>): Promise<T> {
	const saved = TERMINAL.eagerEraseScrollbackRisk;
	mutableTerminalInfo.eagerEraseScrollbackRisk = risk;
	try {
		return await run();
	} finally {
		mutableTerminalInfo.eagerEraseScrollbackRisk = saved;
	}
}

class MutableLiveBlock implements Component {
	#lines: string[];
	#finalized: boolean;

	constructor(lines: string[], finalized = false) {
		this.#lines = [...lines];
		this.#finalized = finalized;
	}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}
}

function markerLines(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_unused, i) => `${prefix}${i}`);
}

function stripRows(rows: string[]): string {
	return rows.map(row => Bun.stripANSI(row).trimEnd()).join("\n");
}

describe("transcript reactive commit boundary", () => {
	it("treats growth before stable trailing chrome as append-only", async () => {
		await withTerminalRisk(true, () => {
			const chat = new TranscriptContainer();
			const block = new MutableLiveBlock(["top", "stable", "bottom"]);
			chat.addChild(block);

			expect(chat.render(80)).toEqual(["top", "stable", "bottom"]);
			expect(chat.getNativeScrollbackCommitSafeEnd()).toBeUndefined();

			block.setLines(["top", "stable", "inserted", "bottom"]);
			expect(chat.render(80)).toEqual(["top", "stable", "inserted", "bottom"]);
			expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(4);
		});
	});

	it("treats in-place growth of the trailing line as append-only", async () => {
		await withTerminalRisk(true, () => {
			const chat = new TranscriptContainer();
			// Models a streaming assistant reply: stable head rows plus a current
			// line that grows token-by-token without adding a new row — the dominant
			// streaming shape, and the one a strict line-count-growth check missed,
			// stranding the scrolled-off head outside tmux pane history.
			const block = new MutableLiveBlock(["para one", "para two", "the quick brown"]);
			chat.addChild(block);

			chat.render(80);
			block.setLines(["para one", "para two", "the quick brown fox"]);
			chat.render(80);
			expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(3);
		});
	});

	it("marks interior live re-layout volatile and defers commit", async () => {
		await withTerminalRisk(true, () => {
			const chat = new TranscriptContainer();
			const block = new MutableLiveBlock(["top", "old", "bottom"]);
			chat.addChild(block);

			chat.render(80);
			block.setLines(["top", "new", "extra", "bottom"]);
			expect(chat.render(80)).toEqual(["top", "new", "extra", "bottom"]);
			expect(chat.getNativeScrollbackCommitSafeEnd()).toBeUndefined();

			block.setLines(["top", "new", "extra", "more", "bottom"]);
			chat.render(80);
			expect(chat.getNativeScrollbackCommitSafeEnd()).toBeUndefined();
		});
	});

	it("treats escape placement and pad drift on visually unchanged rows as append-only", async () => {
		await withTerminalRisk(true, () => {
			const chat = new TranscriptContainer();
			// Field failure shape (streaming styled thinking): the previous last row
			// carried the span-closing SGR before its width padding; when the
			// paragraph wrapped onto a new row, the close moved to the new last row
			// while the first row's visible cells stayed identical.
			const sty = "\x1b[38;2;156;163;176m";
			const block = new MutableLiveBlock([`${sty}alpha beta\x1b[39m   `]);
			chat.addChild(block);

			chat.render(80);
			block.setLines([`${sty}alpha beta   `, `${sty}gamma\x1b[39m        `]);
			chat.render(80);
			expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(2);
		});
	});

	it("treats a wrap-shrink of the trailing line as append-only", async () => {
		await withTerminalRisk(true, () => {
			const chat = new TranscriptContainer();
			// A streamed token extends the last word past the wrap column, so the
			// word moves down onto an appended row and the previous bottom line
			// shrinks. The bottom line is on screen by definition, so this is not a
			// rewrite of committed-candidate rows.
			const block = new MutableLiveBlock(["para one", "foo bar baz"]);
			chat.addChild(block);

			chat.render(80);
			block.setLines(["para one", "foo bar", "bazqux and more"]);
			chat.render(80);
			expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(3);
		});
	});

	it("re-earns append-only after a one-off interior rewrite heals", async () => {
		await withTerminalRisk(true, () => {
			const chat = new TranscriptContainer();
			const block = new MutableLiveBlock(["top", "old", "bottom"]);
			chat.addChild(block);

			chat.render(80);
			// Interior rewrite (a codespan finalizing across a wrap) suspends commits.
			block.setLines(["top", "new", "bottom"]);
			chat.render(80);
			expect(chat.getNativeScrollbackCommitSafeEnd()).toBeUndefined();

			// Clean static frames re-arm the block...
			for (let i = 0; i < 30; i++) chat.render(80);
			// ...and the next append-shaped frame resumes committing the full block,
			// so the pinned emitter can backfill the stalled gap contiguously.
			block.setLines(["top", "new", "bottom", "appended"]);
			chat.render(80);
			expect(chat.getNativeScrollbackCommitSafeEnd()).toBe(4);
		});
	});

	it("keeps a periodically rewriting block (spinner) deferred", async () => {
		await withTerminalRisk(true, () => {
			const chat = new TranscriptContainer();
			const block = new MutableLiveBlock(["⠋ running", "body"]);
			chat.addChild(block);

			chat.render(80);
			const glyphs = ["⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", "⠋"];
			for (const glyph of glyphs) {
				// Spinner advances every third frame; the static frames in between
				// must never accumulate into a re-arm.
				block.setLines([`${glyph} running`, "body"]);
				chat.render(80);
				chat.render(80);
				chat.render(80);
			}
			block.setLines(["⠋ running", "body", "appended"]);
			chat.render(80);
			expect(chat.getNativeScrollbackCommitSafeEnd()).toBeUndefined();
		});
	});
});

describe("tool live-region scrollback", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("does not splice stale pending eval preview above the running eval viewport", async () => {
		if (process.platform === "win32") return;

		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(120, 12);
			(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () =>
				undefined;
			const tui = new TUI(term);
			const chat = new TranscriptContainer();
			const code = Array.from({ length: 20 }, (_unused, i) => `const line${i} = ${i};`).join("\n");
			const title = "call model with new prompt + check box heights";
			const args = { cells: [{ language: "js", title, code }] };
			const component = new ToolExecutionComponent("eval", args, {}, undefined, tui, process.cwd());

			try {
				chat.addChild(
					new Text("Now let me verify by calling the model and checking the box heights it produces:", 0, 0),
				);
				chat.addChild(new Text("prior filler\n".repeat(8).trimEnd(), 0, 0));
				tui.addChild(chat);
				tui.start();
				tui.setEagerNativeScrollbackRebuild(true);
				await term.waitForRender();

				chat.addChild(component);
				tui.requestRender();
				await term.waitForRender();

				component.updateResult(
					{
						content: [{ type: "text", text: "" }],
						details: { cells: [{ index: 0, title, code, language: "js", output: "", status: "running" }] },
					},
					true,
				);
				tui.requestRender();
				await term.waitForRender();

				const bufferText = term
					.getScrollBuffer()
					.map(row => Bun.stripANSI(row).trimEnd())
					.join("\n");
				expect(bufferText).not.toContain("pending [1/1]");
				expect(bufferText).toContain("const line9 = 9;");
				expect(bufferText).toContain("const line19 = 19;");
			} finally {
				component.stopAnimation();
				tui.stop();
				await term.flush();
			}
		});
	});

	it("repaints a finalized write whose result lands after a card was appended below it", async () => {
		if (process.platform === "win32") return;

		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(120, 20);
			(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () =>
				undefined;
			const tui = new TUI(term);
			const chat = new TranscriptContainer();
			const content = Array.from({ length: 5 }, (_unused, i) => `const line${i} = ${i};`).join("\n");
			const args = { file_path: "packages/coding-agent/test/probe.ts", content };
			const component = new ToolExecutionComponent("write", args, {}, undefined, tui, process.cwd());

			try {
				chat.addChild(new Text("prior filler", 0, 0));
				tui.addChild(chat);
				tui.start();
				tui.setEagerNativeScrollbackRebuild(true);
				await term.waitForRender();

				// The write streams its preview while it is the live block.
				chat.addChild(component);
				tui.requestRender();
				await term.waitForRender();

				// An out-of-band card (e.g. a TTSR rule notification) is appended below
				// the still-in-flight write. Previously this froze the write on its
				// streaming preview, so the eventual result never repainted.
				chat.addChild(new Text("⚠ Injecting rule: ts-set-map", 0, 0));
				tui.requestRender();
				await term.waitForRender();

				const beforeResult = term
					.getScrollBuffer()
					.map(row => Bun.stripANSI(row).trimEnd())
					.join("\n");
				expect(beforeResult).toContain("(streaming)");

				// The write finishes after the card is already below it.
				component.updateResult({ content: [{ type: "text", text: "" }], details: { path: args.file_path } }, false);
				tui.requestRender();
				await term.waitForRender();

				const afterResult = term
					.getScrollBuffer()
					.map(row => Bun.stripANSI(row).trimEnd())
					.join("\n");
				// The streaming preview is gone and the finalized header repainted in place.
				expect(afterResult).not.toContain("(streaming)");
				expect(afterResult).toContain("· 5 lines");
			} finally {
				component.stopAnimation();
				tui.stop();
				await term.flush();
			}
		});
	});

	it("commits the scrolled-off head of an over-tall expanded streaming write to scrollback", async () => {
		if (process.platform === "win32") return;

		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(120, 20);
			(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () =>
				undefined;
			const tui = new TUI(term);
			const chat = new TranscriptContainer();
			const body = (n: number) => Array.from({ length: n }, (_unused, i) => `MARK-${i}`).join("\n");
			const filePath = "packages/coding-agent/test/probe.txt";
			// Expanded (Ctrl+O) lifts the tail-window cap, so the preview renders the
			// whole content top-anchored — append-only growth as chunks stream in.
			const component = new ToolExecutionComponent(
				"write",
				{ file_path: filePath, content: body(12) },
				{},
				undefined,
				tui,
				process.cwd(),
			);
			component.setExpanded(true);

			try {
				chat.addChild(component);
				tui.addChild(chat);
				tui.start();
				tui.setEagerNativeScrollbackRebuild(true);
				await term.waitForRender();

				for (const lineCount of [24, 40]) {
					component.updateArgs({ file_path: filePath, content: body(lineCount) });
					tui.requestRender();
					await term.waitForRender();
				}

				const scrollText = stripRows(term.getScrollBuffer());
				const viewportText = stripRows(term.getViewport());

				// MARK-0 scrolled above the viewport: it must live in native scrollback
				// (committed), not nowhere. Before the fix the tool block was not
				// append-only, so its scrolled-off head was dropped — a yanked stream.
				expect(viewportText).not.toContain("MARK-0");
				expect(scrollText).toContain("MARK-0");
				// The streaming tail stays on screen, and nothing went missing between.
				expect(viewportText).toContain("MARK-39");
				expect(viewportText).toContain("(streaming)");
				expect(scrollText).toContain("MARK-20");
			} finally {
				component.stopAnimation();
				tui.stop();
				await term.flush();
			}
		});
	});

	it("commits the scrolled-off head of an over-tall pending task context to scrollback", async () => {
		if (process.platform === "win32") return;

		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(120, 12);
			(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () =>
				undefined;
			const tui = new TUI(term);
			const chat = new TranscriptContainer();
			const context = (n: number) => Array.from({ length: n }, (_unused, i) => `- CTX-${i}`).join("\n");
			const args = (n: number) => ({
				agent: "task",
				context: context(n),
				tasks: [{ id: "alpha", description: "probe", assignment: "Inspect the task context." }],
			});
			const component = new ToolExecutionComponent("task", args(4), {}, undefined, tui, process.cwd());

			try {
				chat.addChild(component);
				tui.addChild(chat);
				tui.start();
				tui.setEagerNativeScrollbackRebuild(true);
				await term.waitForRender();

				for (const lineCount of [12, 24, 40]) {
					component.updateArgs(args(lineCount));
					tui.requestRender();
					await term.waitForRender();
				}

				const scrollText = stripRows(term.getScrollBuffer());
				const viewportText = stripRows(term.getViewport());

				expect(viewportText).not.toContain("CTX-0");
				expect(scrollText).toContain("CTX-0");
				expect(scrollText).toContain("CTX-20");
				expect(viewportText).toContain("CTX-39");
			} finally {
				component.stopAnimation();
				tui.stop();
				await term.flush();
			}
		});
	});

	it("commits the scrolled-off head of a tall finalized bottom tool result", async () => {
		if (process.platform === "win32") return;

		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(120, 12);
			(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () =>
				undefined;
			const tui = new TUI(term);
			const chat = new TranscriptContainer();
			const content = markerLines("FINAL-", 40).join("\n");
			const args = { path: "packages/coding-agent/test/finalized.txt" };
			const component = new ToolExecutionComponent("read", args, {}, undefined, tui, process.cwd());
			component.setExpanded(true);
			component.updateResult(
				{
					content: [{ type: "text", text: content }],
					details: { displayContent: { text: content, startLine: 1 } },
				},
				false,
			);

			try {
				chat.addChild(component);
				tui.addChild(chat);
				tui.start();
				tui.setEagerNativeScrollbackRebuild(true);
				await term.waitForRender();

				const scrollText = stripRows(term.getScrollBuffer());
				const viewportText = stripRows(term.getViewport());

				expect(viewportText).not.toContain("FINAL-0");
				expect(scrollText).toContain("FINAL-0");
				expect(scrollText).toContain("FINAL-20");
				expect(viewportText).toContain("FINAL-39");
			} finally {
				component.stopAnimation();
				tui.stop();
				await term.flush();
			}
		});
	});

	it("keeps a re-layouting live block's changed head out of scrollback", async () => {
		if (process.platform === "win32") return;

		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(120, 12);
			(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () =>
				undefined;
			const tui = new TUI(term);
			const chat = new TranscriptContainer();
			const block = new MutableLiveBlock(markerLines("OLD-", 8));

			try {
				chat.addChild(block);
				tui.addChild(chat);
				tui.start();
				tui.setEagerNativeScrollbackRebuild(true);
				await term.waitForRender();

				block.setLines(markerLines("NEW-", 40));
				tui.requestRender();
				await term.waitForRender();

				const scrollText = stripRows(term.getScrollBuffer());
				const viewportText = stripRows(term.getViewport());

				expect(viewportText).not.toContain("NEW-0");
				expect(scrollText).not.toContain("NEW-0");
				expect(scrollText).not.toContain("NEW-20");
				expect(viewportText).toContain("NEW-39");
			} finally {
				tui.stop();
				await term.flush();
			}
		});
	});

	it("commits the scrolled-off head of an expanded eval whose output streams past the viewport", async () => {
		if (process.platform === "win32") return;

		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(120, 12);
			(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () =>
				undefined;
			const tui = new TUI(term);
			const chat = new TranscriptContainer();
			const title = "stream lots of output";
			const code = "for (let i = 0; i < 40; i++) console.log('MARK-' + i);";
			const args = { cells: [{ language: "js", title, code }] };
			const component = new ToolExecutionComponent("eval", args, {}, undefined, tui, process.cwd());
			component.setExpanded(true);
			const out = (n: number) => Array.from({ length: n }, (_unused, i) => `MARK-${i}`).join("\n");
			const partial = (output: string) =>
				component.updateResult(
					{
						content: [{ type: "text", text: "" }],
						details: { cells: [{ index: 0, title, code, language: "js", output, status: "running" }] },
					},
					true,
				);

			partial(out(4));

			try {
				chat.addChild(component);
				tui.addChild(chat);
				tui.start();
				tui.setEagerNativeScrollbackRebuild(true);
				await term.waitForRender();

				for (const lineCount of [12, 24, 40]) {
					partial(out(lineCount));
					tui.requestRender();
					await term.waitForRender();
				}

				const scrollText = stripRows(term.getScrollBuffer());
				const viewportText = stripRows(term.getViewport());

				// The streamed output head scrolled above the viewport: it must live in
				// native scrollback (committed), not nowhere. The fixed code cell rides
				// along as the stable prefix above it.
				expect(viewportText).not.toContain("MARK-0");
				expect(scrollText).toContain("MARK-0");
				expect(scrollText).toContain("MARK-20");
				// The streaming tail stays on screen, and nothing went missing between.
				expect(viewportText).toContain("MARK-39");
			} finally {
				component.stopAnimation();
				tui.stop();
				await term.flush();
			}
		});
	});
});

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeThinkingMessage(thinking: string): AssistantMessage {
	const message = makeAssistantMessage("");
	message.content = [{ type: "thinking", thinking }];
	return message;
}

describe("assistant live-region scrollback", () => {
	beforeAll(async () => {
		await initTheme();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});

	it("commits a streamed reply's scrolled-off head to scrollback instead of dropping it", async () => {
		if (process.platform === "win32") return;

		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(120, 12);
			(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () =>
				undefined;
			const tui = new TUI(term);
			const chat = new TranscriptContainer();
			// A streaming assistant reply, mid-stream (no message in the ctor → live).
			// A markdown list yields one stable row per item, so growth is append-only.
			const component = new AssistantMessageComponent(undefined, false);
			const markers = Array.from({ length: 40 }, (_unused, i) => `- MARK-${i}`);

			try {
				chat.addChild(component);
				tui.addChild(chat);
				tui.start();
				tui.setEagerNativeScrollbackRebuild(true);
				await term.waitForRender();

				component.updateContent(makeAssistantMessage(markers.slice(0, 4).join("\n")));
				tui.requestRender();
				await term.waitForRender();

				for (const lineCount of [12, 24, 40]) {
					component.updateContent(makeAssistantMessage(markers.slice(0, lineCount).join("\n")));
					tui.requestRender();
					await term.waitForRender();
				}

				const scrollText = stripRows(term.getScrollBuffer());
				const viewportText = stripRows(term.getViewport());

				// MARK-0 scrolled above the viewport: with the fix it lives in native
				// scrollback (committed), not nowhere. The regression dropped it.
				expect(viewportText).not.toContain("MARK-0");
				expect(scrollText).toContain("MARK-0");
				// The tail is still on screen, and nothing went missing in between.
				expect(viewportText).toContain("MARK-39");
				expect(scrollText).toContain("MARK-20");
			} finally {
				tui.stop();
				await term.flush();
			}
		});
	});

	it("commits scrolled-off styled thinking paragraphs to scrollback while streaming", async () => {
		if (process.platform === "win32") return;

		await withTerminalRisk(true, async () => {
			const term = new VirtualTerminal(120, 12);
			(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () =>
				undefined;
			const tui = new TUI(term);
			const chat = new TranscriptContainer();
			const component = new AssistantMessageComponent(undefined, false);
			// Word-wrapped italic/colored paragraphs — the styled streaming shape the
			// raw-byte append detector mis-classified as volatile (the span-closing
			// SGR moves rows as the paragraph wraps), which froze the commit boundary
			// and dropped every later paragraph that scrolled past the viewport top.
			const paragraphs = Array.from(
				{ length: 8 },
				(_unused, i) =>
					`PARA-${i} considering the resolver path and the descriptor defaults, the policy layer must keep the ` +
					`reasoning flag intact while discovery maps an unknown model entry onto the bundled reference shape ` +
					`so the runtime request stays correct across upstream metadata shifts.`,
			);
			const fullText = paragraphs.join("\n\n");
			const words = fullText.split(" ");

			try {
				chat.addChild(component);
				tui.addChild(chat);
				tui.start();
				tui.setEagerNativeScrollbackRebuild(true);
				await term.waitForRender();

				// Stream a few words per frame so the in-flight bottom line extends,
				// wraps, and sheds words onto new rows across many coalesced frames.
				for (let i = 5; i <= words.length; i += 5) {
					component.updateContent(makeThinkingMessage(words.slice(0, i).join(" ")));
					tui.requestRender();
					await term.waitForRender();
				}

				const scrollText = stripRows(term.getScrollBuffer());
				const viewportText = stripRows(term.getViewport());

				// Early paragraphs scrolled above the viewport: they must live in
				// native scrollback, not vanish into the dropped gap.
				expect(viewportText).not.toContain("PARA-0");
				expect(scrollText).toContain("PARA-0");
				expect(scrollText).toContain("PARA-4");
				// The tail is still on screen.
				expect(viewportText).toContain("PARA-7");
			} finally {
				tui.stop();
				await term.flush();
			}
		});
	});
});
