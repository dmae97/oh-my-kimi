import type { InMemorySnapshotStore } from "@oh-my-pi/hashline";
import type { AgentTelemetryConfig, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl, ImageContent, Model, ServiceTierByFamily, ToolChoice } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { AsyncJobManager } from "../async/job-manager";
import type { Rule } from "../capability/rule";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import { EditTool } from "../edit";
import { checkJuliaKernelAvailability } from "../eval/jl/kernel";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import { checkRubyKernelAvailability } from "../eval/rb/kernel";
import type { ToolPathWithSource } from "../extensibility/custom-tools";
import type { Skill } from "../extensibility/skills";
import type { GoalModeState, GoalRuntime } from "../goals";
import { GoalTool } from "../goals/tools/goal-tool";
import type { HindsightSessionState } from "../hindsight/state";
import type { LocalProtocolOptions } from "../internal-urls";
import { LspTool } from "../lsp";
import type { MCPManager } from "../mcp";
import type { MnemopiSessionState } from "../mnemopi/state";
import type { PlanModeState } from "../plan-mode/state";
import type { AgentRegistry } from "../registry/agent-registry";
import type { ArtifactManager } from "../session/artifacts";
import type { ClientBridge } from "../session/client-bridge";
import type { CustomMessage } from "../session/messages";
import type { UsageStatistics } from "../session/session-entries";
import type { ToolChoiceQueue } from "../session/tool-choice-queue";
import { TaskTool } from "../task";
import type { AgentOutputManager } from "../task/output-manager";
import { canSpawnAtDepth } from "../task/types";
import type { EventBus } from "../utils/event-bus";
import { WebSearchTool } from "../web/search";
import type { WorkspaceTree } from "../workspace-tree";
import { AskTool } from "./ask";
import { AstEditTool } from "./ast-edit";
import { AstGrepTool } from "./ast-grep";
import { BashTool } from "./bash";
import { BrowserTool } from "./browser";
import { type BuiltinToolName, type HiddenToolName, normalizeToolNames } from "./builtin-names";
import { type CheckpointState, CheckpointTool, type CompletedRewindState, RewindTool } from "./checkpoint";
import { DebugTool } from "./debug";
import { EvalTool } from "./eval";
import { resolveEvalBackends } from "./eval-backends";
import { GithubTool } from "./gh";
import { GlobTool } from "./glob";
import { GrepTool } from "./grep";
import { HubTool } from "./hub";
import { InspectImageTool } from "./inspect-image";
import { LearnTool } from "./learn";
import { ManageSkillTool } from "./manage-skill";
import { MemoryEditTool } from "./memory-edit";
import { MemoryRecallTool } from "./memory-recall";
import { MemoryReflectTool } from "./memory-reflect";
import { MemoryRetainTool } from "./memory-retain";
import { wrapToolWithMetaNotice } from "./output-meta";
import { ReadTool } from "./read";
import type { PlanProposalHandler } from "./resolve";
import { type TodoPhase, TodoTool } from "./todo";
import { WriteTool } from "./write";
import { isMountableUnderXdev, XdevRegistry } from "./xdev";
import { YieldTool } from "./yield";

export * from "../edit";
export * from "../goals";
export * from "../lsp";
export * from "../session/streaming-output";
export * from "../task";
export * from "../web/search";
export * from "./ask";
export * from "./ast-edit";
export * from "./ast-grep";
export * from "./bash";
export * from "./browser";
export * from "./checkpoint";
export * from "./debug";
export * from "./eval";
export * from "./eval-backends";
export * from "./gh";
export * from "./glob";
export * from "./grep";
export * from "./hub";
export * from "./image-gen";
export * from "./inspect-image";
export * from "./learn";
export * from "./manage-skill";
export * from "./memory-edit";
export * from "./memory-recall";
export * from "./memory-reflect";
export * from "./memory-retain";
export * from "./read";
export * from "./report-tool-issue";
export * from "./resolve";
export * from "./review";
export * from "./todo";
export * from "./tts";
export * from "./vibe";
export * from "./write";
export * from "./xdev";
export * from "./yield";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any, any, any>;

export type ContextFileEntry = {
	path: string;
	content: string;
	depth?: number;
};

