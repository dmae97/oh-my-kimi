import { type FauxProviderRegistration, fauxAssistantMessage, type RetryCallbacks, registerFauxProvider } from "omk-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { generateSummary } from "../../src/harness/compaction/compaction.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentMessage } from "../../src/types.ts";

const registrations: FauxProviderRegistration[] = [];

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function retryTrace(): { readonly events: string[]; readonly callbacks: RetryCallbacks } {
	const events: string[] = [];
	return {
		events,
		callbacks: {
			onRetryScheduled: (attempt) => {
				events.push(`scheduled:${attempt}`);
			},
			onRetryAttemptStart: () => {
				events.push("started");
			},
			onRetryFinished: (success, attempt) => {
				events.push(`finished:${success}:${attempt}`);
			},
		},
	};
}

afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

describe("AgentHarness summarization retry", () => {
	it("retries a transient compaction summary failure", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let calls = 0;
		registration.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
			},
			() => {
				calls++;
				return fauxAssistantMessage("Recovered summary");
			},
		]);
		const trace = retryTrace();

		const result = await generateSummary(
			[userMessage("history")],
			registration.getModel(),
			16_384,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
			{ retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 }, callbacks: trace.callbacks },
		);

		expect(result).toMatchObject({ ok: true, value: "Recovered summary" });
		expect(calls).toBe(2);
		expect(trace.events).toEqual(["scheduled:1", "started", "finished:true:1"]);
	});

	it("does not retry a quota-exhaustion compaction failure", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let calls = 0;
		registration.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" });
			},
		]);
		const trace = retryTrace();

		const result = await generateSummary(
			[userMessage("history")],
			registration.getModel(),
			16_384,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
			{ retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 }, callbacks: trace.callbacks },
		);

		expect(result).toMatchObject({ ok: false });
		expect(calls).toBe(1);
		expect(trace.events).toEqual([]);
	});

	it("retries branch summarization and emits typed harness events", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let calls = 0;
		registration.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
			},
			() => {
				calls++;
				return fauxAssistantMessage("Recovered branch summary");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		const targetId = await session.appendMessage(userMessage("first branch"));
		await session.appendMessage(fauxAssistantMessage("first reply"));
		await session.appendMessage(userMessage("abandoned work"));
		await session.appendMessage(fauxAssistantMessage("abandoned reply"));
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
			streamOptions: { summarizationRetry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } },
		});
		const events: string[] = [];
		harness.subscribe((event) => {
			if (
				event.type === "retry_scheduled" ||
				event.type === "retry_attempt_start" ||
				event.type === "retry_finished"
			) {
				events.push(`${event.type}:${event.operation}`);
			}
		});

		const result = await harness.navigateTree(targetId, { summarize: true });

		expect(result.summaryEntry?.summary).toContain("Recovered branch summary");
		expect(calls).toBe(2);
		expect(events).toEqual([
			"retry_scheduled:branch_summary",
			"retry_attempt_start:branch_summary",
			"retry_finished:branch_summary",
		]);
	});
});
