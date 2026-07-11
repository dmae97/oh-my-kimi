import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Contracts under test — the soft request budget must degrade gracefully
 * instead of killing scouts into an unreachable state:
 *
 * 1. Crossing 1.5x the budget stops the free-running turn and drives ONE
 *    forced final `yield`, so the run finishes as a normal completion with a
 *    partial report — not as an abort with no output.
 * 2. If the agent still refuses to yield (grace exhausted → hard abort), a
 *    kept-alive agent stays adopted (`idle`), so `irc` can message/resume it.
 * 3. Caller-signal aborts remain terminal, and the irc bus names the aborted
 *    agent precisely instead of claiming it is unknown.
 */

interface MockSessionHandle {
	session: AgentSession;
	prompts: Array<{ text: string; options?: PromptOptions }>;
	abortCalls: () => number;
	disposeCalls: () => number;
}

function assistantText(text: string, stopReason: "stop" | "aborted" = "stop") {
	return { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason };
}

function createMockSession(
	onPrompt: (params: {
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		pushMessage: (message: unknown) => void;
	}) => void,
): MockSessionHandle {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: unknown[] = [];
	const prompts: Array<{ text: string; options?: PromptOptions }> = [];
	let abortCount = 0;
	let disposeCount = 0;
	let promptIndex = 0;

	const emit = (event: AgentSessionEvent) => {
		for (const listener of [...listeners]) listener(event);
	};

	const session: Partial<AgentSession> = {
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		model: { api: "anthropic-messages" } as never,
		extensionRunner: undefined as never,
		sessionManager: { appendSessionInit: () => {} } as never,
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, options?: PromptOptions) => {
			promptIndex += 1;
			prompts.push({ text, options });
			onPrompt({ promptIndex, emit, pushMessage: message => messages.push(message) });
			return true;
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => messages[messages.length - 1] as never,
		sendUserMessage: async () => {},
		deliverIrcMessage: async () => "woken",
		abort: async () => {
			abortCount += 1;
		},
		dispose: async () => {
			disposeCount += 1;
		},
	};

	return {
		session: session as AgentSession,
		prompts,
		abortCalls: () => abortCount,
		disposeCalls: () => disposeCount,
	};
}

function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} satisfies CreateAgentSessionResult);
}
// Named "task": bundled scout/sonic budgets are built-in and override the
// `task.softRequestBudget` setting, which these tests pin to a tiny value.
const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("runSubprocess soft request budget", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-soft-budget-");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir[Symbol.dispose]();
	});

	function baseOptions(id: string) {
		return {
			cwd: "/tmp",
			agent: baseAgent,
			task: "inventory the api surface",
			index: 0,
			id,
			settings: Settings.isolated({ "task.softRequestBudget": 2 }),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir: tempDir.path(),
		};
	}

	function registerRunning(id: string, session: AgentSession) {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session,
			sessionFile: null,
			status: "running",
		});
	}

	it("a budget stop drives one forced final yield and finishes as a normal completion", async () => {
		const id = "BudgetScout";
		let abortCallsAtReminder: number | undefined;
		const handle = createMockSession(({ promptIndex, emit, pushMessage }) => {
			if (promptIndex === 1) {
				// Free-running exploration: budget 2 → stop threshold 3.
				for (let i = 1; i <= 3; i++) {
					const message = assistantText(`exploring ${i}`, i === 3 ? "aborted" : "stop");
					pushMessage(message);
					emit({ type: "message_end", message } as unknown as AgentSessionEvent);
				}
				return;
			}
			// The forced wrap-up reminder: answer it with a terminal yield.
			abortCallsAtReminder = handle.abortCalls();
			const yieldMessage = {
				role: "assistant" as const,
				content: [
					{
						type: "toolCall" as const,
						id: "tool-forced-yield",
						name: "yield",
						arguments: { result: { data: { report: "partial findings" } } },
					},
				],
				stopReason: "toolUse" as const,
			};
			pushMessage(yieldMessage);
			emit({ type: "message_end", message: yieldMessage } as unknown as AgentSessionEvent);
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-forced-yield",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { report: "partial findings" } },
				},
				isError: false,
			} as AgentSessionEvent);
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess(baseOptions(id));

		// The budget stop aborted the free-running turn exactly once before the
		// wrap-up reminder; the second abort (after the terminal yield) is the
		// normal post-yield terminate.
		expect(abortCallsAtReminder).toBe(1);
		// The wrap-up reminder is the budget-stop variant with a forced tool choice.
		expect(handle.prompts).toHaveLength(2);
		expect(handle.prompts[1]?.text).toMatch(/request budget/);
		expect(handle.prompts[1]?.options?.synthetic).toBe(true);
		expect(handle.prompts[1]?.options?.toolChoice).toEqual({ type: "tool", name: "yield" });
		// The forced yield finalizes as a normal completion, not an abort.
		expect(result.aborted).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.abortReason).toBeUndefined();
		expect(JSON.parse(result.output)).toEqual({ report: "partial findings" });
		// The agent stays a live, adopted peer.
		expect(AgentRegistry.global().get(id)?.status).toBe("idle");
		expect(AgentLifecycleManager.global().has(id)).toBe(true);
		expect(handle.disposeCalls()).toBe(0);
	});

	it("a budget hard-abort keeps the kept-alive agent adopted and messageable via irc", async () => {
		const id = "StubbornScout";
		const handle = createMockSession(({ promptIndex, emit, pushMessage }) => {
			if (promptIndex !== 1) return;
			// Never yields: budget 2 → stop at 3, grace exhausted at 3 + 5 = 8.
			for (let i = 1; i <= 8; i++) {
				const message = assistantText(`burning request ${i}`);
				pushMessage(message);
				emit({ type: "message_end", message } as unknown as AgentSessionEvent);
			}
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess(baseOptions(id));

		expect(result.aborted).toBe(true);
		expect(result.abortReason).toMatch(/Soft request budget exceeded/);
		// Resumable stop, not a terminal kill: the ref stays adopted and live.
		expect(AgentRegistry.global().get(id)?.status).toBe("idle");
		expect(AgentLifecycleManager.global().has(id)).toBe(true);
		expect(handle.disposeCalls()).toBe(0);

		// The whole point: irc can reach the stopped agent to resume it.
		const receipt = await new IrcBus().send({ from: "Main", to: id, body: "resume your inventory" });
		expect(receipt.outcome).toBe("woken");
	});

	it("a caller-signal abort stays terminal and irc names the aborted agent precisely", async () => {
		const id = "CancelledScout";
		const controller = new AbortController();
		const handle = createMockSession(({ promptIndex, emit, pushMessage }) => {
			if (promptIndex !== 1) return;
			const message = assistantText("working");
			pushMessage(message);
			emit({ type: "message_end", message } as unknown as AgentSessionEvent);
			controller.abort();
		});
		mockCreateAgentSession(handle.session);
		registerRunning(id, handle.session);

		const result = await runSubprocess({ ...baseOptions(id), signal: controller.signal });

		expect(result.aborted).toBe(true);
		expect(AgentRegistry.global().get(id)?.status).toBe("aborted");
		expect(handle.disposeCalls()).toBeGreaterThanOrEqual(1);

		const receipt = await new IrcBus().send({ from: "Main", to: id, body: "resume" });
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/hard-aborted/);
		expect(receipt.error).toMatch(new RegExp(`history://${id}`));
	});
});
