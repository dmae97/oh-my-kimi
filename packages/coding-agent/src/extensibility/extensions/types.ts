/**
 * Extension system types.
 *
 * Extensions are TypeScript modules that can:
 * - Subscribe to agent lifecycle events
 * - Register LLM-callable tools
 * - Register commands, keyboard shortcuts, and CLI flags
 * - Interact with the user via UI primitives
 */
import type { AgentMessage, AgentToolResult, AgentToolUpdateCallback, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	ProviderResponseMetadata,
	SimpleStreamOptions,
	TextContent,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import type * as piCodingAgent from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem, Component, EditorComponent, EditorTheme, KeyId, TUI } from "@oh-my-pi/pi-tui";
import type { Static, TSchema } from "@sinclair/typebox";
import type { Rule } from "../../capability/rule";
import type { KeybindingsManager } from "../../config/keybindings";
import type { ModelRegistry } from "../../config/model-registry";
import type { EditToolDetails } from "../../edit";
import type { BashResult } from "../../exec/bash-executor";
import type { ExecOptions, ExecResult } from "../../exec/exec";
import type { PythonResult } from "../../ipy/executor";
import type { Theme } from "../../modes/theme/theme";
import type { CompactionPreparation, CompactionResult } from "../../session/compaction";
import type { CustomMessage } from "../../session/messages";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	ReadonlySessionManager,
	SessionEntry,
	SessionManager,
} from "../../session/session-manager";
import type {
	BashToolDetails,
	BashToolInput,
	FindToolDetails,
	FindToolInput,
	ReadToolDetails,
	ReadToolInput,
	SearchToolDetails,
	SearchToolInput,
	WriteToolInput,
} from "../../tools";
import type { TodoItem } from "../../tools/todo-write";
import type { EventBus } from "../../utils/event-bus";
import type { SlashCommandInfo } from "../slash-commands";

export type { AppKeybinding, KeybindingsManager } from "../../config/keybindings";
export type { ExecOptions, ExecResult } from "../../exec/exec";
export type { AgentToolResult, AgentToolUpdateCallback };

// ============================================================================
// UI Context
// ============================================================================

/**
 * UI dialog options for extensions.
 */
export interface ExtensionUIDialogOptions {
	signal?: AbortSignal;
	timeout?: number;
	/** Invoked when the UI times out while waiting for a selection/input */
	onTimeout?: () => void;
	/** Initial cursor position for select dialogs (0-indexed) */
	initialIndex?: number;
	/** Render an outlined list for select dialogs */
	outline?: boolean;
	/** Invoked when user presses left arrow in select dialogs */
	onLeft?: () => void;
	/** Invoked when user presses right arrow in select dialogs */
	onRight?: () => void;
	/** Invoked when user presses the external editor shortcut in select dialogs */
	onExternalEditor?: () => void;
	/** Optional footer hint text rendered by interactive selector */
	helpText?: string;
}

/** Raw terminal input listener for extensions. */
export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

export type WidgetPlacement = "aboveEditor" | "belowEditor";

export interface ExtensionWidgetOptions {
	placement?: WidgetPlacement;
}

export type ExtensionUiComponent = Component & { dispose?(): void };
export type ExtensionUiComponentFactory = (tui: TUI, theme: Theme) => ExtensionUiComponent;
export type ExtensionWidgetContent = string[] | ExtensionUiComponentFactory | undefined;

/**
 * UI context for extensions to request interactive UI.
 * Each mode (interactive, RPC, print) provides its own implementation.
 */
export interface ExtensionUIContext {
	/** Show a selector and return the user's choice. */
	select(title: string, options: string[], dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show a confirmation dialog. */
	confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean>;

	/** Show a text input dialog. */
	input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show a notification to the user. */
	notify(message: string, type?: "info" | "warning" | "error"): void;

	/** Listen to raw terminal input (interactive mode only). Returns an unsubscribe function. */
	onTerminalInput(handler: TerminalInputHandler): () => void;

	/** Set status text in the footer/status bar. Pass undefined to clear. */
	setStatus(key: string, text: string | undefined): void;

	/** Set the working/loading message shown during streaming. Call with no argument to restore default. */
	setWorkingMessage(message?: string): void;

	/** Set a widget to display above or below the editor. Accepts string array or component factory. */
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;

	/** Set a custom footer component, or undefined to restore the built-in footer. */
	setFooter(factory: ExtensionUiComponentFactory | undefined): void;

	/** Set a custom header component, or undefined to restore the built-in header. */
	setHeader(factory: ExtensionUiComponentFactory | undefined): void;

	/** Set the terminal window/tab title. */
	setTitle(title: string): void;

	/** Show a custom component with keyboard focus. */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => ExtensionUiComponent | Promise<ExtensionUiComponent>,
		options?: { overlay?: boolean },
	): Promise<T>;

