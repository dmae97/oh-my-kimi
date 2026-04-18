/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Agent, type AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	type AssistantMessage,
	type ImageContent,
	type Message,
	type Model,
	modelsAreEqual,
	type UsageReport,
} from "@oh-my-pi/pi-ai";
import type { Component, SlashCommand } from "@oh-my-pi/pi-tui";
import { Container, Loader, Markdown, ProcessTerminal, Spacer, Text, TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { APP_NAME, getProjectDir, hsvToRgb, isEnoent, logger, postmortem, prompt } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { KeybindingsManager } from "../config/keybindings";
import { type Settings, settings } from "../config/settings";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "../extensibility/extensions";
import type { CompactOptions } from "../extensibility/extensions/types";
import { BUILTIN_SLASH_COMMANDS, loadSlashCommands } from "../extensibility/slash-commands";
import { resolveLocalUrlToPath } from "../internal-urls";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "../lsp/startup-events";
import { renameApprovedPlanFile } from "../plan-mode/approved-plan";
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { HistoryStorage } from "../session/history-storage";
import type { SessionContext, SessionManager } from "../session/session-manager";
import { getRecentSessions } from "../session/session-manager";
import { STTController, type SttState } from "../stt";
import type { ExitPlanModeDetails, LspStartupServerInfo } from "../tools";
import { normalizeLocalScheme } from "../tools/path-utils";
import type { EventBus } from "../utils/event-bus";
import { getEditorCommand, openInEditor } from "../utils/external-editor";
import { getSessionAccentAnsi, getSessionAccentHexForTitle } from "../utils/session-color";
import { popTerminalTitle, pushTerminalTitle, setSessionTerminalTitle } from "../utils/title-generator";
import type { AssistantMessageComponent } from "./components/assistant-message";
import type { BashExecutionComponent } from "./components/bash-execution";
import { CustomEditor } from "./components/custom-editor";
import { DynamicBorder } from "./components/dynamic-border";
import type { HookEditorComponent } from "./components/hook-editor";
import type { HookInputComponent } from "./components/hook-input";
import type { HookSelectorComponent } from "./components/hook-selector";
import type { PythonExecutionComponent } from "./components/python-execution";
import { StatusLineComponent } from "./components/status-line";
import type { ToolExecutionHandle } from "./components/tool-execution";
import { WelcomeComponent, type LspServerInfo as WelcomeLspServerInfo } from "./components/welcome";
import { BtwController } from "./controllers/btw-controller";
import { CommandController } from "./controllers/command-controller";
import { EventController } from "./controllers/event-controller";
import { ExtensionUiController } from "./controllers/extension-ui-controller";
import { InputController } from "./controllers/input-controller";
import { MCPCommandController } from "./controllers/mcp-command-controller";
import { SelectorController } from "./controllers/selector-controller";
import { SSHCommandController } from "./controllers/ssh-command-controller";
import { OAuthManualInputManager } from "./oauth-manual-input";
import { SessionObserverRegistry } from "./session-observer-registry";
import { setMermaidRenderCallback } from "./theme/mermaid-cache";
import type { Theme } from "./theme/theme";
import {
	getEditorTheme,
	getMarkdownTheme,
	getSymbolTheme,
	onTerminalAppearanceChange,
	onThemeChange,
	theme,
} from "./theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext, SubmittedUserInput, TodoItem, TodoPhase } from "./types";
import { UiHelpers } from "./utils/ui-helpers";

const EDITOR_MAX_HEIGHT_MIN = 6;
const EDITOR_MAX_HEIGHT_MAX = 18;
const EDITOR_RESERVED_ROWS = 12;
const EDITOR_FALLBACK_ROWS = 24;

/** Options for creating an InteractiveMode instance (for future API use) */
export interface InteractiveModeOptions {
	/** Providers that were migrated during startup */
	migratedProviders?: string[];
	/** Warning message if model fallback occurred */
	modelFallbackMessage?: string;
	/** Initial message to send */
	initialMessage?: string;
	/** Initial images to include with the message */
	initialImages?: ImageContent[];
	/** Additional initial messages to queue */
	initialMessages?: string[];
}

export class InteractiveMode implements InteractiveModeContext {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: Agent;
	historyStorage?: HistoryStorage;

	ui: TUI;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	todoContainer: Container;
	btwContainer: Container;
	editor: CustomEditor;
	editorContainer: Container;
	hookWidgetContainerAbove: Container;
	hookWidgetContainerBelow: Container;
	statusLine: StatusLineComponent;

	isInitialized = false;
	isBackgrounded = false;
	isBashMode = false;
	toolOutputExpanded = false;
	todoExpanded = false;
	planModeEnabled = false;
	planModePaused = false;
	planModePlanFilePath: string | undefined = undefined;
	todoPhases: TodoPhase[] = [];
	hideThinkingBlock = false;
	pendingImages: ImageContent[] = [];
	compactionQueuedMessages: CompactionQueuedMessage[] = [];
	pendingTools = new Map<string, ToolExecutionHandle>();
	pendingBashComponents: BashExecutionComponent[] = [];
	bashComponent: BashExecutionComponent | undefined = undefined;
	pendingPythonComponents: PythonExecutionComponent[] = [];
	pythonComponent: PythonExecutionComponent | undefined = undefined;
	isPythonMode = false;
	streamingComponent: AssistantMessageComponent | undefined = undefined;
	streamingMessage: AssistantMessage | undefined = undefined;
	loadingAnimation: Loader | undefined = undefined;
	autoCompactionLoader: Loader | undefined = undefined;
	retryLoader: Loader | undefined = undefined;
	#pendingWorkingMessage: string | undefined;
	readonly #defaultWorkingMessage = `Working… (esc to interrupt)`;
	autoCompactionEscapeHandler?: () => void;
	retryEscapeHandler?: () => void;
	unsubscribe?: () => void;
	onInputCallback?: (input: SubmittedUserInput) => void;
	optimisticUserMessageSignature: string | undefined = undefined;
	#pendingSubmittedInput: SubmittedUserInput | undefined;
	lastSigintTime = 0;
	lastEscapeTime = 0;
	shutdownRequested = false;
	#isShuttingDown = false;
	hookSelector: HookSelectorComponent | undefined = undefined;
	hookInput: HookInputComponent | undefined = undefined;
	hookEditor: HookEditorComponent | undefined = undefined;
	lastStatusSpacer: Spacer | undefined = undefined;
	lastStatusText: Text | undefined = undefined;
	fileSlashCommands: Set<string> = new Set();
	skillCommands: Map<string, string> = new Map();
	oauthManualInput: OAuthManualInputManager = new OAuthManualInputManager();

	#pendingSlashCommands: SlashCommand[] = [];
	#cleanupUnsubscribe?: () => void;
	readonly #version: string;
	readonly #changelogMarkdown: string | undefined;
	#planModePreviousTools: string[] | undefined;
	#planModePreviousModelState: { model: Model; thinkingLevel?: ThinkingLevel } | undefined;
	#pendingModelSwitch: { model: Model; thinkingLevel?: ThinkingLevel } | undefined;
	#planModeHasEntered = false;
	#planReviewContainer: Container | undefined;
	readonly lspServers: LspStartupServerInfo[] | undefined = undefined;
	mcpManager?: import("../mcp").MCPManager;
	readonly #toolUiContextSetter: (uiContext: ExtensionUIContext, hasUI: boolean) => void;

	readonly #btwController: BtwController;
	readonly #commandController: CommandController;
	readonly #eventController: EventController;
	readonly #extensionUiController: ExtensionUiController;
	readonly #inputController: InputController;
	readonly #selectorController: SelectorController;
	readonly #uiHelpers: UiHelpers;
	#sttController: STTController | undefined;
	#voiceAnimationInterval: NodeJS.Timeout | undefined;
	#voiceHue = 0;
	#voicePreviousShowHardwareCursor: boolean | null = null;
	#voicePreviousUseTerminalCursor: boolean | null = null;
	#resizeHandler?: () => void;
	#observerRegistry: SessionObserverRegistry;
	#eventBus?: EventBus;
	#eventBusUnsubscribers: Array<() => void> = [];
	#welcomeComponent?: WelcomeComponent;

	constructor(
		session: AgentSession,
		version: string,
		changelogMarkdown: string | undefined = undefined,
		setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void = () => {},
		lspServers: LspStartupServerInfo[] | undefined = undefined,
		mcpManager?: import("../mcp").MCPManager,
		eventBus?: EventBus,
	) {
		this.session = session;
		this.sessionManager = session.sessionManager;
		this.settings = session.settings;
		this.keybindings = KeybindingsManager.inMemory();
		this.agent = session.agent;
		this.#version = version;
		this.#changelogMarkdown = changelogMarkdown;
		this.#toolUiContextSetter = setToolUIContext;
		this.lspServers = lspServers;
		this.mcpManager = mcpManager;
		this.#eventBus = eventBus;
		if (eventBus) {
			this.#eventBusUnsubscribers.push(
				eventBus.on(LSP_STARTUP_EVENT_CHANNEL, data => {
					this.#handleLspStartupEvent(data as LspStartupEvent);
				}),
			);
		}

		this.ui = new TUI(new ProcessTerminal(), settings.get("showHardwareCursor"));
		this.ui.setClearOnShrink(settings.get("clearOnShrink"));
		setMermaidRenderCallback(() => this.ui.requestRender());
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.todoContainer = new Container();
		this.btwContainer = new Container();
		this.editor = new CustomEditor(getEditorTheme());
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.setAutocompleteMaxVisible(settings.get("autocompleteMaxVisible"));
		this.editor.onAutocompleteCancel = () => {
			this.ui.requestRender(true);
		};
		this.editor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		this.#syncEditorMaxHeight();
		this.#resizeHandler = () => {
			this.#syncEditorMaxHeight();
		};
		process.stdout.on("resize", this.#resizeHandler);
		try {
			this.historyStorage = HistoryStorage.open();
			this.editor.setHistoryStorage(this.historyStorage);
		} catch (error) {
			logger.warn("History storage unavailable", { error: String(error) });
		}
		this.hookWidgetContainerAbove = new Container();
		this.hookWidgetContainerAbove.addChild(new Spacer(1));
		this.hookWidgetContainerBelow = new Container();
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor);
		this.statusLine = new StatusLineComponent(session);
		this.statusLine.setAutoCompactEnabled(session.autoCompactionEnabled);

		this.hideThinkingBlock = settings.get("hideThinkingBlock");

		const builtinCommandNames = new Set(BUILTIN_SLASH_COMMANDS.map(c => c.name));
		const hookCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(builtinCommandNames) ?? []
		).map(cmd => ({
			name: cmd.name,
			description: cmd.description ?? "(hook command)",
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

		// Convert custom commands (TypeScript) to SlashCommand format
		const customCommands: SlashCommand[] = this.session.customCommands.map(loaded => ({
			name: loaded.command.name,
			description: `${loaded.command.description} (${loaded.source})`,
		}));

		// Build skill commands from session.skills (if enabled)
		const skillCommandList: SlashCommand[] = [];
		if (settings.get("skills.enableSkillCommands")) {
			for (const skill of this.session.skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({ name: commandName, description: skill.description });
			}
		}

		// Store pending commands for init() where file commands are loaded async
		this.#pendingSlashCommands = [...BUILTIN_SLASH_COMMANDS, ...hookCommands, ...customCommands, ...skillCommandList];

		this.#uiHelpers = new UiHelpers(this);
		this.#btwController = new BtwController(this);
		this.#extensionUiController = new ExtensionUiController(this);
		this.#eventController = new EventController(this);
		this.#commandController = new CommandController(this);
		this.#selectorController = new SelectorController(this);
		this.#inputController = new InputController(this);
		this.#observerRegistry = new SessionObserverRegistry();
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		logger.time("InteractiveMode.init:keybindings");
		this.keybindings = KeybindingsManager.create();

		// Register session manager flush for signal handlers (SIGINT, SIGTERM, SIGHUP)
		this.#cleanupUnsubscribe = postmortem.register("session-manager-flush", () => this.sessionManager.flush());

		await logger.time(
			"InteractiveMode.init:slashCommands",
			this.refreshSlashCommandState.bind(this),
			getProjectDir(),
		);

		// Get current model info for welcome screen
		const modelName = this.session.model?.name ?? "Unknown";
		const providerName = this.session.model?.provider ?? "Unknown";

		// Get recent sessions
		const recentSessions = await logger.time("InteractiveMode.init:recentSessions", () =>
			getRecentSessions(this.sessionManager.getSessionDir()).then(sessions =>
				sessions.map(s => ({
					name: s.name,
					timeAgo: s.timeAgo,
				})),
			),
		);

		const startupQuiet = settings.get("startup.quiet");
		this.#welcomeComponent = undefined;

		for (const warning of this.session.configWarnings) {
			this.ui.addChild(new Text(theme.fg("warning", `Warning: ${warning}`), 1, 0));
			this.ui.addChild(new Spacer(1));
		}

		if (!startupQuiet) {
			// Add welcome header
			this.#welcomeComponent = new WelcomeComponent(
				this.#version,
				modelName,
				providerName,
				recentSessions,
				this.#getWelcomeLspServers(),
			);

			// Setup UI layout
			this.ui.addChild(new Spacer(1));
			this.ui.addChild(this.#welcomeComponent);
			this.ui.addChild(new Spacer(1));

			// Add changelog if provided
			if (this.#changelogMarkdown) {
				this.ui.addChild(new DynamicBorder());
				if (settings.get("collapseChangelog")) {
					const versionMatch = this.#changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
					const latestVersion = versionMatch ? versionMatch[1] : this.#version;
					const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
					this.ui.addChild(new Text(condensedText, 1, 0));
				} else {
					this.ui.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
					this.ui.addChild(new Spacer(1));
					this.ui.addChild(new Markdown(this.#changelogMarkdown.trim(), 1, 0, getMarkdownTheme()));
					this.ui.addChild(new Spacer(1));
				}
				this.ui.addChild(new DynamicBorder());
			}
		}

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.todoContainer);
		this.ui.addChild(this.btwContainer);
		this.ui.addChild(this.statusLine); // Only renders hook statuses (main status in editor border)
		this.ui.addChild(this.hookWidgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.hookWidgetContainerBelow);
		this.ui.setFocus(this.editor);

		this.#inputController.setupKeyHandlers();
		this.#inputController.setupEditorSubmitHandler();

		// Wire observer registry to EventBus
		if (this.#eventBus) {
			this.#observerRegistry.subscribeToEventBus(this.#eventBus);
		}
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
		this.#observerRegistry.onChange(() => {
			this.statusLine.setSubagentCount(this.#observerRegistry.getActiveSubagentCount());
			this.ui.requestRender();
		});

		// Load initial todos
		await this.#loadTodoList();

		// Start the UI
		this.ui.start();
		pushTerminalTitle();
		setSessionTerminalTitle(
			this.sessionManager.getSessionName(),
			this.sessionManager.getCwd(),
			this.sessionManager.titleSource,
		);
		this.updateEditorBorderColor();
		this.#syncEditorMaxHeight();
		this.isInitialized = true;
		this.ui.requestRender(true);

		// Initialize hooks with TUI-based UI context
		await this.initHooksAndCustomTools();

		// Restore mode from session (e.g. plan mode on resume)
		await this.#restoreModeFromSession();

		// Subscribe to agent events
		this.#subscribeToAgent();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Subscribe to terminal dark/light appearance changes.
		// The terminal queries background color via OSC 11 at startup and on
		// Mode 2031 notifications, computing luminance to detect dark/light.
		this.ui.terminal.onAppearanceChange(mode => {
			onTerminalAppearanceChange(mode);
		});

		// Set up git branch watcher
		this.statusLine.watchBranch(() => {
			this.updateEditorTopBorder();
			this.ui.requestRender();
		});

		// Initial top border update
		this.updateEditorTopBorder();
	}

	/** Reload slash commands and autocomplete for the provided working directory. */
	async refreshSlashCommandState(cwd?: string): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		const fileCommands = await loadSlashCommands({ cwd: basePath });
		this.fileSlashCommands = new Set(fileCommands.map(cmd => cmd.name));
		const fileSlashCommands: SlashCommand[] = fileCommands.map(cmd => ({
			name: cmd.name,
			description: cmd.description,
		}));
		const autocompleteProvider = this.#inputController.createAutocompleteProvider(
			[...this.#pendingSlashCommands, ...fileSlashCommands],
			basePath,
		);
		this.editor.setAutocompleteProvider(autocompleteProvider);
		this.session.setSlashCommands(fileCommands);
	}

	async getUserInput(): Promise<SubmittedUserInput> {
		const { promise, resolve } = Promise.withResolvers<SubmittedUserInput>();
		this.onInputCallback = input => {
			this.onInputCallback = undefined;
			resolve(input);
		};
		return promise;
	}

	startPendingSubmission(input: { text: string; images?: ImageContent[] }): SubmittedUserInput {
		const submission: SubmittedUserInput = {
			text: input.text,
			images: input.images,
			cancelled: false,
			started: false,
		};
		this.#pendingSubmittedInput = submission;
		this.optimisticUserMessageSignature = `${submission.text}\u0000${submission.images?.length ?? 0}`;
		this.addMessageToChat({
			role: "user",
			content: [{ type: "text", text: submission.text }, ...(submission.images ?? [])],
			attribution: "user",
			timestamp: Date.now(),
		});
		this.editor.setText("");
		this.ensureLoadingAnimation();
		this.ui.requestRender();
		return submission;
	}

	cancelPendingSubmission(): boolean {
		const submission = this.#pendingSubmittedInput;
		if (!submission || submission.started) {
			return false;
		}

		submission.cancelled = true;
		this.#pendingSubmittedInput = undefined;
		this.optimisticUserMessageSignature = undefined;
		this.#pendingWorkingMessage = undefined;
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
			this.statusContainer.clear();
		}
		this.pendingImages = submission.images ? [...submission.images] : [];
		this.rebuildChatFromMessages();
		this.editor.setText(submission.text);
		this.updateEditorBorderColor();
		this.ui.requestRender();
		return true;
	}

	markPendingSubmissionStarted(input: SubmittedUserInput): boolean {
		if (this.#pendingSubmittedInput !== input || input.cancelled) {
			return false;
		}
		input.started = true;
		return true;
	}

	finishPendingSubmission(input: SubmittedUserInput): void {
		if (this.#pendingSubmittedInput === input) {
			this.#pendingSubmittedInput = undefined;
		}
	}

	#computeEditorMaxHeight(): number {
		const rows = this.ui.terminal.rows;
		const terminalRows = Number.isFinite(rows) && rows > 0 ? rows : EDITOR_FALLBACK_ROWS;
		const maxHeight = terminalRows - EDITOR_RESERVED_ROWS;
		return Math.max(EDITOR_MAX_HEIGHT_MIN, Math.min(EDITOR_MAX_HEIGHT_MAX, maxHeight));
	}

	#syncEditorMaxHeight(): void {
		this.editor.setMaxHeight(this.#computeEditorMaxHeight());
	}

	updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else if (this.isPythonMode) {
			this.editor.borderColor = theme.getPythonModeBorderColor();
		} else {
			const hex = getSessionAccentHexForTitle(this.sessionManager.getSessionName(), this.sessionManager.titleSource);
			const ansi = getSessionAccentAnsi(hex);
			if (ansi) {
				this.editor.borderColor = (str: string) => `${ansi}${str}\x1b[39m`;
			} else {
				const level = this.session.thinkingLevel ?? ThinkingLevel.Off;
				this.editor.borderColor = theme.getThinkingBorderColor(level);
			}
		}
		this.updateEditorTopBorder();
		this.ui.requestRender();
	}

	updateEditorTopBorder(): void {
		const availableWidth = this.editor.getTopBorderAvailableWidth(this.ui.terminal.columns);
		const topBorder = this.statusLine.getTopBorder(availableWidth);
		this.editor.setTopBorder(topBorder);
	}

	rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		const context = this.session.buildDisplaySessionContext();
		this.renderSessionContext(context);
	}

	#formatTodoLine(todo: TodoItem, prefix: string): string {
		const checkbox = theme.checkbox;
		switch (todo.status) {
			case "completed":
				return theme.fg("success", `${prefix}${checkbox.checked} ${chalk.strikethrough(todo.content)}`);
			case "in_progress": {
				const main = theme.fg("accent", `${prefix}${checkbox.unchecked} ${todo.content}`);
				if (!todo.details) return main;
				const detailLines = todo.details.split("\n").map(line => theme.fg("dim", `${prefix}  ${line}`));
				return [main, ...detailLines].join("\n");
			}
			case "abandoned":
				return theme.fg("error", `${prefix}${checkbox.unchecked} ${chalk.strikethrough(todo.content)}`);
			default:
				return theme.fg("dim", `${prefix}${checkbox.unchecked} ${todo.content}`);
		}
	}

	#getActivePhase(phases: TodoPhase[]): TodoPhase | undefined {
		const nonEmpty = phases.filter(phase => phase.tasks.length > 0);
		const active = nonEmpty.find(phase =>
			phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
		);
		return active ?? nonEmpty[nonEmpty.length - 1];
	}

	#renderTodoList(): void {
		this.todoContainer.clear();
		const phases = this.todoPhases.filter(phase => phase.tasks.length > 0);
		if (phases.length === 0) {
			return;
		}

		const indent = "  ";
		const hook = theme.tree.hook;
		const lines = ["", indent + theme.bold(theme.fg("accent", "Todos"))];

		if (!this.todoExpanded) {
			const activePhase = this.#getActivePhase(phases);
			if (!activePhase) return;
			lines.push(`${indent}${theme.fg("accent", `${hook} ${activePhase.name}`)}`);
			const visibleTasks = activePhase.tasks.slice(0, 5);
			visibleTasks.forEach((todo, index) => {
				const prefix = `${indent}${index === 0 ? hook : " "} `;
				lines.push(this.#formatTodoLine(todo, prefix));
			});
			if (visibleTasks.length < activePhase.tasks.length) {
				const remaining = activePhase.tasks.length - visibleTasks.length;
				lines.push(theme.fg("muted", `${indent}  ${hook} +${remaining} more`));
			}
			this.todoContainer.addChild(new Text(lines.join("\n"), 1, 0));
			return;
		}

		for (const phase of phases) {
			lines.push(`${indent}${theme.fg("accent", `${hook} ${phase.name}`)}`);
			phase.tasks.forEach((todo, index) => {
				const prefix = `${indent}${index === 0 ? hook : " "} `;
				lines.push(this.#formatTodoLine(todo, prefix));
			});
		}

		this.todoContainer.addChild(new Text(lines.join("\n"), 1, 0));
	}

	async #loadTodoList(): Promise<void> {
		this.todoPhases = this.session.getTodoPhases();
		this.#renderTodoList();
	}

	async #getPlanFilePath(): Promise<string> {
		return "local://PLAN.md";
	}

	#resolvePlanFilePath(planFilePath: string): string {
		if (planFilePath.startsWith("local:")) {
			const normalized = normalizeLocalScheme(planFilePath);
			return resolveLocalUrlToPath(normalized, {
				getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
				getSessionId: () => this.sessionManager.getSessionId(),
			});
		}
		return path.resolve(this.sessionManager.getCwd(), planFilePath);
	}

	#updatePlanModeStatus(): void {
		const status =
			this.planModeEnabled || this.planModePaused
				? {
						enabled: this.planModeEnabled,
						paused: this.planModePaused,
					}
				: undefined;
		this.statusLine.setPlanModeStatus(status);
		this.updateEditorTopBorder();
		this.ui.requestRender();
	}

	async #applyPlanModeModel(): Promise<void> {
		const resolved = this.session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) return;

		const currentModel = this.session.model;
		const sameModel = modelsAreEqual(currentModel, resolved.model);
		const planThinkingLevel = resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined;

		this.#planModePreviousModelState = currentModel
			? { model: currentModel, thinkingLevel: this.session.thinkingLevel }
			: undefined;

		if (!sameModel) {
			if (this.session.isStreaming) {
				this.#pendingModelSwitch = { model: resolved.model, thinkingLevel: planThinkingLevel };
				return;
			}
			try {
				await this.session.setModelTemporary(resolved.model, planThinkingLevel);
			} catch (error) {
				this.showWarning(
					`Failed to switch to plan model for plan mode: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} else if (planThinkingLevel) {
			this.session.setThinkingLevel(planThinkingLevel);
		}
	}

	/** Apply any deferred model switch after the current stream ends. */
	async flushPendingModelSwitch(): Promise<void> {
		const pending = this.#pendingModelSwitch;
		if (!pending) return;
		this.#pendingModelSwitch = undefined;
		try {
			await this.session.setModelTemporary(pending.model, pending.thinkingLevel);
		} catch (error) {
			this.showWarning(
				`Failed to switch model after streaming: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** Restore mode state from session entries on resume (e.g. plan mode). */
	async #restoreModeFromSession(): Promise<void> {
		const sessionContext = this.sessionManager.buildSessionContext();
		if (sessionContext.mode === "plan") {
			const planFilePath = sessionContext.modeData?.planFilePath as string | undefined;
			await this.#enterPlanMode({ planFilePath });
		} else if (sessionContext.mode === "plan_paused") {
			this.planModePaused = true;
			this.#planModeHasEntered = true;
			this.#updatePlanModeStatus();
		}
	}

	async #enterPlanMode(options?: { planFilePath?: string; workflow?: "parallel" | "iterative" }): Promise<void> {
		if (this.planModeEnabled) {
			return;
		}

		this.planModePaused = false;

		const planFilePath = options?.planFilePath ?? (await this.#getPlanFilePath());
		const previousTools = this.session.getActiveToolNames();
		const hasExitTool = this.session.getToolByName("exit_plan_mode") !== undefined;
		const planTools = hasExitTool ? [...previousTools, "exit_plan_mode"] : previousTools;
		const uniquePlanTools = [...new Set(planTools)];

		this.#planModePreviousTools = previousTools;
		this.planModePlanFilePath = planFilePath;
		this.planModeEnabled = true;

		await this.session.setActiveToolsByName(uniquePlanTools);
		this.session.setPlanModeState({
			enabled: true,
			planFilePath,
			workflow: options?.workflow ?? "parallel",
			reentry: this.#planModeHasEntered,
		});
		if (this.session.isStreaming) {
			await this.session.sendPlanModeContext({ deliverAs: "steer" });
		}
		this.#planModeHasEntered = true;
		await this.#applyPlanModeModel();
		this.#updatePlanModeStatus();
		this.sessionManager.appendModeChange("plan", { planFilePath });
		this.showStatus(`Plan mode enabled. Plan file: ${planFilePath}`);
	}

	async #exitPlanMode(options?: { silent?: boolean; paused?: boolean }): Promise<void> {
		if (!this.planModeEnabled) {
			return;
		}

		const previousTools = this.#planModePreviousTools;
		if (previousTools && previousTools.length > 0) {
			await this.session.setActiveToolsByName(previousTools);
		}
		if (this.#planModePreviousModelState) {
			const prev = this.#planModePreviousModelState;
			if (modelsAreEqual(this.session.model, prev.model)) {
				// Same model — only thinking level may differ. Avoid setModelTemporary()
				// which would reset provider-side sessions (openai-responses/Codex) and
				// break conversation continuity.
				this.session.setThinkingLevel(prev.thinkingLevel);
			} else if (this.session.isStreaming) {
				this.#pendingModelSwitch = { model: prev.model, thinkingLevel: prev.thinkingLevel };
			} else {
				await this.session.setModelTemporary(prev.model, prev.thinkingLevel);
			}
		}
		this.session.setPlanModeState(undefined);
		this.planModeEnabled = false;
		this.planModePaused = options?.paused ?? false;
		this.planModePlanFilePath = undefined;
		this.#planModePreviousTools = undefined;
		this.#planModePreviousModelState = undefined;
		this.#updatePlanModeStatus();
		const paused = options?.paused ?? false;
		this.sessionManager.appendModeChange(paused ? "plan_paused" : "none");
		if (!options?.silent) {
			this.showStatus(paused ? "Plan mode paused." : "Plan mode disabled.");
		}
	}

	async #readPlanFile(planFilePath: string): Promise<string | null> {
		const resolvedPath = this.#resolvePlanFilePath(planFilePath);
		try {
			return await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}
	}

	#renderPlanPreview(planContent: string): void {
		const planReviewContainer = this.#planReviewContainer ?? new Container();
		if (this.#planReviewContainer) {
			// Re-append the preview so repeated plan-review refreshes stay adjacent to the
			// active selector instead of updating an older off-screen preview in place.
			this.chatContainer.removeChild(this.#planReviewContainer);
		}
		planReviewContainer.clear();
		planReviewContainer.addChild(new Spacer(1));
		planReviewContainer.addChild(new DynamicBorder());
		planReviewContainer.addChild(new Text(theme.bold(theme.fg("accent", "Plan Review")), 1, 1));
		planReviewContainer.addChild(new Spacer(1));
		planReviewContainer.addChild(new Markdown(planContent, 1, 1, getMarkdownTheme()));
		planReviewContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(planReviewContainer);
		this.#planReviewContainer = planReviewContainer;
		this.ui.requestRender();
	}

	#getEditorTerminalPath(): string | null {
		if (process.platform === "win32") {
			return null;
		}
		return "/dev/tty";
	}

	async #openEditorTerminalHandle(): Promise<fs.FileHandle | null> {
		const terminalPath = this.#getEditorTerminalPath();
		if (!terminalPath) {
			return null;
		}
		try {
			return await fs.open(terminalPath, "r+");
		} catch {
			return null;
		}
	}

	#getPlanReviewHelpText(): string {
		const externalEditorKey = this.keybindings.getDisplayString("app.editor.external");
		if (!externalEditorKey) {
			return "up/down navigate  enter select  esc cancel";
		}
		return `up/down navigate  enter select  ${externalEditorKey.toLowerCase()} open in editor  esc cancel`;
	}

	async #openPlanInExternalEditor(planFilePath: string): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const resolvedPath = this.#resolvePlanFilePath(planFilePath);
		let currentText: string;
		try {
			currentText = await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				this.showError(`Plan file not found at ${planFilePath}`);
				return;
			}
			this.showWarning(`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		let ttyHandle: fs.FileHandle | null = null;
		try {
			ttyHandle = await this.#openEditorTerminalHandle();
			this.ui.stop();

			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = ttyHandle
				? [ttyHandle.fd, ttyHandle.fd, ttyHandle.fd]
				: ["inherit", "inherit", "inherit"];

			const result = await openInEditor(editorCmd, currentText, {
				extension: path.extname(resolvedPath) || ".md",
				stdio,
				trimTrailingNewline: false,
			});
			if (result !== null) {
				await Bun.write(resolvedPath, result);
				this.#renderPlanPreview(result);
				this.showStatus("Plan updated in external editor.");
			}
		} catch (error) {
			this.showWarning(`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (ttyHandle) {
				await ttyHandle.close();
			}
			this.ui.start();
			this.ui.requestRender(true);
		}
	}

	async #approvePlan(
		planContent: string,
		options: { planFilePath: string; finalPlanFilePath: string },
	): Promise<void> {
		await renameApprovedPlanFile({
			planFilePath: options.planFilePath,
			finalPlanFilePath: options.finalPlanFilePath,
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		});
		const previousTools = this.#planModePreviousTools ?? this.session.getActiveToolNames();
		await this.#exitPlanMode({ silent: true, paused: false });
		await this.handleClearCommand();
		// The new session has a fresh local:// root — persist the approved plan there
		// so `local://<title>.md` resolves correctly in the execution session.
		const newLocalPath = resolveLocalUrlToPath(options.finalPlanFilePath, {
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		});
		await Bun.write(newLocalPath, planContent);
		if (previousTools.length > 0) {
			await this.session.setActiveToolsByName(previousTools);
		}
		this.session.setPlanReferencePath(options.finalPlanFilePath);
		this.session.markPlanReferenceSent();
		const planModePrompt = prompt.render(planModeApprovedPrompt, {
			planContent,
			finalPlanFilePath: options.finalPlanFilePath,
		});
		await this.session.prompt(planModePrompt, { synthetic: true });
	}

	async handlePlanModeCommand(initialPrompt?: string): Promise<void> {
		if (this.planModeEnabled) {
			const confirmed = await this.showHookConfirm(
				"Exit plan mode?",
				"This exits plan mode without approving a plan.",
			);
			if (!confirmed) return;
			await this.#exitPlanMode({ paused: true });
			return;
		}
		await this.#enterPlanMode();
		if (initialPrompt && this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: initialPrompt }));
		}
	}

	async handleExitPlanModeTool(details: ExitPlanModeDetails): Promise<void> {
		if (!this.planModeEnabled) {
			this.showWarning("Plan mode is not active.");
			return;
		}

		// Abort the agent to prevent it from continuing (e.g., calling exit_plan_mode
		// again) while the popup is showing. The event listener fires asynchronously
		// (agent's #emit is fire-and-forget), so without this the model sees "Plan
		// ready for approval." and immediately calls exit_plan_mode in a loop.
		await this.session.abort();

		const planFilePath = details.planFilePath || this.planModePlanFilePath || (await this.#getPlanFilePath());
		this.planModePlanFilePath = planFilePath;
		const planContent = await this.#readPlanFile(planFilePath);
		if (!planContent) {
			this.showError(`Plan file not found at ${planFilePath}`);
			return;
		}

		this.#renderPlanPreview(planContent);
		const choice = await this.showHookSelector(
			"Plan mode - next step",
			["Approve and execute", "Refine plan", "Stay in plan mode"],
			{
				helpText: this.#getPlanReviewHelpText(),
				onExternalEditor: () => void this.#openPlanInExternalEditor(planFilePath),
			},
		);

		if (choice === "Approve and execute") {
			const finalPlanFilePath = details.finalPlanFilePath || planFilePath;
			try {
				const latestPlanContent = await this.#readPlanFile(planFilePath);
				if (!latestPlanContent) {
					this.showError(`Plan file not found at ${planFilePath}`);
					return;
				}
				await this.#approvePlan(latestPlanContent, { planFilePath, finalPlanFilePath });
			} catch (error) {
				this.showError(
					`Failed to finalize approved plan: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return;
		}
		if (choice === "Refine plan") {
			const refinement = (await this.showHookInput("What should be refined?"))?.trim();
			if (refinement) {
				if (this.onInputCallback) {
					this.onInputCallback(this.startPendingSubmission({ text: refinement }));
				} else {
					this.editor.setText(refinement);
				}
			}
		}
	}

	stop(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.#cleanupMicAnimation();
		if (this.#sttController) {
			this.#sttController.dispose();
			this.#sttController = undefined;
		}
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.#extensionUiController.clearHookWidgets();
		for (const unsubscribe of this.#eventBusUnsubscribers) {
			unsubscribe();
		}
		this.#eventBusUnsubscribers = [];
		this.#observerRegistry.dispose();
		this.#eventController.dispose();
		this.statusLine.dispose();
		if (this.#resizeHandler) {
			process.stdout.removeListener("resize", this.#resizeHandler);
			this.#resizeHandler = undefined;
		}
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.#cleanupUnsubscribe) {
			this.#cleanupUnsubscribe();
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}

	async shutdown(): Promise<void> {
		if (this.#isShuttingDown) return;
		this.#isShuttingDown = true;

		// Flush pending session writes before shutdown
		await this.sessionManager.flush();
		this.#btwController.dispose();

		// Emit shutdown event to hooks
		await this.session.dispose();

		if (this.isInitialized) {
			this.ui.requestRender(true);
		}

		// Wait for any pending renders to complete
		// requestRender() uses process.nextTick(), so we wait one tick
		await new Promise(resolve => process.nextTick(resolve));

		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);
		popTerminalTitle();
		this.stop();

		// Print resumption hint if this is a persisted session
		const sessionId = this.sessionManager.getSessionId();
		const sessionFile = this.sessionManager.getSessionFile();
		if (sessionId && sessionFile) {
			process.stderr.write(`\n${chalk.dim(`Resume this session with ${APP_NAME} --resume ${sessionId}`)}\n`);
		}

		await postmortem.quit(0);
	}

	async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	// Extension UI integration
	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#toolUiContextSetter(uiContext, hasUI);
	}

	initializeHookRunner(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#extensionUiController.initializeHookRunner(uiContext, hasUI);
	}

	createBackgroundUiContext(): ExtensionUIContext {
		return this.#extensionUiController.createBackgroundUiContext();
	}

	// Event handling
	async handleBackgroundEvent(event: AgentSessionEvent): Promise<void> {
		await this.#eventController.handleBackgroundEvent(event);
	}

	// UI helpers
	showStatus(message: string, options?: { dim?: boolean }): void {
		this.#uiHelpers.showStatus(message, options);
	}

	showError(message: string): void {
		this.#pendingSubmittedInput = undefined;
		this.optimisticUserMessageSignature = undefined;
		this.#pendingWorkingMessage = undefined;
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
			this.statusContainer.clear();
		}
		this.#uiHelpers.showError(message);
	}

	showWarning(message: string): void {
		this.#uiHelpers.showWarning(message);
	}

	#handleLspStartupEvent(event: LspStartupEvent): void {
		this.#updateWelcomeLspServers();

		if (event.type === "failed") {
			this.showWarning(`LSP startup failed: ${event.error}. It will retry lazily on write.`);
			return;
		}

		const failedServers = event.servers.filter(server => server.status === "error");

		if (failedServers.length === 1) {
			const failedServer = failedServers[0];
			const detail = failedServer.error ? `: ${failedServer.error}` : "";
			this.showWarning(`LSP startup failed for ${failedServer.name}${detail}. It will retry lazily on write.`);
			return;
		}

		if (failedServers.length > 1) {
			const failedNames = failedServers.map(server => server.name).join(", ");
			this.showWarning(`LSP startup failed for ${failedNames}. It will retry lazily on write.`);
		}
	}

	#getWelcomeLspServers(): WelcomeLspServerInfo[] {
		return (
			this.lspServers?.map(server => ({
				name: server.name,
				status: server.status,
				fileTypes: server.fileTypes,
			})) ?? []
		);
	}

	#updateWelcomeLspServers(): void {
		if (!this.#welcomeComponent) {
			return;
		}

		this.#welcomeComponent.setLspServers(this.#getWelcomeLspServers());
		this.ui.requestRender();
	}

	ensureLoadingAnimation(): void {
		if (!this.loadingAnimation) {
			this.statusContainer.clear();
			this.loadingAnimation = new Loader(
				this.ui,
				spinner => theme.fg("accent", spinner),
				text => theme.fg("muted", text),
				this.#defaultWorkingMessage,
				getSymbolTheme().spinnerFrames,
			);
			this.statusContainer.addChild(this.loadingAnimation);
		}

		this.applyPendingWorkingMessage();
	}

	setWorkingMessage(message?: string): void {
		if (message === undefined) {
			this.#pendingWorkingMessage = undefined;
			if (this.loadingAnimation) {
				this.loadingAnimation.setMessage(this.#defaultWorkingMessage);
			}
			return;
		}

		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(message);
			return;
		}

		this.#pendingWorkingMessage = message;
	}

	applyPendingWorkingMessage(): void {
		if (this.#pendingWorkingMessage === undefined) {
			return;
		}

		const message = this.#pendingWorkingMessage;
		this.#pendingWorkingMessage = undefined;
		this.setWorkingMessage(message);
	}

	showNewVersionNotification(newVersion: string): void {
		this.#uiHelpers.showNewVersionNotification(newVersion);
	}

	clearEditor(): void {
		this.#uiHelpers.clearEditor();
	}

	updatePendingMessagesDisplay(): void {
		this.#uiHelpers.updatePendingMessagesDisplay();
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.#uiHelpers.queueCompactionMessage(text, mode);
	}

	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		return this.#uiHelpers.flushCompactionQueue(options);
	}

	flushPendingBashComponents(): void {
		this.#uiHelpers.flushPendingBashComponents();
	}

	isKnownSlashCommand(text: string): boolean {
		return this.#uiHelpers.isKnownSlashCommand(text);
	}

	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		this.#uiHelpers.addMessageToChat(message, options);
	}

	renderSessionContext(
		sessionContext: SessionContext,
		options?: { updateFooter?: boolean; populateHistory?: boolean },
	): void {
		this.#uiHelpers.renderSessionContext(sessionContext, options);
	}

	renderInitialMessages(): void {
		this.#uiHelpers.renderInitialMessages();
	}

	getUserMessageText(message: Message): string {
		return this.#uiHelpers.getUserMessageText(message);
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		return this.#uiHelpers.findLastAssistantMessage();
	}

	extractAssistantText(message: AssistantMessage): string {
		return this.#uiHelpers.extractAssistantText(message);
	}

	// Command handling
	handleExportCommand(text: string): Promise<void> {
		return this.#commandController.handleExportCommand(text);
	}

	handleDumpCommand() {
		return this.#commandController.handleDumpCommand();
	}

	handleDebugTranscriptCommand(): Promise<void> {
		return this.#commandController.handleDebugTranscriptCommand();
	}

	handleShareCommand(): Promise<void> {
		return this.#commandController.handleShareCommand();
	}

	handleCopyCommand(sub?: string) {
		return this.#commandController.handleCopyCommand(sub);
	}

	handleSessionCommand(): Promise<void> {
		return this.#commandController.handleSessionCommand();
	}

	handleJobsCommand(): Promise<void> {
		return this.#commandController.handleJobsCommand();
	}

	handleUsageCommand(reports?: UsageReport[] | null): Promise<void> {
		return this.#commandController.handleUsageCommand(reports);
	}

	async handleChangelogCommand(showFull = false): Promise<void> {
		await this.#commandController.handleChangelogCommand(showFull);
	}

	handleHotkeysCommand(): void {
		this.#commandController.handleHotkeysCommand();
	}

	handleToolsCommand(): void {
		this.#commandController.handleToolsCommand();
	}

	handleClearCommand(): Promise<void> {
		this.#btwController.dispose();
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.#planReviewContainer = undefined;
		return this.#commandController.handleClearCommand();
	}

	handleForkCommand(): Promise<void> {
		this.#btwController.dispose();
		return this.#commandController.handleForkCommand();
	}

	handleMoveCommand(targetPath: string): Promise<void> {
		return this.#commandController.handleMoveCommand(targetPath);
	}

	handleRenameCommand(title: string): Promise<void> {
		return this.#commandController.handleRenameCommand(title);
	}

	handleMemoryCommand(text: string): Promise<void> {
		return this.#commandController.handleMemoryCommand(text);
	}

	async handleSTTToggle(): Promise<void> {
		if (!settings.get("stt.enabled")) {
			this.showWarning("Speech-to-text is disabled. Enable it in settings: stt.enabled");
			return;
		}
		if (!this.#sttController) {
			this.#sttController = new STTController();
		}
		await this.#sttController.toggle(this.editor, {
			showWarning: (msg: string) => this.showWarning(msg),
			showStatus: (msg: string) => this.showStatus(msg),
			onStateChange: (state: SttState) => {
				if (state === "recording") {
					this.#voicePreviousShowHardwareCursor = this.ui.getShowHardwareCursor();
					this.#voicePreviousUseTerminalCursor = this.editor.getUseTerminalCursor();
					this.ui.setShowHardwareCursor(false);
					this.editor.setUseTerminalCursor(false);
					this.#startMicAnimation();
				} else if (state === "transcribing") {
					this.#stopMicAnimation();
					this.#setMicCursor({ r: 200, g: 200, b: 200 });
				} else {
					this.#cleanupMicAnimation();
				}
				this.updateEditorTopBorder();
				this.ui.requestRender();
			},
		});
	}

	#setMicCursor(color: { r: number; g: number; b: number }): void {
		this.editor.cursorOverride = `\x1b[38;2;${color.r};${color.g};${color.b}m${theme.icon.mic}\x1b[0m`;
		// Theme symbols can be wide (for example, 🎤), so measure the rendered override.
		this.editor.cursorOverrideWidth = visibleWidth(this.editor.cursorOverride);
	}

	#updateMicIcon(): void {
		const { r, g, b } = hsvToRgb({ h: this.#voiceHue, s: 0.9, v: 1.0 });
		this.#setMicCursor({ r, g, b });
	}

	#startMicAnimation(): void {
		if (this.#voiceAnimationInterval) return;
		this.#voiceHue = 0;
		this.#updateMicIcon();
		this.#voiceAnimationInterval = setInterval(() => {
			this.#voiceHue = (this.#voiceHue + 8) % 360;
			this.#updateMicIcon();
			this.ui.requestRender();
		}, 60);
	}

	#stopMicAnimation(): void {
		if (this.#voiceAnimationInterval) {
			clearInterval(this.#voiceAnimationInterval);
			this.#voiceAnimationInterval = undefined;
		}
	}

	#cleanupMicAnimation(): void {
		if (this.#voiceAnimationInterval) {
			clearInterval(this.#voiceAnimationInterval);
			this.#voiceAnimationInterval = undefined;
		}
		this.editor.cursorOverride = undefined;
		this.editor.cursorOverrideWidth = undefined;
		if (this.#voicePreviousShowHardwareCursor !== null) {
			this.ui.setShowHardwareCursor(this.#voicePreviousShowHardwareCursor);
			this.#voicePreviousShowHardwareCursor = null;
		}
		if (this.#voicePreviousUseTerminalCursor !== null) {
			this.editor.setUseTerminalCursor(this.#voicePreviousUseTerminalCursor);
			this.#voicePreviousUseTerminalCursor = null;
		}
	}

	showDebugSelector(): void {
		this.#selectorController.showDebugSelector();
	}

	showSessionObserver(): void {
		const sessions = this.#observerRegistry.getSessions();
		if (sessions.length <= 1) {
			this.showStatus("No active subagent sessions");
			return;
		}
		this.#selectorController.showSessionObserver(this.#observerRegistry);
	}

	resetObserverRegistry(): void {
		this.#observerRegistry.resetSessions();
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
	}

	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void> {
		return this.#commandController.handleBashCommand(command, excludeFromContext);
	}

	handlePythonCommand(code: string, excludeFromContext?: boolean): Promise<void> {
		return this.#commandController.handlePythonCommand(code, excludeFromContext);
	}

	async handleMCPCommand(text: string): Promise<void> {
		const controller = new MCPCommandController(this);
		await controller.handle(text);
	}

	async handleSSHCommand(text: string): Promise<void> {
		const controller = new SSHCommandController(this);
		await controller.handle(text);
	}

	handleCompactCommand(customInstructions?: string): Promise<void> {
		return this.#commandController.handleCompactCommand(customInstructions);
	}

	handleHandoffCommand(customInstructions?: string): Promise<void> {
		return this.#commandController.handleHandoffCommand(customInstructions);
	}

	executeCompaction(customInstructionsOrOptions?: string | CompactOptions, isAuto?: boolean): Promise<void> {
		return this.#commandController.executeCompaction(customInstructionsOrOptions, isAuto);
	}

	openInBrowser(urlOrPath: string): void {
		this.#commandController.openInBrowser(urlOrPath);
	}

	// Selector handling
	showSettingsSelector(): void {
		this.#selectorController.showSettingsSelector();
	}

	showHistorySearch(): void {
		this.#selectorController.showHistorySearch();
	}

	showExtensionsDashboard(): void {
		void this.#selectorController.showExtensionsDashboard();
	}

	showAgentsDashboard(): void {
		void this.#selectorController.showAgentsDashboard();
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		this.#selectorController.showModelSelector(options);
	}

	showPluginSelector(mode?: "install" | "uninstall"): void {
		void this.#selectorController.showPluginSelector(mode);
	}

	showUserMessageSelector(): void {
		this.#selectorController.showUserMessageSelector();
	}

	showTreeSelector(): void {
		this.#selectorController.showTreeSelector();
	}

	showSessionSelector(): void {
		this.#selectorController.showSessionSelector();
	}

	handleResumeSession(sessionPath: string): Promise<void> {
		this.#btwController.dispose();
		this.resetObserverRegistry();
		return this.#selectorController.handleResumeSession(sessionPath);
	}

	handleSessionDeleteCommand(): Promise<void> {
		return this.#selectorController.handleSessionDeleteCommand();
	}

	showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void> {
		return this.#selectorController.showOAuthSelector(mode, providerId);
	}

	showHookConfirm(title: string, message: string): Promise<boolean> {
		return this.#extensionUiController.showHookConfirm(title, message);
	}

	// Input handling
	handleCtrlC(): void {
		this.#inputController.handleCtrlC();
	}

	handleCtrlD(): void {
		this.#inputController.handleCtrlD();
	}

	handleCtrlZ(): void {
		this.#inputController.handleCtrlZ();
	}

	handleDequeue(): void {
		this.#inputController.handleDequeue();
	}

	handleBackgroundCommand(): void {
		this.#inputController.handleBackgroundCommand();
	}

	handleImagePaste(): Promise<boolean> {
		return this.#inputController.handleImagePaste();
	}

	handleBtwCommand(question: string): Promise<void> {
		return this.#btwController.start(question);
	}

	hasActiveBtw(): boolean {
		return this.#btwController.hasActiveRequest();
	}

	handleBtwEscape(): boolean {
		return this.#btwController.handleEscape();
	}

	cycleThinkingLevel(): void {
		this.#inputController.cycleThinkingLevel();
	}

	cycleRoleModel(options?: { temporary?: boolean }): Promise<void> {
		return this.#inputController.cycleRoleModel(options);
	}

	toggleToolOutputExpansion(): void {
		this.#inputController.toggleToolOutputExpansion();
	}

	setToolsExpanded(expanded: boolean): void {
		this.#inputController.setToolsExpanded(expanded);
	}

	toggleThinkingBlockVisibility(): void {
		this.#inputController.toggleThinkingBlockVisibility();
	}

	toggleTodoExpansion(): void {
		this.todoExpanded = !this.todoExpanded;
		this.#renderTodoList();
		this.ui.requestRender();
	}

	setTodos(todos: TodoItem[] | TodoPhase[]): void {
		if (todos.length > 0 && "tasks" in todos[0]) {
			this.todoPhases = todos as TodoPhase[];
		} else {
			this.todoPhases = [
				{
					id: "default",
					name: "Todos",
					tasks: todos as TodoItem[],
				},
			];
		}
		this.#renderTodoList();
		this.ui.requestRender();
	}

	async reloadTodos(): Promise<void> {
		await this.#loadTodoList();
		this.ui.requestRender();
	}

	openExternalEditor(): void {
		this.#inputController.openExternalEditor();
	}

	registerExtensionShortcuts(): void {
		this.#inputController.registerExtensionShortcuts();
	}

	// Hook UI methods
	initHooksAndCustomTools(): Promise<void> {
		return this.#extensionUiController.initHooksAndCustomTools();
	}

	emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void> {
		return this.#extensionUiController.emitCustomToolSessionEvent(reason, previousSessionFile);
	}

	setHookWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		this.#extensionUiController.setHookWidget(key, content, options);
	}

	setHookStatus(key: string, text: string | undefined): void {
		this.#extensionUiController.setHookStatus(key, text);
	}

	showHookSelector(
		title: string,
		options: string[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookSelector(title, options, dialogOptions);
	}

	hideHookSelector(): void {
		this.#extensionUiController.hideHookSelector();
	}

	showHookInput(title: string, placeholder?: string): Promise<string | undefined> {
		return this.#extensionUiController.showHookInput(title, placeholder);
	}

	hideHookInput(): void {
		this.#extensionUiController.hideHookInput();
	}

	showHookEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookEditor(title, prefill, dialogOptions, editorOptions);
	}

	hideHookEditor(): void {
		this.#extensionUiController.hideHookEditor();
	}

	showHookNotify(message: string, type?: "info" | "warning" | "error"): void {
		this.#extensionUiController.showHookNotify(message, type);
	}

	showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: { overlay?: boolean },
	): Promise<T> {
		return this.#extensionUiController.showHookCustom(factory, options);
	}

	showExtensionError(extensionPath: string, error: string): void {
		this.#extensionUiController.showExtensionError(extensionPath, error);
	}

	showToolError(toolName: string, error: string): void {
		this.#extensionUiController.showToolError(toolName, error);
	}

	#subscribeToAgent(): void {
		this.#eventController.subscribeToAgent();
	}
}
