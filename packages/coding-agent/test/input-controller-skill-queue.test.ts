/**
 * Skill/custom queued-message display contracts.
 *
 * Custom queued chips now ride on the queued AgentMessage itself via
 * details.__queueChipText. The session derives pending display directly from
 * the agent-core queue; there is no separate display mirror to splice.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Container } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

type StubEditor = {
	setText: (text: string) => void;
	getText: () => string;
	addToHistory: Mock<(...args: unknown[]) => unknown>;
	onSubmit?: (text: string) => Promise<void>;
};

type PromptCustomMessage = Mock<
	(
		message: { details: SkillPromptDetails },
		options?: { streamingBehavior?: "steer" | "followUp"; queueChipText?: string },
	) => Promise<void>
>;

async function writeSkillFile(dir: string, skillName: string, body: string): Promise<string> {
	const skillPath = path.join(dir, `${skillName}.md`);
	await Bun.write(skillPath, `---\nname: ${skillName}\n---\n${body}\n`);
	return skillPath;
}

function createStubInputControllerContext(opts: { skillCommands: Map<string, string>; isStreaming: boolean }) {
	let editorText = "";
	const editor: StubEditor = {
		setText(text) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
	};
	const promptCustomMessage: PromptCustomMessage = vi.fn(async () => {});
	const prompt = vi.fn(async (_text: string, _options?: unknown) => {});
	const handleGoalModeCommand = vi.fn(async (_rest?: string) => {});
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();

	const ctx = {
		editor,
		ui: { requestRender },
		skillCommands: opts.skillCommands,
		session: {
			isStreaming: opts.isStreaming,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			prompt,
			promptCustomMessage,
		},
		get viewSession() {
			return (this as typeof ctx).session;
		},
		showError,
		handleGoalModeCommand,
		goalModeEnabled: false,
		updatePendingMessagesDisplay,
		isBashMode: false,
		isPythonMode: false,
		pendingImages: [],
		pendingImageLinks: [],
		loopModeEnabled: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		prompt,
		promptCustomMessage,
		handleGoalModeCommand,
		updatePendingMessagesDisplay,
		requestRender,
	};
}

describe("InputController skill queue chip metadata", () => {
	let tempDir: TempDir;
	let skillCommands: Map<string, string>;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-skill-queue-stub-");
		const skillPath = await writeSkillFile(tempDir.path(), "test-skill", "Do the thing.");
		skillCommands = new Map<string, string>([["skill:test-skill", skillPath]]);
	});

	afterEach(() => {
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("passes slash-form queueChipText for streaming skill steers", async () => {
		const { ctx, editor, promptCustomMessage, updatePendingMessagesDisplay, requestRender } =
			createStubInputControllerContext({ skillCommands, isStreaming: true });
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill arg1 arg2");
		await editor.onSubmit?.("/skill:test-skill arg1 arg2");

		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		expect(promptCustomMessage.mock.calls[0]?.[1]).toEqual({
			streamingBehavior: "steer",
			queueChipText: "/skill:test-skill arg1 arg2",
		});
		expect(promptCustomMessage.mock.calls[0]?.[0].details.__queueChipText).toBeUndefined();
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("passes slash-form queueChipText for streaming skill follow-ups", async () => {
		const { ctx, editor, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
		});
		const controller = new InputController(ctx);

		editor.setText("/skill:test-skill arg1 arg2");
		await controller.handleFollowUp();

		expect(promptCustomMessage.mock.calls[0]?.[1]).toEqual({
			streamingBehavior: "followUp",
			queueChipText: "/skill:test-skill arg1 arg2",
		});
	});

	it("streaming follow-up applies builtin slash commands instead of queueing them", async () => {
		const { ctx, editor, prompt, handleGoalModeCommand } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
		});
		const controller = new InputController(ctx);

		editor.setText("/goal set Ship the release");
		await controller.handleFollowUp();

		expect(handleGoalModeCommand).toHaveBeenCalledWith("set Ship the release");
		expect(prompt).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});

	it("idle skill prompt still leaves queueChipText out of persisted details", async () => {
		const { ctx, editor, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: false,
		});
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill arg1 arg2");
		await editor.onSubmit?.("/skill:test-skill arg1 arg2");

		expect(promptCustomMessage.mock.calls[0]?.[1]).toEqual({
			streamingBehavior: "steer",
			queueChipText: "/skill:test-skill arg1 arg2",
		});
		expect(promptCustomMessage.mock.calls[0]?.[0].details.__queueChipText).toBeUndefined();
	});
});

interface SessionFixture {
	tempDir: TempDir;
	authStorage: AuthStorage;
	session: AgentSession;
}

async function createRealSession(): Promise<SessionFixture> {
	const tempDir = TempDir.createSync("@pi-skill-queue-real-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");

	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
	});

	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry,
	});

	return { tempDir, authStorage, session };
}

function queueCustomSteer(session: AgentSession, chip: string, content = "skill body"): void {
	session.agent.steer({
		role: "custom",
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content,
		display: true,
		details: {
			name: "foo",
			path: "/s.md",
			args: "bar",
			lineCount: 1,
			__queueChipText: chip,
		} satisfies SkillPromptDetails,
		timestamp: Date.now(),
	});
}

describe("AgentSession derived queued custom display", () => {
	let fixture: SessionFixture | undefined;

	afterEach(async () => {
		if (fixture) {
			await fixture.session.dispose();
			fixture.authStorage.close();
			fixture.tempDir.removeSync();
			fixture = undefined;
		}
		vi.restoreAllMocks();
	});

	it("derives queued custom chip text directly from the agent steering queue", async () => {
		fixture = await createRealSession();
		const { session } = fixture;

		queueCustomSteer(session, "/skill:foo bar");

		expect(session.getQueuedMessages().steering).toEqual(["/skill:foo bar"]);
		expect(session.queuedMessageCount).toBe(1);
	});

	it("excludes display-suppressed custom messages from pending chips and counts", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		session.agent.steer({
			role: "custom",
			customType: "internal",
			content: "hidden",
			display: false,
			details: { __queueChipText: "hidden" },
			timestamp: Date.now(),
		});

		expect(session.getQueuedMessages().steering).toEqual([]);
		expect(session.queuedMessageCount).toBe(0);
	});

	it("popLastQueuedMessage restores chip text and removes the core queue entry", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueCustomSteer(session, "/skill:foo bar");

		expect(session.popLastQueuedMessage()?.text).toBe("/skill:foo bar");
		expect(session.getQueuedMessages().steering).toEqual([]);
	});
});

function createStubInteractiveModeContextForUiHelpers(session: AgentSession) {
	let editorText = "";
	const editor: StubEditor = {
		setText(text) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
	};
	const pendingMessagesContainer = new Container();
	const requestRender = vi.fn();
	const updatePendingMessagesDisplay = vi.fn();

	const ctx = {
		editor,
		ui: { requestRender },
		pendingMessagesContainer,
		session,
		viewSession: session,
		compactionQueuedMessages: [],
		keybindings: {
			getDisplayString: (_action: string) => "Alt+Up",
		},
		updatePendingMessagesDisplay,
		locallySubmittedUserSignatures: new Set<string>(),
	} as unknown as InteractiveModeContext;

	return { ctx, editor, pendingMessagesContainer };
}

describe("UiHelpers / InputController against derived queued custom display", () => {
	let fixture: SessionFixture | undefined;

	beforeEach(async () => {
		const themeInstance = await getThemeByName("dark");
		expect(themeInstance).toBeDefined();
		setThemeInstance(themeInstance!);
	});

	afterEach(async () => {
		if (fixture) {
			await fixture.session.dispose();
			fixture.authStorage.close();
			fixture.tempDir.removeSync();
			fixture = undefined;
		}
		vi.restoreAllMocks();
	});

	it("renders the compact slash form for queued skills", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueCustomSteer(session, "/skill:test-skill arg1 arg2");

		const { ctx, pendingMessagesContainer } = createStubInteractiveModeContextForUiHelpers(session);
		const uiHelpers = new UiHelpers(ctx);
		uiHelpers.updatePendingMessagesDisplay();

		const rendered = pendingMessagesContainer.render(120).join("\n");
		expect(rendered).toMatch(/Steer: \/skill:test-skill arg1 arg2/);
	});

	it("restores the compact slash form into the editor and clears the queue", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueCustomSteer(session, "/skill:test-skill arg1 arg2");

		const { ctx, editor } = createStubInteractiveModeContextForUiHelpers(session);
		const controller = new InputController(ctx);
		const count = controller.restoreQueuedMessagesToEditor();

		expect(count).toBe(1);
		expect(editor.getText()).toBe("/skill:test-skill arg1 arg2");
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
	});
});

function createEventControllerFixture() {
	const updatePendingMessagesDisplay = vi.fn();
	const addMessageToChat = vi.fn();
	const requestRender = vi.fn();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		addMessageToChat,
		updatePendingMessagesDisplay,
		pendingTools: new Map(),
		session: {},
		get viewSession() {
			return (this as typeof ctx).session;
		},
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return { controller, updatePendingMessagesDisplay, addMessageToChat };
}

describe("EventController custom queued-message refresh", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("refreshes the pending bar only for custom messages carrying __queueChipText", async () => {
		const { controller, updatePendingMessagesDisplay, addMessageToChat } = createEventControllerFixture();
		const queuedEvent: Extract<AgentSessionEvent, { type: "message_start" }> = {
			type: "message_start",
			message: {
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "first",
				display: true,
				details: {
					__queueChipText: "/skill:foo bar",
					name: "foo",
					path: "/s.md",
					args: "bar",
					lineCount: 1,
				} satisfies SkillPromptDetails,
				timestamp: Date.now(),
			},
		};
		await controller.handleEvent(queuedEvent);
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(addMessageToChat).toHaveBeenCalledTimes(1);

		const unqueuedEvent: Extract<AgentSessionEvent, { type: "message_start" }> = {
			type: "message_start",
			message: {
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "second",
				display: true,
				details: undefined,
				timestamp: Date.now() + 1,
			},
		};
		await controller.handleEvent(unqueuedEvent);

		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(addMessageToChat).toHaveBeenCalledTimes(2);
	});
});
