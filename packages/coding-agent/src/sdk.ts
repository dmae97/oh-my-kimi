import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	INTENT_FIELD,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type { Message, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import {
	getOpenAICodexTransportDetails,
	prewarmOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Component } from "@oh-my-pi/pi-tui";
import {
	$env,
	$flag,
	getAgentDbPath,
	getAgentDir,
	getProjectDir,
	logger,
	postmortem,
	prompt,
	Snowflake,
} from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { AsyncJobManager, isBackgroundJobSupportEnabled } from "./async";
import { createAutoresearchExtension } from "./autoresearch";
import { loadCapability } from "./capability";
import { type Rule, ruleCapability } from "./capability/rule";
import { ModelRegistry } from "./config/model-registry";
import { formatModelString, parseModelPattern, parseModelString, resolveModelRoleValue } from "./config/model-resolver";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "./config/prompt-templates";
import { Settings, type SkillsSettings } from "./config/settings";
import { CursorExecHandlers } from "./cursor";
import "./discovery";
import { resolveConfigValue } from "./config/resolve-config-value";
import { initializeWithSettings } from "./discovery";
import { disposeAllKernelSessions, disposeKernelSessionsByOwner } from "./eval/py/executor";
import { TtsrManager } from "./export/ttsr";
import {
	type CustomCommandsLoadResult,
	type LoadedCustomCommand,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./extensibility/custom-commands";
import { discoverAndLoadCustomTools } from "./extensibility/custom-tools";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "./extensibility/custom-tools/types";
import { CustomToolAdapter } from "./extensibility/custom-tools/wrapper";
import {
	discoverAndLoadExtensions,
	type ExtensionContext,
	type ExtensionFactory,
	ExtensionRunner,
	ExtensionToolWrapper,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
	type ToolDefinition,
	wrapRegisteredTools,
} from "./extensibility/extensions";
import { loadSkills as loadSkillsInternal, type Skill, type SkillWarning } from "./extensibility/skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "./extensibility/slash-commands";
import {
	AgentProtocolHandler,
	ArtifactProtocolHandler,
	InternalUrlRouter,
	JobsProtocolHandler,
	LocalProtocolHandler,
	type LocalProtocolOptions,
	McpProtocolHandler,
	MemoryProtocolHandler,
	PiProtocolHandler,
	RuleProtocolHandler,
	SkillProtocolHandler,
} from "./internal-urls";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "./lsp/startup-events";
import { discoverAndLoadMCPTools, type MCPManager, type MCPToolsLoadResult } from "./mcp";
import {
	collectDiscoverableMCPTools,
	formatDiscoverableMCPToolServerSummary,
	selectDiscoverableMCPToolNamesByServer,
	summarizeDiscoverableMCPTools,
} from "./mcp/discoverable-tool-metadata";
import { buildMemoryToolDeveloperInstructions, getMemoryRoot, startMemoryStartupTask } from "./memories";
import asyncResultTemplate from "./prompts/tools/async-result.md" with { type: "text" };
import { AgentRegistry, MAIN_AGENT_ID } from "./registry/agent-registry";
import {
	collectEnvSecrets,
	deobfuscateSessionContext,
	loadSecrets,
	obfuscateMessages,
	SecretObfuscator,
} from "./secrets";
import { AgentSession } from "./session/agent-session";
import { AuthStorage } from "./session/auth-storage";
import { convertToLlm } from "./session/messages";
import { SessionManager } from "./session/session-manager";
import { closeAllConnections } from "./ssh/connection-manager";
import { unmountAll } from "./ssh/sshfs-mount";
import {
	type AgentsMdSearch,
	buildAgentsMdSearch,
	buildSystemPrompt as buildSystemPromptInternal,
	buildSystemPromptToolMetadata,
	loadProjectContextFiles as loadContextFilesInternal,
} from "./system-prompt";
import { AgentOutputManager } from "./task/output-manager";
import { parseThinkingLevel, resolveThinkingLevelForModel, toReasoningEffort } from "./thinking";
import {
	BashTool,
	BUILTIN_TOOLS,
	createTools,
	discoverStartupLspServers,
	EditTool,
	EvalTool,
	FindTool,
	getSearchTools,
	HIDDEN_TOOLS,
	isSearchProviderPreference,
	type LspStartupServerInfo,
	loadSshTool,
	ReadTool,
	ResolveTool,
	renderSearchToolBm25Description,
	SearchTool,
	setPreferredImageProvider,
	setPreferredSearchProvider,
	type Tool,
	type ToolSession,
	WebSearchTool,
	WriteTool,
	warmupLspServers,
} from "./tools";
import { ToolContextStore } from "./tools/context";
import { getImageGenTools } from "./tools/image-gen";
import { wrapToolWithMetaNotice } from "./tools/output-meta";
import { queueResolveHandler } from "./tools/resolve";
import { EventBus } from "./utils/event-bus";
import { buildNamedToolChoice } from "./utils/tool-choice";

// Types
export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: getProjectDir() */
	cwd?: string;
	/** Global config directory. Default: ~/.omp/agent */
	agentDir?: string;
	/** Spawns to allow. Default: "*" */
	spawns?: string;

	/** Auth storage for credentials. Default: discoverAuthStorage(agentDir) */
	authStorage?: AuthStorage;
	/** Model registry. Default: discoverModels(authStorage, agentDir) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model;
	/** Raw model pattern string (e.g. from --model CLI flag) to resolve after extensions load.
	 * Used when model lookup is deferred because extension-provided models aren't registered yet. */
	modelPattern?: string;
	/** Thinking selector. Default: from settings, else unset */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;

	/** System prompt. String replaces default, function receives default and returns final. */
	systemPrompt?: string | ((defaultPrompt: string) => string);
	/** Optional provider-facing session identifier for prompt caches and sticky auth selection.
	 * Keeps persisted session files isolated while reusing provider-side caches. */
	providerSessionId?: string;

	/** Custom tools to register (in addition to built-in tools). Accepts both CustomTool and ToolDefinition. */
	customTools?: (CustomTool | ToolDefinition)[];
	/** Inline extensions (merged with discovery). */
	extensions?: ExtensionFactory[];
	/** Additional extension paths to load (merged with discovery). */
	additionalExtensionPaths?: string[];
	/** Disable extension discovery (explicit paths still load). */
	disableExtensionDiscovery?: boolean;
	/**
	 * Pre-loaded extensions (skips file discovery).
	 * @internal Used by CLI when extensions are loaded early to parse custom flags.
	 */
	preloadedExtensions?: LoadExtensionsResult;

	/** Shared event bus for tool/extension communication. Default: creates new bus. */
	eventBus?: EventBus;

	/** Skills. Default: discovered from multiple locations */
	skills?: Skill[];
	/** Rules. Default: discovered from multiple locations */
	rules?: Rule[];
	/** Context files (AGENTS.md content). Default: discovered walking up from cwd */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Prompt templates. Default: discovered from cwd/.omp/prompts/ + agentDir/prompts/ */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands. Default: discovered from commands/ directories */
	slashCommands?: FileSlashCommand[];

	/** Enable MCP server discovery from .mcp.json files. Default: true */
	enableMCP?: boolean;
	/** Existing MCP manager to reuse (skips discovery, propagates to toolSession). */
	mcpManager?: MCPManager;

	/** Enable LSP integration (tool, formatting, diagnostics, warmup). Default: true */
	enableLsp?: boolean;
	/** Skip Python kernel availability check and prelude warmup */
	skipPythonPreflight?: boolean;
	/** Tool names explicitly requested (enables disabled-by-default tools) */
	toolNames?: string[];

	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
	/** Whether to include the yield tool by default */
	requireYieldTool?: boolean;
	/** Task recursion depth (for subagent sessions). Default: 0 */
	taskDepth?: number;
	/** Pre-allocated agent identity for IRC routing. Default: "0-Main" for top-level, parentTaskPrefix-derived for sub. */
	agentId?: string;
	/** Display name for the agent in IRC. Default: "main" or "sub". */
	agentDisplayName?: string;
	/** Optional shared agent registry for IRC routing. Default: AgentRegistry.global(). */
	agentRegistry?: AgentRegistry;
	/** Parent task ID prefix for nested artifact naming (e.g., "6-Extensions") */
	parentTaskPrefix?: string;

	/** Session manager. Default: session stored under the configured agentDir sessions root */
	sessionManager?: SessionManager;

	/** Override local:// protocol options for subagent local:// sharing. Default: uses the session's own artifacts dir and session ID. */
	localProtocolOptions?: LocalProtocolOptions;

	/** Settings instance. Default: Settings.init({ cwd, agentDir }) */
	settings?: Settings;

	/** Whether UI is available (enables interactive tools like ask). Default: false */
	hasUI?: boolean;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (loaded extensions + runtime) */
	extensionsResult: LoadExtensionsResult;
	/** Update tool UI context (interactive mode) */
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** MCP manager for server lifecycle management (undefined if MCP disabled) */
	mcpManager?: MCPManager;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** LSP servers detected for startup; warmup may continue in the background */
	lspServers?: LspStartupServerInfo[];
	/** Shared event bus for tool/extension communication */
	eventBus: EventBus;
}

// Re-exports

export type { PromptTemplate } from "./config/prompt-templates";
export { Settings, type SkillsSettings } from "./config/settings";
export type { CustomCommand, CustomCommandFactory } from "./extensibility/custom-commands/types";
export type { CustomTool, CustomToolFactory } from "./extensibility/custom-tools/types";
export type * from "./extensibility/extensions";
export type { Skill } from "./extensibility/skills";
export type { FileSlashCommand } from "./extensibility/slash-commands";
export type { MCPManager, MCPServerConfig, MCPServerConnection, MCPToolsLoadResult } from "./mcp";
export type { Tool } from "./tools";

export {
	// Individual tool classes (for custom usage)
	BashTool,
	// Tool classes and factories
	BUILTIN_TOOLS,
	createTools,
	EditTool,
	EvalTool,
	FindTool,
	HIDDEN_TOOLS,
	loadSshTool,
	ReadTool,
	ResolveTool,
	SearchTool,
	type ToolSession,
	WebSearchTool,
	WriteTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

// Discovery Functions

/**
 * Create an AuthStorage instance with fallback support.
 * Reads from primary path first, then falls back to legacy paths (.pi, .claude).
 */
export async function discoverAuthStorage(agentDir: string = getDefaultAgentDir()): Promise<AuthStorage> {
	const dbPath = getAgentDbPath(agentDir);

	const storage = await AuthStorage.create(dbPath, { configValueResolver: resolveConfigValue });
	await storage.reload();
	return storage;
}

/**
 * Discover extensions from cwd.
 */
export async function discoverExtensions(cwd?: string): Promise<LoadExtensionsResult> {
	const resolvedCwd = cwd ?? getProjectDir();

	return discoverAndLoadExtensions([], resolvedCwd);
}

/**
 * Discover skills from cwd and agentDir.
 */
export async function discoverSkills(
	cwd?: string,
	_agentDir?: string,
	settings?: SkillsSettings,
): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
	return await loadSkillsInternal({
		...settings,
		cwd: cwd ?? getProjectDir(),
	});
}

/**
 * Discover context files (AGENTS.md) walking up from cwd.
 * Returns files sorted by depth (farther from cwd first, so closer files appear last/more prominent).
 */
export async function discoverContextFiles(
	cwd?: string,
	_agentDir?: string,
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
	});
}

