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
import { basename, dirname, join as joinPath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Agent, AgentEvent, AgentMessage, AgentState, AgentTool, ThinkingLevel } from "omk-agent-core";
import { getVisionRouteModel } from "omk-agent-core";
import type { Api, AssistantMessage, ImageContent, Message, Model, TextContent } from "omk-ai";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	deriveContextPromptCacheKey,
	getSupportedThinkingLevels,
	isBuiltinStreamFn,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
} from "omk-ai";
import { APP_NAME, VERSION } from "../config.ts";
import type { ReplayLedgerManager } from "../guardrails/evidence-system.ts";
import type { VerifiedEvidenceExecutor } from "../guardrails/verified-executor.ts";
import { theme } from "../modes/interactive/theme/theme.ts";
import type { ReplayEventType } from "../types/evidence.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import { getShellConfig } from "../utils/shell.ts";
import { sleep } from "../utils/sleep.ts";
import { type AdaptorchBridge, type AdaptorchConsultPayload, createAdaptorchBridge } from "./adaptorch-bridge.ts";
import {
	applyCategoryTimeoutDefaults,
	resolveAgentToolSettings,
	resolveToolTimeoutCategory,
} from "./agent-tool-settings.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { parseBangInvocation } from "./bang-skill-invocation.ts";
import type { BashResult } from "./bash-executor.ts";
import { type CompactionSettings, getCompactionHeadroomThreshold } from "./compaction/compaction.ts";
import {
	type CompactionHysteresisState,
	createCompactionHysteresisConfig,
	createCompactionHysteresisState,
	stepCompactionHysteresis,
} from "./compaction/hysteresis.ts";
import {
	type CompactionPreparation,
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
import { summarizeWithOAuthRecovery } from "./compaction/oauth-recovery.ts";
import { compactionEmitWillRetry } from "./compaction/resume-policy.ts";
import { isSessionModelOverflow, shouldSkipCompactionCheck } from "./compaction-gate.ts";
import {
	estimateToolResultReserve,
	type ToolResultClass,
	type ToolResultReserveRequest,
} from "./context-budget-reserved-tokens.ts";
import {
	createDiskContextBudgetCacheProviderV2,
	DiskContextBudgetCacheProviderV2,
} from "./context-budget-v2-cache-disk.ts";
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
import { captureHostResourceSnapshot, type HostResourceSnapshot } from "./host-resource-snapshot.ts";
import { decideLoadoutAccess, type LoadoutAccessPolicy } from "./loadout-access-policy.ts";
import { loadMcpServerConfigs } from "./mcp/config.ts";
import { McpManager, type McpServerConfig, type McpServerStatus } from "./mcp/manager.ts";
import { buildRuntimeProvenance } from "./runtime-provenance.ts";
import { type ToolCallMetric, TurnMetricsSink } from "./turn-metrics.ts";

/** Values that disable a session-level feature through its environment variable. */
const DISABLED_ENV_VALUES = new Set(["0", "false", "off", "disable", "disabled"]);
const MAX_OVERFLOW_RECOVERY_ATTEMPTS = 2;
const OVERFLOW_RECOVERY_EMERGENCY_TOKENS = 4_096;
const MAX_RESOURCE_OBSERVATION_JOURNALS = 32;
/**
 * Token headroom demanded before a compaction run.
 *
 * Compaction resolves auth once and then reuses that token for a summarization
 * that can stream for minutes and be retried with backoff. A token accepted
 * with only seconds of validity left comes back as a provider 401 mid-run
 * ("authentication token is expired"), which reads as a compaction failure.
 * Refreshing up front is cheap; failing a long compaction is not.
 */
const COMPACTION_MIN_TOKEN_VALIDITY_MS = 10 * 60 * 1000;

function isDisabledEnvValue(value: string | undefined): boolean {
	return value !== undefined && DISABLED_ENV_VALUES.has(value.trim().toLowerCase());
}

/** In-flight metric accumulation for the current turn. */
interface TurnMetricsState {
	readonly startedAtEpochMs: number;
	readonly toolCalls: ToolCallMetric[];
	readonly toolStarts: Map<string, number>;
	/** `provider/model` the turn was requested with, captured at turn start. */
	readonly requestedModel: string | null;
	/** `"auto"` in auto mode, else the thinking level captured at turn start. */
	readonly requestedThinking: string;
}

type RouterAutoDecision = Pick<
	RouterFeedbackRecord,
	"routerVersion" | "laneType" | "predictedClass" | "resolvedLevel" | "lenBucket" | "hadFence" | "hadDiff"
>;

/** Extract the first text block of a tool result, for failure classification only. */
function firstTextContent(result: unknown): string | undefined {
	const content = (result as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") return text;
		}
	}
	return undefined;
}

