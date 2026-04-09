import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { clearMermaidCache } from "@oh-my-pi/pi-coding-agent/modes/theme/mermaid-cache";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

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
	_resetSettingsForTest();
	await Settings.init({ inMemory: true });
	clearMermaidCache();
	setTerminalImageProtocol(null);
});

afterEach(() => {
	_resetSettingsForTest();
	setTerminalImageProtocol(originalImageProtocol);
	clearMermaidCache();
});

describe("AssistantMessageComponent mermaid markdown", () => {
	it("renders fenced Mermaid ASCII without terminal image protocol", () => {
		const rendered = renderAssistantMessage("```mermaid\nflowchart TD\n  Start-->Stop\n```");

		expect(TERMINAL.imageProtocol).toBeNull();
		expect(rendered).toContain("Start");
		expect(rendered).toContain("Stop");
		expect(rendered).not.toContain("```mermaid");
		expect(rendered).not.toContain("flowchart TD");
	});

	it("falls back to the fenced code block when Mermaid source is invalid", () => {
		const rendered = renderAssistantMessage("```mermaid\nflowchart TD\n  A --\n```");

		expect(TERMINAL.imageProtocol).toBeNull();
		expect(rendered).toContain("```mermaid");
		expect(rendered).toContain("flowchart TD");
		expect(rendered).toContain("A --");
	});
});
