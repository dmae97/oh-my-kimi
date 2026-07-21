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

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	repairTranscriptIntegrity,
	type ThinkingLevel,
} from "omk-agent-core";
import type { Api, AssistantMessage, ImageContent, Message, Model, TextContent, ToolResultMessage } from "omk-ai";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	modelsAreEqual,
	resetApiProviders,
	streamSimple,
} from "omk-ai";
import type { ReplayLedgerManager } from "../guardrails/evidence-system.ts";
import { theme } from "../modes/interactive/theme/theme.ts";
import type { ReplayEventType } from "../types/evidence.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import { sleep } from "../utils/sleep.ts";
import { type AdaptorchBridge, type AdaptorchConsultPayload, createAdaptorchBridge } from "./adaptorch-bridge.ts";
import {
	applyCategoryTimeoutDefaults,
	resolveAgentToolSettings,
	resolveToolTimeoutCategory,
} from "./agent-tool-settings.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { parseBangInvocation } from "./bang-skill-invocation.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import { classifyShellCommand } from "./command-safety.ts";
import { type CompactionSettings, getCompactionHeadroomThreshold } from "./compaction/compaction.ts";
import {
	type CompactionHysteresisState,
	createCompactionHysteresisConfig,
	createCompactionHysteresisState,
	stepCompactionHysteresis,
} from "./compaction/hysteresis.ts";
import {
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateProjectedContextTokens,
	generateBranchSummary,
	prepareCompaction,
	resolveCompactionModel,
} from "./compaction/index.ts";
import { compactionEmitWillRetry } from "./compaction/resume-policy.ts";
import {
	type CompactionBarrierResult,
	type CompactionEnvelope,
	type CompactionPreservedProvenanceInput,
	type CompactionSourceIdentity,
	type CompactionTransaction,
	createCompactionEnvelope,
	createCompactionSourceIdentity,
	createCompactionTransaction,
	decideCompactionCommit,
	evaluateCompactionBarrier,
	validateCompactionEnvelope,
} from "./compaction/transaction.ts";
import {
	estimateToolResultReserve,
	type ToolResultClass,
	type ToolResultReserveRequest,
} from "./context-budget-reserved-tokens.ts";
import {
	applyContextCacheInvalidation,
	type ContextCacheInvalidationEvent,
	type ContextCacheInvalidationSnapshot,
	createContextCacheInvalidationSnapshot,
} from "./context-budget-v2-cache-invalidation.ts";
import { createMemoryContextBudgetCacheProviderV2 } from "./context-budget-v2-cache-provider.ts";
import type { ContextBudgetCacheProviderV2 } from "./context-budget-v2-types.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	buildBlockedBashResult,
	evaluateCommandGate,
	isCommandSafetyAssumeYesEnabled,
} from "./extensions/builtin/command-safety-gate.ts";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { assertTextChatModelForCompletion } from "./grok-harness.ts";
import { grokPlaybookAppendForProvider } from "./grok-playbook.ts";
import { assertLoadoutAccess, decideLoadoutAccess, type LoadoutAccessPolicy } from "./loadout-access-policy.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { findExactModelReferenceMatch } from "./model-resolver.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import {
	isContentSafetyStopMessage,
	isStickySafetyModel,
	isTransientProviderErrorMessage,
	pickFailoverCandidate,
	resolveProviderResilience,
	stickySafetyBlockMessage,
} from "./provider-resilience.ts";
import {
	getBiasStepsForCell,
	getDefaultRouterBiasSnapshotPath,
	parseRouterBiasSnapshot,
	type RouterBiasSnapshot,
} from "./reasoning-router-bias.ts";
import { classifyTaskV4, resolveThinkingLevelV4WithUncertainty, type TaskClassV4 } from "./reasoning-router-v4.ts";
import { redactSensitiveText } from "./redaction.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import {
	appendRouterFeedbackRecord,
	type RouterFeedbackLenBucket,
	type RouterFeedbackRecord,
} from "./router-feedback-collector.ts";
import type { RunJournalAuditDetails, RunJournalAuditEvent, RunJournalRecord } from "./run-journal.ts";
import { type RunJournalQuarantineReport, RunJournalStore } from "./run-journal-store.ts";
import { detectSandboxBackend } from "./sandbox/backend.ts";
import type { SandboxBackendStatus } from "./sandbox/policy.ts";
import type { SessionIntegrityReport } from "./session-integrity.ts";
import { inspectSessionIntegrity } from "./session-integrity.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionManager } from "./session-manager.ts";
import { CURRENT_SESSION_VERSION, getLatestCompactionEntry, type SessionHeader } from "./session-manager.ts";
import {
	classifySessionTermination,
	type SessionProcessSignal,
	type SessionTermination,
	type SessionTerminationCause,
} from "./session-termination.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { type BashOperations, type BashSandboxPreflight, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/**
 * Thinking mode: "manual" keeps the user-selected level; "auto" resolves the
 * level per turn via the reasoning router. Manual `/think <level>` always wins
 * because the router only runs in auto mode.
 */
export type ThinkingMode = "manual" | "auto";

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "session_termination"; termination: SessionTermination }
	| {
			/**
			 * A late-settling potentially-writing tool may have mutated the
			 * workspace after its terminal result was committed. Evidence
			 * freshness consumers must treat affected scopes as stale
			 * (empty `paths` means the whole workspace root).
			 */
			type: "workspace_mutation";
			source: "tool_late_settlement";
			toolCallId: string;
			toolName: string;
			payload: { root: string; paths: readonly string[] };
	  };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for skills, prompts, themes, context files, system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Trusted sandbox preflight used for built-in local bash execution. Never sourced from RPC command payloads. */
	bashSandboxPreflight?: BashSandboxPreflight;
	/** Optional immutable loadout policy used to lock active tools and scope built-in tool access. */
	loadoutAccessPolicy?: LoadoutAccessPolicy;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Transcript repair applied by the SDK while opening/resuming this session (ALG001-A). */
	transcriptRepair?: SessionTranscriptRepair;
	/** Optional shared replay ledger used by evidence receipts and runtime mutation audits. */
	replayLedger?: ReplayLedgerManager;
	/** Goal binding for replay events. Defaults to the ledger's own goal id. */
	replayGoalId?: string;
	/** Optional lane binding for replay events. */
	replayLaneId?: string;
}

/** Summary of a missing-only transcript auto-repair applied on session open/resume. */
export interface SessionTranscriptRepair {
	readonly insertedToolCallIds: readonly string[];
	readonly reason: "resume";
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

interface ExecuteBashOptions {
	excludeFromContext?: boolean;
	operations?: BashOperations;
	safetyGate?: "headless";
	/** Trusted internal/test override for local bash sandboxing. */
	sandboxPolicy?: BashSandboxPreflight;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	activeSkillNames?: readonly string[];
	activeSkillSource?: string;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
}

function mergePromptActiveSkillNames(first: readonly string[], second: readonly string[]): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const name of [...first, ...second]) {
		if (!seen.has(name)) {
			seen.add(name);
			names.push(name);
		}
	}
	return names;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
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
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

interface CapturedCompactionState {
	readonly report: SessionIntegrityReport;
	readonly branchEntries: readonly SessionEntry[];
	readonly revision: CompactionTransaction["baseRevision"];
	readonly source: CompactionSourceIdentity;
}

interface BegunCompaction {
	readonly capture: CapturedCompactionState;
	readonly transaction: CompactionTransaction;
}

interface CommittedCompaction {
	readonly entry: CompactionEntry;
	readonly envelope: CompactionEnvelope;
}

const PENDING_TOOL_RESULT_TOKENS = {
	text: 1024,
	image: 4096,
	"large-output": 16_384,
} as const satisfies Record<ToolResultClass, number>;

const TEXT_RESULT_TOOLS = new Set(["edit", "find", "grep", "ls", "read", "write"]);
const IMAGE_PATH_PATTERN = /\.(?:avif|gif|jpe?g|png|webp)$/iu;

function pendingToolResultClass(name: string, args: unknown): ToolResultClass {
	if (
		name === "read" &&
		typeof args === "object" &&
		args !== null &&
		typeof Reflect.get(args, "path") === "string" &&
		IMAGE_PATH_PATTERN.test(Reflect.get(args, "path"))
	) {
		return "image";
	}
	return TEXT_RESULT_TOOLS.has(name) ? "text" : "large-output";
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

function normalizeToolNames(toolNames: readonly string[]): string[] {
	return [...new Set(toolNames.map((name) => name.trim()).filter((name) => name !== ""))].sort();
}

function toolNameSetsEqual(left: readonly string[], right: readonly string[]): boolean {
	const normalizedLeft = normalizeToolNames(left);
	const normalizedRight = normalizeToolNames(right);
	return (
		normalizedLeft.length === normalizedRight.length &&
		normalizedLeft.every((toolName, index) => toolName === normalizedRight[index])
	);
}

function isSandboxDeniedError(error: unknown): error is Error {
	return error instanceof Error && error.message.startsWith("sandbox: shell denied");
}

function buildSandboxDeniedBashResult(reason: string): BashResult {
	return {
		output: reason,
		exitCode: 1,
		cancelled: false,
		truncated: false,
	};
}
function snapshotContractError(reason: string): Error {
	return new Error(`Finalized message replacement must be a plain serializable snapshot: ${reason}`);
}

/**
 * Clone a finalized message replacement into the JSON-compatible snapshot
 * persisted by SessionManager. Undefined remains allowed as ordinary optional
 * message data: JSON omits object properties with undefined values and writes
 * undefined array elements as null.
 */
function clonePlainSnapshot(
	value: unknown,
	ancestors = new WeakSet<object>(),
	copies = new WeakMap<object, unknown>(),
): unknown {
	if (value === null) return value;

	switch (typeof value) {
		case "string":
		case "boolean":
		case "undefined":
			return value;
		case "number":
			if (!Number.isFinite(value)) {
				throw snapshotContractError("non-finite number values are not allowed");
			}
			return value;
		case "bigint":
			throw snapshotContractError("bigint values are not allowed");
		case "function":
		case "symbol":
			throw snapshotContractError(`${typeof value} values are not allowed`);
		case "object":
			break;
		default:
			throw snapshotContractError(`${typeof value} values are not allowed`);
	}

	if (ancestors.has(value)) {
		throw snapshotContractError("cyclic values are not allowed");
	}
	if (copies.has(value)) {
		return copies.get(value);
	}
	ancestors.add(value);

	try {
		if (Array.isArray(value)) {
			const copy: unknown[] = new Array(value.length);
			copies.set(value, copy);
			for (const key of Reflect.ownKeys(value)) {
				if (key === "length") continue;
				if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
					throw snapshotContractError("arrays may only contain indexed values");
				}
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
					throw snapshotContractError("accessor or non-enumerable properties are not allowed");
				}
				copy[Number(key)] = clonePlainSnapshot(descriptor.value, ancestors, copies);
			}
			return copy;
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw snapshotContractError("non-plain objects are not allowed");
		}

		const copy = Object.create(prototype) as Record<string, unknown>;
		copies.set(value, copy);
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") {
				throw snapshotContractError("symbol-keyed properties are not allowed");
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				throw snapshotContractError("accessor or non-enumerable properties are not allowed");
			}
			Object.defineProperty(copy, key, {
				value: clonePlainSnapshot(descriptor.value, ancestors, copies),
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		return copy;
	} finally {
		ancestors.delete(value);
	}
}

function freezeSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
	if (value === null || typeof value !== "object" || seen.has(value)) return value;
	seen.add(value);
	for (const child of Object.values(value as Record<string, unknown>)) {
		freezeSnapshot(child, seen);
	}
	return Object.freeze(value);
}

function createImmutableMessageSnapshot(message: AgentMessage): AgentMessage {
	return freezeSnapshot(clonePlainSnapshot(message) as AgentMessage);
}

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Thinking mode (default "manual"). Persists across turns within the session;
	 * auto-resolved levels are never written to the user's persisted settings.
	 */
	private _thinkingMode: ThinkingMode = "manual";

	/**
	 * N=8 ring buffer of recent auto-turn task classes (newest first), feeding
	 * v4's multi-turn prior feature. Never persisted to settings.
	 */
	private _taskClassHistory: TaskClassV4[] = [];

	/**
	 * Compiled reasoning-router bias snapshot for the opt-in v4 learning path
	 * (Goal 010 Lane I). Loaded at most once per session and pinned thereafter:
	 * `_reasoningRouterBiasSnapshotLoaded` flips to `true` on the first v4
	 * auto-turn that has learning enabled, and `_reasoningRouterBiasSnapshot`
	 * then stays fixed for the rest of the session (even across later settings
	 * reloads, and even if the on-disk file changes or the load failed/was
	 * invalid, in which case it stays `null`). See `_getReasoningRouterBiasSnapshot`.
	 */
	private _reasoningRouterBiasSnapshot: RouterBiasSnapshot | null = null;
	private _reasoningRouterBiasSnapshotLoaded = false;

	/**
	 * AdaptOrch advisory bridge (default-off, global-only opt-in via
	 * `adaptorchBridge.enabled` in ~/.omk/agent/settings.json). Lazily
	 * constructed on the first v4 auto-turn when enabled; stays `null`
	 * otherwise. The bridge is advisory-only: its hint is fused into the
	 * resolver as a bounded ±2 step nudge, never as an override.
	 */
	private _adaptorchBridge: AdaptorchBridge | null = null;
	private _adaptorchBridgeInitAttempted = false;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _messageEndReplacements = new WeakMap<Extract<AgentEvent, { type: "message_end" }>, AgentMessage>();

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;
	private _thresholdCompactionEmergency = false;
	private _compactionHysteresisState: CompactionHysteresisState = createCompactionHysteresisState();

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// Bash execution state
	private _bashAbortController: AbortController | undefined = undefined;
	private _pendingBashMessages: BashExecutionMessage[] = [];
	private _configuredBashSandboxPreflight: BashSandboxPreflight | undefined = undefined;
	private _detectedBashSandboxBackend: SandboxBackendStatus | undefined = undefined;

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _loadoutAccessPolicy?: LoadoutAccessPolicy;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	// Required durable run/audit chain, persisted next to the session file.
	private readonly _runJournalStore: RunJournalStore;
	private _activeRunId: string | null = null;
	private _pendingRuntimeTerminationCause: SessionTerminationCause | undefined;
	private _activeRunToolTermination:
		| { toolCallId: string; toolName: string; timeoutMs?: number; executionStarted: boolean }
		| undefined;
	private _lastTermination: SessionTermination | undefined;
	private _userAbortRequested = false;
	private readonly _replayLedger: ReplayLedgerManager | undefined;
	private readonly _replayGoalId: string | undefined;
	private readonly _replayLaneId: string | undefined;
	private _transcriptRepair: SessionTranscriptRepair | undefined;
	private _sessionRiskLevel: "normal" | "elevated" = "normal";
	private _workspaceMutationCount = 0;

	// Model registry for API key resolution
	private _modelRegistry: ModelRegistry;
	/** Lazy, in-memory only; never shared across sessions or persisted. */
	private _contextBudgetCacheProvider: ContextBudgetCacheProviderV2 | undefined;
	private _contextCacheInvalidationSnapshot: ContextCacheInvalidationSnapshot;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRegistry = config.modelRegistry;
		const initialModelId = this._contextCacheModelId(this.agent.state.model);
		this._contextCacheInvalidationSnapshot = createContextCacheInvalidationSnapshot({
			forkId: this.sessionManager.getSessionId(),
			worktreeFingerprint: this._contextCacheWorktreeFingerprint(),
			activeModelId: initialModelId,
			compactionModelId: initialModelId,
		});
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._loadoutAccessPolicy = config.loadoutAccessPolicy;
		this._configuredBashSandboxPreflight = config.bashSandboxPreflight;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._transcriptRepair = config.transcriptRepair;
		this._replayLedger = config.replayLedger;
		this._replayGoalId = config.replayGoalId ?? config.replayLedger?.getLedger().goalId;
		this._replayLaneId = config.replayLaneId;
		if (this._replayLedger && this._replayGoalId !== this._replayLedger.getLedger().goalId) {
			throw new Error("AgentSession replayGoalId does not match the replay ledger goal id");
		}
		const sessionFile = this.sessionManager.getSessionFile();
		this._runJournalStore = RunJournalStore.open({
			...(sessionFile ? { journalPath: `${sessionFile}.runjournal` } : {}),
			sessionId: this.sessionManager.getSessionId(),
		});
		const startupTerminal = this._runJournalStore.records.at(-1);
		if (startupTerminal?.event === "run_recovered") {
			this._lastTermination = startupTerminal.termination;
		}

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();

		// Durable transcript-repair audit for a repair applied on open/resume.
		if (this._transcriptRepair) {
			this._invalidateContextBudgetCache({ type: "transcriptRepair" });
			this._appendRunJournalAudit("transcript_repaired", {
				insertedToolCallIds: [...this._transcriptRepair.insertedToolCallIds],
				reason: this._transcriptRepair.reason,
			});
		}

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	/** Transcript repair applied while this session was opened/resumed, if any. */
	get transcriptRepair(): SessionTranscriptRepair | undefined {
		return this._transcriptRepair;
	}

	/** Durable lifecycle and audit records appended by this session's run journal. */
	get runJournalRecords(): readonly RunJournalRecord[] {
		return this._runJournalStore.records;
	}

	/** Most recently observed or inferred termination for this session. */
	get lastTermination(): SessionTermination | undefined {
		return this._lastTermination;
	}

	/** Exact trailing journal fragment quarantine performed during startup, if any. */
	get runJournalQuarantineReport(): RunJournalQuarantineReport | null {
		return this._runJournalStore.quarantineReport;
	}

	/** Elevated once a late-settling potentially-writing tool may have mutated the workspace. */
	get sessionRiskLevel(): "normal" | "elevated" {
		return this._sessionRiskLevel;
	}

	/** Monotonic count of workspace mutation/invalidation signals emitted by this session. */
	get workspaceMutationCount(): number {
		return this._workspaceMutationCount;
	}

	get contextCacheInvalidationSnapshot(): ContextCacheInvalidationSnapshot {
		return this._contextCacheInvalidationSnapshot;
	}

	private _contextCacheModelId(model: Model<any> | undefined): string {
		return model
			? `model-${createHash("sha256").update(`${model.provider}\0${model.id}`, "utf8").digest("hex")}`
			: "unknown";
	}

	private _contextCacheWorktreeFingerprint(): string {
		return createHash("sha256").update(`${this._cwd}\0${this._workspaceMutationCount}`, "utf8").digest("hex");
	}

	private _invalidateContextBudgetCache(event: ContextCacheInvalidationEvent): void {
		const result = applyContextCacheInvalidation(this._contextCacheInvalidationSnapshot, event);
		this._contextCacheInvalidationSnapshot = result.snapshot;
		if (result.status === "overflow") {
			this._contextBudgetCacheProvider = undefined;
			return;
		}
		this._contextBudgetCacheProvider?.setInvalidationSnapshot?.(result.snapshot);
	}

	private _recordEvidenceReceiptInvalidation(customType: string): void {
		if (customType === "evidence_receipt" || customType === "evidence-receipt") {
			this._invalidateContextBudgetCache({ type: "evidenceReceipt" });
		}
	}

	private _sessionRevision(): number {
		return this.sessionManager.getEntries().length;
	}

	private _appendReplayEvent(type: ReplayEventType, payload: unknown): void {
		if (!this._replayLedger || !this._replayGoalId) return;
		this._replayLedger.append({
			type,
			goalId: this._replayGoalId,
			...(this._replayLaneId ? { laneId: this._replayLaneId } : {}),
			payload,
		});
		this._replayLedger.persist();
	}

	/** Append one required durable audit record. Persistence failures propagate. */
	private _appendRunJournalAudit(event: RunJournalAuditEvent, details: RunJournalAuditDetails): void {
		this._runJournalStore.audit({
			event,
			details,
			sessionRevision: this._sessionRevision(),
			timestamp: new Date().toISOString(),
		});
		this._appendReplayEvent(event, details);
	}

	private _terminationMessage(value: string | undefined, fallback: string): string {
		const redacted = redactSensitiveText(value?.trim() || fallback)
			.replace(/\0/g, "")
			.slice(0, 512);
		return redacted || fallback;
	}

	private _providerFailureCause(message: AssistantMessage): SessionTerminationCause {
		const text = message.errorMessage ?? "";
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) {
			return { area: "provider", code: "context_overflow" };
		}
		// Fable/Claude often emit stop_reason=refusal on benign turns (false positive).
		// Match broadly so we never mislabel these as provider.protocol.
		if (
			/stop_reason\s*=\s*(refusal|sensitive)|content\/safety stop|safety stop|provider\.refusal|kind=provider_refusal/i.test(
				text,
			)
		) {
			return { area: "provider", code: "refusal" };
		}
		if (/auth|unauthori[sz]ed|forbidden|invalid.?api.?key|no api key|401|403|\/login/i.test(text)) {
			return { area: "provider", code: "auth" };
		}
		if (/rate.?limit|too many requests|429|quota|available balance|billing/i.test(text)) {
			return { area: "provider", code: "rate_limit" };
		}
		// Kimi/K3 + OpenAI-compat: orphan tool results after dropped error assistants.
		// Sanitize-and-retry (transform-messages drops orphans), not a hard tool fatal.
		if (/tool_call_id\s+is\s+not\s+found|tool_call_id\s+not\s+found|unknown\s+tool_call_id/i.test(text)) {
			return { area: "provider", code: "protocol" };
		}
		if (/tool.+timed? out|tool.+timeout/i.test(text)) return { area: "tool", code: "timeout" };
		if (/\btool\b/i.test(text) && !/tool_call_id/i.test(text)) return { area: "tool", code: "fatal" };
		if (/network|fetch failed|connection|socket|websocket|timed? out|timeout|dns|econn|^terminated$/i.test(text)) {
			return { area: "provider", code: "network" };
		}
		return { area: "provider", code: "protocol" };
	}

	private _classifyPreflightCause(message: string): SessionTerminationCause {
		if (!this.model || /no model|model selected|model is required/i.test(message)) {
			return { area: "configuration", code: "invalid" };
		}
		if (/auth|api key|unauthori[sz]ed|forbidden|401|403|\/login/i.test(message)) {
			return { area: "provider", code: "auth" };
		}
		if (/context.+overflow|context window|too many tokens/i.test(message)) {
			return { area: "provider", code: "context_overflow" };
		}
		if (/duplicate.?result/i.test(message)) return { area: "transcript", code: "duplicate_result" };
		if (/orphan.?result/i.test(message)) return { area: "transcript", code: "orphan_result" };
		if (/duplicate.?call/i.test(message)) return { area: "transcript", code: "duplicate_call_id" };
		if (/transcript|missing.?result/i.test(message)) return { area: "transcript", code: "missing_result" };
		if (/compaction/i.test(message)) return { area: "compaction", code: "failed" };
		if (/fsync/i.test(message)) return { area: "persistence", code: "fsync_failed" };
		if (/lock/i.test(message)) return { area: "persistence", code: "lock_failed" };
		if (/append|persist|write/i.test(message)) return { area: "persistence", code: "append_failed" };
		if (/tool/i.test(message)) return { area: "tool", code: "fatal" };
		return { area: "internal", code: "unclassified" };
	}

	private _classifyRunTermination(
		runId: string,
		event: Extract<AgentEvent, { type: "agent_end" }>,
	): SessionTermination {
		const timestamp = new Date().toISOString();
		const assistant = [...event.messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		let cause: SessionTerminationCause;
		let message: string;
		let sideEffects: "none" | "possible" = this._sessionRiskLevel === "elevated" ? "possible" : "none";
		let toolCallId: string | undefined;
		let toolName: string | undefined;

		if (this._activeRunToolTermination) {
			cause = { area: "tool", code: "timeout" };
			message = `Tool ${this._activeRunToolTermination.toolName} timed out.`;
			toolCallId = this._activeRunToolTermination.toolCallId;
			toolName = this._activeRunToolTermination.toolName;
			sideEffects = this._activeRunToolTermination.executionStarted ? "possible" : sideEffects;
		} else if (!assistant) {
			cause = { area: "internal", code: "unclassified" };
			message = "Agent run ended without an assistant result.";
		} else if (assistant.stopReason === "aborted") {
			cause = this._userAbortRequested ? { area: "user", code: "abort" } : { area: "provider", code: "abort" };
			message = this._terminationMessage(
				assistant.errorMessage,
				this._userAbortRequested ? "The user aborted the run." : "The provider aborted the run.",
			);
		} else if (assistant.stopReason === "error") {
			cause = this._providerFailureCause(assistant);
			message = this._terminationMessage(assistant.errorMessage, "The provider request failed.");
		} else {
			cause = { area: "completed" };
			message = "Run completed.";
		}

		return classifySessionTermination({
			sessionId: this.sessionId,
			runId,
			timestamp,
			source: "observed",
			message,
			cause,
			sideEffects,
			...(assistant?.provider
				? { provider: assistant.provider }
				: this.model
					? { provider: this.model.provider }
					: {}),
			...(assistant?.model ? { model: assistant.model } : this.model ? { model: this.model.id } : {}),
			...(toolCallId ? { toolCallId } : {}),
			...(toolName ? { toolName } : {}),
		});
	}

	private _publishTermination(termination: SessionTermination): void {
		this._lastTermination = termination;
		this._emit({ type: "session_termination", termination });
	}

	private _runtimeFailureCause(error: unknown): SessionTerminationCause {
		if (this._pendingRuntimeTerminationCause) return this._pendingRuntimeTerminationCause;
		const code =
			typeof error === "object" && error !== null && "code" in error ? Reflect.get(error, "code") : undefined;
		if (
			typeof code === "string" &&
			new Set(["EACCES", "EDQUOT", "EFBIG", "EIO", "EISDIR", "EMFILE", "ENFILE", "ENOSPC", "EPERM", "EROFS"]).has(
				code,
			)
		) {
			return { area: "persistence", code: "append_failed" };
		}
		const message = error instanceof Error ? error.message : String(error);
		if (/compaction.+stale|session changed during compaction/i.test(message)) {
			return { area: "compaction", code: "stale" };
		}
		if (/compaction/i.test(message)) return { area: "compaction", code: "failed" };
		return { area: "internal", code: "unclassified" };
	}

	private _publishRuntimeFailure(error: unknown): void {
		const cause = this._runtimeFailureCause(error);
		const runId = this._activeRunId ?? `runtime-${randomUUID()}`;
		const timestamp = new Date().toISOString();
		const message =
			cause.area === "persistence"
				? "A required runtime persistence operation failed."
				: cause.area === "compaction"
					? "Runtime compaction failed."
					: "The AgentSession runtime failed before completing the run.";
		let termination = classifySessionTermination({
			sessionId: this.sessionId,
			runId,
			timestamp,
			source: "observed",
			message,
			cause,
			sideEffects: this._activeRunId === null ? "none" : "possible",
			...(this.model ? { provider: this.model.provider, model: this.model.id } : {}),
		});
		if (this._activeRunId !== null && this._runJournalStore.openRunId === this._activeRunId) {
			try {
				this._runJournalStore.finish({
					termination,
					sessionRevision: this._sessionRevision(),
					timestamp,
				});
			} catch {
				termination = classifySessionTermination({
					sessionId: this.sessionId,
					runId,
					timestamp,
					source: "observed",
					message: "The run journal could not persist the runtime termination.",
					cause: { area: "persistence", code: "append_failed" },
					sideEffects: "possible",
					...(this.model ? { provider: this.model.provider, model: this.model.id } : {}),
				});
			}
		}
		this._activeRunId = null;
		this._activeRunToolTermination = undefined;
		this._pendingRuntimeTerminationCause = undefined;
		this._userAbortRequested = false;
		this._publishTermination(termination);
	}

	private _handleRunLifecycleEvent(event: AgentEvent): void {
		if (event.type === "agent_start") {
			if (this._activeRunId !== null) throw new Error("run journal already has an active AgentSession run");
			const runId = randomUUID();
			this._activeRunId = runId;
			this._activeRunToolTermination = undefined;
			this._pendingRuntimeTerminationCause = undefined;
			this._userAbortRequested = false;
			try {
				this._runJournalStore.start({
					runId,
					sessionRevision: this._sessionRevision(),
					timestamp: new Date().toISOString(),
				});
			} catch (error) {
				this._pendingRuntimeTerminationCause = { area: "persistence", code: "append_failed" };
				throw error;
			}
			return;
		}
		if (event.type !== "agent_end") return;
		if (this._activeRunId === null) throw new Error("run journal received agent_end without run_started");
		const termination = this._classifyRunTermination(this._activeRunId, event);
		try {
			this._runJournalStore.finish({
				termination,
				sessionRevision: this._sessionRevision(),
				timestamp: termination.timestamp,
			});
		} catch (error) {
			this._pendingRuntimeTerminationCause = { area: "persistence", code: "append_failed" };
			throw error;
		}
		this._activeRunId = null;
		this._activeRunToolTermination = undefined;
		this._pendingRuntimeTerminationCause = undefined;
		this._userAbortRequested = false;
		this._publishTermination(termination);
	}

	/**
	 * Handle tool timeout / late-settlement audit signals (ALG004-A/B). A late
	 * settlement of a potentially-writing tool raises session risk and emits a
	 * workspace mutation/invalidation signal for evidence freshness consumers.
	 */
	private _handleToolAuditEvent(event: AgentEvent): void {
		if (event.type === "tool_execution_end") {
			this._invalidateContextBudgetCache({ type: "toolResultDisposition" });
			const envelope = (event.result as { details?: { omk?: Record<string, unknown> } } | undefined)?.details?.omk;
			if (envelope && envelope.schema === "tool-result/v2" && envelope.disposition === "timeout") {
				const timeout = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					...(typeof envelope.timeoutMs === "number" ? { timeoutMs: envelope.timeoutMs } : {}),
					executionStarted: envelope.executionStarted === true,
				};
				this._activeRunToolTermination = timeout;
				this._appendRunJournalAudit("tool_timeout", timeout);
			}
			return;
		}
		if (event.type !== "tool_execution_late_settlement") {
			return;
		}
		// Fail closed: anything not classified as a read-category tool may write.
		const potentiallyWriting = resolveToolTimeoutCategory(event.toolName) !== "read";
		this._appendRunJournalAudit("tool_late_settlement", {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			disposition: event.disposition,
			outcome: event.outcome,
			...(potentiallyWriting ? { sessionRisk: "elevated" as const } : {}),
		});
		if (potentiallyWriting) {
			this._sessionRiskLevel = "elevated";
			this._workspaceMutationCount += 1;
			this._invalidateContextBudgetCache({
				type: "worktreeFingerprint",
				value: this._contextCacheWorktreeFingerprint(),
			});
			const payload = { root: this._cwd, paths: [] as readonly string[] };
			this._appendReplayEvent("workspace_mutation", payload);
			this._emit({
				type: "workspace_mutation",
				source: "tool_late_settlement",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				payload,
			});
		}
	}

	private _getBashSandboxPreflight(override?: BashSandboxPreflight): BashSandboxPreflight | undefined {
		const preflight = override ?? this._configuredBashSandboxPreflight;
		if (!preflight || preflight.policy.mode === "off" || preflight.backend) {
			return preflight;
		}
		this._detectedBashSandboxBackend ??= detectSandboxBackend();
		return { ...preflight, backend: this._detectedBashSandboxBackend };
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		apiKey: string;
		headers?: Record<string, string>;
	}> {
		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!result.ok) {
			if (result.error.startsWith("No API key found")) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw new Error(result.error);
		}
		if (result.apiKey) {
			return { apiKey: result.apiKey, headers: result.headers };
		}

		const isOAuth = this._modelRegistry.isUsingOAuth(model);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getCompactionRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
	}> {
		if (this.agent.streamFn === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		return result.ok ? { apiKey: result.apiKey, headers: result.headers } : {};
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			if (this._loadoutAccessPolicy && !this._loadoutAccessPolicy.activeTools.includes(toolCall.name)) {
				throw new Error(`loadout: inactive tool: ${toolCall.name}`);
			}
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_result")) {
				return undefined;
			}

			const hookResult = await runner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content: result.content,
				details: result.details,
				isError,
			});

			if (!hookResult) {
				return undefined;
			}

			return {
				content: hookResult.content,
				details: hookResult.details,
				isError: hookResult.isError ?? isError,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// Required run lifecycle persistence executes before extension/user listeners.
		this._handleRunLifecycleEvent(event);

		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const messageText = this._getUserMessageText(event.message);
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// Durable tool timeout / late-settlement audits (ALG004-A/B).
		this._handleToolAuditEvent(event);

		// Emit to extensions first
		await this._emitExtensionEvent(event);
		const replacement = event.type === "message_end" ? this._messageEndReplacements.get(event) : undefined;
		if (event.type === "message_end") {
			this._messageEndReplacements.delete(event);
		}
		const finalizedEvent: AgentEvent =
			replacement === undefined ? event : (Object.freeze({ ...event, message: replacement }) as AgentEvent);

		// Notify all listeners
		this._emit(
			finalizedEvent.type === "agent_end"
				? { ...finalizedEvent, willRetry: this._willRetryAfterAgentEnd(finalizedEvent) }
				: finalizedEvent,
		);

		// Handle session persistence
		if (finalizedEvent.type === "message_end") {
			// Check if this is a custom message from extensions
			if (finalizedEvent.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					finalizedEvent.message.customType,
					finalizedEvent.message.content,
					finalizedEvent.message.display,
					finalizedEvent.message.details,
				);
			} else if (
				finalizedEvent.message.role === "user" ||
				finalizedEvent.message.role === "assistant" ||
				finalizedEvent.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(finalizedEvent.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (finalizedEvent.message.role === "assistant") {
				this._lastAssistantMessage = finalizedEvent.message;

				const assistantMsg = finalizedEvent.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** Extract text content from a message */
	private _getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		const textBlocks = content.filter((c) => c.type === "text");
		return textBlocks.map((c) => (c as TextContent).text).join("");
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceFinalizedMessage(target: AgentMessage, replacement: AgentMessage): AgentMessage {
		const messages = this.agent.state.messages;
		const matchingIndexes = messages.flatMap((message, index) => (isDeepStrictEqual(message, target) ? [index] : []));
		if (matchingIndexes.length !== 1) {
			throw new Error(
				matchingIndexes.length === 0
					? "Finalized message was not found in agent state"
					: "Finalized message is ambiguous in agent state",
			);
		}

		const finalizedReplacement = createImmutableMessageSnapshot(replacement);
		const nextMessages = messages.slice();
		nextMessages[matchingIndexes[0]!] = finalizedReplacement;
		this.agent.state.messages = nextMessages;
		return finalizedReplacement;
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				const finalizedReplacement = this._replaceFinalizedMessage(event.message, replacement);
				this._messageEndReplacements.set(event, finalizedReplacement);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured extension API or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Current thinking mode ("manual" = user-selected level, "auto" = per-turn router) */
	get thinkingMode(): ThinkingMode {
		return this._thinkingMode;
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const requestedToolNames = normalizeToolNames(toolNames);
		const lockedToolNames = this._loadoutAccessPolicy?.activeTools;
		if (lockedToolNames && !toolNameSetsEqual(requestedToolNames, lockedToolNames)) {
			throw new Error(
				`loadout active tools are locked: expected ${lockedToolNames.join(", ") || "(none)"}, received ${requestedToolNames.join(", ") || "(none)"}`,
			);
		}

		const desiredToolNames = lockedToolNames ? [...lockedToolNames] : toolNames;
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of desiredToolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			} else if (lockedToolNames?.includes(name)) {
				throw new Error(`loadout locked tool unavailable: ${name}`);
			}
		}
		this.agent.state.tools = tools;
		this._applyToolTimeoutCategoryDefaults(validToolNames);

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	/**
	 * Recompute the Agent's per-name timeout map for the active tool set:
	 * explicit user/settings entries always win; active tools without an entry
	 * receive their §6.3 category default (ALG004-C); uncategorized tools fall
	 * through to the global `toolTimeoutMs`.
	 */
	private _applyToolTimeoutCategoryDefaults(activeToolNames: readonly string[]): void {
		try {
			const resolved = resolveAgentToolSettings(this.settingsManager);
			this.agent.toolTimeouts = applyCategoryTimeoutDefaults(activeToolNames, resolved.toolTimeouts);
		} catch {
			// Invalid settings fail closed at session creation; keep current
			// explicit entries and still fill category defaults for active tools.
			this.agent.toolTimeouts = applyCategoryTimeoutDefaults(activeToolNames, this.agent.toolTimeouts ?? {});
		}
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
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
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	/**
	 * Extract the most recent user query text from conversation messages.
	 * Returns undefined when no user message exists or content is empty.
	 * Handles both string content and multimodal (array) content.
	 */
	private _extractCurrentQuery(): string | undefined {
		const messages = this.messages;
		if (messages.length === 0) {
			return undefined;
		}
		// Scan recent messages (last 3) for the most recent user message
		const recent = messages.slice(-3);
		for (let i = recent.length - 1; i >= 0; i--) {
			const msg = recent[i]!;
			if (!("role" in msg) || msg.role !== "user") {
				continue;
			}
			const content = (msg as { content: string | (TextContent | ImageContent)[] }).content;
			if (typeof content === "string") {
				const trimmed = content.trim();
				return trimmed.length > 0 ? trimmed : undefined;
			}
			if (Array.isArray(content)) {
				const textParts = content
					.filter((c): c is TextContent => "type" in c && c.type === "text")
					.map((c) => c.text);
				const joined = textParts.join("\n").trim();
				return joined.length > 0 ? joined : undefined;
			}
		}
		return undefined;
	}

	private _getContextBudgetOptions(): BuildSystemPromptOptions["contextBudget"] | undefined {
		const contextGovernorOverride = process.env.OMK_CONTEXT_GOVERNOR;
		if (contextGovernorOverride === "0") {
			return undefined;
		}
		if (contextGovernorOverride !== "1" && !this.settingsManager.getContextBudgetEnabled()) {
			return undefined;
		}

		const contextWindow = this.model?.contextWindow ?? 0;

		// --- maxPromptTokens ---
		// Priority 1: explicit env override (user knows best)
		const envMaxPrompt = parsePositiveIntegerEnv("OMK_CONTEXT_GOVERNOR_MAX_PROMPT_TOKENS");
		let maxPromptTokens: number;
		let responseReserveTokens: number;

		if (envMaxPrompt !== undefined) {
			// User override — use as-is for prompt, derive response reserve normally
			maxPromptTokens = envMaxPrompt;
			responseReserveTokens =
				parsePositiveIntegerEnv("OMK_CONTEXT_GOVERNOR_RESPONSE_RESERVE_TOKENS") ??
				this._computeResponseReserve(contextWindow);
		} else if (contextWindow > 0) {
			// Dynamic: derive from model contextWindow
			const envPromptRatio = parsePositiveFloatEnv("OMK_CONTEXT_GOVERNOR_PROMPT_RATIO");
			const envResponseRatio = parsePositiveFloatEnv("OMK_CONTEXT_GOVERNOR_RESPONSE_RATIO");

			responseReserveTokens =
				parsePositiveIntegerEnv("OMK_CONTEXT_GOVERNOR_RESPONSE_RESERVE_TOKENS") ??
				this._computeResponseReserve(contextWindow, envResponseRatio);

			const safetyMargin = Math.floor(contextWindow * SAFETY_MARGIN_RATIO);
			if (envPromptRatio !== undefined && envPromptRatio > 0 && envPromptRatio < 1) {
				maxPromptTokens = Math.floor(contextWindow * envPromptRatio);
			} else {
				// Default: contextWindow minus reserves and safety margin
				maxPromptTokens = contextWindow - responseReserveTokens - safetyMargin;
			}
		} else {
			// No model info — legacy fallback
			maxPromptTokens = LEGACY_MAX_PROMPT_TOKENS;
			responseReserveTokens =
				parsePositiveIntegerEnv("OMK_CONTEXT_GOVERNOR_RESPONSE_RESERVE_TOKENS") ?? LEGACY_RESPONSE_RESERVE_TOKENS;
		}

		const cacheProvider = this._contextBudgetCacheProvider ?? createMemoryContextBudgetCacheProviderV2("session");
		cacheProvider.setInvalidationSnapshot?.(this._contextCacheInvalidationSnapshot);
		this._contextBudgetCacheProvider = cacheProvider;

		// Enforce floor
		if (maxPromptTokens < MIN_PROMPT_TOKENS) {
			maxPromptTokens = MIN_PROMPT_TOKENS;
		}
		// Ensure responseReserve does not exceed maxPromptTokens
		if (responseReserveTokens >= maxPromptTokens) {
			responseReserveTokens = Math.max(Math.floor(maxPromptTokens / 4), LEGACY_RESPONSE_RESERVE_TOKENS);
		}

		return {
			maxPromptTokens,
			responseReserveTokens,
			modelId: this.model?.id ?? "unknown",
			tokenizerMode: parseTokenizerModeEnv(process.env.OMK_CONTEXT_GOVERNOR_TOKENIZER),
			activeSkillNames: parseCommaSeparatedEnv(process.env.OMK_CONTEXT_GOVERNOR_ACTIVE_SKILLS),
			queryContext: this._extractCurrentQuery(),
			cacheProvider,
		};
	}

	/**
	 * Compute responseReserveTokens from contextWindow.
	 * Prefers the model's own maxTokens when available, otherwise uses a ratio.
	 */
	private _computeResponseReserve(contextWindow: number, overrideRatio?: number): number {
		// Prefer model's maxTokens (actual output limit) if available and reasonable
		const modelMaxTokens = this.model?.maxTokens;
		if (modelMaxTokens !== undefined && modelMaxTokens > 0 && modelMaxTokens < contextWindow) {
			return modelMaxTokens;
		}
		const ratio = overrideRatio ?? RESPONSE_RESERVE_RATIO;
		return Math.max(Math.floor(contextWindow * ratio), LEGACY_RESPONSE_RESERVE_TOKENS);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const grokAppend = grokPlaybookAppendForProvider(this.model?.provider);
		const appendParts = [...loaderAppendSystemPrompt];
		if (grokAppend) {
			appendParts.push(grokAppend);
		}
		const appendSystemPrompt = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
			contextBudget: this._getContextBudgetOptions(),
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		try {
			await this.agent.prompt(messages);
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} catch (error) {
			this._publishRuntimeFailure(error);
			throw error;
		} finally {
			this._flushPendingBashMessages();
		}
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(msg)) {
			return true;
		}

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		return this.agent.hasQueuedMessages();
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via omk.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let currentText = redactSensitiveText(text);
		let promptActiveSkillNames = [...(options?.activeSkillNames ?? [])];
		let promptActiveSkillSource = options?.activeSkillSource;
		let isBangSkillInvocation = false;
		if (expandPromptTemplates) {
			const bangInvocation = parseBangInvocation(text, {
				hasSkill: (name) => this._resourceLoader.getSkills().skills.some((skill) => skill.name === name),
			});
			if (bangInvocation.kind === "skill") {
				isBangSkillInvocation = true;
				currentText = bangInvocation.prompt
					? `/skill:${bangInvocation.skillName} ${bangInvocation.prompt}`
					: `/skill:${bangInvocation.skillName}`;
				promptActiveSkillNames = mergePromptActiveSkillNames(
					promptActiveSkillNames,
					bangInvocation.activeSkillNames,
				);
				promptActiveSkillSource = bangInvocation.source;
			}
		}
		let messages: AgentMessage[] | undefined;

		try {
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via omk.sendMessage()
			if (expandPromptTemplates && !isBangSkillInvocation && currentText.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(currentText);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}
			expandedText = redactSensitiveText(expandedText);

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			// Root-level: eject sticky safety models (Fable) before the turn leaves the machine.
			await this._ejectStickySafetyModelIfNeeded();

			// Grok OAuth: refuse Imagine ids on the chat/completions path (tool-only).
			assertTextChatModelForCompletion(this.model.id, this.model.provider);

			if (!this._modelRegistry.hasConfiguredAuth(this.model)) {
				const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Check if we need to compact before sending (catches aborted responses)
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant && (await this._checkCompaction(lastAssistant, false))) {
				try {
					await this.agent.continue();
					while (await this._handlePostAgentRun()) {
						await this.agent.continue();
					}
				} finally {
					this._flushPendingBashMessages();
				}
			}

			// Auto thinking mode: resolve this turn's level from the prompt content.
			// Manual mode never enters the router, so /think <level> always wins.
			this._applyAutoThinkingLevelForTurn(expandedText);

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			const turnSystemPromptOptions =
				promptActiveSkillNames.length > 0
					? {
							...this._baseSystemPromptOptions,
							activeSkillNames: promptActiveSkillNames,
							...(promptActiveSkillSource ? { activeSkillSource: promptActiveSkillSource } : {}),
						}
					: this._baseSystemPromptOptions;
			const turnSystemPrompt =
				promptActiveSkillNames.length > 0 ? buildSystemPrompt(turnSystemPromptOptions) : this._baseSystemPrompt;

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				turnSystemPrompt,
				turnSystemPromptOptions,
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						content: msg.content,
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt) {
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this.agent.state.systemPrompt = turnSystemPrompt;
			}

			await this._checkProjectedCompaction(messages);
		} catch (error) {
			preflightResult?.(false);
			const rawMessage = error instanceof Error ? error.message : String(error);
			const cause = this._classifyPreflightCause(rawMessage);
			const timestamp = new Date().toISOString();
			this._publishTermination(
				classifySessionTermination({
					sessionId: this.sessionId,
					runId: `preflight-${randomUUID()}`,
					timestamp,
					source: "observed",
					message: this._terminationMessage(rawMessage, "Prompt preflight failed."),
					cause,
					sideEffects: "none",
					...(this.model ? { provider: this.model.provider, model: this.model.id } : {}),
				}),
			);
			throw error;
		}

		if (!messages) {
			return;
		}

		preflightResult?.(true);
		await this._runAgentPrompt(messages);
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		const sanitizedText = redactSensitiveText(text);

		// Check for extension commands (cannot be queued)
		if (sanitizedText.startsWith("/")) {
			this._throwIfExtensionCommand(sanitizedText);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(sanitizedText);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(redactSensitiveText(expandedText), images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		const sanitizedText = redactSensitiveText(text);

		// Check for extension commands (cannot be queued)
		if (sanitizedText.startsWith("/")) {
			this._throwIfExtensionCommand(sanitizedText);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(sanitizedText);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(redactSensitiveText(expandedText), images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._invalidateContextBudgetCache({ type: "userSteering" });
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

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
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		this._recordEvidenceReceiptInvalidation(message.customType);
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._runAgentPrompt(appMessage);
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
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
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this._userAbortRequested = this.isStreaming || this.isRetrying;
		this.abortRetry();
		this.agent.abort();
		await this.agent.waitForIdle();
	}

	/** Record an observed process signal before a mode begins shutdown. */
	recordProcessSignal(signal: SessionProcessSignal): SessionTermination {
		const timestamp = new Date().toISOString();
		const runId = this._activeRunId ?? `signal-${randomUUID()}`;
		const termination = classifySessionTermination({
			sessionId: this.sessionId,
			runId,
			timestamp,
			source: "observed",
			message: `Process received ${signal}.`,
			cause: { area: "process", code: "signal", signal },
			sideEffects: this._activeRunId === null ? "none" : "possible",
			...(this.model ? { provider: this.model.provider, model: this.model.id } : {}),
		});
		if (this._activeRunId !== null) {
			this._runJournalStore.finish({
				termination,
				sessionRevision: this._sessionRevision(),
				timestamp,
			});
			this._activeRunId = null;
		}
		this._publishTermination(termination);
		return termination;
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		this._invalidateContextBudgetCache({ type: "activeModelId", value: this._contextCacheModelId(nextModel) });
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>): Promise<void> {
		if (!this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		// Root-level: block sticky safety models (Fable) unless explicitly allowed in settings.
		const resilience = resolveProviderResilience(this.settingsManager.getProviderResilienceSettings());
		if (resilience.blockStickySafetyModels && isStickySafetyModel(model.id, model.provider)) {
			throw new Error(stickySafetyBlockMessage(model.id, model.provider));
		}

		// Grok OAuth: block selecting Imagine models as the session chat model.
		assertTextChatModelForCompletion(model.id, model.provider);

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const resilience = resolveProviderResilience(this.settingsManager.getProviderResilienceSettings());
		const scopedModels = this._scopedModels.filter((scoped) => {
			if (!this._modelRegistry.hasConfiguredAuth(scoped.model)) return false;
			if (resilience.blockStickySafetyModels && isStickySafetyModel(scoped.model.id, scoped.model.provider)) {
				return false;
			}
			return true;
		});
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		// Single path through setModel (sticky block + auth + Imagine guards).
		await this.setModel(next.model);
		// Explicit scoped thinking level still applies after switch.
		this.setThinkingLevel(thinkingLevel);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const resilience = resolveProviderResilience(this.settingsManager.getProviderResilienceSettings());
		const raw = await this._modelRegistry.getAvailable();
		// Hard-kill sticky safety models from the cycle list (Fable must not re-enter via hotkey).
		const availableModels = resilience.blockStickySafetyModels
			? raw.filter((m) => !isStickySafetyModel(m.id, m.provider))
			: raw;
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		// Always go through setModel so sticky blocks / auth / Imagine guards stay single-path.
		await this.setModel(nextModel);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Set the thinking mode. "auto" resolves a level per turn via the reasoning
	 * router; "manual" keeps the explicitly selected level. The mode persists for
	 * the session lifetime and is never written to user settings.
	 */
	setThinkingMode(mode: ThinkingMode): void {
		this._thinkingMode = mode;
	}

	/**
	 * In auto thinking mode, resolve and apply this turn's thinking level from the
	 * prompt content. Updates agent state, records the change in the session, and
	 * notifies observers - but never overwrites the user's persisted default
	 * thinking level in settings. Models without reasoning support bypass the
	 * router entirely (level stays "off").
	 */
	private _applyAutoThinkingLevelForTurn(promptText: string): void {
		if (this._thinkingMode !== "auto") return;
		if (!this.supportsThinking()) return;

		this._applyAutoThinkingLevelV4(promptText);
	}

	/**
	 * Auto-mode resolver. Reuses the N=8 recent-class history and
	 * context-pressure bucket, routed through the confidence-bearing v4 classifier
	 * and its uncertainty-aware resolver. No
	 * `laneType` applies to the main session (always "none"/`undefined`);
	 * `hint` is permanently `null` -- the Adaptorch advisory bridge has no
	 * transport wired into the session (out of this lane's scope; see
	 * adaptorch-bridge.ts). `bias` stays `0` unless BOTH hold: (a) the global,
	 * owner-only `reasoningRouterLearning.enabled` setting is `true` (default
	 * off; a project-scope `.omk/settings.json` value for this key is never
	 * consulted -- see settings-manager.ts), and (b) a compiled
	 * `RouterBiasSnapshot` was found and passed strict validation at the
	 * configured/default path, loaded and cached ("pinned") at most once per
	 * session (see `_getReasoningRouterBiasSnapshot`). When learning is
	 * enabled, exactly one bounded "accepted" feedback record (no raw prompt/
	 * path/diff/session/model/provider/tool/hook content; see
	 * router-feedback-collector.ts's exact ten-key schema) is appended to the
	 * local ledger after every v4 auto-turn resolution, for a future, separate
	 * offline compile step to learn from -- this lane never records an
	 * override/fail/hook-outcome signal, only the neutral "accepted" one. The
	 * resolver's own confidence-band/fallback-reason escalation (see
	 * reasoning-router-v4.ts) still applies on top of the base+lane+bias
	 * target, so a low-confidence or fallback-decided verdict can still only
	 * match or exceed the confident-path level.
	 */
	private _applyAutoThinkingLevelV4(promptText: string): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const verdict = classifyTaskV4({
			prompt: promptText,
			history: this._taskClassHistory,
			pressureBucket: this._computePressureBucket(),
		});

		this._taskClassHistory.unshift(verdict.taskClass);
		if (this._taskClassHistory.length > 8) this._taskClassHistory.length = 8;

		const learningEnabled = this.settingsManager.getReasoningRouterLearningEnabled();
		const snapshot = learningEnabled ? this._getReasoningRouterBiasSnapshot() : null;
		const features = this._deriveRouterFeedbackFeatures(promptText);
		const bias =
			snapshot === null
				? 0
				: getBiasStepsForCell(snapshot, {
						predictedClass: verdict.taskClass,
						laneType: "none",
						lenBucket: features.lenBucket,
						hadFence: features.hadFence,
						hadDiff: features.hadDiff,
					});

		const resolved = resolveThinkingLevelV4WithUncertainty(
			verdict,
			availableLevels,
			undefined,
			bias,
			this._getAdaptorchHint(verdict, features),
		);

		if (learningEnabled && resolved !== "off") {
			const record: RouterFeedbackRecord = {
				routerVersion: "v4",
				laneType: "none",
				predictedClass: verdict.taskClass,
				resolvedLevel: resolved,
				acceptedLevel: resolved,
				signal: "s2-accept",
				outcome: "accepted",
				lenBucket: features.lenBucket,
				hadFence: features.hadFence,
				hadDiff: features.hadDiff,
			};
			appendRouterFeedbackRecord(record, {
				enabled: true,
				ledgerPath: this.settingsManager.getReasoningRouterLearningFeedbackLedgerPath(),
			});
		}

		const previousLevel = this.agent.state.thinkingLevel;
		if (resolved === previousLevel) return;

		this.agent.state.thinkingLevel = resolved;
		this.sessionManager.appendThinkingLevelChange(resolved);
		this._emit({ type: "thinking_level_changed", level: resolved });
	}

	/**
	 * Loads and strictly validates the compiled reasoning-router bias snapshot
	 * for the opt-in v4 learning path (Goal 010 Lane I), at most once per
	 * session ("pinned"): the first call attempts the read and caches whatever
	 * it finds (including a `null` miss/failure); every later call in the same
	 * session reuses that cached result without touching disk again. Returns
	 * `null` when no file exists at the configured/default path, the file
	 * cannot be read, or its contents fail `parseRouterBiasSnapshot`'s schema
	 * validation -- never throws.
	 */
	private _getReasoningRouterBiasSnapshot(): RouterBiasSnapshot | null {
		if (this._reasoningRouterBiasSnapshotLoaded) return this._reasoningRouterBiasSnapshot;
		this._reasoningRouterBiasSnapshotLoaded = true;

		const path =
			this.settingsManager.getReasoningRouterLearningBiasSnapshotPath() ?? getDefaultRouterBiasSnapshotPath();
		try {
			if (existsSync(path)) {
				this._reasoningRouterBiasSnapshot = parseRouterBiasSnapshot(readFileSync(path, "utf-8"));
			}
		} catch {
			this._reasoningRouterBiasSnapshot = null;
		}
		return this._reasoningRouterBiasSnapshot;
	}

	/**
	 * Locally derives the same three bounded, privacy-safe feedback-ledger
	 * features (`lenBucket`, `hadFence`, `hadDiff`) the v4 classifier computes
	 * internally (reasoning-router-v4.ts keeps those helpers file-private, so
	 * they cannot be imported here). Mirrors reasoning-router-v4.ts's
	 * length-bucket, `hasCodeFence`, and `hasDiffMarkers` helpers. Operates on the same trimmed prompt text
	 * the classifier scores; never returns raw prompt content or its exact
	 * length, only the clamped [0,7] bucket and two booleans.
	 */
	private _deriveRouterFeedbackFeatures(promptText: string): {
		lenBucket: RouterFeedbackLenBucket;
		hadFence: boolean;
		hadDiff: boolean;
	} {
		const trimmed = promptText.trim();

		let lenBucket = 0;
		let remaining = trimmed.length + 1;
		while (remaining > 1 && lenBucket < 7) {
			remaining >>= 1;
			lenBucket++;
		}

		const hadFence = trimmed.includes("```");
		const hadDiff =
			/^@@[^\n]*@@/m.test(trimmed) ||
			/^diff --git /m.test(trimmed) ||
			(/^\+(?!\+)/m.test(trimmed) && /^-(?!-)/m.test(trimmed));

		return { lenBucket: lenBucket as RouterFeedbackLenBucket, hadFence, hadDiff };
	}

	/**
	 * Context-pressure band 0..3 from the projected token estimate over the
	 * model context window (reuses estimateProjectedContextTokens). 0..<0.5,
	 * 1..<0.75, 2..<0.9, 3..>=0.9. Inert under DEFAULT_WEIGHTS (no pressure
	 * coefficient); computed for future calibrated weight presets.
	 */
	private _computePressureBucket(): number {
		const contextWindow = this.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return 0;
		const estimate = estimateProjectedContextTokens(this.agent.state.messages, []);
		const pressure = estimate.tokens / contextWindow;
		if (pressure >= 0.9) return 3;
		if (pressure >= 0.75) return 2;
		if (pressure >= 0.5) return 1;
		return 0;
	}

	/**
	 * AdaptOrch advisory bridge hint accessor (default-off, global-only).
	 * Lazily constructs the bridge on first call when enabled; returns `null`
	 * (no hint) otherwise. The bridge's `getFreshHint` is synchronous and
	 * cache-read-only, so this never blocks the turn-start path. A fire-and-
	 * forget `requestRefresh` is issued for the NEXT turn's benefit.
	 *
	 * The returned hint is shaped as `{ level, confidence }` for the resolver's
	 * hint-fusion slot: confidence is mapped from the bridge's closed
	 * `confidenceBand` enum (low=0.5, medium=0.75, high=0.95) and the level is
	 * derived from the bridge's `taskClass` via the same static rule table the
	 * resolver uses. The resolver's own HINT_CONFIDENCE_THRESHOLD (0.7) gates
	 * whether the hint actually fuses, so a "low" band hint is structurally
	 * inert.
	 */
	private _getAdaptorchHint(
		verdict: { taskClass: TaskClassV4 },
		features: { lenBucket: RouterFeedbackLenBucket; hadFence: boolean; hadDiff: boolean },
	): { level: import("omk-agent-core").ThinkingLevel; confidence: number } | null {
		if (!this.settingsManager.getAdaptorchBridgeEnabled()) return null;

		// Lazy init (at most once per session)
		if (!this._adaptorchBridgeInitAttempted) {
			this._adaptorchBridgeInitAttempted = true;
			const bridgeSettings = this.settingsManager.getAdaptorchBridgeSettings();
			this._adaptorchBridge = createAdaptorchBridge({
				// The advisory function is a no-op stub until a real MCP transport
				// is wired by a future lane. The bridge's circuit breaker and budget
				// counter ensure this stub can never cause harm.
				advisoryFn: async () => null,
				ttlMs: bridgeSettings?.ttlMs,
				timeoutMs: bridgeSettings?.timeoutMs,
				maxConsultsPerSession: bridgeSettings?.maxConsultsPerSession,
				failureThreshold: bridgeSettings?.failureThreshold,
			});
		}

		const bridge = this._adaptorchBridge;
		if (bridge === null) return null;

		const payload: AdaptorchConsultPayload = {
			schemaVersion: 1,
			taskClass: verdict.taskClass as AdaptorchConsultPayload["taskClass"],
			runnerUp: verdict.taskClass as AdaptorchConsultPayload["runnerUp"],
			marginBucket: "high",
			lenBucket: features.lenBucket as AdaptorchConsultPayload["lenBucket"],
			hadFence: features.hadFence,
			hadDiff: features.hadDiff,
			pressureBucket: this._computePressureBucket() as AdaptorchConsultPayload["pressureBucket"],
		};

		// Fire-and-forget refresh for next turn
		bridge.requestRefresh(payload);

		// Synchronous cache read for this turn
		const hint = bridge.getFreshHint(payload);
		if (hint === null) return null;

		// Map confidenceBand -> numeric confidence for the resolver's threshold gate
		const confidenceMap: Record<string, number> = { low: 0.5, medium: 0.75, high: 0.95 };
		const confidence = confidenceMap[hint.confidenceBand] ?? 0.5;

		// Map taskClass -> ThinkingLevel via the same rule table the resolver uses
		const levelMap: Record<string, import("omk-agent-core").ThinkingLevel> = {
			trivial: "minimal",
			"simple-edit": "low",
			"code-gen": "medium",
			debug: "high",
			refactor: "high",
			review: "high",
			plan: "xhigh",
		};
		const level = levelMap[hint.taskClass];
		if (level === undefined) return null;

		return { level, confidence };
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	private _captureCompactionState(): CapturedCompactionState {
		return this.sessionManager.withCompactionCommitLock(() => this._captureCompactionStateLocked());
	}

	private _captureCompactionStateLocked(): CapturedCompactionState {
		const sessionFile = this.sessionManager.getSessionFile();
		const bytes =
			sessionFile && existsSync(sessionFile)
				? new Uint8Array(readFileSync(sessionFile))
				: new TextEncoder().encode(
						`${[this.sessionManager.getHeader(), ...this.sessionManager.getEntries()]
							.filter((entry) => entry !== null)
							.map((entry) => JSON.stringify(entry))
							.join("\n")}\n`,
					);
		const report = inspectSessionIntegrity(bytes, { activeLeafId: this.sessionManager.getLeafId() });
		const branchEntries = report.activeBranch;
		let latestCompactionIndex = -1;
		for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
			if (branchEntries[index]?.type === "compaction") {
				latestCompactionIndex = index;
				break;
			}
		}
		const latestCompaction = branchEntries[latestCompactionIndex];
		const firstKeptIndex =
			latestCompaction?.type === "compaction"
				? branchEntries.findIndex((entry) => entry.id === latestCompaction.firstKeptEntryId)
				: -1;
		const sourceEntries = branchEntries.slice(
			latestCompactionIndex < 0 ? 0 : firstKeptIndex < 0 ? latestCompactionIndex : firstKeptIndex,
		);
		const firstEntry = sourceEntries[0];
		const lastEntry = sourceEntries.at(-1);
		if (!firstEntry || !lastEntry || report.activeLeafId === null) {
			const barrier = evaluateCompactionBarrier(report, [...this.agent.state.pendingToolCalls]);
			if (barrier.status !== "ready") throw this._barrierError(barrier);
			throw new Error("Nothing to compact: the active session branch is empty");
		}
		const revision = this.sessionManager.getDurableHeadToken();
		const source = createCompactionSourceIdentity({
			sessionId: revision.sessionId,
			entryIds: sourceEntries.map((entry) => entry.id),
			firstEntryId: firstEntry.id,
			lastEntryId: lastEntry.id,
			sourceSha256: createHash("sha256")
				.update(sourceEntries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8")
				.digest("hex"),
			activeLeafId: report.activeLeafId,
			messageCount: report.activeMessages.length,
		});
		return { report, branchEntries, revision, source };
	}

	private _captureCompactionProvenance(capture: CapturedCompactionState): CompactionPreservedProvenanceInput {
		let latestIntent = "Continue the current session";
		for (let index = capture.report.activeMessages.length - 1; index >= 0; index -= 1) {
			const message = capture.report.activeMessages[index];
			if (message?.role !== "user") continue;
			const candidate = sanitizeBinaryOutput(redactSensitiveText(this._getUserMessageText(message)).trim()).slice(
				0,
				16_384,
			);
			if (candidate.length > 0) latestIntent = candidate;
			break;
		}
		const modelHistory = capture.branchEntries
			.flatMap((entry) => {
				if (entry.type === "model_change") {
					return [{ entryId: entry.id, provider: entry.provider, modelId: entry.modelId }];
				}
				if (entry.type === "message" && entry.message.role === "assistant") {
					return [{ entryId: entry.id, provider: entry.message.provider, modelId: entry.message.model }];
				}
				return [];
			})
			.slice(-256);
		const customEntryIds = (customType: string): string[] =>
			capture.branchEntries
				.filter((entry) => entry.type === "custom" && entry.customType === customType)
				.map((entry) => entry.id);
		return {
			latestIntent,
			openTasks: [],
			laneIds: customEntryIds("lane"),
			acceptancePredicateIds: customEntryIds("acceptance_predicate"),
			evidenceReceiptIds: customEntryIds("evidence_receipt"),
			blockerReasons: [],
			repairEventIds: [
				...customEntryIds("transcript_repaired"),
				...customEntryIds("compaction_transcript_repaired"),
			],
			branch: null,
			worktree: this._cwd,
			modelHistory,
			nextAction: latestIntent,
		};
	}

	private _barrierError(barrier: CompactionBarrierResult): Error {
		if (barrier.status === "defer") {
			return new Error(`Compaction deferred until the transcript closes (${barrier.reason})`);
		}
		return new Error(
			`Compaction failed closed on transcript integrity (${barrier.reason}). Run the session doctor before retrying.`,
		);
	}

	private _evaluateCompactionBarrier(
		capture: CapturedCompactionState,
		includeMissingTailAsPending: boolean,
		excludedPendingIds: ReadonlySet<string> = new Set(),
	): CompactionBarrierResult {
		const pending = new Set(
			[...this.agent.state.pendingToolCalls].filter((toolCallId) => !excludedPendingIds.has(toolCallId)),
		);
		if (includeMissingTailAsPending) {
			for (const issue of capture.report.transcript?.issues ?? []) {
				if (issue.kind === "missing_result") pending.add(issue.toolCallId);
			}
		}
		return evaluateCompactionBarrier(capture.report, [...pending]);
	}

	private _repairEmergencyCompactionTail(capture: CapturedCompactionState): {
		readonly capture: CapturedCompactionState;
		readonly repairedToolCallIds: ReadonlySet<string>;
	} {
		const barrier = this._evaluateCompactionBarrier(capture, true);
		if (barrier.status !== "defer" || barrier.reason !== "missing_active_tail_results") {
			if (barrier.status !== "ready") throw this._barrierError(barrier);
			return { capture, repairedToolCallIds: new Set() };
		}
		const repairedMessages = repairTranscriptIntegrity(
			[...capture.report.activeMessages],
			"Tool result missing; synthesized to close an emergency compaction barrier",
		);
		const inserted = repairedMessages.slice(capture.report.activeMessages.length);
		const repairedToolCallIds = new Set<string>();
		for (const message of inserted) {
			if (message.role !== "toolResult") {
				throw new Error("Emergency compaction repair produced a non-tool result");
			}
			const toolResult: ToolResultMessage = message;
			repairedToolCallIds.add(toolResult.toolCallId);
			this.sessionManager.appendMessage(toolResult);
		}
		this.sessionManager.appendCustomEntry("compaction_transcript_repaired", {
			insertedToolCallIds: [...repairedToolCallIds],
			reason: "emergency_compaction",
		});
		this._invalidateContextBudgetCache({ type: "transcriptRepair" });
		const closedCapture = this._captureCompactionState();
		const closedBarrier = this._evaluateCompactionBarrier(closedCapture, false, repairedToolCallIds);
		if (closedBarrier.status !== "ready") throw this._barrierError(closedBarrier);
		this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
		return { capture: closedCapture, repairedToolCallIds };
	}

	private _priorCommittedCompactionSourceDigests(): string[] {
		const digests: string[] = [];
		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type !== "compaction" || typeof entry.details !== "object" || entry.details === null) continue;
			if (!Object.hasOwn(entry.details, "compactionEnvelope")) continue;
			const envelope = validateCompactionEnvelope(Reflect.get(entry.details, "compactionEnvelope"));
			if (envelope.summary !== entry.summary) {
				throw new Error(`Compaction entry ${entry.id} has invalid provenance. Run the session doctor.`);
			}
			digests.push(envelope.source.sourceSha256);
		}
		return digests;
	}

	private _beginCompactionTransaction(compactionModel: Model<Api>, emergency: boolean): BegunCompaction {
		let capture = this._captureCompactionState();
		if (emergency) {
			capture = this._repairEmergencyCompactionTail(capture).capture;
		} else {
			const barrier = this._evaluateCompactionBarrier(capture, false);
			if (barrier.status !== "ready") throw this._barrierError(barrier);
		}
		const transaction = createCompactionTransaction({
			transactionId: randomUUID(),
			baseRevision: capture.revision,
			source: capture.source,
			createdAt: new Date().toISOString(),
			model: { provider: compactionModel.provider, id: compactionModel.id },
			preserved: this._captureCompactionProvenance(capture),
		});
		if (this._priorCommittedCompactionSourceDigests().includes(transaction.source.sourceSha256)) {
			throw new Error("This exact compaction source was already compacted");
		}
		return { capture, transaction };
	}

	private _detailsWithCompactionEnvelope(details: unknown, envelope: CompactionEnvelope): unknown {
		if (typeof details === "object" && details !== null && !Array.isArray(details)) {
			return { ...details, compactionEnvelope: envelope };
		}
		return {
			compactionEnvelope: envelope,
			...(details === undefined ? {} : { resultDetails: details }),
		};
	}

	private _commitCompaction(
		begun: BegunCompaction,
		result: CompactionResult,
		fromExtension: boolean,
	): CommittedCompaction {
		if (!begun.transaction.source.entryIds.includes(result.firstKeptEntryId)) {
			throw new Error("Compaction first-kept entry is outside the captured source");
		}
		const committed = this.sessionManager.withCompactionCommitLock(() => {
			const current = this._captureCompactionState();
			const barrier = this._evaluateCompactionBarrier(current, false);
			const decision = decideCompactionCommit({
				transaction: begun.transaction,
				currentRevision: current.revision,
				currentSource: current.source,
				barrier,
				priorCommittedSourceDigests: this._priorCommittedCompactionSourceDigests(),
			});
			switch (decision.decision) {
				case "duplicate":
					throw new Error("This exact compaction source was already compacted");
				case "stale":
					throw new Error(
						`Session changed during compaction (${decision.reason}); generated summary was discarded`,
					);
				case "defer":
				case "fail_closed":
					throw this._barrierError(barrier);
				case "commit": {
					const envelope = createCompactionEnvelope({
						transaction: begun.transaction,
						decision,
						summary: result.summary,
						summarySha256: createHash("sha256").update(result.summary, "utf8").digest("hex"),
					});
					const entryId = this.sessionManager.appendCompaction(
						result.summary,
						result.firstKeptEntryId,
						result.tokensBefore,
						this._detailsWithCompactionEnvelope(result.details, envelope),
						fromExtension,
					);
					const entry = this.sessionManager.getEntry(entryId);
					if (!entry || entry.type !== "compaction") {
						throw new Error("Compaction commit did not produce a compaction entry");
					}
					return { entry, envelope };
				}
			}
		});
		this._recordCompactionCommitForHysteresis();
		return committed;
	}

	private _pendingToolResultReserve(settings: CompactionSettings): number {
		const pendingIds = this.agent.state.pendingToolCalls;
		const calls = new Map<string, { readonly name: string; readonly args: unknown }>();
		const streaming = this.agent.state.streamingMessage;
		const messages = streaming ? [...this.agent.state.messages, streaming] : this.agent.state.messages;
		for (const message of messages) {
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const part of message.content) {
				if (part.type === "toolCall" && pendingIds.has(part.id)) {
					calls.set(part.id, { name: part.name, args: part.arguments });
				}
			}
		}
		const counts: Record<ToolResultClass, number> = { text: 0, image: 0, "large-output": 0 };
		for (const id of pendingIds) {
			const call = calls.get(id);
			const resultClass = call ? pendingToolResultClass(call.name, call.args) : "large-output";
			counts[resultClass] += 1;
		}
		const requests: ToolResultReserveRequest[] = [];
		for (const resultClass of ["text", "image", "large-output"] as const) {
			if (counts[resultClass] > 0) {
				requests.push({
					class: resultClass,
					count: counts[resultClass],
					tokensPerResult: PENDING_TOOL_RESULT_TOKENS[resultClass],
				});
			}
		}
		const configured = settings.reservedToolResultTokens ?? 0;
		requests.push({ class: "large-output", count: 1, tokensPerResult: configured });
		return estimateToolResultReserve(requests);
	}

	private _compactionHysteresisConfig(contextWindow: number, settings: CompactionSettings) {
		const threshold = getCompactionHeadroomThreshold(contextWindow, {
			...settings,
			reservedToolResultTokens: this._pendingToolResultReserve(settings),
		});
		if (!threshold) return undefined;
		const triggerRatio = Math.min(
			1,
			Math.max(1 / Math.floor(contextWindow), threshold.triggerTokens / contextWindow),
		);
		const configuredRearm = settings.rearmRatio ?? triggerRatio * 0.75;
		const rearmRatio = Math.min(configuredRearm, triggerRatio * 0.999);
		const emergencyRatio = Math.max(triggerRatio, settings.emergencyRatio ?? 0.98);
		return createCompactionHysteresisConfig({ rearmRatio, triggerRatio, emergencyRatio });
	}

	private _runtimeCompactionDecision(
		contextTokens: number,
		contextWindow: number,
		settings: CompactionSettings,
	): { readonly compact: boolean; readonly emergency: boolean } {
		if (!Number.isFinite(contextTokens) || contextTokens < 0) return { compact: false, emergency: false };
		const config = this._compactionHysteresisConfig(contextWindow, settings);
		if (!config) return { compact: false, emergency: false };
		const result = stepCompactionHysteresis({
			config,
			state: this._compactionHysteresisState,
			ratio: Math.min(1, contextTokens / contextWindow),
		});
		this._compactionHysteresisState = result.nextState;
		return { compact: result.action === "compact", emergency: result.reason === "emergency_threshold_reached" };
	}

	private async _runThresholdCompaction(emergency: boolean): Promise<boolean> {
		this._thresholdCompactionEmergency = emergency;
		try {
			return await this._runAutoCompaction("threshold", false);
		} finally {
			this._thresholdCompactionEmergency = false;
		}
	}

	private _recordCompactionCommitForHysteresis(): void {
		const contextWindow = this.model?.contextWindow ?? 0;
		const config = this._compactionHysteresisConfig(contextWindow, this.settingsManager.getCompactionSettings());
		if (!config) return;
		this._compactionHysteresisState = stepCompactionHysteresis({
			config,
			state: this._compactionHysteresisState,
			ratio: 0,
			outcome: "commit",
		}).nextState;
	}

	private _resolveCompactionModel(sessionModel: Model<Api>): Model<Api> {
		const configuredModel = this.settingsManager.getCompactionModel();
		const availableModels = this._modelRegistry.getAvailable();
		let model: Model<Api>;
		if (configuredModel) {
			const configured = findExactModelReferenceMatch(configuredModel, availableModels);
			if (!configured) {
				throw new Error(`Configured compaction model "${configuredModel}" is unavailable or unauthenticated.`);
			}
			model = configured;
		} else {
			model = resolveCompactionModel(sessionModel, availableModels);
		}
		this._invalidateContextBudgetCache({
			type: "compactionModelId",
			value: this._contextCacheModelId(model),
		});
		return model;
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		this._disconnectFromAgent();
		await this.abort();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });
		let committedCompaction = false;

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const compactionModel = this._resolveCompactionModel(this.model);
			const { apiKey, headers } = await this._getCompactionRequestAuth(compactionModel);

			const settings = this.settingsManager.getCompactionSettings();
			const begun = this._beginCompactionTransaction(compactionModel, false);
			const pathEntries = [...begun.capture.branchEntries];

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const result = await compact(
					preparation,
					compactionModel,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFn,
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
			};
			const committed = this._commitCompaction(begun, compactionResult, fromExtension);
			committedCompaction = true;
			this.agent.state.messages = this.sessionManager.buildSessionContext().messages;

			if (this._extensionRunner) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: committed.entry,
					fromExtension,
				});
			}
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			const stale = /stale|session changed during compaction|already compacted/i.test(message);
			const timestamp = new Date().toISOString();
			this._publishTermination(
				classifySessionTermination({
					sessionId: this.sessionId,
					runId: `compaction-${randomUUID()}`,
					timestamp,
					source: "observed",
					message: this._terminationMessage(message, "Manual compaction failed."),
					cause: { area: "compaction", code: aborted ? "aborted" : stale ? "stale" : "failed" },
					sideEffects: committedCompaction ? "confirmed" : "none",
					...(this.model ? { provider: this.model.provider, model: this.model.id } : {}),
				}),
			);
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this._compactionAbortController = undefined;
			this._reconnectToAgent();
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	private async _checkProjectedCompaction(pendingMessages: AgentMessage[]): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled || pendingMessages.length === 0) return false;

		const contextWindow = this.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return false;

		const messages = [...this.agent.state.messages, ...pendingMessages];
		const estimate = estimateProjectedContextTokens(this.agent.state.messages, pendingMessages);
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		if (estimate.lastUsageIndex !== null && compactionEntry) {
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
		}

		const decision = this._runtimeCompactionDecision(estimate.tokens, contextWindow, settings);
		if (decision.compact) {
			return await this._runThresholdCompaction(decision.emergency);
		}
		return false;
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Case 1: Overflow - LLM returned context overflow error
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			if (this._overflowRecoveryAttempted) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}

			this._overflowRecoveryAttempted = true;
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", true);
		}

		// Case 2: Threshold - context is getting large
		// For error messages (no usage data), estimate from last successful response.
		// This ensures sessions that hit persistent API errors (e.g. 529) can still compact.
		let contextTokens: number;
		if (assistantMessage.stopReason === "error") {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return false; // No usage data at all
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = calculateContextTokens(assistantMessage.usage);
		}
		const decision = this._runtimeCompactionDecision(contextTokens, contextWindow, settings);
		if (decision.compact) {
			return await this._runThresholdCompaction(decision.emergency);
		}
		return false;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private async _runAutoCompaction(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		emergency = reason === "overflow" || this._thresholdCompactionEmergency,
	): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();

		this._emit({ type: "compaction_start", reason });
		this._autoCompactionAbortController = new AbortController();

		try {
			if (!this.model) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
				});
				return false;
			}

			const compactionModel = this._resolveCompactionModel(this.model);
			let apiKey: string | undefined;
			let headers: Record<string, string> | undefined;
			if (this.agent.streamFn === streamSimple) {
				const authResult = await this._modelRegistry.getApiKeyAndHeaders(compactionModel);
				if (!authResult.ok || !authResult.apiKey) {
					const providerLabel = compactionModel.provider;
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: false,
						willRetry: false,
						errorMessage:
							`Auto-compaction could not authenticate for "${providerLabel}" (${compactionModel.id}). ` +
							`Check proxy/OAuth health and run '/login ${providerLabel}' if needed.`,
					});
					return false;
				}
				apiKey = authResult.apiKey;
				headers = authResult.headers;
			} else {
				({ apiKey, headers } = await this._getCompactionRequestAuth(compactionModel));
			}

			const begun = this._beginCompactionTransaction(compactionModel, emergency);
			const pathEntries = [...begun.capture.branchEntries];

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
				});
				return false;
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return false;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const compactResult = await compact(
					preparation,
					compactionModel,
					apiKey,
					headers,
					undefined,
					this._autoCompactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFn,
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
			}

			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return false;
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
			};
			const committed = this._commitCompaction(begun, result, fromExtension);
			this.agent.state.messages = this.sessionManager.buildSessionContext().messages;

			if (this._extensionRunner) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: committed.entry,
					fromExtension,
				});
			}
			const emitWillRetry = compactionEmitWillRetry(willRetry, this.agent.hasQueuedMessages());
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry: emitWillRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`,
			});
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRegistry.find(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					this.sessionManager.appendCustomEntry(customType, data);
					this._recordEvidenceReceiptInvalidation(customType);
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this.modelRegistry.hasConfiguredAuth(model)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
				// Optional: no in-process MCP client manager yet. Leave unbound so
				// ExtensionAPI.callMcpTool remains present (load-time capture) but throws
				// until a session-level handler is provided. Tests / future MCP hub bind here.
				callMcpTool: undefined,
			},
			{
				getModel: () => this.model,
				isIdle: () => !this.isStreaming,
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRegistry.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRegistry.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		if (this._loadoutAccessPolicy) {
			const shadowedBuiltins = normalizeToolNames(
				allCustomTools.map((tool) => tool.definition.name).filter((name) => this._baseToolDefinitions.has(name)),
			);
			if (shadowedBuiltins.length > 0) {
				throw new Error(`loadout extension tool shadows builtin: ${shadowedBuiltins.join(", ")}`);
			}
		}

		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		if (this._loadoutAccessPolicy) {
			const missingLockedTools = this._loadoutAccessPolicy.activeTools.filter(
				(toolName) => !isAllowedTool(toolName) || !this._toolRegistry.has(toolName),
			);
			if (missingLockedTools.length > 0) {
				throw new Error(`loadout locked tool unavailable: ${missingLockedTools.join(", ")}`);
			}
			this.setActiveToolsByName([...this._loadoutAccessPolicy.activeTools]);
			return;
		}

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const loadoutAccessPolicy = this._loadoutAccessPolicy;
		const loadoutAccessGuard = loadoutAccessPolicy
			? (request: Parameters<typeof decideLoadoutAccess>[1]) => decideLoadoutAccess(loadoutAccessPolicy, request)
			: undefined;
		const loadoutReadOptions = loadoutAccessGuard
			? {
					canReadPath: (path: string) => loadoutAccessGuard({ operation: "read", toolName: "read", path }).allowed,
				}
			: {};
		const loadoutWriteOptions = loadoutAccessGuard
			? {
					canWritePath: (path: string) =>
						loadoutAccessGuard({ operation: "write", toolName: "write", path }).allowed,
				}
			: {};
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages, ...loadoutReadOptions },
					bash: {
						commandPrefix: shellCommandPrefix,
						shellPath,
						...(loadoutAccessGuard ? { loadoutAccessGuard } : {}),
					},
					edit: loadoutWriteOptions,
					write: loadoutWriteOptions,
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			this._modelRegistry,
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(): Promise<void> {
		const previousFlagValues = this._extensionRunner.getFlagValues();
		await emitSessionShutdownEvent(this._extensionRunner, { type: "session_shutdown", reason: "reload" });
		await this.settingsManager.reload();
		this._invalidateContextBudgetCache({ type: "settings" });
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	private _isNonRetryableProviderLimitError(errorMessage: string): boolean {
		return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
			errorMessage,
		);
	}

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		// Context overflow is handled by compaction, not retry
		const contextWindow = this.model?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		const err = message.errorMessage;
		if (this._isNonRetryableProviderLimitError(err)) return false;
		// Shared contract with provider-resilience.ts (Fable safety stop, K3 orphan tool_call_id, terminated).
		return isTransientProviderErrorMessage(err);
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	/** Eject sticky safety model at prompt boundary (session resume / leftover default). */
	private async _ejectStickySafetyModelIfNeeded(): Promise<void> {
		const resilience = resolveProviderResilience(this.settingsManager.getProviderResilienceSettings());
		if (!resilience.blockStickySafetyModels) return;
		const current = this.model;
		if (!current || !isStickySafetyModel(current.id, current.provider)) return;

		const pick = pickFailoverCandidate(
			resilience.failoverCandidates,
			{ provider: current.provider, id: current.id },
			(c) => {
				const next = this._modelRegistry.find(c.provider, c.id);
				return !!next && this._modelRegistry.hasConfiguredAuth(next);
			},
		);
		if (!pick) {
			throw new Error(stickySafetyBlockMessage(current.id, current.provider));
		}
		const next = this._modelRegistry.find(pick.provider, pick.id);
		if (!next) {
			throw new Error(stickySafetyBlockMessage(current.id, current.provider));
		}
		// Bypass setModel sticky check by temporarily allowing via direct state switch path:
		// setModel itself blocks sticky targets, not sources — safe.
		await this.setModel(next);
	}

	/**
	 * Sticky safety models (e.g. claude-fable-5) often false-positive on coding turns.
	 * Retrying the same model repeats the refusal — switch via provider-resilience chain first.
	 */
	private async _maybeFailoverFromSafetyStop(message: AssistantMessage): Promise<string | undefined> {
		const resilience = resolveProviderResilience(this.settingsManager.getProviderResilienceSettings());
		if (!resilience.autoFailoverOnSafetyStop) return undefined;
		if (!isContentSafetyStopMessage(message.errorMessage)) return undefined;

		const current = this.model;
		const currentId = message.model || current?.id || "";
		const currentProvider = message.provider || current?.provider || "";
		if (!isStickySafetyModel(currentId, currentProvider)) return undefined;

		const pick = pickFailoverCandidate(
			resilience.failoverCandidates,
			current ? { provider: current.provider, id: current.id } : undefined,
			(c) => {
				const next = this._modelRegistry.find(c.provider, c.id);
				return !!next && this._modelRegistry.hasConfiguredAuth(next);
			},
		);
		if (!pick) return undefined;

		const next = this._modelRegistry.find(pick.provider, pick.id);
		if (!next) return undefined;
		try {
			await this.setModel(next);
			return `${next.provider}/${next.id}`;
		} catch {
			return undefined;
		}
	}

	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		// Content/safety stop on Fable: switch model BEFORE delay so the retry is not another Fable refusal.
		const failoverTo = await this._maybeFailoverFromSafetyStop(message);
		// Safety stops are usually immediate false positives — short delay after failover, full backoff otherwise.
		const delayMs = failoverTo
			? Math.min(400, settings.baseDelayMs)
			: settings.baseDelayMs * 2 ** (this._retryAttempt - 1);
		const errorMessage = failoverTo
			? `${message.errorMessage || "content/safety stop"} → failover ${failoverTo}`
			: message.errorMessage || "Unknown error";

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage,
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 * @param options.safetyGate When "headless", pre-classify the command and deny confirm/block-tier verdicts without interactive confirmation
	 * @param options.sandboxPolicy Trusted sandbox preflight for local bash execution (never sourced from RPC payloads)
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: ExecuteBashOptions,
	): Promise<BashResult> {
		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;
		if (this._loadoutAccessPolicy) {
			assertLoadoutAccess(
				(request) => decideLoadoutAccess(this._loadoutAccessPolicy as LoadoutAccessPolicy, request),
				{ operation: "execute", toolName: "bash", command: resolvedCommand },
			);
		}

		// Non-negotiable safety floor for headless callers (RPC bash): hard-deny
		// block-tier commands and credential/secret file access before any shell is
		// spawned. This mirrors the §0.1 freedom safety floor behavior in omakit.
		if (options?.safetyGate === "headless") {
			const floorVerdict = classifyShellCommand(command);
			if (floorVerdict.risk === "block" || floorVerdict.rule.startsWith("secret.")) {
				throw new Error(`OMK §0.1 safety floor blocked bash: [${floorVerdict.rule}] ${floorVerdict.reason}`);
			}
		}

		// Command-safety parity for non-interactive callers (RPC bash). Interactive
		// `!`/`!!` bash is gated earlier through the user_bash extension event, which
		// keeps its prompt-based approval semantics, so it does not pass safetyGate and
		// is never double-prompted here. confirm/block-tier verdicts deny headlessly;
		// the EFFECTIVE command (after the shell command prefix) is classified.
		if (options?.safetyGate === "headless") {
			const decision = await evaluateCommandGate(resolvedCommand, {
				hasUI: false,
				headlessConfirmPolicy: isCommandSafetyAssumeYesEnabled() ? "allow" : "deny",
			});
			if (decision?.deny) {
				const blocked = buildBlockedBashResult(decision.reason);
				this.recordBashResult(command, blocked, options);
				return blocked;
			}
		}

		this._bashAbortController = new AbortController();

		try {
			try {
				const result = await executeBashWithOperations(
					resolvedCommand,
					this.sessionManager.getCwd(),
					options?.operations ??
						createLocalBashOperations({
							shellPath,
							sandboxPolicy: this._getBashSandboxPreflight(options?.sandboxPolicy),
						}),
					{
						onChunk,
						signal: this._bashAbortController.signal,
					},
				);

				this.recordBashResult(command, result, options);
				return result;
			} catch (error) {
				if (!isSandboxDeniedError(error)) {
					throw error;
				}
				const blocked = buildSandboxDeniedBashResult(error.message);
				this.recordBashResult(command, blocked, options);
				return blocked;
			}
		} finally {
			this._bashAbortController = undefined;
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this._bashAbortController?.abort();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortController !== undefined;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		this._emit({ type: "session_info_changed", name: this.sessionManager.getSessionName() });
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
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

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { apiKey, headers } = await this._getRequiredRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFn,
				});
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
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = this._extractUserMessageText(targetEntry.message.content);
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
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
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics.
	 */
	getSessionStats(): SessionStats {
		const state = this.state;
		const userMessages = state.messages.filter((m) => m.role === "user").length;
		const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
		const toolResults = state.messages.filter((m) => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
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
			contextUsage: this.getContextUsage(),
		};
	}

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

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const themeName = this.settingsManager.getTheme();

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
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
			.find((m) => {
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

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}

// ---------------------------------------------------------------------------
// Context budget constants
// ---------------------------------------------------------------------------

/** Fraction of contextWindow reserved for model response generation. */
const RESPONSE_RESERVE_RATIO = 0.2;
/** Fraction of contextWindow held back as safety margin for token-count imprecision. */
const SAFETY_MARGIN_RATIO = 0.1;
// Default prompt budget = contextWindow - responseReserve - safetyMargin.
// With the defaults above (0.2 + 0.1) this yields ~0.70 of contextWindow, but it
// stays correct when responseReserve is overridden by model.maxTokens.
/** Absolute floor for maxPromptTokens — below this the budget is meaningless. */
const MIN_PROMPT_TOKENS = 4000;
/** Legacy defaults when no model contextWindow is known. */
const LEGACY_MAX_PROMPT_TOKENS = 60_000;
const LEGACY_RESPONSE_RESERVE_TOKENS = 8_192;

function parsePositiveIntegerEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") {
		return undefined;
	}
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parsePositiveFloatEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") {
		return undefined;
	}
	const value = Number.parseFloat(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseTokenizerModeEnv(
	value: string | undefined,
): NonNullable<BuildSystemPromptOptions["contextBudget"]>["tokenizerMode"] {
	switch (value) {
		case "fallback":
		case "openai-js":
		case "openai-wasm":
		case "auto":
			return value;
		default:
			return "fallback";
	}
}

function parseCommaSeparatedEnv(value: string | undefined): string[] {
	if (value === undefined || value.trim() === "") {
		return [];
	}
	return Array.from(
		new Set(
			value
				.split(",")
				.map((item) => item.trim())
				.filter((item) => item.length > 0),
		),
	);
}