	/** Set the text in the core input editor. */
	setEditorText(text: string): void;

	/**
	 * Paste text into the core input editor.
	 *
	 * Interactive mode should route through the editor's paste handling (e.g. large paste markers).
	 * Non-interactive modes may fall back to replacing the editor text.
	 */
	pasteToEditor(text: string): void;

	/** Get the current text from the core input editor. */
	getEditorText(): string;

	/** Show a multi-line editor for text editing. */
	editor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined>;

	/** Set a custom editor component via factory function, or undefined to restore the default editor. */
	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined,
	): void;

	/** Get the current theme for styling. */
	readonly theme: Theme;

	/** Get all available themes with names and paths. */
	getAllThemes(): Promise<{ name: string; path: string | undefined }[]>;

	/** Load a theme by name without switching to it. */
	getTheme(name: string): Promise<Theme | undefined>;

	/** Set the current theme by name or Theme object. */
	setTheme(theme: string | Theme): Promise<{ success: boolean; error?: string }>;

	/** Get current tool output expansion state. */
	getToolsExpanded(): boolean;

	/** Set tool output expansion state. */
	setToolsExpanded(expanded: boolean): void;
}

// ============================================================================
// Extension Context
// ============================================================================

export interface ContextUsage {
	/** Estimated context tokens, or null if unknown (e.g. right after compaction, before next LLM response). */
	tokens: number | null;
	contextWindow: number;
	/** Context usage as percentage of context window, or null if tokens is unknown. */
	percent: number | null;
}

export interface CompactOptions {
	onComplete?: (result: CompactionResult) => void;
	onError?: (error: Error) => void;
}

/**
 * Context passed to extension event handlers.
 */
export interface ExtensionContext {
	/** UI methods for user interaction */
	ui: ExtensionUIContext;
	/** Get current context usage for the active model. */
	getContextUsage(): ContextUsage | undefined;
	/** Compact the session context (interactive mode shows UI). */
	compact(instructionsOrOptions?: string | CompactOptions): Promise<void>;
	/** Whether UI is available (false in print/RPC mode) */
	hasUI: boolean;
	/** Current working directory */
	cwd: string;
	/** Session manager (read-only) */
	sessionManager: ReadonlySessionManager;
	/** Model registry for API key resolution */
	modelRegistry: ModelRegistry;
	/** Current model (may be undefined) */
	model: Model | undefined;
	/** Whether the agent is idle (not streaming) */
	isIdle(): boolean;
	/** Abort the current agent operation */
	abort(): void;
	/** Whether there are queued messages waiting */
	hasPendingMessages(): boolean;
	/** Gracefully shutdown and exit. */
	shutdown(): void;
	/** Get the current effective system prompt. */
	getSystemPrompt(): string;
	/** @deprecated Use hasPendingMessages() instead */
	hasQueuedMessages(): boolean;
}

/**
 * Extended context for command handlers.
 * Includes session control methods only safe in user-initiated commands.
 */
export interface ExtensionCommandContext extends ExtensionContext {
	/** Get current context usage for the active model. */
	getContextUsage(): ContextUsage | undefined;

	/** Wait for the agent to finish streaming */
	waitForIdle(): Promise<void>;

	/** Start a new session, optionally with initialization. */
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	/** Branch from a specific entry, creating a new session file. */
	branch(entryId: string): Promise<{ cancelled: boolean }>;

	/** Navigate to a different point in the session tree. */
	navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>;

	/** Switch to a different session file. */
	switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;

	/** Reload the current session/runtime state. */
	reload(): Promise<void>;

