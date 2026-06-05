import { beforeAll, describe, expect, it } from "bun:test";
import { TERMINAL, Text, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
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
});
