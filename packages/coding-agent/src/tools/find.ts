import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import * as natives from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { isEnoent, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import findDescription from "../prompts/tools/find.md" with { type: "text" };
import { type TruncationResult, truncateHead } from "../session/streaming-output";
import {
	Ellipsis,
	Hasher,
	type RenderCache,
	renderFileList,
	renderStatusLine,
	renderTreeList,
	truncateToWidth,
} from "../tui";
import type { ToolSession } from ".";
import { applyListLimit } from "./list-limit";
import { formatFullOutputReference, type OutputMeta } from "./output-meta";
import { normalizePathLikeInput, parseFindPattern, resolveMultiFindPattern, resolveToCwd } from "./path-utils";
import { formatCount, formatEmptyMessage, formatErrorMessage, PREVIEW_LIMITS } from "./render-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const findSchema = Type.Object({
	pattern: Type.String({
		description:
			"Glob pattern including the search path (no separate path param), e.g. 'src/**/*.ts', 'lib/*.json'. Supports comma-separated lists like 'apps/,packages/,phases/'. Simple patterns like '*.ts' recurse from cwd.",
	}),
	hidden: Type.Optional(Type.Boolean({ description: "Include hidden files and directories", default: true })),
	limit: Type.Optional(Type.Number({ description: "Max results", default: 1000 })),
});

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;
const GLOB_TIMEOUT_MS = 5000;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	meta?: OutputMeta;
	// Fields for TUI rendering
	scopePath?: string;
	fileCount?: number;
	files?: string[];
	truncated?: boolean;
	error?: string;
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (e.g., SSH).
 */
export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Optional stat for distinguishing files vs directories. */
	stat?: (
		absolutePath: string,
	) => Promise<{ isFile(): boolean; isDirectory(): boolean }> | { isFile(): boolean; isDirectory(): boolean };
	/** Find files matching glob pattern. Returns relative paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem + rg */
	operations?: FindOperations;
}

export class FindTool implements AgentTool<typeof findSchema, FindToolDetails> {
	readonly name = "find";
	readonly label = "Find";
	readonly description: string;
	readonly parameters = findSchema;
	readonly strict = true;

	readonly #customOps?: FindOperations;

	constructor(
		private readonly session: ToolSession,
		options?: FindToolOptions,
	) {
		this.#customOps = options?.operations;
		this.description = prompt.render(findDescription);
	}