/** Image attachment handle exposed to tools for user-facing labels such as `Image #1`. */
export type ImageAttachmentEntry = {
	label: string;
	uri: string;
	image: ImageContent;
};

/**
 * A late LSP diagnostics result that arrived after the edit/write tool already
 * returned. Surfaced to the model and the transcript via
 * {@link ToolSession.queueDeferredDiagnostics}, batched through the session
 * yield queue like background-job results.
 */
export interface DeferredDiagnosticsEntry {
	/** Absolute path the diagnostics belong to (the renderer shortens it). */
	path: string;
	/** One-line severity summary, e.g. "2 errors". */
	summary: string;
	/** Formatted, ready-to-display diagnostic lines. */
	messages: string[];
	/** True when any message is error severity. */
	errored: boolean;
	/**
	 * Evaluated at injection time (in the dispatcher's stale check): drop the entry
	 * when a newer mutation to the same file has superseded it, so the model never
	 * sees diagnostics for stale content.
	 */
	isStale(): boolean;
}

/** Session context for tool factories */
export interface ToolSession {
	/** Current working directory */
	cwd: string;
	/** Whether UI is available */
	hasUI: boolean;
	/**
	 * Suppress the spawn specialization/coordination advisory appended to `task`
	 * results. Set by internal/programmatic callers (e.g. the commit agent's
	 * file-analysis fan-out) whose results are consumed by code — not by a model
	 * orchestrating further spawns — so the nudge would only be noise.
	 */
	suppressSpawnAdvisory?: boolean;
	/** Optional fetch implementation injected into the URL read pipeline (tests, proxies). Defaults to global fetch. */
	fetch?: FetchImpl;
	/** Skip subprocess-kernel availability checks and warmup */
	skipPythonPreflight?: boolean;
	/** Pre-loaded context files (AGENTS.md, etc) */
	contextFiles?: ContextFileEntry[];
	/** Pre-loaded workspace tree (forwarded to subagents to skip re-scanning) */
	workspaceTree?: WorkspaceTree;
	/** Pre-loaded skills */
	skills?: Skill[];
	/** Pre-loaded prompt templates */
	promptTemplates?: PromptTemplate[];
	/** Pre-loaded rules (forwarded to subagents to skip re-discovery). */
	rules?: Rule[];
	/**
	 * Pre-discovered extension source paths. Forwarded to subagents so they
	 * skip the FS scan but still re-bind extensions to their own session-scoped
	 * `ExtensionAPI` (cwd, eventBus, runtime). Inline extension factories
	 * (`<inline-N>`) are NOT included — those are session-local.
	 */
	extensionPaths?: string[];
	/**
	 * Pre-discovered custom-tool source paths from `.omp/tools/`, `.claude/tools/`,
	 * plugins, etc. Forwarded to subagents so they skip the FS scan but still
	 * re-bind tools to their own session-scoped `CustomToolAPI`.
	 */
	customToolPaths?: ToolPathWithSource[];
	/** Whether LSP integrations are enabled */
	enableLsp?: boolean;
	/** Whether an edit-capable tool is available in this session (controls hashline output) */
	hasEditTool?: boolean;
	/** Event bus for tool/extension communication */
	eventBus?: EventBus;
	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
	/** Whether to include the yield tool by default */
	requireYieldTool?: boolean;
	/** Session starts with a prewalk hand-off armed. Keeps `todo` in yield-gated
	 *  (subagent) registries: the prewalk plan nudge + todo gate need it. */
	prewalkArmed?: boolean;
	/** Task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	/** Get shared eval executor session ID. Subagents inherit this to share JS/Python/Ruby/Julia state. */
	getEvalSessionId?: () => string | null;
	/** Get session file */
	getSessionFile: () => string | null;
	/** Get eval kernel owner ID for session-scoped retained-kernel cleanup. */
	getEvalKernelOwnerId?: () => string | null;
	/** Reject new eval work once session disposal has started. */
	assertEvalExecutionAllowed?: () => void;
	/** Track tool-owned eval work so session disposal can await/abort it like direct session eval runs. */
	trackEvalExecution?<T>(execution: Promise<T>, abortController: AbortController): Promise<T>;
	/** Get session ID */
	getSessionId?: () => string | null;
	/** Get Hindsight runtime state for this agent session. */
	getHindsightSessionState?: () => HindsightSessionState | undefined;
	/** Get Mnemopi runtime state for this agent session. */
	getMnemopiSessionState?: () => MnemopiSessionState | undefined;
	/** Agent identity used for IRC routing. Returns the registry id (e.g. "Main", "AuthLoader"). */
	getAgentId?: () => string | null;
	/** Look up a registered tool by name (used by the eval js backend's tool bridge). */
	getToolByName?: (name: string) => AgentTool | undefined;
	/** Return whether a built-in tool is active in this turn's tool set. */
	isToolActive?: (name: string) => boolean;
	/** Update the active built-in tool predicate when a session changes tools mid-run. */
	setActiveToolNames?: (names: Iterable<string>) => void;
	/** Tools mounted under `xd://` (set by createTools when `tools.xdev` is active); read/write consult it at execute time. */
	xdevRegistry?: XdevRegistry;
	/** Agent registry for IRC routing across live sessions. */
	agentRegistry?: AgentRegistry;
	/** Get artifacts directory for artifact:// URLs */
	getArtifactsDir?: () => string | null;
	/** Get the ArtifactManager backing this session (shared across parent + subagents). */
	getArtifactManager?: () => ArtifactManager | null;
	/** Allocate a new artifact path and ID for session-scoped truncated output. */
	allocateOutputArtifact?: (toolType: string) => Promise<{ id?: string; path?: string }>;
	/** Get session spawns */
	getSessionSpawns: () => string | null;
	/** Get resolved model string if explicitly set for this session */
	getModelString?: () => string | undefined;
	/** Get the current session model string, regardless of how it was chosen */
	getActiveModelString?: () => string | undefined;
	/** Get the current session model object (provider/api capabilities), regardless of how it was chosen. */
	getActiveModel?: () => Model | undefined;
	/** Get the session's live per-family service tiers (undefined = none). Source of truth for subagent `tier.subagent: inherit`. */
	getServiceTierByFamily?: () => ServiceTierByFamily | undefined;
	/** Auth storage for passing to subagents (avoids re-discovery) */
	authStorage?: import("../session/auth-storage").AuthStorage;
	/** Model registry for passing to subagents (avoids re-discovery) */
	modelRegistry?: import("../config/model-registry").ModelRegistry;
	/** Agent output manager for unique agent:// IDs across task invocations */
	agentOutputManager?: AgentOutputManager;
	/**
	 * Async job manager scoped to this session.
	 *
	 * - Top-level session that constructed one: its own manager.
	 * - Subagent (`parentTaskPrefix` set): the parent's manager, so background
	 *   bash/task work and `onJobComplete` deliveries flow into the conversation
	 *   that spawned it.
	 * - Secondary in-process top-level session that found a singleton already
	 *   installed (issue #1923): `undefined`. Tools refuse async work rather
	 *   than silently route completions into the owning session's `yieldQueue`.
	 *
	 * Tools MUST use this instead of `AsyncJobManager.instance()` so a secondary
	 * session never borrows the owning session's manager by accident.
	 */
	asyncJobManager?: AsyncJobManager;
	/** MCP manager visible to subagents without relying on the process-global singleton. */
	mcpManager?: MCPManager;
	/** Local protocol root to propagate to nested subagents and eval-created agents. */
	localProtocolOptions?: LocalProtocolOptions;
	/** Settings instance for passing to subagents */
	settings: Settings;
	/** Plan mode state (if active) */
	getPlanModeState?: () => PlanModeState | undefined;
	/** Path of the session's active plan reference (e.g. `local://<title>.md`); defaults to `local://PLAN.md`. */
	getPlanReferencePath?: () => string;
	/** Goal mode state (if active or paused) */
	getGoalModeState?: () => GoalModeState | undefined;
	/** Goal runtime for the active agent session. */
	getGoalRuntime?: () => GoalRuntime | undefined;
	/** Get cumulative session usage statistics (input/output tokens, cost). */
	getUsageStatistics?: () => UsageStatistics;
	/** Current per-turn token budget {total, spent, hard} for the eval `budget` helper. */
	getTurnBudget?: () => { total: number | null; spent: number; hard: boolean };
	/** Record output tokens consumed by an eval-spawned subagent toward the current turn budget. */
	recordEvalSubagentUsage?: (output: number) => void;
	/** Bridge to the connected client (e.g. ACP editor host). Tools should route fs/terminal/permission requests through this when available. */
	getClientBridge?: () => ClientBridge | undefined;
	/** Get cached todo phases for this session. */
	getTodoPhases?: () => TodoPhase[];
	/** Replace cached todo phases for this session. */
	setTodoPhases?: (phases: TodoPhase[]) => void;
	/** The tool-choice queue used to force forthcoming tool invocations and carry invocation handlers. */
	getToolChoiceQueue?(): ToolChoiceQueue;
	/** Build a model-provider-specific ToolChoice that targets the named tool, or undefined if unsupported. */
	buildToolChoice?(toolName: string): ToolChoice | undefined;
	/** Steer a hidden custom message into the conversation (e.g. a preview reminder). */
	steer?(message: { customType: string; content: string; details?: unknown }): void;
	/** Peek the currently in-flight tool-choice queue directive's invocation handler. Used by
	 *  the `xd://resolve` and `xd://reject` dispatch to reach the pending action. */
	peekQueueInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;
	/** Peek the most-recently registered non-forcing pending preview invoker. A `write` to
	 *  `xd://resolve` or `xd://reject` dispatches to it so a staged preview resolves
	 *  WITHOUT forcing tool_choice — the agent-loop's SoftToolRequirement lifecycle owns
	 *  reminder injection and escalation. */
	peekPendingInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;
	/** Clear stale pending preview markers when a resolution dispatch cannot run them. */
	clearPendingInvokers?(): void;
	/** Peek the plan-proposal handler installed by plan mode. `xd://propose` dispatches the
	 *  written plan title to it. */
	peekPlanProposalHandler?(): PlanProposalHandler | undefined;
	/** Register or clear the plan-proposal handler. Passing `null` clears it. */
	setPlanProposalHandler?(handler: PlanProposalHandler | null): void;
	/** Get active checkpoint state if any. */
	getCheckpointState?: () => CheckpointState | undefined;
	/** Set or clear active checkpoint state. */
	setCheckpointState?: (state: CheckpointState | null) => void;
	/** Get the most recent completed rewind, if this session just rewound a checkpoint. */
	getLastCompletedRewind?: () => CompletedRewindState | undefined;

