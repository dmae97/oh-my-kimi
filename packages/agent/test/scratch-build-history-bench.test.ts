import { describe, expect, it } from "bun:test";
import type { Message, Model } from "@oh-my-pi/pi-ai/types";
import { buildOpenAiNativeHistory } from "../src/compaction/openai";

const model = {
	provider: "openai-codex",
	id: "gpt-5.5",
	api: "openai-responses",
	contextWindow: 524288,
	input: ["text"],
} as unknown as Model;

function makeCodexHistory(turns: number): Message[] {
	const messages: Message[] = [];
	for (let i = 0; i < turns; i++) {
		messages.push({
			role: "user",
			content: [{ type: "text", text: `user turn ${i}` }],
			timestamp: i,
		} as unknown as Message);
		messages.push({
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5.5",
			api: "openai-responses",
			content: [{ type: "text", text: `assistant turn ${i}` }],
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai-codex",
				dt: true,
				items: [
					{ type: "reasoning", id: `rs_${i}`, summary: [] },
					{
						type: "message",
						role: "assistant",
						id: `msg_${i}`,
						status: "completed",
						content: [{ type: "output_text", text: `assistant turn ${i}`, annotations: [] }],
					},
					{ type: "function_call", id: `fc_${i}`, call_id: `call_${i}`, name: "read", arguments: "{}" },
				],
			},
			timestamp: i,
		} as unknown as Message);
		messages.push({
			role: "toolResult",
			toolCallId: `call_${i}`,
			content: [{ type: "text", text: `result ${i}` }],
			timestamp: i,
		} as unknown as Message);
	}
	return messages;
}

describe("buildOpenAiNativeHistory perf", () => {
	it("times native history build for large codex contexts", () => {
		for (const turns of [500, 1000, 2000, 4000]) {
			const messages = makeCodexHistory(turns);
			const t0 = performance.now();
			const out = buildOpenAiNativeHistory(messages, model);
			const dt = performance.now() - t0;
			console.log(`turns=${turns} items=${out.length} ms=${dt.toFixed(1)}`);
			expect(out.length).toBeGreaterThan(0);
		}
	});
});
