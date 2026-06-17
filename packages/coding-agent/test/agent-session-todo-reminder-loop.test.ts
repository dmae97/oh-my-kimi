import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

/**
 * Regression coverage for issue #2590: `#checkTodoCompletion` used to schedule
 * `agent.continue()` after appending its `<system-reminder>`, so any text-only
 * acknowledgement from the agent ("paused at your instruction") triggered another
 * `agent_end`, which incremented the counter and fired the next reminder — no
 * user input required. Within a single user pause that loop runs 1/3 → 2/3 → 3/3.
 *
 * The contract these tests defend: a reminder MUST NOT escalate inside a
 * self-continuation chain unless the agent has produced a tool-level result
 * (e.g. called `todo` or `edit`) between the prior reminder and the next stop.
 */
describe("AgentSession todo reminder self-continuation suppression", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let reminderAttempts: number[];
	let firstReminderPromise: Promise<void>;
	let resolveFirstReminder: () => void;

	function textOnlyAssistantMessage(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "paused at your instruction" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function emitTextOnlyStop(): void {
		const msg = textOnlyAssistantMessage();
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	function emitToolResult(toolName: string, details: Record<string, unknown> = {}): void {
		const toolCallId = `call_${toolName}_${Date.now()}_${Math.random()}`;
		const toolCall: ToolCall = { type: "toolCall", id: toolCallId, name: toolName, arguments: {} };
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [toolCall],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 50,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 60,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		const content: TextContent[] = [{ type: "text", text: "ok" }];
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content,
				isError: false,
				details,
				timestamp: Date.now(),
			},
		});
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-todo-reminder-loop-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": true,
				"todo.reminders": true,
				"todo.reminders.max": 3,
			}),
			modelRegistry,
		});

		reminderAttempts = [];
		({ promise: firstReminderPromise, resolve: resolveFirstReminder } = Promise.withResolvers<void>());
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "todo_reminder") {
				reminderAttempts.push(event.attempt);
				if (reminderAttempts.length === 1) resolveFirstReminder();
			}
		});

		session.setTodoPhases([
			{
				name: "Pending review",
				tasks: [
					{ content: "Slice 81", status: "pending" },
					{ content: "Slice 82", status: "pending" },
				],
			},
		]);
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("baseline: a single text-only stop fires reminder 1/3 and records it in the transcript", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired");
		expect(reminderAttempts).toEqual([1]);

		const reminderEntry = sessionManager.getBranch().find(entry => {
			if (entry.type !== "message" || entry.message.role !== "developer") return false;
			const { content } = entry.message;
			if (!Array.isArray(content)) return false;
			return content.some(
				(item): item is TextContent =>
					item.type === "text" && item.text.includes("You stopped with 2 incomplete todo item(s):"),
			);
		});
		expect(reminderEntry?.type).toBe("message");
	});

	it("fires exactly one reminder per user pause when the agent only acknowledges", async () => {
		// Each call to continue() mirrors what the bug-reported model did: emit another
		// text-only stop ("paused at your instruction"), no tool calls in between.
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			emitTextOnlyStop();
		});

		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired");
		await session.waitForIdle();

		// With the bug: reminderAttempts === [1, 2, 3] within a single user pause.
		// With the fix: the second `agent_end` is suppressed because no tool action ran
		// between the first reminder and the agent's text-only ack.
		expect(reminderAttempts).toEqual([1]);
	});

	it("re-escalates after the agent makes tool-level progress between stops", async () => {
		let continueCount = 0;
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			continueCount += 1;
			if (continueCount === 1) {
				// In response to reminder 1/3 the agent actually did work (called `todo`),
				// then stopped again with todos still incomplete.
				emitToolResult("todo", { phases: session.getTodoPhases() });
				emitTextOnlyStop();
				return;
			}
			// Subsequent continuations are bare acks — they must not escalate further.
			emitTextOnlyStop();
		});

		emitTextOnlyStop();
		await withTimeout(firstReminderPromise, 1000, "todo_reminder never fired");
		await session.waitForIdle();

		// 1/3 fires, agent does work, 2/3 fires, agent acks → suppressed, no 3/3.
		expect(reminderAttempts).toEqual([1, 2]);
	});
});
