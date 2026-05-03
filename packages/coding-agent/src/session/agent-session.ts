/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
	type Agent,
	AgentBusyError,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	Context,
	Effort,
	ImageContent,
	Message,
	MessageAttribution,
	Model,
	ProviderSessionState,
	ServiceTier,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
	ToolChoice,
	Usage,
	UsageReport,
} from "@oh-my-pi/pi-ai";
import {
	calculateRateLimitBackoffMs,
	getSupportedEfforts,
	isContextOverflow,
	isUnexpectedSocketCloseMessage,
	isUsageLimitError,
	modelsAreEqual,
	parseRateLimitReason,
	streamSimple,
} from "@oh-my-pi/pi-ai";
import { MacOSPowerAssertion } from "@oh-my-pi/pi-natives";
import { abortableSleep, getAgentDbPath, isEnoent, logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobManager } from "../async";
import type { Rule } from "../capability/rule";
import { MODEL_ROLE_IDS, type ModelRegistry } from "../config/model-registry";
import {
	extractExplicitThinkingSelector,
	formatModelSelectorValue,
	formatModelString,
	parseModelString,
	type ResolvedModelRoleValue,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { expandPromptTemplate, type PromptTemplate } from "../config/prompt-templates";
import type { Settings, SkillsSettings } from "../config/settings";
import { normalizeDiff, normalizeToLF, ParseError, previewPatch, stripBom } from "../edit";
import {
	disposeKernelSessionsByOwner,
	executePython as executePythonCommand,
	type PythonResult,
} from "../eval/py/executor";
import { type BashResult, executeBash as executeBashCommand } from "../exec/bash-executor";
import { exportSessionToHtml } from "../export/html";
import type { TtsrManager, TtsrMatchContext } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import { CustomToolAdapter } from "../extensibility/custom-tools/wrapper";
import type {
	ExtensionCommandContext,
	ExtensionRunner,
	ExtensionUIContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
} from "../extensibility/extensions";
import type { CompactOptions, ContextUsage } from "../extensibility/extensions/types";
import { ExtensionToolWrapper } from "../extensibility/extensions/wrapper";
import type { HookCommandContext } from "../extensibility/hooks/types";
import type { Skill, SkillWarning } from "../extensibility/skills";
import { expandSlashCommand, type FileSlashCommand } from "../extensibility/slash-commands";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import {
	buildDiscoverableMCPSearchIndex,
	collectDiscoverableMCPTools,
	type DiscoverableMCPSearchIndex,
	type DiscoverableMCPTool,
	isMCPToolName,
	selectDiscoverableMCPToolNamesByServer,
} from "../mcp/discoverable-tool-metadata";
import { resolveMemoryBackend } from "../memory-backend";
import { getCurrentThemeName, theme } from "../modes/theme/theme";
import type { PlanModeState } from "../plan-mode/state";
import autoContinuePrompt from "../prompts/system/auto-continue.md" with { type: "text" };
import autoHandoffThresholdFocusPrompt from "../prompts/system/auto-handoff-threshold-focus.md" with { type: "text" };
import eagerTodoPrompt from "../prompts/system/eager-todo.md" with { type: "text" };
import handoffDocumentPrompt from "../prompts/system/handoff-document.md" with { type: "text" };
import ircIncomingTemplate from "../prompts/system/irc-incoming.md" with { type: "text" };
import planModeActivePrompt from "../prompts/system/plan-mode-active.md" with { type: "text" };
import planModeReferencePrompt from "../prompts/system/plan-mode-reference.md" with { type: "text" };
import planModeToolDecisionReminderPrompt from "../prompts/system/plan-mode-tool-decision-reminder.md" with {
	type: "text",
};
import ttsrInterruptTemplate from "../prompts/system/ttsr-interrupt.md" with { type: "text" };
import { type AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { deobfuscateSessionContext, type SecretObfuscator } from "../secrets/obfuscator";
import { resolveThinkingLevelForModel, toReasoningEffort } from "../thinking";
import { assertEditableFile } from "../tools/auto-generated-guard";
import type { CheckpointState } from "../tools/checkpoint";
import { outputMeta } from "../tools/output-meta";
import { normalizeLocalScheme, resolveToCwd } from "../tools/path-utils";
import { isAutoQaEnabled } from "../tools/report-tool-issue";
import { getLatestTodoPhasesFromEntries, type TodoItem, type TodoPhase } from "../tools/todo-write";
import { ToolError } from "../tools/tool-errors";
import { clampTimeout } from "../tools/tool-timeouts";
import { parseCommandArgs } from "../utils/command-args";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { extractFileMentions, generateFileMentionMessages } from "../utils/file-mentions";
import { buildNamedToolChoice } from "../utils/tool-choice";
import {
	type CompactionResult,
	calculateContextTokens,
	calculatePromptTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction";
import { DEFAULT_PRUNE_CONFIG, pruneToolOutputs } from "./compaction/pruning";
import {
	type BashExecutionMessage,
	type CompactionSummaryMessage,
	type CustomMessage,
	convertToLlm,
	type FileMentionMessage,
	type PythonExecutionMessage,
} from "./messages";
import { formatSessionDumpText } from "./session-dump-format";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	NewSessionOptions,
	SessionContext,
	SessionManager,
} from "./session-manager";
import { getLatestCompactionEntry } from "./session-manager";
import { ToolChoiceQueue } from "./tool-choice-queue";

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| AgentEvent
	| { type: "auto_compaction_start"; reason: "threshold" | "overflow" | "idle"; action: "context-full" | "handoff" }
	| {
			type: "auto_compaction_end";
			action: "context-full" | "handoff";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			/** True when compaction was skipped for a benign reason (no model, no candidates, nothing to compact). */
			skipped?: boolean;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "retry_fallback_applied"; from: string; to: string; role: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| { type: "ttsr_triggered"; rules: Rule[] }
	| { type: "todo_reminder"; todos: TodoItem[]; attempt: number; maxAttempts: number }
	| { type: "todo_auto_clear" }
	| { type: "irc_message"; message: CustomMessage }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
export type AsyncJobSnapshotItem = Pick<AsyncJob, "id" | "type" | "status" | "label" | "startTime">;

export interface AsyncJobSnapshot {
	running: AsyncJobSnapshotItem[];
	recent: AsyncJobSnapshotItem[];
}

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	/** Async background jobs launched by tools */
	asyncJobManager?: AsyncJobManager;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	/** Initial session thinking selector. */
	thinkingLevel?: ThinkingLevel;
	/** Prompt templates for expansion */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands for expansion */
	slashCommands?: FileSlashCommand[];
	/** Extension runner (created in main.ts with wrapped tools) */
	extensionRunner?: ExtensionRunner;
	/** Loaded skills (already discovered by SDK) */
	skills?: Skill[];
	/** Skill loading warnings (already captured by SDK) */
	skillWarnings?: SkillWarning[];
	/** Custom commands (TypeScript slash commands) */
	customCommands?: LoadedCustomCommand[];
	skillsSettings?: SkillsSettings;
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Tool registry for LSP and settings */
	toolRegistry?: Map<string, AgentTool>;
	/** Current session pre-LLM message transform pipeline */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	/** Provider payload hook used by the active session request path */
	onPayload?: SimpleStreamOptions["onPayload"];
	/** Provider response hook used by the active session request path */
	onResponse?: SimpleStreamOptions["onResponse"];
	/** Current session message-to-LLM conversion pipeline */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** System prompt builder that can consider tool availability */
	rebuildSystemPrompt?: (toolNames: string[], tools: Map<string, AgentTool>) => Promise<string>;
	/**
	 * Optional accessor for live MCP server instructions. Read by the session's
	 * `rebuildSystemPrompt`-skip optimization to detect server-side instruction
	 * changes (e.g. an MCP server upgrade) that would otherwise pass the tool-set
	 * signature comparison and silently keep a stale prompt cached.
	 */
	getMcpServerInstructions?: () => Map<string, string> | undefined;
	/** Enable hidden-by-default MCP tool discovery for this session. */
	mcpDiscoveryEnabled?: boolean;
	/** MCP tool names to activate for the current session when discovery mode is enabled. */
	initialSelectedMCPToolNames?: string[];
	/** Whether constructor-provided MCP defaults should be persisted immediately. */
	persistInitialMCPToolSelection?: boolean;
	/** MCP server names whose tools should seed discovery-mode sessions whenever those servers are connected. */
	defaultSelectedMCPServerNames?: string[];
	/** MCP tool names that should seed brand-new sessions created from this AgentSession. */
	defaultSelectedMCPToolNames?: string[];
	/** TTSR manager for time-traveling stream rules */
	ttsrManager?: TtsrManager;
	/** Secret obfuscator for deobfuscating streaming edit content */
	obfuscator?: SecretObfuscator;
	/** Logical owner for retained Python kernels created by this session. */
	evalKernelOwnerId?: string;
	/** Agent identity (registry id like "0-Main" or "3-Alice") used for IRC routing. */
	agentId?: string;
	/** Shared agent registry (for forwarding IRC observations to the main session UI). */
	agentRegistry?: AgentRegistry;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). */
	streamingBehavior?: "steer" | "followUp";
	/** Optional tool choice override for the next LLM call. */
	toolChoice?: ToolChoice;
	/** Send as developer/system message instead of user. Providers that support it use the developer role; others fall back to user. */
	synthetic?: boolean;
	/** Explicit billing/initiator attribution for the prompt. Defaults to user prompts as `user` and synthetic prompts as `agent`. */
	attribution?: MessageAttribution;
	/** Skip pre-send compaction checks for this prompt (internal use for maintenance flows). */
	skipCompactionCheck?: boolean;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Result from cycleRoleModels() */
export interface RoleModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	role: string;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	premiumRequests: number;
	cost: number;
}

/** Result from handoff() */
export interface HandoffResult {
	document: string;
	savedPath?: string;
}

interface HandoffOptions {
	autoTriggered?: boolean;
	signal?: AbortSignal;
}

/** Internal marker for hook messages queued through the agent loop */
// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */

const AUTO_HANDOFF_THRESHOLD_FOCUS = prompt.render(autoHandoffThresholdFocusPrompt);

type RetryFallbackChains = Record<string, string[]>;

type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}

interface ActiveRetryFallbackState {
	role: string;
	originalSelector: string;
	originalThinkingLevel: ThinkingLevel | undefined;
	lastAppliedFallbackThinkingLevel: ThinkingLevel | undefined;
}

function parseRetryFallbackSelector(selector: string): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed);
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: parsed.thinkingLevel,
	};
}

function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	const selector = formatModelString(model);
	return thinkingLevel ? `${selector}:${thinkingLevel}` : selector;
}

function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}

/** Composite key for auto-clear timers, keyed by phase name + task content. */
function todoClearKey(phaseName: string, taskContent: string): string {
	return `${phaseName}\u0000${taskContent}`;
}