	/** Compact the session context (interactive mode shows UI). */
	compact(instructionsOrOptions?: string | CompactOptions): Promise<void>;
}

// ============================================================================
// Tool Types
// ============================================================================

/** Rendering options for tool results */
export interface ToolRenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
	/** Current spinner frame index for animated elements (optional) */
	spinnerFrame?: number;
}

/** Session event for tool onSession lifecycle */
export interface ToolSessionEvent {
	/** Reason for the session event */
	reason: "start" | "switch" | "branch" | "tree" | "shutdown";
	/** Previous session file path, or undefined for "start" and "shutdown" */
	previousSessionFile: string | undefined;
}

/**
 * Tool definition for registerTool().
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
	/** Tool name (used in LLM tool calls) */
	name: string;
	/** Human-readable label for UI */
	label: string;
	/** Description for LLM */
	description: string;
	/** Parameter schema (TypeBox) */
	parameters: TParams;
	/** If true, tool is excluded unless explicitly listed in --tools or agent's tools field */
	hidden?: boolean;
	/** If true, tool is registered but not auto-included in the initial active set.
	 *  The registering extension is responsible for activating/deactivating it via setActiveTools(). */
	defaultInactive?: boolean;
	/** If true, tool may stage deferred changes that require explicit resolve/discard. */
	deferrable?: boolean;
	/** MCP server name for discovery/search metadata when this tool fronts an MCP server. */
	mcpServerName?: string;
	/** Original MCP tool name for discovery/search metadata. */
	mcpToolName?: string;
	/** Execute the tool. */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<TDetails>>;

	/** Called on session lifecycle events - use to reconstruct state or cleanup resources */
	onSession?: (event: ToolSessionEvent, ctx: ExtensionContext) => void | Promise<void>;

	/** Custom rendering for tool call display */
	renderCall?: (args: Static<TParams>, options: ToolRenderResultOptions, theme: Theme) => Component;

	/** Custom rendering for tool result display */
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		args?: Static<TParams>,
	) => Component;
}

// ============================================================================
// Resource Events
// ============================================================================

/** Fired after session_start to allow extensions to provide additional resource paths. */
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

/** Result from resources_discover event handler */
export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

// ============================================================================
// Session Events
// ============================================================================

/** Fired on initial session load */
export interface SessionStartEvent {
	type: "session_start";
}

/** Fired before switching to another session (can be cancelled) */
export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	reason: "new" | "resume" | "fork";
	targetSessionFile?: string;
}

/** Fired after switching to another session */
export interface SessionSwitchEvent {
	type: "session_switch";
	reason: "new" | "resume" | "fork";
	previousSessionFile: string | undefined;
}

/** Fired before branching a session (can be cancelled) */
export interface SessionBeforeBranchEvent {
	type: "session_before_branch";
	entryId: string;
}

/** Fired after branching a session */
export interface SessionBranchEvent {
	type: "session_branch";
	previousSessionFile: string | undefined;
}

/** Fired before context compaction (can be cancelled or customized) */
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	customInstructions?: string;
	signal: AbortSignal;
}

/** Fired before compaction summarization to customize prompts/context */
export interface SessionCompactingEvent {
	type: "session.compacting";
	sessionId: string;
	messages: AgentMessage[];
}

/** Fired after context compaction */
export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	fromExtension: boolean;
}

/** Fired on process exit */
export interface SessionShutdownEvent {
	type: "session_shutdown";
}

/** Preparation data for tree navigation */
export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionEntry[];
	userWantsSummary: boolean;
}

/** Fired before navigating in the session tree (can be cancelled) */
export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	preparation: TreePreparation;
	signal: AbortSignal;
}

/** Fired after navigating in the session tree */
export interface SessionTreeEvent {
	type: "session_tree";
	newLeafId: string | null;
	oldLeafId: string | null;
	summaryEntry?: BranchSummaryEntry;
	fromExtension?: boolean;
}

export type SessionEvent =
	| SessionStartEvent
	| SessionBeforeSwitchEvent
	| SessionSwitchEvent
	| SessionBeforeBranchEvent
	| SessionBranchEvent
	| SessionBeforeCompactEvent
	| SessionCompactingEvent
	| SessionCompactEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent;

