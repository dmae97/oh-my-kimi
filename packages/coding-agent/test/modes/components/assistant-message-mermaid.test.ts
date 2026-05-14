import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { clearMermaidCache } from "@oh-my-pi/pi-coding-agent/modes/theme/mermaid-cache";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

const originalImageProtocol = TERMINAL.imageProtocol;

function createAssistantMessage(markdown: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: markdown }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
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

function renderAssistantMessage(markdown: string): string {
	const component = new AssistantMessageComponent(createAssistantMessage(markdown));
	return Bun.stripANSI(component.render(120).join("\n"))
		.split("\n")
		.map(line => line.trimEnd())
		.join("\n");
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	clearMermaidCache();
	setTerminalImageProtocol(null);
});

afterEach(() => {
	resetSettingsForTest();
	setTerminalImageProtocol(originalImageProtocol);
	clearMermaidCache();
});

describe("AssistantMessageComponent mermaid markdown", () => {
	it("renders fenced Mermaid ASCII without terminal image protocol", () => {
		const rendered = renderAssistantMessage("```mermaid\nflowchart TD\n  Start-->Stop\n```");

		expect(TERMINAL.imageProtocol).toBeNull();
		expect(rendered).toContain("Start");
		expect(rendered).toContain("Start--");
		expect(rendered).not.toContain("```mermaid");
		expect(rendered).not.toContain("flowchart TD");
	});

	it("falls back to the fenced code block when Mermaid rendering fails", () => {
		const rendered = renderAssistantMessage("```mermaid\nthis is not mermaid\n```");

		expect(TERMINAL.imageProtocol).toBeNull();
		expect(rendered).toContain("```mermaid");
		expect(rendered).toContain("this is not mermaid");
	});
});

describe("AssistantMessageComponent tool images", () => {
	it("converts WebP tool images for Kitty terminal rendering", async () => {
		const webpBase64 = Buffer.from(
			await Bun.file(path.join(import.meta.dir, "../../../../../assets/python.webp")).arrayBuffer(),
		).toBase64();
		setTerminalImageProtocol(ImageProtocol.Kitty);

		const converted = Promise.withResolvers<void>();
		const component = new AssistantMessageComponent(createAssistantMessage("done"), false, () => converted.resolve());
		component.setToolResultImages("read-1", [{ type: "image", data: webpBase64, mimeType: "image/webp" }]);

		await converted.promise;
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("\x1b_G");
		expect(rendered).not.toContain("[Image: image/webp]");
	});
});
