import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

function model(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: provider === "openrouter" ? "https://openrouter.ai/api/v1" : `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

function createYieldingSession(): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	const session = {
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "retry_fallback_applied",
					from: "primary/bad-runtime-model",
					to: "fallback/working-model",
					role: "subagent:issue-2750",
				});
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
					isError: false,
				});
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

describe("subagent runtime model resolution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("passes ordered subagent candidates as a child retry fallback chain", async () => {
		const primary = model("primary", "bad-runtime-model");
		const fallback = model("fallback", "working-model");
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				default: ["global/inherited-model"],
			},
		});
		settings.setModelRole("default", "primary/bad-runtime-model");
		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "issue-2750",
			modelOverride: ["primary/bad-runtime-model", "fallback/working-model"],
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, fallback],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		let firstFallbackRole: string | undefined;
		let subagentFallbackChain: string[] | undefined;
		let inheritedFallbackChain: string[] | undefined;
		for (const role in childFallbackChains) {
			const chain = childFallbackChains[role];
			if (!firstFallbackRole) {
				firstFallbackRole = role;
			}
			if (role === "subagent:issue-2750") {
				subagentFallbackChain = chain;
			}
			if (role === "default") {
				inheritedFallbackChain = chain;
			}
		}
		expect(firstFallbackRole).toBe("subagent:issue-2750");
		expect(subagentFallbackChain).toEqual(["fallback/working-model"]);
		expect(inheritedFallbackChain).toEqual(["global/inherited-model"]);
		expect(result.modelOverride).toEqual(["primary/bad-runtime-model", "fallback/working-model"]);
		expect(result.resolvedModel).toBe("fallback/working-model");
	});

	it("preserves upstream routing selectors in the child retry fallback chain", async () => {
		const routedModel = model("openrouter", "z-ai/glm-4.7");
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "issue-2750-routed",
			modelOverride: ["openrouter/z-ai/glm-4.7@cerebras", "openrouter/z-ai/glm-4.7@fireworks"],
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [routedModel],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childFallbackChains?.["subagent:issue-2750-routed"]).toEqual(["openrouter/z-ai/glm-4.7@fireworks"]);
	});

	it("defers unresolved explicit subagent model selectors instead of picking an available default", async () => {
		const defaultModel = model("zai", "glm-5.2");
		let childModel: Model | undefined;
		let childModelPattern: unknown;
		let childModelPatternAuthFallback: unknown;
		let childModelPatternFallbackRole: unknown;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childModel = options.model;
			childModelPattern = options.modelPattern;
			childModelPatternAuthFallback = options.modelPatternAuthFallback;
			childModelPatternFallbackRole = options.modelPatternFallbackRole;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "issue-4421",
			modelOverride: ["openai-codex/gpt-5.5:auto"],
			parentActiveModelPattern: "openai-codex/gpt-5.5",
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [defaultModel],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childModel).toBeUndefined();
		expect(childModelPattern).toEqual(["openai-codex/gpt-5.5:auto"]);
		expect(childModelPatternAuthFallback).toBe("openai-codex/gpt-5.5");
		expect(childModelPatternFallbackRole).toBe("subagent:issue-4421");
	});
});