// ============================================================================
// Agent Events
// ============================================================================

/** Fired before each LLM call. Can modify messages. */
export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

/** Fired before a provider request is sent. Can replace the payload. */
export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	payload: unknown;
}

/** Fired after a provider response is received, before its stream body is consumed. */
export interface AfterProviderResponseEvent extends ProviderResponseMetadata {
	type: "after_provider_response";
}

/** Fired after user submits prompt but before agent loop. */
export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	images?: ImageContent[];
	systemPrompt: string;
}

/** Fired when an agent loop starts */
export interface AgentStartEvent {
	type: "agent_start";
}

/** Fired when an agent loop ends */
export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
}

/** Fired at the start of each turn */
export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

/** Fired at the end of each turn */
export interface TurnEndEvent {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
}

/** Fired when a message starts (user, assistant, or toolResult) */
export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

/** Fired during assistant message streaming with token-by-token updates */
export interface MessageUpdateEvent {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

/** Fired when a message ends */
export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

/** Fired when a tool starts executing */
export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
}

/** Fired during tool execution with partial/streaming output */
export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: unknown;
	partialResult: unknown;
}

/** Fired when a tool finishes executing */
export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}

/** Fired when auto-compaction starts */
export interface AutoCompactionStartEvent {
	type: "auto_compaction_start";
	reason: "threshold" | "overflow" | "idle";
	action: "context-full" | "handoff";
}

/** Fired when auto-compaction ends */
export interface AutoCompactionEndEvent {
	type: "auto_compaction_end";
	action: "context-full" | "handoff";
	result: CompactionResult | undefined;
	aborted: boolean;
	willRetry: boolean;
	errorMessage?: string;
	/** True when compaction was skipped for a benign reason (no model, no candidates, nothing to compact). */
	skipped?: boolean;
}

/** Fired when auto-retry starts */
export interface AutoRetryStartEvent {
	type: "auto_retry_start";
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}

/** Fired when auto-retry ends */
export interface AutoRetryEndEvent {
	type: "auto_retry_end";
	success: boolean;
	attempt: number;
	finalError?: string;
}

/** Fired when TTSR rule matching interrupts generation */
export interface TtsrTriggeredEvent {
	type: "ttsr_triggered";
	rules: Rule[];
}

/** Fired when todo reminder logic detects unfinished todos */
export interface TodoReminderEvent {
	type: "todo_reminder";
	todos: TodoItem[];
	attempt: number;
	maxAttempts: number;
}

// ============================================================================
// User Bash Events
// ============================================================================

/** Fired when user executes a bash command via ! or !! prefix */
export interface UserBashEvent {
	type: "user_bash";
	/** The command to execute */
	command: string;
	/** True if !! prefix was used (excluded from LLM context) */
	excludeFromContext: boolean;
	/** Current working directory */
	cwd: string;
}

// ============================================================================
// User Python Events
// ============================================================================

/** Fired when user executes Python code via $ or $$ prefix */
export interface UserPythonEvent {
	type: "user_python";
	/** The Python code to execute */
	code: string;
	/** True if $$ prefix was used (excluded from LLM context) */
	excludeFromContext: boolean;
	/** Current working directory */
	cwd: string;
}

// ============================================================================
// Input Events
// ============================================================================

/** Fired when the user submits input (interactive mode only). */
export interface InputEvent {
	type: "input";
	text: string;
	images?: ImageContent[];
	source: "interactive" | "rpc" | "extension";
}

// ============================================================================
// Tool Events
// ============================================================================

interface ToolCallEventBase {
	type: "tool_call";
	toolCallId: string;
}

export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

export interface ReadToolCallEvent extends ToolCallEventBase {
	toolName: "read";
	input: ReadToolInput;
}

export interface EditToolCallEvent extends ToolCallEventBase {
	toolName: "edit";
	input: Record<string, unknown>;
}

export interface WriteToolCallEvent extends ToolCallEventBase {
	toolName: "write";
	input: WriteToolInput;
}

export interface SearchToolCallEvent extends ToolCallEventBase {
	toolName: "search";
	input: SearchToolInput;
}

export interface FindToolCallEvent extends ToolCallEventBase {
	toolName: "find";
	input: FindToolInput;
}