	/** Per-session snapshot store of file contents as last shown to the model
	 *  by `read`/`search`. Used by hashline anchor-stale recovery to
	 *  reconstruct the version the model authored anchors against when the
	 *  file changed out-of-band. Lazily initialized by `getFileSnapshotStore`. */
	fileSnapshotStore?: InMemorySnapshotStore;

	/** Per-session log of unresolved git merge conflict regions surfaced by
	 *  `read`. Each entry gets a stable id N referenced by `write conflict://N`
	 *  to splice the recorded region with replacement content. Lazily initialized
	 *  by `getConflictHistory`. */
	conflictHistory?: import("./conflict-detect").ConflictHistory;

	/** Per-session ledger of post-edit LSP diagnostics already surfaced to the
	 *  model for each file. Lazily initialized by `getDiagnosticsLedger`. */
	diagnosticsLedger?: import("../lsp/diagnostics-ledger").DiagnosticsLedger;

	/** Per-session ledger of consecutive byte-identical no-op edits, keyed by
	 *  canonical file path. The hashline executor escalates a soft no-op hint
	 *  to a thrown error once the same payload no-ops `NOOP_HARD_LIMIT` times,
	 *  breaking subagent loops that ignore the textual hint (issue #2081).
	 *  Lazily initialized by `getNoopLoopGuard`. */
	noopLoopGuard?: import("../edit/hashline/noop-loop-guard").NoopLoopGuard;

