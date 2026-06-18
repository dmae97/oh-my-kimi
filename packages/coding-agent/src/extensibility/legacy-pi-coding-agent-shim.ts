/**
 * Compatibility shim for legacy extensions importing the package root of
 * `@oh-my-pi/pi-coding-agent` (or one of its aliased scopes like
 * `@earendil-works/pi-coding-agent` or `@mariozechner/pi-coding-agent`).
 *
 * The coding-agent package's own barrel (`./src/index.ts`) cannot be listed
 * as a `bun --compile` extra entrypoint alongside the CLI entry without
 * silently breaking the main binary's startup (see issue #1474 follow-up).
 * Routing legacy plugin imports through this sibling shim sidesteps that
 * conflict: bun bundles a distinct entry whose path differs from the CLI
 * entry, while still re-exporting the canonical surface so plugins observe
 * the same module identity as a direct `@oh-my-pi/pi-coding-agent` import.
 */

import type { AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai";
import { parseFrontmatter as parseOmpFrontmatter } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { BUILTIN_TOOLS, type Tool, type ToolSession } from "../tools";
import type { ToolDefinition } from "./extensions/types";
import { Type } from "./typebox";

const TOOL_DEFINITION_MARKER = "__isToolDefinition";
const LEGACY_BUILTIN_TOOL_MARKER = "__ompLegacyBuiltinTool";
const LEGACY_CODING_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;

type LegacyCodingToolName = (typeof LEGACY_CODING_TOOL_NAMES)[number];
type LegacyBuiltinToolDefinition = ToolDefinition & { [LEGACY_BUILTIN_TOOL_MARKER]: true };

function markToolDefinition<TParams extends TSchema, TDetails>(
	tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	Object.defineProperty(tool, TOOL_DEFINITION_MARKER, {
		value: true,
		enumerable: false,
		writable: false,
		configurable: true,
	});
	return tool;
}
function legacyToolSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	};
}

function createBuiltinTool(cwd: string, name: LegacyCodingToolName): Tool {
	const tool = BUILTIN_TOOLS[name](legacyToolSession(cwd));
	if (tool instanceof Promise) {
		throw new Error(`Built-in ${name} tool factory unexpectedly returned a promise.`);
	}
	if (!tool) {
		throw new Error(`Built-in ${name} tool is unavailable.`);
	}
	return tool;
}

async function executeBuiltinTool(
	cwd: string,
	name: LegacyCodingToolName,
	toolCallId: string,
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
) {
	const tool = createBuiltinTool(cwd, name);
	return tool.execute(toolCallId, params, signal, onUpdate);
}

function legacyBuiltinTool(cwd: string, name: LegacyCodingToolName): ToolDefinition {
	const tool = createBuiltinTool(cwd, name);
	const definition: LegacyBuiltinToolDefinition = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		hidden: tool.hidden,
		deferrable: tool.deferrable,
		approval: tool.approval,
		execute: (toolCallId, params, signal, onUpdate) =>
			executeBuiltinTool(cwd, name, toolCallId, params, signal, onUpdate),
		[LEGACY_BUILTIN_TOOL_MARKER]: true,
	};
	return markToolDefinition(definition);
}

export interface ParsedFrontmatter<T extends Record<string, unknown> = Record<string, unknown>> {
	frontmatter: T;
	body: string;
}

export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> {
	const { frontmatter, body } = parseOmpFrontmatter(content, { level: "fatal" });
	return { frontmatter: frontmatter as T, body };
}

export function stripFrontmatter(content: string): string {
	return parseFrontmatter(content).body;
}

export function defineTool<TParams extends TSchema = TSchema, TDetails = unknown>(
	tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	return markToolDefinition(tool);
}

export function createCodingTools(cwd: string): ToolDefinition[] {
	return LEGACY_CODING_TOOL_NAMES.map(name => legacyBuiltinTool(cwd, name));
}

export const SettingsManager = {
	create(cwd: string, agentDir?: string): Promise<Settings> {
		return Settings.init({ cwd, agentDir });
	},

	inMemory(): Settings {
		return Settings.isolated();
	},
} as const;

export * from "../index";
export { Type };