export interface CustomToolCallEvent extends ToolCallEventBase {
	toolName: string;
	input: Record<string, unknown>;
}

/** Fired before a tool executes. Can block. */
export type ToolCallEvent =
	| BashToolCallEvent
	| ReadToolCallEvent
	| EditToolCallEvent
	| WriteToolCallEvent
	| SearchToolCallEvent
	| FindToolCallEvent
	| CustomToolCallEvent;

interface ToolResultEventBase {
	type: "tool_result";
	toolCallId: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	isError: boolean;
}

export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

export interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details: ReadToolDetails | undefined;
}

export interface EditToolResultEvent extends ToolResultEventBase {
	toolName: "edit";
	details: EditToolDetails | undefined;
}

export interface WriteToolResultEvent extends ToolResultEventBase {
	toolName: "write";
	details: undefined;
}

export interface SearchToolResultEvent extends ToolResultEventBase {
	toolName: "search";
	details: SearchToolDetails | undefined;
}

export interface FindToolResultEvent extends ToolResultEventBase {
	toolName: "find";
	details: FindToolDetails | undefined;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

/** Fired after a tool executes. Can modify result. */
export type ToolResultEvent =
	| BashToolResultEvent
	| ReadToolResultEvent
	| EditToolResultEvent
	| WriteToolResultEvent
	| SearchToolResultEvent
	| FindToolResultEvent
	| CustomToolResultEvent;

/**
 * Type guard for narrowing ToolCallEvent by tool name.
 *
 * Built-in tools narrow automatically (no type params needed):
 * ```ts
 * if (isToolCallEventType("bash", event)) {
 *   event.input.command;  // string
 * }
 * ```
 *
 * Custom tools require explicit type parameters:
 * ```ts
 * if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
 *   event.input.action;  // typed
 * }
 * ```
 *
 * Note: Direct narrowing via `event.toolName === "bash"` doesn't work because
 * CustomToolCallEvent.toolName is `string` which overlaps with all literals.
 */
export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
export function isToolCallEventType(toolName: "search", event: ToolCallEvent): event is SearchToolCallEvent;
export function isToolCallEventType(toolName: "find", event: ToolCallEvent): event is FindToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
	toolName: TName,
	event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}

/** Union of all event types */
export type ExtensionEvent =
	| ResourcesDiscoverEvent
	| SessionEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| AutoCompactionStartEvent
	| AutoCompactionEndEvent
	| AutoRetryStartEvent
	| AutoRetryEndEvent
	| TtsrTriggeredEvent
	| TodoReminderEvent
	| UserBashEvent
	| UserPythonEvent
	| InputEvent
	| ToolCallEvent
	| ToolResultEvent;

// ============================================================================
// Event Results
// ============================================================================

export interface ContextEventResult {
	messages?: AgentMessage[];
}

export type BeforeProviderRequestEventResult = unknown;

export interface ToolCallEventResult {
	block?: boolean;
	reason?: string;
}

/** Result from input event handler */
export interface InputEventResult {
	/** If true, the input was handled and should not continue through normal flow */
	handled?: boolean;
	/** Replace the input text */
	text?: string;
	/** Replace any pending images */
	images?: ImageContent[];
}

/** Result from user_bash event handler */
export interface UserBashEventResult {
	/** Full replacement: extension handled execution, use this result */
	result?: BashResult;
}

/** Result from user_python event handler */
export interface UserPythonEventResult {
	/** Full replacement: extension handled execution, use this result */
	result?: PythonResult;
}

export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
}

export interface BeforeAgentStartEventResult {
	message?: Pick<CustomMessage, "customType" | "content" | "display" | "details" | "attribution">;
	/** Replace the system prompt for this turn. If multiple extensions return this, they are chained. */
	systemPrompt?: string;
}

export interface SessionBeforeSwitchResult {
	cancel?: boolean;
}

export interface SessionBeforeBranchResult {
	cancel?: boolean;
	skipConversationRestore?: boolean;
}

export interface SessionBeforeCompactResult {
	cancel?: boolean;
	compaction?: CompactionResult;
}

export interface SessionCompactingResult {
	context?: string[];
	prompt?: string;
	preserveData?: Record<string, unknown>;
}

