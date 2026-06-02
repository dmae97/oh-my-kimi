/**
 * Custom tool loader - loads TypeScript tool modules using native Bun import.
 *
 * Dependencies (the zod-backed typebox shim and pi-coding-agent) are injected via the
 * CustomToolAPI to avoid import resolution issues with custom tools loaded from user directories.
 */
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import { toolCapability } from "../../capability/tool";
import { type CustomTool, loadCapability } from "../../discovery";
import type { ExecOptions } from "../../exec/exec";
import { execCommand } from "../../exec/exec";
import type { HookUIContext } from "../../extensibility/hooks/types";
import { getAllPluginToolPaths } from "../../extensibility/plugins/loader";
import * as typebox from "../typebox";
import { createNoOpUIContext, resolvePath } from "../utils";
import type { CustomToolAPI, CustomToolFactory, LoadedCustomTool, ToolLoadError } from "./types";

/**
 * Depth counter for the surrounding `loadCustomTools` batch. While greater
 * than zero, any `process.exit()` call is logged and dropped instead of
 * terminating the host. The batch stays open through every awaited
 * `loadTool` and through the microtask drain that happens at each `await`
 * point, so deferred exits scheduled by a tool's import or factory (for
 * example `void main().catch(() => process.exit(1))`) fire while the guard
 * is still active.
 */
let activeBatchDepth = 0;
/** Captured reference to the original `process.exit`, set when the guard is first installed. */
let originalProcessExit: typeof process.exit | null = null;

/**
 * Install a permanent `process.exit` interceptor on the first custom tool load.
 *
 * The interceptor logs and drops any `process.exit` call made while a batch is
 * open (`activeBatchDepth > 0`). Outside the batch window the call delegates
 * to the original `process.exit` so omp's own shutdown paths behave normally.
 *
 * The guard is intentionally never restored: tool-scheduled microtask work
 * runs across `await` points inside the batch (Bun's dynamic import body runs
 * on a separate microtask), and once installed the wrapper costs one extra
 * function call per exit. It does *not* attempt to catch exits scheduled by
 * `setTimeout`/`queueMicrotask` that fire after the batch has resolved —
 * those require process isolation, which is out of scope here.
 */
function installExitGuardOnce(): void {
	if (originalProcessExit !== null) return;
	const captured = process.exit;
	originalProcessExit = captured;
	const guarded: typeof process.exit = code => {
		if (activeBatchDepth > 0) {
			logger.error("Custom tool attempted to exit the process during load; call ignored", { code });
			return undefined as never;
		}
		return captured(code);
	};
	process.exit = guarded;
}

/**
 * Run a `loadCustomTools` batch under the exit guard. Sync exits from a
 * tool's import body or factory and async microtask follow-ups scheduled
 * during the batch are both intercepted while the batch is open, because the
 * microtask drain at each `await` point happens before the surrounding batch
 * promise resolves.
 */
async function withCustomToolBatch<T>(operation: () => Promise<T>): Promise<T> {
	installExitGuardOnce();
	activeBatchDepth++;
	try {
		return await operation();
	} finally {
		activeBatchDepth--;
	}
}

/**
 * Load a single tool module using native Bun import.
 */
