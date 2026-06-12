import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AssistantThinkingRenderer } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { clearMermaidCache } from "@oh-my-pi/pi-coding-agent/modes/theme/mermaid-cache";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, Text } from "@oh-my-pi/pi-tui";

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

function renderAssistantMessage(markdown: string, renderers: readonly AssistantThinkingRenderer[] = []): string {
	const component = new AssistantMessageComponent(createAssistantMessage(markdown), false, undefined, renderers);
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

describe("AssistantMessageComponent thinking renderers", () => {
	it("renders all extension outputs below visible thinking blocks in registration order", () => {
		const contexts: Array<{ contentIndex: number; thinkingIndex: number; text: string }> = [];
		const component = new AssistantMessageComponent(
			{
				...createAssistantMessage(""),
				content: [{ type: "thinking", thinking: "I should inspect the input." }],
			},
			false,
			undefined,
			[
				context => {
					contexts.push({
						contentIndex: context.contentIndex,
						thinkingIndex: context.thinkingIndex,
						text: context.text,
					});
					return new Text("first note", 1, 0);
				},
				() => new Text("second note", 1, 0),
			],
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("I should inspect the input.");
		expect(rendered.indexOf("I should inspect the input.")).toBeLessThan(rendered.indexOf("first note"));
		expect(rendered.indexOf("first note")).toBeLessThan(rendered.indexOf("second note"));
		expect(contexts).toEqual([{ contentIndex: 0, thinkingIndex: 0, text: "I should inspect the input." }]);
	});

	it("keeps original thinking visible when an extension renderer throws", () => {
		const component = new AssistantMessageComponent(
			{
				...createAssistantMessage(""),
				content: [{ type: "thinking", thinking: "I should inspect the input." }],
			},
			false,
			undefined,
			[
				() => {
					throw new Error("renderer failed");
				},
			],
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("I should inspect the input.");
		expect(rendered).not.toContain("renderer failed");
	});

	it("keeps async renderer components mounted when they request a render", () => {
		let renderRequests = 0;
		let rendererCalls = 0;
		let mountedNote: Text | undefined;
		let requestRender: (() => void) | undefined;
		const component = new AssistantMessageComponent(
			{
				...createAssistantMessage(""),
				content: [{ type: "thinking", thinking: "I should inspect the input." }],
			},
			false,
			() => {
				renderRequests += 1;
			},
			[
				context => {
					rendererCalls += 1;
					requestRender = context.requestRender;
					const note = new Text("translation loading", 1, 0);
					mountedNote ??= note;
					return note;
				},
			],
		);

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("translation loading");
		mountedNote?.setText("translation ready");
		requestRender?.();

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(renderRequests).toBe(1);
		expect(rendererCalls).toBe(1);
		expect(rendered).toContain("translation ready");
		expect(rendered).not.toContain("translation loading");
	});

	it("does not invoke extension renderers when thinking is hidden", () => {
		let rendererCalled = false;
		const component = new AssistantMessageComponent(
			{
				...createAssistantMessage(""),
				content: [{ type: "thinking", thinking: "I should inspect the input." }],
			},
			true,
			undefined,
			[
				() => {
					rendererCalled = true;
					return new Text("hidden note", 1, 0);
				},
			],
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).not.toContain("Thinking...");
		expect(rendered).not.toContain("I should inspect the input.");
		expect(rendered).not.toContain("hidden note");
		expect(rendererCalled).toBe(false);
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
