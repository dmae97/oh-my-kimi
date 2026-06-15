import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	isUnexpectedStopCandidate,
	parseUnexpectedStopClassification,
} from "@oh-my-pi/pi-coding-agent/session/unexpected-stop-classifier";

function makeAssistantMessage(options: {
	stopReason: AssistantMessage["stopReason"];
	content: AssistantMessage["content"];
}): AssistantMessage {
	return {
		role: "assistant",
		provider: "mock",
		model: "mock/mock",
		api: "mock" as unknown as AssistantMessage["api"],
		content: options.content,
		stopReason: options.stopReason,
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

describe("isUnexpectedStopCandidate", () => {
	it("returns true for a text-only stop", () => {
		const message = makeAssistantMessage({
			stopReason: "stop",
			content: [{ type: "text", text: "I should do the same for the JS eval worker." }],
		});
		expect(isUnexpectedStopCandidate(message)).toBe(true);
	});

	it("returns false when stopReason is not stop", () => {
		const length = makeAssistantMessage({
			stopReason: "length",
			content: [{ type: "text", text: "I should continue." }],
		});
		expect(isUnexpectedStopCandidate(length)).toBe(false);

		const aborted = makeAssistantMessage({
			stopReason: "aborted",
			content: [{ type: "text", text: "I should continue." }],
		});
		expect(isUnexpectedStopCandidate(aborted)).toBe(false);
	});

	it("returns false when the message contains a toolCall", () => {
		const message = makeAssistantMessage({
			stopReason: "stop",
			content: [
				{ type: "text", text: "I will run the tests now." },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: {} },
			],
		});
		expect(isUnexpectedStopCandidate(message)).toBe(false);
	});

	it("returns false when the text is only whitespace", () => {
		const message = makeAssistantMessage({
			stopReason: "stop",
			content: [{ type: "text", text: "   \n\t  " }],
		});
		expect(isUnexpectedStopCandidate(message)).toBe(false);
	});

	it("returns false for an empty stop", () => {
		const message = makeAssistantMessage({
			stopReason: "stop",
			content: [],
		});
		expect(isUnexpectedStopCandidate(message)).toBe(false);
	});
});

describe("parseUnexpectedStopClassification", () => {
	it("returns true for YES output", () => {
		expect(parseUnexpectedStopClassification("YES")).toBe(true);
		expect(parseUnexpectedStopClassification("yes")).toBe(true);
		expect(parseUnexpectedStopClassification("  Yes, this is unexpected  ")).toBe(true);
	});

	it("returns false for NO output", () => {
		expect(parseUnexpectedStopClassification("NO")).toBe(false);
		expect(parseUnexpectedStopClassification("no")).toBe(false);
		expect(parseUnexpectedStopClassification("No, the task is complete.")).toBe(false);
	});

	it("returns undefined for unparseable output", () => {
		expect(parseUnexpectedStopClassification("maybe")).toBeUndefined();
		expect(parseUnexpectedStopClassification("")).toBeUndefined();
		expect(parseUnexpectedStopClassification("I don't know")).toBeUndefined();
	});
});
