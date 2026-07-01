import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ToolCallLoopGuard } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("ToolCallLoopGuard", () => {
	test("detects the fifth consecutive identical tool call", () => {
		const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: ["job", "irc"] });
		let detection = null;
		for (let index = 0; index < 5; index++) {
			const toolCallId = `call-${index}`;
			detection = guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "pytest -q", timeout: 120 } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId,
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			});
		}

		expect(detection).toEqual({
			kind: "repeated_tool_call",
			toolName: "bash",
			count: 5,
			resultSummary: "1263 passed, 4 skipped",
			argumentsSummary: '{"command":"pytest -q","timeout":120}',
		});
	});

	test("canonicalizes argument key order and ignores harness intent fields", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: [] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "first", name: "read", arguments: { path: "a.ts", [INTENT_FIELD]: "first" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "second",
							name: "read",
							arguments: { [INTENT_FIELD]: "second", path: "a.ts" },
						},
					],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toMatchObject({ toolName: "read", count: 2 });
	});

	test("resets the consecutive count on a different call", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "first", name: "bash", arguments: { command: "pytest -q" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "second", name: "read", arguments: { path: "src/index.ts" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "read",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "third", name: "bash", arguments: { command: "pytest -q" } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "third",
						toolName: "bash",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});

	test("ignores exempt polling tools", () => {
		const guard = new ToolCallLoopGuard({ threshold: 2, exemptTools: ["job"] });
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "first", name: "job", arguments: { poll: ["abc"] } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "first",
						toolName: "job",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
		expect(
			guard.recordTurn({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "second", name: "job", arguments: { poll: ["abc"] } }],
					api: "openai-responses",
					provider: "openai",
					model: "test-model",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "second",
						toolName: "job",
						content: [{ type: "text", text: "1263 passed, 4 skipped" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			}),
		).toBeNull();
	});
});
