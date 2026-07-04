import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { assistantShouldRenderUsageRow } from "./transcript-render-helpers";

const billedUsage: Usage = {
	input: 321,
	output: 65,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 386,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface AssistantMessageOverrides {
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}

function assistantMessage(
	content: AssistantMessage["content"],
	overrides: AssistantMessageOverrides = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: billedUsage,
		stopReason: overrides.stopReason ?? "stop",
		errorMessage: overrides.errorMessage,
		timestamp: 1,
	};
}

describe("assistantShouldRenderUsageRow", () => {
	it("suppresses token usage rows for empty assistant text", () => {
		expect(assistantShouldRenderUsageRow(assistantMessage([{ type: "text", text: "" }]))).toBe(false);
		expect(assistantShouldRenderUsageRow(assistantMessage([{ type: "text", text: "   \n\t" }]))).toBe(false);
	});

	it("keeps token usage rows anchored to visible assistant text", () => {
		expect(assistantShouldRenderUsageRow(assistantMessage([{ type: "text", text: "Visible answer." }]))).toBe(true);
	});

	it("keeps token usage rows anchored to tool calls and terminal errors", () => {
		expect(
			assistantShouldRenderUsageRow(
				assistantMessage([{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } }]),
			),
		).toBe(true);
		expect(
			assistantShouldRenderUsageRow(
				assistantMessage([{ type: "text", text: "" }], { stopReason: "error", errorMessage: "provider failed" }),
			),
		).toBe(true);
	});
});