export interface SessionBeforeTreeResult {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: unknown;
	};
}

// ============================================================================
// Message Rendering
// ============================================================================

export interface MessageRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

// ============================================================================
// Command Registration
// ============================================================================

export interface RegisteredCommand {
	name: string;
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

// ============================================================================
// Extension API
// ============================================================================

/** Handler function type for events */
// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/**
 * ExtensionAPI passed to extension factory functions.
 */
export interface ExtensionAPI {
	// =========================================================================
	// Module Access
	// =========================================================================

	/** File logger for error/warning/debug messages */
	logger: typeof import("@oh-my-pi/pi-utils").logger;

	/** Injected @sinclair/typebox module for defining tool parameters */
	typebox: typeof import("@sinclair/typebox");

	/** Injected pi-coding-agent exports for accessing SDK utilities */
	pi: typeof piCodingAgent;

	// =========================================================================
	// Event Subscription
	// =========================================================================

	on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): void;
	on(event: "session_switch", handler: ExtensionHandler<SessionSwitchEvent>): void;
	on(
		event: "session_before_branch",
		handler: ExtensionHandler<SessionBeforeBranchEvent, SessionBeforeBranchResult>,
	): void;
	on(event: "session_branch", handler: ExtensionHandler<SessionBranchEvent>): void;
	on(
		event: "session_before_compact",
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): void;
	on(event: "session.compacting", handler: ExtensionHandler<SessionCompactingEvent, SessionCompactingResult>): void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
	on(
		event: "before_provider_request",
		handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
	): void;
	on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
	on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent>): void;
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
	on(event: "auto_compaction_start", handler: ExtensionHandler<AutoCompactionStartEvent>): void;
	on(event: "auto_compaction_end", handler: ExtensionHandler<AutoCompactionEndEvent>): void;
	on(event: "auto_retry_start", handler: ExtensionHandler<AutoRetryStartEvent>): void;
	on(event: "auto_retry_end", handler: ExtensionHandler<AutoRetryEndEvent>): void;
	on(event: "ttsr_triggered", handler: ExtensionHandler<TtsrTriggeredEvent>): void;
	on(event: "todo_reminder", handler: ExtensionHandler<TodoReminderEvent>): void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
	on(event: "user_python", handler: ExtensionHandler<UserPythonEvent, UserPythonEventResult>): void;

	// =========================================================================
	// Tool Registration
	// =========================================================================

	/** Register a tool that the LLM can call. */
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;

	// =========================================================================
	// Command, Shortcut, Flag Registration
	// =========================================================================

	/** Register a custom command. */
	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void;

	/** Register a keyboard shortcut. */
	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;

	/** Register a CLI flag. */
	registerFlag(
		name: string,
		options: {
			description?: string;
			type: "boolean" | "string";
			default?: boolean | string;
		},
	): void;

	/** Set the display label for this extension, or set a label on a specific entry. */
	setLabel(entryIdOrLabel: string, label?: string | undefined): void;

	/** Get the value of a registered CLI flag. */
	getFlag(name: string): boolean | string | undefined;

	// =========================================================================
	// Message Rendering
	// =========================================================================

	/** Register a custom renderer for CustomMessageEntry. */
	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;

	// =========================================================================
	// Actions
	// =========================================================================

	/**
	 * Send a custom message to the session.
	 *
	 * `deliverAs: "nextTurn"` keeps the message hidden from the editable pending-message UI.
	 * If `triggerTurn` is also true while the current turn is still unwinding, the session schedules
	 * an internal continuation that consumes the message on the next turn.
	 */
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;

	/** Send a user message to the agent. Always triggers a turn. */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void;

	/** Append a custom entry to the session for state persistence (not sent to LLM). */
	appendEntry<T = unknown>(customType: string, data?: T): void;

	/** Execute a shell command. */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	/** Get the list of currently active tool names. */
	getActiveTools(): string[];

	/** Get all configured tools (built-in + extension tools). */
	getAllTools(): string[];

	/** Set the active tools by name. */
	setActiveTools(toolNames: string[]): Promise<void>;

	/** Get available slash commands in the current session. */
	getCommands(): SlashCommandInfo[];

	/** Set the current model. Returns false if no API key available. */
	setModel(model: Model): Promise<boolean>;

	/** Get current thinking level. */
	getThinkingLevel(): ThinkingLevel | undefined;

	/** Set thinking level for the current session. */
	setThinkingLevel(level: ThinkingLevel): void;

	/** Get the current session name. */
	getSessionName(): string | undefined;

	/** Set the session name. Persists to the session file. */
	setSessionName(name: string): Promise<void>;

	// =========================================================================
	// Provider Registration
	// =========================================================================

	/**
	 * Register or override a model provider.
	 *
	 * If `models` is provided: replaces all existing models for this provider.
	 * If only `baseUrl` is provided: overrides the URL for existing models.
	 * If `streamSimple` is provided: registers a custom API stream handler.
	 *
	 * @example
	 * // Register a new provider with custom models and streaming
	 * pi.registerProvider("google-vertex-claude", {
	 *   baseUrl: "https://us-east5-aiplatform.googleapis.com",
	 *   apiKey: "GOOGLE_CLOUD_PROJECT",
	 *   api: "vertex-claude-api",
	 *   streamSimple: myStreamFunction,
	 *   models: [
	 *     {
	 *       id: "claude-sonnet-4@20250514",
	 *       name: "Claude Sonnet 4 (Vertex)",
	 *       reasoning: true,
	 *       thinking: { mode: "anthropic-adaptive", minLevel: "minimal", maxLevel: "high" },
	 *       input: ["text", "image"],
	 *       cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	 *       contextWindow: 200000,
	 *       maxTokens: 64000,
	 *   ]
	 * });
	 *
	 * @example
	 * // Override baseUrl for an existing provider
	 * pi.registerProvider("anthropic", {
	 *   baseUrl: "https://proxy.example.com"
	 * });
	 */
	registerProvider(name: string, config: ProviderConfig): void;

	/** Shared event bus for extension communication. */
	events: EventBus;
}

