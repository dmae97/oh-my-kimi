import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	EventController,
	INTERRUPTING_WORKING_MESSAGE,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function createContext() {
	const setWorkingMessage = vi.fn();
	const pendingTools = new Map<string, unknown>();
	const ctx = {
		isInitialized: true,
		settings: { get: () => false },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		pendingTools,
		hideThinkingBlock: false,
		setWorkingMessage,
		clearPinnedError: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
		ui: { requestRender: vi.fn() },
		session: { getToolByName: () => undefined },
	} as unknown as InteractiveModeContext;
	return { ctx, pendingTools, setWorkingMessage };
}

const AGENT_START = { type: "agent_start" } as unknown as AgentSessionEvent;

/** A `tool_execution_start` whose toolCallId is pre-seeded into `pendingTools`,
 *  so the handler only runs the intent->working-message path and skips component
 *  construction (which needs far heavier mocks). */
function toolStartWithIntent(toolCallId: string, intent: string): AgentSessionEvent {
	return {
		type: "tool_execution_start",
		toolCallId,
		toolName: "search",
		args: {},
		intent,
	} as unknown as AgentSessionEvent;
}

describe("EventController user interrupt acknowledgement", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("swaps the loader to the interrupting label once a turn is active", async () => {
		const { ctx, setWorkingMessage } = createContext();
		const controller = new EventController(ctx);
		await controller.handleEvent(AGENT_START);

		controller.notifyInterrupting();

		expect(setWorkingMessage).toHaveBeenCalledWith(INTERRUPTING_WORKING_MESSAGE);
	});

	it("freezes intent-driven working-message updates while interrupting", async () => {
		const { ctx, pendingTools, setWorkingMessage } = createContext();
		const controller = new EventController(ctx);
		await controller.handleEvent(AGENT_START);
		controller.notifyInterrupting();
		setWorkingMessage.mockClear();

		// A tool whose args already started streaming before the abort still emits a
		// late tool_execution_start; without the freeze its intent would repaint the
		// loader over the "Interrupting…" acknowledgement.
		pendingTools.set("late-call", {});
		await controller.handleEvent(toolStartWithIntent("late-call", "Reticulating splines"));

		expect(setWorkingMessage).not.toHaveBeenCalled();
	});

	it("lets intent updates drive the loader when not interrupting", async () => {
		const { ctx, pendingTools, setWorkingMessage } = createContext();
		const controller = new EventController(ctx);
		await controller.handleEvent(AGENT_START);
		setWorkingMessage.mockClear();

		pendingTools.set("call-1", {});
		await controller.handleEvent(toolStartWithIntent("call-1", "Searching files"));

		expect(setWorkingMessage).toHaveBeenCalledTimes(1);
		expect(setWorkingMessage.mock.calls[0]?.[0]).toContain("Searching files");
	});

	it("clears the interrupt freeze at the next agent_start", async () => {
		const { ctx, pendingTools, setWorkingMessage } = createContext();
		const controller = new EventController(ctx);
		await controller.handleEvent(AGENT_START);
		controller.notifyInterrupting();

		// New turn: the freeze must lift so the next turn's intents render again.
		await controller.handleEvent(AGENT_START);
		setWorkingMessage.mockClear();

		pendingTools.set("call-2", {});
		await controller.handleEvent(toolStartWithIntent("call-2", "Editing module"));

		expect(setWorkingMessage).toHaveBeenCalledTimes(1);
		expect(setWorkingMessage.mock.calls[0]?.[0]).toContain("Editing module");
	});

	it("is a no-op before any turn starts", () => {
		const { ctx, setWorkingMessage } = createContext();
		const controller = new EventController(ctx);

		controller.notifyInterrupting();

		expect(setWorkingMessage).not.toHaveBeenCalled();
	});
});
