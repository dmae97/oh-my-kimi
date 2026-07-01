import { describe, expect, test } from "bun:test";
import {
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	type SessionEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const MODEL: Model = buildModel({
	id: "mock-model",
	name: "mock-model",
	api: "mock",
	provider: "mock",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_768,
});

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("branch summarization", () => {
	test("includes informative tool results and drops useless ones", async () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: "Inspect the branch-only state.", timestamp: 0 },
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp: new Date(1).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "config.txt" } }],
					api: "mock",
					provider: "mock",
					model: "mock-model",
					usage: ZERO_USAGE,
					stopReason: "toolUse",
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "tool-1",
				parentId: "assistant-1",
				timestamp: new Date(2).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "call-read",
					toolName: "read",
					content: [{ type: "text", text: "BRANCH_ONLY_FACT_4076=enabled" }],
					isError: false,
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "assistant-2",
				parentId: "tool-1",
				timestamp: new Date(3).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-search", name: "search", arguments: { pattern: "absent" } }],
					api: "mock",
					provider: "mock",
					model: "mock-model",
					usage: ZERO_USAGE,
					stopReason: "toolUse",
					timestamp: 3,
				},
			},
			{
				type: "message",
				id: "tool-2",
				parentId: "assistant-2",
				timestamp: new Date(4).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "call-search",
					toolName: "search",
					content: [{ type: "text", text: "NO_MATCH_SENTINEL_4076" }],
					isError: false,
					useless: true,
					timestamp: 4,
				},
			},
		];
		let capturedPrompt = "";
		const completeImpl: GenerateBranchSummaryOptions["completeImpl"] = async (_model, ctx) => {
			const message = ctx.messages[0];
			if (message?.role !== "user") {
				throw new Error("branch summary request did not contain a user prompt");
			}
			if (typeof message.content === "string") {
				capturedPrompt = message.content;
			} else {
				for (const block of message.content) {
					if (block.type === "text") capturedPrompt += block.text;
				}
			}
			const response: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "branch summary text" }],
				api: "mock",
				provider: "mock",
				model: "mock-model",
				usage: ZERO_USAGE,
				stopReason: "stop",
				timestamp: 5,
			};
			return response;
		};

		await generateBranchSummary(entries, {
			model: MODEL,
			apiKey: "test-api-key",
			signal: new AbortController().signal,
			completeImpl,
		});

		expect(capturedPrompt).toContain("BRANCH_ONLY_FACT_4076=enabled");
		expect(capturedPrompt).not.toContain("NO_MATCH_SENTINEL_4076");
	});
});