// ============================================================================
// Provider Registration Types
// ============================================================================

/** Configuration for registering a provider via pi.registerProvider(). */
export interface ProviderConfig {
	/** Base URL for the API endpoint. Required when defining models. */
	baseUrl?: string;
	/** API key or environment variable name. Required when defining models unless oauth is provided. */
	apiKey?: string;
	/** API type identifier. Required when registering streamSimple or when models don't specify one. */
	api?: Api;
	/** Custom streaming function for non-built-in APIs. */
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	/** Custom headers to include in requests. */
	headers?: Record<string, string>;
	/** If true, adds Authorization: Bearer header with the resolved API key. */
	authHeader?: boolean;
	/** Models to register. If provided, replaces all existing models for this provider. */
	models?: ProviderModelConfig[];
	/** OAuth provider for /login support. */
	oauth?: {
		/** Display name in login UI. */
		name: string;
		/** Run the provider login flow and return credentials (or a plain API key) to persist. */
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;
		/** Refresh expired credentials. */
		refreshToken?(credentials: OAuthCredentials): Promise<OAuthCredentials>;
		/** Convert credentials to an API key string for requests. */
		getApiKey?(credentials: OAuthCredentials): string;
		/** Optional model rewrite hook for credential-aware routing (e.g., enterprise URLs). */
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
}

/** Configuration for a model within a provider. */
export interface ProviderModelConfig {
	/** Model ID (e.g., "claude-sonnet-4@20250514"). */
	id: string;
	/** Display name (e.g., "Claude Sonnet 4 (Vertex)"). */
	name: string;
	/** API type override for this model. */
	api?: Api;
	/** Whether the model supports extended thinking at all. */
	reasoning: boolean;
	/** Optional canonical thinking capability metadata for per-model effort support. */
	thinking?: Model["thinking"];
	/** Supported input types. */
	input: ("text" | "image")[];
	/** Cost per million tokens. */
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** Premium Copilot requests charged per user-initiated request. */
	premiumMultiplier?: number;
	/** Maximum context window size in tokens. */
	contextWindow: number;
	/** Maximum output tokens. */
	maxTokens: number;
	/** Custom headers for this model. */
	headers?: Record<string, string>;
	/** OpenAI compatibility settings. */
	compat?: Model<Api>["compat"];
}

/** Extension factory function type. Supports both sync and async initialization. */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

// ============================================================================
// Loaded Extension Types
// ============================================================================

export interface RegisteredTool<TParams extends TSchema = TSchema, TDetails = unknown> {
	definition: ToolDefinition<TParams, TDetails>;
	extensionPath: string;
}

export interface ExtensionFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
	extensionPath: string;
}