	/** Queue a hidden message to be injected at the next agent turn. */
	queueDeferredMessage?(message: CustomMessage): void;
	/** Queue late LSP diagnostics (arrived after an edit/write returned) to be shown
	 *  in the transcript and delivered to the model at the next yield, like background
	 *  job results. */
	queueDeferredDiagnostics?(entry: DeferredDiagnosticsEntry): void;
	/** Bump and return the session-global mutation counter for `path`. Edit/write
	 *  tools call this on every file mutation so stale late-diagnostics can be dropped. */
	bumpFileMutationVersion?(path: string): number;
	/** Read the current session-global mutation counter for `path` (0 if never mutated). */
	getFileMutationVersion?(path: string): number;
	/** Get the active OpenTelemetry config so subagent dispatch can forward
	 *  the parent's tracer/hooks with the subagent's own identity stamped. */
	getTelemetry?: () => AgentTelemetryConfig | undefined;
	/** Return image attachments visible to tools for resolving labels such as `Image #1`. */
	getImageAttachments?: () => ImageAttachmentEntry[];
}

export type ToolFactory = (session: ToolSession) => Tool | null | Promise<Tool | null>;

/**
 * Public callable factory map. External callers may invoke `BUILTIN_TOOLS.read(session)` or
 * `BUILTIN_TOOLS[name](session)` to construct a tool directly.
 */
