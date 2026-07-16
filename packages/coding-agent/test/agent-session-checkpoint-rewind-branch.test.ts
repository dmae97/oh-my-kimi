import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, ThinkingContent } from "@oh-my-pi/pi-ai";
import { z } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockContent, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { RewindTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const checkpointSchema = z.object({ goal: z.string() });
const rewindSchema = z.object({ report: z.string() });

const xdevWriteSchema = z.object({ path: z.string(), content: z.string() });

const xdevWriteTool: AgentTool<typeof xdevWriteSchema, unknown> = {
	name: "write",
	label: "Write",
	description: "Dispatch a write to an xd:// device",
	parameters: xdevWriteSchema,
	async execute(_toolCallId, params) {
		const args = JSON.parse(params.content) as { goal?: string; report?: string };
		const tool = params.path === "xd://checkpoint" ? "checkpoint" : "rewind";
		const inner =
			tool === "checkpoint"
				? { goal: args.goal, startedAt: "2026-01-01T00:00:00.000Z" }
				: { report: args.report, rewound: true };
		return {
			content: [{ type: "text" as const, text: `${tool} via xdev` }],
			details: {
				xdev: {
					tool,
					mode: "execute",
					args,
					inner,
				},
			},
		};
	},
};

const checkpointTool: AgentTool<typeof checkpointSchema, { startedAt: string }> = {
	name: "checkpoint",
	label: "Checkpoint",
	description: "Create a checkpoint",
	parameters: checkpointSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text" as const, text: `checkpoint:${params.goal}` }],
			details: { startedAt: "2026-01-01T00:00:00.000Z" },
		};
	},
};

const rewindTool: AgentTool<typeof rewindSchema, { report: string; rewound: boolean }> = {
	name: "rewind",
	label: "Rewind",
	description: "Rewind to the checkpoint",
	parameters: rewindSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text" as const, text: "rewind requested" }],
			details: { report: params.report, rewound: true },
		};
	},
};

type Harness = {
	session: AgentSession;
	authStorage: AuthStorage;
	extraSessions: AgentSession[];
	tempDir: TempDir;
};

const activeHarnesses: Harness[] = [];

afterEach(async () => {
	while (activeHarnesses.length > 0) {
		const harness = activeHarnesses.pop();
		for (const extraSession of harness?.extraSessions ?? []) {
			await extraSession.dispose();
		}
		await harness?.session.dispose();
		harness?.authStorage.close();
		harness?.tempDir.removeSync();
	}
});

function signedThinking(thinking: string, thinkingSignature: string): MockContent {
	return { type: "thinking", thinking, thinkingSignature } as unknown as MockContent;
}

async function createHarness(
	responses: MockResponse[],
	tools: AgentTool[] = [checkpointTool as AgentTool, rewindTool as AgentTool],
): Promise<Harness & { mock: MockModel }> {
	const tempDir = TempDir.createSync("@pi-checkpoint-rewind-branch-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");

	const mock = createMockModel({ responses });
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": "default",
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});

	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	const harness = { session, authStorage, tempDir, extraSessions: [] };
	activeHarnesses.push(harness);
	return { ...harness, mock };
}

