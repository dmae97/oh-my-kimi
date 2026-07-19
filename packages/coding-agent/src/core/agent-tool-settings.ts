import type { AgentOptions } from "omk-agent-core";
import type { AgentRuntimeSettings, SettingsManager } from "./settings-manager.ts";

const DEFAULT_TOOL_SCHEDULER = "dag-v2";
const DEFAULT_MAX_TOOL_CONCURRENCY = 4;
const DEFAULT_TOOL_TIMEOUT_MS = 0;
const MAX_TOOL_TIMEOUT_MS = 2_147_483_647;

const DEFAULT_BUILTIN_TOOL_TIMEOUTS: Readonly<Record<string, number>> = {
	bash: 300_000,
	edit: 60_000,
	find: 30_000,
	grep: 30_000,
	ls: 30_000,
	read: 30_000,
	write: 60_000,
};

/** §6.3 timeout categories. `undefined` category falls through to the global setting. */
export type ToolTimeoutCategory = "read" | "write" | "mcp" | "process" | "browser";

/** §6.3 category default timeouts (ms): read/list/search 30s, write/edit 60s, MCP 120s, bash/process 300s, browser/computer-use 180s. */
export const TOOL_CATEGORY_TIMEOUTS: Readonly<Record<ToolTimeoutCategory, number>> = Object.freeze({
	read: 30_000,
	write: 60_000,
	mcp: 120_000,
	process: 300_000,
	browser: 180_000,
});

const READ_CATEGORY_TOOLS = new Set(["read", "ls", "find", "grep", "glob", "list", "search"]);
const WRITE_CATEGORY_TOOLS = new Set(["write", "edit"]);
const PROCESS_CATEGORY_TOOLS = new Set(["bash"]);
// Matches direct browser/computer-use tools and browser tools bridged through
// MCP servers (e.g. `mcp__playwright__browser_click`).
const BROWSER_TOOL_PATTERN = /(^|__)(browser_|computer[-_]?use$|computer_)/;

/**
 * Classify a tool name into its §6.3 timeout category. Conservative on
 * purpose: unknown names return `undefined` and keep the global timeout.
 * A browser/computer-use match wins over the generic MCP category because
 * browser automation is the slower bound.
 */
export function resolveToolTimeoutCategory(toolName: string): ToolTimeoutCategory | undefined {
	if (READ_CATEGORY_TOOLS.has(toolName)) return "read";
	if (WRITE_CATEGORY_TOOLS.has(toolName)) return "write";
	if (PROCESS_CATEGORY_TOOLS.has(toolName)) return "process";
	if (BROWSER_TOOL_PATTERN.test(toolName)) return "browser";
	if (toolName.startsWith("mcp__")) return "mcp";
	return undefined;
}

/**
 * Fill §6.3 category default timeouts for every active tool name that has no
 * explicit per-name entry. Explicit entries (user settings and built-in
 * defaults) always win and are all preserved; names without a category are
 * omitted so they fall through to the global `toolTimeoutMs` at runtime.
 */
export function applyCategoryTimeoutDefaults(
	toolNames: Iterable<string>,
	explicit: Readonly<Record<string, number>>,
): Record<string, number> {
	const merged: Record<string, number> = Object.create(null);
	for (const toolName of toolNames) {
		if (Object.hasOwn(explicit, toolName)) continue;
		const category = resolveToolTimeoutCategory(toolName);
		if (category !== undefined) {
			merged[toolName] = TOOL_CATEGORY_TIMEOUTS[category];
		}
	}
	for (const [toolName, timeoutMs] of Object.entries(explicit)) {
		merged[toolName] = timeoutMs;
	}
	return merged;
}

type ToolScheduler = NonNullable<AgentOptions["toolScheduler"]>;

export interface ResolvedAgentToolSettings {
	readonly toolScheduler: ToolScheduler;
	readonly maxToolConcurrency: number | undefined;
	readonly strictExtensionClaims: boolean;
	readonly toolTimeoutMs: number;
	readonly toolTimeouts: Record<string, number>;
}