	async execute(
		_toolCallId: string,
		params: Static<typeof findSchema>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<FindToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<FindToolDetails>> {
		const { pattern, limit, hidden } = params;

		return untilAborted(signal, async () => {
			const formatScopePath = (targetPath: string): string => {
				const relative = path.relative(this.session.cwd, targetPath).replace(/\\/g, "/");
				return relative.length === 0 ? "." : relative;
			};
			const normalizedPattern = normalizePathLikeInput(pattern).replace(/\\/g, "/");
			if (!normalizedPattern) {
				throw new ToolError("Pattern must not be empty");
			}

			const multiPattern = await resolveMultiFindPattern(normalizedPattern, this.session.cwd);
			const parsedPattern = multiPattern ? null : parseFindPattern(normalizedPattern);
			const hasGlob = multiPattern ? true : (parsedPattern?.hasGlob ?? false);
			const globPattern = multiPattern?.globPattern ?? parsedPattern?.globPattern ?? "**/*";
			const searchPath = resolveToCwd(multiPattern?.basePath ?? parsedPattern?.basePath ?? ".", this.session.cwd);
			const scopePath = multiPattern?.scopePath ?? formatScopePath(searchPath);

			if (searchPath === "/") {
				throw new ToolError("Searching from root directory '/' is not allowed");
			}

			const rawLimit = limit ?? DEFAULT_LIMIT;
			const effectiveLimit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : Number.NaN;
			if (!Number.isFinite(effectiveLimit) || effectiveLimit <= 0) {
				throw new ToolError("Limit must be a positive number");
			}
			const includeHidden = hidden ?? true;
			const timeoutSignal = AbortSignal.timeout(GLOB_TIMEOUT_MS);
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			const formatMatchPath = (matchPath: string, fileType?: natives.FileType): string => {
				const hadTrailingSlash = matchPath.endsWith("/") || matchPath.endsWith("\\");
				const absolutePath = path.isAbsolute(matchPath) ? matchPath : path.resolve(searchPath, matchPath);
				let relativePath = path.relative(this.session.cwd, absolutePath).replace(/\\/g, "/");
				if (relativePath.length === 0) {
					relativePath = ".";
				}
				if ((fileType === natives.FileType.Dir || hadTrailingSlash) && !relativePath.endsWith("/")) {
					relativePath += "/";
				}
				return relativePath;
			};

			const buildResult = (files: string[]): AgentToolResult<FindToolDetails> => {
				if (files.length === 0) {
					const details: FindToolDetails = { scopePath, fileCount: 0, files: [], truncated: false };
					return toolResult(details).text("No files found matching pattern").done();
				}

				const listLimit = applyListLimit(files, { limit: effectiveLimit });
				const limited = listLimit.items;
				const limitMeta = listLimit.meta;
				const rawOutput = limited.join("\n");
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

				const details: FindToolDetails = {
					scopePath,
					fileCount: limited.length,
					files: limited,
					truncated: Boolean(limitMeta.resultLimit || truncation.truncated),
					resultLimitReached: limitMeta.resultLimit?.reached,
					truncation: truncation.truncated ? truncation : undefined,
				};

				const resultBuilder = toolResult(details)
					.text(truncation.content)
					.limits({ resultLimit: limitMeta.resultLimit?.reached });
				if (truncation.truncated) {
					resultBuilder.truncation(truncation, { direction: "head" });
				}

				return resultBuilder.done();
			};

			if (this.#customOps?.glob) {
				if (!(await this.#customOps.exists(searchPath))) {
					throw new ToolError(`Path not found: ${scopePath}`);
				}

				if (!hasGlob && this.#customOps.stat) {
					const stat = await this.#customOps.stat(searchPath);
					if (stat.isFile()) {
						return buildResult([scopePath]);
					}
				}

				const results = await this.#customOps.glob(globPattern, searchPath, {
					ignore: ["**/node_modules/**", "**/.git/**"],
					limit: effectiveLimit,
				});
				const relativized = results.map(p => formatMatchPath(p));

				return buildResult(relativized);
			}

			let searchStat: fs.Stats;
			try {
				searchStat = await fs.promises.stat(searchPath);
			} catch (err) {
				if (isEnoent(err)) {
					throw new ToolError(`Path not found: ${scopePath}`);
				}
				throw err;
			}

			if (!hasGlob && searchStat.isFile()) {
				return buildResult([scopePath]);
			}
			if (!searchStat.isDirectory()) {
				throw new ToolError(`Path is not a directory: ${searchPath}`);
			}

			let matches: natives.GlobMatch[];
			const onUpdateMatches: string[] = [];
			const updateIntervalMs = 200;
			let lastUpdate = 0;
			const emitUpdate = () => {
				if (!onUpdate) return;
				const now = Date.now();
				if (now - lastUpdate < updateIntervalMs) return;
				lastUpdate = now;
				const details: FindToolDetails = {
					scopePath,
					fileCount: onUpdateMatches.length,
					files: onUpdateMatches.slice(),
					truncated: false,
				};
				onUpdate({
					content: [{ type: "text", text: onUpdateMatches.join("\n") }],
					details,
				});
			};
			const onMatch = onUpdate
				? (err: Error | null, match: natives.GlobMatch | null) => {
						if (err || signal?.aborted || !match?.path) return;
						const relativePath = formatMatchPath(match.path, match.fileType);
						onUpdateMatches.push(relativePath);
						emitUpdate();
					}
				: undefined;

			const doGlob = async (useGitignore: boolean) =>
				untilAborted(combinedSignal, () =>
					natives.glob(
						{
							pattern: globPattern,
							path: searchPath,
							fileType: natives.FileType.File,
							hidden: includeHidden,
							maxResults: effectiveLimit,
							sortByMtime: true,
							gitignore: useGitignore,
							signal: combinedSignal,
						},
						onMatch,
					),
				);

			try {
				const result = await doGlob(true);
				// Sort by mtime descending (most recent first) in JS instead of native.
				// This allows native glob to early-terminate at maxResults.
				result.matches.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
				matches = result.matches;
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") {
					if (timeoutSignal.aborted && !signal?.aborted) {
						const timeoutSeconds = Math.max(1, Math.round(GLOB_TIMEOUT_MS / 1000));
						throw new ToolError(`find timed out after ${timeoutSeconds}s`);
					}
					throw new ToolAbortError();
				}
				throw error;
			}

			const relativized: string[] = [];
			for (const match of matches) {
				throwIfAborted(signal);
				if (!match.path) {
					continue;
				}

				relativized.push(formatMatchPath(match.path, match.fileType));
			}

			return buildResult(relativized);
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface FindRenderArgs {
	pattern: string;
	limit?: number;
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;

export const findToolRenderer = {
	inline: true,
	renderCall(args: FindRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);

		const text = renderStatusLine(
			{ icon: "pending", title: "Find", description: args.pattern || "*", meta },
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: FindToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: FindRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const hasDetailedData = details?.fileCount !== undefined;
		const textContent = result.content?.find(c => c.type === "text")?.text;

		if (!hasDetailedData) {
			if (
				!textContent ||
				textContent.includes("No files matching") ||
				textContent.includes("No files found") ||
				textContent.trim() === ""
			) {
				return new Text(formatEmptyMessage("No files found", uiTheme), 0, 0);
			}

			const lines = textContent.split("\n").filter(l => l.trim());
			const header = renderStatusLine(
				{
					icon: "success",
					title: "Find",
					description: args?.pattern,
					meta: [formatCount("file", lines.length)],
				},
				uiTheme,
			);
			let cached: RenderCache | undefined;
			return {
				render(width: number): string[] {
					const { expanded } = options;
					const key = new Hasher().bool(expanded).u32(width).digest();
					if (cached?.key === key) return cached.lines;
					const listLines = renderTreeList(
						{
							items: lines,
							expanded,
							maxCollapsed: COLLAPSED_LIST_LIMIT,
							itemType: "file",
							renderItem: line => uiTheme.fg("accent", line),
						},
						uiTheme,
					);
					const result = [header, ...listLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
					cached = { key, lines: result };
					return result;
				},
				invalidate() {
					cached = undefined;
				},
			};
		}

		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.truncation ?? details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(details?.truncated || truncation || details?.resultLimitReached || limits?.resultLimit);
		const files = details?.files ?? [];

		if (fileCount === 0) {
			const header = renderStatusLine(
				{ icon: "warning", title: "Find", description: args?.pattern, meta: ["0 files"] },
				uiTheme,
			);
			return new Text([header, formatEmptyMessage("No files found", uiTheme)].join("\n"), 0, 0);
		}
		const meta: string[] = [formatCount("file", fileCount)];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));
		const header = renderStatusLine(
			{ icon: truncated ? "warning" : "success", title: "Find", description: args?.pattern, meta },
			uiTheme,
		);

		const truncationReasons: string[] = [];
		if (details?.resultLimitReached) truncationReasons.push(`limit ${details.resultLimitReached} results`);
		if (limits?.resultLimit) truncationReasons.push(`limit ${limits.resultLimit.reached} results`);
		if (truncation) truncationReasons.push(truncation.truncatedBy === "lines" ? "line limit" : "size limit");
		const artifactId = truncation && "artifactId" in truncation ? truncation.artifactId : undefined;
		if (artifactId) truncationReasons.push(formatFullOutputReference(artifactId));

		const extraLines: string[] = [];
		if (truncationReasons.length > 0) {
			extraLines.push(uiTheme.fg("warning", `truncated: ${truncationReasons.join(", ")}`));
		}

		let cached: RenderCache | undefined;
		return {
			render(width: number): string[] {
				const { expanded } = options;
				const key = new Hasher().bool(expanded).u32(width).digest();
				if (cached?.key === key) return cached.lines;
				const fileLines = renderFileList(
					{
						files: files.map(entry => ({ path: entry, isDirectory: entry.endsWith("/") })),
						expanded,
						maxCollapsed: COLLAPSED_LIST_LIMIT,
					},
					uiTheme,
				);
				const result = [header, ...fileLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				cached = { key, lines: result };
				return result;
			},
			invalidate() {
				cached = undefined;
			},
		};
	},
	mergeCallAndResult: true,
};
