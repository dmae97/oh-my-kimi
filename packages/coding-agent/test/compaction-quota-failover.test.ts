import type { AgentMessage, StreamFn } from "omk-agent-core";
import type { AssistantMessage, Model } from "omk-ai";
import { describe, expect, it } from "vitest";
import { type CompactionPreparation, type CompactionSettings, compact } from "../src/core/compaction/compaction.ts";
import { createFileOps } from "../src/core/compaction/utils.ts";

const QUOTA_ERROR = "Codex error: The usage limit has been reached";
const TRANSIENT_ERROR = "provider returned error 503 service unavailable";

const SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 1000,
	keepRecentTokens: 100,
};

function makeModel(provider: string, id: string): Model<any> {
	return { provider, id, maxTokens: 4000 } as unknown as Model<any>;
}

function assistantError(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		stopReason: "error",
		errorMessage,
		content: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as unknown as AssistantMessage;
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text }],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	} as unknown as AssistantMessage;
}

/**
 * Fake StreamFn keyed by `${provider}/${id}` so a test can decide which model
 * fails and which succeeds.
 */
function makeStreamFn(outcomes: Record<string, AssistantMessage>, calls: string[] = []): StreamFn {
	const fn = (async (model: Model<any>) => {
		const key = `${model.provider}/${model.id}`;
		calls.push(key);
		const outcome = outcomes[key] ?? assistantText(`summary from ${key}`);
		return {
			result: async () => outcome,
		};
	}) as unknown as StreamFn;
	return fn;
}

const USER_MESSAGE: AgentMessage = {
	role: "user",
	content: "hello",
	timestamp: Date.now(),
} as unknown as AgentMessage;

function makePreparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [USER_MESSAGE],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 10,
		fileOps: createFileOps(),
		settings: SETTINGS,
	};
}

describe("compact quota-exhaustion failover", () => {
	it("falls back to the next candidate when the primary model's quota is exhausted", async () => {
		const primary = makeModel("openrouter", "stealth/ox-alpha");
		const candidate = makeModel("kimi-coding", "k3");
		const calls: string[] = [];
		const streamFn = makeStreamFn(
			{
				"openrouter/stealth/ox-alpha": assistantError(QUOTA_ERROR),
				"kimi-coding/k3": assistantText("rescued summary"),
			},
			calls,
		);

		const result = await compact(
			makePreparation(),
			primary,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
			undefined,
			undefined,
			[candidate],
		);

		expect(result.summary).toContain("rescued summary");
		expect(calls).toEqual(["openrouter/stealth/ox-alpha", "kimi-coding/k3"]);
	});

	it("skips candidates that duplicate the primary model", async () => {
		const primary = makeModel("openrouter", "stealth/ox-alpha");
		const duplicate = makeModel("openrouter", "stealth/ox-alpha");
		const realCandidate = makeModel("deepseek", "deepseek-v4-flash");
		const calls: string[] = [];
		const streamFn = makeStreamFn({ "openrouter/stealth/ox-alpha": assistantError(QUOTA_ERROR) }, calls);

		const result = await compact(
			makePreparation(),
			primary,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
			undefined,
			undefined,
			[duplicate, realCandidate],
		);

		expect(result.summary).toContain("deepseek/deepseek-v4-flash");
		expect(calls).toEqual(["openrouter/stealth/ox-alpha", "deepseek/deepseek-v4-flash"]);
	});

	it("surfaces non-quota failures immediately without burning candidates", async () => {
		const primary = makeModel("openrouter", "stealth/ox-alpha");
		const candidate = makeModel("kimi-coding", "k3");
		const calls: string[] = [];
		const streamFn = makeStreamFn({ "openrouter/stealth/ox-alpha": assistantError(TRANSIENT_ERROR) }, calls);

		await expect(
			compact(
				makePreparation(),
				primary,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				streamFn,
				undefined,
				undefined,
				[candidate],
			),
		).rejects.toThrow(/Summarization failed/);
		expect(calls).toEqual(["openrouter/stealth/ox-alpha"]);
	});

	it("throws the original quota error when every candidate is also quota-blocked", async () => {
		const primary = makeModel("openrouter", "stealth/ox-alpha");
		const candidates = [makeModel("kimi-coding", "k3"), makeModel("deepseek", "deepseek-v4-flash")];
		const calls: string[] = [];
		const streamFn = makeStreamFn(
			{
				"openrouter/stealth/ox-alpha": assistantError(QUOTA_ERROR),
				"kimi-coding/k3": assistantError("kimi usage limit reached"),
				"deepseek/deepseek-v4-flash": assistantError("insufficient_quota"),
			},
			calls,
		);

		await expect(
			compact(
				makePreparation(),
				primary,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				streamFn,
				undefined,
				undefined,
				candidates,
			),
		).rejects.toThrow(/The usage limit has been reached/);
		expect(calls).toEqual(["openrouter/stealth/ox-alpha", "kimi-coding/k3", "deepseek/deepseek-v4-flash"]);
	});

	it("keeps plain single-model compaction working without failover models", async () => {
		const primary = makeModel("anthropic", "claude-sonnet");
		const calls: string[] = [];
		const streamFn = makeStreamFn({}, calls);

		const result = await compact(
			makePreparation(),
			primary,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);

		expect(result.summary).toContain("anthropic/claude-sonnet");
		expect(calls).toEqual(["anthropic/claude-sonnet"]);
	});
});

