import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ToolChoice } from "@oh-my-pi/pi-ai";
import { $env, $flag, logger } from "@oh-my-pi/pi-utils";
import type { AsyncJobManager } from "../async";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import { EditTool } from "../edit";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import type { Skill } from "../extensibility/skills";
import type { InternalUrlRouter } from "../internal-urls";
import { LspTool } from "../lsp";
import type { DiscoverableMCPSearchIndex, DiscoverableMCPTool } from "../mcp/discoverable-tool-metadata";
import type { PlanModeState } from "../plan-mode/state";
import type { AgentRegistry } from "../registry/agent-registry";
import type { CustomMessage } from "../session/messages";
import type { ToolChoiceQueue } from "../session/tool-choice-queue";
import { TaskTool } from "../task";
import type { AgentOutputManager } from "../task/output-manager";
import type { EventBus } from "../utils/event-bus";
import { WebSearchTool } from "../web/search";
import { AskTool } from "./ask";
import { AstEditTool } from "./ast-edit";
import { AstGrepTool } from "./ast-grep";
import { BashTool } from "./bash";
import { BrowserTool } from "./browser";
import { CalculatorTool } from "./calculator";
import { type CheckpointState, CheckpointTool, RewindTool } from "./checkpoint";
import { DebugTool } from "./debug";
import { EvalTool } from "./eval";
import { ExitPlanModeTool } from "./exit-plan-mode";
import { FindTool } from "./find";
import { GithubTool } from "./gh";
import { HindsightRecallTool } from "./hindsight-recall";
import { HindsightReflectTool } from "./hindsight-reflect";
import { HindsightRetainTool } from "./hindsight-retain";
import { InspectImageTool } from "./inspect-image";
import { IrcTool } from "./irc";
import { JobTool } from "./job";
import { NotebookTool } from "./notebook";
import { wrapToolWithMetaNotice } from "./output-meta";
import { ReadTool } from "./read";
import { RecipeTool } from "./recipe";
import { RenderMermaidTool } from "./render-mermaid";
import { createReportToolIssueTool, isAutoQaEnabled } from "./report-tool-issue";
import { ResolveTool } from "./resolve";
import { reportFindingTool } from "./review";
import { SearchTool } from "./search";
import { SearchToolBm25Tool } from "./search-tool-bm25";
import { loadSshTool } from "./ssh";
import { type TodoPhase, TodoWriteTool } from "./todo-write";
import { WriteTool } from "./write";
import { YieldTool } from "./yield";

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
export * from "./checkpoint";
export * from "./debug";
export * from "./eval";
export * from "./exit-plan-mode";
export * from "./find";
export * from "./gh";
export * from "./hindsight-recall";
export * from "./hindsight-reflect";
export * from "./hindsight-retain";
export * from "./image-gen";
export * from "./inspect-image";
export * from "./irc";
export * from "./job";
export * from "./notebook";
export * from "./read";
export * from "./recipe";
export * from "./render-mermaid";
export * from "./report-tool-issue";
export * from "./resolve";
export * from "./review";
export * from "./search";
export * from "./search-tool-bm25";
export * from "./ssh";
export * from "./todo-write";
export * from "./vim";
export * from "./write";
export * from "./yield";

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
	/** Whether to include the yield tool by default */
	requireYieldTool?: boolean;
	/** Task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	/** Get session file */
	getSessionFile: () => string | null;
	/** Get eval kernel owner ID for session-scoped retained-kernel cleanup. */
	getEvalKernelOwnerId?: () => string | null;
	/** Reject new eval (python or js) work once session disposal has started. */
	assertEvalExecutionAllowed?: () => void;
	/** Track tool-owned eval work so session disposal can await/abort it like direct session eval runs. */
	trackEvalExecution?<T>(execution: Promise<T>, abortController: AbortController): Promise<T>;
	/** Get session ID */
	getSessionId?: () => string | null;
	/** Agent identity used for IRC routing. Returns the registry id (e.g. "0-Main", "0-AuthLoader"). */
	getAgentId?: () => string | null;
	/** Look up a registered tool by name (used by the eval js backend's tool bridge). */
	getToolByName?: (name: string) => AgentTool | undefined;
	/** Agent registry for IRC routing across live sessions. */
	agentRegistry?: AgentRegistry;
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
	eval: s => new EvalTool(s),
	calc: s => new CalculatorTool(s),
	ssh: loadSshTool,
	edit: s => new EditTool(s),
	github: GithubTool.createIf,
	find: s => new FindTool(s),
	search: s => new SearchTool(s),
	lsp: LspTool.createIf,
	notebook: s => new NotebookTool(s),
	read: s => new ReadTool(s),
	inspect_image: s => new InspectImageTool(s),
	browser: s => new BrowserTool(s),
	checkpoint: CheckpointTool.createIf,
	rewind: RewindTool.createIf,
	task: TaskTool.create,
	job: JobTool.createIf,
	recipe: RecipeTool.createIf,
	irc: IrcTool.createIf,
	todo_write: s => new TodoWriteTool(s),
	web_search: s => new WebSearchTool(s),
	search_tool_bm25: SearchToolBm25Tool.createIf,
	write: s => new WriteTool(s),
	hindsight_retain: HindsightRetainTool.createIf,
	hindsight_recall: HindsightRecallTool.createIf,
	hindsight_reflect: HindsightReflectTool.createIf,
};

