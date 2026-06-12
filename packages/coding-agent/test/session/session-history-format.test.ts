/**
 * Contracts: history:// transcript serializer (rework-contracts.md §5).
 *
 * - `## user` / `## assistant` headers carry full text.
 * - Thinking blocks are elided entirely.
 * - Each toolCall collapses with its toolResult into ONE `→ name(…) ⇒ …`
 *   line (ok and error variants); result bodies are never dumped.
 * - Custom messages render as one-liners (`[irc] from → me: …`).
 * - No system prompt / tool catalog sections.
 */
import { describe, expect, it } from "bun:test";
import { formatSessionHistoryMarkdown } from "@oh-my-pi/pi-coding-agent/session/session-history-format";

function buildMessages(): unknown[] {
	return [
		{ role: "user", content: "Please read the config.", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "SECRET-THOUGHT about the approach" },
				{ type: "text", text: "Reading it now." },
				{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "src/config.ts" } },
				{ type: "toolCall", id: "tc-2", name: "bash", arguments: { command: "bun test" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {},
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "const a = 1;\nconst b = 2;\nconst c = 3;" }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: "tc-2",
			toolName: "bash",
			content: [{ type: "text", text: "FAIL: 1 test failed" }],
			isError: true,
			timestamp: 4,
		},
		{
			role: "custom",
			customType: "irc:incoming",
			content: "full rendered irc prompt that must not appear",
			details: { from: "Main", message: "status update please" },
			timestamp: 5,
		},
	];
}

describe("formatSessionHistoryMarkdown", () => {
	it("renders role headers, collapses tool pairs to one line, and elides thinking", () => {
		const output = formatSessionHistoryMarkdown(buildMessages());

		expect(output).toContain("## user");
		expect(output).toContain("Please read the config.");
		expect(output).toContain("## assistant");
		expect(output).toContain("Reading it now.");

		// Thinking is elided entirely.
		expect(output).not.toContain("SECRET-THOUGHT");

		// Tool call + result collapse to one line each; bodies are not dumped.
		expect(output).toContain("→ read(src/config.ts) ⇒ ok · 3 lines");
		expect(output).not.toContain("const a = 1;");

		// Error variant carries the first line of the error output.
		expect(output).toContain("→ bash(bun test) ⇒ error · 1 line — FAIL: 1 test failed");

		// Consumed toolResults do not render a second orphan line.
		const toolLines = output.split("\n").filter(line => line.startsWith("→ "));
		expect(toolLines).toHaveLength(2);

		// Custom messages are one-liners; the rendered prompt body is dropped.
		expect(output).toContain("[irc] Main → me: status update please");
		expect(output).not.toContain("full rendered irc prompt");

		// Concise transcript: no prompt/tool-catalog sections.
		expect(output).not.toContain("System Prompt");
		expect(output).not.toContain("Available Tools");
	});

	it("prefixes an H1 title when requested", () => {
		const output = formatSessionHistoryMarkdown(buildMessages(), { title: "Spawnling (idle)" });
		expect(output.startsWith("# Spawnling (idle)\n")).toBe(true);
	});

	it("renders an orphan toolResult (truncated history) as its own line", () => {
		const output = formatSessionHistoryMarkdown([
			{
				role: "toolResult",
				toolCallId: "tc-orphan",
				toolName: "search",
				content: [{ type: "text", text: "one match" }],
				isError: false,
				timestamp: 1,
			},
		]);
		expect(output).toContain("→ search() ⇒ ok · 1 line");
	});
});