describe("compact model contract gate (TB21 §7 B2)", () => {
	it("rejects the primary model before any send when it violates the contract", async () => {
		const primary = makeModel("evil-relay", "mimic");
		const calls: string[] = [];
		const streamFn = makeStreamFn({}, calls);

		await expect(
			compact(
				makePreparation(),
				primary,
				"key",
				undefined,
				undefined,
				undefined,
				"off",
				streamFn,
				undefined,
				undefined,
				[],
				{
					contract: {
						allowedModels: [{ provider: "openai", id: "mock" }],
						allowedProviders: ["openai"],
						allowedAuthOrigins: ["openai"],
						thinking: false,
						maxOutputTokens: 8192,
					},
				},
			),
		).rejects.toThrow(/not in the allowed model set/);
		expect(calls).toEqual([]);
	});

	it("skips a contract-violating failover candidate and uses the next one", async () => {
		const primary = makeModel("openai", "mock");
		const bad = makeModel("evil-relay", "mimic");
		const good = makeModel("openai", "mock-2");
		const calls: string[] = [];
		const streamFn = makeStreamFn(
			{
				"openai/mock": assistantError(QUOTA_ERROR),
				"openai/mock-2": assistantText("summary ok"),
			},
			calls,
		);

		const result = await compact(
			makePreparation(),
			primary,
			"key",
			undefined,
			undefined,
			undefined,
			"off",
			streamFn,
			undefined,
			undefined,
			[bad, good],
			{
				contract: {
					allowedModels: [
						{ provider: "openai", id: "mock" },
						{ provider: "openai", id: "mock-2" },
					],
					allowedProviders: ["openai"],
					allowedAuthOrigins: ["openai"],
					thinking: false,
					maxOutputTokens: 8192,
				},
			},
		);

		expect(calls).toEqual(["openai/mock", "openai/mock-2"]);
		expect(JSON.stringify(result)).toContain("summary ok");
	});

	it("re-resolves credentials per provider on cross-provider failover", async () => {
		const primary = makeModel("openai", "mock");
		const candidate = makeModel("other", "model-2");
		const calls: string[] = [];
		const seenKeys: (string | undefined)[] = [];
		const streamFn = ((model: Model<any>, _ctx: unknown, opts?: { apiKey?: string }) => {
			calls.push(`${model.provider}/${model.id}`);
			seenKeys.push(opts?.apiKey);
			const outcome = model.provider === "openai" ? assistantError(QUOTA_ERROR) : assistantText("summary ok");
			return { result: async () => outcome };
		}) as unknown as StreamFn;

		await compact(
			makePreparation(),
			primary,
			"primary-key",
			{ Authorization: "Bearer primary" },
			undefined,
			undefined,
			"off",
			streamFn,
			undefined,
			undefined,
			[candidate],
			{
				contract: {
					allowedModels: [
						{ provider: "openai", id: "mock" },
						{ provider: "other", id: "model-2" },
					],
					allowedProviders: ["openai", "other"],
					allowedAuthOrigins: ["openai", "other"],
					thinking: false,
					maxOutputTokens: 8192,
				},
				resolveKey: (provider: string) =>
					provider === "other" ? Promise.resolve({ apiKey: "other-key" }) : Promise.resolve(undefined),
			},
		);

		expect(calls).toEqual(["openai/mock", "other/model-2"]);
		expect(seenKeys[1]).toBe("other-key");
	});
});
