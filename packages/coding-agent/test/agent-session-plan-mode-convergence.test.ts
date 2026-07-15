/**
 * Contract: plan mode converges on `ask`/`write xd://propose` regardless of how a turn
 * ends, and non-user producers cannot keep it spinning.
 *
 *  T1. An advisor concern in plan mode is recorded as a visible card but never
 *      wakes an autonomous primary turn.
 *  T2. An idle IRC message in plan mode is folded into context ("injected"),
 *      not woken.
 *  T3. A plan-mode turn that stops without a decision tool call is reminded at the
 *      terminal settle, bounded by PLAN_MODE_REMINDER_MAX (then yields to the
 *      user), and either decision tool resets the counter.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus, type IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import planModeReminderPrompt from "../src/prompts/system/plan-mode-tool-decision-reminder.md" with { type: "text" };

/** A stable, literal (non-templated) line of the reminder prompt, so the test
 *  pins the reminder by its real content rather than a hardcoded copy. */
function deriveReminderFragment(template: string): string {
	const line = template
		.split("\n")
		.map(l => l.trim())
		.find(l => l.length > 20 && !l.includes("{{"));
	if (!line) throw new Error("plan-mode reminder template is missing a stable marker line");
	return line;
}
const REMINDER_FRAGMENT = deriveReminderFragment(planModeReminderPrompt);

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

/** Concatenate the text blocks of a message (string or content-array). */
function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function countReminders(messages: readonly AgentMessage[]): number {
	return messages.filter(m => m.role === "developer" && messageText(m).includes(REMINDER_FRAGMENT)).length;
}

interface PlanHarness {
	session: AgentSession;
	mock: MockModel;
	advisorMock?: MockModel;
	sideMock?: MockModel;
}

