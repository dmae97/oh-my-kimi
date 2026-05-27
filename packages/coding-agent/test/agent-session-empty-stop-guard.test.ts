import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { z } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const recordToolSchema = z.object({ value: z.string() });

type Harness = {
	session: AgentSession;
	authStorage: AuthStorage;
	tempDir: TempDir;
};
type SettingsOverrides = Partial<Record<SettingPath, unknown>>;

const activeHarnesses: Harness[] = [];

const recordTool: AgentTool<typeof recordToolSchema, { value: string }> = {
	name: "record",
	label: "Record",
	description: "Record a value",
	parameters: recordToolSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: `recorded:${params.value}` }],
			details: { value: params.value },
		};
	},
};

function recordCall(value: string, id: string): MockResponse {
	return {
		content: [{ type: "toolCall", id, name: "record", arguments: { value } }],
		stopReason: "toolUse",
	};
}

function emptyStop(): MockResponse {
	return {
		content: [],
		stopReason: "stop",
		usage: { output: 1, cacheRead: 100 },
	};
}

async function createHarness(
	responses: MockResponse[],
	settingsOverrides: SettingsOverrides = {},
): Promise<Harness & { mock: MockModel }> {
	const tempDir = TempDir.createSync("@pi-empty-stop-guard-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");

	const mock = createMockModel({ responses });
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": false,
		"todo.reminders": false,
		...settingsOverrides,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);

	const sessionManager = SessionManager.inMemory(tempDir.path());
	const tools = [recordTool as AgentTool];
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
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	const harness = { session, authStorage, tempDir };
	activeHarnesses.push(harness);
	return { ...harness, mock };
}

function assistantText(messages: AgentMessage[]): string {
	return messages
		.filter((message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant")
		.flatMap(message => message.content.flatMap(content => (content.type === "text" ? [content.text] : [])))
		.join("\n");
}

function emptyAssistantStops(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter(
		message =>
			message.role === "assistant" &&
			message.stopReason === "stop" &&
			!message.content.some(content => {
				if (content.type === "text") return content.text.trim().length > 0;
				if (content.type === "thinking") return content.thinking.trim().length > 0;
				return content.type === "toolCall";
			}),
	);
}

function reminderMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter(
		message =>
			message.role === "developer" &&
			(typeof message.content === "string"
				? message.content.includes("previous assistant turn ended with no text")
				: message.content.some(
						content =>
							content.type === "text" && content.text.includes("previous assistant turn ended with no text"),
					)),
	);
}

async function expectPromptCompletes(prompt: Promise<void>): Promise<void> {
	await Promise.race([
		prompt,
		Bun.sleep(1_000).then(() => {
			throw new Error("Expected session prompt to settle after empty-stop retry cap");
		}),
	]);
}

afterEach(async () => {
	for (const harness of activeHarnesses.splice(0)) {
		await harness.session.dispose();
		harness.authStorage.close();
		harness.tempDir.removeSync();
	}
	vi.restoreAllMocks();
});

describe("AgentSession empty stop guard", () => {
	it("retries an empty assistant stop after a tool result", async () => {
		const { session, mock } = await createHarness([
			recordCall("alpha", "call-record-alpha"),
			emptyStop(),
			{ content: ["finished after retry"], stopReason: "stop" },
		]);

		await session.prompt("record alpha");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(3);
		expect(assistantText(session.agent.state.messages)).toContain("finished after retry");
		expect(emptyAssistantStops(session.agent.state.messages)).toHaveLength(0);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);

		const activeBranchMessages = session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as AgentMessage);
		expect(emptyAssistantStops(activeBranchMessages)).toHaveLength(0);
		expect(
			emptyAssistantStops(
				session.sessionManager
					.getEntries()
					.filter(entry => entry.type === "message")
					.map(entry => entry.message as AgentMessage),
			),
		).toHaveLength(1);
	});

	it("caps empty stop retries at three attempts", async () => {
		const { session, mock } = await createHarness([
			recordCall("beta", "call-record-beta"),
			emptyStop(),
			emptyStop(),
			emptyStop(),
			emptyStop(),
		]);

		await session.prompt("record beta");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(5);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(3);
		expect(emptyAssistantStops(session.agent.state.messages)).toHaveLength(1);

		const activeBranchMessages = session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as AgentMessage);
		expect(emptyAssistantStops(activeBranchMessages)).toHaveLength(1);
	});

	it("resolves outstanding auto-retry wait when empty stop retries hit the cap", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { session, mock } = await createHarness(
			[{ throw: "503 service unavailable: overloaded_error" }, emptyStop(), emptyStop(), emptyStop(), emptyStop()],
			{
				"retry.enabled": true,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 5_000,
			},
		);

		await expectPromptCompletes(session.prompt("recover from transient error"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(5);
		expect(session.isRetrying).toBe(false);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(3);
		expect(emptyAssistantStops(session.agent.state.messages)).toHaveLength(1);
	});

	it("does not retry normal stop or tool-use turns", async () => {
		const normal = await createHarness([{ content: ["already done"], stopReason: "stop" }]);

		await normal.session.prompt("answer normally");
		await normal.session.waitForIdle();

		expect(normal.mock.calls).toHaveLength(1);
		expect(reminderMessages(normal.session.agent.state.messages)).toHaveLength(0);

		const withTool = await createHarness([
			recordCall("gamma", "call-record-gamma"),
			{ content: ["tool path complete"], stopReason: "stop" },
		]);

		await withTool.session.prompt("record gamma");
		await withTool.session.waitForIdle();

		expect(withTool.mock.calls).toHaveLength(2);
		expect(reminderMessages(withTool.session.agent.state.messages)).toHaveLength(0);
		expect(assistantText(withTool.session.agent.state.messages)).toContain("tool path complete");
	});
});
