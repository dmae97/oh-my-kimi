import type { AssistantMessage, ToolResultMessage, UserMessage } from "omk-ai";
import { describe, expect, it } from "vitest";
import { repairTranscriptIntegrity, TranscriptIntegrityError } from "../src/index.ts";
import type { AgentMessage } from "../src/types.ts";

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function assistant(calls: Array<{ id: string; name: string }> = []): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} })),
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function result(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "echo",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 1,
	};
}

describe("repairTranscriptIntegrity", () => {
	it("appends synthetic results for unambiguous missing tail calls", () => {
		const messages: AgentMessage[] = [
			user("hi"),
			assistant([
				{ id: "a", name: "echo" },
				{ id: "b", name: "echo" },
			]),
			result("a"),
		];
		const repaired = repairTranscriptIntegrity(messages);
		expect(repaired.length).toBe(messages.length + 1);
		const appended = repaired[repaired.length - 1] as ToolResultMessage;
		expect(appended.role).toBe("toolResult");
		expect(appended.toolCallId).toBe("b");
		expect(appended.isError).toBe(true);
		expect(appended.content).toEqual([
			{ type: "text", text: "Tool result missing; synthesized by transcript repair" },
		]);
	});

	it("preserves source order when synthesizing multiple missing results", () => {
		const messages: AgentMessage[] = [
			assistant([
				{ id: "a", name: "echo" },
				{ id: "b", name: "echo" },
				{ id: "c", name: "echo" },
			]),
		];
		const repaired = repairTranscriptIntegrity(messages);
		const ids = repaired.slice(-3).map((message) => (message as ToolResultMessage).toolCallId);
		expect(ids).toEqual(["a", "b", "c"]);
	});

	it("preserves existing partial results in order", () => {
		const messages: AgentMessage[] = [
			assistant([
				{ id: "a", name: "echo" },
				{ id: "b", name: "echo" },
			]),
			result("a"),
		];
		const repaired = repairTranscriptIntegrity(messages);
		const ids = repaired.slice(-2).map((message) => (message as ToolResultMessage).toolCallId);
		expect(ids).toEqual(["a", "b"]);
	});

	it("is idempotent", () => {
		const messages: AgentMessage[] = [assistant([{ id: "a", name: "echo" }])];
		const once = repairTranscriptIntegrity(messages);
		const twice = repairTranscriptIntegrity(once);
		expect(twice.length).toBe(once.length);
		expect(twice).toEqual(once);
	});

	it("returns a copy when there is nothing to repair", () => {
		const messages: AgentMessage[] = [assistant([{ id: "a", name: "echo" }]), result("a")];
		const repaired = repairTranscriptIntegrity(messages);
		expect(repaired).not.toBe(messages);
		expect(repaired).toEqual(messages);
	});

	it("uses a custom reason when provided", () => {
		const messages: AgentMessage[] = [assistant([{ id: "a", name: "echo" }])];
		const repaired = repairTranscriptIntegrity(messages, "aborted!");
		expect((repaired[repaired.length - 1] as ToolResultMessage).content).toEqual([
			{ type: "text", text: "aborted!" },
		]);
	});

	it("fails closed for duplicate results", () => {
		const messages: AgentMessage[] = [assistant([{ id: "a", name: "echo" }]), result("a"), result("a")];
		expect(() => repairTranscriptIntegrity(messages)).toThrow(TranscriptIntegrityError);
	});

	it("fails closed for orphan results", () => {
		const messages: AgentMessage[] = [user("hi"), result("ghost")];
		expect(() => repairTranscriptIntegrity(messages)).toThrow(TranscriptIntegrityError);
	});

	it("fails closed for duplicate call ids", () => {
		const messages: AgentMessage[] = [
			assistant([{ id: "a", name: "echo" }]),
			result("a"),
			assistant([{ id: "a", name: "echo" }]),
			result("a"),
		];
		expect(() => repairTranscriptIntegrity(messages)).toThrow(TranscriptIntegrityError);
	});

	it("fails closed for interleaved non-results", () => {
		const messages: AgentMessage[] = [assistant([{ id: "a", name: "echo" }]), user("interrupt"), result("a")];
		expect(() => repairTranscriptIntegrity(messages)).toThrow(TranscriptIntegrityError);
	});

	it("fails closed for a mid-transcript missing result", () => {
		const messages: AgentMessage[] = [
			assistant([
				{ id: "a", name: "echo" },
				{ id: "b", name: "echo" },
			]),
			result("b"),
			assistant([{ id: "c", name: "echo" }]),
			result("c"),
		];
		expect(() => repairTranscriptIntegrity(messages)).toThrow(TranscriptIntegrityError);
	});

	it("attaches the integrity report to the thrown error", () => {
		const messages: AgentMessage[] = [user("hi"), result("ghost")];
		try {
			repairTranscriptIntegrity(messages);
			throw new Error("should have thrown");
		} catch (error) {
			if (!(error instanceof TranscriptIntegrityError)) throw error;
			expect(error.report.ok).toBe(false);
		}
	});

	it("attaches a frozen envelope and stays idempotent", () => {
		const repaired = repairTranscriptIntegrity(
			[
				assistant([
					{ id: "a", name: "echo" },
					{ id: "b", name: "echo" },
				]),
				result("a"),
			],
			"Tool result missing; run interrupted",
		);
		const synthetic = repaired[2] as ToolResultMessage;
		expect(synthetic).toMatchObject({
			toolCallId: "b",
			details: {
				omk: {
					schema: "tool-result/v2",
					synthetic: true,
					disposition: "aborted",
					executionStarted: false,
				},
			},
		});
		expect(Object.isFrozen(synthetic)).toBe(true);
		expect(repairTranscriptIntegrity(repaired)).toEqual(repaired);
	});
});