export const BUILTIN_TOOLS: Record<BuiltinToolName, ToolFactory> = {
	read: s => new ReadTool(s),
	bash: s => new BashTool(s),
	edit: s => new EditTool(s),
	ast_grep: s => new AstGrepTool(s),
	ast_edit: s => new AstEditTool(s),
	ask: AskTool.createIf,
	debug: DebugTool.createIf,
	eval: s => new EvalTool(s),
	github: GithubTool.createIf,
	glob: s => new GlobTool(s, { rootPathAlias: true }),
	grep: s => new GrepTool(s),
	lsp: LspTool.createIf,
	inspect_image: s => new InspectImageTool(s),
	browser: s => new BrowserTool(s),
	checkpoint: CheckpointTool.createIf,
	rewind: RewindTool.createIf,
	task: s => TaskTool.create(s),
	hub: s => new HubTool(s),
	todo: s => new TodoTool(s),
	web_search: s => new WebSearchTool(s),
	write: s => new WriteTool(s),
	memory_edit: MemoryEditTool.createIf,
	retain: MemoryRetainTool.createIf,
	recall: MemoryRecallTool.createIf,
	reflect: MemoryReflectTool.createIf,
	learn: LearnTool.createIf,
	manage_skill: ManageSkillTool.createIf,
};

export const HIDDEN_TOOLS: Record<HiddenToolName, ToolFactory> = {
	yield: s => new YieldTool(s),
	goal: s => new GoalTool(s),
};

export type ToolName = BuiltinToolName;

/**
 * Create tools from BUILTIN_TOOLS registry.
 */
