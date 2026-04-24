import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ToolChoice } from "@oh-my-pi/pi-ai";
import { $env, $flag, isBunTestRuntime, logger } from "@oh-my-pi/pi-utils";
import type { AsyncJobManager } from "../async";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import { EditTool } from "../edit";
import type { Skill } from "../extensibility/skills";
import type { InternalUrlRouter } from "../internal-urls";
import { getPreludeDocs, resetPreludeDocsCache, warmPythonEnvironment } from "../ipy/executor";
import { checkPythonKernelAvailability } from "../ipy/kernel";
import { LspTool } from "../lsp";
import type { DiscoverableMCPSearchIndex, DiscoverableMCPTool } from "../mcp/discoverable-tool-metadata";
import type { PlanModeState } from "../plan-mode/state";
import type { CustomMessage } from "../session/messages";
import type { ToolChoiceQueue } from "../session/tool-choice-queue";
import { TaskTool } from "../task";
import type { AgentOutputManager } from "../task/output-manager";
import type { EventBus } from "../utils/event-bus";
import { SearchTool } from "../web/search";
import { AskTool } from "./ask";
import { AstEditTool } from "./ast-edit";
import { AstGrepTool } from "./ast-grep";
import { BashTool } from "./bash";
import { BrowserTool } from "./browser";
import { CalculatorTool } from "./calculator";
import { CancelJobTool } from "./cancel-job";
import { type CheckpointState, CheckpointTool, RewindTool } from "./checkpoint";
import { DebugTool } from "./debug";
import { ExitPlanModeTool } from "./exit-plan-mode";
import { FindTool } from "./find";
import {
	GhIssueViewTool,
	GhPrCheckoutTool,
	GhPrDiffTool,
	GhPrPushTool,
	GhPrViewTool,
	GhRepoViewTool,
	GhRunWatchTool,
	GhSearchIssuesTool,
	GhSearchPrsTool,
} from "./gh";
import { GrepTool } from "./grep";
import { InspectImageTool } from "./inspect-image";
import { NotebookTool } from "./notebook";
import { wrapToolWithMetaNotice } from "./output-meta";
import { PollTool } from "./poll-tool";
import { PythonTool } from "./python";
import { ReadTool } from "./read";
import { RenderMermaidTool } from "./render-mermaid";
import { createReportToolIssueTool, isAutoQaEnabled } from "./report-tool-issue";
import { ResolveTool } from "./resolve";
import { reportFindingTool } from "./review";
import { SearchToolBm25Tool } from "./search-tool-bm25";
import { loadSshTool } from "./ssh";
import { SubmitResultTool } from "./submit-result";
import { type TodoPhase, TodoWriteTool } from "./todo-write";
import { WriteTool } from "./write";

// Exa MCP tools (22 tools)

export * from "../edit";
export * from "../exa";
export type * from "../exa/types";
export * from "../lsp";
export * from "../session/streaming-output";
export * from "../task";
export * from "../web/search";
export * from "./ask";
export * from "./ast-edit";
export * from "./ast-grep";
export * from "./bash";
export * from "./browser";
export * from "./calculator";
export * from "./cancel-job";
export * from "./checkpoint";
export * from "./debug";
export * from "./exit-plan-mode";
export * from "./find";
export * from "./gemini-image";
export * from "./gh";
export * from "./grep";
export * from "./inspect-image";
export * from "./notebook";
export * from "./poll-tool";
export * from "./python";
export * from "./read";
export * from "./render-mermaid";
export * from "./report-tool-issue";
export * from "./resolve";
export * from "./review";
export * from "./search-tool-bm25";
export * from "./ssh";
export * from "./submit-result";
export * from "./todo-write";
export * from "./vim";
export * from "./write";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any, any, any>;

export type ContextFileEntry = {
	path: string;
	content: string;
	depth?: number;
};

export type { DiscoverableMCPTool } from "../mcp/discoverable-tool-metadata";