function messageText(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

function expectLastAssistant(messages: AgentMessage[]): AssistantMessage {
	const message = messages.at(-1);
	expect(message?.role).toBe("assistant");
	if (message?.role !== "assistant") throw new Error("Expected last message to be assistant");
	return message;
}
function createToolSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function rewindToolForSession(session: AgentSession): RewindTool {
	return new RewindTool(
		createToolSession({
			getCheckpointState: () => session.getCheckpointState(),
			getLastCompletedRewind: () => session.getLastCompletedRewind(),
		}),
	);
}

async function expectNoActiveCheckpointError(session: AgentSession): Promise<void> {
	await expect(rewindToolForSession(session).execute("repeat_rewind", { report: "retry" })).rejects.toThrow(
		"No active checkpoint. Create a checkpoint before calling rewind.",
	);
}

describe("AgentSession checkpoint rewind branch context", () => {
	it("rebuilds active history through branch_summary before the post-rewind assistant turn", async () => {
		const report = "findings: kept checkpoint; risks: stale signed thinking";
		const { session, mock } = await createHarness([
			{
				content: [
					signedThinking("checkpoint before exploring", "sig_checkpoint"),
					{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } },
				],
				stopReason: "toolUse",
			},
			{
				content: [
					signedThinking("ready to rewind", "sig_rewind"),
					{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report } },
				],
				stopReason: "toolUse",
			},
			{
				content: [signedThinking("answer after rewind", "sig_after_rewind"), "DONE"],
				stopReason: "stop",
			},
		]);

		await session.prompt("investigate with a checkpoint");

		expect(mock.calls.length).toBe(3);
		const finalCall = mock.calls[2];
		if (!finalCall) throw new Error("Expected final post-rewind provider call");
		const summaryIndex = finalCall.context.messages.findIndex(
			message => message.role === "user" && messageText(message).includes("summary of a branch"),
		);
		const reportIndex = finalCall.context.messages.findIndex(
			message => message.role === "developer" && messageText(message).includes(report),
		);
		expect(summaryIndex).toBeGreaterThan(-1);
		expect(reportIndex).toBeGreaterThan(summaryIndex);
		const reportMessage = finalCall.context.messages[reportIndex];
		if (!reportMessage) throw new Error("Expected rewind report context");
		const reportText = messageText(reportMessage);
		expect(reportText).toContain("Checkpoint completed.");
		expect(reportText).toContain("Do not call `rewind` again");
		expect(reportText).toContain(report);

		expect(
			finalCall.context.messages.some(message => message.role === "toolResult" && message.toolName === "rewind"),
		).toBe(false);

		const activeRoles = session.messages.map(message => message.role);
		expect(activeRoles).toEqual(["user", "assistant", "toolResult", "branchSummary", "custom", "assistant"]);
		expect(activeRoles).toEqual(session.sessionManager.buildSessionContext().messages.map(message => message.role));

		const finalAssistant = expectLastAssistant(session.messages);
		const finalThinking = finalAssistant.content.find((block): block is ThinkingContent => block.type === "thinking");
		expect(finalThinking?.thinking).toBe("answer after rewind");
		expect(finalThinking?.thinkingSignature).toBe("sig_after_rewind");
	});

	it("tracks checkpoint and rewind through execute xdev write results", async () => {
		const report = "findings: xdev wrapper";
		const { session } = await createHarness(
			[
				{
					content: [
						{
							type: "toolCall",
							id: "call_checkpoint_xdev",
							name: "write",
							arguments: {
								path: "xd://checkpoint",
								content: JSON.stringify({ goal: "inspect" }),
							},
						},
					],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "call_rewind_xdev",
							name: "write",
							arguments: {
								path: "xd://rewind",
								content: JSON.stringify({ report }),
							},
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
			[xdevWriteTool],
		);

		await session.prompt("investigate with an xdev checkpoint");

		expect(session.getLastCompletedRewind()).toEqual({
			report,
			startedAt: "2026-01-01T00:00:00.000Z",
			rewoundAt: expect.any(String),
		});
	});

	it("rehydrates completed rewind state from the retained report on resume", async () => {
		const report = "findings: retained after resume";
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report } }],
				stopReason: "toolUse",
			},
			{
				content: ["DONE"],
				stopReason: "stop",
			},
		]);

		await harness.session.prompt("investigate with a checkpoint");

		const reloadedMock = createMockModel({ responses: [] });
		const reloadedSettings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});
		reloadedSettings.setModelRole("default", `${reloadedMock.provider}/${reloadedMock.id}`);
		const reloadedTools = [checkpointTool as AgentTool, rewindTool as AgentTool];
		const reloadedAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: reloadedMock,
				systemPrompt: ["Test"],
				tools: reloadedTools,
				messages: harness.session.sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: reloadedMock.stream,
		});
		const reloadedSession = new AgentSession({
			agent: reloadedAgent,
			sessionManager: harness.session.sessionManager,
			settings: reloadedSettings,
			modelRegistry: new ModelRegistry(
				harness.authStorage,
				path.join(harness.tempDir.path(), "models-reloaded.yml"),
			),
			toolRegistry: new Map(reloadedTools.map(tool => [tool.name, tool])),
		});
		harness.extraSessions.push(reloadedSession);

		expect(reloadedSession.getLastCompletedRewind()).toEqual({
			report,
			startedAt: "2026-01-01T00:00:00.000Z",
			rewoundAt: expect.any(String),
		});
		const tool = new RewindTool(
			createToolSession({
				getLastCompletedRewind: () => reloadedSession.getLastCompletedRewind(),
			}),
		);
		await expect(tool.execute("repeat_rewind", { report: "retry" })).rejects.toThrow(
			"Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.",
		);
	});

	it("clears completed rewind state when starting a new session", async () => {
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report: "findings" } }],
				stopReason: "toolUse",
			},
			{
				content: ["DONE"],
				stopReason: "stop",
			},
		]);

		await harness.session.prompt("investigate with a checkpoint");
		expect(harness.session.getLastCompletedRewind()).toBeDefined();

		await harness.session.newSession();

		expect(harness.session.getLastCompletedRewind()).toBeUndefined();
		await expectNoActiveCheckpointError(harness.session);
	});

	it("rehydrates completed rewind state from the branched path", async () => {
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report: "findings" } }],
				stopReason: "toolUse",
			},
			{
				content: ["DONE"],
				stopReason: "stop",
			},
		]);

		await harness.session.prompt("investigate with a checkpoint");
		expect(harness.session.getLastCompletedRewind()).toBeDefined();
		const userEntry = harness.session.sessionManager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (!userEntry) throw new Error("Expected user entry for branch");

		await harness.session.branch(userEntry.id);

		expect(harness.session.getLastCompletedRewind()).toBeUndefined();
		await expectNoActiveCheckpointError(harness.session);
	});
	it("tells the model to continue when rewind is repeated after completion", async () => {
		const tool = new RewindTool(
			createToolSession({
				getLastCompletedRewind: () => ({
					report: "findings retained",
					startedAt: "2026-01-01T00:00:00.000Z",
					rewoundAt: "2026-01-01T00:01:00.000Z",
				}),
			}),
		);

		await expect(tool.execute("repeat_rewind", { report: "retry" })).rejects.toThrow(
			"Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.",
		);
	});

	it("rehydrates active checkpoint state when resuming a session with no rewind yet", async () => {
		const startedAt = "2026-01-01T00:00:00.000Z";
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report: "findings" } }],
				stopReason: "toolUse",
			},
			{
				content: ["DONE"],
				stopReason: "stop",
			},
		]);
		await harness.session.prompt("investigate with a checkpoint");
		const originalCompleted = harness.session.getLastCompletedRewind();
		expect(originalCompleted).toBeDefined();

		// Simulate "run aborted between checkpoint and rewind" by branching to the
		// checkpoint entry itself — the rewind and its rewind-report entry drop off
		// the active branch, leaving the checkpoint tool result as the leaf.
		const branch = harness.session.sessionManager.getBranch();
		const checkpointEntry = branch.find(
			entry =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "checkpoint",
		);
		if (!checkpointEntry) throw new Error("Expected checkpoint tool result entry");
		harness.session.sessionManager.branch(checkpointEntry.id);

		const reloadedMock = createMockModel({ responses: [] });
		const reloadedSettings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});
		reloadedSettings.setModelRole("default", `${reloadedMock.provider}/${reloadedMock.id}`);
		const reloadedTools = [checkpointTool as AgentTool, rewindTool as AgentTool];
		const reloadedAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: reloadedMock,
				systemPrompt: ["Test"],
				tools: reloadedTools,
				messages: harness.session.sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: reloadedMock.stream,
		});
		const reloadedSession = new AgentSession({
			agent: reloadedAgent,
			sessionManager: harness.session.sessionManager,
			settings: reloadedSettings,
			modelRegistry: new ModelRegistry(
				harness.authStorage,
				path.join(harness.tempDir.path(), "models-reloaded.yml"),
			),
			toolRegistry: new Map(reloadedTools.map(tool => [tool.name, tool])),
		});
		harness.extraSessions.push(reloadedSession);

		const restored = reloadedSession.getCheckpointState();
		expect(restored).toBeDefined();
		expect(restored?.checkpointEntryId).toBe(checkpointEntry.id);
		expect(restored?.startedAt).toBe(startedAt);
		expect(reloadedSession.getLastCompletedRewind()).toBeUndefined();

		// The rewind tool must accept the request now that the active checkpoint
		// has been re-hydrated — previously this threw "No active checkpoint".
		const rewindResult = await rewindToolForSession(reloadedSession).execute("call_rewind_after_resume", {
			report: "post-resume findings",
		});
		expect(rewindResult.content.some(part => part.type === "text" && part.text.includes("Rewind requested"))).toBe(
			true,
		);
	});
	it("rehydrates an active checkpoint from an xdev write after branching and resume", async () => {
		const harness = await createHarness(
			[
				{
					content: [
						{
							type: "toolCall",
							id: "call_checkpoint_xdev",
							name: "write",
							arguments: {
								path: "xd://checkpoint",
								content: JSON.stringify({ goal: "inspect" }),
							},
						},
					],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "call_rewind_xdev",
							name: "write",
							arguments: {
								path: "xd://rewind",
								content: JSON.stringify({ report: "findings" }),
							},
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
			[xdevWriteTool],
		);
		await harness.session.prompt("investigate with an xdev checkpoint");

		const checkpointEntry = harness.session.sessionManager.getBranch().find(entry => {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "write") {
				return false;
			}
			const details = entry.message.details as { xdev?: { tool?: string } } | undefined;
			return details?.xdev?.tool === "checkpoint";
		});
		if (!checkpointEntry) throw new Error("Expected xdev checkpoint tool result entry");
		harness.session.sessionManager.branch(checkpointEntry.id);

		const reloadedMock = createMockModel({ responses: [] });
		const reloadedSettings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});
		reloadedSettings.setModelRole("default", `${reloadedMock.provider}/${reloadedMock.id}`);
		const reloadedTools = [xdevWriteTool as AgentTool];
		const reloadedAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: reloadedMock,
				systemPrompt: ["Test"],
				tools: reloadedTools,
				messages: harness.session.sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: reloadedMock.stream,
		});
		const reloadedSession = new AgentSession({
			agent: reloadedAgent,
			sessionManager: harness.session.sessionManager,
			settings: reloadedSettings,
			modelRegistry: new ModelRegistry(
				harness.authStorage,
				path.join(harness.tempDir.path(), "models-xdev-reloaded.yml"),
			),
			toolRegistry: new Map(reloadedTools.map(tool => [tool.name, tool])),
		});
		harness.extraSessions.push(reloadedSession);

		expect(reloadedSession.getCheckpointState()).toMatchObject({
			checkpointEntryId: checkpointEntry.id,
			startedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(reloadedSession.getLastCompletedRewind()).toBeUndefined();
		await expect(rewindToolForSession(reloadedSession).execute("call_rewind_after_xdev_resume", {
			report: "post-resume findings",
		})).resolves.toMatchObject({ details: { report: "post-resume findings", rewound: true } });
	});

});
