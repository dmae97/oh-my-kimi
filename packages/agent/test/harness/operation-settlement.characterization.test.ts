import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "omk-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentHarnessEvent } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";

/**
 * Characterization fixtures for the current settlement behavior, captured
 * before routing public operations through the operation lifecycle. The
 * overflow cases intentionally record the current double-`settled` trace;
 * the same-operation recovery fix flips those expectations to exactly one.
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
	session: Session = new Session(new InMemorySessionStorage()),
	compaction?: ConstructorParameters<typeof AgentHarness>[0]["compaction"],
): { harness: AgentHarness; events: string[]; settledCount: () => number } {
	const harness = new AgentHarness({
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		session,
		model: registration.getModel(),
		getApiKeyAndHeaders: compaction ? async () => ({ apiKey: "test-key" }) : undefined,
		compaction,
	});
	const events: string[] = [];
	harness.subscribe((event: AgentHarnessEvent) => {
		events.push(event.type);
	});
	return { harness, events, settledCount: () => events.filter((type) => type === "settled").length };
}

afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

describe("operation settlement characterization", () => {
	it("settles a normal prompt exactly once with save points", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("done")]);
		const { harness, events, settledCount } = makeHarness(registration);

		const result = await harness.prompt("hello");

		expect(result.stopReason).toBe("stop");
		expect(events).toContain("agent_start");
		expect(events).toContain("save_point");
		expect(events.filter((type) => type === "agent_end")).toHaveLength(1);
		expect(settledCount()).toBe(1);
	});

	it("settles a provider failure exactly once and resolves an error message", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			() => {
				throw new Error("provider exploded");
			},
		]);
		const { harness, settledCount } = makeHarness(registration);

		const result = await harness.prompt("hello");

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("provider exploded");
		expect(settledCount()).toBe(1);
	});

	it("settles an aborted run exactly once and clears steer/follow-up queues", async () => {
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
		]);
		const { harness, settledCount } = makeHarness(registration);

		const promptPromise = harness.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.steer("steer");
		const abortPromise = harness.abort();
		await new Promise((resolve) => setTimeout(resolve, 0));
		release();
		const result = await promptPromise;
		await abortPromise;

		expect(result.stopReason).toBe("aborted");
		expect(settledCount()).toBe(1);
	});

	it("settles exactly once across overflow recovery (post-fix trace)", async () => {
		const registration = registerFauxProvider({
			models: [{ id: "large-context", reasoning: false, contextWindow: 100_000, maxTokens: 2_000 }],
		});
		registrations.push(registration);
		registration.setResponses([
			() => fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW }),
			() => fauxAssistantMessage("## Goal\nRecovered context"),
			() => fauxAssistantMessage("recovered answer"),
		]);
		const { harness, settledCount } = makeHarness(registration, await seededSession(), {
			enabled: true,
			reserveTokens: 500,
			keepRecentTokens: 100,
			maxUsageRatio: 0.99,
		});

		const result = await harness.prompt("latest request");

		expect(result.content).toContainEqual({ type: "text", text: "recovered answer" });
		expect(settledCount()).toBe(1);
	});

	it("settles exactly once when the continuation also overflows (post-fix trace)", async () => {
		const registration = registerFauxProvider({
			models: [{ id: "large-context", reasoning: false, contextWindow: 100_000, maxTokens: 2_000 }],
		});
		registrations.push(registration);
		registration.setResponses([
			() => fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW }),
			() => fauxAssistantMessage("## Goal\nRecovered context"),
			() => fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW }),
		]);
		const { harness, settledCount } = makeHarness(registration, await seededSession(), {
			enabled: true,
			reserveTokens: 500,
			keepRecentTokens: 100,
			maxUsageRatio: 0.99,
		});

		const result = await harness.prompt("latest request");

		expect(result.errorMessage).toBe(OVERFLOW);
		expect(settledCount()).toBe(1);
	});
});
