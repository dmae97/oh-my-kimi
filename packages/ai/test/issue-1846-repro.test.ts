import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";

import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { xiaomiModelManagerOptions } from "../src/provider-models/openai-compat";
import { convertMessages, detectCompat } from "../src/providers/openai-completions";
import type { AssistantMessage, Model, ThinkingContent, ToolCall } from "../src/types";
import { getOAuthProviders } from "../src/utils/oauth";

const TP_KEY = "tp-ci1p8t1w4e1sbxgyc8v65tnrjbzro287igmvyf25van9mt76";
const SGP_BASE_URL = "https://token-plan-sgp.xiaomimimo.com/v1";

afterEach(() => {
	vi.restoreAllMocks();
});

function mimoModel(): Model<"openai-completions"> {
	return {
		id: "mimo-v2.5-pro",
		name: "MiMo V2.5 Pro",
		api: "openai-completions",
		provider: "xiaomi-token-plan-sgp",
		baseUrl: SGP_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
	};
}

function assistantToolCall(model: Model<"openai-completions">, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1_700_000_000_000,
	};
}

describe("issue #1846: Xiaomi Token Plan provider support", () => {
	it("registers regional Xiaomi Token Plan login providers", () => {
		const providers = getOAuthProviders();

		expect(providers.some(provider => provider.id === "xiaomi-token-plan-sgp")).toBe(true);
		expect(providers.some(provider => provider.id === "xiaomi-token-plan-ams")).toBe(true);
		expect(providers.some(provider => provider.id === "xiaomi-token-plan-cn")).toBe(true);
	});

	it("logs into the selected Token Plan region and stores that provider key", async () => {
		const seen: string[] = [];
		let authUrl = "";
		const fetchMock = Object.assign(
			async (input: string | URL | Request) => {
				seen.push(String(input));
				return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
			},
			{ preconnect() {} },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();

		await storage.login("xiaomi-token-plan-sgp", {
			onAuth: info => {
				authUrl = info.url;
			},
			onPrompt: async () => TP_KEY,
		});

		expect(seen).toEqual([`${SGP_BASE_URL}/chat/completions`]);
		expect(authUrl).toBe("https://platform.xiaomimimo.com/console/plan-manage");
		expect(store.getApiKey("xiaomi-token-plan-sgp")).toBe(TP_KEY);
		expect(store.getApiKey("xiaomi")).toBeNull();
	});

	it("discovers Token Plan models under the regional provider id", async () => {
		const fetchMock = Object.assign(
			async (_input: string | URL | Request) => {
				return new Response(JSON.stringify({ data: [{ id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
			{ preconnect() {} },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		const opts = xiaomiModelManagerOptions({
			apiKey: TP_KEY,
			providerId: "xiaomi-token-plan-sgp",
			tokenPlanRegion: "sgp",
		});

		const models = await opts.fetchDynamicModels?.();

		expect(opts.providerId).toBe("xiaomi-token-plan-sgp");
		expect(models).toHaveLength(1);
		expect(models?.[0]?.provider).toBe("xiaomi-token-plan-sgp");
		expect(models?.[0]?.baseUrl).toBe(SGP_BASE_URL);
		expect(models?.[0]?.compat?.requiresReasoningContentForToolCalls).toBe(true);
	});

	it("replays MiMo reasoning_content on Token Plan tool-call turns", () => {
		const model = mimoModel();
		const compat = detectCompat(model);
		const thinking: ThinkingContent = {
			type: "thinking",
			thinking: "I need to inspect the file before answering.",
			thinkingSignature: "reasoning_content",
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call_read",
			name: "read",
			arguments: { path: "README.md" },
		};

		const messages = convertMessages(model, { messages: [assistantToolCall(model, [thinking, toolCall])] }, compat);
		const assistant = messages.find(message => message.role === "assistant");

		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
		expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
		expect(Reflect.get(assistant ?? {}, "reasoning_content")).toBe("I need to inspect the file before answering.");
	});
});
