import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function createContext() {
	const setEagerNativeScrollbackRebuild = vi.fn();
	const pendingTools = new Map<string, unknown>();
	const chatContainer = { addChild: vi.fn(), removeChild: vi.fn() };
	const ctx = {
		isInitialized: true,
		isBackgrounded: false,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		pendingTools,
		chatContainer,
		hideThinkingBlock: false,
		editor: { getText: vi.fn(() => "") },
		flushPendingModelSwitch: vi.fn(),
		session: {
			agent: { state: { messages: [] } },
			isCompacting: false,
			isTtsrAbortPending: false,
			retryAttempt: 0,
		},
		ui: { setEagerNativeScrollbackRebuild, requestRender: vi.fn() },
	} as unknown as InteractiveModeContext;
	return { ctx, pendingTools, setEagerNativeScrollbackRebuild };
}

// A tool_execution_update for an id that is not pending is a no-op in its handler,
// so dispatching it exercises only the gated post-dispatch refresh in handleEvent —
// which is what syncs the TUI eager-rebuild flag to foreground-tool activity.
const REFRESH_TRIGGER = {
	type: "tool_execution_update",
	toolCallId: "not-pending",
	partialResult: { content: [], details: {} },
} as unknown as AgentSessionEvent;

const ASSISTANT_MESSAGE = {
	role: "assistant",
	content: [{ type: "text", text: "" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "test-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
} as const;

describe("EventController tool render mode", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("enables eager native scrollback rebuild while a foreground tool is pending", async () => {
		const { ctx, pendingTools, setEagerNativeScrollbackRebuild } = createContext();
		const controller = new EventController(ctx);

		pendingTools.set("call-1", {});
		await controller.handleEvent(REFRESH_TRIGGER);
		expect(setEagerNativeScrollbackRebuild).toHaveBeenLastCalledWith(true);

		pendingTools.clear();
		await controller.handleEvent(REFRESH_TRIGGER);
		expect(setEagerNativeScrollbackRebuild).toHaveBeenLastCalledWith(false);
	});

	it("enables eager native scrollback rebuild while assistant text is streaming", async () => {
		const { ctx, setEagerNativeScrollbackRebuild } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "message_start",
			message: ASSISTANT_MESSAGE,
		} as unknown as AgentSessionEvent);
		expect(setEagerNativeScrollbackRebuild).toHaveBeenLastCalledWith(true);

		await controller.handleEvent({ type: "message_end", message: ASSISTANT_MESSAGE } as unknown as AgentSessionEvent);
		expect(setEagerNativeScrollbackRebuild).toHaveBeenLastCalledWith(false);
	});

	it("resets eager native scrollback rebuild when a stream ends without assistant message_end", async () => {
		const { ctx, setEagerNativeScrollbackRebuild } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "message_start",
			message: ASSISTANT_MESSAGE,
		} as unknown as AgentSessionEvent);
		expect(setEagerNativeScrollbackRebuild).toHaveBeenLastCalledWith(true);

		await controller.handleEvent({ type: "agent_end" } as unknown as AgentSessionEvent);
		expect(setEagerNativeScrollbackRebuild).toHaveBeenLastCalledWith(false);
	});
});
