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
 * Downshift: one-way switch from the starting model to a fast/cheap target
 * at the first completed turn that starts execution — an edit/write tool,
 * or the todo-list init the plan nudge asks for — with a hidden plan nudge
 * before the switch and a hidden verify-before-finishing checklist after
 * it. This is the single mechanism that won out over fixed-turn and
 * ungated variants in benchmark testing — see the plan nudge / checklist /
 * continuation-safety-net prompts under `src/prompts/system/downshift-*.md`.
 */
describe("AgentSession downshift", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-downshift-");
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

	function contextMessagesHaveMarker(
		contextMessages: Array<{ role: string; content: unknown }>,
		marker: string,
	): boolean {
		return contextMessages.some(message => {
			if (message.role !== "user" && message.role !== "developer") return false;
			const content = message.content;
			if (typeof content === "string") return content.includes(marker);
			if (!Array.isArray(content)) return false;
			return content.some(block => {
				if (typeof block !== "object" || block === null) return false;
				if (!("type" in block) || block.type !== "text") return false;
				return "text" in block && typeof block.text === "string" && block.text.includes(marker);
			});
		});
	}

	it("downshifts at the first edit/write: plan nudge before, checklist after, bash doesn't trigger", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const planMarker = "complete plan in your NEXT reply";
		const checklistMarker = "grep for every other call site";

		// Turn 1: read-only (nudge injected after). Turn 2: bash — excluded from
		// the trigger set, still no switch. Turn 3: write — first action, switch.
		const mock = createMockModel({
			responses: [toolCall("t1", "record"), toolCall("t2", "bash"), toolCall("t3", "write"), { content: ["done"] }],
		});
		const calls: Array<{ model: string; hasNudge: boolean; hasChecklist: boolean }> = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, bashTool as AgentTool, writeTool as AgentTool],
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
			downshift: { target },
		});

		await session.prompt("do the task");

		expect(calls.map(call => call.model)).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${target.provider}/${target.id}`,
		]);
		// Nudge absent on turn 1 (not yet injected), present turns 2-3, scrubbed by turn 4.
		expect(calls.map(call => call.hasNudge)).toEqual([false, true, true, false]);
		// Checklist present only once the target model is running.
		expect(calls.map(call => call.hasChecklist)).toEqual([false, false, false, true]);
		expect(session.model?.id).toBe(target.id);
	});

	it("todo triggers the switch only after the plan nudge; a turn-1 todo init is bookkeeping, not readiness", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const planMarker = "complete plan in your NEXT reply";

		// Turn 1: todo init BEFORE the nudge exists — must not switch (the nudge
		// is injected after this turn instead). Turn 2: exploration under the
		// nudge. Turn 3: todo — the post-plan "starting work" signal, switch.
		const mock = createMockModel({
			responses: [toolCall("t1", "todo"), toolCall("t2", "record"), toolCall("t3", "todo"), { content: ["done"] }],
		});
		const calls: Array<{ model: string; hasNudge: boolean }> = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool, todoTool as AgentTool],
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
			downshift: { target },
		});

		await session.prompt("do the task");

		expect(calls.map(call => call.model)).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${target.provider}/${target.id}`,
		]);
		// Nudge injected after turn 1 despite the todo call there.
		expect(calls.map(call => call.hasNudge)).toEqual([false, true, true, false]);
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
			downshift: { target },
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

	it("armDownshift (the /downshift slash command) pre-arms the switch for the very next edit/write", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		// No `downshift` in the session config — this simulates a session that
		// was NOT started with --downshift, forced on via the slash command.
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
		session.armDownshift(target);
		session.armDownshift(target);

		await session.prompt("do the task");

		// Pre-armed before the first turn: the very first write call switches
		// immediately — no second primary-model turn needed.
		expect(requested).toEqual([`${primary.provider}/${primary.id}`, `${target.provider}/${target.id}`]);
		expect(session.model?.id).toBe(target.id);
	});
});
