import { readFileSync } from "node:fs";
import type { AgentTool } from "omk-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "omk-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { inspectSessionIntegrity } from "../src/core/session-integrity.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function usage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("manual compaction during an active tool call", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("persists the abort-closed tool result before capturing the transcript", async () => {
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait until aborted",
			parameters: Type.Object({}),
			execute: async (_id, _params, signal) => {
				if (!signal) throw new Error("expected tool abort signal");
				const abortSignal = signal;
				await new Promise<void>((resolve) => {
					if (abortSignal.aborted) return resolve();
					abortSignal.addEventListener("abort", () => resolve(), { once: true });
				});
				return { content: [{ type: "text", text: "aborted" }], details: {} };
			},
		};
		harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
			tools: [waitTool],
		});
		const { session, sessionManager } = harness;
		for (let index = 0; index < 2; index += 1) {
			sessionManager.appendMessage({ role: "user", content: `user-${index}`, timestamp: index * 2 });
			sessionManager.appendMessage({
				...fauxAssistantMessage(`assistant-${index}`),
				usage: usage(100 + index),
				timestamp: index * 2 + 1,
			});
		}
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}, { id: "compact-wait" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("compacted summary"),
		]);

		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = session.subscribe((event) => {
				if (event.type !== "tool_execution_start") return;
				unsubscribe();
				resolve();
			});
		});
		const prompt = session.prompt("start");
		await toolStarted;

		const result = await session.compact();
		await prompt;

		expect(result.summary).toBe("compacted summary");
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const report = inspectSessionIntegrity(readFileSync(sessionFile));
		expect(report.findings.filter((finding) => finding.reason === "transcript_missing_result")).toEqual([]);
	});
});