/** Session context for tool factories */
export interface ToolSession {
	/** Current working directory */
	cwd: string;
	/** Whether UI is available */
	hasUI: boolean;
	/** Skip Python kernel availability check and warmup */
	skipPythonPreflight?: boolean;
	/** Force Python prelude warmup even when test env would normally skip it */
	forcePythonWarmup?: boolean;
	/** Pre-loaded context files (AGENTS.md, etc) */
	contextFiles?: ContextFileEntry[];
	/** Pre-loaded skills */
	skills?: Skill[];
	/** Pre-loaded prompt templates */
	promptTemplates?: PromptTemplate[];
	/** Whether LSP integrations are enabled */
	enableLsp?: boolean;
	/** Whether an edit-capable tool is available in this session (controls hashline output) */
	hasEditTool?: boolean;
	/** Event bus for tool/extension communication */
	eventBus?: EventBus;
	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
	/** Whether to include the submit_result tool by default */
	requireSubmitResultTool?: boolean;
	/** Task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	/** Get session file */
	getSessionFile: () => string | null;
	/** Get Python kernel owner ID for session-scoped retained-kernel cleanup */
	getPythonKernelOwnerId?: () => string | null;
	/** Reject new Python work once session disposal has started. */
	assertPythonExecutionAllowed?: () => void;
	/** Track tool-owned Python work so session disposal can await/abort it like direct session Python runs. */
	trackPythonExecution?<T>(execution: Promise<T>, abortController: AbortController): Promise<T>;
	/** Get session ID */
	getSessionId?: () => string | null;
	/** Get artifacts directory for artifact:// URLs */
	getArtifactsDir?: () => string | null;
	/** Allocate a new artifact path and ID for session-scoped truncated output. */
	allocateOutputArtifact?: (toolType: string) => Promise<{ id?: string; path?: string }>;
	/** Get session spawns */
	getSessionSpawns: () => string | null;
	/** Get resolved model string if explicitly set for this session */
	getModelString?: () => string | undefined;
	/** Get the current session model string, regardless of how it was chosen */
	getActiveModelString?: () => string | undefined;
	/** Auth storage for passing to subagents (avoids re-discovery) */
	authStorage?: import("../session/auth-storage").AuthStorage;
	/** Model registry for passing to subagents (avoids re-discovery) */
	modelRegistry?: import("../config/model-registry").ModelRegistry;
	/** MCP manager for proxying MCP calls through parent */
	mcpManager?: import("../mcp/manager").MCPManager;
	/** Internal URL router for protocols like agent://, skill://, and mcp:// */
	internalRouter?: InternalUrlRouter;
	/** Agent output manager for unique agent:// IDs across task invocations */
	agentOutputManager?: AgentOutputManager;
	/** Async background job manager for bash/task async execution */
	asyncJobManager?: AsyncJobManager;
	/** Settings instance for passing to subagents */
	settings: Settings;
	/** Plan mode state (if active) */
	getPlanModeState?: () => PlanModeState | undefined;
	/** Get compact conversation context for subagents (excludes tool results, system prompts) */
	getCompactContext?: () => string;
	/** Get cached todo phases for this session. */
	getTodoPhases?: () => TodoPhase[];
	/** Replace cached todo phases for this session. */
	setTodoPhases?: (phases: TodoPhase[]) => void;
	/** Whether MCP tool discovery is active for this session. */
	isMCPDiscoveryEnabled?: () => boolean;
	/** Get hidden-but-discoverable MCP tools for search_tool_bm25 prompts and fallbacks. */
	getDiscoverableMCPTools?: () => DiscoverableMCPTool[];
	/** Get the cached discoverable MCP search index for search_tool_bm25 execution. */
	getDiscoverableMCPSearchIndex?: () => DiscoverableMCPSearchIndex;
	/** Get MCP tools activated by prior search_tool_bm25 calls. */
	getSelectedMCPToolNames?: () => string[];
	/** Merge MCP tool selections into the active session tool set. */
	activateDiscoveredMCPTools?: (toolNames: string[]) => Promise<string[]>;
	/** The tool-choice queue used to force forthcoming tool invocations and carry invocation handlers. */
	getToolChoiceQueue?(): ToolChoiceQueue;
	/** Build a model-provider-specific ToolChoice that targets the named tool, or undefined if unsupported. */
	buildToolChoice?(toolName: string): ToolChoice | undefined;
	/** Steer a hidden custom message into the conversation (e.g. a preview reminder). */
	steer?(message: { customType: string; content: string; details?: unknown }): void;
	/** Peek the currently in-flight tool-choice queue directive's invocation handler. Used by the `resolve` tool to dispatch to the pending action. */
	peekQueueInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;
	/** Get active checkpoint state if any. */
	getCheckpointState?: () => CheckpointState | undefined;
	/** Set or clear active checkpoint state. */
	setCheckpointState?: (state: CheckpointState | null) => void;

	/** Queue a hidden message to be injected at the next agent turn. */
	queueDeferredMessage?(message: CustomMessage): void;
}

type ToolFactory = (session: ToolSession) => Tool | null | Promise<Tool | null>;

