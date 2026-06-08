import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, TERMINAL, Text, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { Settings } from "../src/config/settings";
import { AssistantMessageComponent } from "../src/modes/components/assistant-message";
import { ToolExecutionComponent } from "../src/modes/components/tool-execution";
import { TranscriptContainer } from "../src/modes/components/transcript-container";
import { initTheme } from "../src/modes/theme/theme";

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
});