describe("AgentSession plan-mode convergence", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-plan-converge-");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			for (const authStorage of authStorages.splice(0)) authStorage.close();
			await tempDir?.remove();
		}
	});

	async function createPlanSession(
		responses: MockResponse[],
		options?: { advisorResponses?: MockResponse[]; sideResponses?: MockResponse[] },
	): Promise<PlanHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");

		const askTool = makeTool("ask");
		const writeTool = makeTool("write");
		const readTool = makeTool("read");

		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			// All three tools active so a scripted ask/write/read call (and a
			// forced "required" choice) can actually execute (isToolChoiceActive).
			initialState: { model, systemPrompt: ["Test"], tools: [askTool, writeTool, readTool], messages: [] },
			streamFn: mock.stream,
		});

		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join(`models-${Snowflake.next()}.yml`));

		let advisorMock: MockModel | undefined;
		let advisorStreamFn: StreamFn | undefined;
		if (options?.advisorResponses) {
			advisorMock = createMockModel({ responses: options.advisorResponses });
			advisorStreamFn = advisorMock.stream;
		}

		let sideMock: MockModel | undefined;
		let sideStreamFn: StreamFn | undefined;
		if (options?.sideResponses) {
			sideMock = createMockModel({ responses: options.sideResponses });
			sideStreamFn = sideMock.stream;
		}

		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
			}),
			modelRegistry,
			toolRegistry: new Map<string, AgentTool>([
				["ask", askTool],
				["write", writeTool],
				["read", readTool],
			]),
			builtInToolNames: ["ask", "write", "read"],
			advisorTools: [],
			advisorStreamFn,
			sideStreamFn,
		});
		created.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		session = created;
		return { session: created, mock, advisorMock, sideMock };
	}

	it("T1: an advisor concern does not wake the primary in plan mode", async () => {
		const harness = await createPlanSession([], {
			advisorResponses: [
				{
					content: [
						{ type: "toolCall", name: "advise", arguments: { note: "tighten the plan", severity: "concern" } },
					],
				},
			],
		});
		harness.session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(harness.session.setAdvisorEnabled(true)).toBe(true);
		const advisor = harness.session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		await advisor.prompt("inspect current turn").catch(() => {});
		await harness.session.waitForIdle();

		const advisorCards = harness.session.agent.state.messages.filter(
			m => m.role === "custom" && m.customType === "advisor",
		);
		expect(advisorCards.length).toBeGreaterThanOrEqual(1);
		expect(harness.mock.calls.length).toBe(0);
		expect(harness.advisorMock?.calls.length ?? 0).toBeGreaterThanOrEqual(1);
	});

	it("T2: an idle IRC message does not wake an autonomous turn in plan mode", async () => {
		const harness = await createPlanSession([]);
		const msg: IrcMessage = { id: "m1", from: "peer", to: "me", body: "ping", ts: Date.now() };

		const outcome = await harness.session.deliverIrcMessage(msg);

		expect(outcome).toBe("injected");
		const sawIrc = harness.session.agent.state.messages.some(
			m => m.role === "custom" && m.customType === "irc:incoming",
		);
		expect(sawIrc).toBe(true);
		expect(harness.mock.calls.length).toBe(0);
	});

	it("T2b: an awaited idle IRC message gets a side-channel auto-reply without waking a turn", async () => {
		const harness = await createPlanSession([], {
			sideResponses: [{ content: ["still planning — full reply once the plan settles"] }],
		});
		const registry = AgentRegistry.global();
		registry.register({ id: "peer", displayName: "peer", kind: "sub", session: null, status: "running" });
		try {
			const bus = IrcBus.global();
			const replyPromise = bus.wait("peer", { from: "me" }, 0);
			const msg: IrcMessage = { id: "m2", from: "peer", to: "me", body: "blocked on you — status?", ts: Date.now() };

			const outcome = await harness.session.deliverIrcMessage(msg, { expectsReply: true });
			expect(outcome).toBe("injected");

			const reply = await replyPromise;
			expect(reply?.replyTo).toBe("m2");
			expect(reply?.body).toContain("still planning");
			expect(harness.sideMock?.calls.length).toBe(1);
			expect(harness.mock.calls.length).toBe(0);
			expect(harness.session.agent.state.messages.some(m => m.role === "assistant")).toBe(false);
		} finally {
			registry.unregister("peer");
		}
	});

	it("T3a: convergence reminders are bounded by the cap, then yield to the user", async () => {
		const harness = await createPlanSession([
			{ content: ["planning A"] },
			{ content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }] },
			{ content: ["planning B"] },
			{ content: [{ type: "toolCall", name: "read", arguments: { path: "b" } }] },
			{ content: ["planning C"] },
			{ content: [{ type: "toolCall", name: "read", arguments: { path: "c" } }] },
			{ content: ["planning D"] },
		]);

		harness.session.setTodoPhases([{ name: "Plan", tasks: [{ content: "draft the plan", status: "pending" }] }]);

		await harness.session.prompt("make a plan");
		await harness.session.waitForIdle();

		expect(countReminders(harness.session.agent.state.messages)).toBe(3);
		expect(harness.mock.calls.length).toBe(7);
		expect(harness.session.getPlanModeState()?.enabled).toBe(true);
	});

	it("T3b: a propose write resets the convergence counter", async () => {
		const harness = await createPlanSession([
			{ content: ["planning A"] },
			{
				content: [
					{
						type: "toolCall",
						name: "write",
						arguments: {
							path: "xd://propose",
							content: "test-reset",
						},
					},
				],
			},
			{ content: ["planning B"] },
			{ content: ["planning C"] },
		]);

		await harness.session.prompt("make a plan");
		await harness.session.waitForIdle();

		expect(countReminders(harness.session.agent.state.messages)).toBe(2);
		expect(harness.mock.calls.length).toBe(4);
	});

	it("T3c: an ask call resets the convergence counter", async () => {
		const harness = await createPlanSession([
			{ content: ["planning A"] },
			{
				content: [
					{
						type: "toolCall",
						name: "ask",
						arguments: {
							questions: [
								{ id: "q", question: "which?", options: [{ label: "a" }, { label: "b" }], recommended: 0 },
							],
						},
					},
				],
			},
			{ content: ["planning B"] },
			{ content: ["planning C"] },
		]);

		await harness.session.prompt("make a plan");
		await harness.session.waitForIdle();

		expect(countReminders(harness.session.agent.state.messages)).toBe(2);
		expect(harness.mock.calls.length).toBe(4);
	});
});