export async function createTools(session: ToolSession, toolNames?: string[]): Promise<Tool[]> {
	const includeYield = session.requireYieldTool === true;
	const enableLsp = session.enableLsp ?? true;
	let requestedTools = toolNames && toolNames.length > 0 ? normalizeToolNames(toolNames) : undefined;
	const goalEnabled = session.settings.get("goal.enabled");
	const goalModeActive = goalEnabled && session.getGoalModeState?.()?.enabled === true;
	if (goalModeActive && requestedTools && !requestedTools.includes("goal")) {
		requestedTools = [...requestedTools, "goal"];
	}
	const backends = resolveEvalBackends(session);
	const allowPython = backends.python;
	const allowJs = backends.js;
	const allowRuby = backends.ruby;
	const allowJulia = backends.julia;
	const skipEvalPreflight = session.skipPythonPreflight === true;
	// Eval tool is enabled if ANY backend is reachable. JS needs no preflight, so
	// we only probe Python/Ruby/Julia when JS is disabled — otherwise allowEval is
	// already true and per-backend availability is checked at first invocation.
	let pythonAvailable = true;
	let rubyAvailable = true;
	let juliaAvailable = true;
	const evalRequested = requestedTools === undefined || requestedTools.includes("eval");
	if (!skipEvalPreflight && !allowJs && evalRequested) {
		if (allowPython) {
			const availability = await logger.time(
				"createTools:pythonCheck",
				checkPythonKernelAvailability,
				session.cwd,
				session.settings.get("python.interpreter")?.trim() || undefined,
			);
			pythonAvailable = availability.ok;
			if (!availability.ok) {
				logger.warn("Python kernel unavailable and JS backend disabled", { reason: availability.reason });
			}
		}
		if (allowRuby) {
			const availability = await checkRubyKernelAvailability(
				session.cwd,
				session.settings.get("ruby.interpreter")?.trim() || undefined,
			);
			rubyAvailable = availability.ok;
			if (!availability.ok) {
				logger.warn("Ruby kernel unavailable and JS backend disabled", { reason: availability.reason });
			}
		}
		if (allowJulia) {
			const availability = await checkJuliaKernelAvailability(
				session.cwd,
				session.settings.get("julia.interpreter")?.trim() || undefined,
			);
			juliaAvailable = availability.ok;
			if (!availability.ok) {
				logger.warn("Julia kernel unavailable and JS backend disabled", { reason: availability.reason });
			}
		}
	}

	const effectivePythonAllowed = allowPython && pythonAvailable;
	const effectiveRubyAllowed = allowRuby && rubyAvailable;
	const effectiveJuliaAllowed = allowJulia && juliaAvailable;
	// Eval is exposed whenever any backend is reachable. A backend may be
	// unreachable, in which case eval dispatches exclusively to the others.
	const allowEval = effectivePythonAllowed || allowJs || effectiveRubyAllowed || effectiveJuliaAllowed;

	// Auto-include AST counterparts when their text-based sibling is present
	if (requestedTools) {
		if (
			requestedTools.includes("grep") &&
			!requestedTools.includes("ast_grep") &&
			session.settings.get("astGrep.enabled")
		) {
			requestedTools.push("ast_grep");
		}
		if (
			requestedTools.includes("edit") &&
			!requestedTools.includes("ast_edit") &&
			session.settings.get("astEdit.enabled")
		) {
			requestedTools.push("ast_edit");
		}
		if (["hindsight", "mnemopi"].includes(session.settings.get("memory.backend") ?? "")) {
			for (const name of ["recall", "retain", "reflect"]) {
				if (!requestedTools.includes(name)) requestedTools.push(name);
			}
		}
		// Auto-learn tools are gated by `autolearn.enabled` but, like the memory
		// tools above, must also be force-included into an explicit requestedTools
		// list so a restricted top-level session whose controller/guidance is
		// active still exposes the tools the nudge points at. Gated to top-level
		// (taskDepth 0): the controller only runs there, so a subagent's explicit
		// tool whitelist must never be silently widened with write-capable tools.
		if (session.settings.get("autolearn.enabled") && (session.taskDepth ?? 0) === 0) {
			if (!requestedTools.includes("manage_skill")) requestedTools.push("manage_skill");
			if (
				["hindsight", "mnemopi", "local"].includes(session.settings.get("memory.backend") ?? "") &&
				!requestedTools.includes("learn")
			) {
				requestedTools.push("learn");
			}
		}
	}
	const allTools: Record<string, ToolFactory> = { ...BUILTIN_TOOLS, ...HIDDEN_TOOLS };
	const isToolAllowed = (name: string) => {
		if (name === "goal") return goalEnabled && goalModeActive;
		if (name === "lsp") return enableLsp && session.settings.get("lsp.enabled");
		if (name === "bash") return session.settings.get("bash.enabled");
		if (name === "eval") return allowEval;
		if (name === "debug") return session.settings.get("debug.enabled");
		if (name === "todo")
			return (!includeYield || session.prewalkArmed === true) && session.settings.get("todo.enabled");
		if (name === "glob") return session.settings.get("glob.enabled");
		if (name === "grep") return session.settings.get("grep.enabled");
		if (name === "github") return session.settings.get("github.enabled");
		if (name === "ast_grep") return session.settings.get("astGrep.enabled");
		if (name === "ast_edit") return session.settings.get("astEdit.enabled");
		if (name === "inspect_image") return session.settings.get("inspect_image.enabled");
		if (name === "web_search") return session.settings.get("web_search.enabled");
		if (name === "ask") return session.settings.get("ask.enabled");
		if (name === "browser") return session.settings.get("browser.enabled");
		if (name === "checkpoint" || name === "rewind") return session.settings.get("checkpoint.enabled");
		if (name === "retain" || name === "recall" || name === "reflect") {
			return ["hindsight", "mnemopi"].includes(session.settings.get("memory.backend") ?? "");
		}
		if (name === "manage_skill") return session.settings.get("autolearn.enabled") && (session.taskDepth ?? 0) === 0;
		if (name === "learn") {
			return (
				session.settings.get("autolearn.enabled") &&
				(session.taskDepth ?? 0) === 0 &&
				["hindsight", "mnemopi", "local"].includes(session.settings.get("memory.backend") ?? "")
			);
		}
		if (name === "task") {
			return canSpawnAtDepth(session.settings.get("task.maxRecursionDepth") ?? 2, session.taskDepth ?? 0);
		}
		return true;
	};
	if (includeYield && requestedTools && !requestedTools.includes("yield")) {
		requestedTools.push("yield");
	}

	const filteredRequestedTools = requestedTools?.filter(name => name in allTools && isToolAllowed(name));
	const baseEntries =
		filteredRequestedTools !== undefined
			? filteredRequestedTools.map(name => [name, allTools[name]] as const)
			: [
					...Object.entries(BUILTIN_TOOLS)
						.filter(([name]) => isToolAllowed(name))
						.map(([name, factory]) => [name, factory] as const),
					...(includeYield ? ([["yield", HIDDEN_TOOLS.yield]] as const) : []),
					...(goalModeActive ? ([["goal", HIDDEN_TOOLS.goal]] as const) : []),
				];

	const activeToolNames = new Set(baseEntries.map(([name]) => name));
	if (session.setActiveToolNames) {
		session.setActiveToolNames(activeToolNames);
	} else {
		session.isToolActive = name => activeToolNames.has(name);
	}

	const baseResults = await Promise.all(
		baseEntries.map(async ([name, factory]) => {
			const tool = await logger.time(`createTools:${name}`, factory as ToolFactory, session);
			return tool ? wrapToolWithMetaNotice(tool) : null;
		}),
	);
	let tools = baseResults.filter((r): r is Tool => r !== null);

	// xd:// mounting: unmount discoverable built-ins from the tools array and
	// expose them as virtual device URLs driven through read/write. Active for
	// default tool sets when `tools.xdev` is enabled.
	const xdevEnabled = requestedTools === undefined && session.settings.get("tools.xdev");
	if (xdevEnabled) {
		const mounted: Tool[] = [];
		const kept: Tool[] = [];
		for (const tool of tools) {
			const mountable = isMountableUnderXdev(tool) && tool.name in BUILTIN_TOOLS;
			(mountable ? mounted : kept).push(tool);
		}
		session.xdevRegistry = new XdevRegistry(mounted);
		tools = kept;
		const finalActiveNames = new Set(tools.map(tool => tool.name));
		if (session.setActiveToolNames) {
			session.setActiveToolNames(finalActiveNames);
		} else {
			session.isToolActive = name => finalActiveNames.has(name);
		}
	}
	// The xd:// transport rides read/write: `read xd://` lists+documents devices,
	// `write xd://<tool>` executes them. Staged previews from deferrable tools
	// (e.g. ast_edit) also resolve through a `write` to xd://resolve/reject. Retain
	// both whenever any device is mounted or a deferrable tool can stage one.
	const xdevMounted = (session.xdevRegistry?.size ?? 0) > 0;
	if ((tools.some(tool => tool.deferrable === true) || xdevMounted) && !tools.some(tool => tool.name === "write")) {
		const writeTool = await logger.time("createTools:write", BUILTIN_TOOLS.write, session);
		if (writeTool) {
			tools.push(wrapToolWithMetaNotice(writeTool));
		}
	}
	if (xdevMounted && !tools.some(tool => tool.name === "read")) {
		const readTool = await logger.time("createTools:read", BUILTIN_TOOLS.read, session);
		if (readTool) {
			tools.push(wrapToolWithMetaNotice(readTool));
		}
	}

	return tools;
}
