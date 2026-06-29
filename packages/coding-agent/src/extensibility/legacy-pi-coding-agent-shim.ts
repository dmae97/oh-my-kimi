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

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai";
import { Text } from "@oh-my-pi/pi-tui";
import { parseFrontmatter as parseOmpFrontmatter } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { EditTool } from "../edit";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateHead,
	truncateTail,
} from "../session/streaming-output";
import type { Tool, ToolSession } from "../tools";
import { BashTool } from "../tools/bash";
import { GlobTool } from "../tools/glob";
import { GrepTool } from "../tools/grep";
import { ReadTool } from "../tools/read";
import { formatBytes } from "../tools/render-utils";
import { WriteTool } from "../tools/write";
import type { ToolDefinition } from "./extensions/types";
import { Type } from "./typebox";

const TOOL_DEFINITION_MARKER = "__isToolDefinition";
const LEGACY_BUILTIN_TOOL_MARKER = "__ompLegacyBuiltinTool";
const LEGACY_CODING_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;
const LEGACY_READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

type LegacyCodingToolName = (typeof LEGACY_CODING_TOOL_NAMES)[number];
type LegacyRegistryToolName = LegacyCodingToolName | "grep" | "glob";
type LegacyBuiltinToolDefinition = ToolDefinition & { [LEGACY_BUILTIN_TOOL_MARKER]: true };

