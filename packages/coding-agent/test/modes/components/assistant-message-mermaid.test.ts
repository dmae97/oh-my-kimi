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

	it("aligns box borders for CJK labels in display columns", () => {
		// Defends the first-party vendored Mermaid ASCII renderer's CJK/East-Asian
		// display-width handling (packages/utils/src/vendor/mermaid-ascii): Hangul is 2
		// terminal columns wide, so every row of a single-node diagram must
		// measure the same display width or the right border drifts.
		const rendered = renderAssistantMessage("```mermaid\nflowchart TD\n  A[수집 스케줄러]\n```");
		const displayCols = (line: string): number => {
			let width = 0;
			for (const ch of line) {
				const code = ch.codePointAt(0) ?? 0;
				const wide =
					(code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
					(code >= 0x2e80 && code <= 0x9fff) || // CJK radicals/ideographs
					(code >= 0xff00 && code <= 0xff60); // fullwidth forms
				width += wide ? 2 : 1;
			}
			return width;
		};
		const boxRows = rendered.split("\n").filter(line => /[┌│└]/.test(line));
		expect(boxRows.length).toBeGreaterThanOrEqual(3);
		expect(new Set(boxRows.map(displayCols)).size).toBe(1);
	});

	it("falls back to the fenced code block when Mermaid rendering fails", () => {
		const rendered = renderAssistantMessage("```mermaid\nthis is not mermaid\n```");

		expect(TERMINAL.imageProtocol).toBeNull();
		expect(rendered).toContain("```mermaid");
		expect(rendered).toContain("this is not mermaid");
	});
});

describe("AssistantMessageComponent reflowing-markdown commit stability", () => {
	// A streaming reply is built empty then fed via updateContent (the live path);
	// passing a message to the constructor would mark it finalized.
	it("is commit-unstable while a streaming reply still carries a mermaid fence", () => {
		const component = new AssistantMessageComponent();
		component.updateContent(createAssistantMessage("Here is the flow:\n\n```mermaid\nflowchart TD\n  A-->B"));
		expect(component.isTranscriptBlockCommitStable()).toBe(false);
	});

	it("becomes commit-stable once the mermaid reply finalizes", () => {
		const component = new AssistantMessageComponent();
		component.updateContent(createAssistantMessage("```mermaid\nflowchart TD\n  A-->B\n```"));
		expect(component.isTranscriptBlockCommitStable()).toBe(false);
		component.markTranscriptBlockFinalized();
		expect(component.isTranscriptBlockCommitStable()).toBe(true);
	});

	it("stays commit-stable for a streaming reply without a mermaid fence", () => {
		const component = new AssistantMessageComponent();
		component.updateContent(createAssistantMessage("A long normal reply.\n\n- one\n- two\n\nMore prose follows."));
		expect(component.isTranscriptBlockCommitStable()).toBe(true);
	});

	it("does not trip on prose that mentions a mermaid fence inline", () => {
		const component = new AssistantMessageComponent();
		component.updateContent(createAssistantMessage("Wrap the diagram in a ```mermaid block to render it."));
		expect(component.isTranscriptBlockCommitStable()).toBe(true);
	});

	it("is commit-unstable for intro prose followed by a streaming mermaid tail", () => {
		const component = new AssistantMessageComponent();
		component.updateContent(
			createAssistantMessage("Intro prose above the diagram.\n\n```mermaid\nflowchart TD\n  A-->B"),
		);
		expect(component.isTranscriptBlockCommitStable()).toBe(false);
	});

	it("is commit-unstable while a streaming reply still renders a GFM table", () => {
		const component = new AssistantMessageComponent();
		component.updateContent(createAssistantMessage("Results:\n\n| Name | Score |\n| --- | --- |\n| a | 1 |"));
		expect(component.isTranscriptBlockCommitStable()).toBe(false);
	});

	it("becomes commit-stable once a table reply finalizes", () => {
		const component = new AssistantMessageComponent();
		component.updateContent(createAssistantMessage("| Name | Score |\n| --- | --- |\n| a | 1 |\n| b | 2 |"));
		expect(component.isTranscriptBlockCommitStable()).toBe(false);
		component.markTranscriptBlockFinalized();
		expect(component.isTranscriptBlockCommitStable()).toBe(true);
	});

	it("stays commit-stable for pipe-heavy prose with no table delimiter row", () => {
		const component = new AssistantMessageComponent();
		component.updateContent(
			createAssistantMessage("Weigh cost | benefit | risk before deciding, and note `a || b` short-circuits."),
		);
		expect(component.isTranscriptBlockCommitStable()).toBe(true);
	});

	it("stays commit-stable for a streaming table header before its delimiter row arrives", () => {
		// Header alone is just a paragraph with pipes — Markdown lays out no table,
		// and nothing re-flows, until the delimiter row streams in.
		const component = new AssistantMessageComponent();
		component.updateContent(createAssistantMessage("| Name | Score |"));
		expect(component.isTranscriptBlockCommitStable()).toBe(true);
	});

	it("stays commit-stable for a fenced code block containing a table delimiter", () => {
		// A shell snippet with pipes and dashes inside a code fence is literal text,
		// not a reflowing table, so a long code-heavy reply still commits normally.
		const component = new AssistantMessageComponent();
		component.updateContent(createAssistantMessage("Run it:\n\n```sh\necho '| --- | --- |'\ncat data | sort\n```"));
		expect(component.isTranscriptBlockCommitStable()).toBe(true);
	});

	it("stays commit-stable for a mermaid fence shown as example content inside a code block", () => {
		const component = new AssistantMessageComponent();
		component.updateContent(
			createAssistantMessage("Example:\n\n````md\n```mermaid\nflowchart TD\n  A-->B\n```\n````"),
		);
		expect(component.isTranscriptBlockCommitStable()).toBe(true);
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
