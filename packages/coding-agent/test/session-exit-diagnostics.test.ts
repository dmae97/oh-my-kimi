import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	collectPendingToolCalls,
	describePendingToolCalls,
	SESSION_EXIT_CUSTOM_TYPE,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
	type ToolExecutionStartData,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const pendingAssistant: AssistantMessage = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "toolu_repro",
			name: "bash",
			arguments: { command: "bun run check:ts" },
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "mock",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: Date.now(),
};

describe("session exit diagnostics", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("records a durable tool start marker and shutdown diagnostic before a pending result exists", async () => {
		tempDir = TempDir.createSync("@pi-session-exit-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		agent.emitExternalEvent({ type: "message_end", message: pendingAssistant });
		await Promise.resolve();
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});
		await Promise.resolve();

		const marker = sessionManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE);
		if (marker?.type !== "custom") throw new Error("Expected tool execution start marker");
		expect(marker.data).toMatchObject({
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});

		const pending = collectPendingToolCalls(sessionManager.getBranch());
		expect(pending).toMatchObject([
			{
				toolCallId: "toolu_repro",
				toolName: "bash",
				args: { command: "bun run check:ts" },
			},
		]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toContain("bun run check:ts");

		await session.dispose();
		session = undefined;
		const exitEntry = sessionManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
		if (exitEntry?.type !== "custom") throw new Error("Expected session exit marker");
		expect(exitEntry.data).toMatchObject({
			reason: "dispose",
			kind: "normal",
			pendingToolCalls: [
				{
					toolCallId: "toolu_repro",
					toolName: "bash",
					args: { command: "bun run check:ts" },
				},
			],
		});
	});

	it("treats assistant tool calls as pending even when stopReason is not toolUse", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ ...pendingAssistant, stopReason: "stop" });

		expect(collectPendingToolCalls(sessionManager.getBranch())).toMatchObject([
			{
				toolCallId: "toolu_repro",
				toolName: "bash",
				args: { command: "bun run check:ts" },
			},
		]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toContain("bun run check:ts");
	});

	it("clears the pending warning once the matching tool result is recorded", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
			startedAt: new Date().toISOString(),
		} satisfies ToolExecutionStartData);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_repro",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		});

		expect(collectPendingToolCalls(sessionManager.getBranch())).toEqual([]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toBeUndefined();
	});
});
