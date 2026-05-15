import { describe, expect, test } from "bun:test";
import {
	AUTO_HANDOFF_THRESHOLD_FOCUS,
	createHandoffContext,
	createHandoffFileName,
	extractHandoffDocument,
	renderHandoffPrompt,
} from "@oh-my-pi/pi-agent-core/compaction/handoff";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

describe("handoff helpers", () => {
	test("renders custom focus into the handoff prompt", () => {
		const rendered = renderHandoffPrompt("preserve failing test name");
		expect(rendered).toContain("Write a handoff document");
		expect(rendered).toContain("Additional focus: preserve failing test name");
	});

	test("exports the threshold focus text used by auto-handoff", () => {
		expect(AUTO_HANDOFF_THRESHOLD_FOCUS).toBe(
			"Threshold-triggered maintenance: preserve critical implementation state and immediate next actions.",
		);
	});

	test("extracts the latest assistant text document", () => {
		const document = extractHandoffDocument([
			{ role: "user", content: "older", timestamp: 1 },
			assistantText("old handoff"),
			{ role: "user", content: "newer", timestamp: 2 },
			assistantText("new handoff"),
		]);
		expect(document).toBe("new handoff");
	});

	test("creates the persisted handoff context and filename", () => {
		expect(createHandoffContext("## Goal\nContinue")).toBe(
			"<handoff-context>\n## Goal\nContinue\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.",
		);
		expect(createHandoffFileName(new Date("2026-05-15T12:34:56.789Z"))).toBe("handoff-2026-05-15T12-34-56-789Z.md");
	});
});
