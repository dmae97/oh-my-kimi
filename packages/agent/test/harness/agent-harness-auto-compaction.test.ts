import {
	type AssistantMessage,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Message,
	type Model,
	registerFauxProvider,
} from "omk-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentMessage } from "../../src/types.ts";

const registrations: FauxProviderRegistration[] = [];

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantWithUsage(model: Model<any>, content = `old reply ${"x".repeat(4_000)}`): AssistantMessage {
	return {
		...fauxAssistantMessage(content),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1_700,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_800,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function textParts(messages: readonly Message[]): string[] {
	return messages.flatMap((message) => {
		if (typeof message.content === "string") return [message.content];
		return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
	});
}

afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

describe("AgentHarness threshold auto-compaction", () => {
	it("compacts persisted history before the provider receives an oversized projected prompt", async () => {
		const registration = registerFauxProvider({
			models: [{ id: "small-context", reasoning: false, contextWindow: 2_000, maxTokens: 200 }],
		});
		registrations.push(registration);
		const model = registration.getModel();
		if (!model) throw new Error("Faux model missing");
		let providerMessages: readonly Message[] = [];
		registration.setResponses([
			() => fauxAssistantMessage("## Goal\nCompacted history"),
			(context) => {
				providerMessages = context.messages;
				return fauxAssistantMessage("final answer");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(userMessage("old request"));
		await session.appendMessage(assistantWithUsage(model));
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
			compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 100, maxUsageRatio: 0.9 },
		});
		let compactions = 0;
		harness.subscribe((event) => {
			if (event.type === "session_compact") compactions++;
		});

		const result = await harness.prompt("latest request");

		expect(result.content).toContainEqual({ type: "text", text: "final answer" });
		expect(compactions).toBe(1);
		expect(textParts(providerMessages)).toContain("latest request");
		expect(textParts(providerMessages).join("\n")).toContain("Compacted history");
		expect((await session.getEntries()).some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("skips automatic compaction without explicit summarization auth", async () => {
		const registration = registerFauxProvider({
			models: [{ id: "small-context", reasoning: false, contextWindow: 2_000, maxTokens: 200 }],
		});
		registrations.push(registration);
		const model = registration.getModel();
		if (!model) throw new Error("Faux model missing");
		let calls = 0;
		registration.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage("direct answer");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(userMessage("old request"));
		await session.appendMessage(assistantWithUsage(model));
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model,
			compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 100 },
		});

		await harness.prompt("latest request");

		expect(calls).toBe(1);
		expect((await session.getEntries()).some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("skips a threshold decision when compaction would drop no history", async () => {
		const registration = registerFauxProvider({
			models: [{ id: "small-context", reasoning: false, contextWindow: 2_000, maxTokens: 200 }],
		});
		registrations.push(registration);
		const model = registration.getModel();
		if (!model) throw new Error("Faux model missing");
		let calls = 0;
		registration.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage("direct answer");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(userMessage("old request"));
		await session.appendMessage(assistantWithUsage(model, "short reply"));
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
			compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 100 },
		});

		await harness.prompt("latest request");

		expect(calls).toBe(1);
		expect((await session.getEntries()).some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("does not compact when automatic compaction is disabled", async () => {
		const registration = registerFauxProvider({
			models: [{ id: "small-context", reasoning: false, contextWindow: 2_000, maxTokens: 200 }],
		});
		registrations.push(registration);
		const model = registration.getModel();
		if (!model) throw new Error("Faux model missing");
		let calls = 0;
		registration.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage("direct answer");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(userMessage("old request"));
		await session.appendMessage(assistantWithUsage(model));
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
			compaction: { enabled: false, reserveTokens: 500, keepRecentTokens: 100 },
		});

		await harness.prompt("latest request");

		expect(calls).toBe(1);
		expect((await session.getEntries()).some((entry) => entry.type === "compaction")).toBe(false);
	});
});
