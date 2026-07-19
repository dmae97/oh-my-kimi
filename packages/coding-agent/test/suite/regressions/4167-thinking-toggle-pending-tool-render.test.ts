import type { AgentMessage } from "omk-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "omk-ai";
import { Container, Text, type TUI } from "omk-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { SessionContext } from "../../../src/core/session-manager.ts";
import type { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

const TOOL_CALL_ID = "tool-4167";
const TOOL_NAME = "slow_tool";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type RenderSessionContextThis = {
	pendingTools: Map<string, ToolExecutionComponent>;
	chatContainer: Container;
	footer: { invalidate(): void };
	ui: TUI;
	settingsManager: {
		getShowImages(): boolean;
		getImageWidthCells(): number;
	};
	sessionManager: { getCwd(): string };
	session: { retryAttempt: number };
	toolOutputExpanded: boolean;
	isInitialized: boolean;
	updateEditorBorderColor(): void;
	getRegisteredToolDefinition(toolName: string): undefined;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
};

type RenderSessionContext = (
	this: RenderSessionContextThis,
	sessionContext: SessionContext,
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

type HandleEvent = (this: RenderSessionContextThis, event: AgentSessionEvent) => Promise<void>;

function createFakeInteractiveModeThis(): RenderSessionContextThis {
	const chatContainer = new Container();
	return {
		pendingTools: new Map<string, ToolExecutionComponent>(),
		chatContainer,
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
		},
		sessionManager: { getCwd: () => process.cwd() },
		session: { retryAttempt: 0 },
		toolOutputExpanded: false,
		isInitialized: true,
		updateEditorBorderColor: vi.fn(),
		getRegisteredToolDefinition: (_toolName: string) => undefined,
		addMessageToChat(message: AgentMessage) {
			chatContainer.addChild(new Text(message.role, 0, 0));
		},
	};
}

function createAssistantToolCallMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: TOOL_CALL_ID,
				name: TOOL_NAME,
				arguments: { delayMs: 10_000 },
			},
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createToolResultMessage(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createSessionContext(messages: AgentMessage[]): SessionContext {
	return {
		messages,
		thinkingLevel: "off",
		model: null,
	};
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}
async function completePendingToolExecution(result: unknown, isError = false) {
	const fakeThis = createFakeInteractiveModeThis();
	const renderSessionContext = (InteractiveMode.prototype as unknown as { renderSessionContext: RenderSessionContext })
		.renderSessionContext;
	const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

	renderSessionContext.call(fakeThis, createSessionContext([createAssistantToolCallMessage()]));

	const component = fakeThis.pendingTools.get(TOOL_CALL_ID);
	if (!component) {
		throw new Error("Expected the rendered tool call to be pending.");
	}
	const updateResult = vi.spyOn(component, "updateResult");

	await handleEvent.call(fakeThis, {
		type: "tool_execution_end",
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		result,
		isError,
	} as AgentSessionEvent);

	return { fakeThis, updateResult };
}

describe("InteractiveMode.renderSessionContext", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("keeps unresolved rendered tool calls registered for live completion events", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionContext = (
			InteractiveMode.prototype as unknown as { renderSessionContext: RenderSessionContext }
		).renderSessionContext;
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		renderSessionContext.call(fakeThis, createSessionContext([createAssistantToolCallMessage()]));

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(true);

		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			result: { content: [{ type: "text", text: "FINAL_RESULT" }], details: undefined },
			isError: false,
		});

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(false);
		expect(renderChat(fakeThis.chatContainer)).toContain("FINAL_RESULT");
	});
	test("preserves valid tool result details and error status", async () => {
		const details = { source: "extension" };
		const result = { content: [{ type: "text" as const, text: "VALID_RESULT" }], details };
		const { fakeThis, updateResult } = await completePendingToolExecution(result, true);

		expect(updateResult).toHaveBeenCalledWith({ content: result.content, details, isError: true });
		expect(renderChat(fakeThis.chatContainer)).toContain("VALID_RESULT");
	});

	test("renders primitive tool results as generic errors", async () => {
		const { fakeThis, updateResult } = await completePendingToolExecution("invalid result");

		expect(updateResult).toHaveBeenCalledWith({
			content: [{ type: "text", text: "Tool returned an invalid result." }],
			isError: true,
		});
		expect(renderChat(fakeThis.chatContainer)).toContain("Tool returned an invalid result.");
	});

	test("renders malformed tool content as a generic error", async () => {
		const { fakeThis, updateResult } = await completePendingToolExecution({
			content: [{ type: "text", text: 42 }],
		});

		expect(updateResult).toHaveBeenCalledWith({
			content: [{ type: "text", text: "Tool returned an invalid result." }],
			isError: true,
		});
		expect(renderChat(fakeThis.chatContainer)).toContain("Tool returned an invalid result.");
	});

	test("contains inaccessible tool result failures behind a generic error", async () => {
		const thrownCause = "extension secret";
		const result = new Proxy(
			{},
			{
				get() {
					throw new Error(thrownCause);
				},
			},
		);
		const { fakeThis, updateResult } = await completePendingToolExecution(result);

		expect(updateResult).toHaveBeenCalledWith({
			content: [{ type: "text", text: "Tool returned an invalid result." }],
			isError: true,
		});
		expect(() => renderChat(fakeThis.chatContainer)).not.toThrow();
		expect(renderChat(fakeThis.chatContainer)).not.toContain(thrownCause);
	});

	test("does not keep completed historical tool calls registered as pending", () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionContext = (
			InteractiveMode.prototype as unknown as { renderSessionContext: RenderSessionContext }
		).renderSessionContext;

		renderSessionContext.call(
			fakeThis,
			createSessionContext([createAssistantToolCallMessage(), createToolResultMessage("HISTORICAL_RESULT")]),
		);

		expect(fakeThis.pendingTools.size).toBe(0);
		expect(renderChat(fakeThis.chatContainer)).toContain("HISTORICAL_RESULT");
	});
});