export const BUILTIN_TOOLS: Record<string, ToolFactory> = {
	ast_grep: s => new AstGrepTool(s),
	ast_edit: s => new AstEditTool(s),
	render_mermaid: s => new RenderMermaidTool(s),
	ask: AskTool.createIf,
	bash: s => new BashTool(s),
	debug: DebugTool.createIf,
	python: s => new PythonTool(s),
	calc: s => new CalculatorTool(s),
	ssh: loadSshTool,
	edit: s => new EditTool(s),
	gh_repo_view: GhRepoViewTool.createIf,
	gh_issue_view: GhIssueViewTool.createIf,
	gh_pr_view: GhPrViewTool.createIf,
	gh_pr_diff: GhPrDiffTool.createIf,
	gh_pr_checkout: GhPrCheckoutTool.createIf,
	gh_pr_push: GhPrPushTool.createIf,
	gh_run_watch: GhRunWatchTool.createIf,
	gh_search_issues: GhSearchIssuesTool.createIf,
	gh_search_prs: GhSearchPrsTool.createIf,
	find: s => new FindTool(s),
	grep: s => new GrepTool(s),
	lsp: LspTool.createIf,
	notebook: s => new NotebookTool(s),
	read: s => new ReadTool(s),
	inspect_image: s => new InspectImageTool(s),
	browser: s => new BrowserTool(s),
	checkpoint: CheckpointTool.createIf,
	rewind: RewindTool.createIf,
	task: TaskTool.create,
	cancel_job: CancelJobTool.createIf,
	poll: PollTool.createIf,
	todo_write: s => new TodoWriteTool(s),
	web_search: s => new SearchTool(s),
	search_tool_bm25: SearchToolBm25Tool.createIf,
	write: s => new WriteTool(s),
};

export const HIDDEN_TOOLS: Record<string, ToolFactory> = {
	submit_result: s => new SubmitResultTool(s),
	report_finding: () => reportFindingTool,
	report_tool_issue: s => createReportToolIssueTool(s),
	exit_plan_mode: s => new ExitPlanModeTool(s),
	resolve: s => new ResolveTool(s),
};

export type ToolName = keyof typeof BUILTIN_TOOLS;

export type PythonToolMode = "ipy-only" | "bash-only" | "both";

/**
 * Parse PI_PY environment variable to determine Python tool mode.
 * Returns null if not set or invalid.
 *
 * Values:
 * - "0" or "bash" → bash-only
 * - "1" or "py" → ipy-only
 * - "mix" or "both" → both
 */
function getPythonModeFromEnv(): PythonToolMode | null {
	const value = $env.PI_PY?.toLowerCase();
	if (!value) return null;

	switch (value) {
		case "0":
		case "bash":
			return "bash-only";
		case "1":
		case "py":
			return "ipy-only";
		case "mix":
		case "both":
			return "both";
		default:
			return null;
	}
}

/**
 * Create tools from BUILTIN_TOOLS registry.
 */