/**
 * Discover prompt templates from cwd and agentDir.
 */
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getDefaultAgentDir(),
	});
}

/**
 * Discover file-based slash commands from commands/ directories.
 */
export async function discoverSlashCommands(cwd?: string): Promise<FileSlashCommand[]> {
	return loadSlashCommandsInternal({ cwd: cwd ?? getProjectDir() });
}

/**
 * Discover custom commands (TypeScript slash commands) from cwd and agentDir.
 */
export async function discoverCustomTSCommands(cwd?: string, agentDir?: string): Promise<CustomCommandsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	const resolvedAgentDir = agentDir ?? getDefaultAgentDir();

	return loadCustomCommandsInternal({
		cwd: resolvedCwd,
		agentDir: resolvedAgentDir,
	});
}

/**
 * Discover MCP servers from .mcp.json files.
 * Returns the manager and loaded tools.
 */
export async function discoverMCPServers(cwd?: string): Promise<MCPToolsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	return discoverAndLoadMCPTools(resolvedCwd);
}

// API Key Helpers

// System Prompt

export interface BuildSystemPromptOptions {
	tools?: Tool[];
	skills?: Skill[];
	contextFiles?: Array<{ path: string; content: string }>;
	cwd?: string;
	appendPrompt?: string;
	repeatToolDescriptions?: boolean;
}

/**
 * Build the default system prompt.
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<string> {
	return await buildSystemPromptInternal({
		cwd: options.cwd,
		skills: options.skills,
		contextFiles: options.contextFiles,
		appendSystemPrompt: options.appendPrompt,
		repeatToolDescriptions: options.repeatToolDescriptions,
	});
}

// Internal Helpers

function createCustomToolContext(ctx: ExtensionContext): CustomToolContext {
	return {
		sessionManager: ctx.sessionManager,
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		isIdle: ctx.isIdle,
		hasQueuedMessages: ctx.hasPendingMessages,
		abort: ctx.abort,
	};
}

function isCustomTool(tool: CustomTool | ToolDefinition): tool is CustomTool {
	// To distinguish, we mark converted tools with a hidden symbol property.
	// If the tool doesn't have this marker, it's a CustomTool that needs conversion.
	return !(tool as any).__isToolDefinition;
}

const TOOL_DEFINITION_MARKER = Symbol("__isToolDefinition");

let sshCleanupRegistered = false;

async function cleanupSshResources(): Promise<void> {
	const results = await Promise.allSettled([closeAllConnections(), unmountAll()]);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("SSH cleanup failed", { error: String(result.reason) });
		}
	}
}

function registerSshCleanup(): void {
	if (sshCleanupRegistered) return;
	sshCleanupRegistered = true;
	postmortem.register("ssh-cleanup", cleanupSshResources);
}

let pythonCleanupRegistered = false;

function registerPythonCleanup(): void {
	if (pythonCleanupRegistered) return;
	pythonCleanupRegistered = true;
	postmortem.register("python-cleanup", disposeAllKernelSessions);
}

function customToolToDefinition(tool: CustomTool): ToolDefinition {
	const definition: ToolDefinition & { [TOOL_DEFINITION_MARKER]: true } = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		hidden: tool.hidden,
		deferrable: tool.deferrable,
		mcpServerName: tool.mcpServerName,
		mcpToolName: tool.mcpToolName,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			tool.execute(toolCallId, params, onUpdate, createCustomToolContext(ctx), signal),
		onSession: tool.onSession ? (event, ctx) => tool.onSession?.(event, createCustomToolContext(ctx)) : undefined,
		renderCall: tool.renderCall,
		renderResult: tool.renderResult
			? (result, options, theme): Component => {
					const component = tool.renderResult?.(
						result,
						{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
						theme,
					);
					// Return empty component if undefined to match Component type requirement
					return component ?? ({ render: () => [] } as unknown as Component);
				}
			: undefined,
		[TOOL_DEFINITION_MARKER]: true,
	};
	return definition;
}

function createCustomToolsExtension(tools: CustomTool[]): ExtensionFactory {
	return api => {
		for (const tool of tools) {
			api.registerTool(customToolToDefinition(tool));
		}

		const runOnSession = async (event: CustomToolSessionEvent, ctx: ExtensionContext) => {
			for (const tool of tools) {
				if (!tool.onSession) continue;
				try {
					await tool.onSession(event, createCustomToolContext(ctx));
				} catch (err) {
					logger.warn("Custom tool onSession error", { tool: tool.name, error: String(err) });
				}
			}
		};

		api.on("session_start", async (_event, ctx) =>
			runOnSession({ reason: "start", previousSessionFile: undefined }, ctx),
		);
		api.on("session_switch", async (event, ctx) =>
			runOnSession({ reason: "switch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_branch", async (event, ctx) =>
			runOnSession({ reason: "branch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_tree", async (_event, ctx) =>
			runOnSession({ reason: "tree", previousSessionFile: undefined }, ctx),
		);
		api.on("session_shutdown", async (_event, ctx) =>
			runOnSession({ reason: "shutdown", previousSessionFile: undefined }, ctx),
		);
		api.on("auto_compaction_start", async (event, ctx) =>
			runOnSession({ reason: "auto_compaction_start", trigger: event.reason, action: event.action }, ctx),
		);
		api.on("auto_compaction_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_compaction_end",
					action: event.action,
					result: event.result,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
				},
				ctx,
			),
		);
		api.on("auto_retry_start", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				},
				ctx,
			),
		);
		api.on("auto_retry_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_end",
					success: event.success,
					attempt: event.attempt,
					finalError: event.finalError,
				},
				ctx,
			),
		);
		api.on("ttsr_triggered", async (event, ctx) =>
			runOnSession({ reason: "ttsr_triggered", rules: event.rules }, ctx),
		);
		api.on("todo_reminder", async (event, ctx) =>
			runOnSession(
				{
					reason: "todo_reminder",
					todos: event.todos,
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
				},
				ctx,
			),
		);
	};
}

// Factory

/**
 * Build LoadedCustomCommand entries for all MCP prompts across connected servers.
 * These are re-created whenever prompts change (setOnPromptsChanged callback).
 */