export const HIDDEN_TOOLS: Record<string, ToolFactory> = {
	yield: s => new YieldTool(s),
	report_finding: () => reportFindingTool,
	report_tool_issue: s => createReportToolIssueTool(s),
	exit_plan_mode: s => new ExitPlanModeTool(s),
	resolve: s => new ResolveTool(s),
};

export type ToolName = keyof typeof BUILTIN_TOOLS;

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
}

/**
 * Parse PI_PY / PI_JS environment variables. Each is a boolean flag; unset
 * means "not specified, defer to settings". Returns null when neither is set
 * so the caller can fall through to `readEvalBackendsAllowance` per key.
 */
function getEvalBackendsFromEnv(): EvalBackendsAllowance | null {
	const pyEnv = $env.PI_PY;
	const jsEnv = $env.PI_JS;
	if (pyEnv === undefined && jsEnv === undefined) return null;
	return {
		python: pyEnv === undefined ? true : $flag("PI_PY"),
		js: jsEnv === undefined ? true : $flag("PI_JS"),
	};
}

/** Read per-backend allowance from settings (defaults true). */
export function readEvalBackendsAllowance(session: ToolSession): EvalBackendsAllowance {
	return {
		python: session.settings.get("eval.py") ?? true,
		js: session.settings.get("eval.js") ?? true,
	};
}

/**
 * Materialize the active eval backend allowance: PI_PY / PI_JS env flags
 * override the per-key settings; otherwise settings (defaults true) win.
 */
export function resolveEvalBackends(session: ToolSession): EvalBackendsAllowance {
	return getEvalBackendsFromEnv() ?? readEvalBackendsAllowance(session);
}

/**
 * Create tools from BUILTIN_TOOLS registry.
 */
export async function createTools(session: ToolSession, toolNames?: string[]): Promise<Tool[]> {
	const includeYield = session.requireYieldTool === true;
	const enableLsp = session.enableLsp ?? true;
	const requestedTools =
		toolNames && toolNames.length > 0 ? [...new Set(toolNames.map(name => name.toLowerCase()))] : undefined;
	if (requestedTools && !requestedTools.includes("exit_plan_mode")) {
		requestedTools.push("exit_plan_mode");
	}
	const backends = resolveEvalBackends(session);
	const allowPython = backends.python;
	const allowJs = backends.js;
	const skipPythonPreflight = session.skipPythonPreflight === true;
	// Eval tool is enabled if EITHER backend is reachable. We only need to know
	// whether python is reachable when JS is disabled — otherwise allowEval is
	// already true and the python-availability check can be deferred to first
	// invocation of the python backend (already handled inside the executor).
	let pythonAvailable = true;
	if (
		!skipPythonPreflight &&
		allowPython &&
		!allowJs &&
		(requestedTools === undefined || requestedTools.includes("eval"))
	) {
		const availability = await logger.time("createTools:pythonCheck", checkPythonKernelAvailability, session.cwd);
		pythonAvailable = availability.ok;
		if (!availability.ok) {
			logger.warn("Python kernel unavailable and JS backend disabled; eval will be unavailable", {
				reason: availability.reason,
			});
		}
	}

	const effectivePythonAllowed = allowPython && pythonAvailable;
	// Eval is exposed whenever any backend is reachable. The python backend may
	// be unreachable, in which case eval dispatches exclusively to js.
	const allowEval = effectivePythonAllowed || allowJs;

	// Auto-include AST counterparts when their text-based sibling is present
	if (requestedTools) {
		if (
			requestedTools.includes("search") &&
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
		if (
			requestedTools.includes("bash") &&
			!requestedTools.includes("recipe") &&
			session.settings.get("recipe.enabled")
		) {
			requestedTools.push("recipe");
		}
	}
	const allTools: Record<string, ToolFactory> = { ...BUILTIN_TOOLS, ...HIDDEN_TOOLS };
	const isToolAllowed = (name: string) => {
		if (name === "lsp") return enableLsp && session.settings.get("lsp.enabled");
		if (name === "bash") return true;
		if (name === "eval") return allowEval;
		if (name === "debug") return session.settings.get("debug.enabled");
		if (name === "todo_write") return !includeYield && session.settings.get("todo.enabled");
		if (name === "find") return session.settings.get("find.enabled");
		if (name === "search") return session.settings.get("search.enabled");
		if (name === "github") return session.settings.get("github.enabled");
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
		if (name === "irc") return session.settings.get("irc.enabled");
		if (name === "recipe") return session.settings.get("recipe.enabled");
		if (name === "hindsight_retain" || name === "hindsight_recall" || name === "hindsight_reflect") {
			return session.settings.get("memory.backend") === "hindsight";
		}
		if (name === "task") {
			const maxDepth = session.settings.get("task.maxRecursionDepth") ?? 2;
			const currentDepth = session.taskDepth ?? 0;
			return maxDepth < 0 || currentDepth < maxDepth;
		}
		return true;
	};
	if (includeYield && requestedTools && !requestedTools.includes("yield")) {
		requestedTools.push("yield");
	}

	const filteredRequestedTools = requestedTools?.filter(name => name in allTools && isToolAllowed(name));
	const baseEntries =
		filteredRequestedTools !== undefined
			? filteredRequestedTools.filter(name => name !== "resolve").map(name => [name, allTools[name]] as const)
			: [
					...Object.entries(BUILTIN_TOOLS).filter(([name]) => isToolAllowed(name)),
					...(includeYield ? ([["yield", HIDDEN_TOOLS.yield]] as const) : []),
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
