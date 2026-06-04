import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Message } from "@oh-my-pi/pi-ai";
import { inferCopilotInitiator } from "@oh-my-pi/pi-ai/providers/github-copilot-headers";
import { convertToLlm, wrapSteeringForModel } from "@oh-my-pi/pi-coding-agent/session/messages";

function expectAttribution(message: Message | undefined, expected: "user" | "agent" | undefined): void {
	expect(message).toBeDefined();
	if (!message) return;
	if (message.role === "assistant") {
		throw new Error("Assistant messages do not expose attribution");
	}
	expect(message.attribution).toBe(expected);
}

describe("convertToLlm custom message mapping", () => {
	it("uses async-result attribution without special role mapping", () => {
		const messages: AgentMessage[] = [
			{
				role: "custom",
				customType: "async-result",
				content: "Background task completed",
				display: true,
				attribution: "agent",
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("user");
		expectAttribution(converted[0], "agent");
		expect(inferCopilotInitiator(converted)).toBe("agent");
	});

	it("preserves missing attribution for legacy custom messages", () => {
		const messages: AgentMessage[] = [
			{
				role: "custom",
				customType: "skill-prompt",
				content: "Run this skill with my arguments",
				display: true,
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("user");
		expectAttribution(converted[0], undefined);
		expect(inferCopilotInitiator(converted)).toBe("user");
	});

	it("uses explicit agent attribution for custom messages", () => {
		const messages: AgentMessage[] = [
			{
				role: "custom",
				customType: "ttsr-injection",
				content: "<system-reminder>Read file</system-reminder>",
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("user");
		expectAttribution(converted[0], "agent");
		expect(inferCopilotInitiator(converted)).toBe("agent");
	});

	it("allows custom messages to opt into user attribution", () => {
		const messages: AgentMessage[] = [
			{
				role: "custom",
				customType: "skill-prompt",
				content: "Run this skill with my arguments",
				display: true,
				attribution: "user",
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("user");
		expectAttribution(converted[0], "user");
		expect(inferCopilotInitiator(converted)).toBe("user");
	});
});

function getUserText(message: AgentMessage | undefined): string {
	expect(message).toBeDefined();
	if (message?.role !== "user") {
		throw new Error("Expected user message");
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	const text = message.content.find(content => content.type === "text");
	if (!text) {
		throw new Error("Expected text content");
	}
	return text.text;
}

describe("wrapSteeringForModel", () => {
	it("wraps trailing steering text for the model without escaping user code", () => {
		const rawText = "Use <tag> & keep it literal";
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: rawText }],
			steering: true,
			timestamp: 1,
		};
		const messages = [message];

		const wrapped = wrapSteeringForModel(messages);

		expect(wrapped).not.toBe(messages);
		expect(wrapped[0]).not.toBe(message);
		expect(message.content).toEqual([{ type: "text", text: rawText }]);
		const wrappedText = getUserText(wrapped[0]);
		expect(wrappedText).toContain("<user_interjection>");
		expect(wrappedText).toContain("<message>\nUse <tag> & keep it literal\n</message>");
		expect(wrappedText).not.toContain("&lt;tag&gt;");
		expect(wrappedText).not.toContain("&amp;");
	});

	it("leaves buried steering messages unchanged", () => {
		const buried: AgentMessage = {
			role: "user",
			content: "old steer",
			steering: true,
			timestamp: 1,
		};
		const later: AgentMessage = { role: "user", content: "later", timestamp: 2 };
		const messages = [buried, later];

		const wrapped = wrapSteeringForModel(messages);

		expect(wrapped).toBe(messages);
		expect(wrapped[0]).toBe(buried);
	});

	it("leaves trailing user messages without the steering marker unchanged", () => {
		const message: AgentMessage = { role: "user", content: "plain user", timestamp: 1 };
		const messages = [message];

		const wrapped = wrapSteeringForModel(messages);

		expect(wrapped).toBe(messages);
		expect(wrapped[0]).toBe(message);
	});

	it("preserves images after the wrapped steering text", () => {
		const image: ImageContent = { type: "image", data: "abc123", mimeType: "image/png" };
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "look at this" }, image],
			steering: true,
			timestamp: 1,
		};

		const wrapped = wrapSteeringForModel([message]);

		const wrappedMessage = wrapped[0];
		if (wrappedMessage?.role !== "user" || typeof wrappedMessage.content === "string") {
			throw new Error("Expected user array content");
		}
		expect(wrappedMessage.content[0]?.type).toBe("text");
		expect(wrappedMessage.content[1]).toBe(image);
	});

	it("wraps every message in the trailing steering run", () => {
		const first: AgentMessage = { role: "user", content: "first steer", steering: true, timestamp: 1 };
		const second: AgentMessage = { role: "user", content: "second steer", steering: true, timestamp: 2 };
		const messages = [first, second];

		const wrapped = wrapSteeringForModel(messages);

		expect(wrapped).not.toBe(messages);
		expect(wrapped[0]).not.toBe(first);
		expect(wrapped[1]).not.toBe(second);
		expect(getUserText(wrapped[0])).toContain("<message>\nfirst steer\n</message>");
		expect(getUserText(wrapped[1])).toContain("<message>\nsecond steer\n</message>");
	});
});
