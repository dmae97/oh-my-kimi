import {
	type AssistantMessage,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Message,
	registerFauxProvider,
} from "omk-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentMessage } from "../../src/types.ts";

const registrations: FauxProviderRegistration[] = [];
const OVERFLOW = "prompt is too long: 100001 tokens > 100000 maximum";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function textParts(messages: readonly Message[]): string[] {
	return messages.flatMap((message) => {
		if (typeof message.content === "string") return [message.content];
		return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
	});
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

afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

describe("AgentHarness context-overflow recovery", () => {
	it("compacts and continues without duplicating the user message", async () => {
		const registration = registerFauxProvider({
			models: [{ id: "large-context", reasoning: false, contextWindow: 100_000, maxTokens: 2_000 }],
		});
		registrations.push(registration);
		const model = registration.getModel();
		if (!model) throw new Error("Faux model missing");
		let recoveredContext: readonly Message[] = [];
		registration.setResponses([
			() => fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW }),
			() => fauxAssistantMessage("## Goal\nRecovered context"),
			(context) => {
				recoveredContext = context.messages;
				return fauxAssistantMessage("recovered answer");
			},
		]);
		const session = await seededSession();
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
			compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 100, maxUsageRatio: 0.99 },
		});

		const result = await harness.prompt("latest request");

		expect(result.content).toContainEqual({ type: "text", text: "recovered answer" });
		expect(textParts(recoveredContext).filter((text) => text === "latest request")).toHaveLength(1);
		expect(textParts(recoveredContext).join("\n")).toContain("Recovered context");
		const activeBranch = await session.getBranch();
		expect(
			activeBranch.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.errorMessage === OVERFLOW,
			),
		).toBe(false);
	});

	it("leaves the original overflow active when summarization auth is unavailable", async () => {
		const registration = registerFauxProvider({
			models: [{ id: "large-context", reasoning: false, contextWindow: 100_000, maxTokens: 2_000 }],
		});
		registrations.push(registration);
		const model = registration.getModel();
		if (!model) throw new Error("Faux model missing");
		let calls = 0;
		registration.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW });
			},
		]);
		const session = await seededSession();
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model,
			compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 100, maxUsageRatio: 0.99 },
		});

		const result = await harness.prompt("latest request");

		expect(result.errorMessage).toBe(OVERFLOW);
		expect(calls).toBe(1);
		const leafId = await session.getLeafId();
		const leaf = leafId ? await session.getEntry(leafId) : undefined;
		expect(
			leaf?.type === "message" && leaf.message.role === "assistant" ? leaf.message.errorMessage : undefined,
		).toBe(OVERFLOW);
	});

	it("does not recover an old overflow after a settled listener starts a new run", async () => {
		const registration = registerFauxProvider({
			models: [{ id: "large-context", reasoning: false, contextWindow: 100_000, maxTokens: 2_000 }],
		});
		registrations.push(registration);
		const model = registration.getModel();
		if (!model) throw new Error("Faux model missing");
		let calls = 0;
		registration.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW });
			},
			() => {
				calls++;
				return fauxAssistantMessage("second answer");
			},
		]);
		const session = await seededSession();
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
			compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 100, maxUsageRatio: 0.99 },
		});
		let secondRun: Promise<AssistantMessage> | undefined;
		harness.subscribe((event) => {
			if (event.type === "settled" && !secondRun) secondRun = harness.prompt("second request");
		});

		const first = await harness.prompt("first request");
		if (!secondRun) throw new Error("Settled listener did not start the second run");
		const second = await secondRun;

		expect(first.errorMessage).toBe(OVERFLOW);
		expect(second.content).toContainEqual({ type: "text", text: "second answer" });
		expect(calls).toBe(2);
		expect((await session.getEntries()).some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("stops after one compact-and-retry recovery when the retry also overflows", async () => {
		const registration = registerFauxProvider({
			models: [{ id: "large-context", reasoning: false, contextWindow: 100_000, maxTokens: 2_000 }],
		});
		registrations.push(registration);
		const model = registration.getModel();
		if (!model) throw new Error("Faux model missing");
		let calls = 0;
		registration.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW });
			},
			() => {
				calls++;
				return fauxAssistantMessage("## Goal\nRecovered context");
			},
			() => {
				calls++;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW });
			},
		]);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: await seededSession(),
			model,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
			compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 100, maxUsageRatio: 0.99 },
		});

		const result = await harness.prompt("latest request");

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(OVERFLOW);
		expect(calls).toBe(3);
	});
});
