import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { z } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as unexpectedStopClassifier from "@oh-my-pi/pi-coding-agent/session/unexpected-stop-classifier";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

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

function unexpectedStop(text: string): MockResponse {
	return {
		content: [{ type: "text", text }],
		stopReason: "stop",
	};
}

async function createHarness(
	responses: MockResponse[],
	settingsOverrides: SettingsOverrides = {},
): Promise<Harness & { mock: MockModel }> {
	const tempDir = TempDir.createSync("@pi-unexpected-stop-guard-");
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
		.flatMap(message =>
			Array.isArray(message.content)
				? message.content.flatMap(content => (content.type === "text" ? [content.text] : []))
				: [],
		)
		.join("\n");
}

function reminderMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter((message): message is Extract<AgentMessage, { role: "developer" }> => {
		if (message.role !== "developer") return false;
		const text =
			(typeof message.content === "string"
				? message.content
				: message.content.find((content): content is { type: "text"; text: string } => content.type === "text")
						?.text) ?? "";
		return text.includes("You said you would continue");
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of activeHarnesses) {
		await harness.session.dispose();
		harness.authStorage.close();
		harness.tempDir.remove();
	}
	activeHarnesses.length = 0;
});

describe("AgentSession unexpected stop guard", () => {
	it("does not classify when the feature is disabled", async () => {
		const spy = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(true);
		const { session, mock } = await createHarness([
			unexpectedStop("I should apply the same fix to the JS eval worker. Doing that now."),
		]);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});

	it("schedules a continuation when the classifier returns true", async () => {
		let calls = 0;
		const spy = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockImplementation(async () => {
			calls++;
			return calls === 1;
		});
		const { session, mock } = await createHarness(
			[
				unexpectedStop("I should apply the same fix to the JS eval worker. Doing that now."),
				{ content: ["done now"], stopReason: "stop" },
			],
			{
				"features.unexpectedStopDetection": true,
				"providers.unexpectedStopModel": "online",
			},
		);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).toHaveBeenCalledTimes(2);
		expect(mock.calls).toHaveLength(2);
		expect(assistantText(session.agent.state.messages)).toContain("done now");
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
	});

	it("does not continue when the classifier returns false", async () => {
		const spy = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(false);
		const { session, mock } = await createHarness(
			[unexpectedStop("I should apply the same fix to the JS eval worker. Doing that now.")],
			{
				"features.unexpectedStopDetection": true,
				"providers.unexpectedStopModel": "online",
			},
		);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).toHaveBeenCalledTimes(1);
		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});

	it("caps unexpected stop retries at three attempts", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const spy = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(true);
		const { session, mock } = await createHarness(
			[
				unexpectedStop("I should fix this next."),
				unexpectedStop("I should fix this next."),
				unexpectedStop("I should fix this next."),
				unexpectedStop("I should fix this next."),
			],
			{
				"features.unexpectedStopDetection": true,
				"providers.unexpectedStopModel": "online",
			},
		);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).toHaveBeenCalledTimes(4);
		expect(mock.calls).toHaveLength(4);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(3);
		expect(warnSpy).toHaveBeenCalled();
	});

	it("does not classify a message that contains a tool call", async () => {
		const spy = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(false);
		const { session, mock } = await createHarness(
			[recordCall("alpha", "call-record-alpha"), { content: ["tool path complete"], stopReason: "aborted" }],
			{
				"features.unexpectedStopDetection": true,
				"providers.unexpectedStopModel": "online",
			},
		);

		await session.prompt("record alpha");
		await session.waitForIdle();

		expect(spy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(2);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});

	it("does not classify a stop whose reason is not stop", async () => {
		const spy = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(true);
		const { session, mock } = await createHarness(
			[{ content: ["I should continue but hit the length limit"], stopReason: "length" }],
			{
				"features.unexpectedStopDetection": true,
				"providers.unexpectedStopModel": "online",
			},
		);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});
});