interface LegacyThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export interface BashOperations {
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

export interface BashToolOptions {
	operations?: BashOperations;
	commandPrefix?: string;
	spawnHook?: BashSpawnHook;
}

export interface ReadToolOptions {
	autoResizeImages?: boolean;
}

export interface GrepToolOptions {
	operations?: unknown;
}

export interface FindOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

export interface FindToolOptions {
	operations?: FindOperations;
}

export interface LsOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	stat: (absolutePath: string) => Promise<{ isDirectory(): boolean }> | { isDirectory(): boolean };
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

export interface LsToolOptions {
	operations?: LsOperations;
}

const legacyBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

const legacyReadSchema = Type.Object({
	path: Type.String({ description: "Path to read" }),
	offset: Type.Optional(Type.Number({ description: "1-based line offset" })),
	limit: Type.Optional(Type.Number({ description: "Maximum lines to read" })),
});

const legacyGrepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search" })),
	glob: Type.Optional(Type.String({ description: "Glob filter" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string" })),
	context: Type.Optional(Type.Number({ description: "Context lines" })),
	limit: Type.Optional(Type.Number({ description: "Maximum matches" })),
});

const legacyFindSchema = Type.Object({
	pattern: Type.String({ description: "Glob pattern to match files" }),
	path: Type.Optional(Type.String({ description: "Directory to search" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results" })),
});

const legacyLsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list" })),
	limit: Type.Optional(Type.Number({ description: "Maximum entries" })),
});

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

function createRegistryTool(cwd: string, name: LegacyRegistryToolName): Tool {
	const session = legacyToolSession(cwd);
	switch (name) {
		case "bash":
			return new BashTool(session);
		case "edit":
			return new EditTool(session);
		case "glob":
			return new GlobTool(session);
		case "grep":
			return new GrepTool(session);
		case "read":
			return new ReadTool(session);
		case "write":
			return new WriteTool(session);
	}
}

async function executeBuiltinTool(
	cwd: string,
	name: LegacyCodingToolName,
	toolCallId: string,
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
) {
	const tool = createRegistryTool(cwd, name);
	return tool.execute(toolCallId, params, signal, onUpdate);
}

function legacyBuiltinTool(cwd: string, name: LegacyCodingToolName): ToolDefinition {
	const tool = createRegistryTool(cwd, name);
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

function stringField(value: unknown, key: string): string | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const field = Reflect.get(value, key);
	return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const field = Reflect.get(value, key);
	return typeof field === "number" ? field : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const field = Reflect.get(value, key);
	return typeof field === "boolean" ? field : undefined;
}

function isLegacyThemeLike(value: unknown): value is LegacyThemeLike {
	if (value === null || typeof value !== "object") return false;
	return typeof Reflect.get(value, "fg") === "function" && typeof Reflect.get(value, "bold") === "function";
}

function renderTheme(second: unknown, third: unknown): LegacyThemeLike | undefined {
	if (isLegacyThemeLike(second)) return second;
	if (isLegacyThemeLike(third)) return third;
	return undefined;
}

function themedTitle(theme: LegacyThemeLike | undefined, title: string): string {
	return theme ? theme.fg("toolTitle", theme.bold(title)) : title;
}

function themedMuted(theme: LegacyThemeLike | undefined, text: string): string {
	return theme ? theme.fg("toolOutput", text) : text;
}

function textResult(result: AgentToolResult<unknown> | undefined): string {
	return result?.content.find(block => block.type === "text")?.text ?? "";
}

function legacyRenderResult(result: AgentToolResult<unknown>, _options: unknown, themeArg: unknown): Text {
	const theme = renderTheme(themeArg, undefined);
	const output = textResult(result);
	return new Text(output ? `\n${themedMuted(theme, output)}` : "", 0, 0);
}

function lineRangePath(readPath: string, offset: number | undefined, limit: number | undefined): string {
	if (offset === undefined && limit === undefined) return readPath;
	const start = Math.max(1, Math.floor(offset ?? 1));
	if (limit === undefined) return `${readPath}:${start}`;
	const end = Math.max(start, start + Math.max(1, Math.floor(limit)) - 1);
	return `${readPath}:${start}-${end}`;
}

function escapeRegexLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function joinLegacyGlob(searchPath: string, pattern: string): string {
	if (path.isAbsolute(pattern)) return pattern;
	if (!searchPath || searchPath === ".") return pattern;
	return path.join(searchPath, pattern);
}

function normalizeLegacyLimit(limit: number | undefined, fallback: number): number {
	if (limit === undefined || !Number.isFinite(limit)) return fallback;
	return Math.max(1, Math.floor(limit));
}

function appendStatus(text: string, status: string): string {
	return text ? `${text}\n\n${status}` : status;
}

function legacyBashSnapshot(output: string): { text: string; details?: { truncation: TruncationResult } } {
	const truncation = truncateTail(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) {
		return { text: truncation.content };
	}
	const startLine = truncation.totalLines - (truncation.outputLines ?? 0) + 1;
	const note =
		truncation.truncatedBy === "lines"
			? `Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}`
			: `Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines} (${formatBytes(DEFAULT_MAX_BYTES)} limit)`;
	return {
		text: `${truncation.content}\n\n[${note}]`,
		details: { truncation },
	};
}

async function executeLegacyBashOperations(
	operations: BashOperations,
	spawn: BashSpawnContext,
	timeout: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
): Promise<AgentToolResult> {
	let output = "";
	const onData = (data: Buffer) => {
		output += data.toString("utf8");
		if (onUpdate) {
			const snapshot = legacyBashSnapshot(output);
			onUpdate({ content: [{ type: "text", text: snapshot.text }], details: snapshot.details });
		}
	};
	try {
		const result = await operations.exec(spawn.command, spawn.cwd, {
			onData,
			signal,
			timeout,
			env: spawn.env,
		});
		const snapshot = legacyBashSnapshot(output);
		const text = snapshot.text || "(no output)";
		if (result.exitCode !== 0 && result.exitCode !== null) {
			throw new Error(appendStatus(text, `Command exited with code ${result.exitCode}`));
		}
		return { content: [{ type: "text", text }], details: snapshot.details };
	} catch (err) {
		const snapshot = legacyBashSnapshot(output);
		const text = snapshot.text;
		if (err instanceof Error && err.message === "aborted") {
			throw new Error(appendStatus(text, "Command aborted"));
		}
		if (err instanceof Error && err.message.startsWith("timeout:")) {
			throw new Error(appendStatus(text, `Command timed out after ${err.message.slice("timeout:".length)} seconds`));
		}
		throw err;
	}
}

function createLegacyTool(_cwd: string, definition: ToolDefinition): ToolDefinition {
	return definition;
}

/** Parse frontmatter using the historical Pi package-root helper. */
export interface ParsedFrontmatter<T extends Record<string, unknown> = Record<string, unknown>> {
	frontmatter: T;
	body: string;
}

/** Parse YAML frontmatter and throw on invalid metadata. */
export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> {
	const { frontmatter, body } = parseOmpFrontmatter(content, { level: "fatal" });
	return { frontmatter: frontmatter as T, body };
}

/** Return content without YAML frontmatter. */
export function stripFrontmatter(content: string): string {
	return parseFrontmatter(content).body;
}

/** Mark an extension-authored tool as a Pi-compatible tool definition. */
export function defineTool<TParams extends TSchema = TSchema, TDetails = unknown>(
	tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	return markToolDefinition(tool);
}

/** Create the legacy read tool definition. */
export function createReadToolDefinition(cwd: string, _options?: ReadToolOptions): ToolDefinition {
	const tool = createRegistryTool(cwd, "read");
	return markToolDefinition({
		name: "read",
		label: "Read",
		description: tool.description,
		parameters: legacyReadSchema,
		approval: "read",
		renderCall: (params, options, themeArg) => {
			const theme = renderTheme(options, themeArg);
			const readPath = stringField(params, "path") ?? "";
			return new Text(`${themedTitle(theme, "read")} ${themedMuted(theme, readPath)}`, 0, 0);
		},
		renderResult: legacyRenderResult,
		execute: (toolCallId, params, signal, onUpdate) => {
			const readPath = stringField(params, "path") ?? "";
			const pathWithRange = lineRangePath(readPath, numberField(params, "offset"), numberField(params, "limit"));
			return tool.execute(toolCallId, { path: pathWithRange }, signal, onUpdate);
		},
	});
}

/** Create the legacy read tool. */
export function createReadTool(cwd: string, options?: ReadToolOptions): ToolDefinition {
	return createLegacyTool(cwd, createReadToolDefinition(cwd, options));
}

/** Create the legacy bash tool definition. */
export function createBashToolDefinition(cwd: string, options?: BashToolOptions): ToolDefinition {
	const tool = createRegistryTool(cwd, "bash");
	return markToolDefinition({
		name: "bash",
		label: "Bash",
		description: tool.description,
		parameters: legacyBashSchema,
		approval: "exec",
		renderCall: (params, optionsArg, themeArg) => {
			const theme = renderTheme(optionsArg, themeArg);
			const command = stringField(params, "command") ?? "";
			return new Text(`${themedTitle(theme, "bash")} ${themedMuted(theme, command)}`, 0, 0);
		},
		renderResult: legacyRenderResult,
		execute: (toolCallId, params, signal, onUpdate) => {
			const rawCommand = stringField(params, "command") ?? "";
			const command = options?.commandPrefix ? `${options.commandPrefix}\n${rawCommand}` : rawCommand;
			const timeout = numberField(params, "timeout");
			const spawn = options?.spawnHook?.({ command, cwd, env: process.env });
			if (options?.operations) {
				return executeLegacyBashOperations(
					options.operations,
					{ command: spawn?.command ?? command, cwd: spawn?.cwd ?? cwd, env: spawn?.env ?? process.env },
					timeout,
					signal,
					onUpdate,
				);
			}
			return tool.execute(
				toolCallId,
				{
					command: spawn?.command ?? command,
					cwd: spawn?.cwd ?? cwd,
					env: spawn?.env,
					timeout,
				},
				signal,
				onUpdate,
			);
		},
	});
}

/** Create the legacy bash tool. */
export function createBashTool(cwd: string, options?: BashToolOptions): ToolDefinition {
	return createLegacyTool(cwd, createBashToolDefinition(cwd, options));
}

/** Create the legacy grep tool definition. */
export function createGrepToolDefinition(cwd: string, _options?: GrepToolOptions): ToolDefinition {
	const tool = createRegistryTool(cwd, "grep");
	return markToolDefinition({
		name: "grep",
		label: "grep",
		description: "Search file contents for a pattern.",
		parameters: legacyGrepSchema,
		approval: "read",
		renderCall: (params, optionsArg, themeArg) => {
			const theme = renderTheme(optionsArg, themeArg);
			const pattern = stringField(params, "pattern") ?? "";
			const searchPath = stringField(params, "path") ?? ".";
			return new Text(`${themedTitle(theme, "grep")} ${themedMuted(theme, `/${pattern}/ in ${searchPath}`)}`, 0, 0);
		},
		renderResult: legacyRenderResult,
		execute: (toolCallId, params, signal, onUpdate) => {
			const rawPattern = stringField(params, "pattern") ?? "";
			const pattern = booleanField(params, "literal") ? escapeRegexLiteral(rawPattern) : rawPattern;
			const searchPath = stringField(params, "path") ?? ".";
			const glob = stringField(params, "glob");
			return tool.execute(
				toolCallId,
				{
					pattern,
					paths: glob ? joinLegacyGlob(searchPath, glob) : searchPath,
					case: booleanField(params, "ignoreCase") ? false : undefined,
				},
				signal,
				onUpdate,
			);
		},
	});
}

/** Create the legacy grep tool. */
export function createGrepTool(cwd: string, options?: GrepToolOptions): ToolDefinition {
	return createLegacyTool(cwd, createGrepToolDefinition(cwd, options));
}

/** Create the legacy find tool definition. */
export function createFindToolDefinition(cwd: string, options?: FindToolOptions): ToolDefinition {
	const tool = createRegistryTool(cwd, "glob");
	return markToolDefinition({
		name: "find",
		label: "find",
		description: "Find files by glob pattern.",
		parameters: legacyFindSchema,
		approval: "read",
		renderCall: (params, optionsArg, themeArg) => {
			const theme = renderTheme(optionsArg, themeArg);
			const pattern = stringField(params, "pattern") ?? "";
			const searchPath = stringField(params, "path") ?? ".";
			return new Text(`${themedTitle(theme, "find")} ${themedMuted(theme, `${pattern} in ${searchPath}`)}`, 0, 0);
		},
		renderResult: legacyRenderResult,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const pattern = stringField(params, "pattern") ?? "*";
			const searchPath = stringField(params, "path") ?? ".";
			const limit = normalizeLegacyLimit(numberField(params, "limit"), 1000);
			const absolutePath = path.resolve(cwd, searchPath);
			if (options?.operations) {
				if (!(await options.operations.exists(absolutePath))) {
					throw new Error(`Path not found: ${absolutePath}`);
				}
				const matches = await options.operations.glob(pattern, absolutePath, {
					ignore: ["**/node_modules/**", "**/.git/**"],
					limit,
				});
				const output = matches
					.map(match => path.relative(absolutePath, match).split(path.sep).join("/"))
					.join("\n");
				const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
				return {
					content: [{ type: "text", text: truncation.content || "No files found matching pattern" }],
					details: truncation.truncated ? { truncation } : undefined,
				};
			}
			return tool.execute(
				toolCallId,
				{ paths: [joinLegacyGlob(searchPath, pattern)], hidden: true, gitignore: true, limit },
				signal,
				onUpdate,
			);
		},
	});
}

/** Create the legacy find tool. */
export function createFindTool(cwd: string, options?: FindToolOptions): ToolDefinition {
	return createLegacyTool(cwd, createFindToolDefinition(cwd, options));
}

/** Create the legacy ls tool definition. */
export function createLsToolDefinition(cwd: string, options?: LsToolOptions): ToolDefinition {
	return markToolDefinition({
		name: "ls",
		label: "ls",
		description: "List directory entries.",
		parameters: legacyLsSchema,
		approval: "read",
		renderCall: (params, optionsArg, themeArg) => {
			const theme = renderTheme(optionsArg, themeArg);
			return new Text(`${themedTitle(theme, "ls")} ${themedMuted(theme, stringField(params, "path") ?? ".")}`, 0, 0);
		},
		renderResult: legacyRenderResult,
		execute: async (_toolCallId, params, _signal, _onUpdate) => {
			const rawPath = stringField(params, "path") ?? ".";
			const limit = normalizeLegacyLimit(numberField(params, "limit"), 500);
			const absolutePath = path.resolve(cwd, rawPath);
			const ops = options?.operations;
			const exists = ops
				? await ops.exists(absolutePath)
				: await fs.stat(absolutePath).then(
						() => true,
						() => false,
					);
			if (!exists) throw new Error(`Path not found: ${absolutePath}`);
			const stat = ops ? await ops.stat(absolutePath) : await fs.stat(absolutePath);
			if (!stat.isDirectory()) {
				return { content: [{ type: "text", text: rawPath }] };
			}
			const entries = ops ? await ops.readdir(absolutePath) : await fs.readdir(absolutePath);
			const sorted = [...entries].sort((a, b) => a.localeCompare(b));
			const limited = sorted.slice(0, limit);
			const output = limited.join("\n");
			const details = sorted.length > limited.length ? { entryLimitReached: limit } : undefined;
			const suffix = details ? `\n\n[${limit} entries limit reached]` : "";
			return { content: [{ type: "text", text: `${output}${suffix}` }], details };
		},
	});
}

/** Create the legacy ls tool. */
export function createLsTool(cwd: string, options?: LsToolOptions): ToolDefinition {
	return createLegacyTool(cwd, createLsToolDefinition(cwd, options));
}

/** Create legacy read, bash, edit, and write tools. */
export function createCodingTools(cwd: string): ToolDefinition[] {
	return LEGACY_CODING_TOOL_NAMES.map(name => legacyBuiltinTool(cwd, name));
}

/** Create legacy read, grep, find, and ls tools. */
export function createReadOnlyTools(cwd: string): ToolDefinition[] {
	return LEGACY_READ_ONLY_TOOL_NAMES.map(name => {
		if (name === "read") return createReadTool(cwd);
		if (name === "grep") return createGrepTool(cwd);
		if (name === "find") return createFindTool(cwd);
		return createLsTool(cwd);
	});
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
export { formatBytes as formatSize } from "../tools/render-utils";
export { Type } from "./typebox";
