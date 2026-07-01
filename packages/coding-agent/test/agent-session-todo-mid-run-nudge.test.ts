import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool, type AsideMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression coverage for issue #3651: the only structured "reconcile your
 * todos" reminder used to fire at a text-only `agent_end`. A model running a
 * long tool-use loop therefore got no nudge until the very last turn, then
 * batch-flipped every task `done`. The contract this defends:
 *
 *   1. After {@link MID_RUN_TODO_NUDGE_TURN_THRESHOLD} consecutive tool-use
 *      turns without invoking the `todo` tool, the aside provider injects a
 *      `<system-reminder>` for the next turn AND emits a `todo_reminder` event.
 *   2. Sub-threshold counts do NOT inject anything.
 *   3. Any `todo` tool call inside the run resets the counter, so an interleaved
 *      todo turn keeps the nudge silent.
 *
 * Drives the aside provider directly: the production agent loop polls it
 * between tool-use turns (mid-work boundary in `agent-loop.ts`), so calling it
 * after a batch of synthesized `message_end` events mirrors that injection
 * point without spinning a real model.
 */
describe("AgentSession mid-run todo reconciliation nudge", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let reminderEvents: Array<Extract<AgentSessionEvent, { type: "todo_reminder" }>>;
	let asideProvider: (() => AsideMessage[] | Promise<AsideMessage[]>) | undefined;

	const THRESHOLD = 8; // mirrors MID_RUN_TODO_NUDGE_TURN_THRESHOLD

	function toolUseAssistant(toolName: string): AssistantMessage {
		const id = `call_${toolName}_${Date.now()}_${Math.random()}`;
		const toolCall: ToolCall = { type: "toolCall", id, name: toolName, arguments: {} };
		return {
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
	}

	function emitToolUseTurn(toolName: string): void {
		session.agent.emitExternalEvent({ type: "message_end", message: toolUseAssistant(toolName) });
	}

	function textOnlyAssistant(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "paused for instruction" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
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
	}
	async function emitTextOnlyStop(): Promise<void> {
		const msg = textOnlyAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		await settle();
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	function emitToolResult(toolName: string): void {
		const toolCallId = `call_${toolName}_${Date.now()}_${Math.random()}`;
		emitToolUseTurn(toolName);
		const content: TextContent[] = [{ type: "text", text: "ok" }];
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content,
				isError: false,
				timestamp: Date.now(),
			},
		});
	}

	/**
	 * #processAgentEvent fires off message_end handlers as async microtasks that
	 * chain on `#messageEndPersistenceTail`. After a batch of synchronous emits
	 * the counter only catches up once every queued persist task drains, so
	 * tests yield a full event-loop tick before draining asides.
	 */
	async function settle(): Promise<void> {
		await Bun.sleep(0);
	}

	async function drainAsides(): Promise<Array<{ role: string; text: string }>> {
		if (!asideProvider) throw new Error("aside provider was never captured");
		const thunks = await asideProvider();
		const out: Array<{ role: string; text: string }> = [];
		for (const entry of thunks) {
			const message = typeof entry === "function" ? entry() : entry;
			if (!message) continue;
			if (message.role !== "developer") continue;
			const content = message.content;
			if (!Array.isArray(content)) continue;
			for (const part of content) {
				if (part.type === "text") out.push({ role: message.role, text: part.text });
			}
		}
		return out;
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-todo-mid-run-nudge-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": true,
			"todo.reminders": true,
			"todo.reminders.max": 3,
		});
		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
		};
		const todoTool = new TodoTool(toolSession);

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [todoTool as unknown as AgentTool],
				messages: [],
			},
		});

		// Capture the aside provider AgentSession installs in its constructor.
		// Wrap the instance method (not the prototype) so concurrent test files
		// constructing their own Agents are never observed through this seam.
		asideProvider = undefined;
		const originalSet = agent.setAsideMessageProvider.bind(agent);
		agent.setAsideMessageProvider = (fn): void => {
			if (fn !== undefined && asideProvider === undefined) asideProvider = fn;
			originalSet(fn);
		};

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		reminderEvents = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "todo_reminder") reminderEvents.push(event);
		});

		session.setTodoPhases([
			{
				name: "Refactor pass",
				tasks: [
					{ content: "Sweep call sites", status: "in_progress" },
					{ content: "Update tests", status: "pending" },
					{ content: "Polish docs", status: "pending" },
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

	it("stays silent until the threshold of non-todo tool-use turns is reached", async () => {
		for (let i = 0; i < THRESHOLD - 1; i++) emitToolUseTurn("edit");

		await settle();
		const messages = await drainAsides();
		expect(messages).toEqual([]);
		expect(reminderEvents).toEqual([]);
	});

	it("injects a developer-role reminder once the threshold is reached", async () => {
		for (let i = 0; i < THRESHOLD; i++) emitToolUseTurn("edit");

		await settle();
		const messages = await drainAsides();
		expect(messages.length).toBe(1);
		const text = messages[0]?.text ?? "";
		expect(text).toContain("<system-reminder>");
		// Surfaces every incomplete task by content, not just a count.
		expect(text).toContain("Sweep call sites");
		expect(text).toContain("Update tests");
		expect(text).toContain("Polish docs");
		// Carries the mid-run framing so the agent does not treat it as a stop-time prompt.
		expect(text).toContain("Mid-run reminder 1/3");

		expect(reminderEvents.length).toBe(1);
		expect(reminderEvents[0]?.attempt).toBe(1);
		expect(reminderEvents[0]?.maxAttempts).toBe(3);
		expect(reminderEvents[0]?.todos.length).toBe(3);

		// Counter reset: another full runway is required before the next nudge,
		// so an immediate poll right after firing must NOT re-inject.
		const followUp = await drainAsides();
		expect(followUp).toEqual([]);
	});

	it("does not nudge when a `todo` call has reset the counter mid-window", async () => {
		// Seven non-todo turns get us within one of the threshold...
		for (let i = 0; i < THRESHOLD - 1; i++) emitToolUseTurn("edit");
		// ...then a todo call resets the counter; the remaining runway is fresh.
		emitToolUseTurn("todo");
		for (let i = 0; i < THRESHOLD - 1; i++) emitToolUseTurn("edit");

		await settle();
		const messages = await drainAsides();
		expect(messages).toEqual([]);
		expect(reminderEvents).toEqual([]);
	});

	it("counter update lands synchronously with the message_end emit (no microtask drain required)", () => {
		// Regression for the review on PR #3652: pre-fix the counter update sat
		// after `await messageEndPersistence.persist(...)`, so the live counter
		// only caught up once microtasks drained. A poll between the emit burst
		// and the persistence chain settling would observe stale state — a turn
		// that JUST flipped a todo could still trip the nudge against the
		// pre-reset counter. With the hoisted (synchronous) update, the
		// production-shaped contract holds even when the aside poll runs in the
		// same JS task as the emit, before any microtask gets a chance to fire.
		for (let i = 0; i < THRESHOLD; i++) emitToolUseTurn("edit");

		if (!asideProvider) throw new Error("aside provider was never captured");
		const result = asideProvider();
		if (result instanceof Promise) throw new Error("aside provider unexpectedly returned a Promise");
		const messagesAfterThreshold = result
			.map(entry => (typeof entry === "function" ? entry() : entry))
			.filter((m): m is NonNullable<typeof m> => Boolean(m))
			.filter(m => m.role === "developer");
		// The threshold-hit fire is the proof point: pre-hoist, the eight
		// increments are all queued microtasks, so this sync poll would see
		// counter=0 and skip the nudge entirely.
		expect(messagesAfterThreshold.length).toBe(1);
	});

	it("stays silent when `todo` is not in the active-tool list, even if `todo.enabled` is still on", async () => {
		// Regression for the review on PR #3652: an explicit active-tool list
		// (or discovery-mode filtering) can drop `todo` from the slate while the
		// setting flag stays true and an incomplete persisted/user-edited todo
		// list survives. Asking the model to call a tool that is not in its
		// schema would produce fabricated/unknown tool calls or loop on
		// impossible reminders. Mirror {@link #createEagerTodoPrelude}'s guard.
		await session.setActiveToolsByName([]);
		expect(session.getActiveToolNames()).not.toContain("todo");

		for (let i = 0; i < THRESHOLD; i++) emitToolUseTurn("edit");
		await settle();
		const messages = await drainAsides();
		expect(messages).toEqual([]);
		expect(reminderEvents).toEqual([]);
	});

	it("does not spend the pre-stop tool-turn count immediately after a stop-time reminder", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		for (let i = 0; i < THRESHOLD - 1; i++) emitToolUseTurn("edit");

		await settle();
		await emitTextOnlyStop();
		await session.waitForIdle();
		expect(reminderEvents.length).toBe(1);
		expect(reminderEvents[0]?.attempt).toBe(1);

		emitToolResult("edit");
		await settle();
		const messages = await drainAsides();
		expect(messages).toEqual([]);
		expect(reminderEvents.length).toBe(1);
	});
});
