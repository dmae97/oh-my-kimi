import { describe, expect, it } from "bun:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { zSessionNotification } from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { mapAgentSessionEventToAcpSessionUpdates } from "../src/modes/acp/acp-event-mapper";
import type { AgentSessionEvent } from "../src/session/agent-session";
import { expectAcpStructure, expectAcpStructureRejects } from "./helpers/acp-schema";

function makeAssistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function getChunkMessageId(event: { update: object }): string | undefined {
	const update = event.update as { messageId?: string | null };
	return typeof update.messageId === "string" ? update.messageId : undefined;
}

function expectAcpNotifications(updates: SessionNotification[]): void {
	for (const update of updates) {
		expectAcpStructure(zSessionNotification, update);
	}
}

describe("ACP event mapper", () => {
	it("attaches a stable messageId to live assistant chunks", () => {
		const assistantMessage = makeAssistantMessage("chunk");
		const getMessageId = (message: unknown): string | undefined =>
			message === assistantMessage ? "a80f1ff7-4f0a-4e6b-9f09-c94857b62a4a" : undefined;

		const textUpdates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", delta: "chunk" },
			} as AgentSessionEvent,
			"session-1",
			{ getMessageId },
		);
		const thoughtUpdates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "thinking_delta", delta: "plan" },
			} as AgentSessionEvent,
			"session-1",
			{ getMessageId },
		);

		expect(textUpdates).toHaveLength(1);
		expect(thoughtUpdates).toHaveLength(1);
		expectAcpNotifications([...textUpdates, ...thoughtUpdates]);
		expect(textUpdates[0] ? getChunkMessageId(textUpdates[0]) : undefined).toBe(
			"a80f1ff7-4f0a-4e6b-9f09-c94857b62a4a",
		);
		expect(thoughtUpdates[0] ? getChunkMessageId(thoughtUpdates[0]) : undefined).toBe(
			"a80f1ff7-4f0a-4e6b-9f09-c94857b62a4a",
		);
	});

	it("emits final assistant text when no text deltas were observed", () => {
		const assistantMessage = makeAssistantMessage("final response");
		const progress = { textEmitted: false, thoughtEmitted: false };

		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_end",
				message: assistantMessage,
			} as AgentSessionEvent,
			"session-1",
			{ getMessageProgress: message => (message === assistantMessage ? progress : undefined) },
		);

		expect(updates).toEqual([
			{
				sessionId: "session-1",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "final response" },
					messageId: undefined,
				},
			},
		]);
		expectAcpNotifications(updates);
		expect(progress.textEmitted).toBe(true);
	});

	it("does not duplicate final assistant text after streaming deltas", () => {
		const assistantMessage = makeAssistantMessage("streamed response");
		const progress = { textEmitted: false, thoughtEmitted: false };
		const options = {
			getMessageProgress: (message: unknown) => (message === assistantMessage ? progress : undefined),
		};

		const deltaUpdates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", delta: "streamed response" },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const doneUpdates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_end",
				message: assistantMessage,
			} as AgentSessionEvent,
			"session-1",
			options,
		);

		expect(deltaUpdates).toHaveLength(1);
		expectAcpNotifications(deltaUpdates);
		expect(doneUpdates).toEqual([]);
	});

	it("emits a diff ToolCallContent for each per-file edit result", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-1",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "applied" }],
					details: {
						diff: "--- a/foo\n+++ b/foo\n",
						perFileResults: [
							{ path: "foo.ts", diff: "...", oldText: "before\n", newText: "after\n" },
							{ path: "bar.ts", diff: "...", oldText: undefined, newText: "created\n" },
							{ path: "skipped.ts", diff: "", isError: true, errorText: "boom" },
						],
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>;
			locations?: { path: string }[];
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		const diffBlocks = update.content?.filter(block => block.type === "diff") ?? [];
		expect(diffBlocks).toEqual([
			{ type: "diff", path: "foo.ts", oldText: "before\n", newText: "after\n" },
			{ type: "diff", path: "bar.ts", oldText: null, newText: "created\n" },
		]);
		expect(update.locations).toEqual([{ path: "foo.ts" }, { path: "bar.ts" }, { path: "skipped.ts" }]);
	});

	it("emits a diff ToolCallContent for single-file edit details", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-single",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "applied" }],
					details: {
						path: "single.ts",
						diff: "--- a/single.ts\n+++ b/single.ts\n",
						oldText: "before\n",
						newText: "after\n",
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>;
			locations?: { path: string }[];
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content?.filter(block => block.type === "diff")).toEqual([
			{ type: "diff", path: "single.ts", oldText: "before\n", newText: "after\n" },
		]);
		expect(update.locations).toEqual([{ path: "single.ts" }]);
	});

	it("emits locations on tool_execution_update from args", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-2",
				toolName: "edit",
				args: { path: "src/foo.ts" },
				partialResult: { content: [{ type: "text", text: "in progress" }] },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; locations?: { path: string }[] };
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.locations).toEqual([{ path: "src/foo.ts" }]);
	});

	it("emits a terminal ToolCallContent when tool details carry a terminalId", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-3",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: { content: [], details: { terminalId: "term-42" } },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; terminalId?: string }>;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toEqual([{ type: "terminal", terminalId: "term-42" }]);
	});
	it("emits distinct locations for move-style path arguments", () => {
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-move",
				toolName: "move",
				args: { path: "src/current.ts", oldPath: "src/old.ts", newPath: "src/new.ts" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; locations?: { path: string }[] };
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.locations).toEqual([{ path: "src/current.ts" }, { path: "src/old.ts" }, { path: "src/new.ts" }]);
	});

	it("rejects mutated ACP notification discriminators", () => {
		const [notification] = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-schema",
				toolName: "read",
				args: { path: "package.json" },
			} as AgentSessionEvent,
			"session-1",
		);

		expectAcpStructure(zSessionNotification, notification);
		expectAcpStructureRejects(zSessionNotification, {
			...notification,
			update: { ...notification!.update, sessionUpdate: "tool_call_updates" },
		});
		expectAcpStructureRejects(zSessionNotification, { ...notification, sessionId: 42 });
	});
});