import { createImmutableMessageSnapshot } from "./agent-session-snapshot.ts";
import { redactCredentialShapedContent } from "./compaction/transaction.ts";
import type { CustomMessage } from "./messages.ts";
import { selectContextFilesForModel } from "./model-prompt-policy.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { findExactModelReferenceMatch } from "./model-resolver.ts";
import { computePromptTokenBudget } from "./prompt-budget.ts";
import { classifyPromptCacheTransition } from "./prompt-cache.ts";
import * as promptSettlement from "./prompt-settlement.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import {
	isQuotaExhaustionMessage,
	isStickySafetyModel,
	isUpstreamUnavailableMessage,
	pickFailoverCandidate,
	resolveFailoverCandidates,
	resolveProviderResilience,
	sameModelRouteCandidates,
	shouldEjectStickySafetyModel,
	shouldHonorSafetyFailover,
	stickySafetyBlockMessage,
} from "./provider-resilience.ts";
import {
	computeRetryDelayMs,
	failoverModelKey,
	isFailoverTriggerError,
	isRetryableAssistantError,
	nextRetryAttempt,
	retryBudgetForAssistantError,
} from "./provider-retry.ts";
import { getBiasStepsForCell, parseRouterBiasSnapshot, type RouterBiasSnapshot } from "./reasoning-router-bias.ts";
import {
	classifyTaskV4,
	deriveRouterFeedbackFeaturesV4,
	type RouterFeedbackFeaturesV4,
	resolveThinkingLevelV4WithUncertainty,
	TASK_CLASS_THINKING_LEVELS_V4,
	type TaskClassV4,
} from "./reasoning-router-v4.ts";
import { redactSensitiveText, redactSensitiveTextForced } from "./redaction.ts";
import { getRepositoryRouterLearningPaths, type RepositoryRouterLearningPaths } from "./repository-learning-scope.ts";
import { decideResourceAdmission, type ResourceAdmissionDecision } from "./resource-admission.ts";
import { resolveResourceGovernorSettings } from "./resource-governor-settings.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import {
	admissionObservationFacts,
	classificationObservationFacts,
	ResourceObservationJournal,
	settledObservationFacts,
	snapshotObservationFacts,
	soundObservationFacts,
} from "./resource-observation-journal.ts";
import { decideResourceSafetyGate, RESOURCE_PRESSURE_REQUIRED_ACTION } from "./resource-safety-gate.ts";
import {
	appendRouterFeedbackRecord,
	ROUTER_FEEDBACK_LEVELS,
	type RouterFeedbackRecord,
} from "./router-feedback-collector.ts";
import type { RunJournalAuditDetails, RunJournalAuditEvent, RunJournalRecord } from "./run-journal.ts";
import { type RunJournalQuarantineReport, RunJournalStore } from "./run-journal-store.ts";
import { type RunResourceLease, RunResourceLeaseController } from "./run-resource-lease.ts";
import { SessionBashRuntime } from "./session-bash-runtime.ts";
import { type BashResourcePermitGrant, SessionBashService } from "./session-bash-service.ts";
import { SessionCompactionService } from "./session-compaction-service.ts";
import {
	preflightFailureCause,
	providerFailureCause,
	runtimeFailureCause,
	terminationMessage,
} from "./session-failure-cause.ts";
import type { BranchSummaryEntry, SessionManager } from "./session-manager.ts";
import { CURRENT_SESSION_VERSION, getLatestCompactionEntry, type SessionHeader } from "./session-manager.ts";
import { acquireSessionOwnerLeaseSync, type SessionOwnerLease } from "./session-owner-lease.ts";
import { assembleSessionSystemPrompt } from "./session-system-prompt.ts";
import {
	classifySessionTermination,
	type SessionProcessSignal,
	type SessionTermination,
	type SessionTerminationCause,
} from "./session-termination.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { type BuildSystemPromptOptions, buildSystemPromptPlan } from "./system-prompt.ts";
import { type BashOperations, type BashSandboxPreflight, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { createVerifiedBashOperations } from "./verified-bash-adapter.ts";
import { resolveSessionWorkspaceScope } from "./verified-bash-runtime.ts";
import { classifyWorkloadCommand } from "./workload-classifier.ts";
import { WorkloadPermitError, WorkloadPermitPool, type WorkloadPermitPoolSnapshot } from "./workload-permit-pool.ts";

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
	| promptSettlement.PromptSettledEvent
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
	| { type: "bash_execution_update"; id?: string; delta: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
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
	/** True when the user pinned `--model` / `--provider` for this process. */
	modelPinned?: boolean;
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
	/** Optional identifier echoed in `bash_execution_update` events (RPC request correlation). */
	id?: string;
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
	promptCache: {
		providerEligibleInputTokens: number;
		providerHitRate: number;
		keyChanges: number;
		boundaryBypasses: number;
		stablePrefixCharacters: number;
		lastBreakReason?: string;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

type BegunCompaction = import("./session-compaction-service.ts").BegunCompaction;
type CommittedCompaction = import("./session-compaction-service.ts").CommittedCompaction;

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
	return [...new Set(toolNames.map((name) => name.trim()).filter((name) => name !== ""))].sort((left, right) => {
		if (left < right) return -1;
		if (left > right) return 1;
		return 0;
	});
}

function toolNameSetsEqual(left: readonly string[], right: readonly string[]): boolean {
	const normalizedLeft = normalizeToolNames(left);
	const normalizedRight = normalizeToolNames(right);
	return (
		normalizedLeft.length === normalizedRight.length &&
		normalizedLeft.every((toolName, index) => toolName === normalizedRight[index])
	);
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
	private _lastAutoRouterDecision: RouterAutoDecision | undefined;

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
	private _overflowRecoveryAttempts = 0;
	private _thresholdCompactionEmergency = false;
	private _compactionHysteresisState: CompactionHysteresisState = createCompactionHysteresisState();

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	// v10.3-Ω: models that already refused/failed this turn — failover must advance,
	// not re-pick the same candidate (claude-opus-5 → grok → grok → grok loop fix).
	private _refusedModels = new Set<string>();
	/** True when `--model` / `--provider` pinned this process to one model. */
	private readonly _modelPinned: boolean;

	// Bash execution state
	private readonly _bashService: SessionBashService;
	private readonly _compactionService: SessionCompactionService;

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _mcpManager: McpManager | undefined;
	private _mcpToolNames: Set<string> = new Set();
	private _turnMetricsSink: TurnMetricsSink | undefined;
	private _turnMetricsState: TurnMetricsState | undefined;
	private _cwd: string;
	private _repositoryRouterLearningPaths: RepositoryRouterLearningPaths | undefined;
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
	private _ownedSessionOwnerLease: SessionOwnerLease | undefined;
	private _activeRunId: string | null = null;
	// Resource governor (roadmap M2): lease controller owns the temporary tool
	// cap for governed runs; the last decision backs the §19.4 read-only API.
	private _resourceLeaseController: RunResourceLeaseController | undefined;
	private _resourceObservations: ResourceObservationJournal | null = null;
	private readonly _resourceObservationJournals = new Map<string, ResourceObservationJournal>();
	private _latestResourcePromptRunId: string | null = null;
	private _lastResourceAdmission: ResourceAdmissionDecision | null = null;
	private _workloadPermitPool: WorkloadPermitPool | undefined;
	private _pendingRuntimeTerminationCause: SessionTerminationCause | undefined;
	private _activeRunToolTermination:
		| { toolCallId: string; toolName: string; timeoutMs?: number; executionStarted: boolean }
		| undefined;
	private _lastTermination: SessionTermination | undefined;
	private _userAbortRequested = false;
	private readonly _replayLedger: ReplayLedgerManager | undefined;
	private readonly _replayGoalId: string | undefined;
	private readonly _replayLaneId: string | undefined;
	private readonly _bashRuntime: SessionBashRuntime;
	private _transcriptRepair: SessionTranscriptRepair | undefined;
	private _sessionRiskLevel: "normal" | "elevated" = "normal";
	private _workspaceMutationCount = 0;

	// Model registry for API key resolution
	private _modelRegistry: ModelRegistry;
	/** Lazy provider: representations persist per workspace by default; plans stay session-memory-only. */
	private _contextBudgetCacheProvider: ContextBudgetCacheProviderV2 | undefined;
	private _contextCacheInvalidationSnapshot: ContextCacheInvalidationSnapshot;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptCacheBoundary: number | undefined;
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _promptCacheKey: string | undefined;
	private _promptCacheKeyChanges = 0;
	private _promptCacheBoundaryBypasses = 0;
	private _promptCacheStablePrefixCharacters = 0;
	private _promptCacheLastBreakReason: string | undefined;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._modelPinned = config.modelPinned === true;
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

		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._transcriptRepair = config.transcriptRepair;
		this._replayLedger = config.replayLedger;
		this._replayGoalId = config.replayGoalId ?? config.replayLedger?.getLedger().goalId;
		this._replayLaneId = config.replayLaneId;
		if (this._replayLedger && this._replayGoalId !== this._replayLedger.getLedger().goalId) {
			throw new Error("AgentSession replayGoalId does not match the replay ledger goal id");
		}
		this._bashRuntime = new SessionBashRuntime({
			cwd: this._cwd,
			getExecutionCwd: () => this.sessionManager.getCwd(),
			getSessionFile: () => this.sessionManager.getSessionFile(),
			replayLedger: this._replayLedger,
			replayGoalId: this._replayGoalId,
			replayLaneId: this._replayLaneId,
			configuredSandboxPreflight: config.bashSandboxPreflight,
			appendReplayEvent: (type, payload) => this._appendReplayEvent(type, payload),
		});
		this._bashService = new SessionBashService({
			settings: this.settingsManager,
			runtime: this._bashRuntime,
			loadoutPolicy: this._loadoutAccessPolicy,
			getCwd: () => this.sessionManager.getCwd(),
			emit: (event) => this._emit(event),
			isStreaming: () => this.isStreaming,
			pushMessage: (message) => this.agent.state.messages.push(message),
			appendMessage: (message) => this.sessionManager.appendMessage(message),
			acquireResourcePermit: (command, signal) => this._acquireBashResourcePermit(command, signal),
		});
		this._compactionService = new SessionCompactionService({
			sessionManager: this.sessionManager,
			pendingToolCallIds: () => this.agent.state.pendingToolCalls,
			getUserMessageText: (message) => this._getUserMessageText(message),
			cwd: this._cwd,
			invalidateContextBudget: () => this._invalidateContextBudgetCache({ type: "transcriptRepair" }),
			refreshAgentMessages: () => {
				this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
			},
			recordCommit: () => this._recordCompactionCommitForHysteresis(),
		});
		const sessionFile = this.sessionManager.getSessionFile();
		let ownerLease = this.sessionManager.getOwnerLease();
		try {
			if (sessionFile && !ownerLease) {
				ownerLease = acquireSessionOwnerLeaseSync(sessionFile);
				this._ownedSessionOwnerLease = ownerLease;
				this.sessionManager.setOwnerLease(ownerLease);
			}
			this._runJournalStore = RunJournalStore.open({
				...(sessionFile ? { journalPath: `${sessionFile}.runjournal` } : {}),
				sessionId: this.sessionManager.getSessionId(),
				...(ownerLease ? { ownerLease } : {}),
			});
			const startupRecords = this._runJournalStore.records;
			const startupTerminal = startupRecords[startupRecords.length - 1];
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
		} catch (error) {
			const ownedLease = this._ownedSessionOwnerLease;
			if (ownedLease) {
				try {
					ownedLease.release();
					if (this.sessionManager.getOwnerLease() === ownedLease) this.sessionManager.setOwnerLease(undefined);
					this._ownedSessionOwnerLease = undefined;
				} catch {
					throw new Error("AgentSession initialization cleanup failed");
				}
			}
			throw error;
		}
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

	/** Lazy verified-bash executor bound to this session's replay ledger (default-on path). */
	private _getVerifiedEvidenceExecutor(): VerifiedEvidenceExecutor | undefined {
		return this._bashRuntime.verifiedEvidenceExecutor();
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

	private _classifyRunTermination(
		runId: string,
		event: Extract<AgentEvent, { type: "agent_end" }>,
	): SessionTermination {
		const timestamp = new Date().toISOString();
		let assistant: AssistantMessage | undefined;
		for (let index = event.messages.length - 1; index >= 0; index -= 1) {
			const message = event.messages[index];
			if (message?.role === "assistant") {
				assistant = message;
				break;
			}
		}
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
			message = terminationMessage(
				assistant.errorMessage,
				this._userAbortRequested ? "The user aborted the run." : "The provider aborted the run.",
			);
		} else if (assistant.stopReason === "error") {
			cause = providerFailureCause(assistant, this.model?.contextWindow ?? 0);
			message = terminationMessage(assistant.errorMessage, "The provider request failed.");
		} else {
			cause = { area: "completed" };
			message = "Run completed.";
		}

		let provider = this.model?.provider;
		if (assistant?.provider) provider = assistant.provider;
		let model = this.model?.id;
		if (assistant?.model) model = assistant.model;

		return classifySessionTermination({
			sessionId: this.sessionId,
			runId,
			timestamp,
			source: "observed",
			message,
			cause,
			sideEffects,
			...(provider ? { provider } : {}),
			...(model ? { model } : {}),
			...(toolCallId ? { toolCallId } : {}),
			...(toolName ? { toolName } : {}),
		});
	}

	private _publishTermination(termination: SessionTermination): void {
		this._lastTermination = termination;
		this._emit({ type: "session_termination", termination });
	}

	private _publishRuntimeFailure(error: unknown): void {
		const cause = this._pendingRuntimeTerminationCause ?? runtimeFailureCause(error);
		const runId = this._activeRunId ?? `runtime-${randomUUID()}`;
		const timestamp = new Date().toISOString();
		let message = "The AgentSession runtime failed before completing the run.";
		if (cause.area === "persistence") {
			message = "A required runtime persistence operation failed.";
		} else if (cause.area === "compaction") {
			message = "Runtime compaction failed.";
		}
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
		return this._bashRuntime.sandboxPreflight(override);
	}

	private async _getRequiredRequestAuth(
		model: Model<any>,
		options?: { minRemainingMs?: number },
	): Promise<{
		apiKey: string;
		headers?: Record<string, string>;
	}> {
		const result = await this._modelRegistry.getApiKeyAndHeaders(model, options);
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
		const options = { minRemainingMs: COMPACTION_MIN_TOKEN_VALIDITY_MS };
		if (isBuiltinStreamFn(this.agent.streamFn)) {
			return this._getRequiredRequestAuth(model, options);
		}

		const result = await this._modelRegistry.getApiKeyAndHeaders(model, options);
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
			this._overflowRecoveryAttempts = 0;
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
					this._overflowRecoveryAttempts = 0;
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
					this._refusedModels.clear();
				}
			}
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) return false;

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				const assistant = message as AssistantMessage;
				const maxRetries = retryBudgetForAssistantError(assistant, settings.maxRetries);
				return this._retryAttempt < maxRetries && this._isRetryableError(assistant);
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

		const matchingIndex = matchingIndexes[0];
		if (matchingIndex === undefined) {
			throw new Error("Finalized message was not found in agent state");
		}
		const finalizedReplacement = createImmutableMessageSnapshot(replacement);
		const nextMessages = [...messages];
		nextMessages[matchingIndex] = finalizedReplacement;
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
			// `agent_end` fires once per attempt. Extensions that release per-run
			// state need the boundary no retry follows, so mark it explicitly.
			if (!this._willRetryAfterAgentEnd(event)) {
				await this._extensionRunner.emit({ type: "agent_settled", messages: event.messages });
			}
		} else if (event.type === "turn_start") {
			this._turnMetricsState = {
				startedAtEpochMs: Date.now(),
				toolCalls: [],
				toolStarts: new Map(),
				requestedModel: this.model ? `${this.model.provider}/${this.model.id}` : null,
				requestedThinking: this.thinkingMode === "auto" ? "auto" : this.thinkingLevel,
			};
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			this._recordTurnMetrics(event.message);
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
			this._turnMetricsState?.toolStarts.set(event.toolCallId, Date.now());
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
			this._recordToolMetric(event.toolCallId, event.toolName, event.isError === true, event.result);
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
	 * Turn metrics sink for this session, created on first use.
	 *
	 * Writes to `<cwd>/.omk/metrics/`. Set `OMK_TURN_METRICS=0` to disable, or
	 * `OMK_TURN_METRICS_DIR` to relocate. Returns `undefined` when disabled, so
	 * every call site is a no-op rather than a branch.
	 */
	private _metricsSink(): TurnMetricsSink | undefined {
		if (isDisabledEnvValue(process.env.OMK_TURN_METRICS)) return undefined;
		if (!this._turnMetricsSink) {
			const dir = process.env.OMK_TURN_METRICS_DIR ?? joinPath(this._cwd, ".omk", "metrics");
			this._turnMetricsSink = new TurnMetricsSink({ dir });
		}
		return this._turnMetricsSink;
	}

	private _recordToolMetric(toolCallId: string, toolName: string, isError: boolean, result: unknown): void {
		const state = this._turnMetricsState;
		if (!state) return;
		const startedAt = state.toolStarts.get(toolCallId);
		state.toolStarts.delete(toolCallId);
		state.toolCalls.push({
			name: toolName,
			durationMs: startedAt === undefined ? 0 : Date.now() - startedAt,
			ok: !isError,
			...(isError ? { error: firstTextContent(result) } : {}),
		});
	}

	/** Persist one turn. Metrics are advisory: a failure here never affects the turn. */
	private _recordTurnMetrics(message: AgentMessage): void {
		const state = this._turnMetricsState;
		this._turnMetricsState = undefined;
		if (!state) return;
		const sink = this._metricsSink();
		if (!sink) return;
		const assistant = message.role === "assistant" ? message : undefined;
		const usage = assistant?.usage;
		const selectedModel = this.model ? `${this.model.provider}/${this.model.id}` : null;
		const runtimeProvenance = buildRuntimeProvenance({
			requestedModel: state.requestedModel,
			selectedModel,
			responseModel: assistant?.responseModel ?? (assistant ? `${assistant.provider}/${assistant.model}` : null),
			requestedThinking: state.requestedThinking,
			effectiveThinking: this.thinkingLevel,
			source: "session",
		});
		try {
			sink.record({
				sessionId: this.sessionId,
				turnIndex: this._turnIndex,
				provider: this.model?.provider,
				model: this.model?.id,
				startedAtEpochMs: state.startedAtEpochMs,
				endedAtEpochMs: Date.now(),
				stopReason: assistant?.stopReason,
				runtimeProvenance,
				usage: usage
					? {
							input: usage.input,
							output: usage.output,
							cacheRead: usage.cacheRead,
							cacheWrite: usage.cacheWrite,
							costUsd: usage.cost.total,
						}
					: undefined,
				toolCalls: state.toolCalls,
			});
		} catch {
			// Never let observability break a turn.
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
			if (this._contextBudgetCacheProvider instanceof DiskContextBudgetCacheProviderV2) {
				// Persist whatever the session rendered; a failed flush is never fatal.
				this._contextBudgetCacheProvider.close();
			}
			this._mcpManager?.close();
			this._mcpManager = undefined;
			cleanupSessionResources(this.sessionId);
		} finally {
			const ownerLease = this._ownedSessionOwnerLease;
			if (ownerLease) {
				ownerLease.release();
				if (this.sessionManager.getOwnerLease() === ownerLease) this.sessionManager.setOwnerLease(undefined);
				this._ownedSessionOwnerLease = undefined;
			}
		}
	}

	/**
	 * Build the context-budget cache provider for this session.
	 *
	 * Defaults to a workspace-layer provider persisted under `<cwd>/.omk/cache`,
	 * so a second session reuses representations the first one already rendered
	 * (representation keys are content-addressed; see
	 * `context-budget-v2-cache-keys.ts`). Set
	 * `OMK_CONTEXT_GOVERNOR_CACHE=memory` to opt out, or
	 * `OMK_CONTEXT_GOVERNOR_CACHE_DIR` to relocate the snapshot.
	 */
	private _createContextBudgetCacheProvider(): ContextBudgetCacheProviderV2 {
		if (process.env.OMK_CONTEXT_GOVERNOR_CACHE === "memory") {
			return createMemoryContextBudgetCacheProviderV2("session");
		}
		const dir =
			process.env.OMK_CONTEXT_GOVERNOR_CACHE_DIR ?? joinPath(this._cwd, ".omk", "cache", "context-budget-v2");
		try {
			return createDiskContextBudgetCacheProviderV2({ dir, layer: "workspace" });
		} catch {
			// An unusable cache directory must not take the session down.
			return createMemoryContextBudgetCacheProviderV2("session");
		}
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
		this.agent.state.systemPromptCacheBoundary = this._baseSystemPromptCacheBoundary;
		this.agent.state.systemPromptCacheBoundaryBypass = false;
		this._recordPromptCachePlan("tool-set");
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
			const msg = recent[i];
			if (!msg || !("role" in msg) || msg.role !== "user") {
				continue;
			}
			const content = (msg as { content: string | (TextContent | ImageContent)[] }).content;
			if (typeof content === "string") {
				const trimmed = content.trim();
				return trimmed.length > 0 ? trimmed : undefined;
			}
			if (Array.isArray(content)) {
				const textParts = content.flatMap((item) => (item.type === "text" ? [item.text] : []));
				const joined = textParts.join("\n").trim();
				return joined.length > 0 ? joined : undefined;
			}
		}
		return undefined;
	}

	private _getContextBudgetOptions(
		queryContext = this._extractCurrentQuery(),
		model: Model<any> | undefined = this.model,
	): BuildSystemPromptOptions["contextBudget"] | undefined {
		const contextGovernorOverride = process.env.OMK_CONTEXT_GOVERNOR;
		if (contextGovernorOverride === "0") {
			return undefined;
		}
		if (contextGovernorOverride !== "1" && !this.settingsManager.getContextBudgetEnabled()) {
			return undefined;
		}

		const contextWindow = model?.contextWindow ?? 0;
		const budget = computePromptTokenBudget({
			contextWindow,
			modelMaxTokens: model?.maxTokens,
			envMaxPromptTokens: parsePositiveIntegerEnv("OMK_CONTEXT_GOVERNOR_MAX_PROMPT_TOKENS"),
			envResponseReserveTokens: parsePositiveIntegerEnv("OMK_CONTEXT_GOVERNOR_RESPONSE_RESERVE_TOKENS"),
			envPromptRatio: parsePositiveFloatEnv("OMK_CONTEXT_GOVERNOR_PROMPT_RATIO"),
			envResponseRatio: parsePositiveFloatEnv("OMK_CONTEXT_GOVERNOR_RESPONSE_RATIO"),
		});
		const maxPromptTokens = budget.maxPromptTokens;
		const responseReserveTokens = budget.responseReserveTokens;

		const cacheProvider = this._contextBudgetCacheProvider ?? this._createContextBudgetCacheProvider();
		cacheProvider.setInvalidationSnapshot?.(this._contextCacheInvalidationSnapshot);
		this._contextBudgetCacheProvider = cacheProvider;

		return {
			maxPromptTokens,
			responseReserveTokens,
			modelId: model?.id ?? "unknown",
			tokenizerMode: parseTokenizerModeEnv(process.env.OMK_CONTEXT_GOVERNOR_TOKENIZER),
			activeSkillNames: parseCommaSeparatedEnv(process.env.OMK_CONTEXT_GOVERNOR_ACTIVE_SKILLS),
			queryContext,
			cacheProvider,
		};
	}

	/**
	 * Compute responseReserveTokens from contextWindow.
	 * Prefers the model's own maxTokens when available, otherwise uses a ratio.
	 */
	private _recordPromptCachePlan(reason: string): void {
		const boundary = this.agent.state.systemPromptCacheBoundary;
		const scope = this.model ? `${this.model.provider}/${this.model.id}` : "unknown";
		const nextKey = deriveContextPromptCacheKey(
			{
				systemPrompt: this.agent.state.systemPrompt,
				systemPromptCacheBoundary: boundary,
				systemPromptCacheBoundaryBypass: this.agent.state.systemPromptCacheBoundaryBypass,
				messages: [],
				tools: this.agent.state.tools,
			},
			scope,
		);
		const transition = classifyPromptCacheTransition(this._promptCacheKey, nextKey);
		if (transition.kind === "bypass") {
			this._promptCacheBoundaryBypasses += 1;
			this._promptCacheStablePrefixCharacters = 0;
			if (transition.recordBreak) {
				this._promptCacheLastBreakReason = reason;
			}
			this._promptCacheKey = undefined;
			return;
		}
		if (transition.kind === "changed") {
			this._promptCacheKeyChanges += 1;
			this._promptCacheLastBreakReason = reason;
		}
		this._promptCacheKey = nextKey;
		this._promptCacheStablePrefixCharacters = boundary ?? 0;
	}

	private _getDefaultActiveSkills(): string[] {
		const trustedSkillNames = new Set(
			this._resourceLoader
				.getSkills()
				.skills.filter((skill) => skill.sourceInfo.scope === "user")
				.map((skill) => skill.name),
		);
		return this.settingsManager.getDefaultActiveSkills().filter((name) => trustedSkillNames.has(name));
	}

	private _rebuildSystemPrompt(toolNames: string[], model: Model<any> | undefined = this.model): string {
		const defaultActiveSkills = this._getDefaultActiveSkills();
		const assembled = assembleSessionSystemPrompt({
			cwd: this._cwd,
			toolNames,
			hasTool: (name) => this._toolRegistry.has(name),
			toolPromptSnippets: this._toolPromptSnippets,
			toolPromptGuidelines: this._toolPromptGuidelines,
			customPrompt: this._resourceLoader.getSystemPrompt(),
			appendSystemPrompt: this._resourceLoader.getAppendSystemPrompt(),
			providerAppend: grokPlaybookAppendForProvider(model?.provider),
			skills: this._resourceLoader.getSkills().skills,
			activeSkillNames: defaultActiveSkills,
			activeSkillSource: defaultActiveSkills.length > 0 ? "settings" : undefined,
			contextFiles: selectContextFilesForModel(this._resourceLoader.getAgentsFiles().agentsFiles, model),
			contextBudget: this._getContextBudgetOptions(undefined, model),
		});
		this._baseSystemPromptOptions = assembled.options;
		this._baseSystemPromptCacheBoundary = assembled.cacheBoundary;
		return assembled.prompt;
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		// One identity per top-level run (§16.2): internal retries and
		// continuations inside this call share it, as does the resource lease.
		const promptRunId = `prompt-run-${randomUUID()}`;
		const startedAtEpochMs = Date.now();
		// Roadmap M2: the lease spans the whole run including internal retries
		// and continuations, so they share one admission decision (§8.3).
		const resourceLease = await this._beginResourceGovernedRun(promptRunId);
		const resourceObservations = this._resourceObservationJournals.get(promptRunId) ?? null;
		let outcome: promptSettlement.PromptSettlementOutcome = "completed";
		try {
			await this.agent.prompt(messages);
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} catch (error) {
			outcome = "failed";
			this._publishRuntimeFailure(error);
			throw error;
		} finally {
			outcome = promptSettlement.resolvePromptSettlementOutcome(outcome, this._lastTermination?.kind);
			if (resourceLease !== null) {
				// Generation-safe: a stale release after another run acquired the
				// lease is a no-op instead of clobbering the newer cap (§8.1).
				this._resourceLeaseController?.release(resourceLease);
				resourceObservations?.record("resource_lease_released_v1", { promptRunId });
			}
			this._flushPendingBashMessages();
			// §16.4 (M4): settle only after every in-run continuation drained.
			this._emitPromptSettledIfReady({ promptRunId, startedAtEpochMs, outcome, resourceObservations });
		}
	}

	/**
	 * Emit `prompt_settled` when the §16.4 conditions hold. Called exactly
	 * once per promptRunId (from `_runAgentPrompt`'s finally), so the same
	 * run can never emit twice; late-queued messages block emission
	 * conservatively — the continuation run settles under its own id.
	 * Settlement is a UX signal only and must never affect the run (§16.1).
	 */
	private _emitPromptSettledIfReady(input: {
		readonly promptRunId: string;
		readonly startedAtEpochMs: number;
		readonly outcome: promptSettlement.PromptSettlementOutcome;
		readonly resourceObservations: ResourceObservationJournal | null;
	}): void {
		try {
			let state = promptSettlement.createPromptSettlementState(input.promptRunId, input.startedAtEpochMs);
			state = promptSettlement.reducePromptSettlement(state, { kind: "terminal", outcome: input.outcome });
			if (this.isStreaming) {
				state = promptSettlement.reducePromptSettlement(state, { kind: "tool", delta: 1 });
			}
			if (this.agent.hasQueuedMessages()) {
				state = promptSettlement.reducePromptSettlement(state, { kind: "continuation", delta: 1 });
			}
			const settled = promptSettlement.settlePromptIfReady(state, Date.now());
			if (settled.event !== null) {
				input.resourceObservations?.record("prompt_settled_v1", settledObservationFacts(settled.event));
				this._emit(settled.event);
			}
		} catch {
			// Never let settlement bookkeeping break a run.
		}
	}

	/**
	 * Resource governor preflight for one top-level run (roadmap §8, §25.3 M2).
	 *
	 * - `off`: nothing; v0.96.1 observable behavior is preserved.
	 * - `observe` (default): fire-and-forget probe records a decision for the
	 *   §19.4 read-only API; the cap never changes and the prompt is never
	 *   delayed. The pending probe is bounded (~cpuSampleMs) and never rejects.
	 * - `adaptive`/`strict`: bounded blocking probe (default 300 ms deadline),
	 *   then a generation-safe lease applies the effective tool cap for this
	 *   run. The caller's `finally` releases it exactly once.
	 *
	 * Never throws: any probe or policy failure leaves this run ungoverned
	 * (§2.1: probe failure must not crash or block the prompt).
	 */
	private async _beginResourceGovernedRun(promptRunId: string): Promise<RunResourceLease | null> {
		try {
			const resolved = resolveResourceGovernorSettings(this.settingsManager.getResourceGovernorSettings());
			if (resolved.mode === "off") {
				return null;
			}
			const resourceObservations = this._openResourceObservations(promptRunId);
			const probeOptions = {
				cwd: this._cwd,
				maxProbeMs: resolved.maxProbeMs,
				cpuSampleMs: resolved.cpuSampleMs,
			};
			// §7.3: Agent.maxToolConcurrency uses undefined for "unlimited"; the
			// admission contract uses 0 for the same meaning.
			const configuredCaps = { maxToolConcurrency: this.agent.maxToolConcurrency ?? 0 };
			if (resolved.mode === "observe") {
				void captureHostResourceSnapshot(probeOptions)
					.then((snapshot) => {
						const decision = decideResourceAdmission({
							snapshot,
							config: resolved.admission,
							configuredCaps,
						});
						if (this._latestResourcePromptRunId === promptRunId) {
							this._lastResourceAdmission = decision;
						}
						resourceObservations?.record("resource_snapshot_v1", snapshotObservationFacts(snapshot));
						resourceObservations?.record("resource_admission_v1", admissionObservationFacts(decision));
					})
					.catch(() => {});
				return null;
			}
			const snapshot = await captureHostResourceSnapshot(probeOptions);
			const decision = decideResourceAdmission({ snapshot, config: resolved.admission, configuredCaps });
			if (this._latestResourcePromptRunId === promptRunId) {
				this._lastResourceAdmission = decision;
			}
			resourceObservations?.record("resource_snapshot_v1", snapshotObservationFacts(snapshot));
			resourceObservations?.record("resource_admission_v1", admissionObservationFacts(decision));
			this._resourceLeaseController ??= new RunResourceLeaseController({
				getCap: () => this.agent.maxToolConcurrency,
				setCap: (cap) => {
					this.agent.maxToolConcurrency = cap;
				},
			});
			const lease = this._resourceLeaseController.acquire({ promptRunId, decision });
			resourceObservations?.record("resource_lease_acquired_v1", {
				decisionId: decision.decisionId,
				appliedToolCap: decision.maxToolConcurrency,
			});
			return lease;
		} catch {
			return null;
		}
	}

	private _openResourceObservations(promptRunId: string): ResourceObservationJournal | null {
		this._latestResourcePromptRunId = promptRunId;
		try {
			const journal = ResourceObservationJournal.open(this._cwd, promptRunId);
			this._resourceObservations = journal;
			this._resourceObservationJournals.set(promptRunId, journal);
			while (this._resourceObservationJournals.size > MAX_RESOURCE_OBSERVATION_JOURNALS) {
				const oldestPromptRunId = this._resourceObservationJournals.keys().next().value;
				if (oldestPromptRunId === undefined) break;
				this._resourceObservationJournals.delete(oldestPromptRunId);
			}
			return journal;
		} catch {
			this._resourceObservations = null;
			this._resourceObservationJournals.delete(promptRunId);
			return null;
		}
	}

	/** §20.2: record the TUI-side completion sound result in its originating run journal. */
	recordCompletionSoundResult(
		promptRunId: string,
		result: import("./completion-sound.ts").CompletionSoundResult,
	): void {
		const journal = this._resourceObservationJournals.get(promptRunId);
		journal?.record("completion_sound_result_v1", soundObservationFacts(result));
		this._resourceObservationJournals.delete(promptRunId);
		if (this._latestResourcePromptRunId === promptRunId) {
			this._latestResourcePromptRunId = null;
			if (this._resourceObservations === journal) this._resourceObservations = null;
		}
	}

	/** §19.4 read-only SDK surface: the most recent resource admission decision, if any. */
	getCurrentResourceAdmission(): ResourceAdmissionDecision | null {
		return this._lastResourceAdmission;
	}

	/** §19.4 read-only SDK surface: capture a fresh host resource snapshot. */
	async getHostResourceSnapshot(): Promise<HostResourceSnapshot> {
		const resolved = resolveResourceGovernorSettings(this.settingsManager.getResourceGovernorSettings());
		return captureHostResourceSnapshot({
			cwd: this._cwd,
			maxProbeMs: resolved.maxProbeMs,
			cpuSampleMs: resolved.cpuSampleMs,
		});
	}

	/** §19.4 read-only SDK surface: shared workload permit pool state, if any. */
	getWorkloadPermitSnapshot(): WorkloadPermitPoolSnapshot | null {
		return this._workloadPermitPool?.snapshot() ?? null;
	}

	/**
	 * §14.1 shared-budget seam: child subagents must reuse this instance
	 * instead of creating a private pool (host oversubscription). The live
	 * child launcher wiring lands in M6.
	 */
	get workloadPermitPool(): WorkloadPermitPool {
		this._workloadPermitPool ??= new WorkloadPermitPool();
		return this._workloadPermitPool;
	}

	/**
	 * Resource safety gate for the bash boundary (roadmap §9.4/§11, M3).
	 * Runs only in adaptive/strict mode with a recorded admission decision;
	 * observe/off keep v0.96.1 behavior. Never throws: gate machinery
	 * failures leave the command ungated (§2.1), while computed block
	 * verdicts and permit rejections return a bounded §11.3 payload.
	 */
	private async _acquireBashResourcePermit(command: string, signal: AbortSignal): Promise<BashResourcePermitGrant> {
		try {
			const resolved = resolveResourceGovernorSettings(this.settingsManager.getResourceGovernorSettings());
			if (resolved.mode !== "adaptive" && resolved.mode !== "strict") {
				return {};
			}
			const decision = this._lastResourceAdmission;
			if (decision === null) {
				return {};
			}
			const classification = classifyWorkloadCommand(command);
			this._resourceObservations?.record(
				"workload_classification_v1",
				classificationObservationFacts(classification),
			);
			const verdict = decideResourceSafetyGate({ commandSafety: "allowed", classification, decision });
			if (verdict.kind === "allow") {
				return {};
			}
			if (verdict.kind === "block") {
				return { blocked: JSON.stringify(verdict.block) };
			}
			this._workloadPermitPool ??= new WorkloadPermitPool({ capacity: decision.maxHeavyProcesses });
			const pool = this._workloadPermitPool;
			pool.setCapacity(decision.maxHeavyProcesses);
			const waitStartedMs = Date.now();
			this._resourceObservations?.record("workload_permit_wait_v1", {
				workloadClass: classification.workloadClass,
				weight: verdict.weight,
			});
			try {
				const permit = await pool.acquire({
					requestId: `bash-${randomUUID()}`,
					promptRunId: this._resourceLeaseController?.activeLease?.promptRunId ?? "unleased",
					workloadClass: classification.workloadClass,
					weight: verdict.weight,
					signal,
					// Bounded §10.3 timeout-aware wait; a settings knob can follow later.
					timeoutMs: 60_000,
				});
				this._resourceObservations?.record("workload_permit_acquired_v1", {
					workloadClass: classification.workloadClass,
					weight: verdict.weight,
					waitMs: Date.now() - waitStartedMs,
				});
				return {
					release: () => {
						permit.release();
						this._resourceObservations?.record("workload_permit_released_v1", {
							workloadClass: classification.workloadClass,
							weight: verdict.weight,
						});
					},
				};
			} catch (error) {
				const code = error instanceof WorkloadPermitError ? error.code : "queue_overflow";
				return {
					blocked: JSON.stringify({
						kind: "resource_pressure",
						pressure: decision.pressure,
						action: "defer-heavy",
						reasonCodes: [...decision.reasons, `resource.permit.${code}`],
						requiredAction: RESOURCE_PRESSURE_REQUIRED_ACTION,
					}),
				};
			}
		} catch {
			return {};
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
			this._refusedModels.clear();
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
		const defaultActiveSkills = this._getDefaultActiveSkills();
		let promptActiveSkillNames = mergePromptActiveSkillNames(defaultActiveSkills, options?.activeSkillNames ?? []);
		let promptActiveSkillSource =
			defaultActiveSkills.length > 0
				? options?.activeSkillSource
					? `settings+${options.activeSkillSource}`
					: "settings"
				: options?.activeSkillSource;
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
				promptActiveSkillSource =
					defaultActiveSkills.length > 0 ? `settings+${bangInvocation.source}` : bangInvocation.source;
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
					this.isStreaming || this.isRetrying ? options?.streamingBehavior : undefined,
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

			// While a run or its retry backoff owns the session, queue instead of starting a competing top-level prompt.
			if (this.isStreaming || this.isRetrying) {
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

			const turnSystemPromptOptions = {
				...this._baseSystemPromptOptions,
				contextBudget: this._getContextBudgetOptions(expandedText),
				activeSkillNames: promptActiveSkillNames,
				activeSkillSource: promptActiveSkillSource,
			};
			const turnSystemPrompt = buildSystemPromptPlan(turnSystemPromptOptions);

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				turnSystemPrompt.prompt,
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
			// Apply extension-modified system prompt, or reset to the turn plan.
			if (result?.systemPrompt) {
				const preservesCacheBoundary = result.systemPrompt === turnSystemPrompt.prompt;
				this.agent.state.systemPrompt = result.systemPrompt;
				this.agent.state.systemPromptCacheBoundary = preservesCacheBoundary
					? turnSystemPrompt.cacheBoundary
					: undefined;
				this.agent.state.systemPromptCacheBoundaryBypass = !preservesCacheBoundary;
			} else {
				// Ensure we're using the turn prompt (in case the previous turn had modifications).
				this.agent.state.systemPrompt = turnSystemPrompt.prompt;
				this.agent.state.systemPromptCacheBoundary = turnSystemPrompt.cacheBoundary;
				this.agent.state.systemPromptCacheBoundaryBypass = false;
			}
			this._recordPromptCachePlan(result?.systemPrompt ? "extension-override" : "turn-plan");

			await this._checkProjectedCompaction(messages);
		} catch (error) {
			preflightResult?.(false);
			const rawMessage = error instanceof Error ? error.message : String(error);
			const cause = preflightFailureCause(rawMessage, Boolean(this.model));
			const timestamp = new Date().toISOString();
			this._publishTermination(
				classifySessionTermination({
					sessionId: this.sessionId,
					runId: `preflight-${randomUUID()}`,
					timestamp,
					source: "observed",
					message: terminationMessage(rawMessage, "Prompt preflight failed."),
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

		// Root-level: block sticky safety models (Fable) unless the user pinned `--model`.
		const resilience = resolveProviderResilience(this.settingsManager.getProviderResilienceSettings());
		if (
			shouldEjectStickySafetyModel({
				blockStickySafetyModels: resilience.blockStickySafetyModels,
				modelPinned: this._modelPinned,
			}) &&
			isStickySafetyModel(model.id, model.provider)
		) {
			throw new Error(stickySafetyBlockMessage(model.id, model.provider));
		}

		// Grok OAuth: block selecting Imagine models as the session chat model.
		assertTextChatModelForCompletion(model.id, model.provider);

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		const nextSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames(), model);
		this.agent.state.model = model;
		this._baseSystemPrompt = nextSystemPrompt;
		this.agent.state.systemPrompt = this._baseSystemPrompt;
		this.agent.state.systemPromptCacheBoundary = this._baseSystemPromptCacheBoundary;
		this.agent.state.systemPromptCacheBoundaryBypass = false;
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
		const raw = this._modelRegistry.getAvailable();
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

	/** Apply an explicit user choice and retain it as bounded router feedback. */
	setUserThinkingLevel(level: ThinkingLevel): void {
		const overridesAuto = this._thinkingMode === "auto";
		this.setThinkingMode("manual");
		this.setThinkingLevel(level);
		if (overridesAuto) {
			this._recordUserThinkingOverride(this.thinkingLevel);
		} else {
			this._lastAutoRouterDecision = undefined;
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
	 * the default-off Adaptorch bridge is wired but its current transport returns
	 * no advisory hint. `bias` stays `0` unless BOTH hold: (a) the global,
	 * owner-only `reasoningRouterLearning.enabled` setting is `true` (default
	 * off; a project-scope `.omk/settings.json` value for this key is never
	 * consulted -- see settings-manager.ts), and (b) a compiled
	 * `RouterBiasSnapshot` was found and passed strict validation at the
	 * configured path or opaque repository/worktree-scoped default, loaded and
	 * cached ("pinned") at most once per session (see
	 * `_getReasoningRouterBiasSnapshot`). When learning is enabled, one bounded
	 * "accepted" record (no raw prompt/path/diff/session/model/provider/tool/hook
	 * content; see router-feedback-collector.ts's exact ten-key schema) is
	 * appended after every v4 auto-turn. A later explicit user level records one
	 * bounded `s1-override` direction for the same cell. Both remain inert until
	 * a future, separate offline compile step. The
	 * resolver's own confidence-band/fallback-reason escalation (see
	 * reasoning-router-v4.ts) still applies on top of the base+lane+bias
	 * target, so a low-confidence or fallback-decided verdict can still only
	 * match or exceed the confident-path level.
	 */
	private _applyAutoThinkingLevelV4(promptText: string): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const features = deriveRouterFeedbackFeaturesV4(promptText);
		const verdict = classifyTaskV4(
			{
				prompt: promptText,
				history: this._taskClassHistory,
				pressureBucket: this._computePressureBucket(),
			},
			undefined,
			features,
		);

		this._taskClassHistory.unshift(verdict.taskClass);
		if (this._taskClassHistory.length > 8) this._taskClassHistory.length = 8;

		const learningEnabled = this.settingsManager.getReasoningRouterLearningEnabled();
		const snapshot = learningEnabled ? this._getReasoningRouterBiasSnapshot() : null;
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

		this._lastAutoRouterDecision = undefined;
		if (learningEnabled && resolved !== "off") {
			const decision: RouterAutoDecision = {
				routerVersion: "v4",
				laneType: "none",
				predictedClass: verdict.taskClass,
				resolvedLevel: resolved,
				lenBucket: features.lenBucket,
				hadFence: features.hadFence,
				hadDiff: features.hadDiff,
			};
			this._lastAutoRouterDecision = decision;
			this._appendRouterFeedback({
				...decision,
				acceptedLevel: resolved,
				signal: "s2-accept",
				outcome: "accepted",
			});
		}

		const previousLevel = this.agent.state.thinkingLevel;
		if (resolved === previousLevel) return;

		this.agent.state.thinkingLevel = resolved;
		this.sessionManager.appendThinkingLevelChange(resolved);
		this._emit({ type: "thinking_level_changed", level: resolved });
	}

	private _getRepositoryRouterLearningPaths(): RepositoryRouterLearningPaths {
		if (this._repositoryRouterLearningPaths === undefined) {
			this._repositoryRouterLearningPaths = getRepositoryRouterLearningPaths(this._cwd);
		}
		return this._repositoryRouterLearningPaths;
	}

	private _appendRouterFeedback(record: RouterFeedbackRecord): void {
		appendRouterFeedbackRecord(record, {
			enabled: this.settingsManager.getReasoningRouterLearningEnabled(),
			ledgerPath:
				this.settingsManager.getReasoningRouterLearningFeedbackLedgerPath() ??
				this._getRepositoryRouterLearningPaths().ledgerPath,
		});
	}

	private _recordUserThinkingOverride(acceptedLevel: ThinkingLevel): void {
		const decision = this._lastAutoRouterDecision;
		this._lastAutoRouterDecision = undefined;
		if (!this.settingsManager.getReasoningRouterLearningEnabled() || !decision || acceptedLevel === "off") return;

		const resolvedIndex = ROUTER_FEEDBACK_LEVELS.indexOf(decision.resolvedLevel);
		const acceptedIndex = ROUTER_FEEDBACK_LEVELS.indexOf(acceptedLevel);
		const outcome = acceptedIndex > resolvedIndex ? "up" : acceptedIndex < resolvedIndex ? "down" : "same";
		this._appendRouterFeedback({
			...decision,
			acceptedLevel,
			signal: "s1-override",
			outcome,
		});
	}

	/**
	 * Strictly load the compiled bias snapshot once per session. The first call
	 * pins either a valid snapshot or a null miss; later calls never touch disk.
	 */
	private _getReasoningRouterBiasSnapshot(): RouterBiasSnapshot | null {
		if (this._reasoningRouterBiasSnapshotLoaded) return this._reasoningRouterBiasSnapshot;
		this._reasoningRouterBiasSnapshotLoaded = true;

		const path =
			this.settingsManager.getReasoningRouterLearningBiasSnapshotPath() ??
			this._getRepositoryRouterLearningPaths().biasSnapshotPath;
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
	 * Context-pressure band 0..3 from the projected token estimate over the
	 * model context window (reuses estimateProjectedContextTokens). 0..<0.5,
	 * 1..<0.75, 2..<0.9, 3..>=0.9. The released default pressure coefficient
	 * is 1 and participates only after the classifier has prompt evidence.
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
		features: RouterFeedbackFeaturesV4,
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

		return { level: TASK_CLASS_THINKING_LEVELS_V4[hint.taskClass], confidence };
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
		const overridesAuto = this._thinkingMode === "auto";

		this.setThinkingLevel(nextLevel);
		if (overridesAuto) {
			this.setThinkingMode("manual");
			this._recordUserThinkingOverride(nextLevel);
		}
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
		return Boolean(this.model?.reasoning);
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

	private _beginCompactionTransaction(compactionModel: Model<Api>, emergency: boolean): BegunCompaction {
		return this._compactionService.beginTransaction(compactionModel, emergency);
	}

	private _commitCompaction(
		begun: BegunCompaction,
		result: CompactionResult,
		fromExtension: boolean,
	): CommittedCompaction {
		return this._compactionService.commit(begun, result, fromExtension);
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
	 * Authenticated failover candidates for compaction summarization, in
	 * resilience-chain order, excluding the primary compaction model itself.
	 * Used when the primary model's quota is exhausted (same-model retry is
	 * useless until reset; another provider can still save the compaction).
	 */
	/**
	 * Summarize for manual and automatic compaction alike. If the provider
	 * rejects the OAuth token as expired despite a still-future stored expiry
	 * (ChatGPT `401 token_expired`), the credential is force-refreshed once and
	 * the summarization retried; the retry classifier rightly never replays a 401.
	 */
	private _summarizeCompaction(input: {
		preparation: CompactionPreparation;
		model: Model<Api>;
		apiKey: string | undefined;
		headers: Record<string, string> | undefined;
		customInstructions?: string;
		signal: AbortSignal;
		reason: "manual" | "overflow" | "threshold";
	}): Promise<CompactionResult> {
		const { model } = input;
		return summarizeWithOAuthRecovery({
			apiKey: input.apiKey,
			provider: model.provider,
			refreshRejectedToken: (rejected) => this._modelRegistry.refreshRejectedOAuthToken(model, rejected),
			run: (requestApiKey) =>
				compact(
					input.preparation,
					model,
					requestApiKey,
					input.headers,
					input.customInstructions,
					input.signal,
					this.thinkingLevel,
					this.agent.streamFn,
					this.settingsManager.getRetrySettings(),
					this._summarizationRetryCallbacks({ source: "compaction", reason: input.reason }),
					this._compactionFailoverModels(model),
				),
		});
	}

	private _compactionFailoverModels(primary: Model<Api>): Model<Api>[] {
		const candidates = resolveFailoverCandidates(this.settingsManager.getProviderResilienceSettings());
		const available = this._modelRegistry.getAvailable();
		const models: Model<Api>[] = [];
		for (const candidate of candidates) {
			if (candidate.provider === primary.provider && candidate.id === primary.id) continue;
			const resolved = available.find((m) => m.provider === candidate.provider && m.id === candidate.id);
			if (resolved) models.push(resolved);
		}
		return models;
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		await this.abort();
		this._disconnectFromAgent();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });
		let committedCompaction = false;
		// Hoisted so a failure is attributed to the model that actually summarized,
		// which `compaction.model` may make different from the session model.
		let compactionModel: Model<Api> | undefined;

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			compactionModel = this._resolveCompactionModel(this.model);
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
				const result = await this._summarizeCompaction({
					preparation,
					model: compactionModel,
					apiKey,
					headers,
					customInstructions,
					signal: this._compactionAbortController.signal,
					reason: "manual",
				});
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			const compactionResult: CompactionResult = {
				summary: redactCredentialShapedContent(redactSensitiveTextForced(summary)),
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
			let compactionCode: "aborted" | "stale" | "failed" | "quota_exhausted" = "failed";
			if (aborted) compactionCode = "aborted";
			else if (stale) compactionCode = "stale";
			else if (isQuotaExhaustionMessage(message)) compactionCode = "quota_exhausted";
			const timestamp = new Date().toISOString();
			this._publishTermination(
				classifySessionTermination({
					sessionId: this.sessionId,
					runId: `compaction-${randomUUID()}`,
					timestamp,
					source: "observed",
					message: terminationMessage(message, "Manual compaction failed."),
					cause: { area: "compaction", code: compactionCode },
					sideEffects: committedCompaction ? "confirmed" : "none",
					...(compactionModel
						? { provider: compactionModel.provider, model: compactionModel.id }
						: this.model
							? { provider: this.model.provider, model: this.model.id }
							: {}),
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

	/** True when the transcript carries image content that forces a vision-route turn. */
	private _transcriptHasImages(messages: AgentMessage[]): boolean {
		return messages.some((m) => {
			const content = (m as { content?: unknown }).content;
			if (!Array.isArray(content)) return false;
			return content.some((part: unknown) => {
				return typeof part === "object" && part !== null && (part as { type?: string }).type === "image";
			});
		});
	}

	/**
	 * Effective context window for the upcoming turn.
	 * Image-bearing turns with a text-only session model are auto-routed to the
	 * vision model (gpt-5.6-luna, 1M) — that window is the real limit. Text-only
	 * turns keep the session model's (typically much larger) window.
	 */
	private _effectiveTurnContextWindow(pendingMessages: AgentMessage[], sessionWindow: number): number {
		// Vision routing keys off the full transcript, not just the pending turn:
		// images retained in history keep every subsequent request on the vision model.
		const hasImages =
			this._transcriptHasImages(this.agent.state.messages) || this._transcriptHasImages(pendingMessages);
		const model = this.model;
		if (!hasImages || !model || (model.input ?? []).includes("image")) {
			return sessionWindow;
		}
		return Math.min(sessionWindow, getVisionRouteModel(model).contextWindow);
	}

	private async _checkProjectedCompaction(pendingMessages: AgentMessage[]): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled || pendingMessages.length === 0) return false;

		const sessionWindow = this.model?.contextWindow ?? 0;
		if (sessionWindow <= 0) return false;
		// Image-bearing turns are served by the auto-routed vision model, not the
		// session model. Its window (not the session model's) is the real limit the
		// provider enforces, so threshold compaction must use it or the vision
		// request overflows (context_length_exceeded) before deepseek-based
		// compaction would fire.
		const contextWindow = this._effectiveTurnContextWindow(pendingMessages, sessionWindow);
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
			return this._runThresholdCompaction(decision.emergency);
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
		// Stale pre-compaction usage/errors must not retrigger compaction on the
		// first prompt after one finished.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		if (
			shouldSkipCompactionCheck({
				enabled: settings.enabled,
				skipAbortedCheck,
				stopReason: assistantMessage.stopReason,
				messageTimestamp: assistantMessage.timestamp,
				latestCompactionTimestamp: compactionEntry ? new Date(compactionEntry.timestamp).getTime() : undefined,
			})
		) {
			return false;
		}

		const contextWindow = this.model?.contextWindow ?? 0;

		// Case 1: Overflow - LLM returned context overflow error. Only counts when
		// the failing message belongs to the session model — or to the auto-routed
		// vision model while the session model is text-only.
		if (
			isSessionModelOverflow({
				message: assistantMessage,
				contextWindow,
				sessionProvider: this.model?.provider,
				sessionModelId: this.model?.id,
				sessionInputs: this.model?.input,
			})
		) {
			if (this._overflowRecoveryAttempts >= MAX_OVERFLOW_RECOVERY_ATTEMPTS) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after two staged compact-and-retry attempts. Reduce the latest input or switch to a model with a larger effective context window.",
				});
				return false;
			}

			this._overflowRecoveryAttempts++;
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return this._runAutoCompaction("overflow", true);
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
			return this._runThresholdCompaction(decision.emergency);
		}
		return false;
	}

	private _overflowCompactionSettings(settings: CompactionSettings, attempt: number): CompactionSettings {
		if (attempt < MAX_OVERFLOW_RECOVERY_ATTEMPTS) return settings;

		return {
			...settings,
			reserveTokens: Math.min(settings.reserveTokens, OVERFLOW_RECOVERY_EMERGENCY_TOKENS),
			reservedOutputTokens: Math.min(
				settings.reservedOutputTokens ?? settings.reserveTokens,
				OVERFLOW_RECOVERY_EMERGENCY_TOKENS,
			),
			keepRecentTokens: Math.min(settings.keepRecentTokens, OVERFLOW_RECOVERY_EMERGENCY_TOKENS),
		};
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private async _runAutoCompaction(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		emergency = reason === "overflow" || this._thresholdCompactionEmergency,
	): Promise<boolean> {
		const configuredSettings = this.settingsManager.getCompactionSettings();
		const settings =
			reason === "overflow"
				? this._overflowCompactionSettings(configuredSettings, this._overflowRecoveryAttempts)
				: configuredSettings;

		this._emit({ type: "compaction_start", reason });
		this._autoCompactionAbortController = new AbortController();
		// Hoisted so the failure message names the model that actually summarized.
		let compactionModel: Model<Api> | undefined;

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

			compactionModel = this._resolveCompactionModel(this.model);
			let apiKey: string | undefined;
			let headers: Record<string, string> | undefined;
			if (isBuiltinStreamFn(this.agent.streamFn)) {
				const authResult = await this._modelRegistry.getApiKeyAndHeaders(compactionModel, {
					minRemainingMs: COMPACTION_MIN_TOKEN_VALIDITY_MS,
				});
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
				const compactResult = await this._summarizeCompaction({
					preparation,
					model: compactionModel,
					apiKey,
					headers,
					signal: this._autoCompactionAbortController.signal,
					reason,
				});
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
				summary: redactCredentialShapedContent(redactSensitiveTextForced(summary)),
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
			// Whether the agent loop will resume after this compaction. Shared by
			// the compaction_end event (so the TUI flushes its queued messages
			// correctly) and the return value below.
			const resumeMessages = this.agent.state.messages;
			let lastAssistantMsg: AssistantMessage | undefined;
			for (let i = resumeMessages.length - 1; i >= 0; i--) {
				const candidate = resumeMessages[i];
				if (candidate.role === "assistant") {
					lastAssistantMsg = candidate as AssistantMessage;
					break;
				}
			}
			const endedCleanly = lastAssistantMsg?.stopReason === "stop";
			const willResume = this.agent.hasQueuedMessages() || !endedCleanly;
			const emitWillRetry = compactionEmitWillRetry(willRetry, willResume);
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry: emitWillRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			// Resume the agent loop after a successful auto-compaction unless the
			// agent had already finished cleanly. Previously this returned
			// `hasQueuedMessages()`, which made the agent stall right after the
			// purple "Auto-compacting..." indicator whenever no steer/follow-up
			// messages were queued — even when the last turn was cut off mid-task
			// (stopReason toolUse/length/error/aborted). Continue in that case so
			// the task runs to completion on the compacted context. Hysteresis
			// (disarmed until context drops below rearmRatio) prevents an immediate
			// re-trigger; a clean "stop" with nothing queued still ends the loop.
			return willResume;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			const modelLabel = compactionModel ? ` (${compactionModel.provider}/${compactionModel.id})` : "";
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed${modelLabel}: ${errorMessage}`
						: `Auto-compaction failed${modelLabel}: ${errorMessage}`,
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
		this.agent.state.systemPromptCacheBoundary = this._baseSystemPromptCacheBoundary;
		this.agent.state.systemPromptCacheBoundaryBypass = false;
		this._recordPromptCachePlan("resource-reload");
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

	/**
	 * Connect configured MCP servers and register their tools for this session.
	 *
	 * Connection is lazy by construction: nothing is spawned until this is called,
	 * and a server that fails to start is reported in the returned status instead
	 * of taking the session down. Calling it twice replaces the previously
	 * attached MCP tools rather than duplicating them.
	 *
	 * Returns per-server status so a caller can surface failures; an empty
	 * configuration returns an empty array without spawning anything.
	 */
	async attachMcpServers(options?: {
		servers?: readonly McpServerConfig[];
		callTimeoutMs?: number;
	}): Promise<McpServerStatus[]> {
		const servers = options?.servers ?? loadMcpServerConfigs(this._cwd);
		this._mcpManager?.close();
		this._mcpManager = undefined;
		this._customTools = this._customTools.filter((definition) => !this._mcpToolNames.has(definition.name));
		this._mcpToolNames = new Set();
		if (servers.length === 0) {
			this._refreshToolRegistry();
			return [];
		}

		const manager = new McpManager({
			servers,
			cwd: this._cwd,
			clientInfo: { name: APP_NAME, version: VERSION },
			callTimeoutMs: options?.callTimeoutMs,
		});
		this._mcpManager = manager;
		const definitions = await manager.listToolDefinitions();
		// A builtin always wins a name collision; MCP must never shadow `bash`.
		const usable = definitions.filter((definition) => !this._baseToolDefinitions.has(definition.name));
		this._mcpToolNames = new Set(usable.map((definition) => definition.name));
		this._customTools = [...this._customTools, ...(usable as ToolDefinition[])];
		this._refreshToolRegistry();
		return manager.status();
	}

	/** Status of MCP servers attached to this session. Empty when none were attached. */
	mcpServerStatus(): McpServerStatus[] {
		return this._mcpManager?.status() ?? [];
	}

	/**
	 * Ping attached MCP servers and return fresh status, so callers (e.g. the
	 * status rail) can keep displaying real connectivity instead of the last
	 * handshake result. Resolves to [] when no manager is attached.
	 */
	mcpCheckHealth(options?: { pingTimeoutMs?: number; reconnectFailed?: boolean }): Promise<McpServerStatus[]> {
		return this._mcpManager?.checkHealth(options) ?? Promise.resolve([]);
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
			Array.from(this._baseToolDefinitions.entries()).flatMap(([name, definition]) =>
				isAllowedTool(name)
					? [
							[
								name,
								{
									definition,
									sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
								},
							] as [string, ToolDefinitionEntry],
						]
					: [],
			),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values()).flatMap(({ definition }) => {
				const snippet = this._normalizePromptSnippet(definition.promptSnippet);
				return snippet ? [[definition.name, snippet] as const] : [];
			}),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values()).flatMap(({ definition }) => {
				const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
				return guidelines.length > 0 ? [[definition.name, guidelines] as const] : [];
			}),
		);
		// Tools contributed by extensions the harness itself loads (`<builtin:*>`),
		// as opposed to user/project/SDK extensions.
		const builtinExtensionToolNames = new Set(
			allCustomTools.flatMap((tool) => (tool.sourceInfo.path.startsWith("<builtin:") ? [tool.definition.name] : [])),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values()).flatMap((definition) =>
				isAllowedTool(definition.name)
					? [
							{
								definition,
								sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, {
									source: "builtin",
								}),
							},
						]
					: [],
			),
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
			// "Keep extension tools on" is about the *user's* extensions. Tools shipped
			// by a built-in extension (e.g. update_todo) are part of the harness's own
			// tool surface, so they follow the built-in policy: when the caller asked
			// for no built-in tools, they stay off too.
			const builtinToolsDisabled = options.activeToolNames?.length === 0;
			for (const tool of wrappedExtensionTools) {
				if (builtinToolsDisabled && builtinExtensionToolNames.has(tool.name)) continue;
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
		const baseToolDefinitions = (() => {
			if (this._baseToolsOverride) {
				return Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				);
			}
			return createAllToolDefinitions(this._cwd, {
				read: { autoResizeImages, ...loadoutReadOptions },
				bash: {
					commandPrefix: shellCommandPrefix,
					shellPath,
					...(loadoutAccessGuard ? { loadoutAccessGuard } : {}),
					...(() => {
						const sandboxPolicy = this._getBashSandboxPreflight();
						return sandboxPolicy ? { sandboxPolicy } : {};
					})(),
					...(() => {
						const evidenceExecutor = this._getVerifiedEvidenceExecutor();
						if (!evidenceExecutor || !this._replayGoalId) return {};
						const { shell } = getShellConfig(shellPath);
						const inner = createLocalBashOperations({
							...(shellPath !== undefined ? { shellPath } : {}),
							sandboxPolicy: this._getBashSandboxPreflight(),
						});
						return {
							operations: createVerifiedBashOperations(inner, {
								evidenceExecutor,
								goalId: this._replayGoalId,
								...(this._replayLaneId !== undefined ? { laneId: this._replayLaneId } : {}),
								shell,
								workspaceScope: resolveSessionWorkspaceScope(this._cwd),
							}),
						};
					})(),
				},
				edit: loadoutWriteOptions,
				write: loadoutWriteOptions,
			});
		})();

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
			: ["read", "bash", "edit", "write", "diagnostics"];
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

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		return isRetryableAssistantError(message, this.model?.contextWindow ?? 0);
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	/** Eject sticky safety model at prompt boundary (session resume / leftover default). */
	private async _ejectStickySafetyModelIfNeeded(): Promise<void> {
		const resilience = resolveProviderResilience(this.settingsManager.getProviderResilienceSettings());
		if (
			!shouldEjectStickySafetyModel({
				blockStickySafetyModels: resilience.blockStickySafetyModels,
				modelPinned: this._modelPinned,
			})
		) {
			return;
		}
		const current = this.model;
		if (!current || !isStickySafetyModel(current.id, current.provider)) return;

		const pick = pickFailoverCandidate(
			resilience.failoverCandidates,
			{ provider: current.provider, id: current.id },
			(c) => {
				const next = this._modelRegistry.find(c.provider, c.id);
				if (!next) return false;
				return this._modelRegistry.hasConfiguredAuth(next);
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
	 * Rotate to another authenticated provider route serving the SAME model
	 * family (e.g. openrouter/stealth/ox-alpha ↔ opencode-go/ox-alpha-free ↔
	 * opencode/x-preview-f-free). Used when the current route fails with an
	 * upstream availability error — same-model retry would hammer a dead
	 * endpoint while the identical model is one route away. Visited and
	 * unauthenticated routes are marked in {@link _refusedModels} so repeat
	 * failures advance the rotation within the turn.
	 */
	private async _maybeRotateModelRoutes(): Promise<string | undefined> {
		const current = this.model;
		if (!current) return undefined;
		const candidates = sameModelRouteCandidates(current, this._modelRegistry.getAvailable());
		for (const candidate of candidates) {
			const key = failoverModelKey(candidate.provider, candidate.id);
			if (this._refusedModels.has(key)) continue;
			const next = this._modelRegistry.find(candidate.provider, candidate.id);
			if (!next || !this._modelRegistry.hasConfiguredAuth(next)) {
				this._refusedModels.add(key);
				continue;
			}
			try {
				await this.setModel(next);
				// The old route just failed upstream — keep it out of this turn's retries.
				this._refusedModels.add(failoverModelKey(current.provider, current.id));
				return `${next.provider}/${next.id}`;
			} catch {
				this._refusedModels.add(key);
			}
		}
		return undefined;
	}

	/**
	 * Content/safety stops (stop_reason=refusal) are often false positives on coding turns
	 * for Fable AND Claude Opus/Sonnet. Retrying the same model usually reprints the refusal —
	 * switch via provider-resilience chain first. Failover targets still skip sticky models.
	 */
	private async _maybeFailoverFromSafetyStop(message: AssistantMessage): Promise<string | undefined> {
		const resilience = resolveProviderResilience(this.settingsManager.getProviderResilienceSettings());
		if (
			!shouldHonorSafetyFailover({
				autoFailoverOnSafetyStop: resilience.autoFailoverOnSafetyStop,
				modelPinned: this._modelPinned,
				modelId: this.model?.id,
				provider: this.model?.provider,
			})
		) {
			return undefined;
		}
		// Fire on safety-stop FPs AND on billing/quota exhaustion: both mean the
		// current model cannot finish this turn and same-model retry is useless.
		if (!isFailoverTriggerError(message.errorMessage)) {
			return undefined;
		}

		const current = this.model;
		// v10.0-Ω: do NOT gate on isStickySafetyModel(source).
		// claude-opus-5 emits the same stop_reason=refusal FP; same-model retry is useless.

		// v10.3-Ω: mark the model that just refused so we never re-pick it this turn.
		if (current) this._refusedModels.add(failoverModelKey(current.provider, current.id));

		const pick = pickFailoverCandidate(
			resilience.failoverCandidates,
			current ? { provider: current.provider, id: current.id } : undefined,
			(c) => {
				// Skip any model that already refused/failed this turn → advance the chain.
				if (this._refusedModels.has(failoverModelKey(c.provider, c.id))) return false;
				const next = this._modelRegistry.find(c.provider, c.id);
				if (!next) return false;
				return this._modelRegistry.hasConfiguredAuth(next);
			},
		);
		if (!pick) return undefined;

		const next = this._modelRegistry.find(pick.provider, pick.id);
		if (!next) return undefined;
		try {
			await this.setModel(next);
			return `${next.provider}/${next.id}`;
		} catch {
			// setModel failed (auth/guard) — blacklist so next retry advances further.
			this._refusedModels.add(failoverModelKey(pick.provider, pick.id));
			return undefined;
		}
	}

	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		const maxRetries = retryBudgetForAssistantError(message, settings.maxRetries);
		const attempt = nextRetryAttempt({
			enabled: settings.enabled,
			completedAttempts: this._retryAttempt,
			maxRetries,
		});
		if (attempt === undefined) return false;
		this._retryAttempt = attempt;

		// Upstream-unavailable (gateway 5xx / dropped stream): rotate to another
		// authenticated route of the SAME model family so the retry lands on a
		// live endpoint instead of hammering the dead one.
		const rotatedTo = isUpstreamUnavailableMessage(message.errorMessage)
			? await this._maybeRotateModelRoutes()
			: undefined;

		// Content/safety stop (Fable/Opus/Sonnet): switch model BEFORE delay so retry is not same-model refusal.
		const failoverTo = await this._maybeFailoverFromSafetyStop(message);
		const switchedVia = failoverTo ? `failover ${failoverTo}` : rotatedTo ? `route ${rotatedTo}` : undefined;
		// Safety stops are usually immediate false positives — short delay after failover, full backoff otherwise.
		const delayMs = computeRetryDelayMs(settings.baseDelayMs, attempt, switchedVia !== undefined);
		const errorMessage = switchedVia
			? `${message.errorMessage || "content/safety stop"} → ${switchedVia}`
			: message.errorMessage || "Unknown error";

		this._emit({
			type: "auto_retry_start",
			attempt,
			maxAttempts: maxRetries,
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
			this._refusedModels.clear();
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
		return this._bashService.executeBash(command, onChunk, options);
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this._bashService.recordBashResult(command, result, options);
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this._bashService.abortBash();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashService.isBashRunning;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._bashService.hasPendingBashMessages;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		this._bashService.flushPending();
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
				const model = this.model;
				if (!model) throw new Error("No model available for summarization");
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
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
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
				if (typeof targetEntry.content === "string") {
					editorText = targetEntry.content;
				} else {
					editorText = targetEntry.content
						.flatMap((item) => {
							if (item.type === "text") return [item.text];
							return [];
						})
						.join("");
				}
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
				.flatMap((item) => (item.type === "text" && typeof item.text === "string" ? [item.text] : []))
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

		const providerEligibleInputTokens = totalInput + totalCacheRead + totalCacheWrite;
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
			promptCache: {
				providerEligibleInputTokens,
				providerHitRate: providerEligibleInputTokens > 0 ? totalCacheRead / providerEligibleInputTokens : 0,
				keyChanges: this._promptCacheKeyChanges,
				boundaryBypasses: this._promptCacheBoundaryBypasses,
				stablePrefixCharacters: this._promptCacheStablePrefixCharacters,
				...(this._promptCacheLastBreakReason ? { lastBreakReason: this._promptCacheLastBreakReason } : {}),
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

		return exportSessionToHtml(this.sessionManager, this.state, {
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
		let lastAssistant: AssistantMessage | undefined;
		for (let index = this.messages.length - 1; index >= 0; index -= 1) {
			const message = this.messages[index];
			if (message?.role !== "assistant") continue;
			const assistant = message as AssistantMessage;
			// Skip aborted messages with no content
			if (assistant.stopReason === "aborted" && assistant.content.length === 0) continue;
			lastAssistant = assistant;
			break;
		}

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of lastAssistant.content) {
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
