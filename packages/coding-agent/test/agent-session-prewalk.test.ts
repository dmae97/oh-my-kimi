import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model, z } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Prewalk: one-way switch from the starting model to a fast/cheap target
 * at the first completed turn that starts execution — an edit/write tool,
 * or the todo-list init the plan nudge asks for — with a hidden plan nudge
 * before the switch and a hidden verify-before-finishing checklist after
 * it. This is the single mechanism that won out over fixed-turn and
 * ungated variants in benchmark testing — see the plan nudge / checklist /
 * continuation-safety-net prompts under `src/prompts/system/prewalk-*.md`.
 */
describe("AgentSession prewalk", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-prewalk-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	function modelOrThrow(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected bundled model ${id}`);
		return model;
	}

	const recordToolSchema = z.object({});
	const recordTool: AgentTool<typeof recordToolSchema, undefined> = {
		name: "record",
		label: "Record",
		description: "Read-only step",
		parameters: recordToolSchema,
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	};
	const bashToolSchema = z.object({});
	const bashTool: AgentTool<typeof bashToolSchema, undefined> = {
		name: "bash",
		label: "Bash",
		description: "Run a command",
		parameters: bashToolSchema,
		async execute() {
			return { content: [{ type: "text", text: "ran" }], details: undefined };
		},
	};
	const writeToolSchema = z.object({});
	const writeTool: AgentTool<typeof writeToolSchema, undefined> = {
		name: "write",
		label: "Write",
		description: "Write a file",
		parameters: writeToolSchema,
		async execute() {
			return { content: [{ type: "text", text: "wrote" }], details: undefined };
		},
	};
	const todoToolSchema = z.object({});
	const todoTool: AgentTool<typeof todoToolSchema, undefined> = {
		name: "todo",
		label: "Todo",
		description: "Track tasks",
		parameters: todoToolSchema,
		async execute() {
			return { content: [{ type: "text", text: "listed" }], details: undefined };
		},
	};
	const toolRegistry = new Map<string, AgentTool>([
		[recordTool.name, recordTool as AgentTool],
		[bashTool.name, bashTool as AgentTool],
		[writeTool.name, writeTool as AgentTool],
		[todoTool.name, todoTool as AgentTool],
	]);

	function toolCall(id: string, name: string): MockResponse {
		return { content: [{ type: "toolCall", id, name, arguments: {} }], stopReason: "toolUse" };
	}

	function contextMessagesHaveMarker(contextMessages: ReadonlyArray<{ role: string }>, marker: string): boolean {
		return contextMessages.some(message => {
			if (message.role !== "user" && message.role !== "developer") return false;
			if (!("content" in message)) return false;
			const content: unknown = message.content;
			if (typeof content === "string") return content.includes(marker);
			if (!Array.isArray(content)) return false;
			return content.some(block => {
				if (typeof block !== "object" || block === null) return false;
				if (!("type" in block) || block.type !== "text") return false;
				return "text" in block && typeof block.text === "string" && block.text.includes(marker);
			});
		});
	}

	it("prewalks at the first edit/write after the todo gate opens; bash and todo don't trigger", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const planMarker = "complete plan in your NEXT reply";
		const checklistMarker = "grep for every other call site";

		// Turn 1: read-only (nudge injected after). Turn 2: bash — excluded.
		// Turn 3: todo — opens the gate, must NOT itself switch. Turn 4: write —
		// first post-todo edit/write, switch.
		const mock = createMockModel({
			responses: [
				toolCall("t1", "record"),
				toolCall("t2", "bash"),
				toolCall("t3", "todo"),
				toolCall("t4", "write"),
				{ content: ["done"] },
			],
		});
		const calls: Array<{ model: string; hasNudge: boolean; hasChecklist: boolean }> = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, bashTool as AgentTool, writeTool as AgentTool, todoTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				calls.push({
					model: `${model.provider}/${model.id}`,
					hasNudge: contextMessagesHaveMarker(context.messages, planMarker),
					hasChecklist: contextMessagesHaveMarker(context.messages, checklistMarker),
				});
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			prewalk: { target },
		});

		await session.prompt("do the task");

		expect(calls.map(call => call.model)).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${target.provider}/${target.id}`,
		]);
		// Nudge absent on turn 1 (not yet injected), present turns 2-4, scrubbed after the switch.
		expect(calls.map(call => call.hasNudge)).toEqual([false, true, true, true, false]);
		// Checklist present only once the target model is running.
		expect(calls.map(call => call.hasChecklist)).toEqual([false, false, false, false, true]);
		expect(session.model?.id).toBe(target.id);
	});

	it("an edit before any todo call does not switch while a todo tool exists; the next edit after todo does", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const planMarker = "complete plan in your NEXT reply";

		// Turn 1: exploration (nudge after). Turn 2: write with the gate still
		// closed — no switch; the fast model must not inherit a todo-less run.
		// Turn 3: todo — gate opens. Turn 4: write — switch.
		const mock = createMockModel({
			responses: [
				toolCall("t1", "record"),
				toolCall("t2", "write"),
				toolCall("t3", "todo"),
				toolCall("t4", "write"),
				{ content: ["done"] },
			],
		});
		const calls: Array<{ model: string; hasNudge: boolean }> = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, writeTool as AgentTool, todoTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				calls.push({
					model: `${model.provider}/${model.id}`,
					hasNudge: contextMessagesHaveMarker(context.messages, planMarker),
				});
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			prewalk: { target },
		});

		await session.prompt("do the task");

		expect(calls.map(call => call.model)).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${target.provider}/${target.id}`,
		]);
		// The turn-2 write landed while the gate was closed — still primary on turn 3.
		expect(calls.map(call => call.hasNudge)).toEqual([false, true, true, true, false]);
		expect(session.model?.id).toBe(target.id);
	});

	it("forces a continuation when the plan nudge gets a text-only reply, instead of silently ending the run", async () => {
		// Regression: the agent loop treats a turn with zero tool calls as a
		// natural stop boundary and ends the session with no further prompting.
		// The plan nudge explicitly asks for a prose reply, making this common
		// right after it — observed killing production runs before any code
		// was written. The safety net must force one more turn.
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		const mock = createMockModel({
			responses: [
				toolCall("t1", "record"),
				{ content: [{ type: "text", text: "Let me think about this for a moment." }], stopReason: "stop" },
				toolCall("t3", "write"),
				{ content: ["done"] },
			],
		});
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([
				[recordTool.name, recordTool as AgentTool],
				[writeTool.name, writeTool as AgentTool],
			]),
			prewalk: { target },
		});

		await session.prompt("do the task");

		// All 4 turns must run — the text-only turn 2 must not end the session early.
		expect(requested).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${target.provider}/${target.id}`,
		]);
		expect(session.model?.id).toBe(target.id);
	});

	it("bounds a completed bash-only task to a single continuation instead of looping", async () => {
		// Regression (#5551): with no edit/write ever run, the continuation net
		// used to re-fire on every text-only reply, looping forever. It must
		// fire at most once — one "continue" nudge — then let the next text-only
		// reply end the run. No mock fallback: a stray extra turn rejects.
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		// Turn 1: record (nudge injected after). Turn 2: bash — not an action
		// tool. Turn 3: prose — the single continuation fires. Turn 4: prose
		// again — no more continuation, run ends. A 5th call would exhaust the
		// script and reject.
		const mock = createMockModel({
			responses: [
				toolCall("t1", "record"),
				toolCall("t2", "bash"),
				{ content: [{ type: "text", text: "Commit complete." }], stopReason: "stop" },
				{ content: [{ type: "text", text: "Nothing left to do." }], stopReason: "stop" },
			],
		});
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, bashTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			prewalk: { target },
		});

		await session.prompt("commit the current changes");

		// Exactly one continuation: 4 turns, all on the primary (no edit/write,
		// so no switch), then a clean stop.
		expect(requested).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
		]);
		expect(session.model?.id).toBe(primary.id);
	});

	it("keeps the continuation net armed across a todo-only turn so a following prose reply still implements", async () => {
		// Regression: the plan nudge asks for a prose plan plus the todo init.
		// A model that answers the nudge with a todo-only turn, then a prose
		// follow-up, must not end the run before any edit/write — the todo turn
		// is part of planning, not completion, so the continuation net stays
		// armed until an action tool runs.
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		// Turn 1: read-only (nudge injected after). Turn 2: todo — plan
		// captured, gate opens, net stays armed. Turn 3: prose — must be
		// bridged, not treated as terminal. Turn 4: write — switch.
		const mock = createMockModel({
			responses: [
				toolCall("t1", "record"),
				toolCall("t2", "todo"),
				{ content: [{ type: "text", text: "Plan captured, starting now." }], stopReason: "stop" },
				toolCall("t4", "write"),
				{ content: ["done"] },
			],
		});
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, writeTool as AgentTool, todoTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			prewalk: { target },
		});

		await session.prompt("do the task");

		expect(requested).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${target.provider}/${target.id}`,
		]);
		expect(session.model?.id).toBe(target.id);
	});

	it("skips the todo gate when todo is registered but not active (subagent-style restricted slates)", async () => {
		// Regression: the gate used to key on the tool REGISTRY, so a session
		// whose active-tool slate excluded `todo` (subagents strip it) while the
		// registry still contained it could never open the gate — the model
		// cannot call an inactive tool — and prewalk never fired.
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		// Turn 1: read-only (nudge injected after). Turn 2: write — first
		// edit/write must switch immediately; no todo call is possible.
		const mock = createMockModel({
			responses: [toolCall("t1", "record"), toolCall("t2", "write"), { content: ["done"] }],
		});
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				// Active slate excludes todo; the session toolRegistry still has it.
				tools: [recordTool as AgentTool, writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry,
			prewalk: { target },
		});

		await session.prompt("do the task");

		expect(requested).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${target.provider}/${target.id}`,
		]);
		expect(session.model?.id).toBe(target.id);
	});

	it("armPrewalk (the /prewalk slash command) pre-arms the switch for the very next edit/write", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		// No `prewalk` in the session config — this simulates a session that
		// was NOT started with --prewalk, forced on via the slash command.
		const mock = createMockModel({ responses: [toolCall("t1", "write"), { content: ["done"] }] });
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([[writeTool.name, writeTool as AgentTool]]),
		});

		// Arming twice back-to-back must stay a single, idempotent arm.
		session.armPrewalk(target);
		session.armPrewalk(target);

		await session.prompt("do the task");

		// Pre-armed before the first turn: the very first write call switches
		// immediately — no second primary-model turn needed.
		expect(requested).toEqual([`${primary.provider}/${primary.id}`, `${target.provider}/${target.id}`]);
		expect(session.model?.id).toBe(target.id);
	});
});