function buildMCPPromptCommands(manager: MCPManager): LoadedCustomCommand[] {
	const commands: LoadedCustomCommand[] = [];
	for (const serverName of manager.getConnectedServers()) {
		const prompts = manager.getServerPrompts(serverName);
		if (!prompts?.length) continue;
		for (const prompt of prompts) {
			const commandName = `${serverName}:${prompt.name}`;
			commands.push({
				path: `mcp:${commandName}`,
				resolvedPath: `mcp:${commandName}`,
				source: "bundled",
				command: {
					name: commandName,
					description: prompt.description ?? `MCP prompt from ${serverName}`,
					async execute(args: string[]) {
						const promptArgs: Record<string, string> = {};
						for (const arg of args) {
							const eqIdx = arg.indexOf("=");
							if (eqIdx > 0) {
								promptArgs[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
							}
						}
						const result = await manager.executePrompt(serverName, prompt.name, promptArgs);
						if (!result) return "";
						const parts: string[] = [];
						for (const msg of result.messages) {
							const contentItems = Array.isArray(msg.content) ? msg.content : [msg.content];
							for (const item of contentItems) {
								if (item.type === "text") {
									parts.push(item.text);
								} else if (item.type === "resource") {
									const resource = item.resource;
									if (resource.text) parts.push(resource.text);
								}
							}
						}
						return parts.join("\n\n");
					},
				},
			});
		}
	}
	return commands;
}
/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@oh-my-pi/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   getApiKey: async () => Bun.env.MY_KEY,
 *   systemPrompt: 'You are helpful.',
 *   tools: codingTools({ cwd: getProjectDir() }),
 *   skills: [],
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getDefaultAgentDir();
	const eventBus = options.eventBus ?? new EventBus();

	registerSshCleanup();
	registerPythonCleanup();

	// Use provided or create AuthStorage and ModelRegistry
	const authStorage = options.authStorage ?? (await logger.time("discoverModels", discoverAuthStorage, agentDir));
	const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage);

	const settings = options.settings ?? (await logger.time("settings", Settings.init, { cwd, agentDir }));
	logger.time("initializeWithSettings", initializeWithSettings, settings);
	if (!options.modelRegistry) {
		modelRegistry.refreshInBackground();
	}
	// Kick off AGENTS.md filesystem search in parallel — it is the slowest piece of buildSystemPrompt
	// (~200ms on large repos) and only needs `cwd`, so it can overlap with everything that follows.
	const agentsMdSearchPromise: Promise<AgentsMdSearch> = logger.time("buildAgentsMdSearch", buildAgentsMdSearch, cwd);
	agentsMdSearchPromise.catch(() => {});

	// Independent discoveries that depend only on cwd/agentDir — kicked off in parallel and awaited
	// at their respective consumer sites. Their work can overlap with model resolution, secret loading,
	// session-context build, tool creation, MCP discovery, and extension discovery.
	const contextFilesPromise = options.contextFiles
		? Promise.resolve(options.contextFiles)
		: logger.time("discoverContextFiles", discoverContextFiles, cwd, agentDir);
	contextFilesPromise.catch(() => {});
	const promptTemplatesPromise = options.promptTemplates
		? Promise.resolve(options.promptTemplates)
		: logger.time("discoverPromptTemplates", discoverPromptTemplates, cwd, agentDir);
	promptTemplatesPromise.catch(() => {});
	const slashCommandsPromise = options.slashCommands
		? Promise.resolve(options.slashCommands)
		: logger.time("discoverSlashCommands", discoverSlashCommands, cwd);
	slashCommandsPromise.catch(() => {});
	const skillsSettings = settings.getGroup("skills");
	const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
	const discoveredSkillsPromise =
		options.skills === undefined
			? logger.time("discoverSkills", discoverSkills, cwd, agentDir, {
					...skillsSettings,
					disabledExtensions: disabledExtensionIds,
				})
			: undefined;
	discoveredSkillsPromise?.catch(() => {});

	// Initialize provider preferences from settings
	const webSearchProvider = settings.get("providers.webSearch");
	if (typeof webSearchProvider === "string" && isSearchProviderPreference(webSearchProvider)) {
		setPreferredSearchProvider(webSearchProvider);
	}

	const imageProvider = settings.get("providers.image");
	if (
		imageProvider === "auto" ||
		imageProvider === "openai" ||
		imageProvider === "gemini" ||
		imageProvider === "openrouter"
	) {
		setPreferredImageProvider(imageProvider);
	}

	const sessionManager =
		options.sessionManager ??
		logger.time("sessionManager", () =>
			SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir)),
		);
	const providerSessionId = options.providerSessionId ?? sessionManager.getSessionId();
	const modelApiKeyAvailability = new Map<string, boolean>();
	const getModelAvailabilityKey = (candidate: Model): string =>
		`${candidate.provider}\u0000${candidate.baseUrl ?? ""}`;
	const hasModelApiKey = async (candidate: Model): Promise<boolean> => {
		const availabilityKey = getModelAvailabilityKey(candidate);
		const cached = modelApiKeyAvailability.get(availabilityKey);
		if (cached !== undefined) {
			return cached;
		}

		const hasKey = !!(await modelRegistry.getApiKey(candidate, providerSessionId));
		modelApiKeyAvailability.set(availabilityKey, hasKey);
		return hasKey;
	};

	// Load and create secret obfuscator early so resumed session state and prompt warnings
	// reflect actual loaded secrets, not just the setting toggle.
	let obfuscator: SecretObfuscator | undefined;
	if (settings.get("secrets.enabled")) {
		const fileEntries = await logger.time("loadSecrets", loadSecrets, cwd, agentDir);
		const envEntries = collectEnvSecrets();
		const allEntries = [...envEntries, ...fileEntries];
		if (allEntries.length > 0) {
			obfuscator = new SecretObfuscator(allEntries);
		}
	}
	const secretsEnabled = obfuscator?.hasSecrets() === true;

	// Check if session has existing data to restore
	const existingSession = logger.time("loadSessionContext", () =>
		deobfuscateSessionContext(sessionManager.buildSessionContext(), obfuscator),
	);
	const existingBranch = logger.time("getSessionBranch", () => sessionManager.getBranch());
	const hasExistingSession = existingBranch.length > 0;
	const hasThinkingEntry = existingBranch.some(entry => entry.type === "thinking_level_change");
	const hasServiceTierEntry = existingBranch.some(entry => entry.type === "service_tier_change");

	const hasExplicitModel = options.model !== undefined || options.modelPattern !== undefined;
	const modelMatchPreferences = {
		usageOrder: settings.getStorage()?.getModelUsageOrder(),
	};
	const defaultRoleSpec = logger.time("resolveDefaultModelRole", () =>
		resolveModelRoleValue(settings.getModelRole("default"), modelRegistry.getAvailable(), {
			settings,
			matchPreferences: modelMatchPreferences,
			modelRegistry,
		}),
	);
	let model = options.model;
	let modelFallbackMessage: string | undefined;
	// If session has data, try to restore model from it.
	// Skip restore when an explicit model was requested.
	const defaultModelStr = existingSession.models.default;
	if (!hasExplicitModel && !model && hasExistingSession && defaultModelStr) {
		await logger.time("restoreSessionModel", async () => {
			const parsedModel = parseModelString(defaultModelStr);
			if (parsedModel) {
				const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
				if (restoredModel && (await hasModelApiKey(restoredModel))) {
					model = restoredModel;
				}
			}
			if (!model) {
				modelFallbackMessage = `Could not restore model ${defaultModelStr}`;
			}
		});
	}

	// If still no model, try settings default.
	// Skip settings fallback when an explicit model was requested.
	if (!hasExplicitModel && !model && defaultRoleSpec.model) {
		const settingsDefaultModel = defaultRoleSpec.model;
		logger.time("resolveSettingsDefaultModel", () => {
			// defaultRoleSpec.model already comes from modelRegistry.getAvailable(),
			// so re-validating auth here just repeats the expensive lookup path.
			model = settingsDefaultModel;
		});
	}

	const taskDepth = options.taskDepth ?? 0;

	let thinkingLevel = options.thinkingLevel;

	// If session has data and includes a thinking entry, restore it
	if (thinkingLevel === undefined && hasExistingSession && hasThinkingEntry) {
		thinkingLevel = parseThinkingLevel(existingSession.thinkingLevel);
	}

	if (thinkingLevel === undefined && !hasExplicitModel && !hasThinkingEntry && defaultRoleSpec.explicitThinkingLevel) {
		thinkingLevel = defaultRoleSpec.thinkingLevel;
	}

	// Prefer the selected model's configured defaultLevel, otherwise fall back
	// to the global settings default.
	if (thinkingLevel === undefined && model?.thinking?.defaultLevel !== undefined) {
		thinkingLevel = model.thinking.defaultLevel;
	}
	if (thinkingLevel === undefined) {
		thinkingLevel = settings.get("defaultThinkingLevel");
	}
	if (model) {
		const resolvedModel = model;
		thinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
			resolveThinkingLevelForModel(resolvedModel, thinkingLevel),
		);
	}

	let skills: Skill[];
	let skillWarnings: SkillWarning[];
	if (options.skills !== undefined) {
		skills = options.skills;
		skillWarnings = [];
	} else {
		const discovered = await (discoveredSkillsPromise ?? Promise.resolve({ skills: [], warnings: [] }));
		skills = discovered.skills;
		skillWarnings = discovered.warnings;
	}

	// Discover rules and bucket them in one pass to avoid repeated scans over large rule sets.
	const { ttsrManager, rulebookRules, alwaysApplyRules } = await logger.time("discoverTtsrRules", async () => {
		const ttsrSettings = settings.getGroup("ttsr");
		const ttsrManager = new TtsrManager(ttsrSettings);
		const rulesResult =
			options.rules !== undefined
				? { items: options.rules, warnings: undefined }
				: await loadCapability<Rule>(ruleCapability.id, { cwd });
		const rulebookRules: Rule[] = [];
		const alwaysApplyRules: Rule[] = [];
		for (const rule of rulesResult.items) {
			const isTtsrRule = rule.condition && rule.condition.length > 0 ? ttsrManager.addRule(rule) : false;
			if (isTtsrRule) {
				continue;
			}
			if (rule.alwaysApply === true) {
				alwaysApplyRules.push(rule);
				continue;
			}
			if (rule.description) {
				rulebookRules.push(rule);
			}
		}
		if (existingSession.injectedTtsrRules.length > 0) {
			ttsrManager.restoreInjected(existingSession.injectedTtsrRules);
		}
		return { ttsrManager, rulebookRules, alwaysApplyRules };
	});

	const contextFiles = await contextFilesPromise;

	let agent: Agent;
	let session!: AgentSession;
	let hasSession = false;
	const enableLsp = options.enableLsp ?? true;
	const backgroundJobsEnabled = isBackgroundJobSupportEnabled(settings);
	const asyncMaxJobs = Math.min(100, Math.max(1, settings.get("async.maxJobs") ?? 100));
	const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
	const ASYNC_PREVIEW_MAX_CHARS = 4_000;
	const formatAsyncResultForFollowUp = async (result: string): Promise<string> => {
		if (result.length <= ASYNC_INLINE_RESULT_MAX_CHARS) {
			return result;
		}

		const preview = `${result.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
		try {
			const { path: artifactPath, id: artifactId } = await sessionManager.allocateArtifactPath("async");
			if (artifactPath && artifactId) {
				await Bun.write(artifactPath, result);
				return `${preview}\nFull output: artifact://${artifactId}`;
			}
		} catch (error) {
			logger.warn("Failed to persist async follow-up artifact", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		return preview;
	};
	const asyncJobManager = backgroundJobsEnabled
		? new AsyncJobManager({
				maxRunningJobs: asyncMaxJobs,
				onJobComplete: async (jobId, result, job) => {
					if (!session || asyncJobManager!.isDeliverySuppressed(jobId)) return;
					const formattedResult = await formatAsyncResultForFollowUp(result);
					if (asyncJobManager!.isDeliverySuppressed(jobId)) return;

					const message = prompt.render(asyncResultTemplate, { jobId, result: formattedResult });
					const durationMs = job ? Math.max(0, Date.now() - job.startTime) : undefined;
					await session.sendCustomMessage(
						{
							customType: "async-result",
							content: message,
							display: true,
							attribution: "agent",
							details: {
								jobId,
								type: job?.type,
								label: job?.label,
								durationMs,
							},
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				},
			})
		: undefined;

	const agentRegistry = options.agentRegistry ?? AgentRegistry.global();
	const resolvedAgentId = options.agentId ?? options.parentTaskPrefix ?? MAIN_AGENT_ID;
	const resolvedAgentDisplayName =
		options.agentDisplayName ?? ((options.taskDepth ?? 0) > 0 || options.parentTaskPrefix ? "sub" : "main");
	const evalKernelOwnerId = `agent-session:${Snowflake.next()}`;

	try {
		const getActiveModelString = (): string | undefined => {
			const activeModel = agent?.state.model;
			if (activeModel) return formatModelString(activeModel);
			if (model) return formatModelString(model);
			return undefined;
		};
		const toolSession: ToolSession = {
			cwd,
			hasUI: options.hasUI ?? false,
			enableLsp,
			get hasEditTool() {
				const requestedToolNames = options.toolNames
					? [...new Set(options.toolNames.map(name => name.toLowerCase()))]
					: undefined;
				return !requestedToolNames || requestedToolNames.includes("edit");
			},
			skipPythonPreflight: options.skipPythonPreflight,
			contextFiles,
			skills,
			eventBus,
			outputSchema: options.outputSchema,
			requireYieldTool: options.requireYieldTool,
			taskDepth: options.taskDepth ?? 0,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getEvalKernelOwnerId: () => evalKernelOwnerId,
			assertEvalExecutionAllowed: () => session?.assertEvalExecutionAllowed(),
			trackEvalExecution: (execution, abortController) =>
				session ? session.trackEvalExecution(execution, abortController) : execution,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			getAgentId: () => resolvedAgentId,
			getToolByName: name => session?.getToolByName(name),
			agentRegistry,
			getSessionSpawns: () => options.spawns ?? "*",
			getModelString: () => (hasExplicitModel && model ? formatModelString(model) : undefined),
			getActiveModelString,
			getPlanModeState: () => session.getPlanModeState(),
			getCompactContext: () => session.formatCompactContext(),
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: phases => session.setTodoPhases(phases),
			isMCPDiscoveryEnabled: () => session.isMCPDiscoveryEnabled(),
			getDiscoverableMCPTools: () => session.getDiscoverableMCPTools(),
			getDiscoverableMCPSearchIndex: () => session.getDiscoverableMCPSearchIndex(),
			getSelectedMCPToolNames: () => session.getSelectedMCPToolNames(),
			activateDiscoveredMCPTools: toolNames => session.activateDiscoveredMCPTools(toolNames),
			getCheckpointState: () => session.getCheckpointState(),
			setCheckpointState: state => session.setCheckpointState(state ?? undefined),
			getToolChoiceQueue: () => session.toolChoiceQueue,
			buildToolChoice: name => {
				const m = session.model;
				return m ? buildNamedToolChoice(name, m) : undefined;
			},
			steer: msg =>
				session.agent.steer({
					role: "custom",
					customType: msg.customType,
					content: msg.content,
					display: false,
					details: msg.details,
					attribution: "agent",
					timestamp: Date.now(),
				}),
			peekQueueInvoker: () => session.peekQueueInvoker(),
			allocateOutputArtifact: async toolType => {
				try {
					return await sessionManager.allocateArtifactPath(toolType);
				} catch {
					return {};
				}
			},
			settings,
			authStorage,
			modelRegistry,
			asyncJobManager,
		};

		// Initialize internal URL router for internal protocols (agent://, artifact://, memory://, skill://, rule://, mcp://, local://)
		const internalRouter = new InternalUrlRouter();
		const getArtifactsDir = () => sessionManager.getArtifactsDir();
		internalRouter.register(new AgentProtocolHandler({ getArtifactsDir }));
		internalRouter.register(new ArtifactProtocolHandler({ getArtifactsDir }));
		internalRouter.register(
			new MemoryProtocolHandler({
				getMemoryRoot: () => getMemoryRoot(agentDir, settings.getCwd()),
			}),
		);
		internalRouter.register(
			new LocalProtocolHandler(
				options.localProtocolOptions ?? {
					getArtifactsDir,
					getSessionId: () => sessionManager.getSessionId(),
				},
			),
		);
		internalRouter.register(
			new SkillProtocolHandler({
				getSkills: () => skills,
			}),
		);
		internalRouter.register(
			new RuleProtocolHandler({
				getRules: () => [...rulebookRules, ...alwaysApplyRules],
			}),
		);
		internalRouter.register(new PiProtocolHandler());
		internalRouter.register(new JobsProtocolHandler({ getAsyncJobManager: () => asyncJobManager }));
		internalRouter.register(new McpProtocolHandler({ getMcpManager: () => mcpManager }));
		toolSession.internalRouter = internalRouter;
		toolSession.getArtifactsDir = getArtifactsDir;
		toolSession.agentOutputManager = new AgentOutputManager(
			getArtifactsDir,
			options.parentTaskPrefix ? { parentPrefix: options.parentTaskPrefix } : undefined,
		);

		// Create built-in tools (already wrapped with meta notice formatting)
		const builtinTools = await logger.time("createAllTools", createTools, toolSession, options.toolNames);

		// Discover MCP tools from .mcp.json files
		let mcpManager: MCPManager | undefined = options.mcpManager;
		const enableMCP = options.enableMCP ?? true;
		const customTools: CustomTool[] = [];
		if (enableMCP && !mcpManager) {
			const mcpResult = await logger.time("discoverAndLoadMCPTools", discoverAndLoadMCPTools, cwd, {
				onConnecting: serverNames => {
					if (options.hasUI && serverNames.length > 0) {
						process.stderr.write(`${chalk.gray(`Connecting to MCP servers: ${serverNames.join(", ")}…`)}\n`);
					}
				},
				enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,
				// Always filter Exa - we have native integration
				filterExa: true,
				// Filter browser MCP servers when builtin browser tool is active
				filterBrowser: settings.get("browser.enabled") ?? false,
				cacheStorage: settings.getStorage(),
				authStorage,
			});
			mcpManager = mcpResult.manager;

			if (settings.get("mcp.notifications")) {
				mcpManager.setNotificationsEnabled(true);
			}
			// If we extracted Exa API keys from MCP configs and EXA_API_KEY isn't set, use the first one
			if (mcpResult.exaApiKeys.length > 0 && !$env.EXA_API_KEY) {
				Bun.env.EXA_API_KEY = mcpResult.exaApiKeys[0];
			}

			// Log MCP errors
			for (const { path, error } of mcpResult.errors) {
				logger.error("MCP tool load failed", { path, error });
			}

			if (mcpResult.tools.length > 0) {
				// MCP tools are LoadedCustomTool, extract the tool property
				customTools.push(...mcpResult.tools.map(loaded => loaded.tool));
			}
		}
		toolSession.mcpManager = mcpManager;

		// Add image tools when the active model or configured image providers can generate images.
		const imageGenTools = await logger.time("getImageGenTools", () => getImageGenTools(modelRegistry, model));
		if (imageGenTools.length > 0) {
			customTools.push(...(imageGenTools as unknown as CustomTool[]));
		}

		// Add web search tools
		if (options.toolNames?.includes("web_search")) {
			customTools.push(...getSearchTools());
		}

		// Discover and load custom tools from .omp/tools/, .claude/tools/, etc.
		const builtInToolNames = builtinTools.map(t => t.name);
		const discoveredCustomTools = await logger.time(
			"discoverAndLoadCustomTools",
			discoverAndLoadCustomTools,
			[],
			cwd,
			builtInToolNames,
			action => queueResolveHandler(toolSession, action),
		);
		for (const { path, error } of discoveredCustomTools.errors) {
			logger.error("Custom tool load failed", { path, error });
		}
		if (discoveredCustomTools.tools.length > 0) {
			customTools.push(...discoveredCustomTools.tools.map(loaded => loaded.tool));
		}

		const inlineExtensions: ExtensionFactory[] = options.extensions ? [...options.extensions] : [];
		inlineExtensions.push(createAutoresearchExtension);
		if (customTools.length > 0) {
			inlineExtensions.push(createCustomToolsExtension(customTools));
		}

		// Load extensions (discovers from standard locations + configured paths)
		let extensionsResult: LoadExtensionsResult;
		if (options.disableExtensionDiscovery) {
			const configuredPaths = options.additionalExtensionPaths ?? [];
			extensionsResult = await logger.time("loadExtensions", loadExtensions, configuredPaths, cwd, eventBus);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to load extension", { path, error });
			}
		} else if (options.preloadedExtensions) {
			extensionsResult = options.preloadedExtensions;
		} else {
			// Merge CLI extension paths with settings extension paths
			const configuredPaths = [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])];
			const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
			extensionsResult = await logger.time(
				"discoverAndLoadExtensions",
				discoverAndLoadExtensions,
				configuredPaths,
				cwd,
				eventBus,
				disabledExtensionIds,
			);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to load extension", { path, error });
			}
		}

		// Load inline extensions from factories
		if (inlineExtensions.length > 0) {
			for (let i = 0; i < inlineExtensions.length; i++) {
				const factory = inlineExtensions[i];
				const loaded = await loadExtensionFromFactory(
					factory,
					cwd,
					eventBus,
					extensionsResult.runtime,
					`<inline-${i}>`,
				);
				extensionsResult.extensions.push(loaded);
			}
		}

		// Process provider registrations queued during extension loading.
		// This must happen before the runner is created so that models registered by
		// extensions are available for model selection on session resume / fallback.
		const activeExtensionSources = extensionsResult.extensions.map(extension => extension.path);
		modelRegistry.syncExtensionSources(activeExtensionSources);
		for (const sourceId of new Set(activeExtensionSources)) {
			modelRegistry.clearSourceRegistrations(sourceId);
		}
		if (extensionsResult.runtime.pendingProviderRegistrations.length > 0) {
			for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
				modelRegistry.registerProvider(name, config, sourceId);
			}
			extensionsResult.runtime.pendingProviderRegistrations = [];
		}

		// Resolve deferred --model pattern now that extension models are registered.
		if (!model && options.modelPattern) {
			const availableModels = modelRegistry.getAll();
			const matchPreferences = {
				usageOrder: settings.getStorage()?.getModelUsageOrder(),
			};
			const { model: resolved } = parseModelPattern(options.modelPattern, availableModels, matchPreferences, {
				modelRegistry,
			});
			if (resolved) {
				model = resolved;
				modelFallbackMessage = undefined;
			} else {
				modelFallbackMessage = `Model "${options.modelPattern}" not found`;
			}
		}

		// Fall back to first available model with a valid API key.
		// Skip fallback if the user explicitly requested a model via --model that wasn't found.
		if (!model && !options.modelPattern) {
			const allModels = modelRegistry.getAll();
			for (const candidate of allModels) {
				if (await hasModelApiKey(candidate)) {
					model = candidate;
					break;
				}
			}
			if (model) {
				if (modelFallbackMessage) {
					modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
				}
			} else {
				modelFallbackMessage =
					"No models available. Use /login or set an API key environment variable. Then use /model to select a model.";
			}
		}

		// Discover custom commands (TypeScript slash commands)
		const customCommandsResult: CustomCommandsLoadResult = options.disableExtensionDiscovery
			? { commands: [], errors: [] }
			: await logger.time("discoverCustomCommands", loadCustomCommandsInternal, { cwd, agentDir });
		if (!options.disableExtensionDiscovery) {
			for (const { path, error } of customCommandsResult.errors) {
				logger.error("Failed to load custom command", { path, error });
			}
		}

		let extensionRunner: ExtensionRunner | undefined;
		if (extensionsResult.extensions.length > 0) {
			extensionRunner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);
		}

		const getSessionContext = () => ({
			sessionManager,
			modelRegistry,
			model: agent.state.model,
			isIdle: () => !session.isStreaming,
			hasQueuedMessages: () => session.queuedMessageCount > 0,
			abort: () => {
				session.abort();
			},
			settings,
		});
		const toolContextStore = new ToolContextStore(getSessionContext);

		const registeredTools = extensionRunner?.getAllRegisteredTools() ?? [];
		let wrappedExtensionTools: Tool[];

		if (extensionRunner) {
			// With extension runner: convert CustomTools to ToolDefinitions and wrap all together
			const allCustomTools = [
				...registeredTools,
				...(options.customTools?.map(tool => {
					const definition = isCustomTool(tool) ? customToolToDefinition(tool) : tool;
					return { definition, extensionPath: "<sdk>" };
				}) ?? []),
			];
			wrappedExtensionTools = wrapRegisteredTools(allCustomTools, extensionRunner);
		} else {
			// Without extension runner: wrap CustomTools directly with CustomToolAdapter
			// ToolDefinition items require ExtensionContext and cannot be used without a runner
			const customToolContext = (): CustomToolContext => ({
				sessionManager,
				modelRegistry,
				model: agent?.state.model,
				isIdle: () => !session?.isStreaming,
				hasQueuedMessages: () => (session?.queuedMessageCount ?? 0) > 0,
				abort: () => session?.abort(),
				settings,
			});
			wrappedExtensionTools = (options.customTools ?? [])
				.filter(isCustomTool)
				.map(tool => CustomToolAdapter.wrap(tool, customToolContext));
		}

		// All built-in tools are active (conditional tools like git/ask return null from factory if disabled)
		const toolRegistry = new Map<string, Tool>();
		for (const tool of builtinTools) {
			toolRegistry.set(tool.name, tool);
		}
		for (const tool of wrappedExtensionTools) {
			toolRegistry.set(tool.name, tool);
		}
		if (extensionRunner) {
			for (const tool of toolRegistry.values()) {
				toolRegistry.set(tool.name, new ExtensionToolWrapper(tool, extensionRunner));
			}
		}
		if (model?.provider === "cursor") {
			toolRegistry.delete("edit");
		}

		const hasDeferrableTools = Array.from(toolRegistry.values()).some(tool => tool.deferrable === true);
		if (!hasDeferrableTools) {
			toolRegistry.delete("resolve");
		} else if (!toolRegistry.has("resolve")) {
			const resolveTool = await logger.time("createTools:resolve:session", HIDDEN_TOOLS.resolve, toolSession);
			if (resolveTool) {
				toolRegistry.set(resolveTool.name, wrapToolWithMetaNotice(resolveTool));
			}
		}

		let cursorEventEmitter: ((event: AgentEvent) => void) | undefined;
		const cursorExecHandlers = new CursorExecHandlers({
			cwd,
			tools: toolRegistry,
			getToolContext: () => toolContextStore.getContext(),
			emitEvent: event => cursorEventEmitter?.(event),
		});

		const repeatToolDescriptions = settings.get("repeatToolDescriptions");
		const eagerTasks = settings.get("task.eager");
		const intentField = settings.get("tools.intentTracing") || $flag("PI_INTENT_TRACING") ? INTENT_FIELD : undefined;
		const rebuildSystemPrompt = async (toolNames: string[], tools: Map<string, AgentTool>): Promise<string> => {
			toolContextStore.setToolNames(toolNames);
			const discoverableMCPTools = mcpDiscoveryEnabled ? collectDiscoverableMCPTools(tools.values()) : [];
			const discoverableMCPSummary = summarizeDiscoverableMCPTools(discoverableMCPTools);
			const hasDiscoverableMCPTools =
				mcpDiscoveryEnabled && toolNames.includes("search_tool_bm25") && discoverableMCPTools.length > 0;
			const promptTools = buildSystemPromptToolMetadata(tools, {
				search_tool_bm25: { description: renderSearchToolBm25Description(discoverableMCPTools) },
			});
			const memoryInstructions = await buildMemoryToolDeveloperInstructions(agentDir, settings);

			// Build combined append prompt: memory instructions + MCP server instructions
			const serverInstructions = mcpManager?.getServerInstructions();
			let appendPrompt: string | undefined = memoryInstructions ?? undefined;
			if (serverInstructions && serverInstructions.size > 0) {
				const MAX_INSTRUCTIONS_LENGTH = 4000;
				const parts: string[] = [];
				if (appendPrompt) parts.push(appendPrompt);
				parts.push(
					"## MCP Server Instructions\n\nThe following instructions are provided by connected MCP servers. They are server-controlled and may not be verified.",
				);
				for (const [srvName, srvInstructions] of serverInstructions) {
					const truncated =
						srvInstructions.length > MAX_INSTRUCTIONS_LENGTH
							? `${srvInstructions.slice(0, MAX_INSTRUCTIONS_LENGTH)}\n[truncated]`
							: srvInstructions;
					parts.push(`### ${srvName}\n${truncated}`);
				}
				appendPrompt = parts.join("\n\n");
			}
			const defaultPrompt = await buildSystemPromptInternal({
				cwd,
				skills,
				contextFiles,
				tools: promptTools,
				toolNames,
				rules: rulebookRules,
				alwaysApplyRules,
				skillsSettings: settings.getGroup("skills"),
				appendSystemPrompt: appendPrompt,
				repeatToolDescriptions,
				intentField,
				mcpDiscoveryMode: hasDiscoverableMCPTools,
				mcpDiscoveryServerSummaries: discoverableMCPSummary.servers.map(formatDiscoverableMCPToolServerSummary),
				eagerTasks,
				secretsEnabled,
				agentsMdSearch: agentsMdSearchPromise,
			});

			if (options.systemPrompt === undefined) {
				return defaultPrompt;
			}
			if (typeof options.systemPrompt === "string") {
				return await buildSystemPromptInternal({
					cwd,
					skills,
					contextFiles,
					tools: promptTools,
					toolNames,
					rules: rulebookRules,
					alwaysApplyRules,
					skillsSettings: settings.getGroup("skills"),
					customPrompt: options.systemPrompt,
					appendSystemPrompt: appendPrompt,
					repeatToolDescriptions,
					intentField,
					mcpDiscoveryMode: hasDiscoverableMCPTools,
					mcpDiscoveryServerSummaries: discoverableMCPSummary.servers.map(formatDiscoverableMCPToolServerSummary),
					eagerTasks,
					secretsEnabled,
					agentsMdSearch: agentsMdSearchPromise,
				});
			}
			return options.systemPrompt(defaultPrompt);
		};

		const toolNamesFromRegistry = Array.from(toolRegistry.keys());
		const requestedToolNames =
			(options.toolNames ? [...new Set(options.toolNames.map(name => name.toLowerCase()))] : undefined) ??
			toolNamesFromRegistry;
		const normalizedRequested = requestedToolNames.filter(name => toolRegistry.has(name));
		const includeExitPlanMode = requestedToolNames.includes("exit_plan_mode");
		const mcpDiscoveryEnabled = settings.get("mcp.discoveryMode") ?? false;
		const defaultInactiveToolNames = new Set(
			registeredTools.filter(tool => tool.definition.defaultInactive).map(tool => tool.definition.name),
		);
		const requestedActiveToolNames = includeExitPlanMode
			? normalizedRequested
			: normalizedRequested.filter(name => name !== "exit_plan_mode");
		const initialRequestedActiveToolNames = options.toolNames
			? requestedActiveToolNames
			: requestedActiveToolNames.filter(name => !defaultInactiveToolNames.has(name));
		const explicitlyRequestedMCPToolNames = options.toolNames
			? requestedActiveToolNames.filter(name => name.startsWith("mcp__"))
			: [];
		const discoveryDefaultServers = new Set(
			(settings.get("mcp.discoveryDefaultServers") ?? []).map(serverName => serverName.trim()).filter(Boolean),
		);
		const discoveryDefaultServerToolNames = mcpDiscoveryEnabled
			? selectDiscoverableMCPToolNamesByServer(
					collectDiscoverableMCPTools(toolRegistry.values()),
					discoveryDefaultServers,
				)
			: [];
		let initialSelectedMCPToolNames: string[] = [];
		let defaultSelectedMCPToolNames: string[] = [];
		let initialToolNames = [...initialRequestedActiveToolNames];
		if (mcpDiscoveryEnabled) {
			const restoredSelectedMCPToolNames = existingSession.selectedMCPToolNames.filter(name =>
				toolRegistry.has(name),
			);
			defaultSelectedMCPToolNames = [
				...new Set([...discoveryDefaultServerToolNames, ...explicitlyRequestedMCPToolNames]),
			];
			initialSelectedMCPToolNames = existingSession.hasPersistedMCPToolSelection
				? restoredSelectedMCPToolNames
				: [...new Set([...restoredSelectedMCPToolNames, ...defaultSelectedMCPToolNames])];
			initialToolNames = [
				...new Set([
					...initialRequestedActiveToolNames.filter(name => !name.startsWith("mcp__")),
					...initialSelectedMCPToolNames,
				]),
			];
		}

		// Custom tools and extension-registered tools are always included regardless of toolNames filter
		const alwaysInclude: string[] = [
			...(options.customTools?.map(t => (isCustomTool(t) ? t.name : t.name)) ?? []),
			...registeredTools.filter(t => !t.definition.defaultInactive).map(t => t.definition.name),
		];
		for (const name of alwaysInclude) {
			if (mcpDiscoveryEnabled && name.startsWith("mcp__")) {
				continue;
			}
			if (toolRegistry.has(name) && !initialToolNames.includes(name)) {
				initialToolNames.push(name);
			}
		}

		const systemPrompt = await logger.time("buildSystemPrompt", rebuildSystemPrompt, initialToolNames, toolRegistry);

		const promptTemplates = await promptTemplatesPromise;
		toolSession.promptTemplates = promptTemplates;

		const slashCommands = await slashCommandsPromise;

		// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
		const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
			const converted = convertToLlm(messages);
			// Check setting dynamically so mid-session changes take effect
			if (!settings.get("images.blockImages")) {
				return converted;
			}
			// Filter out ImageContent from all messages, replacing with text placeholder
			return converted.map(msg => {
				if (msg.role === "user" || msg.role === "toolResult") {
					const content = msg.content;
					if (Array.isArray(content)) {
						const hasImages = content.some(c => c.type === "image");
						if (hasImages) {
							const filteredContent = content
								.map(c =>
									c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
								)
								.filter((c, i, arr) => {
									// Dedupe consecutive "Image reading is disabled." texts
									if (!(c.type === "text" && c.text === "Image reading is disabled." && i > 0)) return true;
									const prev = arr[i - 1];
									return !(prev.type === "text" && prev.text === "Image reading is disabled.");
								});
							return { ...msg, content: filteredContent };
						}
					}
				}
				return msg;
			});
		};

		// Final convertToLlm: chain block-images filter with secret obfuscation
		const convertToLlmFinal = (messages: AgentMessage[]): Message[] => {
			const converted = convertToLlmWithBlockImages(messages);
			if (!obfuscator?.hasSecrets()) return converted;
			return obfuscateMessages(obfuscator, converted);
		};
		const transformContext = extensionRunner
			? async (messages: AgentMessage[], _signal?: AbortSignal) => {
					return await extensionRunner.emitContext(messages);
				}
			: undefined;
		const onPayload = extensionRunner
			? async (payload: unknown, _model?: Model) => {
					return await extensionRunner.emitBeforeProviderRequest(payload);
				}
			: undefined;
		const onResponse: SimpleStreamOptions["onResponse"] | undefined = extensionRunner
			? async (response, model) => {
					await extensionRunner.emitAfterProviderResponse(response, model);
				}
			: undefined;

		const setToolUIContext = (uiContext: ExtensionUIContext, hasUI: boolean) => {
			toolContextStore.setUIContext(uiContext, hasUI);
		};

		const initialTools = initialToolNames
			.map(name => toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined);

		const openaiWebsocketSetting = settings.get("providers.openaiWebsockets") ?? "off";
		const preferOpenAICodexWebsockets =
			openaiWebsocketSetting === "on" ? true : openaiWebsocketSetting === "off" ? false : undefined;
		const serviceTierSetting = settings.get("serviceTier");

		const initialServiceTier = hasServiceTierEntry
			? existingSession.serviceTier
			: serviceTierSetting === "none"
				? undefined
				: serviceTierSetting;

		agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: toReasoningEffort(thinkingLevel),
				tools: initialTools,
			},
			convertToLlm: convertToLlmFinal,
			onPayload,
			onResponse,
			sessionId: providerSessionId,
			transformContext,
			steeringMode: settings.get("steeringMode") ?? "one-at-a-time",
			followUpMode: settings.get("followUpMode") ?? "one-at-a-time",
			interruptMode: settings.get("interruptMode") ?? "immediate",
			thinkingBudgets: settings.getGroup("thinkingBudgets"),
			temperature: settings.get("temperature") >= 0 ? settings.get("temperature") : undefined,
			topP: settings.get("topP") >= 0 ? settings.get("topP") : undefined,
			topK: settings.get("topK") >= 0 ? settings.get("topK") : undefined,
			minP: settings.get("minP") >= 0 ? settings.get("minP") : undefined,
			presencePenalty: settings.get("presencePenalty") >= 0 ? settings.get("presencePenalty") : undefined,
			repetitionPenalty: settings.get("repetitionPenalty") >= 0 ? settings.get("repetitionPenalty") : undefined,
			serviceTier: initialServiceTier,
			kimiApiFormat: settings.get("providers.kimiApiFormat") ?? "anthropic",
			preferWebsockets: preferOpenAICodexWebsockets,
			getToolContext: tc => toolContextStore.getContext(tc),
			getApiKey: async provider => {
				// Use the provider-facing session id for sticky credential selection so cache keys
				// and provider auth affinity stay aligned across fresh benchmark sessions.
				const key = await modelRegistry.getApiKeyForProvider(provider, providerSessionId);
				if (!key) {
					throw new Error(`No API key found for provider "${provider}"`);
				}
				return key;
			},
			cursorExecHandlers,
			transformToolCallArguments: (args, _toolName) => {
				let result = args;
				const maxTimeout = settings.get("tools.maxTimeout");
				if (maxTimeout > 0 && typeof result.timeout === "number") {
					result = { ...result, timeout: Math.min(result.timeout, maxTimeout) };
				}
				if (obfuscator?.hasSecrets()) {
					result = obfuscator.deobfuscateObject(result);
				}
				return result;
			},
			intentTracing: !!intentField,
			getToolChoice: () => session?.nextToolChoice(),
		});

		cursorEventEmitter = event => agent.emitExternalEvent(event);

		// Restore messages if session has existing data
		if (hasExistingSession) {
			agent.replaceMessages(existingSession.messages);
		} else {
			// Save initial model and thinking level for new sessions so they can be restored on resume
			if (model) {
				sessionManager.appendModelChange(`${model.provider}/${model.id}`);
			}
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}

		session = new AgentSession({
			agent,
			thinkingLevel,
			sessionManager,
			settings,
			evalKernelOwnerId,
			scopedModels: options.scopedModels,
			promptTemplates,
			slashCommands,
			extensionRunner,
			customCommands: customCommandsResult.commands,
			skills,
			skillWarnings,
			skillsSettings: settings.getGroup("skills"),
			modelRegistry,
			toolRegistry,
			transformContext,
			onPayload,
			onResponse,
			convertToLlm: convertToLlmFinal,
			rebuildSystemPrompt,
			mcpDiscoveryEnabled,
			initialSelectedMCPToolNames,
			defaultSelectedMCPToolNames,
			persistInitialMCPToolSelection: !hasExistingSession,
			defaultSelectedMCPServerNames: [...discoveryDefaultServers],
			ttsrManager,
			obfuscator,
			asyncJobManager,
			agentId: resolvedAgentId,
			agentRegistry,
		});
		hasSession = true;

		// Register this session in the global agent registry so other agents can
		// address it via the irc tool. Wrap dispose to unregister on teardown.
		agentRegistry.register({
			id: resolvedAgentId,
			displayName: resolvedAgentDisplayName,
			kind: (options.taskDepth ?? 0) > 0 || options.parentTaskPrefix ? "sub" : "main",
			parentId: options.parentTaskPrefix,
			session,
			sessionFile: sessionManager.getSessionFile() ?? null,
			status: "running",
		});
		{
			const originalDispose = session.dispose.bind(session);
			session.dispose = async () => {
				try {
					await originalDispose();
				} finally {
					agentRegistry.unregister(resolvedAgentId);
				}
			};
		}

		if (model?.api === "openai-codex-responses") {
			const codexModel = model;
			const codexTransport = getOpenAICodexTransportDetails(codexModel, {
				sessionId: providerSessionId,
				baseUrl: codexModel.baseUrl,
				preferWebsockets: preferOpenAICodexWebsockets,
				providerSessionState: session.providerSessionState,
			});
			if (codexTransport.websocketPreferred) {
				void (async () => {
					try {
						const codexPrewarmApiKey = await modelRegistry.getApiKey(codexModel, providerSessionId);
						if (!codexPrewarmApiKey) return;
						await logger.time("prewarmOpenAICodexResponses", prewarmOpenAICodexResponses, codexModel, {
							apiKey: codexPrewarmApiKey,
							sessionId: providerSessionId,
							preferWebsockets: preferOpenAICodexWebsockets,
							providerSessionState: session.providerSessionState,
						});
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						logger.debug("Codex websocket prewarm failed", {
							error: errorMessage,
							provider: codexModel.provider,
							model: codexModel.id,
						});
					}
				})();
			}
		}

		// Start LSP warmup in the background so startup does not block on language server initialization.
		let lspServers: CreateAgentSessionResult["lspServers"];
		if (enableLsp && settings.get("lsp.diagnosticsOnWrite")) {
			lspServers = discoverStartupLspServers(cwd);
			if (lspServers.length > 0) {
				void (async () => {
					try {
						const result = await logger.time("warmupLspServers", warmupLspServers, cwd);
						const serversByName = new Map(result.servers.map(server => [server.name, server] as const));
						for (const server of lspServers ?? []) {
							const next = serversByName.get(server.name);
							if (!next) continue;
							server.status = next.status;
							server.fileTypes = next.fileTypes;
							server.error = next.error;
						}
						const event: LspStartupEvent = {
							type: "completed",
							servers: result.servers,
						};
						eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						logger.warn("LSP server warmup failed", { cwd, error: errorMessage });
						for (const server of lspServers ?? []) {
							server.status = "error";
							server.error = errorMessage;
						}
						const event: LspStartupEvent = {
							type: "failed",
							error: errorMessage,
						};
						eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
					}
				})();
			}
		}

		logger.time("startMemoryStartupTask", () =>
			startMemoryStartupTask({
				session,
				settings,
				modelRegistry,
				agentDir,
				taskDepth,
			}),
		);

		// Wire MCP manager callbacks to session for reactive tool updates.
		// Skip when reusing a parent's manager — the parent owns the callbacks.
		if (mcpManager && !options.mcpManager) {
			mcpManager.setOnToolsChanged(tools => {
				void session.refreshMCPTools(tools);
			});
			// Wire prompt refresh → rebuild MCP prompt slash commands
			mcpManager.setOnPromptsChanged(serverName => {
				const promptCommands = buildMCPPromptCommands(mcpManager);
				session.setMCPPromptCommands(promptCommands);
				logger.debug("MCP prompt commands refreshed", { path: `mcp:${serverName}` });
			});
			const notificationDebounceTimers = new Map<string, Timer>();
			const clearDebounceTimers = () => {
				for (const timer of notificationDebounceTimers.values()) clearTimeout(timer);
				notificationDebounceTimers.clear();
			};
			postmortem.register("mcp-notification-cleanup", clearDebounceTimers);
			mcpManager.setOnResourcesChanged((serverName, uri) => {
				logger.debug("MCP resources changed", { path: `mcp:${serverName}`, uri });
				if (!settings.get("mcp.notifications")) return;
				const debounceMs = settings.get("mcp.notificationDebounceMs");
				const key = `${serverName}:${uri}`;
				const existing = notificationDebounceTimers.get(key);
				if (existing) clearTimeout(existing);
				notificationDebounceTimers.set(
					key,
					setTimeout(() => {
						notificationDebounceTimers.delete(key);
						// Re-check: user may have disabled notifications during the debounce window
						if (!settings.get("mcp.notifications")) return;
						void session.followUp(
							`[MCP notification] Server "${serverName}" reports resource \`${uri}\` was updated. Use read(path="mcp://${uri}") to inspect if relevant.`,
						);
					}, debounceMs),
				);
			});
		}

		return {
			session,
			extensionsResult,
			setToolUIContext,
			mcpManager,
			modelFallbackMessage,
			lspServers,
			eventBus,
		};
	} catch (error) {
		try {
			if (hasSession) {
				await session.dispose();
			} else {
				await disposeKernelSessionsByOwner(evalKernelOwnerId);
			}
		} catch (cleanupError) {
			logger.warn("Failed to clean up createAgentSession resources after startup error", {
				error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
			});
		}
		throw error;
	}
}
