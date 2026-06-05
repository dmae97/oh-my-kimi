import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { TERMINAL, Text, TUI } from "@oh-my-pi/pi-tui";
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
				expect(bufferText).toContain("… 10 more lines");
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

				// First a short reply that fits, then the full reply that overflows the
				// 12-row viewport — the frame that scrolls the head above the top.
				component.updateContent(makeAssistantMessage(markers.slice(0, 4).join("\n")));
				tui.requestRender();
				await term.waitForRender();

				component.updateContent(makeAssistantMessage(markers.join("\n")));
				tui.requestRender();
				await term.waitForRender();

				const strip = (rows: string[]) => rows.map(row => Bun.stripANSI(row).trimEnd()).join("\n");
				const scrollText = strip(term.getScrollBuffer());
				const viewportText = strip(term.getViewport());

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
