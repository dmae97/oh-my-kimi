import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionMessageEntry } from "@oh-my-pi/pi-agent-core/compaction";
import {
	applyShakeRegion,
	collectShakeRegions,
	DEFAULT_PRUNE_CONFIG,
	estimateTokens,
	invalidateMessageCache,
	isEstimateCacheable,
	pruneToolOutputs,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";

let idCounter = 0;
function nextId(): string {
	return `mc-${idCounter++}`;
}

function messageEntry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: nextId(), parentId: null, timestamp: new Date().toISOString(), message };
}

function usage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function settledAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "bench",
		usage: usage(120),
		stopReason: "stop",
		timestamp: 1,
	};
}

function toolResult(text: string, extra?: Partial<ToolResultMessage>): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${idCounter++}`,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
		...extra,
	};
}

describe("estimate cache settle gate", () => {
	test("caches settled assistants (terminal stopReason + real usage)", () => {
		expect(isEstimateCacheable(settledAssistant("done"))).toBe(true);
	});

	test("bypasses a streaming assistant (zero usage seed)", () => {
		const streaming: AssistantMessage = { ...settledAssistant("partial"), usage: usage(0), stopReason: "stop" };
		expect(isEstimateCacheable(streaming)).toBe(false);
	});

	test("bypasses aborted and error assistants even with usage", () => {
		expect(isEstimateCacheable({ ...settledAssistant("x"), stopReason: "aborted" })).toBe(false);
		expect(isEstimateCacheable({ ...settledAssistant("x"), stopReason: "error" })).toBe(false);
	});

	test("caches non-assistant roles unconditionally", () => {
		expect(isEstimateCacheable(toolResult("out") as AgentMessage)).toBe(true);
		expect(isEstimateCacheable({ role: "user", content: "hi", timestamp: 1 } as AgentMessage)).toBe(true);
	});

	test("a streaming assistant re-estimates as its content grows", () => {
		const streaming: AssistantMessage = {
			...settledAssistant("first chunk"),
			usage: usage(0),
			stopReason: "stop",
		};
		const before = estimateTokens(streaming as AgentMessage);
		streaming.content = [{ type: "text", text: "first chunk plus a much longer continuation of streamed text" }];
		const after = estimateTokens(streaming as AgentMessage);
		// Unsettled assistants never read the cache, so the grown content is recounted.
		expect(after).toBeGreaterThan(before);
	});
});

describe("estimate cache option split", () => {
	test("default and floored estimates do not collide in one map", () => {
		const blob = "blob ".repeat(4000);
		const msg: AssistantMessage = {
			...settledAssistant("thinking heavy"),
			content: [
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "reasoning", thinkingSignature: blob },
			],
		};
		// Prime the default map first, then the floored one; the floored estimate
		// (which drops the encrypted-reasoning blob) must not read the default entry.
		const withBlob = estimateTokens(msg as AgentMessage);
		const floored = estimateTokens(msg as AgentMessage, { excludeEncryptedReasoning: true });
		expect(withBlob).toBeGreaterThan(floored + 500);
		// Cached reads return the same split values.
		expect(estimateTokens(msg as AgentMessage)).toBe(withBlob);
		expect(estimateTokens(msg as AgentMessage, { excludeEncryptedReasoning: true })).toBe(floored);
	});
});

describe("estimate cache invalidation seams", () => {
	test("pruneToolOutputs drops the cached estimate of a pruned result", () => {
		const big = toolResult("x".repeat(20_000));
		const entries = [messageEntry(big as AgentMessage)];
		const before = estimateTokens(big as AgentMessage);
		expect(before).toBeGreaterThan(1000);

		const result = pruneToolOutputs(entries, { ...DEFAULT_PRUNE_CONFIG, protectTokens: 0, minimumSavings: 0 });
		expect(result.prunedCount).toBe(1);

		// After the in-place prune the estimate must reflect the short placeholder,
		// not the stale full-content count.
		const after = estimateTokens(big as AgentMessage);
		expect(after).toBeLessThan(before);
	});

	test("applyShakeRegion drops the cached estimate of a shaken result", () => {
		const big = toolResult(`\`\`\`ts\n${"const value = compute(a, b, c, d, e);\n".repeat(400)}\`\`\``);
		const entry = messageEntry(big as AgentMessage);
		const before = estimateTokens(big as AgentMessage);

		const regions = collectShakeRegions([entry], {
			protectTokens: 0,
			minSavings: 0,
			protectedTools: [],
			fenceMinTokens: 0,
		});
		expect(regions.length).toBeGreaterThan(0);
		applyShakeRegion(regions[0], "[shaken]");

		const after = estimateTokens(big as AgentMessage);
		expect(after).toBeLessThan(before);
	});

	test("explicit invalidateMessageCache forces a recount", () => {
		const result = toolResult("original content here");
		const before = estimateTokens(result as AgentMessage);
		// Mutate content directly (simulating an owner rewrite) then invalidate.
		result.content = [{ type: "text", text: "a much longer replacement body that should count higher than before" }];
		// Without invalidation the stale cached value would still be returned.
		expect(estimateTokens(result as AgentMessage)).toBe(before);
		invalidateMessageCache(result as AgentMessage);
		expect(estimateTokens(result as AgentMessage)).toBeGreaterThan(before);
	});
});