export class AgentToolSettingsError extends Error {
	readonly settingName: string;

	constructor(settingName: string) {
		super(`Invalid ${settingName} setting`);
		this.name = "AgentToolSettingsError";
		this.settingName = settingName;
	}
}

function parseScheduler(value: unknown, settingName: string): ToolScheduler | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "waves-v1" || value === "dag-v2") {
		return value;
	}
	throw new AgentToolSettingsError(settingName);
}

function parseTimeout(value: unknown, settingName: string, defaultValue: number): number {
	if (value === undefined) {
		return defaultValue;
	}
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_TOOL_TIMEOUT_MS) {
		throw new AgentToolSettingsError(settingName);
	}
	return value;
}

function parseConcurrency(value: unknown): number | undefined {
	if (value === undefined) {
		return DEFAULT_MAX_TOOL_CONCURRENCY;
	}
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new AgentToolSettingsError("agent.maxToolConcurrency");
	}
	return value === 0 ? undefined : value;
}

function parseAgentSettings(value: AgentRuntimeSettings | undefined, settingName: string): AgentRuntimeSettings {
	if (value === undefined) {
		return {};
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new AgentToolSettingsError(settingName);
	}
	return value;
}

function parseToolTimeoutEntries(
	value: AgentRuntimeSettings["toolTimeouts"],
	settingName: string,
): readonly (readonly [string, number])[] {
	if (value === undefined) {
		return [];
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new AgentToolSettingsError(settingName);
	}

	return Object.entries(value).map(([toolName, timeoutMs]) => {
		if (toolName.length === 0) {
			throw new AgentToolSettingsError(settingName);
		}
		return [toolName, parseTimeout(timeoutMs, `${settingName}.${toolName}`, DEFAULT_TOOL_TIMEOUT_MS)] as const;
	});
}

function resolveToolTimeouts(
	globalSettings: AgentRuntimeSettings,
	projectSettings: AgentRuntimeSettings,
	effectiveSettings: AgentRuntimeSettings,
): Record<string, number> {
	const timeouts: Record<string, number> = Object.create(null);
	const entryGroups = [
		Object.entries(DEFAULT_BUILTIN_TOOL_TIMEOUTS),
		parseToolTimeoutEntries(globalSettings.toolTimeouts, "agent.toolTimeouts"),
		parseToolTimeoutEntries(projectSettings.toolTimeouts, "agent.toolTimeouts"),
		parseToolTimeoutEntries(effectiveSettings.toolTimeouts, "agent.toolTimeouts"),
	];
	for (const entries of entryGroups) {
		for (const [toolName, timeoutMs] of entries) {
			timeouts[toolName] = timeoutMs;
		}
	}
	return timeouts;
}

export function resolveAgentToolSettings(
	settingsManager: SettingsManager,
	env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
): ResolvedAgentToolSettings {
	const globalSettings = parseAgentSettings(settingsManager.getGlobalSettings().agent, "agent");
	const projectSettings = parseAgentSettings(settingsManager.getProjectSettings().agent, "agent");
	const settings = parseAgentSettings(settingsManager.getAgentRuntimeSettings(), "agent");
	const envScheduler = parseScheduler(env.OMK_TOOL_SCHEDULER, "OMK_TOOL_SCHEDULER");
	const settingsScheduler = parseScheduler(settings.toolScheduler, "agent.toolScheduler");

	return {
		toolScheduler: envScheduler ?? settingsScheduler ?? DEFAULT_TOOL_SCHEDULER,
		maxToolConcurrency: parseConcurrency(settings.maxToolConcurrency),
		strictExtensionClaims: true,
		toolTimeoutMs: parseTimeout(settings.toolTimeoutMs, "agent.toolTimeoutMs", DEFAULT_TOOL_TIMEOUT_MS),
		toolTimeouts: resolveToolTimeouts(globalSettings, projectSettings, settings),
	};
}