export interface ExtensionShortcut {
	shortcut: KeyId;
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
	extensionPath: string;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

export type SendMessageHandler = <T = unknown>(
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
	/**
	 * `deliverAs: "nextTurn"` queues hidden custom context for the next turn.
	 * When paired with `triggerTurn: true` during prompt teardown, the session schedules
	 * an internal continuation without surfacing the message in the editable pending queue.
	 */
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;

export type SendUserMessageHandler = (
	content: string | (TextContent | ImageContent)[],
	options?: { deliverAs?: "steer" | "followUp" },
) => void;

export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

export type GetActiveToolsHandler = () => string[];

export type GetAllToolsHandler = () => string[];

export type GetCommandsHandler = () => SlashCommandInfo[];

export type SetActiveToolsHandler = (toolNames: string[]) => Promise<void>;

export type SetModelHandler = (model: Model) => Promise<boolean>;

export type GetThinkingLevelHandler = () => ThinkingLevel | undefined;

export type SetThinkingLevelHandler = (level: ThinkingLevel, persist?: boolean) => void;

/** Shared state created by loader, used during registration and runtime. */
export interface ExtensionRuntimeState {
	flagValues: Map<string, boolean | string>;
	/** Provider registrations queued during extension loading, processed during session initialization */
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; sourceId: string }>;
}

/** Action implementations for ExtensionAPI methods. */
export interface ExtensionActions {
	sendMessage: SendMessageHandler;
	sendUserMessage: SendUserMessageHandler;
	appendEntry: AppendEntryHandler;
	setLabel: (targetId: string, label: string | undefined) => void;
	getActiveTools: GetActiveToolsHandler;
	getAllTools: GetAllToolsHandler;
	setActiveTools: SetActiveToolsHandler;
	getCommands: GetCommandsHandler;
	setModel: SetModelHandler;
	getThinkingLevel: GetThinkingLevelHandler;
	setThinkingLevel: SetThinkingLevelHandler;
	getSessionName: () => string | undefined;
	setSessionName: (name: string) => Promise<void>;
}

/** Actions for ExtensionContext (ctx.* in event handlers). */
export interface ExtensionContextActions {
	getModel: () => Model | undefined;
	isIdle: () => boolean;
	abort: () => void;
	hasPendingMessages: () => boolean;
	shutdown: () => void;
	getContextUsage: () => ContextUsage | undefined;
	compact: (instructionsOrOptions?: string | CompactOptions) => Promise<void>;
	getSystemPrompt: () => string;
}

/** Actions for ExtensionCommandContext (ctx.* in command handlers). */
export interface ExtensionCommandContextActions {
	getContextUsage: () => ContextUsage | undefined;
	waitForIdle: () => Promise<void>;
	newSession: (options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	branch: (entryId: string) => Promise<{ cancelled: boolean }>;
	navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
	compact: (instructionsOrOptions?: string | CompactOptions) => Promise<void>;
	switchSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
	reload: () => Promise<void>;
}

/** Full runtime = state + actions. */
export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {}

/** Loaded extension with all registered items. */
export interface Extension {
	path: string;
	resolvedPath: string;
	label?: string;
	handlers: Map<string, HandlerFn[]>;
	tools: Map<string, RegisteredTool<any, any>>;
	messageRenderers: Map<string, MessageRenderer>;
	commands: Map<string, RegisteredCommand>;
	flags: Map<string, ExtensionFlag>;
	shortcuts: Map<KeyId, ExtensionShortcut>;
}

/** Result of loading extensions. */
export interface LoadExtensionsResult {
	extensions: Extension[];
	errors: Array<{ path: string; error: string }>;
	runtime: ExtensionRuntime;
}

// ============================================================================
// Extension Error
// ============================================================================

export interface ExtensionError {
	extensionPath: string;
	event: string;
	error: string;
	stack?: string;
}