async function loadTool(
	toolPath: string,
	cwd: string,
	sharedApi: CustomToolAPI,
	source?: { provider: string; providerName: string; level: "user" | "project" },
): Promise<{ tools: LoadedCustomTool[] | null; error: ToolLoadError | null }> {
	const resolvedPath = resolvePath(toolPath, cwd);

	// Skip declarative tool files (.md, .json) - these are metadata only, not executable modules
	if (resolvedPath.endsWith(".md") || resolvedPath.endsWith(".json")) {
		return {
			tools: null,
			error: {
				path: toolPath,
				error: "Declarative tool files (.md, .json) cannot be loaded as executable modules",
				source,
			},
		};
	}

	try {
		const module = await import(resolvedPath);
		const factory = (module.default ?? module) as CustomToolFactory;

		if (typeof factory !== "function") {
			return { tools: null, error: { path: toolPath, error: "Tool must export a default function", source } };
		}

		const toolResult = await factory(sharedApi);
		const toolsArray = Array.isArray(toolResult) ? toolResult : [toolResult];

		const loadedTools: LoadedCustomTool[] = toolsArray.map(tool => ({
			path: toolPath,
			resolvedPath,
			tool,
			source,
		}));

		return { tools: loadedTools, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { tools: null, error: { path: toolPath, error: `Failed to load tool: ${message}`, source } };
	}
}

/** Tool path with optional source metadata */
interface ToolPathWithSource {
	path: string;
	source?: { provider: string; providerName: string; level: "user" | "project" };
}

/**
 * Loads custom tools from paths with conflict detection and error handling.
 *
 * Manages a shared API instance passed to all tool factories, providing access to
 * execution context, UI, logger, and injected dependencies. The UI context can be
 * updated after loading via setUIContext().
 */
export class CustomToolLoader {
	tools: LoadedCustomTool[] = [];
	errors: ToolLoadError[] = [];
	#sharedApi: CustomToolAPI;
	#seenNames: Set<string>;

	constructor(
		pi: typeof import("@oh-my-pi/pi-coding-agent"),
		cwd: string,
		builtInToolNames: string[],
		pushPendingAction?: (action: {
			label: string;
			sourceToolName: string;
			apply(reason: string): Promise<AgentToolResult<unknown>>;
			reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
		}) => void,
	) {
		this.#sharedApi = {
			cwd,
			exec: (command: string, args: string[], options?: ExecOptions) =>
				execCommand(command, args, options?.cwd ?? cwd, options),
			ui: createNoOpUIContext(),
			hasUI: false,
			logger,
			typebox,
			zod: z,
			pi,
			pushPendingAction: action => {
				if (!pushPendingAction) {
					throw new Error("Pending action store unavailable for custom tools in this runtime.");
				}
				pushPendingAction({
					label: action.label,
					sourceToolName: action.sourceToolName ?? "custom_tool",
					apply: action.apply,
					reject: action.reject,
				});
			},
		};
		this.#seenNames = new Set<string>(builtInToolNames);
	}

	async load(pathsWithSources: ToolPathWithSource[]): Promise<void> {
		for (const { path: toolPath, source } of pathsWithSources) {
			const { tools: loadedTools, error } = await loadTool(toolPath, this.#sharedApi.cwd, this.#sharedApi, source);

			if (error) {
				this.errors.push(error);
				continue;
			}

			if (loadedTools) {
				for (const loadedTool of loadedTools) {
					// Check for name conflicts
					if (this.#seenNames.has(loadedTool.tool.name)) {
						this.errors.push({
							path: toolPath,
							error: `Tool name "${loadedTool.tool.name}" conflicts with existing tool`,
							source,
						});
						continue;
					}

					this.#seenNames.add(loadedTool.tool.name);
					this.tools.push(loadedTool);
				}
			}
		}
	}

	setUIContext(uiContext: HookUIContext, hasUI: boolean): void {
		this.#sharedApi.ui = uiContext;
		this.#sharedApi.hasUI = hasUI;
	}
}

/**
 * Load all tools from configuration.
 * @param pathsWithSources - Array of tool paths with optional source metadata
 * @param cwd - Current working directory for resolving relative paths
 * @param builtInToolNames - Names of built-in tools to check for conflicts
 */
export async function loadCustomTools(
	pathsWithSources: ToolPathWithSource[],
	cwd: string,
	builtInToolNames: string[],
	pushPendingAction?: (action: {
		label: string;
		sourceToolName: string;
		apply(reason: string): Promise<AgentToolResult<unknown>>;
		reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
	}) => void,
) {
	const loader = new CustomToolLoader(
		await import("@oh-my-pi/pi-coding-agent"),
		cwd,
		builtInToolNames,
		pushPendingAction,
	);
	await withCustomToolBatch(() => loader.load(pathsWithSources));
	return {
		tools: loader.tools,
		errors: loader.errors,
		setUIContext: (uiContext: HookUIContext, hasUI: boolean) => {
			loader.setUIContext(uiContext, hasUI);
		},
	};
}

/**
 * Discover and load tools from standard locations via capability system:
 * 1. User and project tools discovered by capability providers
 * 2. Installed plugins (~/.omp/plugins/node_modules/*)
 * 3. Explicitly configured paths from settings or CLI
 *
 * @param configuredPaths - Explicit paths from settings.json and CLI --tool flags
 * @param cwd - Current working directory
 * @param builtInToolNames - Names of built-in tools to check for conflicts
 */
export async function discoverAndLoadCustomTools(
	configuredPaths: string[],
	cwd: string,
	builtInToolNames: string[],
	pushPendingAction?: (action: {
		label: string;
		sourceToolName: string;
		apply(reason: string): Promise<AgentToolResult<unknown>>;
		reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
	}) => void,
) {
	const allPathsWithSources: ToolPathWithSource[] = [];
	const seen = new Set<string>();

	// Helper to add paths without duplicates
	const addPath = (p: string, source?: { provider: string; providerName: string; level: "user" | "project" }) => {
		const resolved = path.resolve(p);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			allPathsWithSources.push({ path: p, source });
		}
	};

	// 1. Discover tools via capability system (user + project from all providers)
	const discoveredTools = await loadCapability<CustomTool>(toolCapability.id, { cwd });
	for (const tool of discoveredTools.items) {
		addPath(tool.path, {
			provider: tool._source.provider,
			providerName: tool._source.providerName,
			level: tool.level,
		});
	}

	// 2. Plugin tools: ~/.omp/plugins/node_modules/*/
	for (const pluginPath of await getAllPluginToolPaths(cwd)) {
		addPath(pluginPath, { provider: "plugin", providerName: "Plugin", level: "user" });
	}

	// 3. Explicitly configured paths (can override/add)
	for (const configPath of configuredPaths) {
		addPath(resolvePath(configPath, cwd), { provider: "config", providerName: "Config", level: "project" });
	}

	return loadCustomTools(allPathsWithSources, cwd, builtInToolNames, pushPendingAction);
}