const noOpUIContext: ExtensionUIContext = {
	select: async (_title, _options, _dialogOptions) => undefined,
	confirm: async (_title, _message, _dialogOptions) => false,
	input: async (_title, _placeholder, _dialogOptions) => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: _theme => Promise.resolve({ success: false, error: "UI not available" }),
	setFooter: () => {},
	setHeader: () => {},
	setEditorComponent: () => {},
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;

	#powerAssertion: MacOSPowerAssertion | undefined;

	readonly configWarnings: string[] = [];

	#asyncJobManager: AsyncJobManager | undefined = undefined;
	#scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	#thinkingLevel: ThinkingLevel | undefined;
	#promptTemplates: PromptTemplate[];
	#slashCommands: FileSlashCommand[];

	// Event subscription state
	#unsubscribeAgent?: () => void;
	#eventListeners: AgentSessionEventListener[] = [];

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	#steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	#followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	#pendingNextTurnMessages: CustomMessage[] = [];
	#scheduledHiddenNextTurnGeneration: number | undefined = undefined;
	#planModeState: PlanModeState | undefined;
	#planReferenceSent = false;
	#planReferencePath = "local://PLAN.md";

	// Compaction state
	#compactionAbortController: AbortController | undefined = undefined;
	#autoCompactionAbortController: AbortController | undefined = undefined;

	// Branch summarization state
	#branchSummaryAbortController: AbortController | undefined = undefined;

	// Handoff state
	#handoffAbortController: AbortController | undefined = undefined;
	#skipPostTurnMaintenanceAssistantTimestamp: number | undefined = undefined;

	// Retry state
	#retryAbortController: AbortController | undefined = undefined;
	#retryAttempt = 0;
	#retryPromise: Promise<void> | undefined = undefined;
	#retryResolve: (() => void) | undefined = undefined;
	#activeRetryFallback: ActiveRetryFallbackState | undefined = undefined;
	// Todo completion reminder state
	#todoReminderCount = 0;
	#todoPhases: TodoPhase[] = [];
	#todoClearTimers = new Map<string, Timer>();
	#toolChoiceQueue = new ToolChoiceQueue();

	// Bash execution state
	#bashAbortControllers = new Set<AbortController>();
	#pendingBashMessages: BashExecutionMessage[] = [];

	// Python execution state
	#evalAbortControllers = new Set<AbortController>();
	#evalKernelOwnerId: string;
	#pendingPythonMessages: PythonExecutionMessage[] = [];
	#activeEvalExecutions = new Set<Promise<unknown>>();
	#evalExecutionDisposing = false;

	// Background-channel IRC exchanges queued while the recipient was streaming.
	// Drained into history (via emitExternalEvent) once the recipient becomes idle.
	#pendingBackgroundExchanges: CustomMessage[][] = [];
	#scheduledBackgroundExchangeFlush = false;
	// Agent identity + registry for IRC relay forwarding to the main session UI.
	#agentId: string | undefined;
	#agentRegistry: AgentRegistry | undefined;
	// Extension system
	#extensionRunner: ExtensionRunner | undefined = undefined;
	#turnIndex = 0;

	#skills: Skill[];
	#skillWarnings: SkillWarning[];

	// Custom commands (TypeScript slash commands)
	#customCommands: LoadedCustomCommand[] = [];
	/** MCP prompt commands (updated dynamically when prompts are loaded) */
	#mcpPromptCommands: LoadedCustomCommand[] = [];

	#skillsSettings: SkillsSettings | undefined;

	// Model registry for API key resolution
	#modelRegistry: ModelRegistry;

	// Tool registry and prompt builder for extensions
	#toolRegistry: Map<string, AgentTool>;
	#transformContext: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	#onPayload: SimpleStreamOptions["onPayload"] | undefined;
	#onResponse: SimpleStreamOptions["onResponse"] | undefined;
	#convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	#rebuildSystemPrompt: ((toolNames: string[], tools: Map<string, AgentTool>) => Promise<string>) | undefined;
	#getMcpServerInstructions: (() => Map<string, string> | undefined) | undefined;
	#baseSystemPrompt: string;
	/**
	 * Signature of the (toolNames, tool descriptions) tuple passed to the most
	 * recent successful `rebuildSystemPrompt` call. Used to skip redundant rebuilds
	 * when MCP servers reconnect without changing their tool definitions, which is
	 * the dominant cause of prompt-cache invalidation in long sessions.
	 */
	#lastAppliedToolSignature: string | undefined;
	#mcpDiscoveryEnabled = false;
	#discoverableMCPTools = new Map<string, DiscoverableMCPTool>();
	#discoverableMCPSearchIndex: DiscoverableMCPSearchIndex | null = null;
	#selectedMCPToolNames = new Set<string>();
	#rpcHostToolNames = new Set<string>();
	#defaultSelectedMCPServerNames = new Set<string>();
	#defaultSelectedMCPToolNames = new Set<string>();
	#sessionDefaultSelectedMCPToolNames = new Map<string, string[]>();

	// TTSR manager for time-traveling stream rules
	#ttsrManager: TtsrManager | undefined = undefined;
	#pendingTtsrInjections: Rule[] = [];
	#ttsrAbortPending = false;
	#ttsrRetryToken = 0;
	#ttsrResumePromise: Promise<void> | undefined = undefined;
	#ttsrResumeResolve: (() => void) | undefined = undefined;
	#postPromptTasks = new Set<Promise<void>>();
	#postPromptTasksPromise: Promise<void> | undefined = undefined;
	#postPromptTasksResolve: (() => void) | undefined = undefined;
	#postPromptTasksAbortController = new AbortController();

	#streamingEditAbortTriggered = false;
	#streamingEditCheckedLineCounts = new Map<string, number>();

	#streamingEditPrecheckedToolCallIds = new Set<string>();

	#streamingEditFileCache = new Map<string, string>();
	#promptInFlightCount = 0;
	#obfuscator: SecretObfuscator | undefined;
	#checkpointState: CheckpointState | undefined = undefined;
	#pendingRewindReport: string | undefined = undefined;
	#lastSuccessfulYieldToolCallId: string | undefined = undefined;
	#promptGeneration = 0;
	#providerSessionState = new Map<string, ProviderSessionState>();

	#startPowerAssertion(): void {
		if (process.platform !== "darwin") {
			return;
		}
		try {
			this.#powerAssertion = MacOSPowerAssertion.start({ reason: "Oh My Pi agent session" });
		} catch (error) {
			logger.warn("Failed to acquire macOS power assertion", { error: String(error) });
		}
	}

	#stopPowerAssertion(): void {
		const assertion = this.#powerAssertion;
		this.#powerAssertion = undefined;
		if (!assertion) {
			return;
		}
		try {
			assertion.stop();
		} catch (error) {
			logger.warn("Failed to release macOS power assertion", { error: String(error) });
		}
	}

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settings = config.settings;
		this.#startPowerAssertion();
		this.#asyncJobManager = config.asyncJobManager;
		this.#evalKernelOwnerId = config.evalKernelOwnerId ?? `agent-session:${Snowflake.next()}`;
		this.#scopedModels = config.scopedModels ?? [];
		this.#thinkingLevel = config.thinkingLevel;
		this.#promptTemplates = config.promptTemplates ?? [];
		this.#slashCommands = config.slashCommands ?? [];
		this.#extensionRunner = config.extensionRunner;
		this.#skills = config.skills ?? [];
		this.#skillWarnings = config.skillWarnings ?? [];
		this.#customCommands = config.customCommands ?? [];
		this.#skillsSettings = config.skillsSettings;
		this.#modelRegistry = config.modelRegistry;
		this.#validateRetryFallbackChains();
		this.#toolRegistry = config.toolRegistry ?? new Map();
		this.#transformContext = config.transformContext ?? (messages => messages);
		this.#onPayload = config.onPayload;
		this.#onResponse = config.onResponse;
		this.#convertToLlm = config.convertToLlm ?? convertToLlm;
		this.#rebuildSystemPrompt = config.rebuildSystemPrompt;
		this.#getMcpServerInstructions = config.getMcpServerInstructions;
		this.#baseSystemPrompt = this.agent.state.systemPrompt;
		this.#mcpDiscoveryEnabled = config.mcpDiscoveryEnabled ?? false;
		this.#setDiscoverableMCPTools(this.#collectDiscoverableMCPToolsFromRegistry());
		this.#selectedMCPToolNames = new Set(config.initialSelectedMCPToolNames ?? []);
		this.#defaultSelectedMCPServerNames = new Set(config.defaultSelectedMCPServerNames ?? []);
		this.#defaultSelectedMCPToolNames = new Set(config.defaultSelectedMCPToolNames ?? []);
		this.#pruneSelectedMCPToolNames();
		const persistedSelectedMCPToolNames = this.buildDisplaySessionContext().selectedMCPToolNames;
		const currentSelectedMCPToolNames = this.getSelectedMCPToolNames();
		const persistInitialMCPToolSelection =
			config.persistInitialMCPToolSelection ?? this.sessionManager.getBranch().length === 0;
		if (
			this.#mcpDiscoveryEnabled &&
			persistInitialMCPToolSelection &&
			!this.#selectedMCPToolNamesMatch(persistedSelectedMCPToolNames, currentSelectedMCPToolNames)
		) {
			this.sessionManager.appendMCPToolSelection(currentSelectedMCPToolNames);
		}
		this.#rememberSessionDefaultSelectedMCPToolNames(
			this.sessionManager.getSessionFile(),
			this.#getConfiguredDefaultSelectedMCPToolNames(),
		);
		this.#ttsrManager = config.ttsrManager;
		this.#obfuscator = config.obfuscator;
		this.#agentId = config.agentId;
		this.#agentRegistry = config.agentRegistry;
		this.agent.setAssistantMessageEventInterceptor((message, assistantMessageEvent) => {
			const event: AgentEvent = {
				type: "message_update",
				message,
				assistantMessageEvent,
			};
			this.#preCacheStreamingEditFile(event);
			this.#maybeAbortStreamingEdit(event);
		});
		this.agent.providerSessionState = this.#providerSessionState;
		this.#syncTodoPhasesFromBranch();

		// Always subscribe to agent events for internal handling
		// (session persistence, hooks, auto-compaction, retry logic)
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this.#modelRegistry;
	}

	/** Advance the tool-choice queue and return the next directive for the upcoming LLM call. */
	nextToolChoice(): ToolChoice | undefined {
		return this.#toolChoiceQueue.nextToolChoice();
	}

	/**
	 * Force the next model call to target a specific active tool, then terminate
	 * the agent loop. Pushes a two-step sequence [forced, "none"] so the model
	 * calls exactly the forced tool once and then cannot call another.
	 */
	setForcedToolChoice(toolName: string): void {
		if (!this.getActiveToolNames().includes(toolName)) {
			throw new Error(`Tool "${toolName}" is not currently active.`);
		}

		const forced = buildNamedToolChoice(toolName, this.model);
		if (!forced || typeof forced === "string") {
			throw new Error("Current model does not support forcing a specific tool.");
		}

		this.#toolChoiceQueue.pushSequence([forced, "none"], {
			label: "user-force",
			onRejected: () => "requeue",
		});
	}

	/** The tool-choice queue: forces forthcoming tool invocations and carries handlers. */
	get toolChoiceQueue(): ToolChoiceQueue {
		return this.#toolChoiceQueue;
	}

	/** Peek the in-flight directive's invocation handler for use by the resolve tool. */
	peekQueueInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekInFlightInvoker();
	}

	/** Provider-scoped mutable state store for transport/session caches. */
	get providerSessionState(): Map<string, ProviderSessionState> {
		return this.#providerSessionState;
	}

	/** TTSR manager for time-traveling stream rules */
	get ttsrManager(): TtsrManager | undefined {
		return this.#ttsrManager;
	}

	/** Whether a TTSR abort is pending (stream was aborted to inject rules) */
	get isTtsrAbortPending(): boolean {
		return this.#ttsrAbortPending;
	}

	getAsyncJobSnapshot(options?: { recentLimit?: number }): AsyncJobSnapshot | null {
		if (!this.#asyncJobManager) return null;
		const running = this.#asyncJobManager.getRunningJobs().map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		}));
		const recent = this.#asyncJobManager.getRecentJobs(options?.recentLimit ?? 5).map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		}));
		return { running, recent };
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	#emit(event: AgentSessionEvent): void {
		// Copy array before iteration to avoid mutation during iteration
		const listeners = [...this.#eventListeners];
		for (const l of listeners) {
			l(event);
		}
	}

	/**
	 * Emit a UI-only notice to the session. Surfaces in interactive mode as a
	 * `showWarning` / `showError` / `showStatus` line; non-interactive modes
	 * receive the event through the normal subscribe stream.
	 *
	 * Notices are NOT added to agent state and never reach the LLM — use this
	 * for out-of-band conditions the user should see but the model shouldn't
	 * react to (e.g. background queue flush failures).
	 */
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void {
		this.#emit({ type: "notice", level, message, source });
	}

	#queuedExtensionEvents: Promise<void> = Promise.resolve();

	#queueExtensionEvent(event: AgentSessionEvent): Promise<void> {
		const emit = async () => {
			await this.#emitExtensionEvent(event);
		};
		const queued = this.#queuedExtensionEvents.then(emit, emit);
		this.#queuedExtensionEvents = queued.catch(() => {});
		return queued;
	}

	async #emitSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "message_update") {
			this.#emit(event);
			void this.#queueExtensionEvent(event);
			return;
		}
		await this.#emitExtensionEvent(event);
		this.#emit(event);
	}

	// Track last assistant message for auto-compaction check
	#lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect */
	#handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			const messageText = this.#getUserMessageText(event.message);
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this.#steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this.#steeringMessages.splice(steeringIndex, 1);
				} else {
					// Check follow-up queue
					const followUpIndex = this.#followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this.#followUpMessages.splice(followUpIndex, 1);
					}
				}
			}
		}

		// Deobfuscate assistant message content for display emission — the LLM echoes back
		// obfuscated placeholders, but listeners (TUI, extensions, exporters) must see real
		// values. The original event.message stays obfuscated so the persistence path below
		// writes `#HASH#` tokens to the session file; convertToLlm re-obfuscates outbound
		// traffic on the next turn. Walks text, thinking, and toolCall arguments/intent.
		let displayEvent: AgentEvent = event;
		const obfuscator = this.#obfuscator;
		if (obfuscator && event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			const deobfuscatedContent = obfuscator.deobfuscateObject(message.content);
			if (deobfuscatedContent !== message.content) {
				displayEvent = { ...event, message: { ...message, content: deobfuscatedContent } };
			}
		}

		await this.#emitSessionEvent(displayEvent);

		if (event.type === "turn_start") {
			this.#resetStreamingEditState();
			// TTSR: Reset buffer on turn start
			this.#ttsrManager?.resetBuffer();
		}

		// TTSR: Increment message count on turn end (for repeat-after-gap tracking)
		if (event.type === "turn_end" && this.#ttsrManager) {
			this.#ttsrManager.incrementMessageCount();
		}
		// Finalize the tool-choice queue's in-flight yield after tools have executed.
		// This must happen at turn_end (not message_end) because onInvoked handlers
		// run during tool execution, which happens between message_end and turn_end.
		if (event.type === "turn_end" && this.#toolChoiceQueue.hasInFlight) {
			const msg = event.message as AssistantMessage;
			if (msg.stopReason === "aborted" || msg.stopReason === "error") {
				this.#toolChoiceQueue.reject(msg.stopReason === "error" ? "error" : "aborted");
			} else {
				this.#toolChoiceQueue.resolve();
			}
		}
		if (event.type === "tool_execution_end" && event.toolName === "yield" && !event.isError) {
			this.#lastSuccessfulYieldToolCallId = event.toolCallId;
		}
		if (event.type === "turn_end" && this.#pendingRewindReport) {
			const report = this.#pendingRewindReport;
			this.#pendingRewindReport = undefined;
			await this.#applyRewind(report);
		}

		// TTSR: Check for pattern matches on assistant text/thinking and tool argument deltas
		if (event.type === "message_update" && this.#ttsrManager?.hasRules()) {
			const assistantEvent = event.assistantMessageEvent;
			let matchContext: TtsrMatchContext | undefined;

			if (assistantEvent.type === "text_delta") {
				matchContext = { source: "text" };
			} else if (assistantEvent.type === "thinking_delta") {
				matchContext = { source: "thinking" };
			} else if (assistantEvent.type === "toolcall_delta") {
				matchContext = this.#getTtsrToolMatchContext(event.message, assistantEvent.contentIndex);
			}

			if (matchContext && "delta" in assistantEvent) {
				const matches = this.#ttsrManager.checkDelta(assistantEvent.delta, matchContext);
				if (matches.length > 0) {
					// Queue rules for injection; mark as injected only after successful enqueue.

					this.#addPendingTtsrInjections(matches);

					if (this.#shouldInterruptForTtsrMatch(matches, matchContext)) {
						// Abort the stream immediately — do not gate on extension callbacks
						this.#ttsrAbortPending = true;
						this.#ensureTtsrResumePromise();
						this.agent.abort();
						// Notify extensions (fire-and-forget, does not block abort)
						this.#emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {});
						// Schedule retry after a short delay
						const retryToken = ++this.#ttsrRetryToken;
						const generation = this.#promptGeneration;
						const targetMessageTimestamp =
							event.message.role === "assistant" ? event.message.timestamp : undefined;
						this.#schedulePostPromptTask(
							async () => {
								if (this.#ttsrRetryToken !== retryToken) {
									this.#resolveTtsrResume();
									return;
								}

								const targetAssistantIndex = this.#findTtsrAssistantIndex(targetMessageTimestamp);
								if (
									!this.#ttsrAbortPending ||
									this.#promptGeneration !== generation ||
									targetAssistantIndex === -1
								) {
									this.#ttsrAbortPending = false;
									this.#pendingTtsrInjections = [];
									this.#resolveTtsrResume();
									return;
								}
								this.#ttsrAbortPending = false;
								const ttsrSettings = this.#ttsrManager?.getSettings();
								if (ttsrSettings?.contextMode === "discard") {
									// Remove the partial/aborted assistant turn from agent state
									this.agent.replaceMessages(this.agent.state.messages.slice(0, targetAssistantIndex));
								}
								// Inject TTSR rules as system reminder before retry
								const injection = this.#getTtsrInjectionContent();
								if (injection) {
									const details = { rules: injection.rules.map(rule => rule.name) };
									this.agent.appendMessage({
										role: "custom",
										customType: "ttsr-injection",
										content: injection.content,
										display: false,
										details,
										attribution: "agent",
										timestamp: Date.now(),
									});
									this.sessionManager.appendCustomMessageEntry(
										"ttsr-injection",
										injection.content,
										false,
										details,
										"agent",
									);
									this.#markTtsrInjected(details.rules);
								}
								try {
									await this.agent.continue();
								} catch {
									this.#resolveTtsrResume();
								}
							},
							{ delayMs: 50 },
						);
						return;
					}
				}
			}
		}

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_start" ||
				event.assistantMessageEvent.type === "toolcall_delta" ||
				event.assistantMessageEvent.type === "toolcall_end")
		) {
			void this.#preCacheStreamingEditFile(event);
		}

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_end" || event.assistantMessageEvent.type === "toolcall_delta")
		) {
			this.#maybeAbortStreamingEdit(event);
		}

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a hook/custom message
			if (event.message.role === "hookMessage" || event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
					event.message.attribution ?? "agent",
				);
				if (event.message.role === "custom" && event.message.customType === "ttsr-injection") {
					this.#markTtsrInjected(this.#extractTtsrRuleNames(event.message.details));
				}
			} else if (
				event.message.role === "user" ||
				event.message.role === "developer" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult" ||
				event.message.role === "fileMention"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this.#lastAssistantMessage = event.message;
				const assistantMsg = event.message as AssistantMessage;
				// Resolve TTSR resume gate before checking for new deferred injections.
				// Gate on #ttsrAbortPending, not stopReason: a non-TTSR abort (e.g. streaming
				// edit) also produces stopReason === "aborted" but has no continuation coming.
				// Only skip when #ttsrAbortPending is true (TTSR continuation is imminent).
				if (!this.#ttsrAbortPending) {
					this.#resolveTtsrResume();
				}
				this.#queueDeferredTtsrInjectionIfNeeded(assistantMsg);
				if (this.#handoffAbortController) {
					this.#skipPostTurnMaintenanceAssistantTimestamp = assistantMsg.timestamp;
				}
				if (
					assistantMsg.stopReason !== "error" &&
					assistantMsg.stopReason !== "aborted" &&
					this.#retryAttempt > 0
				) {
					if (this.#activeRetryFallback && this.model) {
						await this.#emitSessionEvent({
							type: "retry_fallback_succeeded",
							model: formatRetryFallbackSelector(this.model, this.thinkingLevel),
							role: this.#activeRetryFallback.role,
						});
					}
					await this.#emitSessionEvent({
						type: "auto_retry_end",
						success: true,
						attempt: this.#retryAttempt,
					});
					this.#retryAttempt = 0;
				}
			}

			if (event.message.role === "toolResult") {
				const { toolName, details, isError, content } = event.message as {
					toolName?: string;
					details?: { path?: string; phases?: TodoPhase[]; report?: string; startedAt?: string };
					isError?: boolean;
					content?: Array<TextContent | ImageContent>;
				};
				// Invalidate streaming edit cache when edit tool completes to prevent stale data
				if (toolName === "edit" && details?.path) {
					this.#invalidateFileCacheForPath(details.path);
				}
				if (toolName === "todo_write" && !isError && Array.isArray(details?.phases)) {
					this.setTodoPhases(details.phases);
				}
				if (toolName === "todo_write" && isError) {
					const errorText = content?.find(part => part.type === "text")?.text;
					const reminderText = [
						"<system-reminder>",
						"todo_write failed, so todo progress is not visible to the user.",
						errorText ? `Failure: ${errorText}` : "Failure: todo_write returned an error.",
						"Fix the todo payload and call todo_write again before continuing.",
						"</system-reminder>",
					].join("\n");
					await this.sendCustomMessage(
						{
							customType: "todo-write-error-reminder",
							content: reminderText,
							display: false,
							details: { toolName, errorText },
						},
						{ deliverAs: "nextTurn" },
					);
				}
				if (toolName === "checkpoint" && !isError) {
					const checkpointEntryId = this.sessionManager.getEntries().at(-1)?.id ?? null;
					this.#checkpointState = {
						checkpointMessageCount: this.agent.state.messages.length,
						checkpointEntryId,
						startedAt: details?.startedAt ?? new Date().toISOString(),
					};
					this.#pendingRewindReport = undefined;
				}
				if (toolName === "rewind" && !isError && this.#checkpointState) {
					const detailReport = typeof details?.report === "string" ? details.report.trim() : "";
					const textReport = content?.find(part => part.type === "text")?.text?.trim() ?? "";
					const report = detailReport || textReport;
					if (report.length > 0) {
						this.#pendingRewindReport = report;
					}
				}
			}
		}

		// Check auto-retry and auto-compaction after agent completes
		if (event.type === "agent_end") {
			const fallbackAssistant = [...event.messages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
			const msg = this.#lastAssistantMessage ?? fallbackAssistant;
			this.#lastAssistantMessage = undefined;
			if (!msg) {
				this.#lastSuccessfulYieldToolCallId = undefined;
				return;
			}

			// Invalidate GitHub Copilot credentials on auth failure so stale tokens
			// aren't reused on the next request
			if (
				msg.stopReason === "error" &&
				msg.provider === "github-copilot" &&
				msg.errorMessage?.includes("GitHub Copilot authentication failed")
			) {
				await this.#modelRegistry.authStorage.remove("github-copilot");
			}

			if (this.#skipPostTurnMaintenanceAssistantTimestamp === msg.timestamp) {
				this.#skipPostTurnMaintenanceAssistantTimestamp = undefined;
				this.#lastSuccessfulYieldToolCallId = undefined;
				return;
			}

			if (this.#assistantEndedWithSuccessfulYield(msg)) {
				this.#lastSuccessfulYieldToolCallId = undefined;
				return;
			}
			this.#lastSuccessfulYieldToolCallId = undefined;

			// Check for retryable errors first (overloaded, rate limit, server errors)
			if (this.#isRetryableError(msg)) {
				const didRetry = await this.#handleRetryableError(msg);
				if (didRetry) return; // Retry was initiated, don't proceed to compaction
			}
			this.#resolveRetry();

			if (msg.stopReason === "aborted" && this.#checkpointState) {
				this.#checkpointState = undefined;
				this.#pendingRewindReport = undefined;
			}
			const compactionTask = this.#checkCompaction(msg);
			this.#trackPostPromptTask(compactionTask);
			await compactionTask;
			// Check for incomplete todos only after a final assistant stop, not intermediate tool-use turns.
			const hasToolCalls = msg.content.some(content => content.type === "toolCall");
			if (hasToolCalls) {
				return;
			}
			if (msg.stopReason !== "error" && msg.stopReason !== "aborted") {
				if (this.#enforceRewindBeforeYield()) {
					return;
				}
				await this.#checkTodoCompletion();
			}
		}
	};

	/** Resolve the pending retry promise */
	#resolveRetry(): void {
		if (this.#retryResolve) {
			this.#retryResolve();
			this.#retryResolve = undefined;
			this.#retryPromise = undefined;
		}
	}

	/** Create the TTSR resume gate promise if one doesn't already exist. */
	#ensureTtsrResumePromise(): void {
		if (this.#ttsrResumePromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#ttsrResumePromise = promise;
		this.#ttsrResumeResolve = resolve;
	}

	/** Resolve and clear the TTSR resume gate. */
	#resolveTtsrResume(): void {
		if (!this.#ttsrResumeResolve) return;
		this.#ttsrResumeResolve();
		this.#ttsrResumeResolve = undefined;
		this.#ttsrResumePromise = undefined;
	}

	#ensurePostPromptTasksPromise(): void {
		if (this.#postPromptTasksPromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#postPromptTasksPromise = promise;
		this.#postPromptTasksResolve = resolve;
	}

	#resolvePostPromptTasks(): void {
		if (!this.#postPromptTasksResolve) return;
		this.#postPromptTasksResolve();
		this.#postPromptTasksResolve = undefined;
		this.#postPromptTasksPromise = undefined;
	}

	#trackPostPromptTask(task: Promise<void>): void {
		this.#postPromptTasks.add(task);
		this.#ensurePostPromptTasksPromise();
		void task
			.catch(() => {})
			.finally(() => {
				this.#postPromptTasks.delete(task);
				if (this.#postPromptTasks.size === 0) {
					this.#resolvePostPromptTasks();
				}
			});
	}

	#schedulePostPromptTask(
		task: (signal: AbortSignal) => Promise<void>,
		options?: { delayMs?: number; generation?: number; onSkip?: () => void },
	): void {
		const delayMs = options?.delayMs ?? 0;
		const signal = this.#postPromptTasksAbortController.signal;
		const scheduled = (async () => {
			if (delayMs > 0) {
				try {
					await abortableSleep(delayMs, signal);
				} catch {
					return;
				}
			}
			if (signal.aborted) {
				options?.onSkip?.();
				return;
			}
			if (options?.generation !== undefined && this.#promptGeneration !== options.generation) {
				options.onSkip?.();
				return;
			}
			await task(signal);
		})();
		this.#trackPostPromptTask(scheduled);
	}

	#scheduleAgentContinue(options?: {
		delayMs?: number;
		generation?: number;
		shouldContinue?: () => boolean;
		onSkip?: () => void;
		onError?: () => void;
	}): void {
		this.#schedulePostPromptTask(
			async () => {
				if (options?.shouldContinue && !options.shouldContinue()) {
					options.onSkip?.();
					return;
				}
				try {
					await this.#maybeRestoreRetryFallbackPrimary();
					await this.agent.continue();
				} catch {
					options?.onError?.();
				}
			},
			{
				delayMs: options?.delayMs,
				generation: options?.generation,
				onSkip: options?.onSkip,
			},
		);
	}

	#scheduleAutoContinuePrompt(generation: number): void {
		const continuePrompt = async () => {
			await this.#promptWithMessage(
				{
					role: "developer",
					content: [{ type: "text", text: autoContinuePrompt }],
					attribution: "agent",
					timestamp: Date.now(),
				},
				autoContinuePrompt,
				{ skipPostPromptRecoveryWait: true },
			);
		};
		this.#schedulePostPromptTask(
			async signal => {
				await Promise.resolve();
				if (signal.aborted) return;
				await continuePrompt();
			},
			{ generation },
		);
	}

	async #cancelPostPromptTasks(): Promise<void> {
		this.#postPromptTasksAbortController.abort();
		this.#postPromptTasksAbortController = new AbortController();
		this.#resolveTtsrResume();

		const pendingTasks = Array.from(this.#postPromptTasks);
		if (pendingTasks.length === 0) {
			this.#resolvePostPromptTasks();
			return;
		}

		await Promise.allSettled(pendingTasks);
		if (this.#postPromptTasks.size === 0) {
			this.#resolvePostPromptTasks();
		}
	}
	/**
	 * Wait for retry, TTSR resume, and any background continuation to settle.
	 * Loops because a TTSR continuation can trigger a retry (or vice-versa),
	 * and fire-and-forget `agent.continue()` may still be streaming after
	 * the TTSR resume gate resolves.
	 */
	async #waitForPostPromptRecovery(): Promise<void> {
		while (true) {
			if (this.#retryPromise) {
				await this.#retryPromise;
				continue;
			}
			if (this.#ttsrResumePromise) {
				await this.#ttsrResumePromise;
				continue;
			}
			if (this.#postPromptTasksPromise) {
				await this.#postPromptTasksPromise;
				continue;
			}
			// Tracked post-prompt tasks cover deferred continuations scheduled from
			// event handlers. Keep the streaming fallback for direct agent activity
			// outside the scheduler.
			if (this.agent.state.isStreaming) {
				await this.agent.waitForIdle();
				continue;
			}
			break;
		}
	}

	/** Get TTSR injection payload and clear pending injections. */
	#getTtsrInjectionContent(): { content: string; rules: Rule[] } | undefined {
		if (this.#pendingTtsrInjections.length === 0) return undefined;
		const rules = this.#pendingTtsrInjections;
		const content = rules
			.map(r => prompt.render(ttsrInterruptTemplate, { name: r.name, path: r.path, content: r.content }))
			.join("\n\n");
		this.#pendingTtsrInjections = [];
		return { content, rules };
	}

	#addPendingTtsrInjections(rules: Rule[]): void {
		const seen = new Set(this.#pendingTtsrInjections.map(rule => rule.name));
		for (const rule of rules) {
			if (seen.has(rule.name)) continue;
			this.#pendingTtsrInjections.push(rule);
			seen.add(rule.name);
		}
	}

	#extractTtsrRuleNames(details: unknown): string[] {
		if (!details || typeof details !== "object" || Array.isArray(details)) {
			return [];
		}
		const rules = (details as { rules?: unknown }).rules;
		if (!Array.isArray(rules)) {
			return [];
		}
		return rules.filter((ruleName): ruleName is string => typeof ruleName === "string");
	}

	#markTtsrInjected(ruleNames: string[]): void {
		const uniqueRuleNames = Array.from(
			new Set(ruleNames.map(ruleName => ruleName.trim()).filter(ruleName => ruleName.length > 0)),
		);
		if (uniqueRuleNames.length === 0) {
			return;
		}
		this.#ttsrManager?.markInjectedByNames(uniqueRuleNames);
		this.sessionManager.appendTtsrInjection(uniqueRuleNames);
	}

	#findTtsrAssistantIndex(targetTimestamp: number | undefined): number {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") {
				continue;
			}
			if (targetTimestamp === undefined || message.timestamp === targetTimestamp) {
				return i;
			}
		}
		return -1;
	}

	#shouldInterruptForTtsrMatch(matches: Rule[], matchContext: TtsrMatchContext): boolean {
		const globalMode = this.#ttsrManager?.getSettings().interruptMode ?? "always";
		for (const rule of matches) {
			const mode = rule.interruptMode ?? globalMode;
			if (mode === "never") continue;
			if (mode === "prose-only" && (matchContext.source === "text" || matchContext.source === "thinking"))
				return true;
			if (mode === "tool-only" && matchContext.source === "tool") return true;
			if (mode === "always") return true;
		}
		return false;
	}

	#queueDeferredTtsrInjectionIfNeeded(assistantMsg: AssistantMessage): void {
		if (this.#ttsrAbortPending || this.#pendingTtsrInjections.length === 0) {
			return;
		}
		if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
			this.#pendingTtsrInjections = [];
			return;
		}

		const injection = this.#getTtsrInjectionContent();
		if (!injection) {
			return;
		}
		this.agent.followUp({
			role: "custom",
			customType: "ttsr-injection",
			content: injection.content,
			display: false,
			details: { rules: injection.rules.map(rule => rule.name) },
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#ensureTtsrResumePromise();
		// Mark as injected after this custom message is delivered and persisted (handled in message_end).
		// followUp() only enqueues; resume on the next tick once streaming settles.
		this.#scheduleAgentContinue({
			delayMs: 1,
			generation: this.#promptGeneration,
			onSkip: () => {
				this.#resolveTtsrResume();
			},
			shouldContinue: () => {
				if (this.agent.state.isStreaming || !this.agent.hasQueuedMessages()) {
					this.#resolveTtsrResume();
					return false;
				}
				return true;
			},
			onError: () => {
				this.#resolveTtsrResume();
			},
		});
	}

	/** Build TTSR match context for tool call argument deltas. */
	#getTtsrToolMatchContext(message: AgentMessage, contentIndex: number): TtsrMatchContext {
		const context: TtsrMatchContext = { source: "tool" };
		if (message.role !== "assistant") {
			return context;
		}

		const content = message.content;
		if (!Array.isArray(content) || contentIndex < 0 || contentIndex >= content.length) {
			return context;
		}

		const block = content[contentIndex];
		if (!block || typeof block !== "object" || block.type !== "toolCall") {
			return context;
		}

		const toolCall = block as ToolCall;
		context.toolName = toolCall.name;
		context.streamKey = toolCall.id ? `toolcall:${toolCall.id}` : `tool:${toolCall.name}:${contentIndex}`;
		context.filePaths = this.#extractTtsrFilePathsFromArgs(toolCall.arguments);
		return context;
	}

	/** Extract path-like arguments from tool call payload for TTSR glob matching. */
	#extractTtsrFilePathsFromArgs(args: unknown): string[] | undefined {
		if (!args || typeof args !== "object" || Array.isArray(args)) {
			return undefined;
		}

		const rawPaths: string[] = [];
		for (const [key, value] of Object.entries(args)) {
			const normalizedKey = key.toLowerCase();
			if (typeof value === "string" && (normalizedKey === "path" || normalizedKey.endsWith("path"))) {
				rawPaths.push(value);
				continue;
			}
			if (Array.isArray(value) && (normalizedKey === "paths" || normalizedKey.endsWith("paths"))) {
				for (const candidate of value) {
					if (typeof candidate === "string") {
						rawPaths.push(candidate);
					}
				}
			}
		}

		const normalizedPaths = rawPaths.flatMap(pathValue => this.#normalizeTtsrPathCandidates(pathValue));
		if (normalizedPaths.length === 0) {
			return undefined;
		}

		return Array.from(new Set(normalizedPaths));
	}

	/** Convert a path argument into stable relative/absolute candidates for glob checks. */
	#normalizeTtsrPathCandidates(rawPath: string): string[] {
		const trimmed = rawPath.trim();
		if (trimmed.length === 0) {
			return [];
		}

		const normalizedInput = trimmed.replaceAll("\\", "/");
		const candidates = new Set<string>([normalizedInput]);
		if (normalizedInput.startsWith("./")) {
			candidates.add(normalizedInput.slice(2));
		}

		const cwd = this.sessionManager.getCwd();
		const absolutePath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
		candidates.add(absolutePath.replaceAll("\\", "/"));

		const relativePath = path.relative(cwd, absolutePath).replaceAll("\\", "/");
		if (relativePath && relativePath !== "." && !relativePath.startsWith("../") && relativePath !== "..") {
			candidates.add(relativePath);
		}

		return Array.from(candidates);
	}
	/** Extract text content from a message */
	#getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		const textBlocks = content.filter(c => c.type === "text");
		const text = textBlocks.map(c => (c as TextContent).text).join("");
		if (text.length > 0) return text;
		const hasImages = content.some(c => c.type === "image");
		return hasImages ? "[Image]" : "";
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	#findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	#resetStreamingEditState(): void {
		this.#streamingEditAbortTriggered = false;
		this.#streamingEditCheckedLineCounts.clear();
		this.#streamingEditPrecheckedToolCallIds.clear();
		this.#streamingEditFileCache.clear();
	}

	#getStreamingEditToolCall(event: AgentEvent):
		| {
				toolCall: ToolCall;
				path: string;
				resolvedPath: string;
				diff?: string;
				op?: string;
				rename?: string;
		  }
		| undefined {
		if (event.type !== "message_update") return undefined;
		if (event.message.role !== "assistant") return undefined;

		const contentIndex = event.assistantMessageEvent.contentIndex ?? 0;
		const messageContent = event.message.content;
		if (!Array.isArray(messageContent) || contentIndex < 0 || contentIndex >= messageContent.length) {
			return undefined;
		}

		const toolCall = messageContent[contentIndex] as ToolCall;
		if (toolCall.name !== "edit") return undefined;

		const args = toolCall.arguments;
		if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
		if ("old_text" in args || "new_text" in args) return undefined;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) return undefined;

		// `local://` URLs (e.g. local://PLAN.md for plan-mode) resolve to a real
		// on-disk artifacts path; pre-caching works as long as we ask the
		// local-protocol handler. Other internal-scheme URLs (agent://, skill://,
		// rule://, mcp://, artifact://) have no stable filesystem representation;
		// skip pre-cache entirely for those — the edit tool itself will reject
		// them through its normal dispatch path.
		const resolvedPath = this.#resolveSessionFsPath(path);
		if (resolvedPath === undefined) return undefined;

		return {
			toolCall,
			path,
			resolvedPath,
			diff: typeof args.diff === "string" ? args.diff : undefined,
			op: typeof args.op === "string" ? args.op : undefined,
			rename: typeof args.rename === "string" ? args.rename : undefined,
		};
	}

	#lastStreamingEditToolCallId: string | undefined;
	#abortStreamingEditForAutoGeneratedPath(toolCall: ToolCall, path: string, resolvedPath: string): void {
		if (this.#lastStreamingEditToolCallId === toolCall.id) return;
		this.#lastStreamingEditToolCallId = toolCall.id;
		void assertEditableFile(resolvedPath, path).catch(err => {
			// peekFile and other I/O can reject with ENOENT, etc. Only ToolError means
			// auto-generated detection; other failures are left for the edit tool.
			if (!(err instanceof ToolError)) return;
			if (this.#lastStreamingEditToolCallId !== toolCall.id) return;

			if (!this.#streamingEditAbortTriggered) {
				this.#streamingEditAbortTriggered = true;
				logger.warn("Streaming edit aborted due to auto-generated file guard", {
					toolCallId: toolCall.id,
					path,
				});
				this.agent.abort();
			}
		});
	}

	#preCacheStreamingEditFile(event: AgentEvent): void {
		if (!this.settings.get("edit.streamingAbort")) return;
		if (this.#streamingEditAbortTriggered) return;
		if (event.type !== "message_update") return;

		const assistantEvent = event.assistantMessageEvent;
		if (
			assistantEvent.type !== "toolcall_start" &&
			assistantEvent.type !== "toolcall_delta" &&
			assistantEvent.type !== "toolcall_end"
		) {
			return;
		}

		const streamingEdit = this.#getStreamingEditToolCall(event);
		if (!streamingEdit) return;

		const shouldCheckAutoGenerated =
			!streamingEdit.toolCall.id || !this.#streamingEditPrecheckedToolCallIds.has(streamingEdit.toolCall.id);
		if (shouldCheckAutoGenerated) {
			if (streamingEdit.toolCall.id) {
				this.#streamingEditPrecheckedToolCallIds.add(streamingEdit.toolCall.id);
			}
			this.#abortStreamingEditForAutoGeneratedPath(
				streamingEdit.toolCall,
				streamingEdit.path,
				streamingEdit.resolvedPath,
			);
		}

		this.#ensureFileCache(streamingEdit.resolvedPath);
	}

	#ensureFileCache(resolvedPath: string): void {
		if (this.#streamingEditFileCache.has(resolvedPath)) return;

		try {
			const rawText = fs.readFileSync(resolvedPath, "utf-8");
			const { text } = stripBom(rawText);
			this.#streamingEditFileCache.set(resolvedPath, normalizeToLF(text));
		} catch {
			// Don't cache on read errors (including ENOENT) - let the edit tool handle them
		}
	}

	/** Invalidate cache for a file after an edit completes to prevent stale data */
	#invalidateFileCacheForPath(filePath: string): void {
		const resolvedPath = this.#resolveSessionFsPath(filePath);
		if (resolvedPath === undefined) return;
		this.#streamingEditFileCache.delete(resolvedPath);
	}

	/**
	 * Resolve a path supplied to a tool to a real filesystem path.
	 *
	 * - `local://` URLs route through the local-protocol handler so they map
	 *   onto the session's on-disk artifacts directory; pre-caching, ENOENT
	 *   handling, and post-edit invalidation all work normally.
	 * - Other internal-scheme URLs (agent://, skill://, rule://, mcp://,
	 *   artifact://) have no stable filesystem path; this returns `undefined`
	 *   so callers skip filesystem-only operations.
	 * - Cwd-relative and absolute paths resolve via `resolveToCwd`.
	 */
	#resolveSessionFsPath(filePath: string): string | undefined {
		const normalized = normalizeLocalScheme(filePath);
		if (normalized.startsWith("local:")) {
			return resolveLocalUrlToPath(normalized, this.#localProtocolOptions());
		}
		if (
			normalized.startsWith("agent://") ||
			normalized.startsWith("skill://") ||
			normalized.startsWith("rule://") ||
			normalized.startsWith("mcp://") ||
			normalized.startsWith("artifact://")
		) {
			return undefined;
		}
		return resolveToCwd(normalized, this.sessionManager.getCwd());
	}

	#localProtocolOptions(): LocalProtocolOptions {
		return {
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		};
	}

	#maybeAbortStreamingEdit(event: AgentEvent): void {
		if (!this.settings.get("edit.streamingAbort")) return;
		if (this.#streamingEditAbortTriggered) return;
		if (event.type !== "message_update") return;

		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent.type !== "toolcall_end" && assistantEvent.type !== "toolcall_delta") return;

		const streamingEdit = this.#getStreamingEditToolCall(event);
		if (!streamingEdit?.toolCall.id) return;

		const { toolCall, path, resolvedPath, diff, op, rename } = streamingEdit;
		if (!diff) return;
		if (op && op !== "update") return;

		if (!diff.includes("\n")) return;
		const lastNewlineIndex = diff.lastIndexOf("\n");
		if (lastNewlineIndex < 0) return;
		const diffForCheck = diff.endsWith("\n") ? diff : diff.slice(0, lastNewlineIndex + 1);
		if (diffForCheck.trim().length === 0) return;

		let normalizedDiff = normalizeDiff(diffForCheck.replace(/\r/g, ""));
		if (!normalizedDiff) return;
		// Deobfuscate the diff so removed lines match real file content
		if (this.#obfuscator) normalizedDiff = this.#obfuscator.deobfuscate(normalizedDiff);
		if (!normalizedDiff) return;
		const lines = normalizedDiff.split("\n");
		const hasChangeLine = lines.some(line => line.startsWith("+") || line.startsWith("-"));
		if (!hasChangeLine) return;

		const lineCount = lines.length;
		const lastChecked = this.#streamingEditCheckedLineCounts.get(toolCall.id);
		if (lastChecked !== undefined && lineCount <= lastChecked) return;
		this.#streamingEditCheckedLineCounts.set(toolCall.id, lineCount);

		const removedLines = lines
			.filter(line => line.startsWith("-") && !line.startsWith("--- "))
			.map(line => line.slice(1));
		if (removedLines.length > 0) {
			let cachedContent = this.#streamingEditFileCache.get(resolvedPath);
			if (cachedContent === undefined) {
				this.#ensureFileCache(resolvedPath);
				cachedContent = this.#streamingEditFileCache.get(resolvedPath);
			}
			if (cachedContent !== undefined) {
				const missing = removedLines.find(line => !cachedContent.includes(normalizeToLF(line)));
				if (missing) {
					this.#streamingEditAbortTriggered = true;
					logger.warn("Streaming edit aborted due to patch preview failure", {
						toolCallId: toolCall.id,
						path,
						error: `Failed to find expected lines in ${path}:\n${missing}`,
					});
					this.agent.abort();
				}
				return;
			}
			if (assistantEvent.type === "toolcall_delta") return;
			void this.#checkRemovedLinesAsync(toolCall.id, path, resolvedPath, removedLines);
			return;
		}

		if (assistantEvent.type === "toolcall_delta") return;
		void this.#checkPreviewPatchAsync(toolCall.id, path, rename, normalizedDiff);
	}

	async #checkRemovedLinesAsync(
		toolCallId: string,
		path: string,
		resolvedPath: string,
		removedLines: string[],
	): Promise<void> {
		if (this.#streamingEditAbortTriggered) return;
		try {
			const { text } = stripBom(await Bun.file(resolvedPath).text());
			const normalizedContent = normalizeToLF(text);
			const missing = removedLines.find(line => !normalizedContent.includes(normalizeToLF(line)));
			if (missing) {
				this.#streamingEditAbortTriggered = true;
				logger.warn("Streaming edit aborted due to patch preview failure", {
					toolCallId,
					path,
					error: `Failed to find expected lines in ${path}:\n${missing}`,
				});
				this.agent.abort();
			}
		} catch (err) {
			// Ignore ENOENT (file not found) - let the edit tool handle missing files
			// Also ignore other errors during async fallback
			if (!isEnoent(err)) {
				// Log unexpected errors but don't abort
			}
		}
	}

	async #checkPreviewPatchAsync(
		toolCallId: string,
		path: string,
		rename: string | undefined,
		normalizedDiff: string,
	): Promise<void> {
		if (this.#streamingEditAbortTriggered) return;
		try {
			await previewPatch(
				{ path, op: "update", rename, diff: normalizedDiff },
				{
					cwd: this.sessionManager.getCwd(),
					allowFuzzy: this.settings.get("edit.fuzzyMatch"),
					fuzzyThreshold: this.settings.get("edit.fuzzyThreshold"),
				},
			);
		} catch (error) {
			if (error instanceof ParseError) return;
			this.#streamingEditAbortTriggered = true;
			logger.warn("Streaming edit aborted due to patch preview failure", {
				toolCallId,
				path,
				error: error instanceof Error ? error.message : String(error),
			});
			this.agent.abort();
		}
	}

	/** Emit extension events based on session events */
	async #emitExtensionEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.#extensionRunner) return;
		if (event.type === "agent_start") {
			this.#turnIndex = 0;
			await this.#extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this.#extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const hookEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this.#turnIndex,
				timestamp: Date.now(),
			};
			await this.#extensionRunner.emit(hookEvent);
		} else if (event.type === "turn_end") {
			const hookEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this.#turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this.#extensionRunner.emit(hookEvent);
			this.#turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError ?? false,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "auto_compaction_start") {
			await this.#extensionRunner.emit({
				type: "auto_compaction_start",
				reason: event.reason,
				action: event.action,
			});
		} else if (event.type === "auto_compaction_end") {
			await this.#extensionRunner.emit({
				type: "auto_compaction_end",
				action: event.action,
				result: event.result,
				aborted: event.aborted,
				willRetry: event.willRetry,
				errorMessage: event.errorMessage,
				skipped: event.skipped,
			});
		} else if (event.type === "auto_retry_start") {
			await this.#extensionRunner.emit({
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			});
		} else if (event.type === "auto_retry_end") {
			await this.#extensionRunner.emit({
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
			});
		} else if (event.type === "ttsr_triggered") {
			await this.#extensionRunner.emit({ type: "ttsr_triggered", rules: event.rules });
		} else if (event.type === "todo_reminder") {
			await this.#extensionRunner.emit({
				type: "todo_reminder",
				todos: event.todos,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
			});
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this.#eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	#disconnectFromAgent(): void {
		if (this.#unsubscribeAgent) {
			this.#unsubscribeAgent();
			this.#unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	#reconnectToAgent(): void {
		if (this.#unsubscribeAgent) return; // Already connected
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
	}

	/**
	 * Remove all listeners, flush pending writes, and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	async dispose(): Promise<void> {
		this.#evalExecutionDisposing = true;
		try {
			if (this.#extensionRunner?.hasHandlers("session_shutdown")) {
				await this.#extensionRunner.emit({ type: "session_shutdown" });
			}
		} catch (error) {
			logger.warn("Failed to emit session_shutdown event", { error: String(error) });
		}
		await this.#cancelPostPromptTasks();
		this.#clearTodoClearTimers();
		const drained = await this.#asyncJobManager?.dispose({ timeoutMs: 3_000 });
		const deliveryState = this.#asyncJobManager?.getDeliveryState();
		if (drained === false && deliveryState) {
			logger.warn("Async job completion deliveries still pending during dispose", { ...deliveryState });
		}
		const pythonExecutionsSettled = await this.#prepareEvalExecutionsForDispose();
		if (!pythonExecutionsSettled) {
			logger.warn(
				"Detaching retained Python kernel ownership during dispose while Python execution is still active",
			);
		}
		await disposeKernelSessionsByOwner(this.#evalKernelOwnerId);
		this.#stopPowerAssertion();
		await this.sessionManager.close();
		this.#closeAllProviderSessions("dispose");
		this.#disconnectFromAgent();
		this.#eventListeners = [];
	}

	#closeAllProviderSessions(reason: string): void {
		for (const [providerKey, state] of this.#providerSessionState) {
			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state", {
					providerKey,
					reason,
					error: String(error),
				});
			}
		}

		this.#providerSessionState.clear();
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#thinkingLevel;
	}

	get serviceTier(): ServiceTier | undefined {
		return this.agent.serviceTier;
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming || this.#promptInFlightCount > 0;
	}

	/** Wait until streaming and deferred recovery work are fully settled. */
	async waitForIdle(): Promise<void> {
		await this.agent.waitForIdle();
		await this.#waitForPostPromptRecovery();
	}

	/** Most recent assistant message in agent state. */
	getLastAssistantMessage(): AssistantMessage | undefined {
		return this.#findLastAssistantMessage();
	}
	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this.#retryAttempt;
	}

	#collectDiscoverableMCPToolsFromRegistry(): Map<string, DiscoverableMCPTool> {
		return new Map(collectDiscoverableMCPTools(this.#toolRegistry.values()).map(tool => [tool.name, tool] as const));
	}

	#setDiscoverableMCPTools(discoverableMCPTools: Map<string, DiscoverableMCPTool>): void {
		this.#discoverableMCPTools = discoverableMCPTools;
		this.#discoverableMCPSearchIndex = null;
	}

	#filterSelectableMCPToolNames(toolNames: Iterable<string>): string[] {
		return Array.from(toolNames).filter(name => this.#discoverableMCPTools.has(name) && this.#toolRegistry.has(name));
	}

	#getConfiguredDefaultSelectedMCPToolNames(): string[] {
		return this.#filterSelectableMCPToolNames([
			...this.#defaultSelectedMCPToolNames,
			...selectDiscoverableMCPToolNamesByServer(
				this.#discoverableMCPTools.values(),
				this.#defaultSelectedMCPServerNames,
			),
		]);
	}

	#pruneSelectedMCPToolNames(): void {
		this.#selectedMCPToolNames = new Set(this.#filterSelectableMCPToolNames(this.#selectedMCPToolNames));
	}

	#selectedMCPToolNamesMatch(left: string[], right: string[]): boolean {
		return left.length === right.length && left.every((name, index) => name === right[index]);
	}

	#rememberSessionDefaultSelectedMCPToolNames(
		sessionFile: string | null | undefined,
		toolNames: Iterable<string>,
	): void {
		if (!sessionFile) return;
		this.#sessionDefaultSelectedMCPToolNames.set(
			path.resolve(sessionFile),
			this.#filterSelectableMCPToolNames(toolNames),
		);
	}

	#getSessionDefaultSelectedMCPToolNames(sessionFile: string | null | undefined): string[] {
		if (!sessionFile) return [];
		return this.#sessionDefaultSelectedMCPToolNames.get(path.resolve(sessionFile)) ?? [];
	}

	#persistSelectedMCPToolNamesIfChanged(previousSelectedMCPToolNames: string[]): void {
		if (!this.#mcpDiscoveryEnabled) return;
		const nextSelectedMCPToolNames = this.getSelectedMCPToolNames();
		if (this.#selectedMCPToolNamesMatch(previousSelectedMCPToolNames, nextSelectedMCPToolNames)) {
			return;
		}
		this.sessionManager.appendMCPToolSelection(nextSelectedMCPToolNames);
	}

	#getActiveNonMCPToolNames(): string[] {
		return this.getActiveToolNames().filter(name => !isMCPToolName(name) && this.#toolRegistry.has(name));
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map(t => t.name);
	}

	/** Whether the edit tool is registered in this session. */
	get hasEditTool(): boolean {
		return this.#toolRegistry.has("edit");
	}

	/**
	 * Get a tool by name from the registry.
	 */
	getToolByName(name: string): AgentTool | undefined {
		return this.#toolRegistry.get(name);
	}

	/**
	 * Get all configured tool names (built-in via --tools or default, plus custom tools).
	 */
	getAllToolNames(): string[] {
		return Array.from(this.#toolRegistry.keys());
	}

	#getEditModeSession() {
		return {
			settings: this.settings,
			getActiveModelString: () => (this.model ? formatModelString(this.model) : undefined),
		} as const;
	}

	#resolveActiveEditMode(): EditMode {
		return resolveEditMode(this.#getEditModeSession());
	}

	async #syncEditToolModeAfterModelChange(previousEditMode: EditMode): Promise<void> {
		const currentEditMode = this.#resolveActiveEditMode();
		if (previousEditMode !== currentEditMode && this.getActiveToolNames().includes("edit")) {
			await this.refreshBaseSystemPrompt();
		}
	}

	isMCPDiscoveryEnabled(): boolean {
		return this.#mcpDiscoveryEnabled;
	}

	getDiscoverableMCPTools(): DiscoverableMCPTool[] {
		return Array.from(this.#discoverableMCPTools.values());
	}

	getDiscoverableMCPSearchIndex(): DiscoverableMCPSearchIndex {
		if (!this.#discoverableMCPSearchIndex) {
			this.#discoverableMCPSearchIndex = buildDiscoverableMCPSearchIndex(this.#discoverableMCPTools.values());
		}
		return this.#discoverableMCPSearchIndex;
	}

	getSelectedMCPToolNames(): string[] {
		if (!this.#mcpDiscoveryEnabled) {
			return this.getActiveToolNames().filter(name => isMCPToolName(name) && this.#toolRegistry.has(name));
		}
		return this.#filterSelectableMCPToolNames(this.#selectedMCPToolNames);
	}

	async activateDiscoveredMCPTools(toolNames: string[]): Promise<string[]> {
		const nextSelectedMCPToolNames = new Set(this.#selectedMCPToolNames);
		const activated: string[] = [];
		for (const name of toolNames) {
			if (!isMCPToolName(name) || !this.#discoverableMCPTools.has(name) || !this.#toolRegistry.has(name)) {
				continue;
			}
			nextSelectedMCPToolNames.add(name);
			activated.push(name);
		}
		if (activated.length === 0) {
			return [];
		}
		const nextActive = [
			...this.#getActiveNonMCPToolNames(),
			...this.#filterSelectableMCPToolNames(nextSelectedMCPToolNames),
		];
		await this.setActiveToolsByName(nextActive);
		return [...new Set(activated)];
	}

	async #applyActiveToolsByName(
		toolNames: string[],
		options?: { persistMCPSelection?: boolean; previousSelectedMCPToolNames?: string[] },
	): Promise<void> {
		toolNames = [...new Set(toolNames.map(name => name.toLowerCase()))];
		const previousSelectedMCPToolNames = options?.previousSelectedMCPToolNames ?? this.getSelectedMCPToolNames();
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this.#toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		// Auto-QA tool must survive any runtime tool-set mutation.
		if (isAutoQaEnabled(this.settings) && !validToolNames.includes("report_tool_issue")) {
			const qaTool = this.#toolRegistry.get("report_tool_issue");
			if (qaTool) {
				tools.push(qaTool);
				validToolNames.push("report_tool_issue");
			}
		}
		if (this.#mcpDiscoveryEnabled) {
			this.#selectedMCPToolNames = new Set(
				validToolNames.filter(
					name => isMCPToolName(name) && this.#discoverableMCPTools.has(name) && this.#toolRegistry.has(name),
				),
			);
		}
		this.agent.setTools(tools);

		// Rebuild base system prompt with new tool set, but only when the tool set
		// actually changed. MCP servers can reconnect at arbitrary times and call
		// `refreshMCPTools` -> `#applyActiveToolsByName` even though the resulting
		// tool list is byte-identical. Skipping the rebuild keeps the system prompt
		// stable, which is required for Anthropic prompt caching to keep hitting.
		if (this.#rebuildSystemPrompt) {
			const signature = this.#computeAppliedToolSignature(validToolNames, tools);
			if (signature !== this.#lastAppliedToolSignature) {
				this.#baseSystemPrompt = await this.#rebuildSystemPrompt(validToolNames, this.#toolRegistry);
				this.agent.setSystemPrompt(this.#baseSystemPrompt);
				this.#lastAppliedToolSignature = signature;
			}
		}
		if (options?.persistMCPSelection !== false) {
			this.#persistSelectedMCPToolNamesIfChanged(previousSelectedMCPToolNames);
		}
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect before the next model call.
	 */
	async setActiveToolsByName(toolNames: string[]): Promise<void> {
		await this.#applyActiveToolsByName(toolNames);
	}

	async #restoreMCPSelectionsForSessionContext(
		sessionContext: SessionContext,
		options?: { fallbackSelectedMCPToolNames?: Iterable<string> },
	): Promise<void> {
		if (!this.#mcpDiscoveryEnabled) return;
		const nextActiveNonMCPToolNames = this.#getActiveNonMCPToolNames();
		const fallbackSelectedMCPToolNames =
			options?.fallbackSelectedMCPToolNames ?? this.#getConfiguredDefaultSelectedMCPToolNames();
		const restoredMCPToolNames = sessionContext.hasPersistedMCPToolSelection
			? this.#filterSelectableMCPToolNames(sessionContext.selectedMCPToolNames)
			: this.#filterSelectableMCPToolNames(fallbackSelectedMCPToolNames);
		this.#rememberSessionDefaultSelectedMCPToolNames(
			this.sessionFile,
			this.#getConfiguredDefaultSelectedMCPToolNames(),
		);
		await this.#applyActiveToolsByName([...nextActiveNonMCPToolNames, ...restoredMCPToolNames], {
			persistMCPSelection: false,
		});
	}
	/** Rebuild the base system prompt using the current active tool set. */
	async refreshBaseSystemPrompt(): Promise<void> {
		if (!this.#rebuildSystemPrompt) return;
		const activeToolNames = this.getActiveToolNames();
		this.#baseSystemPrompt = await this.#rebuildSystemPrompt(activeToolNames, this.#toolRegistry);
		this.agent.setSystemPrompt(this.#baseSystemPrompt);
		// Refresh the cached signature so a subsequent `#applyActiveToolsByName` with
		// the same tool set does not re-rebuild on top of the explicit refresh we
		// just performed (and conversely, a different set forces a fresh rebuild).
		const activeTools = activeToolNames
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool != null);
		this.#lastAppliedToolSignature = this.#computeAppliedToolSignature(activeToolNames, activeTools);
	}

	async #buildSystemPromptForAgentStart(promptText: string): Promise<string> {
		const backend = resolveMemoryBackend(this.settings);
		if (!backend.beforeAgentStartPrompt) return this.#baseSystemPrompt;

		try {
			const injected = await backend.beforeAgentStartPrompt(this, promptText);
			if (!injected) return this.#baseSystemPrompt;
			return `${this.#baseSystemPrompt}\n\n${injected}`;
		} catch (err) {
			logger.debug("Memory backend beforeAgentStartPrompt failed", {
				backend: backend.id,
				error: String(err),
			});
			return this.#baseSystemPrompt;
		}
	}

	/**
	 * Compose a stable signature for the inputs that `rebuildSystemPrompt` reads.
	 * Two calls producing identical signatures are guaranteed to produce identical
	 * system prompt bytes, so the rebuild can be skipped.
	 *
	 * The signature covers:
	 *   1. Active tool names in order (the prompt renders them in this order).
	 *   2. Active tool labels, descriptions, and wire-visible names — all are
	 *      rendered into the prompt body (see `system-prompt.md` `{{label}}: \`{{name}}\``
	 *      and `toolPromptNames` in `buildSystemPrompt`). The wire name comes from
	 *      `tool.customWireName` and overrides the internal name on the model wire
	 *      (e.g. `edit` exposes itself as `apply_patch` to GPT-5 in apply_patch mode);
	 *      a stale wire name would desync prompt guidance from actual tool routing.
	 *   3. When MCP discovery is on, every registry tool's name+label+description+
	 *      customWireName, since `rebuildSystemPrompt` summarizes discoverable MCP
	 *      tools that are not in the active set.
	 *   4. MCP server instructions text (per server), since `rebuildSystemPrompt`
	 *      embeds these in the appended prompt under "## MCP Server Instructions".
	 *      A server upgrade can change instructions while keeping tools identical.
	 *
	 * Settings-driven tool metadata is covered automatically: built-in tools that
	 * depend on settings expose `description`/`label` via getters (see `TaskTool`,
	 * `SearchToolBm25Tool`, `EditTool`), and the signature reads them live on every
	 * call - so a settings flip that mutates the rendered string differs the signature
	 * the next time `#applyActiveToolsByName` runs. Do not refactor `describeTool` to
	 * cache per-tool strings without preserving this property.
	 *
	 * Inputs NOT covered: tool input schemas; memory instructions read from disk;
	 * and SDK-init-time closure constants in `sdk.ts` (`repeatToolDescriptions`,
	 * `eagerTasks`, `intentField`, `mcpDiscoveryEnabled`, `secretsEnabled`). The
	 * closure-captured ones cannot change at runtime regardless of skip behavior.
	 * For everything else, callers must explicitly call `refreshBaseSystemPrompt()`
	 * after side-effecting changes; see e.g. the memory hooks and
	 * `#syncEditToolModeAfterModelChange`.
	 *
	 * The current calendar date IS covered (appended as a segment) because
	 * `buildSystemPrompt` injects it into the prompt body (`Today is '{{date}}'`).
	 * Without this, a session spanning midnight with only tool-stable MCP
	 * reconnects would keep yesterday's date indefinitely.
	 */
	#computeAppliedToolSignature(toolNames: string[], tools: AgentTool[]): string {
		// Order-preserving join: any reorder must produce a different signature so
		// the rebuild fires and the new tool list reaches the API.
		const nameSegment = toolNames.join("\u0001");
		const describeTool = (tool: AgentTool): string =>
			`${tool.name}=${tool.label ?? ""}|${tool.description ?? ""}|${tool.customWireName ?? ""}`;
		const descriptionSegment = tools.map(describeTool).join("\u0002");
		let registrySegment = "";
		if (this.#mcpDiscoveryEnabled) {
			// Registry iteration order is not load-bearing for the prompt content, so we
			// sort to keep the signature insensitive to incidental insertion order.
			const entries: string[] = [];
			for (const tool of this.#toolRegistry.values()) {
				entries.push(describeTool(tool));
			}
			entries.sort();
			registrySegment = entries.join("\u0004");
		}
		let instructionsSegment = "";
		const serverInstructions = this.#getMcpServerInstructions?.();
		if (serverInstructions && serverInstructions.size > 0) {
			// Sort by server name so transport flap order does not perturb the signature.
			const entries: string[] = [];
			for (const [server, instructions] of serverInstructions) {
				entries.push(`${server}=${instructions}`);
			}
			entries.sort();
			instructionsSegment = entries.join("\u0006");
		}
		const date = new Date().toISOString().slice(0, 10);
		return `${nameSegment}\u0003${descriptionSegment}\u0005${registrySegment}\u0007${instructionsSegment}|${date}`;
	}

	/**
	 * Replace MCP tools in the registry and recompute the visible MCP tool set immediately.
	 * This allows /mcp add/remove/reauth to take effect without restarting the session.
	 */
	async refreshMCPTools(mcpTools: CustomTool[]): Promise<void> {
		const previousSelectedMCPToolNames = this.getSelectedMCPToolNames();
		const existingNames = Array.from(this.#toolRegistry.keys());
		for (const name of existingNames) {
			if (isMCPToolName(name)) {
				this.#toolRegistry.delete(name);
			}
		}

		const getCustomToolContext = (): CustomToolContext => ({
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: this.model,
			isIdle: () => !this.isStreaming,
			hasQueuedMessages: () => this.queuedMessageCount > 0,
			abort: () => {
				this.agent.abort();
			},
		});

		for (const customTool of mcpTools) {
			const wrapped = CustomToolAdapter.wrap(customTool, getCustomToolContext) as AgentTool;
			const finalTool = (
				this.#extensionRunner ? new ExtensionToolWrapper(wrapped, this.#extensionRunner) : wrapped
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
		}

		this.#setDiscoverableMCPTools(this.#collectDiscoverableMCPToolsFromRegistry());
		this.#pruneSelectedMCPToolNames();
		if (!this.buildDisplaySessionContext().hasPersistedMCPToolSelection) {
			this.#selectedMCPToolNames = new Set([
				...this.#selectedMCPToolNames,
				...this.#getConfiguredDefaultSelectedMCPToolNames(),
			]);
		}
		this.#rememberSessionDefaultSelectedMCPToolNames(
			this.sessionFile,
			this.#getConfiguredDefaultSelectedMCPToolNames(),
		);

		const nextActive = [...this.#getActiveNonMCPToolNames(), ...this.getSelectedMCPToolNames()];
		await this.#applyActiveToolsByName(nextActive, { previousSelectedMCPToolNames });
	}

	/**
	 * Replace RPC host-owned tools and refresh the active tool set before the next model call.
	 */
	async refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
		const nextToolNames = rpcTools.map(tool => tool.name);
		const uniqueToolNames = new Set(nextToolNames);
		if (uniqueToolNames.size !== nextToolNames.length) {
			throw new Error("RPC host tool names must be unique");
		}

		for (const name of uniqueToolNames) {
			if (this.#toolRegistry.has(name) && !this.#rpcHostToolNames.has(name)) {
				throw new Error(`RPC host tool "${name}" conflicts with an existing tool`);
			}
		}

		const previousRpcHostToolNames = new Set(this.#rpcHostToolNames);
		const previousActiveToolNames = this.getActiveToolNames();
		for (const name of previousRpcHostToolNames) {
			this.#toolRegistry.delete(name);
		}
		this.#rpcHostToolNames.clear();

		for (const tool of rpcTools) {
			const finalTool = (
				this.#extensionRunner ? new ExtensionToolWrapper(tool, this.#extensionRunner) : tool
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
			this.#rpcHostToolNames.add(finalTool.name);
		}

		const activeNonRpcToolNames = previousActiveToolNames.filter(name => !previousRpcHostToolNames.has(name));
		const preservedRpcToolNames = previousActiveToolNames.filter(
			name => previousRpcHostToolNames.has(name) && this.#rpcHostToolNames.has(name),
		);
		const autoActivatedRpcToolNames = rpcTools
			.filter(tool => !tool.hidden && !previousRpcHostToolNames.has(tool.name))
			.map(tool => tool.name);
		await this.#applyActiveToolsByName(
			Array.from(new Set([...activeNonRpcToolNames, ...preservedRpcToolNames, ...autoActivatedRpcToolNames])),
		);
	}

	/** Whether auto-compaction is currently running */
	get isCompacting(): boolean {
		return this.#autoCompactionAbortController !== undefined || this.#compactionAbortController !== undefined;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	buildDisplaySessionContext(): SessionContext {
		return deobfuscateSessionContext(this.sessionManager.buildSessionContext(), this.#obfuscator);
	}

	/** Convert session messages using the same pre-LLM pipeline as the active session. */
	async convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]> {
		const transformedMessages = await this.#transformContext(messages, signal);
		return await this.#convertToLlm(transformedMessages);
	}

	/** Apply session-level stream hooks to a direct side request. */
	prepareSimpleStreamOptions(options: SimpleStreamOptions): SimpleStreamOptions {
		const sessionOnPayload = this.#onPayload;
		const sessionOnResponse = this.#onResponse;
		if (!sessionOnPayload && !sessionOnResponse) return options;

		const preparedOptions: SimpleStreamOptions = { ...options };

		if (sessionOnPayload) {
			if (!options.onPayload) {
				preparedOptions.onPayload = sessionOnPayload;
			} else {
				const requestOnPayload = options.onPayload;
				preparedOptions.onPayload = async (payload, model) => {
					const sessionPayload = await sessionOnPayload(payload, model);
					const sessionResolvedPayload = sessionPayload ?? payload;
					const requestPayload = await requestOnPayload(sessionResolvedPayload, model);
					return requestPayload ?? sessionResolvedPayload;
				};
			}
		}

		if (sessionOnResponse) {
			if (!options.onResponse) {
				preparedOptions.onResponse = sessionOnResponse;
			} else {
				const requestOnResponse = options.onResponse;
				preparedOptions.onResponse = async (response, model) => {
					await sessionOnResponse(response, model);
					await requestOnResponse(response, model);
				};
			}
		}

		return preparedOptions;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.getSteeringMode();
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.getFollowUpMode();
	}

	/** Current interrupt mode */
	get interruptMode(): "immediate" | "wait" {
		return this.agent.getInterruptMode();
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }> {
		return this.#scopedModels;
	}

	/** Prompt templates */
	getPlanModeState(): PlanModeState | undefined {
		return this.#planModeState;
	}

	setPlanModeState(state: PlanModeState | undefined): void {
		this.#planModeState = state;
		if (state?.enabled) {
			this.#planReferenceSent = false;
			this.#planReferencePath = state.planFilePath;
		}
	}

	markPlanReferenceSent(): void {
		this.#planReferenceSent = true;
	}

	setPlanReferencePath(path: string): void {
		this.#planReferencePath = path;
	}

	getCheckpointState(): CheckpointState | undefined {
		return this.#checkpointState;
	}

	setCheckpointState(state: CheckpointState | undefined): void {
		this.#checkpointState = state;
		if (!state) {
			this.#pendingRewindReport = undefined;
		}
	}

	/**
	 * Inject the plan mode context message into the conversation history.
	 */
	async sendPlanModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = await this.#buildPlanModeMessage();
		if (!message) return;
		await this.sendCustomMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
			},
			options ? { deliverAs: options.deliverAs } : undefined,
		);
	}

	resolveRoleModel(role: string): Model | undefined {
		return this.#resolveRoleModelFull(role, this.#modelRegistry.getAvailable(), this.model).model;
	}

	/**
	 * Resolve a role to its model AND thinking level.
	 * Unlike resolveRoleModel(), this preserves the thinking level suffix
	 * from role configuration (e.g., "anthropic/claude-sonnet-4-5:xhigh").
	 */
	resolveRoleModelWithThinking(role: string): ResolvedModelRoleValue {
		return this.#resolveRoleModelFull(role, this.#modelRegistry.getAvailable(), this.model);
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this.#promptTemplates;
	}

	/** Replace file-based slash commands used for prompt expansion. */
	setSlashCommands(slashCommands: FileSlashCommand[]): void {
		this.#slashCommands = [...slashCommands];
	}

	/** Custom commands (TypeScript slash commands and MCP prompts) */
	get customCommands(): ReadonlyArray<LoadedCustomCommand> {
		if (this.#mcpPromptCommands.length === 0) return this.#customCommands;
		return [...this.#customCommands, ...this.#mcpPromptCommands];
	}

	/** Update the MCP prompt commands list. Called when server prompts are (re)loaded. */
	setMCPPromptCommands(commands: LoadedCustomCommand[]): void {
		this.#mcpPromptCommands = commands;
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Build a plan mode message.
	 * Returns null if plan mode is not enabled.
	 * @returns The plan mode message, or null if plan mode is not enabled.
	 */
	async #buildPlanReferenceMessage(): Promise<CustomMessage | null> {
		if (this.#planModeState?.enabled) return null;
		if (this.#planReferenceSent) return null;

		const planFilePath = this.#planReferencePath;
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, this.#localProtocolOptions());
		let planContent: string;
		try {
			planContent = await Bun.file(resolvedPlanPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}

		const content = prompt.render(planModeReferencePrompt, {
			planFilePath,
			planContent,
		});

		this.#planReferenceSent = true;

		return {
			role: "custom",
			customType: "plan-mode-reference",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	async #buildPlanModeMessage(): Promise<CustomMessage | null> {
		const state = this.#planModeState;
		if (!state?.enabled) return null;
		const sessionPlanUrl = "local://PLAN.md";
		const resolvedPlanPath = state.planFilePath.startsWith("local:")
			? resolveLocalUrlToPath(normalizeLocalScheme(state.planFilePath), this.#localProtocolOptions())
			: resolveToCwd(state.planFilePath, this.sessionManager.getCwd());
		const resolvedSessionPlan = resolveLocalUrlToPath(sessionPlanUrl, this.#localProtocolOptions());
		const displayPlanPath =
			state.planFilePath.startsWith("local:") || resolvedPlanPath !== resolvedSessionPlan
				? state.planFilePath
				: sessionPlanUrl;

		const planExists = fs.existsSync(resolvedPlanPath);
		const content = prompt.render(planModeActivePrompt, {
			planFilePath: displayPlanPath,
			planExists,
			askToolName: "ask",
			writeToolName: "write",
			editToolName: "edit",
			exitToolName: "exit_plan_mode",
			reentry: state.reentry ?? false,
			iterative: state.workflow === "iterative",
		});

		return {
			role: "custom",
			customType: "plan-mode-context",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;

		// Handle extension commands first (execute immediately, even during streaming)
		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this.#tryExecuteExtensionCommand(text);
			if (handled) {
				return;
			}

			// Try custom commands (TypeScript slash commands)
			const customResult = await this.#tryExecuteCustomCommand(text);
			if (customResult !== null) {
				if (customResult === "") {
					return;
				}
				text = customResult;
			}

			// Try file-based slash commands (markdown files from commands/ directories)
			// Only if text still starts with "/" (wasn't transformed by custom command)
			if (text.startsWith("/")) {
				text = expandSlashCommand(text, this.#slashCommands);
			}
		}

		// Expand file-based prompt templates if requested
		const expandedText = expandPromptTemplates ? expandPromptTemplate(text, [...this.#promptTemplates]) : text;

		// If streaming, queue via steer() or followUp() based on option
		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			if (options.streamingBehavior === "followUp") {
				await this.#queueFollowUp(expandedText, options?.images);
			} else {
				await this.#queueSteer(expandedText, options?.images);
			}
			return;
		}

		// Skip eager todo prelude when the user has already queued a directive
		const hasPendingUserDirective = this.#toolChoiceQueue.inspect().includes("user-force");
		const eagerTodoPrelude =
			!options?.synthetic && !hasPendingUserDirective ? this.#createEagerTodoPrelude(expandedText) : undefined;

		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
		if (options?.images) {
			userContent.push(...options.images);
		}

		const promptAttribution = options?.attribution ?? (options?.synthetic ? "agent" : "user");
		const message = options?.synthetic
			? { role: "developer" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() }
			: { role: "user" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() };

		if (eagerTodoPrelude) {
			this.#toolChoiceQueue.pushOnce(eagerTodoPrelude.toolChoice, {
				label: "eager-todo",
			});
		}

		try {
			await this.#promptWithMessage(message, expandedText, {
				...options,
				prependMessages: eagerTodoPrelude ? [eagerTodoPrelude.message] : undefined,
			});
		} finally {
			// Clean up residual eager-todo directive if the prompt never consumed it
			// (e.g., compaction aborted, validation failed).
			this.#toolChoiceQueue.removeByLabel("eager-todo");
		}
		if (!options?.synthetic) {
			await this.#enforcePlanModeToolDecision();
		}
	}

	async promptCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: Pick<PromptOptions, "streamingBehavior" | "toolChoice">,
	): Promise<void> {
		const textContent =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((content): content is TextContent => content.type === "text")
						.map(content => content.text)
						.join("");

		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			await this.sendCustomMessage(message, { deliverAs: options.streamingBehavior });
			return;
		}

		const customMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};

		await this.#promptWithMessage(customMessage, textContent, options);
	}

	async #promptWithMessage(
		message: AgentMessage,
		expandedText: string,
		options?: Pick<PromptOptions, "toolChoice" | "images" | "skipCompactionCheck"> & {
			prependMessages?: AgentMessage[];
			skipPostPromptRecoveryWait?: boolean;
		},
	): Promise<void> {
		this.#promptInFlightCount++;
		const generation = this.#promptGeneration;
		try {
			// Flush any pending bash messages before the new prompt
			this.#flushPendingBashMessages();
			this.#flushPendingPythonMessages();
			this.#flushPendingBackgroundExchanges();

			// Reset todo reminder count on new user prompt
			this.#todoReminderCount = 0;

			await this.#maybeRestoreRetryFallbackPrimary();

			// Validate model
			if (!this.model) {
				throw new Error(
					"No model selected.\n\n" +
						`Use /login, set an API key environment variable, or create ${getAgentDbPath()}\n\n` +
						"Then use /model to select a model.",
				);
			}

			// Validate API key
			const apiKey = await this.#modelRegistry.getApiKey(this.model, this.sessionId);
			if (!apiKey) {
				throw new Error(
					`No API key found for ${this.model.provider}.\n\n` +
						`Use /login, set an API key environment variable, or create ${getAgentDbPath()}`,
				);
			}

			// Check if we need to compact before sending (catches aborted responses)
			const lastAssistant = this.#findLastAssistantMessage();
			if (lastAssistant && !options?.skipCompactionCheck) {
				await this.#checkCompaction(lastAssistant, false);
			}

			// Build messages array (session context, eager todo prelude, then active prompt message)
			const messages: AgentMessage[] = [];
			const planReferenceMessage = await this.#buildPlanReferenceMessage?.();
			if (planReferenceMessage) {
				messages.push(planReferenceMessage);
			}
			const planModeMessage = await this.#buildPlanModeMessage();
			if (planModeMessage) {
				messages.push(planModeMessage);
			}
			if (options?.prependMessages) {
				messages.push(...options.prependMessages);
			}

			messages.push(message);

			// Early bail-out: if a newer abort/prompt cycle started during setup,
			// return before mutating shared state (nextTurn messages, system prompt).
			if (this.#promptGeneration !== generation) {
				return;
			}

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this.#pendingNextTurnMessages) {
				messages.push(msg);
			}
			this.#pendingNextTurnMessages = [];

			// Auto-read @filepath mentions
			const fileMentions = extractFileMentions(expandedText);
			if (fileMentions.length > 0) {
				const fileMentionMessages = await generateFileMentionMessages(fileMentions, this.sessionManager.getCwd(), {
					autoResizeImages: this.settings.get("images.autoResize"),
					useHashLines: resolveFileDisplayMode(this).hashLines,
				});
				messages.push(...fileMentionMessages);
			}

			const beforeAgentStartSystemPrompt = await this.#buildSystemPromptForAgentStart(expandedText);

			// Emit before_agent_start extension event
			if (this.#extensionRunner) {
				const result = await this.#extensionRunner.emitBeforeAgentStart(
					expandedText,
					options?.images,
					beforeAgentStartSystemPrompt,
				);
				if (result?.messages) {
					const promptAttribution: "user" | "agent" | undefined =
						"attribution" in message ? message.attribution : undefined;
					for (const msg of result.messages) {
						messages.push({
							role: "custom",
							customType: msg.customType,
							content: msg.content,
							display: msg.display,
							details: msg.details,
							attribution: msg.attribution ?? promptAttribution ?? (message.role === "user" ? "user" : "agent"),
							timestamp: Date.now(),
						});
					}
				}

				if (result?.systemPrompt !== undefined) {
					this.agent.setSystemPrompt(result.systemPrompt);
				} else {
					this.agent.setSystemPrompt(beforeAgentStartSystemPrompt);
				}
			} else {
				this.agent.setSystemPrompt(beforeAgentStartSystemPrompt);
			}

			// Bail out if a newer abort/prompt cycle has started since we began setup
			if (this.#promptGeneration !== generation) {
				return;
			}

			const agentPromptOptions = options?.toolChoice ? { toolChoice: options.toolChoice } : undefined;
			await this.#promptAgentWithIdleRetry(messages, agentPromptOptions);
			if (!options?.skipPostPromptRecoveryWait) {
				await this.#waitForPostPromptRecovery();
			}
		} finally {
			this.#promptInFlightCount = Math.max(0, this.#promptInFlightCount - 1);
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	async #tryExecuteExtensionCommand(text: string): Promise<boolean> {
		if (!this.#extensionRunner) return false;

		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this.#extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this.#extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this.#extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	#createCommandContext(): ExtensionCommandContext {
		if (this.#extensionRunner) {
			return this.#extensionRunner.createCommandContext();
		}

		return {
			ui: noOpUIContext,
			hasUI: false,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: this.model ?? undefined,
			isIdle: () => !this.isStreaming,
			abort: () => {
				void this.abort();
			},
			hasPendingMessages: () => this.queuedMessageCount > 0,
			shutdown: () => {
				void this.dispose();
				process.exit(0);
			},
			hasQueuedMessages: () => this.queuedMessageCount > 0,
			getContextUsage: () => this.getContextUsage(),
			waitForIdle: () => this.waitForIdle(),
			newSession: async options => {
				const success = await this.newSession({ parentSession: options?.parentSession });
				if (!success) {
					return { cancelled: true };
				}
				if (options?.setup) {
					await options.setup(this.sessionManager);
				}
				return { cancelled: false };
			},
			branch: async entryId => {
				const result = await this.branch(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.navigateTree(targetId, { summarize: options?.summarize });
				return { cancelled: result.cancelled };
			},
			compact: async instructionsOrOptions => {
				const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
				const options =
					instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
				await this.compact(instructions, options);
			},
			switchSession: async sessionPath => {
				const success = await this.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await this.reload();
			},
			getSystemPrompt: () => this.systemPrompt,
		};
	}

	/**
	 * Try to execute a custom command. Returns the prompt string if found, null otherwise.
	 * If the command returns void, returns empty string to indicate it was handled.
	 */
	async #tryExecuteCustomCommand(text: string): Promise<string | null> {
		if (this.#customCommands.length === 0 && this.#mcpPromptCommands.length === 0) return null;

		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		// Find matching command
		const loaded =
			this.#customCommands.find(c => c.command.name === commandName) ??
			this.#mcpPromptCommands.find(c => c.command.name === commandName);
		if (!loaded) return null;

		// Get command context from extension runner (includes session control methods)
		const baseCtx = this.#createCommandContext();
		const ctx = {
			...baseCtx,
			hasQueuedMessages: baseCtx.hasPendingMessages,
		} as unknown as HookCommandContext;

		try {
			const args = parseCommandArgs(argsString);
			const result = await loaded.command.execute(args, ctx);
			// If result is a string, it's a prompt to send to LLM
			// If void/undefined, command handled everything
			return result ?? "";
		} catch (err) {
			// Emit error via extension runner
			if (this.#extensionRunner) {
				this.#extensionRunner.emitError({
					extensionPath: `custom-command:${commandName}`,
					event: "command",
					error: err instanceof Error ? err.message : String(err),
				});
			} else {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("Custom command failed", { commandName, error: message });
			}
			return ""; // Command was handled (with error)
		}
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText = expandPromptTemplate(text, [...this.#promptTemplates]);
		await this.#queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to process after the agent would otherwise stop.
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText = expandPromptTemplate(text, [...this.#promptTemplates]);
		await this.#queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	async #queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		const displayText = text || (images && images.length > 0 ? "[Image]" : "");
		this.#steeringMessages.push(displayText);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			attribution: "user",
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	async #queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		const displayText = text || (images && images.length > 0 ? "[Image]" : "");
		this.#followUpMessages.push(displayText);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			attribution: "user",
			timestamp: Date.now(),
		});
		// When fully idle AND the session is in a resumable assistant-ended state,
		// schedule an immediate continue so the queued follow-up is delivered
		// without waiting for the next user turn. We gate on isStreaming (model
		// actively producing), isRetrying (auto-retry backoff is sleeping between
		// attempts, #retryPromise set), and the last message being assistant —
		// agent.continue() only dequeues follow-ups from an assistant-ended state;
		// resuming from user/toolResult state runs an extra model call on the
		// stale prompt before draining the queue.
		if (this.#canAutoContinueForFollowUp()) {
			this.#scheduleAgentContinue({
				shouldContinue: () => this.#canAutoContinueForFollowUp() && this.agent.hasQueuedMessages(),
			});
		}
	}

	/**
	 * Gate for idle-path follow-up auto-continue. See `#queueFollowUp` for rationale.
	 */
	#canAutoContinueForFollowUp(): boolean {
		if (this.isStreaming) return false;
		if (this.isRetrying) return false;
		const messages = this.agent.state.messages;
		const last = messages[messages.length - 1];
		return last?.role === "assistant";
	}

	queueDeferredMessage(message: CustomMessage): void {
		this.#queueHiddenNextTurnMessage(message, true);
	}

	#queueHiddenNextTurnMessage(message: CustomMessage, triggerTurn: boolean): void {
		this.#pendingNextTurnMessages.push(message);
		if (!triggerTurn) return;
		const generation = this.#promptGeneration;
		if (this.#scheduledHiddenNextTurnGeneration === generation) {
			return;
		}
		this.#scheduledHiddenNextTurnGeneration = generation;
		this.#schedulePostPromptTask(
			async () => {
				if (this.#scheduledHiddenNextTurnGeneration === generation) {
					this.#scheduledHiddenNextTurnGeneration = undefined;
				}
				if (this.#pendingNextTurnMessages.length === 0) {
					return;
				}
				try {
					await this.#promptQueuedHiddenNextTurnMessages();
				} catch {
					// Leave the hidden next-turn messages queued for the next explicit prompt.
				}
			},
			{
				generation,
				onSkip: () => {
					if (this.#scheduledHiddenNextTurnGeneration === generation) {
						this.#scheduledHiddenNextTurnGeneration = undefined;
					}
				},
			},
		);
	}

	async #promptQueuedHiddenNextTurnMessages(): Promise<void> {
		if (this.#pendingNextTurnMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.#pendingNextTurnMessages];
		this.#pendingNextTurnMessages = [];
		const message = queuedMessages[queuedMessages.length - 1];
		if (!message) {
			return;
		}

		const prependMessages = queuedMessages.slice(0, -1);
		const textContent = this.#getCustomMessageTextContent(message);
		try {
			await this.#promptWithMessage(message, textContent, {
				prependMessages,
				skipPostPromptRecoveryWait: true,
			});
		} catch (error) {
			this.#pendingNextTurnMessages = [...queuedMessages, ...this.#pendingNextTurnMessages];
			throw error;
		}
	}

	#getCustomMessageTextContent(message: Pick<CustomMessage, "content">): string {
		if (typeof message.content === "string") {
			return message.content;
		}
		return message.content
			.filter((content): content is TextContent => content.type === "text")
			.map(content => content.text)
			.join("");
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	#throwIfExtensionCommand(text: string): void {
		if (!this.#extensionRunner) return;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this.#extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queue as steer/follow-up or store for next turn
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};
		if (this.isStreaming) {
			if (options?.deliverAs === "nextTurn") {
				this.#queueHiddenNextTurnMessage(appMessage, options?.triggerTurn ?? false);
				return;
			}

			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
			return;
		}

		if (options?.deliverAs === "nextTurn") {
			if (options?.triggerTurn) {
				await this.agent.prompt(appMessage);
				return;
			}
			this.agent.appendMessage(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
				message.attribution ?? "agent",
			);
			return;
		}

		if (options?.triggerTurn) {
			await this.agent.prompt(appMessage);
			return;
		}

		this.agent.appendMessage(appMessage);
		this.sessionManager.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
			message.attribution ?? "agent",
		);
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
		});
	}

	/**
	 * Clear queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this.#steeringMessages];
		const followUp = [...this.#followUpMessages];
		this.#steeringMessages = [];
		this.#followUpMessages = [];
		this.agent.clearAllQueues();
		return { steering, followUp };
	}

	/** Number of pending messages (includes steering, follow-up, and next-turn messages) */
	get queuedMessageCount(): number {
		return this.#steeringMessages.length + this.#followUpMessages.length + this.#pendingNextTurnMessages.length;
	}

	/** Get pending messages (read-only) */
	getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] } {
		return { steering: this.#steeringMessages, followUp: this.#followUpMessages };
	}

	/**
	 * Pop the last queued message (steering first, then follow-up).
	 * Used by dequeue keybinding to restore messages to editor one at a time.
	 */
	popLastQueuedMessage(): string | undefined {
		// Pop from steering first (LIFO)
		if (this.#steeringMessages.length > 0) {
			const message = this.#steeringMessages.pop();
			this.agent.popLastSteer();
			return message;
		}
		// Then from follow-up
		if (this.#followUpMessages.length > 0) {
			const message = this.#followUpMessages.pop();
			this.agent.popLastFollowUp();
			return message;
		}
		return undefined;
	}

	get skillsSettings(): SkillsSettings | undefined {
		return this.#skillsSettings;
	}

	/** Skills loaded by SDK (empty if --no-skills or skills: [] was passed) */
	get skills(): readonly Skill[] {
		return this.#skills;
	}

	/** Skill loading warnings captured by SDK */
	get skillWarnings(): readonly SkillWarning[] {
		return this.#skillWarnings;
	}

	getTodoPhases(): TodoPhase[] {
		return this.#cloneTodoPhases(this.#todoPhases);
	}

	setTodoPhases(phases: TodoPhase[]): void {
		this.#todoPhases = this.#cloneTodoPhases(phases);
		this.#scheduleTodoAutoClear(phases);
	}

	#syncTodoPhasesFromBranch(): void {
		const phases = getLatestTodoPhasesFromEntries(this.sessionManager.getBranch());
		// Strip completed/abandoned tasks — they were done in a previous run,
		// so the auto-clear grace period has already elapsed.
		for (const phase of phases) {
			phase.tasks = phase.tasks.filter(t => t.status !== "completed" && t.status !== "abandoned");
		}
		this.setTodoPhases(phases.filter(p => p.tasks.length > 0));
	}

	#cloneTodoPhases(phases: TodoPhase[]): TodoPhase[] {
		return phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task => {
				const out: TodoItem = { content: task.content, status: task.status };
				if (task.notes && task.notes.length > 0) out.notes = [...task.notes];
				return out;
			}),
		}));
	}

	/** Schedule auto-removal of completed/abandoned tasks after a delay. */
	#scheduleTodoAutoClear(phases: TodoPhase[]): void {
		const delaySec = this.settings.get("tasks.todoClearDelay") ?? 60;
		if (delaySec < 0) return; // "Never" — no auto-clear
		const delayMs = delaySec * 1000;
		const doneKeys = new Set<string>();
		for (const phase of phases) {
			for (const task of phase.tasks) {
				if (task.status === "completed" || task.status === "abandoned") {
					doneKeys.add(todoClearKey(phase.name, task.content));
				}
			}
		}

		// Cancel timers for tasks that are no longer done (e.g. status was reverted)
		for (const [key, timer] of this.#todoClearTimers) {
			if (!doneKeys.has(key)) {
				clearTimeout(timer);
				this.#todoClearTimers.delete(key);
			}
		}

		// Schedule new timers for newly-done tasks
		for (const key of doneKeys) {
			if (this.#todoClearTimers.has(key)) continue;
			if (delayMs === 0) {
				// Instant — run synchronously on next microtask to batch removals
				const timer = setTimeout(() => this.#runTodoAutoClear(key), 0);
				this.#todoClearTimers.set(key, timer);
			} else {
				const timer = setTimeout(() => this.#runTodoAutoClear(key), delayMs);
				this.#todoClearTimers.set(key, timer);
			}
		}
	}

	/** Remove a single completed task and notify the UI. */
	#runTodoAutoClear(key: string): void {
		this.#todoClearTimers.delete(key);
		let removed = false;
		for (const phase of this.#todoPhases) {
			const idx = phase.tasks.findIndex(t => todoClearKey(phase.name, t.content) === key);
			if (idx !== -1 && (phase.tasks[idx].status === "completed" || phase.tasks[idx].status === "abandoned")) {
				phase.tasks.splice(idx, 1);
				removed = true;
				break;
			}
		}
		if (!removed) return;

		// Remove empty phases
		this.#todoPhases = this.#todoPhases.filter(p => p.tasks.length > 0);
		this.#emit({ type: "todo_auto_clear" });
	}

	#clearTodoClearTimers(): void {
		for (const timer of this.#todoClearTimers.values()) {
			clearTimeout(timer);
		}
		this.#todoClearTimers.clear();
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.#promptGeneration++;
		this.#scheduledHiddenNextTurnGeneration = undefined;
		this.abortCompaction();
		this.abortHandoff();
		this.abortBash();
		this.abortEval();
		const postPromptDrain = this.#cancelPostPromptTasks();
		this.agent.abort();
		await postPromptDrain;
		await this.agent.waitForIdle();
		// Clear prompt-in-flight state: waitForIdle resolves when the agent loop's finally
		// block runs, but nested prompt setup/finalizers may still be unwinding. Without this,
		// a subsequent prompt() can incorrectly observe the session as busy after an abort.
		this.#promptInFlightCount = 0;
		// Safety net: if the agent loop aborted without producing an assistant
		// message (e.g. failed before the first stream), the in-flight yield was
		// never resolved or rejected by the normal message_end path. Reject it now
		// so any requeue callback still fires and the queue stays consistent.
		if (this.#toolChoiceQueue.hasInFlight) {
			this.#toolChoiceQueue.reject("aborted");
		}
	}

	/**
	 * Start a new session, optionally with initial messages and parent tracking.
	 * Clears all messages and starts a new session.
	 * Listeners are preserved and will continue receiving events.
	 * @param options - Optional initial messages and parent session path
	 * @returns true if completed, false if cancelled by hook
	 */
	async newSession(options?: NewSessionOptions): Promise<boolean> {
		const previousSessionFile = this.sessionFile;
		const nextDiscoverySessionToolNames = this.#mcpDiscoveryEnabled
			? [
					...this.#getActiveNonMCPToolNames(),
					...this.#filterSelectableMCPToolNames(this.#defaultSelectedMCPToolNames),
				]
			: undefined;

		// Emit session_before_switch event with reason "new" (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "new",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		this.#disconnectFromAgent();
		await this.abort();
		this.#asyncJobManager?.cancelAll();
		this.#closeAllProviderSessions("new session");
		this.agent.reset();
		if (options?.drop && previousSessionFile) {
			try {
				await this.sessionManager.dropSession(previousSessionFile);
			} catch (err) {
				logger.error("Failed to delete session during /drop", { err });
			}
		} else {
			await this.sessionManager.flush();
		}
		await this.sessionManager.newSession(options);
		this.setTodoPhases([]);
		this.agent.sessionId = this.sessionManager.getSessionId();
		this.#steeringMessages = [];
		this.#followUpMessages = [];
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		this.sessionManager.appendThinkingLevelChange(this.thinkingLevel);
		this.sessionManager.appendServiceTierChange(this.serviceTier ?? null);
		if (nextDiscoverySessionToolNames) {
			await this.#applyActiveToolsByName(nextDiscoverySessionToolNames, { persistMCPSelection: false });
			if (this.getSelectedMCPToolNames().length > 0) {
				this.sessionManager.appendMCPToolSelection(this.getSelectedMCPToolNames());
			}
		}
		this.#rememberSessionDefaultSelectedMCPToolNames(
			this.sessionFile,
			this.#getConfiguredDefaultSelectedMCPToolNames(),
		);

		this.#todoReminderCount = 0;
		this.#planReferenceSent = false;
		this.#planReferencePath = "local://PLAN.md";
		this.#reconnectToAgent();

		// Emit session_switch event with reason "new" to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "new",
				previousSessionFile,
			});
		}

		return true;
	}

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string, source: "auto" | "user" = "auto"): Promise<boolean> {
		return this.sessionManager.setSessionName(name, source);
	}

	/**
	 * Fork the current session, creating a new session file with the exact same state.
	 * Copies all entries and artifacts to the new session.
	 * Unlike newSession(), this preserves all messages in the agent state.
	 * @returns true if completed, false if cancelled by hook or not persisting
	 */
	async fork(): Promise<boolean> {
		const previousSessionFile = this.sessionFile;

		// Emit session_before_switch event with reason "fork" (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "fork",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		// Flush current session to ensure all entries are written
		await this.sessionManager.flush();

		// Fork the session (creates new session file with same entries)
		const forkResult = await this.sessionManager.fork();
		if (!forkResult) {
			return false;
		}

		// Copy artifacts directory if it exists
		const oldArtifactDir = forkResult.oldSessionFile.slice(0, -6);
		const newArtifactDir = forkResult.newSessionFile.slice(0, -6);

		try {
			const oldDirStat = await fs.promises.stat(oldArtifactDir);
			if (oldDirStat.isDirectory()) {
				await fs.promises.cp(oldArtifactDir, newArtifactDir, { recursive: true });
			}
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to copy artifacts during fork", {
					oldArtifactDir,
					newArtifactDir,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Update agent session ID
		this.agent.sessionId = this.sessionManager.getSessionId();

		// Emit session_switch event with reason "fork" to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "fork",
				previousSessionFile,
			});
		}

		return true;
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	/**
	 * Set model directly.
	 * Validates API key, saves to session and settings.
	 * @throws Error if no API key available for the model
	 */
	async setModel(
		model: Model,
		role: string = "default",
		options?: { selector?: string; thinkingLevel?: ThinkingLevel },
	): Promise<void> {
		const previousEditMode = this.#resolveActiveEditMode();
		const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
		if (!apiKey) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(model);
		this.sessionManager.appendModelChange(`${model.provider}/${model.id}`, role);
		this.settings.setModelRole(
			role,
			this.#formatRoleModelValue(role, model, options?.selector, options?.thinkingLevel),
		);
		this.settings.getStorage()?.recordModelUsage(`${model.provider}/${model.id}`);

		// Re-apply thinking for the newly selected model. Prefer the model's
		// configured defaultLevel; otherwise preserve the current level.
		this.setThinkingLevel(model.thinking?.defaultLevel ?? this.thinkingLevel);
		await this.#syncEditToolModeAfterModelChange(previousEditMode);
	}

	/**
	 * Set model temporarily (for this session only).
	 * Validates API key, saves to session log but NOT to settings.
	 * @throws Error if no API key available for the model
	 */
	async setModelTemporary(model: Model, thinkingLevel?: ThinkingLevel): Promise<void> {
		const previousEditMode = this.#resolveActiveEditMode();
		const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
		if (!apiKey) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(model);
		this.sessionManager.appendModelChange(`${model.provider}/${model.id}`, "temporary");
		this.settings.getStorage()?.recordModelUsage(`${model.provider}/${model.id}`);

		// Apply explicit thinking level if given; otherwise prefer the model's
		// configured defaultLevel; otherwise re-clamp the current level.
		this.setThinkingLevel(thinkingLevel ?? model.thinking?.defaultLevel ?? this.thinkingLevel);
		await this.#syncEditToolModeAfterModelChange(previousEditMode);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this.#scopedModels.length > 0) {
			return this.#cycleScopedModel(direction);
		}
		return this.#cycleAvailableModel(direction);
	}

	/**
	 * Cycle through configured role models in a fixed order.
	 * Skips missing roles.
	 * @param roleOrder - Order of roles to cycle through (e.g., ["slow", "default", "smol"])
	 * @param options - Optional settings: `temporary` to not persist to settings
	 */
	async cycleRoleModels(
		roleOrder: readonly string[],
		options?: { temporary?: boolean },
	): Promise<RoleModelCycleResult | undefined> {
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const currentModel = this.model;
		if (!currentModel) return undefined;
		const matchPreferences = { usageOrder: this.settings.getStorage()?.getModelUsageOrder() };
		const roleModels: Array<{
			role: string;
			model: Model;
			thinkingLevel?: ThinkingLevel;
			explicitThinkingLevel: boolean;
		}> = [];

		for (const role of roleOrder) {
			const roleModelStr =
				role === "default"
					? (this.settings.getModelRole("default") ?? `${currentModel.provider}/${currentModel.id}`)
					: this.settings.getModelRole(role);
			if (!roleModelStr) continue;

			const resolved = resolveModelRoleValue(roleModelStr, availableModels, {
				settings: this.settings,
				matchPreferences,
				modelRegistry: this.#modelRegistry,
			});
			if (!resolved.model) continue;

			roleModels.push({
				role,
				model: resolved.model,
				thinkingLevel: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
			});
		}

		if (roleModels.length <= 1) return undefined;

		const lastRole = this.sessionManager.getLastModelChangeRole();
		let currentIndex = lastRole ? roleModels.findIndex(entry => entry.role === lastRole) : -1;
		if (currentIndex === -1) {
			currentIndex = roleModels.findIndex(entry => modelsAreEqual(entry.model, currentModel));
		}
		if (currentIndex === -1) currentIndex = 0;

		const nextIndex = (currentIndex + 1) % roleModels.length;
		const next = roleModels[nextIndex];

		if (options?.temporary) {
			await this.setModelTemporary(next.model, next.explicitThinkingLevel ? next.thinkingLevel : undefined);
		} else {
			await this.setModel(next.model, next.role);
			if (next.explicitThinkingLevel && next.thinkingLevel !== undefined) {
				this.setThinkingLevel(next.thinkingLevel);
			}
		}

		return { model: next.model, thinkingLevel: this.thinkingLevel, role: next.role };
	}

	async #getScopedModelsWithApiKey(): Promise<Array<{ model: Model; thinkingLevel?: ThinkingLevel }>> {
		const apiKeysByProvider = new Map<string, string | undefined>();
		const result: Array<{ model: Model; thinkingLevel?: ThinkingLevel }> = [];

		for (const scoped of this.#scopedModels) {
			const provider = scoped.model.provider;
			let apiKey: string | undefined;
			if (apiKeysByProvider.has(provider)) {
				apiKey = apiKeysByProvider.get(provider);
			} else {
				apiKey = await this.#modelRegistry.getApiKeyForProvider(provider, this.sessionId);
				apiKeysByProvider.set(provider, apiKey);
			}

			if (apiKey) {
				result.push(scoped);
			}
		}

		return result;
	}

	async #cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#resolveActiveEditMode();
		const scopedModels = await this.#getScopedModelsWithApiKey();
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex(sm => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];

		// Apply model
		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(next.model);
		this.sessionManager.appendModelChange(`${next.model.provider}/${next.model.id}`);
		this.settings.setModelRole("default", this.#formatRoleModelValue("default", next.model));
		this.settings.getStorage()?.recordModelUsage(`${next.model.provider}/${next.model.id}`);

		// Apply the scoped model's configured thinking level
		this.setThinkingLevel(next.thinkingLevel);
		await this.#syncEditToolModeAfterModelChange(previousEditMode);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	async #cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#resolveActiveEditMode();
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex(m => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const apiKey = await this.#modelRegistry.getApiKey(nextModel, this.sessionId);
		if (!apiKey) {
			throw new Error(`No API key for ${nextModel.provider}/${nextModel.id}`);
		}

		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(nextModel);
		this.sessionManager.appendModelChange(`${nextModel.provider}/${nextModel.id}`);
		this.settings.setModelRole("default", this.#formatRoleModelValue("default", nextModel));
		this.settings.getStorage()?.recordModelUsage(`${nextModel.provider}/${nextModel.id}`);
		// Re-apply the current thinking level for the newly selected model
		this.setThinkingLevel(this.thinkingLevel);
		await this.#syncEditToolModeAfterModelChange(previousEditMode);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	/**
	 * Get all available models with valid API keys.
	 */
	getAvailableModels(): Model[] {
		return this.#modelRegistry.getAvailable();
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Saves the effective metadata-clamped level to session and settings only if it changes.
	 */
	setThinkingLevel(level: ThinkingLevel | undefined, persist: boolean = false): void {
		const effectiveLevel = resolveThinkingLevelForModel(this.model, level);
		const isChanging = effectiveLevel !== this.#thinkingLevel;

		this.#thinkingLevel = effectiveLevel;
		this.agent.setThinkingLevel(toReasoningEffort(effectiveLevel));

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (persist && effectiveLevel !== undefined && effectiveLevel !== ThinkingLevel.Off) {
				this.settings.set("defaultThinkingLevel", effectiveLevel);
			}
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.model?.reasoning) return undefined;

		const levels = [ThinkingLevel.Off, ...this.getAvailableThinkingLevels()];
		const currentLevel = this.thinkingLevel === ThinkingLevel.Inherit ? ThinkingLevel.Off : this.thinkingLevel;
		const currentIndex = currentLevel ? levels.indexOf(currentLevel) : -1;
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];
		if (!nextLevel) return undefined;

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	isFastModeEnabled(): boolean {
		return this.serviceTier === "priority";
	}

	setServiceTier(serviceTier: ServiceTier | undefined): void {
		if (this.serviceTier === serviceTier) return;
		this.agent.serviceTier = serviceTier;
		this.sessionManager.appendServiceTierChange(serviceTier ?? null);
	}

	setFastMode(enabled: boolean): void {
		this.setServiceTier(enabled ? "priority" : undefined);
	}

	toggleFastMode(): boolean {
		const enabled = !this.isFastModeEnabled();
		this.setFastMode(enabled);
		return enabled;
	}

	/**
	 * Get available thinking levels for current model.
	 */
	getAvailableThinkingLevels(): ReadonlyArray<Effort> {
		if (!this.model) return [];
		return getSupportedEfforts(this.model);
	}

	// =========================================================================
	// Message Queue Mode Management
	// =========================================================================

	/**
	 * Set steering mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setSteeringMode(mode);
		this.settings.set("steeringMode", mode);
	}

	/**
	 * Set follow-up mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setFollowUpMode(mode);
		this.settings.set("followUpMode", mode);
	}

	/**
	 * Set interrupt mode.
	 * Saves to settings.
	 */
	setInterruptMode(mode: "immediate" | "wait"): void {
		this.agent.setInterruptMode(mode);
		this.settings.set("interruptMode", mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	async #pruneToolOutputs(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
		const branchEntries = this.sessionManager.getBranch();
		const result = pruneToolOutputs(branchEntries, DEFAULT_PRUNE_CONFIG);
		if (result.prunedCount === 0) {
			return undefined;
		}

		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		return result;
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 * @param options Optional callbacks for completion/error handling
	 */
	async compact(customInstructions?: string, options?: CompactOptions): Promise<CompactionResult> {
		if (this.#compactionAbortController) {
			throw new Error("Compaction already in progress");
		}
		this.#disconnectFromAgent();
		await this.abort();
		const compactionAbortController = new AbortController();
		this.#compactionAbortController = compactionAbortController;

		try {
			if (!this.model) {
				throw new Error("No model selected");
			}

			const compactionSettings = this.settings.getGroup("compaction");
			const compactionModel = this.model;
			const apiKey = await this.#modelRegistry.getApiKey(compactionModel, this.sessionId);
			if (!apiKey) {
				throw new Error(`No API key for ${compactionModel.provider}`);
			}

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, compactionSettings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let hookCompaction: CompactionResult | undefined;
			let fromExtension = false;
			let hookContext: string[] | undefined;
			let hookPrompt: string | undefined;
			let preserveData: Record<string, unknown> | undefined;

			if (this.#extensionRunner?.hasHandlers("session_before_compact")) {
				const result = (await this.#extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal: compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					hookCompaction = result.compaction;
					fromExtension = true;
				}
			}

			if (!hookCompaction && this.#extensionRunner?.hasHandlers("session.compacting")) {
				const compactMessages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
				const result = (await this.#extensionRunner.emit({
					type: "session.compacting",
					sessionId: this.sessionId,
					messages: compactMessages,
				})) as { context?: string[]; prompt?: string; preserveData?: Record<string, unknown> } | undefined;

				hookContext = result?.context;
				hookPrompt = result?.prompt;
				preserveData = result?.preserveData;
			}

			const memoryBackendContext = await this.#collectMemoryBackendContext(preparation);
			if (memoryBackendContext) {
				hookContext = hookContext ? [...hookContext, memoryBackendContext] : [memoryBackendContext];
			}

			let summary: string;
			let shortSummary: string | undefined;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (hookCompaction) {
				// Extension provided compaction content
				summary = hookCompaction.summary;
				shortSummary = hookCompaction.shortSummary;
				firstKeptEntryId = hookCompaction.firstKeptEntryId;
				tokensBefore = hookCompaction.tokensBefore;
				details = hookCompaction.details;
				preserveData ??= hookCompaction.preserveData;
			} else {
				// Generate compaction result
				const result = await compact(
					preparation,
					compactionModel,
					apiKey,
					customInstructions,
					compactionAbortController.signal,
					{ promptOverride: hookPrompt, extraContext: hookContext, remoteInstructions: this.#baseSystemPrompt },
				);
				summary = result.summary;
				shortSummary = result.shortSummary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				details = result.details;
				preserveData = { ...(preserveData ?? {}), ...(result.preserveData ?? {}) };
			}

			if (compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				preserveData,
			);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			this.#syncTodoPhasesFromBranch();
			this.#closeCodexProviderSessionsForHistoryRewrite();

			// Get the saved compaction entry for the hook
			const savedCompactionEntry = newEntries.find(e => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.#extensionRunner && savedCompactionEntry) {
				await this.#extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
			};
			options?.onComplete?.(compactionResult);
			return compactionResult;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			options?.onError?.(err);
			throw error;
		} finally {
			if (this.#compactionAbortController === compactionAbortController) {
				this.#compactionAbortController = undefined;
			}
			this.#reconnectToAgent();
		}
	}

	/**
	 * Ask the active memory backend for an extra-context block to splice into
	 * the compaction summary prompt. Both the manual and auto compaction paths
	 * funnel through this helper so the behaviour stays identical.
	 *
	 * Failures are swallowed: a memory backend going sideways MUST NOT block
	 * compaction (which is itself the recovery path for context overflow).
	 */
	async #collectMemoryBackendContext(preparation: {
		messagesToSummarize: AgentMessage[];
		turnPrefixMessages: AgentMessage[];
	}): Promise<string | undefined> {
		const backend = resolveMemoryBackend(this.settings);
		if (!backend.preCompactionContext) return undefined;
		const messages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
		try {
			return await backend.preCompactionContext(messages, this.settings);
		} catch (err) {
			logger.debug("Memory backend preCompactionContext failed", {
				backend: backend.id,
				error: String(err),
			});
			return undefined;
		}
	}

	/**
	 * Cancel in-progress context maintenance (manual compaction, auto-compaction, or auto-handoff).
	 */
	abortCompaction(): void {
		this.#compactionAbortController?.abort();
		this.#autoCompactionAbortController?.abort();
		this.#handoffAbortController?.abort();
	}

	/** Trigger idle compaction through the auto-compaction flow (with UI events). */
	async runIdleCompaction(): Promise<void> {
		if (this.isStreaming || this.isCompacting) return;
		await this.#runAutoCompaction("idle", false, true);
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this.#branchSummaryAbortController?.abort();
	}

	/**
	 * Cancel in-progress handoff generation.
	 */
	abortHandoff(): void {
		this.#handoffAbortController?.abort();
	}

	/**
	 * Check if handoff generation is in progress.
	 */
	get isGeneratingHandoff(): boolean {
		return this.#handoffAbortController !== undefined;
	}

	/**
	 * Generate a handoff document by asking the agent, then start a new session with it.
	 *
	 * This prompts the current agent to write a comprehensive handoff document,
	 * waits for completion, then starts a fresh session with the handoff as context.
	 *
	 * @param customInstructions Optional focus for the handoff document
	 * @param options Handoff execution options
	 * @returns The handoff document text, or undefined if cancelled/failed
	 */
	async handoff(customInstructions?: string, options?: HandoffOptions): Promise<HandoffResult | undefined> {
		const entries = this.sessionManager.getBranch();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			throw new Error("Nothing to hand off (no messages yet)");
		}

		this.#skipPostTurnMaintenanceAssistantTimestamp = undefined;

		this.#handoffAbortController = new AbortController();
		const handoffAbortController = this.#handoffAbortController;
		const handoffSignal = handoffAbortController.signal;
		const sourceSignal = options?.signal;
		const onHandoffAbort = () => {
			this.agent.abort();
		};
		handoffSignal.addEventListener("abort", onHandoffAbort, { once: true });
		const onSourceAbort = () => {
			if (!handoffSignal.aborted) {
				handoffAbortController.abort();
			}
		};
		if (sourceSignal) {
			sourceSignal.addEventListener("abort", onSourceAbort, { once: true });
			if (sourceSignal.aborted) {
				onSourceAbort();
			}
		}

		// Build the handoff prompt
		const handoffPrompt = prompt.render(handoffDocumentPrompt, {
			additionalFocus: customInstructions,
		});

		// Create a promise that resolves when the agent completes
		let handoffText: string | undefined;
		const { promise: completionPromise, resolve: resolveCompletion } = Promise.withResolvers<void>();
		let handoffCancelled = false;
		let unsubscribe: (() => void) | undefined;
		const onCompletionAbort = () => {
			unsubscribe?.();
			handoffCancelled = true;
			resolveCompletion();
		};
		if (handoffSignal.aborted) {
			onCompletionAbort();
		} else {
			handoffSignal.addEventListener("abort", onCompletionAbort, { once: true });
		}
		unsubscribe = this.subscribe(event => {
			if (event.type === "agent_end") {
				unsubscribe?.();
				handoffSignal.removeEventListener("abort", onCompletionAbort);
				// Extract text from the last assistant message
				const messages = this.agent.state.messages;
				for (let i = messages.length - 1; i >= 0; i--) {
					const msg = messages[i];
					if (msg.role === "assistant") {
						const content = (msg as AssistantMessage).content;
						const textParts = content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text);
						if (textParts.length > 0) {
							handoffText = textParts.join("\n");
							break;
						}
					}
				}
				resolveCompletion();
			}
		});

		try {
			// Send the prompt and wait for completion
			if (handoffSignal.aborted) {
				throw new Error("Handoff cancelled");
			}
			this.#promptInFlightCount++;
			try {
				this.agent.setSystemPrompt(this.#baseSystemPrompt);
				await this.#promptAgentWithIdleRetry([
					{
						role: "developer",
						content: [{ type: "text", text: handoffPrompt }],
						attribution: "agent",
						timestamp: Date.now(),
					},
				]);
			} finally {
				this.#promptInFlightCount = Math.max(0, this.#promptInFlightCount - 1);
			}
			await completionPromise;

			if (handoffCancelled || handoffSignal.aborted) {
				throw new Error("Handoff cancelled");
			}
			if (!handoffText) {
				return undefined;
			}

			// Start a new session
			const previousSessionFile = this.sessionFile;
			await this.sessionManager.flush();
			this.#asyncJobManager?.cancelAll();
			await this.sessionManager.newSession(previousSessionFile ? { parentSession: previousSessionFile } : undefined);
			this.agent.reset();
			this.agent.sessionId = this.sessionManager.getSessionId();
			this.#steeringMessages = [];
			this.#followUpMessages = [];
			this.#pendingNextTurnMessages = [];
			this.#scheduledHiddenNextTurnGeneration = undefined;
			this.#todoReminderCount = 0;

			// Inject the handoff document as a custom message
			const handoffContent = `<handoff-context>\n${handoffText}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`;
			this.sessionManager.appendCustomMessageEntry("handoff", handoffContent, true, undefined, "agent");
			await this.sessionManager.ensureOnDisk();
			let savedPath: string | undefined;
			if (options?.autoTriggered && this.settings.get("compaction.handoffSaveToDisk")) {
				const artifactsDir = this.sessionManager.getArtifactsDir();
				if (artifactsDir) {
					const fileTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
					const handoffFilePath = path.join(artifactsDir, `handoff-${fileTimestamp}.md`);
					try {
						await Bun.write(handoffFilePath, `${handoffText}\n`);
						savedPath = handoffFilePath;
					} catch (error) {
						logger.warn("Failed to save handoff document to disk", {
							path: handoffFilePath,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				} else {
					logger.debug("Skipping handoff document save because session is not persisted");
				}
			}

			// Rebuild agent messages from session
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			this.#syncTodoPhasesFromBranch();

			return { document: handoffText, savedPath };
		} finally {
			unsubscribe?.();
			handoffSignal.removeEventListener("abort", onCompletionAbort);
			handoffSignal.removeEventListener("abort", onHandoffAbort);
			sourceSignal?.removeEventListener("abort", onSourceAbort);
			this.#handoffAbortController = undefined;
		}
	}

	/**
	 * Check if context maintenance or promotion is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Three cases (in order):
	 * 1. Overflow + promotion: promote to larger model, retry without maintenance
	 * 2. Overflow + no promotion target: run context maintenance, auto-retry on same model
	 * 3. Threshold: Context over threshold, run context maintenance (no auto-retry)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	async #checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<void> {
		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return;
		const contextWindow = this.model?.contextWindow ?? 0;
		const generation = this.#promptGeneration;
		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;
		// This handles the case where an error was kept after compaction (in the "kept" region).
		// The error shouldn't trigger another compaction since we already compacted.
		// Example: opus fails -> switch to codex -> compact -> switch back to opus -> opus error
		// is still in context but shouldn't trigger compaction again.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const errorIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp < new Date(compactionEntry.timestamp).getTime();
		if (sameModel && !errorIsFromBeforeCompaction && isContextOverflow(assistantMessage, contextWindow)) {
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.replaceMessages(messages.slice(0, -1));
			}

			// Try context promotion first - switch to a larger model and retry without compacting
			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (promoted) {
				// Retry on the promoted (larger) model without compacting
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				return;
			}

			// No promotion target available fall through to compaction
			const compactionSettings = this.settings.getGroup("compaction");
			if (compactionSettings.enabled && compactionSettings.strategy !== "off") {
				await this.#runAutoCompaction("overflow", true);
			}
			return;
		}
		const compactionSettings = this.settings.getGroup("compaction");
		if (!compactionSettings.enabled || compactionSettings.strategy === "off") return;

		// Case 2: Threshold - turn succeeded but context is getting large
		// Skip if this was an error (non-overflow errors don't have usage data)
		if (assistantMessage.stopReason === "error") return;
		const pruneResult = await this.#pruneToolOutputs();
		let contextTokens = calculateContextTokens(assistantMessage.usage);
		if (pruneResult) {
			contextTokens = Math.max(0, contextTokens - pruneResult.tokensSaved);
		}
		if (shouldCompact(contextTokens, contextWindow, compactionSettings)) {
			// Try promotion first — if a larger model is available, switch instead of compacting
			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (!promoted) {
				await this.#runAutoCompaction("threshold", false);
			}
		}
	}
	#assistantEndedWithSuccessfulYield(assistantMessage: AssistantMessage): boolean {
		const toolCallId = this.#lastSuccessfulYieldToolCallId;
		if (!toolCallId) return false;
		const lastToolCall = assistantMessage.content
			.slice()
			.reverse()
			.find((content): content is ToolCall => content.type === "toolCall");
		return lastToolCall?.name === "yield" && lastToolCall.id === toolCallId;
	}

	#enforceRewindBeforeYield(): boolean {
		if (!this.#checkpointState || this.#pendingRewindReport) {
			return false;
		}
		const reminder = [
			"<system-warning>",
			"You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.",
			"</system-warning>",
		].join("\n");
		this.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	async #applyRewind(report: string): Promise<void> {
		const checkpointState = this.#checkpointState;
		if (!checkpointState) {
			return;
		}
		const safeCount = Math.max(0, Math.min(checkpointState.checkpointMessageCount, this.agent.state.messages.length));
		this.agent.replaceMessages(this.agent.state.messages.slice(0, safeCount));
		try {
			this.sessionManager.branchWithSummary(checkpointState.checkpointEntryId, report, {
				startedAt: checkpointState.startedAt,
			});
		} catch (error) {
			logger.warn("Rewind branch checkpoint missing, falling back to root", {
				error: error instanceof Error ? error.message : String(error),
			});
			this.sessionManager.branchWithSummary(null, report, { startedAt: checkpointState.startedAt });
		}
		const details = { startedAt: checkpointState.startedAt, rewoundAt: new Date().toISOString() };
		this.agent.appendMessage({
			role: "custom",
			customType: "rewind-report",
			content: report,
			display: false,
			details,
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.sessionManager.appendCustomMessageEntry("rewind-report", report, false, details, "agent");
		this.#checkpointState = undefined;
		this.#pendingRewindReport = undefined;
	}
	async #enforcePlanModeToolDecision(): Promise<void> {
		if (!this.#planModeState?.enabled) {
			return;
		}
		const assistantMessage = this.#findLastAssistantMessage();
		if (!assistantMessage) {
			return;
		}
		if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
			return;
		}

		const calledRequiredTool = assistantMessage.content.some(
			content => content.type === "toolCall" && (content.name === "ask" || content.name === "exit_plan_mode"),
		);
		if (calledRequiredTool) {
			return;
		}
		const hasRequiredTools = this.#toolRegistry.has("ask") && this.#toolRegistry.has("exit_plan_mode");
		if (!hasRequiredTools) {
			logger.warn("Plan mode enforcement skipped because ask/exit tools are unavailable", {
				activeToolNames: this.agent.state.tools.map(tool => tool.name),
			});
			return;
		}

		const reminder = prompt.render(planModeToolDecisionReminderPrompt, {
			askToolName: "ask",
			exitToolName: "exit_plan_mode",
		});

		await this.prompt(reminder, {
			synthetic: true,
			expandPromptTemplates: false,
			toolChoice: "required",
		});
	}

	#createEagerTodoPrelude(promptText: string): { message: AgentMessage; toolChoice: ToolChoice } | undefined {
		const eagerTodosEnabled = this.settings.get("todo.eager");
		const todosEnabled = this.settings.get("todo.enabled");
		if (!eagerTodosEnabled || !todosEnabled) {
			return undefined;
		}

		if (this.#planModeState?.enabled) {
			return undefined;
		}
		if (this.getTodoPhases().length > 0) {
			return undefined;
		}

		// Only inject on the first user message of the conversation. Subsequent user
		// turns must not receive the eager todo reminder — they often correct, clarify,
		// or redirect the prior task, and forcing a brand-new todo list there is wrong.
		const hasPriorUserMessage = this.agent.state.messages.some(m => m.role === "user");
		if (hasPriorUserMessage) {
			return undefined;
		}

		const trimmedPromptText = promptText.trimEnd();
		if (trimmedPromptText.endsWith("?") || trimmedPromptText.endsWith("!")) {
			return undefined;
		}

		if (!this.#toolRegistry.has("todo_write")) {
			logger.warn("Eager todo enforcement skipped because todo_write is unavailable", {
				activeToolNames: this.agent.state.tools.map(tool => tool.name),
			});
			return undefined;
		}

		const todoWriteToolChoice = buildNamedToolChoice("todo_write", this.model);
		if (!todoWriteToolChoice) {
			logger.warn("Eager todo enforcement skipped because the current model does not support forcing todo_write", {
				modelApi: this.model?.api,
				modelId: this.model?.id,
			});
			return undefined;
		}

		const eagerTodoReminder = prompt.render(eagerTodoPrompt);

		return {
			message: {
				role: "custom",
				customType: "eager-todo-prelude",
				content: eagerTodoReminder,
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
			toolChoice: todoWriteToolChoice,
		};
	}
	/**
	 * Check if agent stopped with incomplete todos and prompt to continue.
	 */
	async #checkTodoCompletion(): Promise<void> {
		// Skip todo reminders when the most recent turn was driven by an explicit user force —
		// the user wanted exactly that tool, not a follow-up nag about incomplete todos.
		const lastServedLabel = this.#toolChoiceQueue.consumeLastServedLabel();
		if (lastServedLabel === "user-force") {
			return;
		}

		const remindersEnabled = this.settings.get("todo.reminders");
		const todosEnabled = this.settings.get("todo.enabled");
		if (!remindersEnabled || !todosEnabled) {
			this.#todoReminderCount = 0;
			return;
		}

		const remindersMax = this.settings.get("todo.reminders.max");
		if (this.#todoReminderCount >= remindersMax) {
			logger.debug("Todo completion: max reminders reached", { count: this.#todoReminderCount });
			return;
		}

		const phases = this.getTodoPhases();
		if (phases.length === 0) {
			this.#todoReminderCount = 0;
			return;
		}

		const incompleteByPhase = phases
			.map(phase => ({
				name: phase.name,
				tasks: phase.tasks
					.filter(
						(task): task is TodoItem & { status: "pending" | "in_progress" } =>
							task.status === "pending" || task.status === "in_progress",
					)
					.map(task => ({ content: task.content, status: task.status })),
			}))
			.filter(phase => phase.tasks.length > 0);
		const incomplete = incompleteByPhase.flatMap(phase => phase.tasks);
		if (incomplete.length === 0) {
			this.#todoReminderCount = 0;
			return;
		}

		// Build reminder message
		this.#todoReminderCount++;
		const todoList = incompleteByPhase
			.map(phase => `- ${phase.name}\n${phase.tasks.map(task => `  - ${task.content}`).join("\n")}`)
			.join("\n");
		const reminder =
			`<system-reminder>\n` +
			`You stopped with ${incomplete.length} incomplete todo item(s):\n${todoList}\n\n` +
			`Please continue working on these tasks or mark them complete if finished.\n` +
			`(Reminder ${this.#todoReminderCount}/${remindersMax})\n` +
			`</system-reminder>`;

		logger.debug("Todo completion: sending reminder", {
			incomplete: incomplete.length,
			attempt: this.#todoReminderCount,
		});

		// Emit event for UI to render notification
		await this.#emitSessionEvent({
			type: "todo_reminder",
			todos: incomplete,
			attempt: this.#todoReminderCount,
			maxAttempts: remindersMax,
		});

		// Inject reminder and continue the conversation
		this.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
	}

	/**
	 * Attempt context promotion to a larger model.
	 * Returns true if promotion succeeded (caller should retry without compacting).
	 */
	async #tryContextPromotion(assistantMessage: AssistantMessage): Promise<boolean> {
		const promotionSettings = this.settings.getGroup("contextPromotion");
		if (!promotionSettings.enabled) return false;
		const currentModel = this.model;
		if (!currentModel) return false;
		if (assistantMessage.provider !== currentModel.provider || assistantMessage.model !== currentModel.id)
			return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.#resolveContextPromotionTarget(currentModel, contextWindow);
		if (!targetModel) return false;

		try {
			await this.setModelTemporary(targetModel);
			logger.debug("Context promotion switched model on overflow", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
			});
			return true;
		} catch (error) {
			logger.warn("Context promotion failed", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
				error: String(error),
			});
			return false;
		}
	}

	async #resolveContextPromotionTarget(currentModel: Model, contextWindow: number): Promise<Model | undefined> {
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const candidate = this.#resolveContextPromotionConfiguredTarget(currentModel, availableModels);
		if (!candidate) return undefined;
		if (modelsAreEqual(candidate, currentModel)) return undefined;
		if (candidate.contextWindow <= contextWindow) return undefined;
		const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
		if (!apiKey) return undefined;
		return candidate;
	}

	#setModelWithProviderSessionReset(model: Model): void {
		const currentModel = this.model;
		if (currentModel) {
			this.#closeProviderSessionsForModelSwitch(currentModel, model);
		}
		this.agent.setModel(model);
	}

	#closeCodexProviderSessionsForHistoryRewrite(): void {
		const currentModel = this.model;
		if (!currentModel || currentModel.api !== "openai-codex-responses") return;
		this.#closeProviderSessionsForModelSwitch(currentModel, currentModel);
	}

	#closeProviderSessionsForModelSwitch(currentModel: Model, nextModel: Model): void {
		const providerKeys = new Set<string>();
		if (currentModel.api === "openai-codex-responses" || nextModel.api === "openai-codex-responses") {
			providerKeys.add("openai-codex-responses");
		}
		if (currentModel.api === "openai-responses") {
			providerKeys.add(`openai-responses:${currentModel.provider}`);
		}
		if (nextModel.api === "openai-responses") {
			providerKeys.add(`openai-responses:${nextModel.provider}`);
		}

		for (const providerKey of providerKeys) {
			const state = this.#providerSessionState.get(providerKey);
			if (!state) continue;

			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state during model switch", {
					providerKey,
					error: String(error),
				});
			}

			this.#providerSessionState.delete(providerKey);
		}
	}

	#normalizeProviderReplayValue(value: unknown): unknown {
		if (Array.isArray(value)) {
			return value.map(item => this.#normalizeProviderReplayValue(item));
		}
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, entryValue]) => [key, this.#normalizeProviderReplayValue(entryValue)]),
			);
		}
		return value;
	}

	#normalizeSessionMessageForProviderReplay(message: AgentMessage): unknown {
		switch (message.role) {
			case "user":
			case "developer":
				return {
					role: message.role,
					content: this.#normalizeProviderReplayValue(message.content),
					providerPayload: message.providerPayload,
				};
			case "assistant": {
				const isResponsesFamilyMessage =
					message.api === "openai-responses" || message.api === "openai-codex-responses";
				return {
					role: message.role,
					content:
						isResponsesFamilyMessage && Array.isArray(message.content)
							? message.content.flatMap(block => {
									if (block.type === "thinking") {
										return [];
									}
									if (block.type === "toolCall") {
										return [
											{
												type: block.type,
												id: block.id,
												name: block.name,
												arguments: block.arguments,
											},
										];
									}
									if (block.type === "text") {
										return [{ type: block.type, text: block.text, textSignature: block.textSignature }];
									}
									return [this.#normalizeProviderReplayValue(block)];
								})
							: this.#normalizeProviderReplayValue(message.content),
					api: message.api,
					provider: message.provider,
					model: message.model,
					stopReason: message.stopReason,
					errorMessage: message.errorMessage,
					providerPayload: isResponsesFamilyMessage ? undefined : message.providerPayload,
				};
			}
			case "toolResult":
				return {
					role: message.role,
					toolName: message.toolName,
					toolCallId: message.toolCallId,
					isError: message.isError,
					content: this.#normalizeProviderReplayValue(message.content),
				};
			case "bashExecution":
				return {
					role: message.role,
					command: message.command,
					output: message.output,
					exitCode: message.exitCode,
					cancelled: message.cancelled,
					meta: message.meta
						? {
								truncation: this.#normalizeProviderReplayValue(message.meta.truncation),
								limits: this.#normalizeProviderReplayValue(message.meta.limits),
								diagnostics: message.meta.diagnostics
									? this.#normalizeProviderReplayValue({
											summary: message.meta.diagnostics.summary,
											messages: message.meta.diagnostics.messages,
										})
									: undefined,
							}
						: undefined,
					excludeFromContext: message.excludeFromContext,
				};
			case "pythonExecution":
				return {
					role: message.role,
					code: message.code,
					output: message.output,
					exitCode: message.exitCode,
					cancelled: message.cancelled,
					meta: message.meta
						? {
								truncation: this.#normalizeProviderReplayValue(message.meta.truncation),
								limits: this.#normalizeProviderReplayValue(message.meta.limits),
								diagnostics: message.meta.diagnostics
									? this.#normalizeProviderReplayValue({
											summary: message.meta.diagnostics.summary,
											messages: message.meta.diagnostics.messages,
										})
									: undefined,
							}
						: undefined,
					excludeFromContext: message.excludeFromContext,
				};
			case "custom":
			case "hookMessage":
				return {
					role: message.role,
					customType: message.customType,
					content: this.#normalizeProviderReplayValue(message.content),
				};
			case "branchSummary":
				return { role: message.role, summary: message.summary };
			case "compactionSummary":
				return {
					role: message.role,
					summary: message.summary,
					providerPayload: message.providerPayload,
				};
			case "fileMention":
				return {
					role: message.role,
					files: message.files.map(file => ({
						path: file.path,
						content: file.content,
						image: file.image,
					})),
				};
			default:
				return this.#normalizeProviderReplayValue(message);
		}
	}

	#didSessionMessagesChange(previousMessages: AgentMessage[], nextMessages: AgentMessage[]): boolean {
		return (
			JSON.stringify(previousMessages.map(message => this.#normalizeSessionMessageForProviderReplay(message))) !==
			JSON.stringify(nextMessages.map(message => this.#normalizeSessionMessageForProviderReplay(message)))
		);
	}

	#getModelKey(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	#formatRoleModelValue(
		role: string,
		model: Model,
		selectorOverride?: string,
		thinkingLevelOverride?: ThinkingLevel,
	): string {
		const modelKey = selectorOverride ?? `${model.provider}/${model.id}`;
		if (thinkingLevelOverride !== undefined) {
			return formatModelSelectorValue(modelKey, thinkingLevelOverride);
		}
		const existingRoleValue = this.settings.getModelRole(role);
		if (!existingRoleValue) return modelKey;

		const thinkingLevel = extractExplicitThinkingSelector(existingRoleValue, this.settings);
		return formatModelSelectorValue(modelKey, thinkingLevel);
	}
	#resolveContextPromotionConfiguredTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
		const configuredTarget = currentModel.contextPromotionTarget?.trim();
		if (!configuredTarget) return undefined;

		const parsed = parseModelString(configuredTarget);
		if (parsed) {
			const explicitModel = availableModels.find(m => m.provider === parsed.provider && m.id === parsed.id);
			if (explicitModel) return explicitModel;
		}

		return availableModels.find(m => m.provider === currentModel.provider && m.id === configuredTarget);
	}

	#resolveRoleModelFull(
		role: string,
		availableModels: Model[],
		currentModel: Model | undefined,
	): ResolvedModelRoleValue {
		const roleModelStr =
			role === "default"
				? (this.settings.getModelRole("default") ??
					(currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined))
				: this.settings.getModelRole(role);

		if (!roleModelStr) {
			return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
		}

		return resolveModelRoleValue(roleModelStr, availableModels, {
			settings: this.settings,
			matchPreferences: { usageOrder: this.settings.getStorage()?.getModelUsageOrder() },
			modelRegistry: this.#modelRegistry,
		});
	}

	#getCompactionModelCandidates(availableModels: Model[]): Model[] {
		const candidates: Model[] = [];
		const seen = new Set<string>();

		const addCandidate = (model: Model | undefined): void => {
			if (!model) return;
			const key = this.#getModelKey(model);
			if (seen.has(key)) return;
			seen.add(key);
			candidates.push(model);
		};

		const currentModel = this.model;
		for (const role of MODEL_ROLE_IDS) {
			addCandidate(this.#resolveRoleModelFull(role, availableModels, currentModel).model);
		}

		const sortedByContext = [...availableModels].sort((a, b) => b.contextWindow - a.contextWindow);
		for (const model of sortedByContext) {
			if (!seen.has(this.#getModelKey(model))) {
				addCandidate(model);
				break;
			}
		}

		return candidates;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	async #runAutoCompaction(
		reason: "overflow" | "threshold" | "idle",
		willRetry: boolean,
		deferred = false,
	): Promise<void> {
		const compactionSettings = this.settings.getGroup("compaction");
		if (compactionSettings.strategy === "off") return;
		if (reason !== "idle" && !compactionSettings.enabled) return;
		const generation = this.#promptGeneration;
		if (!deferred && reason !== "overflow" && reason !== "idle" && compactionSettings.strategy === "handoff") {
			this.#schedulePostPromptTask(
				async signal => {
					await Promise.resolve();
					if (signal.aborted) return;
					await this.#runAutoCompaction(reason, willRetry, true);
				},
				{ generation },
			);
			return;
		}

		let action: "context-full" | "handoff" =
			compactionSettings.strategy === "handoff" && reason !== "overflow" ? "handoff" : "context-full";
		await this.#emitSessionEvent({ type: "auto_compaction_start", reason, action });
		// Abort any older auto-compaction before installing this run's controller.
		this.#autoCompactionAbortController?.abort();
		const autoCompactionAbortController = new AbortController();
		this.#autoCompactionAbortController = autoCompactionAbortController;
		const autoCompactionSignal = autoCompactionAbortController.signal;

		try {
			if (compactionSettings.strategy === "handoff" && reason !== "overflow") {
				const handoffFocus = AUTO_HANDOFF_THRESHOLD_FOCUS;
				const handoffResult = await this.handoff(handoffFocus, {
					autoTriggered: true,
					signal: this.#autoCompactionAbortController.signal,
				});
				if (!handoffResult) {
					const aborted = autoCompactionSignal.aborted;
					if (aborted) {
						await this.#emitSessionEvent({
							type: "auto_compaction_end",
							action,
							result: undefined,
							aborted: true,
							willRetry: false,
						});
						return;
					}
					logger.warn("Auto-handoff returned no document; falling back to context-full maintenance", {
						reason,
					});
					action = "context-full";
				}
				if (handoffResult) {
					await this.#emitSessionEvent({
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: false,
						willRetry: false,
					});
					if (!autoCompactionSignal.aborted && reason !== "idle" && compactionSettings.autoContinue !== false) {
						this.#scheduleAutoContinuePrompt(generation);
					}
					return;
				}
			}

			if (!this.model) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				return;
			}

			const availableModels = this.#modelRegistry.getAvailable();
			if (availableModels.length === 0) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				return;
			}

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, compactionSettings);
			if (!preparation) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				if (!willRetry && this.agent.hasQueuedMessages()) {
					this.#scheduleAgentContinue({
						delayMs: 100,
						generation,
						shouldContinue: () => this.agent.hasQueuedMessages(),
					});
				}
				return;
			}

			let hookCompaction: CompactionResult | undefined;
			let fromExtension = false;
			let hookContext: string[] | undefined;
			let hookPrompt: string | undefined;
			let preserveData: Record<string, unknown> | undefined;

			if (this.#extensionRunner?.hasHandlers("session_before_compact")) {
				const hookResult = (await this.#extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					signal: autoCompactionSignal,
				})) as SessionBeforeCompactResult | undefined;

				if (hookResult?.cancel) {
					await this.#emitSessionEvent({
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return;
				}

				if (hookResult?.compaction) {
					hookCompaction = hookResult.compaction;
					fromExtension = true;
				}
			}

			if (!hookCompaction && this.#extensionRunner?.hasHandlers("session.compacting")) {
				const compactMessages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
				const result = (await this.#extensionRunner.emit({
					type: "session.compacting",
					sessionId: this.sessionId,
					messages: compactMessages,
				})) as { context?: string[]; prompt?: string; preserveData?: Record<string, unknown> } | undefined;

				hookContext = result?.context;
				hookPrompt = result?.prompt;
				preserveData = result?.preserveData;
			}

			const memoryBackendContext = await this.#collectMemoryBackendContext(preparation);
			if (memoryBackendContext) {
				hookContext = hookContext ? [...hookContext, memoryBackendContext] : [memoryBackendContext];
			}

			let summary: string;
			let shortSummary: string | undefined;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (hookCompaction) {
				// Extension provided compaction content
				summary = hookCompaction.summary;
				shortSummary = hookCompaction.shortSummary;
				firstKeptEntryId = hookCompaction.firstKeptEntryId;
				tokensBefore = hookCompaction.tokensBefore;
				details = hookCompaction.details;
				preserveData ??= hookCompaction.preserveData;
			} else {
				const candidates = this.#getCompactionModelCandidates(availableModels);
				const retrySettings = this.settings.getGroup("retry");
				let compactResult: CompactionResult | undefined;
				let lastError: unknown;

				for (const candidate of candidates) {
					const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
					if (!apiKey) continue;

					let attempt = 0;
					while (true) {
						try {
							compactResult = await compact(preparation, candidate, apiKey, undefined, autoCompactionSignal, {
								promptOverride: hookPrompt,
								extraContext: hookContext,
								remoteInstructions: this.#baseSystemPrompt,
								initiatorOverride: "agent",
							});
							break;
						} catch (error) {
							if (autoCompactionSignal.aborted) {
								throw error;
							}

							const message = error instanceof Error ? error.message : String(error);
							const retryAfterMs = this.#parseRetryAfterMsFromError(message);
							const shouldRetry =
								retrySettings.enabled &&
								attempt < retrySettings.maxRetries &&
								(retryAfterMs !== undefined ||
									this.#isTransientErrorMessage(message) ||
									isUsageLimitError(message));
							if (!shouldRetry) {
								lastError = error;
								break;
							}

							const baseDelayMs = retrySettings.baseDelayMs * 2 ** attempt;
							const delayMs = retryAfterMs !== undefined ? Math.max(baseDelayMs, retryAfterMs) : baseDelayMs;

							// If retry delay is too long (>30s), try next candidate instead of waiting
							const maxAcceptableDelayMs = 30_000;
							if (delayMs > maxAcceptableDelayMs) {
								const hasMoreCandidates = candidates.indexOf(candidate) < candidates.length - 1;
								if (hasMoreCandidates) {
									logger.warn("Auto-compaction retry delay too long, trying next model", {
										delayMs,
										retryAfterMs,
										error: message,
										model: `${candidate.provider}/${candidate.id}`,
									});
									lastError = error;
									break; // Exit retry loop, continue to next candidate
								}
								// No more candidates - we have to wait
							}

							attempt++;
							logger.warn("Auto-compaction failed, retrying", {
								attempt,
								maxRetries: retrySettings.maxRetries,
								delayMs,
								retryAfterMs,
								error: message,
								model: `${candidate.provider}/${candidate.id}`,
							});
							await abortableSleep(delayMs, autoCompactionSignal);
						}
					}

					if (compactResult) {
						break;
					}
				}

				if (!compactResult) {
					if (lastError) {
						throw lastError;
					}
					throw new Error("Compaction failed: no available model");
				}

				summary = compactResult.summary;
				shortSummary = compactResult.shortSummary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
				preserveData = { ...(preserveData ?? {}), ...(compactResult.preserveData ?? {}) };
			}

			if (autoCompactionSignal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return;
			}

			this.sessionManager.appendCompaction(
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				preserveData,
			);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			this.#syncTodoPhasesFromBranch();
			this.#closeCodexProviderSessionsForHistoryRewrite();

			// Get the saved compaction entry for the hook
			const savedCompactionEntry = newEntries.find(e => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.#extensionRunner && savedCompactionEntry) {
				await this.#extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const result: CompactionResult = {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
			};
			await this.#emitSessionEvent({ type: "auto_compaction_end", action, result, aborted: false, willRetry });

			if (!willRetry && reason !== "idle" && compactionSettings.autoContinue !== false) {
				this.#scheduleAutoContinuePrompt(generation);
			}

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.replaceMessages(messages.slice(0, -1));
				}

				this.#scheduleAgentContinue({ delayMs: 100, generation });
			} else if (this.agent.hasQueuedMessages()) {
				// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
				// Kick the loop so queued messages are actually delivered.
				this.#scheduleAgentContinue({
					delayMs: 100,
					generation,
					shouldContinue: () => this.agent.hasQueuedMessages(),
				});
			}
		} catch (error) {
			if (autoCompactionSignal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return;
			}
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			await this.#emitSessionEvent({
				type: "auto_compaction_end",
				action,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`,
			});
		} finally {
			if (this.#autoCompactionAbortController === autoCompactionAbortController) {
				this.#autoCompactionAbortController = undefined;
			}
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settings.set("compaction.enabled", enabled);
		if (enabled && this.settings.get("compaction.strategy") === "off") {
			this.settings.set("compaction.strategy", "context-full");
		}
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settings.get("compaction.enabled") && this.settings.get("compaction.strategy") !== "off";
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (transient errors or usage limits).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 * Usage-limit errors are retryable because the retry handler performs credential switching.
	 */
	#isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		// Context overflow is handled by compaction, not retry
		const contextWindow = this.model?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		const err = message.errorMessage;
		return this.#isTransientErrorMessage(err) || isUsageLimitError(err);
	}

	#isTransientErrorMessage(errorMessage: string): boolean {
		return (
			this.#isTransientEnvelopeErrorMessage(errorMessage) || this.#isTransientTransportErrorMessage(errorMessage)
		);
	}

	#isTransientEnvelopeErrorMessage(errorMessage: string): boolean {
		// Match Anthropic stream-envelope failures that indicate a broken stream before any content starts.
		return /anthropic stream envelope error:/i.test(errorMessage) && /before message_start/i.test(errorMessage);
	}

	#isTransientTransportErrorMessage(errorMessage: string): boolean {
		// Match: overloaded_error, provider returned error, rate limit, 429, 500, 502, 503, 504,
		// service unavailable, network/connection/socket errors, fetch failed, terminated, retry delay exceeded
		return (
			isUnexpectedSocketCloseMessage(errorMessage) ||
			/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay|stream stall|no error details in response/i.test(
				errorMessage,
			)
		);
	}

	#getRetryFallbackChains(): RetryFallbackChains {
		const configuredChains = this.settings.get("retry.fallbackChains");
		if (!configuredChains || typeof configuredChains !== "object") return {};
		return configuredChains as RetryFallbackChains;
	}

	#validateRetryFallbackChains(): void {
		const configuredChains = this.settings.get("retry.fallbackChains");
		if (configuredChains === undefined) return;
		if (!configuredChains || typeof configuredChains !== "object" || Array.isArray(configuredChains)) {
			const msg = "retry.fallbackChains must be a mapping of role names to selector arrays.";
			logger.warn(msg);
			this.configWarnings.push(msg);
			return;
		}

		for (const [role, chain] of Object.entries(configuredChains)) {
			if (!Array.isArray(chain)) {
				const msg = `Fallback chain for role '${role}' must be an array of selector strings.`;
				logger.warn(msg);
				this.configWarnings.push(msg);
				continue;
			}
			for (const selectorStr of chain) {
				if (typeof selectorStr !== "string") {
					const msg = `Fallback chain for role '${role}' contains a non-string selector.`;
					logger.warn(msg);
					this.configWarnings.push(msg);
					continue;
				}
				const parsed = parseRetryFallbackSelector(selectorStr);
				if (!parsed) {
					const msg = `Invalid fallback selector format in role '${role}': ${selectorStr}`;
					logger.warn(msg);
					this.configWarnings.push(msg);
					continue;
				}
				const exists = this.#modelRegistry.find(parsed.provider, parsed.id);
				if (!exists) {
					const msg = `Fallback chain for role '${role}' references unknown model: ${selectorStr}`;
					logger.warn(msg);
					this.configWarnings.push(msg);
				}
			}
		}
	}

	#getRetryFallbackRevertPolicy(): RetryFallbackRevertPolicy {
		return this.settings.get("retry.fallbackRevertPolicy") === "never" ? "never" : "cooldown-expiry";
	}

	#getRetryFallbackPrimarySelector(role: string): RetryFallbackSelector | undefined {
		const configuredSelector = this.settings.getModelRole(role);
		return configuredSelector ? parseRetryFallbackSelector(configuredSelector) : undefined;
	}

	#clearActiveRetryFallback(): void {
		this.#activeRetryFallback = undefined;
	}

	#isRetryFallbackSelectorSuppressed(selector: RetryFallbackSelector): boolean {
		return this.#modelRegistry.isSelectorSuppressed(selector.raw);
	}

	#noteRetryFallbackCooldown(currentSelector: string, retryAfterMs: number | undefined, errorMessage: string): void {
		let cooldownMs = retryAfterMs;
		if (!cooldownMs || cooldownMs <= 0) {
			const reason = parseRateLimitReason(errorMessage);
			cooldownMs = reason === "UNKNOWN" ? 5 * 60 * 1000 : calculateRateLimitBackoffMs(reason);
		}
		this.#modelRegistry.suppressSelector(currentSelector, Date.now() + cooldownMs);
	}

	#resolveRetryFallbackRole(currentSelector: string): string | undefined {
		const parsedCurrent = parseRetryFallbackSelector(currentSelector);
		if (!parsedCurrent) return undefined;
		const currentBaseSelector = formatRetryFallbackBaseSelector(parsedCurrent);
		for (const role of Object.keys(this.#getRetryFallbackChains())) {
			const primarySelector = this.#getRetryFallbackPrimarySelector(role);
			if (!primarySelector) continue;
			if (primarySelector.raw === currentSelector) return role;
			if (formatRetryFallbackBaseSelector(primarySelector) === currentBaseSelector) return role;
		}
		return undefined;
	}

	#getRetryFallbackEffectiveChain(role: string): RetryFallbackSelector[] {
		const primarySelector = this.#getRetryFallbackPrimarySelector(role);
		if (!primarySelector) return [];
		const chain = [primarySelector];
		const seen = new Set<string>([primarySelector.raw]);
		for (const selector of this.#getRetryFallbackChains()[role] ?? []) {
			const parsed = parseRetryFallbackSelector(selector);
			if (!parsed || seen.has(parsed.raw)) continue;
			seen.add(parsed.raw);
			chain.push(parsed);
		}
		return chain;
	}

	#findRetryFallbackCandidates(role: string, currentSelector: string): RetryFallbackSelector[] {
		const chain = this.#getRetryFallbackEffectiveChain(role);
		if (chain.length <= 1) return [];
		const parsedCurrent = parseRetryFallbackSelector(currentSelector);
		const currentBaseSelector = parsedCurrent ? formatRetryFallbackBaseSelector(parsedCurrent) : undefined;
		const exactIndex = chain.findIndex(selector => selector.raw === currentSelector);
		if (exactIndex >= 0) return chain.slice(exactIndex + 1);
		const baseIndex = currentBaseSelector
			? chain.findIndex(selector => formatRetryFallbackBaseSelector(selector) === currentBaseSelector)
			: -1;
		if (baseIndex >= 0) return chain.slice(baseIndex + 1);
		return chain.slice(1);
	}

	async #applyRetryFallbackCandidate(
		role: string,
		selector: RetryFallbackSelector,
		currentSelector: string,
	): Promise<void> {
		const candidate = this.#modelRegistry.find(selector.provider, selector.id);
		if (!candidate) {
			throw new Error(`Retry fallback model not found: ${selector.raw}`);
		}
		const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
		if (!apiKey) {
			throw new Error(`No API key for retry fallback ${selector.raw}`);
		}

		const currentThinkingLevel = this.thinkingLevel;
		const nextThinkingLevel = selector.thinkingLevel ?? currentThinkingLevel;

		this.#setModelWithProviderSessionReset(candidate);
		this.sessionManager.appendModelChange(`${candidate.provider}/${candidate.id}`, "temporary");
		this.settings.getStorage()?.recordModelUsage(`${candidate.provider}/${candidate.id}`);
		this.setThinkingLevel(nextThinkingLevel);
		if (!this.#activeRetryFallback) {
			this.#activeRetryFallback = {
				role,
				originalSelector: currentSelector,
				originalThinkingLevel: currentThinkingLevel,
				lastAppliedFallbackThinkingLevel: nextThinkingLevel,
			};
		} else {
			this.#activeRetryFallback.lastAppliedFallbackThinkingLevel = nextThinkingLevel;
		}
		await this.#emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: selector.raw,
			role,
		});
	}

	async #tryRetryModelFallback(currentSelector: string): Promise<boolean> {
		const role = this.#activeRetryFallback?.role ?? this.#resolveRetryFallbackRole(currentSelector);
		if (!role) return false;

		for (const selector of this.#findRetryFallbackCandidates(role, currentSelector)) {
			if (this.#isRetryFallbackSelectorSuppressed(selector)) continue;
			const candidate = this.#modelRegistry.find(selector.provider, selector.id);
			if (!candidate) continue;
			const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
			if (!apiKey) continue;
			await this.#applyRetryFallbackCandidate(role, selector, currentSelector);
			return true;
		}

		return false;
	}

	async #maybeRestoreRetryFallbackPrimary(): Promise<void> {
		if (!this.#activeRetryFallback) return;
		if (this.#getRetryFallbackRevertPolicy() !== "cooldown-expiry") return;

		const {
			originalSelector: originalSelectorRaw,
			originalThinkingLevel,
			lastAppliedFallbackThinkingLevel,
		} = this.#activeRetryFallback;
		const originalSelector = parseRetryFallbackSelector(originalSelectorRaw);
		if (!originalSelector) {
			this.#clearActiveRetryFallback();
			return;
		}

		const currentModel = this.model;
		if (!currentModel) return;
		const currentSelector = formatRetryFallbackSelector(currentModel, this.thinkingLevel);
		if (currentSelector === originalSelector.raw) {
			if (!this.#isRetryFallbackSelectorSuppressed(originalSelector)) {
				this.#clearActiveRetryFallback();
			}
			return;
		}
		if (this.#isRetryFallbackSelectorSuppressed(originalSelector)) return;

		const primaryModel = this.#modelRegistry.find(originalSelector.provider, originalSelector.id);
		if (!primaryModel) return;
		const apiKey = await this.#modelRegistry.getApiKey(primaryModel, this.sessionId);
		if (!apiKey) return;

		const currentThinkingLevel = this.thinkingLevel;
		const thinkingToApply =
			currentThinkingLevel === lastAppliedFallbackThinkingLevel ? originalThinkingLevel : currentThinkingLevel;
		this.#setModelWithProviderSessionReset(primaryModel);
		this.sessionManager.appendModelChange(`${primaryModel.provider}/${primaryModel.id}`, "temporary");
		this.settings.getStorage()?.recordModelUsage(`${primaryModel.provider}/${primaryModel.id}`);
		this.setThinkingLevel(thinkingToApply);
		this.#clearActiveRetryFallback();
	}

	#parseRetryAfterMsFromError(errorMessage: string): number | undefined {
		const now = Date.now();
		const retryAfterMsMatch = /retry-after-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (retryAfterMsMatch) {
			return Math.max(0, Number(retryAfterMsMatch[1]));
		}

		const retryAfterMatch = /retry-after\s*[:=]\s*([^\s,;]+)/i.exec(errorMessage);
		if (retryAfterMatch) {
			const value = retryAfterMatch[1];
			const seconds = Number(value);
			if (!Number.isNaN(seconds)) {
				return Math.max(0, seconds * 1000);
			}
			const dateMs = Date.parse(value);
			if (!Number.isNaN(dateMs)) {
				return Math.max(0, dateMs - now);
			}
		}

		const resetMsMatch = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (resetMsMatch) {
			const resetMs = Number(resetMsMatch[1]);
			if (!Number.isNaN(resetMs)) {
				if (resetMs > 1_000_000_000_000) {
					return Math.max(0, resetMs - now);
				}
				return Math.max(0, resetMs);
			}
		}

		const resetMatch = /x-ratelimit-reset\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (resetMatch) {
			const resetSeconds = Number(resetMatch[1]);
			if (!Number.isNaN(resetSeconds)) {
				if (resetSeconds > 1_000_000_000) {
					return Math.max(0, resetSeconds * 1000 - now);
				}
				return Math.max(0, resetSeconds * 1000);
			}
		}

		// Smart Fallback if no exact headers found
		return undefined;
	}

	/**
	 * Handle retryable errors with exponential backoff.
	 * @returns true if retry was initiated, false if max retries exceeded or disabled
	 */
	async #handleRetryableError(message: AssistantMessage): Promise<boolean> {
		const retrySettings = this.settings.getGroup("retry");
		if (!retrySettings.enabled) return false;

		const generation = this.#promptGeneration;
		this.#retryAttempt++;

		// Create retry promise on first attempt so waitForRetry() can await it
		// Ensure only one promise exists (avoid orphaned promises from concurrent calls)
		if (!this.#retryPromise) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#retryPromise = promise;
			this.#retryResolve = resolve;
		}

		if (this.#retryAttempt > retrySettings.maxRetries) {
			// Max retries exceeded, emit final failure and reset
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt: this.#retryAttempt - 1,
				finalError: message.errorMessage,
			});
			this.#retryAttempt = 0;
			this.#resolveRetry(); // Resolve so waitForRetry() completes
			return false;
		}

		const errorMessage = message.errorMessage || "Unknown error";
		const parsedRetryAfterMs = this.#parseRetryAfterMsFromError(errorMessage);
		let delayMs = retrySettings.baseDelayMs * 2 ** (this.#retryAttempt - 1);
		let switchedCredential = false;
		let switchedModel = false;

		if (this.model && isUsageLimitError(errorMessage)) {
			const retryAfterMs = parsedRetryAfterMs ?? calculateRateLimitBackoffMs(parseRateLimitReason(errorMessage));
			const switched = await this.#modelRegistry.authStorage.markUsageLimitReached(
				this.model.provider,
				this.sessionId,
				{
					retryAfterMs,
					baseUrl: this.model.baseUrl,
				},
			);
			if (switched) {
				switchedCredential = true;
				delayMs = 0;
			} else if (retryAfterMs > delayMs) {
				// No more accounts to switch to — wait out the backoff
				delayMs = retryAfterMs;
			}
		}

		const currentSelector = this.model ? formatRetryFallbackSelector(this.model, this.thinkingLevel) : undefined;
		if (!switchedCredential && currentSelector) {
			this.#noteRetryFallbackCooldown(currentSelector, parsedRetryAfterMs, errorMessage);
			switchedModel = await this.#tryRetryModelFallback(currentSelector);
			if (switchedModel) {
				delayMs = 0;
			} else if (parsedRetryAfterMs && parsedRetryAfterMs > delayMs) {
				delayMs = parsedRetryAfterMs;
			}
		}

		await this.#emitSessionEvent({
			type: "auto_retry_start",
			attempt: this.#retryAttempt,
			maxAttempts: retrySettings.maxRetries,
			delayMs,
			errorMessage,
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.replaceMessages(messages.slice(0, -1));
		}

		// Wait with exponential backoff (abortable).
		const retryAbortController = new AbortController();
		this.#retryAbortController?.abort();
		this.#retryAbortController = retryAbortController;
		try {
			await abortableSleep(delayMs, retryAbortController.signal);
		} catch {
			if (this.#retryAbortController !== retryAbortController) {
				return false;
			}
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this.#retryAttempt;
			this.#retryAttempt = 0;
			this.#retryAbortController = undefined;
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this.#resolveRetry();
			return false;
		}
		if (this.#retryAbortController === retryAbortController) {
			this.#retryAbortController = undefined;
		}

		// Retry via continue() outside the agent_end event callback chain.
		this.#scheduleAgentContinue({ delayMs: 1, generation });

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this.#retryAbortController?.abort();
		// Note: _retryAttempt is reset in the catch block of _autoRetry
		this.#resolveRetry();
	}

	async #promptAgentWithIdleRetry(messages: AgentMessage[], options?: { toolChoice?: ToolChoice }): Promise<void> {
		const deadline = Date.now() + 30_000;
		for (;;) {
			try {
				await this.agent.prompt(messages, options);
				return;
			} catch (err) {
				if (!(err instanceof AgentBusyError)) {
					throw err;
				}
				if (Date.now() >= deadline) {
					throw new Error("Timed out waiting for prior agent run to finish before prompting.");
				}
				await this.agent.waitForIdle();
			}
		}
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this.#retryPromise !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settings.get("retry.enabled") ?? true;
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settings.set("retry.enabled", enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	async #saveBashOriginalArtifact(originalText: string): Promise<string | undefined> {
		try {
			return await this.sessionManager.saveArtifact(originalText, "bash-original");
		} catch {
			return undefined;
		}
	}

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<BashResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.sessionManager.getCwd();

		if (this.#extensionRunner?.hasHandlers("user_bash")) {
			const hookResult = await this.#extensionRunner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext,
				cwd,
			});
			if (hookResult?.result) {
				this.recordBashResult(command, hookResult.result, options);
				return hookResult.result;
			}
		}

		const abortController = new AbortController();
		this.#bashAbortControllers.add(abortController);

		try {
			const result = await executeBashCommand(command, {
				onChunk,
				signal: abortController.signal,
				sessionKey: this.sessionId,
				timeout: clampTimeout("bash") * 1000,
				onMinimizedSave: originalText => this.#saveBashOriginalArtifact(originalText),
			});

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this.#bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this.#pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.appendMessage(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of this.#bashAbortControllers) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this.#bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this.#pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	#flushPendingBashMessages(): void {
		if (this.#pendingBashMessages.length === 0) return;

		for (const bashMessage of this.#pendingBashMessages) {
			// Add to agent state
			this.agent.appendMessage(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this.#pendingBashMessages = [];
	}

	// =========================================================================
	// User-Initiated Python Execution
	// =========================================================================

	/**
	 * Execute Python code in the shared kernel.
	 * Uses the same kernel session as eval's Python backend, allowing collaborative editing.
	 * @param code The Python code to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, execution won't be sent to LLM ($$ prefix)
	 */
	async executePython(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<PythonResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.sessionManager.getCwd();
		this.assertEvalExecutionAllowed();

		const abortController = new AbortController();
		const execution = (async (): Promise<PythonResult> => {
			if (this.#extensionRunner?.hasHandlers("user_python")) {
				const hookResult = await this.#extensionRunner.emitUserPython({
					type: "user_python",
					code,
					excludeFromContext,
					cwd,
				});
				this.assertEvalExecutionAllowed();
				if (hookResult?.result) {
					this.recordPythonResult(code, hookResult.result, options);
					return hookResult.result;
				}
			}

			// Use the same session ID as eval's Python backend for kernel sharing
			const sessionFile = this.sessionManager.getSessionFile();
			const sessionId = sessionFile ? `session:${sessionFile}:cwd:${cwd}` : `cwd:${cwd}`;
			const result = await executePythonCommand(code, {
				cwd,
				sessionId,
				kernelOwnerId: this.#evalKernelOwnerId,
				kernelMode: this.settings.get("python.kernelMode"),
				useSharedGateway: this.settings.get("python.sharedGateway"),
				onChunk,
				signal: abortController.signal,
			});
			this.recordPythonResult(code, result, options);
			return result;
		})();
		return await this.trackEvalExecution(execution, abortController);
	}

	assertEvalExecutionAllowed(): void {
		if (this.#evalExecutionDisposing) {
			throw new Error("Python execution is unavailable while session disposal is in progress");
		}
	}

	/**
	 * Track Python work started outside AgentSession.executePython so dispose can await and abort it too.
	 */
	trackEvalExecution<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		this.#evalAbortControllers.add(abortController);
		this.#activeEvalExecutions.add(execution);
		void execution.then(
			() => {
				this.#evalAbortControllers.delete(abortController);
				this.#activeEvalExecutions.delete(execution);
			},
			() => {
				this.#evalAbortControllers.delete(abortController);
				this.#activeEvalExecutions.delete(execution);
			},
		);
		return execution;
	}

	/**
	 * Record a Python execution result in session history.
	 */
	recordPythonResult(code: string, result: PythonResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const pythonMessage: PythonExecutionMessage = {
			role: "pythonExecution",
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			this.#pendingPythonMessages.push(pythonMessage);
		} else {
			this.agent.appendMessage(pythonMessage);
			this.sessionManager.appendMessage(pythonMessage);
		}
	}

	/**
	 * Cancel running Python execution.
	 */
	abortEval(): void {
		for (const abortController of this.#evalAbortControllers) {
			abortController.abort();
		}
	}

	async #waitForEvalExecutionsToSettle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#activeEvalExecutions.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}
			const settled = await Promise.race([
				Promise.allSettled(Array.from(this.#activeEvalExecutions)).then(() => true),
				Bun.sleep(remainingMs).then(() => false),
			]);
			if (!settled && this.#activeEvalExecutions.size > 0) {
				return false;
			}
		}
		return true;
	}

	async #prepareEvalExecutionsForDispose(): Promise<boolean> {
		if (!(await this.#waitForEvalExecutionsToSettle(3_000))) {
			logger.warn("Aborting active Python execution during dispose before retained kernel cleanup");
			this.abortEval();
			if (!(await this.#waitForEvalExecutionsToSettle(1_000))) {
				logger.warn(
					"Python execution is still active after dispose aborted all active runs; retained kernel ownership will still be detached",
				);
				return false;
			}
		}
		return true;
	}

	/** Whether a Python execution is currently running */
	get isEvalRunning(): boolean {
		return this.#evalAbortControllers.size > 0;
	}

	/** Whether there are pending Python messages waiting to be flushed */
	get hasPendingPythonMessages(): boolean {
		return this.#pendingPythonMessages.length > 0;
	}

	/**
	 * Flush pending Python messages to agent state and session.
	 */
	#flushPendingPythonMessages(): void {
		if (this.#pendingPythonMessages.length === 0) return;

		for (const pythonMessage of this.#pendingPythonMessages) {
			this.agent.appendMessage(pythonMessage);
			this.sessionManager.appendMessage(pythonMessage);
		}

		this.#pendingPythonMessages = [];
	}

	// =========================================================================
	// Background-Channel IRC Exchanges
	// =========================================================================

	/**
	 * Generate an ephemeral reply to a background message (e.g. an IRC ping from
	 * another agent) using this session's current model + system prompt + history.
	 *
	 * The reply is computed via a side-channel `streamSimple` call (analogous to
	 * `/btw`) so it never blocks on the recipient's in-flight tool calls.  After
	 * the reply is generated, both the incoming question and the auto-reply are
	 * queued for injection into the recipient's persisted history so the model
	 * sees the exchange on its next turn.  Injection happens immediately when the
	 * session is idle, otherwise it is deferred until streaming ends.
	 */
	async respondAsBackground(args: {
		from: string;
		message: string;
		awaitReply?: boolean;
		signal?: AbortSignal;
	}): Promise<{ replyText: string | null }> {
		const awaitReply = args.awaitReply !== false;
		const incomingTimestamp = Date.now();
		const incomingRecord: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: `[IRC \`${args.from}\` \u2192 you]\n\n${args.message}`,
			display: true,
			details: { from: args.from, message: args.message },
			attribution: "agent",
			timestamp: incomingTimestamp,
		};
		void this.#emitSessionEvent({ type: "irc_message", message: incomingRecord });
		this.#forwardIrcRelayToMain({
			from: args.from,
			to: this.#agentId ?? "?",
			body: args.message,
			kind: "message",
			timestamp: incomingTimestamp,
		});

		if (!awaitReply) {
			this.#queueBackgroundExchangeInjection([incomingRecord]);
			return { replyText: null };
		}

		const incomingPrompt = prompt.render(ircIncomingTemplate, {
			from: args.from,
			message: args.message,
		});
		const { replyText } = await this.runEphemeralTurn({
			promptText: incomingPrompt,
			signal: args.signal,
		});

		const replyRecord: CustomMessage = {
			role: "custom",
			customType: "irc:autoreply",
			content: `[IRC you \u2192 \`${args.from}\` (auto)]\n\n${replyText}`,
			display: true,
			details: { to: args.from, reply: replyText },
			attribution: "agent",
			timestamp: Date.now(),
		};
		void this.#emitSessionEvent({ type: "irc_message", message: replyRecord });
		this.#forwardIrcRelayToMain({
			from: this.#agentId ?? "?",
			to: args.from,
			body: replyText,
			kind: "reply",
			timestamp: replyRecord.timestamp,
		});
		this.#queueBackgroundExchangeInjection([incomingRecord, replyRecord]);

		return { replyText };
	}

	/**
	 * Forward an IRC exchange observation to the main agent's session UI so the
	 * user can see every IRC conversation in the main transcript, even when the
	 * main agent is not a direct participant. The relay record is display-only:
	 * it is NOT injected into the main agent's persisted history.
	 */
	#forwardIrcRelayToMain(args: {
		from: string;
		to: string;
		body: string;
		kind: "message" | "reply";
		timestamp: number;
	}): void {
		const registry = this.#agentRegistry;
		if (!registry) return;
		// If this session is the main agent, the local emit already reached the main UI.
		if (this.#agentId === MAIN_AGENT_ID) return;
		const mainRef = registry.get(MAIN_AGENT_ID);
		const mainSession = mainRef?.session;
		if (!mainSession || mainSession === this) return;
		const arrow = args.kind === "reply" ? "\u2192 (auto)" : "\u2192";
		const relayRecord: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: `[IRC \`${args.from}\` ${arrow} \`${args.to}\`]\n\n${args.body}`,
			display: true,
			details: { from: args.from, to: args.to, body: args.body, kind: args.kind },
			attribution: "agent",
			timestamp: args.timestamp,
		};
		mainSession.emitIrcRelayObservation(relayRecord);
	}

	/**
	 * Emit an IRC relay observation event on this session for UI rendering only.
	 * Does not persist the record to history. Public so other sessions can forward.
	 */
	emitIrcRelayObservation(record: CustomMessage): void {
		void this.#emitSessionEvent({ type: "irc_message", message: record });
	}

	/**
	 * Run a single ephemeral side-channel turn against this session's current
	 * model + system prompt + history.  No tools are used; the side request
	 * does not block on, or interfere with, any in-flight main turn.  The
	 * session's history and persisted state are NOT modified by this call.
	 *
	 * Used by `respondAsBackground` (IRC) and `BtwController` (`/btw`) to share
	 * the snapshot + stream pipeline.  The snapshot includes any in-flight
	 * streaming assistant text so the model sees the half-finished response
	 * rather than missing context.
	 */
	async runEphemeralTurn(args: {
		promptText: string;
		onTextDelta?: (delta: string) => void;
		signal?: AbortSignal;
	}): Promise<{ replyText: string; assistantMessage: AssistantMessage }> {
		const model = this.model;
		if (!model) {
			throw new Error("No active model on session");
		}
		const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
		if (!apiKey) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const snapshot = this.#buildEphemeralSnapshot(args.promptText);
		const llmMessages = await this.convertMessagesToLlm(snapshot, args.signal);
		const context: Context = {
			systemPrompt: this.systemPrompt,
			messages: llmMessages,
		};
		const options = this.prepareSimpleStreamOptions({
			apiKey,
			sessionId: this.sessionId,
			reasoning: toReasoningEffort(this.thinkingLevel),
			serviceTier: this.serviceTier,
			signal: args.signal,
			toolChoice: "none",
		});

		let replyText = "";
		let assistantMessage: AssistantMessage | undefined;
		const stream = streamSimple(model, context, options);
		for await (const event of stream) {
			if (event.type === "text_delta") {
				replyText += event.delta;
				if (args.onTextDelta) args.onTextDelta(event.delta);
				continue;
			}
			if (event.type === "done") {
				assistantMessage = event.message;
				break;
			}
			if (event.type === "error") {
				throw new Error(event.error.errorMessage || "Ephemeral turn failed");
			}
		}

		if (!assistantMessage) {
			throw new Error("Ephemeral turn ended without a final message");
		}
		return { replyText: replyText.trim(), assistantMessage };
	}

	/**
	 * Build a message snapshot for an ephemeral side-channel turn.  Includes
	 * the in-flight streaming assistant message (if any) so the model sees
	 * the partial response in context, then appends the prompt as a virtual
	 * user message.
	 */
	#buildEphemeralSnapshot(promptText: string): AgentMessage[] {
		const messages = [...this.messages];
		const streaming = this.agent.state.streamMessage;
		if (streaming && streaming.role === "assistant") {
			const streamingText = streaming.content
				.filter((c): c is TextContent => c.type === "text")
				.map(c => c.text)
				.join("");
			if (streamingText) {
				const normalized: AssistantMessage = {
					...streaming,
					content: [{ type: "text", text: streamingText }],
				};
				const lastMessage = messages.at(-1);
				if (lastMessage?.role === "assistant") {
					messages[messages.length - 1] = normalized;
				} else {
					messages.push(normalized);
				}
			}
		}
		messages.push({
			role: "user",
			content: [{ type: "text", text: promptText }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		return messages;
	}

	#queueBackgroundExchangeInjection(messages: CustomMessage[]): void {
		this.#pendingBackgroundExchanges.push(messages);
		if (!this.isStreaming) {
			this.#flushPendingBackgroundExchanges();
			return;
		}
		this.#scheduleBackgroundExchangeFlush();
	}

	#scheduleBackgroundExchangeFlush(): void {
		if (this.#scheduledBackgroundExchangeFlush) return;
		this.#scheduledBackgroundExchangeFlush = true;
		const attempt = (): void => {
			if (this.#pendingBackgroundExchanges.length === 0) {
				this.#scheduledBackgroundExchangeFlush = false;
				return;
			}
			if (this.isStreaming) {
				setTimeout(attempt, 50);
				return;
			}
			this.#scheduledBackgroundExchangeFlush = false;
			this.#flushPendingBackgroundExchanges();
		};
		setTimeout(attempt, 0);
	}

	#flushPendingBackgroundExchanges(): void {
		if (this.#pendingBackgroundExchanges.length === 0) return;
		const batches = this.#pendingBackgroundExchanges;
		this.#pendingBackgroundExchanges = [];
		for (const batch of batches) {
			for (const msg of batch) {
				// emitExternalEvent on message_end appends to agent state and dispatches
				// to all session listeners, which in turn handle TUI rendering and
				// sessionManager persistence via #handleAgentEvent.
				this.agent.emitExternalEvent({ type: "message_start", message: msg });
				this.agent.emitExternalEvent({ type: "message_end", message: msg });
			}
		}
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Reload the current session from disk.
	 *
	 * Intended for extension commands and headless modes to re-read the current session
	 * file and re-emit session_switch hooks.
	 */
	async reload(): Promise<void> {
		const sessionFile = this.sessionFile;
		if (!sessionFile) return;
		await this.switchSession(sessionFile);
	}

	/**
	 * Switch to a different session file.
	 * Aborts current operation, loads messages, restores model/thinking.
	 * Listeners are preserved and will continue receiving events.
	 * @returns true if switch completed, false if cancelled by hook
	 */
	async switchSession(sessionPath: string): Promise<boolean> {
		const previousSessionFile = this.sessionManager.getSessionFile();
		const switchingToDifferentSession = previousSessionFile
			? path.resolve(previousSessionFile) !== path.resolve(sessionPath)
			: true;
		// Emit session_before_switch event (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "resume",
				targetSessionFile: sessionPath,
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		this.#disconnectFromAgent();
		await this.abort();

		// Flush pending writes before switching so restore snapshots reflect committed state.
		await this.sessionManager.flush();
		const previousSessionState = this.sessionManager.captureState();
		const previousSessionContext = this.buildDisplaySessionContext();
		// switchSession replaces these arrays wholesale during load/rollback, so retaining
		// the existing message objects is sufficient and avoids structured-clone failures for
		// extension/custom metadata that is valid to persist but not cloneable.
		const previousAgentMessages = [...this.agent.state.messages];
		const previousSteeringMessages = [...this.#steeringMessages];
		const previousFollowUpMessages = [...this.#followUpMessages];
		const previousPendingNextTurnMessages = [...this.#pendingNextTurnMessages];
		const previousScheduledHiddenNextTurnGeneration = this.#scheduledHiddenNextTurnGeneration;
		const previousModel = this.model;
		const previousThinkingLevel = this.#thinkingLevel;
		const previousServiceTier = this.agent.serviceTier;
		const previousSelectedMCPToolNames = new Set(this.#selectedMCPToolNames);
		const previousTools = [...this.agent.state.tools];
		const previousBaseSystemPrompt = this.#baseSystemPrompt;
		const previousSystemPrompt = this.agent.state.systemPrompt;
		const previousFallbackSelectedMCPToolNames = previousSessionFile
			? this.#getSessionDefaultSelectedMCPToolNames(previousSessionFile)
			: undefined;

		this.#steeringMessages = [];
		this.#followUpMessages = [];
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		try {
			await this.sessionManager.setSessionFile(sessionPath);
			this.agent.sessionId = this.sessionManager.getSessionId();

			const sessionContext = this.buildDisplaySessionContext();
			const didReloadConversationChange =
				!switchingToDifferentSession &&
				this.#didSessionMessagesChange(previousSessionContext.messages, sessionContext.messages);
			const fallbackSelectedMCPToolNames = this.#getSessionDefaultSelectedMCPToolNames(sessionPath);
			await this.#restoreMCPSelectionsForSessionContext(sessionContext, { fallbackSelectedMCPToolNames });

			// Emit session_switch event to hooks
			if (this.#extensionRunner) {
				await this.#extensionRunner.emit({
					type: "session_switch",
					reason: "resume",
					previousSessionFile,
				});
			}

			this.agent.replaceMessages(sessionContext.messages);
			this.#syncTodoPhasesFromBranch();
			if (switchingToDifferentSession) {
				this.#closeAllProviderSessions("session switch");
			} else if (didReloadConversationChange) {
				this.#closeAllProviderSessions("session reload");
			}

			// Restore model if saved
			const defaultModelStr = sessionContext.models.default;
			if (defaultModelStr) {
				const slashIdx = defaultModelStr.indexOf("/");
				if (slashIdx > 0) {
					const provider = defaultModelStr.slice(0, slashIdx);
					const modelId = defaultModelStr.slice(slashIdx + 1);
					const availableModels = this.#modelRegistry.getAvailable();
					const match = availableModels.find(m => m.provider === provider && m.id === modelId);
					if (match) {
						const currentModel = this.model;
						const shouldResetProviderState =
							switchingToDifferentSession ||
							(currentModel !== undefined &&
								(currentModel.provider !== match.provider ||
									currentModel.id !== match.id ||
									currentModel.api !== match.api));
						if (shouldResetProviderState) {
							this.#setModelWithProviderSessionReset(match);
						} else {
							this.agent.setModel(match);
						}
					}
				}
			}

			const hasThinkingEntry = this.sessionManager.getBranch().some(entry => entry.type === "thinking_level_change");
			const hasServiceTierEntry = this.sessionManager
				.getBranch()
				.some(entry => entry.type === "service_tier_change");
			const defaultThinkingLevel = this.settings.get("defaultThinkingLevel");
			const configuredServiceTier = this.settings.get("serviceTier");
			const nextThinkingLevel = resolveThinkingLevelForModel(
				this.model,
				hasThinkingEntry ? (sessionContext.thinkingLevel as ThinkingLevel | undefined) : defaultThinkingLevel,
			);
			this.#thinkingLevel = nextThinkingLevel;
			this.agent.setThinkingLevel(toReasoningEffort(nextThinkingLevel));
			this.agent.serviceTier = hasServiceTierEntry
				? sessionContext.serviceTier
				: configuredServiceTier === "none"
					? undefined
					: configuredServiceTier;

			this.#reconnectToAgent();
			return true;
		} catch (error) {
			this.sessionManager.restoreState(previousSessionState);
			this.agent.sessionId = previousSessionState.sessionId;
			let restoreMcpError: unknown;
			try {
				await this.#restoreMCPSelectionsForSessionContext(previousSessionContext, {
					fallbackSelectedMCPToolNames: previousFallbackSelectedMCPToolNames,
				});
			} catch (mcpError) {
				restoreMcpError = mcpError;
				logger.warn("Failed to restore MCP selections after switch error", {
					previousSessionFile,
					targetSessionFile: sessionPath,
					error: String(mcpError),
				});
				this.#selectedMCPToolNames = new Set(previousSelectedMCPToolNames);
				this.agent.setTools(previousTools);
				this.#baseSystemPrompt = previousBaseSystemPrompt;
				this.agent.setSystemPrompt(previousSystemPrompt);
			}
			this.#baseSystemPrompt = previousBaseSystemPrompt;
			this.agent.setSystemPrompt(previousSystemPrompt);
			this.agent.replaceMessages(previousAgentMessages);
			this.#steeringMessages = previousSteeringMessages;
			this.#followUpMessages = previousFollowUpMessages;
			this.#pendingNextTurnMessages = previousPendingNextTurnMessages;
			this.#scheduledHiddenNextTurnGeneration = previousScheduledHiddenNextTurnGeneration;
			if (previousModel) {
				this.agent.setModel(previousModel);
			}
			this.#thinkingLevel = previousThinkingLevel;
			this.agent.setThinkingLevel(toReasoningEffort(previousThinkingLevel));
			this.agent.serviceTier = previousServiceTier;
			this.#syncTodoPhasesFromBranch();
			this.#reconnectToAgent();
			if (restoreMcpError) {
				throw restoreMcpError;
			}
			throw error;
		}
	}

	/**
	 * Create a branch from a specific entry.
	 * Emits before_branch/branch session events to hooks.
	 *
	 * @param entryId ID of the entry to branch from
	 * @returns Object with:
	 *   - selectedText: The text of the selected user message (for editor pre-fill)
	 *   - cancelled: True if a hook cancelled the branch
	 */
	async branch(entryId: string): Promise<{
		selectedText: string;
		cancelled: boolean;
	}> {
		const previousSessionFile = this.sessionFile;
		const selectedEntry = this.sessionManager.getEntry(entryId);

		if (!selectedEntry || selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
			throw new Error("Invalid entry ID for branching");
		}

		const selectedText = this.#extractUserMessageText(selectedEntry.message.content);

		let skipConversationRestore = false;

		// Emit session_before_branch event (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_branch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_branch",
				entryId,
			})) as SessionBeforeBranchResult | undefined;

			if (result?.cancel) {
				return { selectedText, cancelled: true };
			}
			skipConversationRestore = result?.skipConversationRestore ?? false;
		}

		// Clear pending messages (bound to old session state)
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		// Flush pending writes before branching
		await this.sessionManager.flush();
		this.#asyncJobManager?.cancelAll();

		if (!selectedEntry.parentId) {
			await this.sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			this.sessionManager.createBranchedSession(selectedEntry.parentId);
		}
		this.#syncTodoPhasesFromBranch();
		this.agent.sessionId = this.sessionManager.getSessionId();

		// Reload messages from entries (works for both file and in-memory mode)
		const sessionContext = this.buildDisplaySessionContext();

		await this.#restoreMCPSelectionsForSessionContext(sessionContext);

		// Emit session_branch event to hooks (after branch completes)
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_branch",
				previousSessionFile,
			});
		}

		if (!skipConversationRestore) {
			this.agent.replaceMessages(sessionContext.messages);
			this.#closeCodexProviderSessionsForHistoryRewrite();
		}

		return { selectedText, cancelled: false };
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike branch() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string } = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
		/** Raw session context built during navigation — pass to renderInitialMessages to skip a second O(N) walk. */
		sessionContext?: SessionContext;
	}> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data
		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
		};

		// Set up abort controller for summarization
		this.#branchSummaryAbortController = new AbortController();
		let hookSummary: { summary: string; details?: unknown } | undefined;
		let fromExtension = false;

		// Emit session_before_tree event
		if (this.#extensionRunner?.hasHandlers("session_before_tree")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_tree",
				preparation,
				signal: this.#branchSummaryAbortController.signal,
			})) as SessionBeforeTreeResult | undefined;

			if (result?.cancel) {
				return { cancelled: true };
			}

			if (result?.summary && options.summarize) {
				hookSummary = result.summary;
				fromExtension = true;
			}
		}

		// Run default summarizer if needed
		let summaryText: string | undefined;
		let summaryDetails: unknown;
		if (options.summarize && entriesToSummarize.length > 0 && !hookSummary) {
			const model = this.model!;
			const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
			if (!apiKey) {
				throw new Error(`No API key for ${model.provider}`);
			}
			const branchSummarySettings = this.settings.getGroup("branchSummary");
			const result = await generateBranchSummary(entriesToSummarize, {
				model,
				apiKey,
				signal: this.#branchSummaryAbortController.signal,
				customInstructions: options.customInstructions,
				reserveTokens: branchSummarySettings.reserveTokens,
			});
			this.#branchSummaryAbortController = undefined;
			if (result.aborted) {
				return { cancelled: true, aborted: true };
			}
			if (result.error) {
				throw new Error(result.error);
			}
			summaryText = result.summary;
			summaryDetails = {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			};
		} else if (hookSummary) {
			summaryText = hookSummary.summary;
			summaryDetails = hookSummary.details;
		}

		// Determine the new leaf position based on target type
		let newLeafId: string | null;
		let editorText: string | undefined;

		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			// User message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText = this.#extractUserMessageText(targetEntry.message.content);
		} else if (targetEntry.type === "custom_message") {
			// Custom message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText =
				typeof targetEntry.content === "string"
					? targetEntry.content
					: targetEntry.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text)
							.join("");
		} else {
			// Non-user message: leaf = selected node
			newLeafId = targetId;
		}

		// Switch leaf (with or without summary)
		// Summary is attached at the navigation target position (newLeafId), not the old branch
		let summaryEntry: BranchSummaryEntry | undefined;
		if (summaryText) {
			// Create summary at target position (can be null for root)
			const summaryId = this.sessionManager.branchWithSummary(newLeafId, summaryText, summaryDetails, fromExtension);
			summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;
		} else if (newLeafId === null) {
			// No summary, navigating to root - reset leaf
			this.sessionManager.resetLeaf();
		} else {
			// No summary, navigating to non-root
			this.sessionManager.branch(newLeafId);
		}

		// Update agent state — build display context to populate agent messages.
		const stateContext = this.sessionManager.buildSessionContext();
		const displayContext = deobfuscateSessionContext(stateContext, this.#obfuscator);
		await this.#restoreMCPSelectionsForSessionContext(displayContext);
		this.agent.replaceMessages(displayContext.messages);
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();

		this.#branchSummaryAbortController = undefined;

		// Emit session_tree event; only handlers can mutate session entries, so skip
		// the emit and the context rebuild when no handlers are registered (mirrors
		// the session_before_tree guard above).
		if (this.#extensionRunner?.hasHandlers("session_tree")) {
			await this.#extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});
			const rawContext = this.sessionManager.buildSessionContext();
			return { editorText, cancelled: false, summaryEntry, sessionContext: rawContext };
		}
		return { editorText, cancelled: false, summaryEntry, sessionContext: stateContext };
	}

	/**
	 * Get all user messages from session for branch selector.
	 */
	getUserMessagesForBranching(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this.#extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	#extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics.
	 */
	getSessionStats(): SessionStats {
		const state = this.state;
		const userMessages = state.messages.filter(m => m.role === "user").length;
		const assistantMessages = state.messages.filter(m => m.role === "assistant").length;
		const toolResults = state.messages.filter(m => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		let totalPremiumRequests = 0;
		const getTaskToolUsage = (details: unknown): Usage | undefined => {
			if (!details || typeof details !== "object") return undefined;
			const record = details as Record<string, unknown>;
			const usage = record.usage;
			if (!usage || typeof usage !== "object") return undefined;
			return usage as Usage;
		};

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter(c => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalPremiumRequests += assistantMsg.usage.premiumRequests ?? 0;
				totalCost += assistantMsg.usage.cost.total;
			}

			if (message.role === "toolResult" && message.toolName === "task") {
				const usage = getTaskToolUsage(message.details);
				if (usage) {
					totalInput += usage.input;
					totalOutput += usage.output;
					totalCacheRead += usage.cacheRead;
					totalCacheWrite += usage.cacheWrite;
					totalPremiumRequests += usage.premiumRequests ?? 0;
					totalCost += usage.cost.total;
				}
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			premiumRequests: totalPremiumRequests,
		};
	}

	/**
	 * Get current context usage statistics.
	 * Uses the last assistant message's usage data when available,
	 * otherwise estimates tokens for all messages.
	 */
	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
						}
						break;
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = this.#estimateContextTokens();
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	async fetchUsageReports(): Promise<UsageReport[] | null> {
		const authStorage = this.#modelRegistry.authStorage;
		if (!authStorage.fetchUsageReports) return null;
		return authStorage.fetchUsageReports({
			baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
		});
	}

	/**
	 * Estimate context tokens from messages, using the last assistant usage when available.
	 */
	#estimateContextTokens(): {
		tokens: number;
	} {
		const messages = this.messages;

		// Find last assistant message with usage
		let lastUsageIndex: number | null = null;
		let lastUsage: Usage | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				const assistantMsg = msg as AssistantMessage;
				if (assistantMsg.usage) {
					lastUsage = assistantMsg.usage;
					lastUsageIndex = i;
					break;
				}
			}
		}

		if (!lastUsage || lastUsageIndex === null) {
			// No usage data - estimate all messages
			let estimated = 0;
			for (const message of messages) {
				estimated += estimateTokens(message);
			}
			return {
				tokens: estimated,
			};
		}

		const usageTokens = calculatePromptTokens(lastUsage);
		let trailingTokens = 0;
		for (let i = lastUsageIndex + 1; i < messages.length; i++) {
			trailingTokens += estimateTokens(messages[i]);
		}

		return {
			tokens: usageTokens + trailingTokens,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const themeName = getCurrentThemeName();
		return exportSessionToHtml(this.sessionManager, this.state, { outputPath, themeName });
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find(m => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	/**
	 * Format the entire session as plain text for clipboard export.
	 * Includes user messages, assistant text, thinking blocks, tool calls, and tool results.
	 */
	formatSessionAsText(): string {
		return formatSessionDumpText({
			messages: this.messages,
			systemPrompt: this.agent.state.systemPrompt,
			model: this.agent.state.model,
			thinkingLevel: this.#thinkingLevel,
			tools: this.agent.state.tools,
		});
	}

	/**
	 * Format the conversation as compact context for subagents.
	 * Includes only user messages and assistant text responses.
	 * Excludes: system prompt, tool definitions, tool calls/results, thinking blocks.
	 */
	formatCompactContext(): string {
		const lines: string[] = [];
		lines.push("# Conversation Context");
		lines.push("");
		lines.push(
			"This is a summary of the parent conversation. Read this if you need additional context about what was discussed or decided.",
		);
		lines.push("");

		for (const msg of this.messages) {
			if (msg.role === "user" || msg.role === "developer") {
				lines.push(msg.role === "developer" ? "## Developer" : "## User");
				lines.push("");
				if (typeof msg.content === "string") {
					lines.push(msg.content);
				} else {
					for (const c of msg.content) {
						if (c.type === "text") {
							lines.push(c.text);
						} else if (c.type === "image") {
							lines.push("[Image attached]");
						}
					}
				}
				lines.push("");
			} else if (msg.role === "assistant") {
				const assistantMsg = msg as AssistantMessage;
				// Only include text content, skip tool calls and thinking
				const textParts: string[] = [];
				for (const c of assistantMsg.content) {
					if (c.type === "text" && c.text.trim()) {
						textParts.push(c.text);
					}
				}
				if (textParts.length > 0) {
					lines.push("## Assistant");
					lines.push("");
					lines.push(textParts.join("\n\n"));
					lines.push("");
				}
			} else if (msg.role === "fileMention") {
				const fileMsg = msg as FileMentionMessage;
				const paths = fileMsg.files.map(f => f.path).join(", ");
				lines.push(`[Files referenced: ${paths}]`);
				lines.push("");
			} else if (msg.role === "compactionSummary") {
				const compactMsg = msg as CompactionSummaryMessage;
				lines.push("## Earlier Context (Summarized)");
				lines.push("");
				lines.push(compactMsg.summary);
				lines.push("");
			}
			// Skip: toolResult, bashExecution, pythonExecution, branchSummary, custom, hookMessage
		}

		return lines.join("\n").trim();
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this.#extensionRunner?.hasHandlers(eventType) ?? false;
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner | undefined {
		return this.#extensionRunner;
	}
}
