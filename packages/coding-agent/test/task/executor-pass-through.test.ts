/**
 * Verifies parent-discovered rules, extensions, and custom tools are forwarded
 * to `createAgentSession` so subagents skip the FS scans the parent already
 * paid for. Regression guard for issue #2190.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolPathWithSource } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

function createMockSession(onPrompt: (params: { emit: (event: AgentSessionEvent) => void }) => void): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			onPrompt({ emit });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

function yieldEmittingSession(): AgentSession {
	return createMockSession(({ emit }) => {
		emit({
			type: "tool_execution_end",
			toolCallId: "tool-pass-through",
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { ok: true } },
			},
			isError: false,
		});
	});
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const baseOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "do work",
	index: 0,
	id: "subagent-pass-through",
	settings: Settings.isolated(),
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
};

function createModelRegistry(model: Model): ModelRegistry {
	return {
		authStorage: {},
		refresh: async () => {},
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
	} as unknown as ModelRegistry;
}

describe("runSubprocess parent-discovery pass-through (issue #2190)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards rules, preloadedExtensionPaths, and preloadedCustomToolPaths to createAgentSession", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const rules: Rule[] = [{ name: "rule-a" } as unknown as Rule];
		const preloadedExtensionPaths = ["/abs/parent/.omp/extensions/foo.ts"];
		const preloadedCustomToolPaths: ToolPathWithSource[] = [
			{ path: "tools/x.ts", source: { provider: "config", providerName: "Config", level: "project" } },
		];

		const result = await runSubprocess({
			...baseOptions,
			rules,
			preloadedExtensionPaths,
			preloadedCustomToolPaths,
		});

		expect(result.exitCode).toBe(0);
		expect(spy).toHaveBeenCalledTimes(1);
		const forwarded = spy.mock.calls[0]?.[0];
		// Identity, not equality: passing a clone would defeat the perf fix.
		expect(forwarded?.rules).toBe(rules);
		expect(forwarded?.preloadedExtensionPaths).toBe(preloadedExtensionPaths);
		expect(forwarded?.preloadedCustomToolPaths).toBe(preloadedCustomToolPaths);
	});

	it("forwards undefined when the parent has not pre-discovered state", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({ ...baseOptions });

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.rules).toBeUndefined();
		expect(forwarded?.preloadedExtensionPaths).toBeUndefined();
		expect(forwarded?.preloadedCustomToolPaths).toBeUndefined();
	});

	it("records the spawning agent as parentAgentId, distinct from the child's own id and prefix", async () => {
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "ChildAgent",
			parentAgentId: "SpawnerAgent",
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		// The registry parent is the spawning agent — never the child itself (the
		// self-parent bug). The child's own id still drives both its agent id and
		// its artifact/output-id prefix; those must not double as the parent link.
		expect(forwarded?.parentAgentId).toBe("SpawnerAgent");
		expect(forwarded?.agentId).toBe("ChildAgent");
		expect(forwarded?.parentTaskPrefix).toBe("ChildAgent");
	});

	it("resolves an explicit task-role effort suffix over the agent-definition default", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}:high`);
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["pi/task"] },
			id: "subagent-thinking-precedence",
			settings,
			modelRegistry: createModelRegistry(model),
			thinkingLevel: ThinkingLevel.Low,
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		// The user's explicit `:high` suffix on the resolved role pattern wins over
		// the agent definition's default level (e.g. task's `auto`).
		expect(forwarded?.thinkingLevel).toBe(ThinkingLevel.High);
	});

	it("falls back to the agent-definition thinking level without an explicit suffix", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const settings = Settings.isolated();
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["pi/task"] },
			id: "subagent-thinking-default",
			settings,
			modelRegistry: createModelRegistry(model),
			thinkingLevel: ThinkingLevel.Low,
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.thinkingLevel).toBe(ThinkingLevel.Low);
	});
});