export async function createTools(session: ToolSession, toolNames?: string[]): Promise<Tool[]> {
	const includeSubmitResult = session.requireSubmitResultTool === true;
	const enableLsp = session.enableLsp ?? true;
	const requestedTools =
		toolNames && toolNames.length > 0 ? [...new Set(toolNames.map(name => name.toLowerCase()))] : undefined;
	if (requestedTools && !requestedTools.includes("exit_plan_mode")) {
		requestedTools.push("exit_plan_mode");
	}
	const pythonMode = getPythonModeFromEnv() ?? session.settings.get("python.toolMode");
	const skipPythonPreflight = session.skipPythonPreflight === true;
	let pythonAvailable = true;
	const shouldCheckPython =
		!skipPythonPreflight &&
		pythonMode !== "bash-only" &&
		(requestedTools === undefined || requestedTools.includes("python"));
	const isTestEnv = isBunTestRuntime();
	const forcePythonWarmup = session.forcePythonWarmup === true;
	const skipPythonWarm = (isTestEnv && !forcePythonWarmup) || $flag("PI_PYTHON_SKIP_CHECK");
	const cachedPreludeDocs = getPreludeDocs();
	const shouldWarmPython = !skipPythonWarm && (forcePythonWarmup || cachedPreludeDocs.length === 0);
	if (shouldCheckPython) {
		const availability = await logger.time("createTools:pythonCheck", checkPythonKernelAvailability, session.cwd);
		pythonAvailable = availability.ok;
		if (!availability.ok) {
			logger.warn("Python kernel unavailable, falling back to bash", {
				reason: availability.reason,
			});
		} else if (shouldWarmPython) {
			const sessionFile = session.getSessionFile?.() ?? undefined;
			const kernelOwnerId = session.getPythonKernelOwnerId?.() ?? undefined;
			const warmSessionId = sessionFile ? `session:${sessionFile}:cwd:${session.cwd}` : `cwd:${session.cwd}`;
			const warmupAbortController = new AbortController();
			try {
				session.assertPythonExecutionAllowed?.();
				if (forcePythonWarmup && cachedPreludeDocs.length > 0) {
					resetPreludeDocsCache();
				}
				const warmupExecution = session.trackPythonExecution
					? logger.time(
							"createTools:warmPython",
							warmPythonEnvironment,
							session.cwd,
							warmSessionId,
							session.settings.get("python.sharedGateway"),
							sessionFile,
							kernelOwnerId,
							warmupAbortController.signal,
						)
					: logger.time(
							"createTools:warmPython",
							warmPythonEnvironment,
							session.cwd,
							warmSessionId,
							session.settings.get("python.sharedGateway"),
							sessionFile,
							kernelOwnerId,
						);
				await (session.trackPythonExecution?.(warmupExecution, warmupAbortController) ?? warmupExecution);
				session.assertPythonExecutionAllowed?.();
			} catch (err) {
				logger.warn("Failed to warm Python environment", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	const effectiveMode = pythonAvailable ? pythonMode : "bash-only";
	const allowBash = effectiveMode !== "ipy-only";
	const allowPython = effectiveMode !== "bash-only";
	if (
		requestedTools &&
		allowBash &&
		!allowPython &&
		requestedTools.includes("python") &&
		!requestedTools.includes("bash")
	) {
		requestedTools.push("bash");
	}

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
	}
	const allTools: Record<string, ToolFactory> = { ...BUILTIN_TOOLS, ...HIDDEN_TOOLS };
	const isToolAllowed = (name: string) => {
		if (name === "lsp") return enableLsp && session.settings.get("lsp.enabled");
		if (name === "bash") return allowBash;
		if (name === "python") return allowPython;
		if (name === "debug") return session.settings.get("debug.enabled");
		if (name === "todo_write") return !includeSubmitResult && session.settings.get("todo.enabled");
		if (name === "find") return session.settings.get("find.enabled");
		if (name === "grep") return session.settings.get("grep.enabled");
		if (name.startsWith("gh_")) return session.settings.get("github.enabled");
		if (name === "ast_grep") return session.settings.get("astGrep.enabled");
		if (name === "ast_edit") return session.settings.get("astEdit.enabled");
		if (name === "render_mermaid") return session.settings.get("renderMermaid.enabled");
		if (name === "notebook") return session.settings.get("notebook.enabled");
		if (name === "inspect_image") return session.settings.get("inspect_image.enabled");
		if (name === "web_search") return session.settings.get("web_search.enabled");
		if (name === "search_tool_bm25") return session.settings.get("mcp.discoveryMode");
		if (name === "calc") return session.settings.get("calc.enabled");
		if (name === "browser") return session.settings.get("browser.enabled");
		if (name === "checkpoint" || name === "rewind") return session.settings.get("checkpoint.enabled");
		if (name === "task") {
			const maxDepth = session.settings.get("task.maxRecursionDepth") ?? 2;
			const currentDepth = session.taskDepth ?? 0;
			return maxDepth < 0 || currentDepth < maxDepth;
		}
		return true;
	};
	if (includeSubmitResult && requestedTools && !requestedTools.includes("submit_result")) {
		requestedTools.push("submit_result");
	}

	const filteredRequestedTools = requestedTools?.filter(name => name in allTools && isToolAllowed(name));
	const baseEntries =
		filteredRequestedTools !== undefined
			? filteredRequestedTools.filter(name => name !== "resolve").map(name => [name, allTools[name]] as const)
			: [
					...Object.entries(BUILTIN_TOOLS).filter(([name]) => isToolAllowed(name)),
					...(includeSubmitResult ? ([["submit_result", HIDDEN_TOOLS.submit_result]] as const) : []),
					...([["exit_plan_mode", HIDDEN_TOOLS.exit_plan_mode]] as const),
				];

	const baseResults = await Promise.all(
		baseEntries.map(async ([name, factory]) => {
			const tool = await logger.time(`createTools:${name}`, factory, session);
			return tool ? wrapToolWithMetaNotice(tool) : null;
		}),
	);
	const tools = baseResults.filter((r): r is Tool => r !== null);
	const hasDeferrableTools = tools.some(tool => tool.deferrable === true);
	if (hasDeferrableTools && !tools.some(tool => tool.name === "resolve")) {
		const resolveTool = await logger.time("createTools:resolve", HIDDEN_TOOLS.resolve, session);
		if (resolveTool) {
			tools.push(wrapToolWithMetaNotice(resolveTool));
		}
	}

	// Auto-inject report_tool_issue when autoqa is enabled (env or setting).
	// Injected unconditionally into every agent, regardless of requested tool list.
	const autoQA = isAutoQaEnabled(session.settings);
	if (autoQA && !tools.some(t => t.name === "report_tool_issue")) {
		const qaTool = await HIDDEN_TOOLS.report_tool_issue(session);
		if (qaTool) {
			tools.push(wrapToolWithMetaNotice(qaTool));
		}
	}

	return tools;
}
