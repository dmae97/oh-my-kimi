import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 200,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 210,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createContext(
	options: {
		editorText?: string;
		goalObjective?: string;
		isCompacting?: boolean;
		isStreaming?: boolean;
		runIdleCompaction?: () => void;
		sessionName?: string;
		showStatus?: (message: string, options?: { dim?: boolean }) => void;
		todoPhases?: InteractiveModeContext["todoPhases"];
	} = {},
): InteractiveModeContext {
	const runIdleCompaction = options.runIdleCompaction ?? (() => {});
	const goalState = options.goalObjective
		? {
				enabled: true,
				mode: "active",
				goal: {
					id: "goal-test",
					objective: options.goalObjective,
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			}
		: undefined;
	const context = {
		isInitialized: true,
		loadingAnimation: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map<string, unknown>(),
		flushPendingModelSwitch: async () => {},
		ui: { requestRender: vi.fn() },
		chatContainer: { removeChild: vi.fn() },
		statusContainer: { clear: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		editor: { getText: () => options.editorText ?? "" },
		sessionManager: { getSessionName: () => options.sessionName },
		todoPhases: options.todoPhases ?? [],
		showStatus: options.showStatus ?? (() => {}),
		session: {
			isCompacting: options.isCompacting ?? false,
			isStreaming: options.isStreaming ?? false,
			runIdleCompaction,
			getContextUsage: () => ({ tokens: 210 }),
			getGoalModeState: () => goalState,
			agent: { state: { messages: [createAssistantMessage()] } },
		},
		get viewSession() {
			return (this as typeof context).session;
		},
		clearTransientSessionUi: () => {},
	} as unknown as InteractiveModeContext;
	return context;
}

describe("EventController idle compaction teardown", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": true,
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 60,
			},
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("cancels scheduled idle compaction when disposed", async () => {
		const runIdleCompaction = vi.fn();
		const context = createContext({ runIdleCompaction });

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		controller.dispose();
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).not.toHaveBeenCalled();
	});

	it("emits an idle recap after the default four-minute delay", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
			},
		});
		const showStatus = vi.fn((_: string, _options?: { dim?: boolean }) => {});
		const context = createContext({
			sessionName: "Fix login flow",
			showStatus,
			todoPhases: [{ name: "Work", tasks: [{ content: "Wire focused tests", status: "pending" }] }],
		});

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(239_999);
		expect(showStatus).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);

		expect(showStatus).toHaveBeenCalledTimes(1);
		const [message, options] = showStatus.mock.calls[0] ?? [];
		expect(Bun.stripANSI(message ?? "")).toBe("※ recap: Goal: Fix login flow Next: Wire focused tests");
		expect(options).toEqual({ dim: false });
		controller.dispose();
	});

	it("keeps the idle recap silent when disabled", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
				"recap.enabled": false,
				"recap.idleSeconds": 1,
			},
		});
		const showStatus = vi.fn((_: string, _options?: { dim?: boolean }) => {});
		const context = createContext({
			sessionName: "Fix login flow",
			showStatus,
			todoPhases: [{ name: "Work", tasks: [{ content: "Wire focused tests", status: "pending" }] }],
		});

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);

		expect(showStatus).not.toHaveBeenCalled();
		controller.dispose();
	});

	it("keeps the idle recap silent while the editor has a draft", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": false,
				"completion.notify": "off",
				"recap.idleSeconds": 1,
			},
		});
		const showStatus = vi.fn((_: string, _options?: { dim?: boolean }) => {});
		const context = createContext({
			editorText: "draft",
			sessionName: "Fix login flow",
			showStatus,
			todoPhases: [{ name: "Work", tasks: [{ content: "Wire focused tests", status: "pending" }] }],
		});

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		vi.advanceTimersByTime(1_000);

		expect(showStatus).not.toHaveBeenCalled();
		controller.dispose();
	});
});
