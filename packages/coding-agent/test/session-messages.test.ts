import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@oh-my-pi/pi-ai";
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

describe("convertToLlm compaction summary", () => {
	it("appends snapcompact frames as image blocks after the summary text", () => {
		// Regression: the live session uses THIS converter (not agent-core's
		// defaultConvertToLlm). Dropping the frames here silently severs the
		// archive from the provider request — the model sees a summary that
		// references attached frames that never arrive.
		const images: ImageContent[] = [
			{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
			{ type: "image", data: "ZmFrZTI=", mimeType: "image/png" },
		];
		const messages: AgentMessage[] = [
			{
				role: "compactionSummary",
				summary: "the film archive",
				tokensBefore: 1000,
				images,
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("user");
		const content = converted[0]?.content as Array<TextContent | ImageContent>;
		expect(content).toHaveLength(3);
		expect(content[0].type).toBe("text");
		expect((content[0] as TextContent).text).toContain("the film archive");
		expect(content[1]).toEqual(images[0]);
		expect(content[2]).toEqual(images[1]);
	});

	it("emits text-only content when no frames are archived", () => {
		const messages: AgentMessage[] = [
			{ role: "compactionSummary", summary: "plain summary", tokensBefore: 1000, timestamp: Date.now() },
		];
		const converted = convertToLlm(messages);
		expect((converted[0]?.content as unknown[]).length).toBe(1);
	});
});

describe("convertToLlm custom message mapping", () => {
	it("maps custom messages to developer role with explicit agent attribution", () => {
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
		expect(converted[0]?.role).toBe("developer");
		expectAttribution(converted[0], "agent");
		expect(inferCopilotInitiator(converted)).toBe("agent");
	});

	it("maps legacy custom messages to developer role", () => {
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
		expect(converted[0]?.role).toBe("developer");
		expectAttribution(converted[0], undefined);
		expect(inferCopilotInitiator(converted)).toBe("agent");
	});

	it("uses explicit agent attribution for custom messages", () => {
		const messages: AgentMessage[] = [
			{
				role: "custom",
				customType: "agent-reminder",
				content: "Read file",
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("developer");
		expectAttribution(converted[0], "agent");
		expect(inferCopilotInitiator(converted)).toBe("agent");
	});

	it("maps file mention reminders to developer role", () => {
		const messages: AgentMessage[] = [
			{
				role: "fileMention",
				files: [{ path: "src/config.ts", content: "export const config = {};" }],
				timestamp: Date.now(),
			},
		];

		const converted = convertToLlm(messages);

		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("developer");
		expectAttribution(converted[0], "user");
		if (converted[0]?.role !== "developer" || !Array.isArray(converted[0].content)) {
			throw new Error("Expected developer array content");
		}
		const text = converted[0].content.find(content => content.type === "text")?.text ?? "";
		expect(text).toContain('<file path="src/config.ts">');
		expect(text).toContain("export const config = {};");
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
		expect(converted[0]?.role).toBe("developer");
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

	it("wraps buried steering messages too so wire bytes stay stable across turns", () => {
		const buried: AgentMessage = {
			role: "user",
			content: "old steer",
			steering: true,
			timestamp: 1,
		};
		const later: AgentMessage = { role: "user", content: "later", timestamp: 2 };
		const messages = [buried, later];

		const wrapped = wrapSteeringForModel(messages);

		// Buried steer is rewritten (enveloped) just like a trailing one, so its wire
		// bytes are identical whether it is the tail (turn N) or buried (turn N+1) —
		// the cached prefix stays valid instead of busting on the turn after a steer.
		expect(wrapped).not.toBe(messages);
		expect(wrapped[0]).not.toBe(buried);
		expect(getUserText(wrapped[0])).toContain("<user_interjection>");
		expect(getUserText(wrapped[0])).toContain("<message>\nold steer\n</message>");
		// Non-steering trailing message is untouched, and the persisted steer is not mutated.
		expect(wrapped[1]).toBe(later);
		expect(buried.content).toBe("old steer");
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
