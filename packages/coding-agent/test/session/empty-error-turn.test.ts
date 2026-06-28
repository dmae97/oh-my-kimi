import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isEmptyErrorTurn } from "@oh-my-pi/pi-coding-agent/session/messages";

type Turn = Pick<AssistantMessage, "stopReason" | "content">;

const turn = (stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"]): Turn => ({
	stopReason,
	content,
});

describe("isEmptyErrorTurn", () => {
	it("flags a content-less provider-rejection turn (the wedge poison that replays on reload)", () => {
		expect(isEmptyErrorTurn(turn("error", []))).toBe(true);
		expect(isEmptyErrorTurn(turn("error", [{ type: "text", text: "   " }]))).toBe(true);
	});

	it("keeps error turns that streamed real text or tool calls", () => {
		expect(isEmptyErrorTurn(turn("error", [{ type: "text", text: "partial answer" }]))).toBe(false);
		expect(isEmptyErrorTurn(turn("error", [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }]))).toBe(
			false,
		);
	});

	it("never flags non-error turns, even when empty — only the rejection turn is dropped", () => {
		expect(isEmptyErrorTurn(turn("stop", []))).toBe(false);
		expect(isEmptyErrorTurn(turn("aborted", []))).toBe(false);
	});
});
