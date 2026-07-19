import type { AssistantMessage, ToolResultMessage, UserMessage } from "omk-ai";
import { describe, expect, it } from "vitest";
import { inspectTranscriptIntegrity, repairTranscriptIntegrity } from "../src/index.ts";
import type { AgentMessage } from "../src/types.ts";

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function assistant(calls: Array<{ id: string; name: string }> = [], text?: string): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (text) {
		content.push({ type: "text", text });
	}
	for (const call of calls) {
		content.push({ type: "toolCall", id: call.id, name: call.name, arguments: {} });
	}
	return {
		role: "assistant",
		content,
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
		stopReason: calls.length > 0 ? "toolUse" : "stop",
		timestamp: 1,
	};
}

function result(toolCallId: string, toolName = "echo"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 1,
	};
}

function kinds(report: { readonly issues: readonly { readonly kind: string }[] }): string[] {
	return report.issues.map((issue) => issue.kind);
}

describe("inspectTranscriptIntegrity", () => {
	it("accepts a clean transcript", () => {
		const messages: AgentMessage[] = [
			user("hi"),
			assistant([{ id: "a", name: "echo" }]),
			result("a"),
			assistant([], "done"),
		];
		const report = inspectTranscriptIntegrity(messages);
		expect(report.ok).toBe(true);
		expect(report.issues).toEqual([]);
	});

	it("accepts results in any order within a results region", () => {
		const messages: AgentMessage[] = [
			assistant([
				{ id: "a", name: "echo" },
				{ id: "b", name: "echo" },
			]),
			result("b"),
			result("a"),
		];
		expect(inspectTranscriptIntegrity(messages).ok).toBe(true);
	});

	it("accepts multiple sequential turns", () => {
		const messages: AgentMessage[] = [
			assistant([{ id: "a", name: "echo" }]),
			result("a"),
			assistant([{ id: "b", name: "echo" }]),
			result("b"),
		];
		expect(inspectTranscriptIntegrity(messages).ok).toBe(true);
	});

	it("does not mutate the input", () => {
		const messages: AgentMessage[] = [assistant([{ id: "a", name: "echo" }])];
		const snapshot = JSON.stringify(messages);
		inspectTranscriptIntegrity(messages);
		expect(JSON.stringify(messages)).toBe(snapshot);
	});

	it("accepts readonly messages through the source package API", () => {
		const messages: readonly AgentMessage[] = [assistant([{ id: "a", name: "echo" }])];
		expect(inspectTranscriptIntegrity(messages).ok).toBe(false);
		expect(repairTranscriptIntegrity(messages)).toHaveLength(2);
	});

	it("returns a deeply frozen report and issues", () => {
		const report = inspectTranscriptIntegrity([assistant([{ id: "a", name: "echo" }])]);
		expect(Object.isFrozen(report)).toBe(true);
		expect(Object.isFrozen(report.issues)).toBe(true);
		expect(Object.isFrozen(report.issues[0])).toBe(true);
		expect(() => (report.issues as unknown[]).push({ kind: "orphan_result", toolCallId: "b" })).toThrow(TypeError);
		expect(() => Object.assign(report.issues[0] as object, { toolCallId: "forged" })).toThrow(TypeError);
	});

	it("detects a missing result", () => {
		const messages: AgentMessage[] = [assistant([{ id: "a", name: "echo" }])];
		const report = inspectTranscriptIntegrity(messages);
		expect(report.ok).toBe(false);
		expect(kinds(report)).toContain("missing_result");
	});

	it("detects a missing result when only some calls resolve", () => {
		const messages: AgentMessage[] = [
			assistant([
				{ id: "a", name: "echo" },
				{ id: "b", name: "echo" },
			]),
			result("a"),
		];
		const report = inspectTranscriptIntegrity(messages);
		expect(kinds(report)).toContain("missing_result");
		expect(report.issues.find((i) => i.kind === "missing_result")?.toolCallId).toBe("b");
	});

	it("detects a duplicate result", () => {
		const messages: AgentMessage[] = [assistant([{ id: "a", name: "echo" }]), result("a"), result("a")];
		expect(kinds(inspectTranscriptIntegrity(messages))).toContain("duplicate_result");
	});

	it("detects an orphan result", () => {
		const messages: AgentMessage[] = [user("hi"), result("ghost")];
		expect(kinds(inspectTranscriptIntegrity(messages))).toContain("orphan_result");
	});

	it("detects a duplicate call id", () => {
		const messages: AgentMessage[] = [
			assistant([{ id: "a", name: "echo" }]),
			result("a"),
			assistant([{ id: "a", name: "echo" }]),
			result("a"),
		];
		expect(kinds(inspectTranscriptIntegrity(messages))).toContain("duplicate_call_id");
	});

	it("detects an interleaved non-result between calls and results", () => {
		const messages: AgentMessage[] = [assistant([{ id: "a", name: "echo" }]), user("interrupt"), result("a")];
		expect(kinds(inspectTranscriptIntegrity(messages))).toContain("interleaved_non_result");
	});

	it("detects an orphan result at the start (unknown id)", () => {
		const messages: AgentMessage[] = [result("ghost")];
		expect(kinds(inspectTranscriptIntegrity(messages))).toContain("orphan_result");
	});

	it("detects a result that arrives before its call", () => {
		const messages: AgentMessage[] = [result("a"), assistant([{ id: "a", name: "echo" }])];
		expect(kinds(inspectTranscriptIntegrity(messages))).toContain("interleaved_non_result");
	});

	it("detects a second assistant message before results resolve", () => {
		const messages: AgentMessage[] = [assistant([{ id: "a", name: "echo" }]), assistant([{ id: "b", name: "echo" }])];
		expect(kinds(inspectTranscriptIntegrity(messages))).toContain("interleaved_non_result");
	});

	it("detects an orphan result that appears after a user boundary", () => {
		const messages: AgentMessage[] = [assistant([{ id: "a", name: "echo" }]), result("a"), user("more"), result("a")];
		expect(kinds(inspectTranscriptIntegrity(messages))).toContain("interleaved_non_result");
	});
});
