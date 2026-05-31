import { describe, expect, it } from "bun:test";
import { Container, Editor, TUI } from "@oh-my-pi/pi-tui";
import type { AutocompleteItem, AutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { defaultEditorTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

class SlashProvider implements AutocompleteProvider {
	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const text = (lines[cursorLine] ?? "").slice(0, cursorCol);
		if (!text.startsWith("/")) return null;
		const prefix = text.slice(1).toLowerCase();
		const commands = ["model", "settings", "skill:semantic-compression", "status", "stats", "stop"];
		const items = commands
			.filter(command => command.includes(prefix))
			.map(command => ({ value: command, label: command }));
		return items.length > 0 ? { prefix: text, items } : null;
	}

	applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
		const line = lines[cursorLine] ?? "";
		const next = [...lines];
		next[cursorLine] = `${line.slice(0, cursorCol - prefix.length)}/${item.value} ${line.slice(cursorCol)}`;
		return { lines: next, cursorLine, cursorCol: item.value.length + 2 };
	}
}

class UnknownViewportTerminal extends VirtualTerminal {
	isNativeViewportAtBottom(): undefined {
		return undefined;
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(120);
	await term.flush();
}

describe("slash command autocomplete with unknown native viewport state", () => {
	it("keeps repainting the editor while the autocomplete list changes height", async () => {
		const originalPlatform = process.platform;
		const originalWtSession = Bun.env.WT_SESSION;
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		Bun.env.WT_SESSION = "wt-test";
		const term = new UnknownViewportTerminal(40, 8);
		const tui = new TUI(term);
		const root = new Container();
		root.addChild({ invalidate() {}, render: () => ["chat-0", "chat-1", "chat-2", "chat-3", "chat-4", "chat-5"] });
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(new SlashProvider());
		editor.onAutocompleteUpdate = () => tui.requestRender(false, { allowUnknownViewportMutation: true });
		root.addChild(editor);
		tui.addChild(root);
		tui.setFocus(editor);

		try {
			tui.start();
			await settle(term);
			for (const char of "/model") {
				term.sendInput(char);
				await settle(term);
				const viewport = term.getViewport().join("\n");
				expect(viewport).toContain(editor.getText());
			}
			expect(editor.getText()).toBe("/model");
		} finally {
			tui.stop();
			Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			if (originalWtSession === undefined) delete Bun.env.WT_SESSION;
			else Bun.env.WT_SESSION = originalWtSession;
		}
	});

	it("repaints autocomplete updates coalesced with offscreen background mutations", async () => {
		const originalPlatform = process.platform;
		const originalWtSession = Bun.env.WT_SESSION;
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		Bun.env.WT_SESSION = "wt-test";
		const term = new UnknownViewportTerminal(40, 6);
		const tui = new TUI(term);
		const root = new Container();
		let transcriptCounter = 0;
		const transcriptLines = () => Array.from({ length: 8 }, (_v, i) => `chat-${i}-${transcriptCounter}`);
		const transcript = { invalidate() {}, render: () => transcriptLines() };
		root.addChild(transcript);
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(new SlashProvider());
		editor.onAutocompleteUpdate = () => tui.requestRender(false, { allowUnknownViewportMutation: true });
		root.addChild(editor);
		tui.addChild(root);
		tui.setFocus(editor);

		try {
			tui.start();
			await settle(term);
			for (const char of "/mo") {
				// Bump a background row above the viewport in the same render tick as the
				// autocomplete prefix change. `diff.firstChanged` will point at the
				// background row, so the bypass MUST still kick in for the live UI rows.
				transcriptCounter += 1;
				term.sendInput(char);
				await settle(term);
				const viewport = term.getViewport().join("\n");
				expect(viewport).toContain(editor.getText());
			}
			expect(editor.getText()).toBe("/mo");
		} finally {
			tui.stop();
			Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			if (originalWtSession === undefined) delete Bun.env.WT_SESSION;
			else Bun.env.WT_SESSION = originalWtSession;
		}
	});
});
