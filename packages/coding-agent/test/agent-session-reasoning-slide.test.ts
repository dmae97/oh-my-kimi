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

describe("AgentSession reasoning slide", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-reasoning-slide-");
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

	it("uses the primary model for N completed turns before sliding to the target", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [{ content: ["first"] }, { content: ["second"] }, { content: ["third"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			reasoningSlide: { target, afterTurns: 2 },
		});

		await session.prompt("first task");
		await session.prompt("second task");
		await session.prompt("third task");

		expect(requestedModels).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${target.provider}/${target.id}`,
		]);
		expect(session.model?.id).toBe(target.id);
	});

	it("plan burst: injects the deep-plan nudge mid-run and scrubs it at the switch", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		const recordToolSchema = z.object({});
		const recordTool: AgentTool<typeof recordToolSchema, undefined> = {
			name: "record",
			label: "Record",
			description: "Record a step",
			parameters: recordToolSchema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: undefined };
			},
		};
		const step = (id: string): MockResponse => ({
			content: [{ type: "toolCall", id, name: "record", arguments: {} }],
			stopReason: "toolUse",
		});
		// A plan-shaped turn: substantial text (clears the delivery threshold)
		// plus a tool call so the loop keeps running.
		const planText = `Plan: ${"step-by-step execution detail. ".repeat(20)}`;
		const planStep = (id: string): MockResponse => ({
			content: [
				{ type: "text", text: planText },
				{ type: "toolCall", id, name: "record", arguments: {} },
			],
			stopReason: "toolUse",
		});
		// Turn 1 explores; turn 2 answers the nudge with the plan; turn 3 keeps
		// working; turn 4 runs on the target.
		const mock = createMockModel({
			responses: [step("t1"), planStep("t2"), step("t3"), { content: ["done"] }],
		});

		const calls: Array<{ model: string; hasNudge: boolean }> = [];
		const nudgeMarker = "complete plan in your NEXT reply";
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				const hasNudge = context.messages.some(message => {
					// The custom nudge converts to a developer-role LLM message.
					if (message.role !== "user" && message.role !== "developer") return false;
					const content = message.content;
					if (typeof content === "string") return content.includes(nudgeMarker);
					return content.some(block => block.type === "text" && block.text.includes(nudgeMarker));
				});
				calls.push({ model: `${model.provider}/${model.id}`, hasNudge });
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([[recordTool.name, recordTool as AgentTool]]),
			reasoningSlide: { target, afterTurns: 3, plan: true, planAtTurn: 1 },
		});

		await session.prompt("do the task");

		const primaryId = `${primary.provider}/${primary.id}`;
		expect(calls.map(call => call.model)).toEqual([
			primaryId,
			primaryId,
			primaryId,
			`${target.provider}/${target.id}`,
		]);
		// Nudge lands after turn planAtTurn=1, stays through the pre-slide turns,
		// and is scrubbed from the context the target model sees.
		expect(calls.map(call => call.hasNudge)).toEqual([false, true, true, false]);
		expect(session.model?.id).toBe(target.id);
		const residual = session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "reasoning-slide-plan",
		);
		expect(residual).toHaveLength(0);
	});

	it("plan burst: holds the slide until the plan lands, then switches", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const recordToolSchema = z.object({});
		const recordTool: AgentTool<typeof recordToolSchema, undefined> = {
			name: "record",
			label: "Record",
			description: "Record a step",
			parameters: recordToolSchema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: undefined };
			},
		};
		const step = (id: string): MockResponse => ({
			content: [{ type: "toolCall", id, name: "record", arguments: {} }],
			stopReason: "toolUse",
		});
		const planText = `Plan: ${"comprehensive step detail. ".repeat(20)}`;
		// afterTurns=2, but the plan only lands on turn 4 — the slide must wait
		// for it instead of switching mid-exploration, then fire right after.
		const mock = createMockModel({
			responses: [
				step("t1"),
				step("t2"),
				step("t3"),
				{
					content: [
						{ type: "text", text: planText },
						{ type: "toolCall", id: "t4", name: "record", arguments: {} },
					],
					stopReason: "toolUse",
				},
				{ content: ["done"] },
			],
		});
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(model.id);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([[recordTool.name, recordTool as AgentTool]]),
			reasoningSlide: { target, afterTurns: 2, plan: true, planAtTurn: 1 },
		});

		await session.prompt("do the task");

		// Turns 1-4 stay on the primary (plan not yet delivered at the turn-2/3
		// boundaries); turn 5 runs on the target.
		expect(requested).toEqual([primary.id, primary.id, primary.id, primary.id, target.id]);
		expect(session.model?.id).toBe(target.id);
	});

	it("plan burst: grace ceiling slides even when no plan is ever written", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const recordToolSchema = z.object({});
		const recordTool: AgentTool<typeof recordToolSchema, undefined> = {
			name: "record",
			label: "Record",
			description: "Record a step",
			parameters: recordToolSchema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: undefined };
			},
		};
		const step = (id: string): MockResponse => ({
			content: [{ type: "toolCall", id, name: "record", arguments: {} }],
			stopReason: "toolUse",
		});
		// afterTurns=2 + grace 4 → the hold expires at turn 6 even with no plan.
		const mock = createMockModel({
			responses: [step("t1"), step("t2"), step("t3"), step("t4"), step("t5"), step("t6"), { content: ["done"] }],
		});
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(model.id);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([[recordTool.name, recordTool as AgentTool]]),
			reasoningSlide: { target, afterTurns: 2, plan: true, planAtTurn: 1 },
		});

		await session.prompt("do the task");

		expect(requested).toEqual([primary.id, primary.id, primary.id, primary.id, primary.id, primary.id, target.id]);
		expect(session.model?.id).toBe(target.id);
	});

	it("onFirstAction: bash stays on the primary; the first edit/write slides", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const readSchema = z.object({});
		const lookTool: AgentTool<typeof readSchema, undefined> = {
			name: "record",
			label: "Record",
			description: "Read-only step",
			parameters: readSchema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: undefined };
			},
		};
		const bashSchema = z.object({});
		const bashTool: AgentTool<typeof bashSchema, undefined> = {
			name: "bash",
			label: "Bash",
			description: "Run a command",
			parameters: bashSchema,
			async execute() {
				return { content: [{ type: "text", text: "ran" }], details: undefined };
			},
		};
		const writeSchema = z.object({});
		const writeTool: AgentTool<typeof writeSchema, undefined> = {
			name: "write",
			label: "Write",
			description: "Write a file",
			parameters: writeSchema,
			async execute() {
				return { content: [{ type: "text", text: "wrote" }], details: undefined };
			},
		};
		const call = (id: string, name: string): MockResponse => ({
			content: [{ type: "toolCall", id, name, arguments: {} }],
			stopReason: "toolUse",
		});
		// Turn 1 reads, turn 2 runs bash (exploration — must NOT trigger),
		// turn 3 writes (first action) → slide; turn 4 on target.
		const mock = createMockModel({
			responses: [call("t1", "record"), call("t2", "bash"), call("t3", "write"), { content: ["done"] }],
		});
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [lookTool as AgentTool, bashTool as AgentTool, writeTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(model.id);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([
				[lookTool.name, lookTool as AgentTool],
				[bashTool.name, bashTool as AgentTool],
				[writeTool.name, writeTool as AgentTool],
			]),
			reasoningSlide: { target, onFirstAction: true },
		});

		await session.prompt("do the task");

		expect(requested).toEqual([primary.id, primary.id, primary.id, target.id]);
		expect(session.model?.id).toBe(target.id);
	});

	it("plan burst: a text-only plan-delivery turn does not end the run before the target model runs", async () => {
		// Regression: the agent loop treats a turn with zero tool calls as a
		// natural stop boundary and ends the whole session with no further
		// prompting. The plan nudge explicitly asks for a prose reply, making
		// this the COMMON case, not an edge case — observed killing production
		// SWE-bench runs before any code was ever written. The switch must
		// force a continuation so the target model actually gets a turn.
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const recordToolSchema = z.object({});
		const recordTool: AgentTool<typeof recordToolSchema, undefined> = {
			name: "record",
			label: "Record",
			description: "Record a step",
			parameters: recordToolSchema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: undefined };
			},
		};
		const step = (id: string): MockResponse => ({
			content: [{ type: "toolCall", id, name: "record", arguments: {} }],
			stopReason: "toolUse",
		});
		const planText = `Plan: ${"comprehensive step detail. ".repeat(20)}`;
		// Turn 1 explores (tool call). Turn 2 answers the nudge with the plan
		// as PURE TEXT — no tool call, stopReason "stop". afterTurns=2 means
		// this same turn also satisfies the switch criteria: without the
		// safety net, the run would end right here and the target model
		// would never be invoked.
		const mock = createMockModel({
			responses: [
				step("t1"),
				{ content: [{ type: "text", text: planText }], stopReason: "stop" },
				{ content: ["done"] },
			],
		});
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				requested.push(model.id);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([[recordTool.name, recordTool as AgentTool]]),
			reasoningSlide: { target, afterTurns: 2, plan: true, planAtTurn: 1 },
		});

		await session.prompt("do the task");

		// The run must survive the text-only plan turn and give the target
		// model an actual turn — not stop dead after 2 primary-model calls.
		expect(requested).toEqual([primary.id, primary.id, target.id]);
		expect(session.model?.id).toBe(target.id);
	});

	it("checklist: steered only at the switch, present in post-switch context, independent of plan", async () => {
		const primary = modelOrThrow("claude-sonnet-4-5");
		const target = modelOrThrow("claude-sonnet-4-6");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const recordToolSchema = z.object({});
		const recordTool: AgentTool<typeof recordToolSchema, undefined> = {
			name: "record",
			label: "Record",
			description: "Record a step",
			parameters: recordToolSchema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: undefined };
			},
		};
		const step = (id: string): MockResponse => ({
			content: [{ type: "toolCall", id, name: "record", arguments: {} }],
			stopReason: "toolUse",
		});
		const mock = createMockModel({
			responses: [step("t1"), step("t2"), { content: ["done"] }],
		});
		const checklistMarker = "grep for every other call site";
		const calls: Array<{ model: string; hasChecklist: boolean }> = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: primary,
				systemPrompt: ["Test"],
				tools: [recordTool as AgentTool],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: (model, context, options) => {
				const hasChecklist = context.messages.some(message => {
					if (message.role !== "user" && message.role !== "developer") return false;
					const content = message.content;
					if (typeof content === "string") return content.includes(checklistMarker);
					return content.some(block => block.type === "text" && block.text.includes(checklistMarker));
				});
				calls.push({ model: `${model.provider}/${model.id}`, hasChecklist });
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([[recordTool.name, recordTool as AgentTool]]),
			// No `plan: true` — checklist must work standalone.
			reasoningSlide: { target, afterTurns: 2, checklist: true },
		});

		await session.prompt("do the task");

		expect(calls.map(call => call.model)).toEqual([
			`${primary.provider}/${primary.id}`,
			`${primary.provider}/${primary.id}`,
			`${target.provider}/${target.id}`,
		]);
		// Absent pre-switch, present only once the target model is running.
		expect(calls.map(call => call.hasChecklist)).toEqual([false, false, true]);
		expect(session.model?.id).toBe(target.id);
	});
});
