import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

const originalImageProtocol = TERMINAL.imageProtocol;

const RENDER_WIDTH = 120;

function erroredMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

function renderLines(message: AssistantMessage, hideThinkingBlock = false): string[] {
	const component = new AssistantMessageComponent(message, hideThinkingBlock);
	return Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"))
		.split("\n")
		.map(line => line.trimEnd());
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	setTerminalImageProtocol(null);
});

afterEach(() => {
	resetSettingsForTest();
	setTerminalImageProtocol(originalImageProtocol);
});

describe("AssistantMessageComponent error rendering", () => {
	// A proxy 502 returns its own HTML page as the body; AnthropicApiError folds
	// that whole document into `errorMessage`. The inline transcript render must
	// not faithfully reprint every line, or the scrollback fills with the HTML
	// page's blank lines (the reported "weird terminal state").
	const longLine = "x".repeat(300);
	const body = Array.from({ length: 25 }, (_, i) => `marker-${i} <div>content</div>`).join("\n\n");
	const proxy502 = `${longLine}\n\n${body}`;

	it("drops the blank-line flood from a multi-line HTML error body", () => {
		const lines = renderLines(erroredMessage(proxy502));
		// The body interleaves 25 markers with blank lines (~50 source lines). If
		// blanks leaked through, the rendered block would be dozens of lines tall.
		const blankRun = lines.reduce(
			(acc, line) => {
				const run = line === "" ? acc.run + 1 : 0;
				return { run, max: Math.max(acc.max, run) };
			},
			{ run: 0, max: 0 },
		);
		expect(blankRun.max).toBeLessThanOrEqual(1);
		expect(lines.length).toBeLessThan(15);
	});

	it("clamps the line count of a runaway error body", () => {
		const lines = renderLines(erroredMessage(proxy502));
		const markerLines = lines.filter(line => line.includes("marker-"));
		// MAX_TRANSCRIPT_ERROR_LINES is 8; the first preview line is the long line,
		// so at most 7 markers survive — and the late ones are gone entirely.
		expect(markerLines.length).toBeLessThanOrEqual(8);
		expect(lines.some(line => line.includes("marker-0"))).toBe(true);
		expect(lines.some(line => line.includes("marker-24"))).toBe(false);
	});

	it("width-truncates an overlong error line", () => {
		const lines = renderLines(erroredMessage(proxy502));
		const head = lines.find(line => line.trim().startsWith("Error:"));
		expect(head).toBeDefined();
		// 300 'x' chars must not survive the render width; the line is truncated
		// with an ellipsis well under the 120-col terminal width.
		expect(head?.includes("…")).toBe(true);
		expect(head?.length).toBeLessThan(RENDER_WIDTH);
	});

	it("renders a short single-line error unchanged", () => {
		const lines = renderLines(erroredMessage("overloaded_error: Overloaded"));
		expect(lines.some(line => line.includes("Error: overloaded_error: Overloaded"))).toBe(true);
	});
});

describe("AssistantMessageComponent hidden thinking rendering", () => {
	function thinkingMessage(): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "Visible answer" },
			],
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

	it("omits hidden thinking instead of rendering a placeholder", () => {
		const lines = renderLines(thinkingMessage(), true);
		expect(lines.some(line => line.includes("Thinking..."))).toBe(false);
		expect(lines.some(line => line.includes("private reasoning"))).toBe(false);
		expect(lines.some(line => line.includes("Visible answer"))).toBe(true);
	});

	it("still renders thinking when it is not hidden", () => {
		const lines = renderLines(thinkingMessage());
		expect(lines.some(line => line.includes("private reasoning"))).toBe(true);
	});
});
