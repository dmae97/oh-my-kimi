import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "omk-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentHarnessEvent, SessionTreeEntry } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";

/**
 * Regression tests for the operation-lifecycle integration: exact-once
 * settlement, operation/attempt event correlation, strict inline reentry
 * rejection, flush-failure precedence, and target-captured abort.
 */

const registrations: FauxProviderRegistration[] = [];
const OVERFLOW = "prompt is too long: 100001 tokens > 100000 maximum";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

async function seededSession(): Promise<Session> {
	const session = new Session(new InMemorySessionStorage());
	await session.appendMessage(userMessage("old request"));
	await session.appendMessage({
		...fauxAssistantMessage(`old reply ${"x".repeat(4_000)}`),
		usage: {
			input: 1_700,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_800,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	return session;
}

function makeHarness(
	registration: FauxProviderRegistration,
	session?: Session,
	compaction?: ConstructorParameters<typeof AgentHarness>[0]["compaction"],
): { harness: AgentHarness; events: AgentHarnessEvent[] } {
	const harness = new AgentHarness({
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		session: session ?? new Session(new InMemorySessionStorage()),
		model: registration.getModel(),
		getApiKeyAndHeaders: compaction ? async () => ({ apiKey: "test-key" }) : undefined,
		compaction,
	});
	const events: AgentHarnessEvent[] = [];
	harness.subscribe((event) => {
		events.push(event);
	});
	return { harness, events };
}

/** Custom-entry persistence can be toggled to fail after the provider succeeded. */
class SwitchableCustomEntryStorage extends InMemorySessionStorage {
	private acceptsCustomEntries = false;

	allowCustomEntries(): void {
		this.acceptsCustomEntries = true;
	}

	override async appendEntry(entry: SessionTreeEntry): Promise<void> {
		if (entry.type === "custom" && !this.acceptsCustomEntries) {
			throw new Error("custom entry persistence is unavailable");
		}
		await super.appendEntry(entry);
	}
}

afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

describe("operation lifecycle integration", () => {
	it("emits correlated operation and attempt events around a normal prompt", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("done")]);
		const { harness, events } = makeHarness(registration);

		await harness.prompt("hello");

		const types = events.map((event) => event.type);
		expect(types).toContain("operation_started");
		expect(types).toContain("attempt_started");
		expect(types).toContain("attempt_finished");
		const operationStarted = events.find((event) => event.type === "operation_started");
		const attemptStarted = events.find((event) => event.type === "attempt_started");
		const attemptFinished = events.find((event) => event.type === "attempt_finished");
		const settled = events.find((event) => event.type === "settled");
		if (!operationStarted || !attemptStarted || !attemptFinished || !settled || settled.type !== "settled") {
			throw new Error("Missing lifecycle events");
		}
		if (operationStarted.type !== "operation_started") throw new Error("unreachable");
		const operationId = operationStarted.operation.operationId;
		if (attemptStarted.type === "attempt_started") {
			expect(attemptStarted.attempt.operationId).toBe(operationId);
			expect(attemptStarted.attempt.attemptId).toBe(`${operationId}:a0`);
		}
		if (attemptFinished.type === "attempt_finished") {
			expect(attemptFinished.summary.outcome).toBe("completed");
		}
		expect(settled.operationId).toBe(operationId);
		expect(settled.outcome).toEqual({ status: "completed" });
		expect(settled.attemptCount).toBe(1);
		expect(types.indexOf("operation_started")).toBeLessThan(types.indexOf("attempt_started"));
		expect(types.indexOf("attempt_started")).toBeLessThan(types.indexOf("agent_end"));
		expect(types.indexOf("agent_end")).toBeLessThan(types.indexOf("attempt_finished"));
		expect(types.indexOf("attempt_finished")).toBeLessThan(types.lastIndexOf("settled"));
	});

	it("rejects an inline prompt from an agent_end listener without harming the active operation", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("first"), () => fauxAssistantMessage("second")]);
		const { harness } = makeHarness(registration);
		let reentry: Promise<unknown> | undefined;
		harness.subscribe((event) => {
			if (event.type === "agent_end" && !reentry) reentry = harness.prompt("inline");
		});

		const first = await harness.prompt("first");

		expect(first.content).toContainEqual({ type: "text", text: "first" });
		if (!reentry) throw new Error("agent_end listener did not attempt reentry");
		await expect(reentry).rejects.toMatchObject({ code: "busy" });
		const second = await harness.prompt("second");
		expect(second.content).toContainEqual({ type: "text", text: "second" });
	});

	it("fails the operation when the final flush fails after provider success", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("done")]);
		const storage = new SwitchableCustomEntryStorage();
		const { harness, events } = makeHarness(registration, new Session(storage));
		harness.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				void harness.getSession().appendCustomEntry("queued", { value: 1 });
			}
		});

		await expect(harness.prompt("hello")).rejects.toMatchObject({ code: "session" });

		// Exact-once settlement still fires; the recorded outcome must be failed,
		// never completed, when the final flush could not commit accepted writes.
		const settleds = events.flatMap((event) => (event.type === "settled" ? [event] : []));
		expect(settleds).toHaveLength(1);
		expect(settleds[0]!.outcome.status).toBe("failed");
		await harness.waitForIdle();
		storage.allowCustomEntries();
		const retry = await harness.prompt("again");
		expect(retry.content).toBeDefined();
	});

	it("records the overflow recovery continuation under the same operation id", async () => {
		const registration = registerFauxProvider({
			models: [{ id: "large-context", reasoning: false, contextWindow: 100_000, maxTokens: 2_000 }],
		});
		registrations.push(registration);
		registration.setResponses([
			() => fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW }),
			() => fauxAssistantMessage("## Goal\nRecovered context"),
			() => fauxAssistantMessage("recovered answer"),
		]);
		const { harness, events } = makeHarness(registration, await seededSession(), {
			enabled: true,
			reserveTokens: 500,
			keepRecentTokens: 100,
			maxUsageRatio: 0.99,
		});

		const result = await harness.prompt("latest request");

		expect(result.content).toContainEqual({ type: "text", text: "recovered answer" });
		const operationStarted = events.find((event) => event.type === "operation_started");
		if (!operationStarted || operationStarted.type !== "operation_started") throw new Error("no operation_started");
		const operationId = operationStarted.operation.operationId;
		const attemptStarts = events.flatMap((event) => (event.type === "attempt_started" ? [event.attempt] : []));
		expect(attemptStarts.map((attempt) => attempt.attemptId)).toEqual([`${operationId}:a0`, `${operationId}:a1`]);
		expect(attemptStarts.map((attempt) => attempt.reason)).toEqual(["initial", "context_overflow_recovery"]);
		const finishes = events.flatMap((event) => (event.type === "attempt_finished" ? [event.summary] : []));
		expect(finishes.map((summary) => summary.outcome)).toEqual(["overflow", "completed"]);
		const settleds = events.flatMap((event) => (event.type === "settled" ? [event] : []));
		expect(settleds).toHaveLength(1);
		expect(settleds[0]).toMatchObject({ operationId, attemptCount: 2, outcome: { status: "completed" } });
	});

	it("abort waits only for the captured operation and the next prompt runs normally", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		registration.setResponses([
			async (_context, options) => {
				options?.signal?.addEventListener("abort", () => release(), { once: true });
				await gate;
				return fauxAssistantMessage("late");
			},
			() => fauxAssistantMessage("second"),
		]);
		const { harness, events } = makeHarness(registration);

		const firstPrompt = harness.prompt("first");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const abortResult = await harness.abort();
		const first = await firstPrompt;

		expect(first.stopReason).toBe("aborted");
		expect(abortResult.clearedSteer).toHaveLength(0);
		const settleds = events.flatMap((event) => (event.type === "settled" ? [event] : []));
		expect(settleds).toHaveLength(1);
		expect(settleds[0]).toMatchObject({ outcome: { status: "aborted" } });
		const second = await harness.prompt("second");
		expect(second.content).toContainEqual({ type: "text", text: "second" });
	});
});
