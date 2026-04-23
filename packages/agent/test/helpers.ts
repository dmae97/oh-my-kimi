import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

/**
 * Pushes the canonical two-call stream script used across agent tests:
 *   - call 0: assistant emits a single `alpha` tool call with argument `{ value: "hello" }`
 *   - call 1+: assistant emits a plain text "done" response
 * Caller is responsible for incrementing its own `callIndex` counter after invoking.
 */
export function pushAlphaThenDoneEvent(
	stream: AssistantMessageEventStream,
	callIndex: number,
	createAssistantMessage: (
		content: AssistantMessage["content"],
		stopReason?: AssistantMessage["stopReason"],
	) => AssistantMessage,
): void {
	if (callIndex === 0) {
		const message = createAssistantMessage(
			[{ type: "toolCall", id: "tool-1", name: "alpha", arguments: { value: "hello" } }],
			"toolUse",
		);
		stream.push({ type: "done", reason: "toolUse", message });
	} else {
		const message = createAssistantMessage([{ type: "text", text: "done" }]);
		stream.push({ type: "done", reason: "stop", message });
	}
}

export function createUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}
