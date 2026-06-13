import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext, SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";

type Spy = Mock<(...args: unknown[]) => unknown>;
type StartPendingSubmissionSpy = Mock<InteractiveModeContext["startPendingSubmission"]>;
type FakeEditor = {
	onEscape?: () => void;
	onSubmit?: (text: string) => Promise<void>;
	onClear?: () => void;
	onExit?: () => void;
	onSuspend?: () => void;
	onCycleThinkingLevel?: () => void;
	onCycleModelForward?: () => void;
	onCycleModelBackward?: () => void;
	onSelectModelTemporary?: () => void;
	onSelectModel?: () => void;
	onLeftAtStart?: () => void;
	onHistorySearch?: () => void;
	onPasteImage?: () => void;
	onCopyPrompt?: () => void;
	onExpandTools?: () => void;
	onToggleThinking?: () => void;
	onExternalEditor?: () => void;
	onDequeue?: () => void;
	onChange?: (text: string) => void;
	setText(text: string): void;
	getText(): string;
	addToHistory(text: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
};

function createSubmission(input: {
	text: string;
	images?: InteractiveModeContext["pendingImages"];
	imageLinks?: InteractiveModeContext["pendingImageLinks"];
}): SubmittedUserInput {
	return {
		text: input.text,
		images: input.images,
		imageLinks: input.imageLinks,
		cancelled: false,
		started: false,
	};
}

function createContext(): {
	ctx: InteractiveModeContext;
	editor: FakeEditor;
	spies: {
		abort: Spy;
		abortBash: Spy;
		abortEval: Spy;
		abortHandoff: Spy;
		addMessageToChat: Spy;
		cancelPendingSubmission: Spy;
		clearEditor: Spy;
		clearQueue: Spy;
		flushSync: Spy;
		getQueuedMessages: Spy;
		ensureLoadingAnimation: Spy;
		handleBtwCommand: Spy;
		handleBtwEscape: Spy;
		handleOmfgEscape: Spy;
		hasActiveBtw: Spy;
		hasActiveOmfg: Spy;
		onInputCallback: Spy;
		prompt: Spy;
		requestRender: Spy;
		resetDisplay: Spy;
		shutdown: Spy;
		startPendingSubmission: StartPendingSubmissionSpy;
		updatePendingMessagesDisplay: Spy;
	};
	inputListeners: Array<(data: string) => { consume?: boolean; data?: string } | undefined>;
} {
	let editorText = "";
	const abort = vi.fn();
	const abortBash = vi.fn();
	const abortEval = vi.fn();
	const abortHandoff = vi.fn();
	const addMessageToChat = vi.fn();
	const cancelPendingSubmission = vi.fn(() => false);
	const clearQueue = vi.fn(() => ({ steering: [], followUp: [] }));
	const getQueuedMessages = vi.fn(() => ({ steering: [], followUp: [] }));
	const onInputCallback = vi.fn();
	const requestRender = vi.fn();
	const resetDisplay = vi.fn();
	const inputListeners: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
	const handleBtwCommand = vi.fn(async () => {});
	const handleBtwEscape = vi.fn(() => true);
	const hasActiveBtw = vi.fn(() => false);
	const handleOmfgEscape = vi.fn(() => true);
	const hasActiveOmfg = vi.fn(() => false);
	const updatePendingMessagesDisplay = vi.fn();
	const prompt = vi.fn();
	const startPendingSubmission = vi.fn(
		(input: {
			text: string;
			images?: InteractiveModeContext["pendingImages"];
			imageLinks?: InteractiveModeContext["pendingImageLinks"];
		}) => {
			ensureLoadingAnimation();
			return createSubmission(input);
		},
	);
	const editor: FakeEditor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
	};

	let ctx!: InteractiveModeContext;
	const ensureLoadingAnimation = vi.fn(() => {
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
	});

	ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: {
			requestRender,
			resetDisplay,
			addInputListener: vi.fn(listener => {
				inputListeners.push(listener as (data: string) => { consume?: boolean; data?: string } | undefined);
				return () => {};
			}),
			addStartListener: vi.fn(),
		} as unknown as InteractiveModeContext["ui"],
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		autoCompactionEscapeHandler: undefined,
		retryEscapeHandler: undefined,
		session: {
			isStreaming: false,
			isCompacting: false,
			isGeneratingHandoff: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			messages: [],
			extensionRunner: undefined,
			abort,
			abortBash,
			abortEval,
			clearQueue,
			getQueuedMessages,
			prompt,
		} as unknown as InteractiveModeContext["session"],
		viewSession: {
			isCompacting: false,
			isGeneratingHandoff: false,
			isRetrying: false,
			abortCompaction: vi.fn(),
			abortHandoff,
			abortRetry: vi.fn(),
		} as unknown as InteractiveModeContext["viewSession"],
		sessionManager: {
			getSessionName: () => "existing session",
			flushSync: vi.fn(),
		} as unknown as InteractiveModeContext["sessionManager"],
		keybindings: {
			getKeys: () => [],
		} as unknown as InteractiveModeContext["keybindings"],
		pendingImages: [],
		pendingImageLinks: [],
		isBashMode: false,
		isPythonMode: false,
		optimisticUserMessageSignature: undefined,
		locallySubmittedUserSignatures: new Set<string>(),
		onInputCallback,
		addMessageToChat,
		cancelPendingSubmission,
		ensureLoadingAnimation,
		finishPendingSubmission: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		markPendingSubmissionStarted: vi.fn(() => true),
		startPendingSubmission,
		updatePendingMessagesDisplay,
		updateEditorBorderColor: vi.fn(),
		showDebugSelector: vi.fn(),
		toggleTodoExpansion: vi.fn(),
		showAgentHub: vi.fn(),
		unfocusSession: vi.fn(async () => {}),
		focusParentSession: vi.fn(async () => {}),
		handleSTTToggle: vi.fn(),
		handleBtwEscape,
		handleBtwCommand,
		hasActiveBtw,
		handleOmfgEscape,
		hasActiveOmfg,
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		shutdown: vi.fn(async () => {}),
		clearEditor: vi.fn(),
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		spies: {
			abort,
			abortBash,
			abortEval,
			abortHandoff,
			addMessageToChat,
			cancelPendingSubmission,
			clearQueue,
			clearEditor: ctx.clearEditor as Spy,
			getQueuedMessages,
			ensureLoadingAnimation,
			flushSync: ctx.sessionManager.flushSync as Spy,
			handleBtwCommand,
			handleBtwEscape,
			hasActiveBtw,
			handleOmfgEscape,
			hasActiveOmfg,
			onInputCallback,
			prompt,
			requestRender,
			resetDisplay,
			shutdown: ctx.shutdown as Spy,
			startPendingSubmission,
			updatePendingMessagesDisplay,
		},
		inputListeners,
	};
}
beforeEach(async () => {
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("InputController escape behavior", () => {
	it("prefers canceling a pending optimistic submission before aborting the session", async () => {
		const { ctx, editor, spies } = createContext();
		const submission = createSubmission({ text: "hello" });
		spies.startPendingSubmission.mockReturnValue(submission);
		spies.cancelPendingSubmission.mockReturnValue(true);
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("hello");

		expect(spies.startPendingSubmission).toHaveBeenCalledWith({
			text: "hello",
			images: undefined,
			imageLinks: undefined,
		});
		expect(spies.onInputCallback).toHaveBeenCalledWith(submission);

		editor.onEscape?.();
		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("empty-submit with a queued message aborts the active stream and refreshes pending display", async () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; queuedMessageCount: number }).isStreaming = true;
		(ctx.session as { isStreaming: boolean; queuedMessageCount: number }).queuedMessageCount = 1;
		const order: string[] = [];
		spies.abort.mockImplementation(async () => {
			order.push("abort");
		});
		spies.updatePendingMessagesDisplay.mockImplementation(() => {
			order.push("refresh");
		});
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		await editor.onSubmit?.("");

		expect(order).toEqual(["abort", "refresh"]);
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
		expect(spies.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(spies.requestRender).toHaveBeenCalledTimes(1);
	});
	it("runs /btw as a builtin side request instead of steering the active stream", async () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		editor.setText("/btw why is it doing that?");
		await editor.onSubmit?.("/btw why is it doing that?");

		expect(spies.handleBtwCommand).toHaveBeenCalledWith("why is it doing that?");
		expect(spies.prompt).not.toHaveBeenCalled();
		expect(editor.addToHistory).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});

	it("falls back to aborting the active session when no pending optimistic submission exists", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.cancelPendingSubmission).toHaveBeenCalledTimes(1);
		expect(spies.clearQueue).toHaveBeenCalledTimes(1);
		expect(spies.abort).toHaveBeenCalledTimes(1);
		// The Esc interrupt threads a user-facing reason so the aborted turn and its
		// synthetic tool results read as a deliberate interrupt, not "Request was aborted".
		expect(spies.abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
	});

	it("aborts active handoff generation before default Esc handling", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.viewSession as { isGeneratingHandoff: boolean }).isGeneratingHandoff = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abortHandoff).toHaveBeenCalledTimes(1);
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("prefers aborting bash before aborting an overlapping stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; isBashRunning: boolean }).isStreaming = true;
		(ctx.session as { isStreaming: boolean; isBashRunning: boolean }).isBashRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abortBash).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("prefers aborting python before aborting an overlapping stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean; isEvalRunning: boolean }).isStreaming = true;
		(ctx.session as { isStreaming: boolean; isEvalRunning: boolean }).isEvalRunning = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.abortEval).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before aborting the main stream", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before canceling a pending optimistic submission", () => {
		const { ctx, editor, spies } = createContext();
		ctx.loadingAnimation = {} as InteractiveModeContext["loadingAnimation"];
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("dismisses an active /btw panel before aborting bash", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isBashRunning: boolean }).isBashRunning = true;
		spies.hasActiveBtw.mockReturnValue(true);
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		expect(spies.abortBash).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("aborts streaming even when the working loader is no longer present", () => {
		const { ctx, editor, spies } = createContext();
		(ctx.session as { isStreaming: boolean }).isStreaming = true;
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(spies.cancelPendingSubmission).not.toHaveBeenCalled();
		expect(spies.clearQueue).not.toHaveBeenCalled();
		expect(spies.abort).toHaveBeenCalledTimes(1);
	});

	it("returns focused subagent view to main on Esc instead of aborting", () => {
		const { ctx, editor, spies } = createContext();
		Object.defineProperty(ctx, "focusedAgentId", { value: "Worker", configurable: true });
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();

		expect(ctx.unfocusSession).toHaveBeenCalledTimes(1);
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("routes focused left-left through the global input listener like Esc", () => {
		const { ctx, inputListeners } = createContext();
		Object.defineProperty(ctx, "focusedAgentId", { value: "Worker", configurable: true });
		ctx.lastLeftTapTime = Date.now();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		const result = inputListeners[0]("\x1b[D");

		expect(result).toEqual({ consume: true });

		expect(ctx.unfocusSession).toHaveBeenCalledTimes(1);
		expect(ctx.focusParentSession).not.toHaveBeenCalled();
	});
	it("opens the tree selector and clears the display on default double-Esc", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		editor.onEscape?.();

		expect(ctx.showTreeSelector).toHaveBeenCalledTimes(1);
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
		expect(spies.resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("opens the message selector and clears the display when double-Esc is configured for branch", () => {
		Settings.instance.override("doubleEscapeAction", "branch");
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.();
		editor.onEscape?.();

		expect(ctx.showUserMessageSelector).toHaveBeenCalledTimes(1);
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(spies.resetDisplay).toHaveBeenCalledTimes(1);
	});
	it("clears typed editor text on Esc without opening selectors or aborting", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.setText("draft message");
		editor.onEscape?.();

		expect(editor.getText()).toBe("");
		expect(spies.requestRender).toHaveBeenCalledTimes(1);
		expect(ctx.showTreeSelector).not.toHaveBeenCalled();
		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
		expect(spies.resetDisplay).not.toHaveBeenCalled();
		expect(spies.abort).not.toHaveBeenCalled();
	});

	it("does not treat the Esc after a text-clearing Esc as a double-Esc", () => {
		const { ctx, editor } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.(); // empty editor: arms double-Esc timer
		editor.setText("draft");
		editor.onEscape?.(); // clears text, must also reset the timer
		editor.onEscape?.(); // empty again: should only re-arm, not trigger

		expect(ctx.showUserMessageSelector).not.toHaveBeenCalled();
	});
});

describe("InputController Ctrl+C behavior", () => {
	it("sync-flushes the session JSONL on first Ctrl+C (editor clear)", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onClear?.(); // first Ctrl+C: clears editor

		expect(spies.clearEditor).toHaveBeenCalledTimes(1);
		expect(spies.flushSync).toHaveBeenCalledTimes(1);
		expect(spies.shutdown).not.toHaveBeenCalled();
	});

	it("sync-flushes the session JSONL on second Ctrl+C (shutdown)", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onClear?.(); // first Ctrl+C
		editor.onClear?.(); // second Ctrl+C within 500ms → shutdown

		expect(spies.shutdown).toHaveBeenCalledTimes(1);
		// flushSync fires on both presses; the first-press flush is the
		// guarantee that the JSONL is on disk even if the user closes the
		// terminal before the second press.
		expect(spies.flushSync).toHaveBeenCalledTimes(2);
	});

	it("does not flush when Ctrl+C is not pressed", () => {
		const { ctx, editor, spies } = createContext();
		const controller = new InputController(ctx);

		controller.setupKeyHandlers();
		editor.onEscape?.(); // Esc is a different handler

		expect(spies.flushSync).not.toHaveBeenCalled();
	});
});
