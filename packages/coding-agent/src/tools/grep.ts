import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";

import { type GrepMatch, GrepOutputMode, type GrepResult, grep } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import grepDescription from "../prompts/tools/grep.md" with { type: "text" };
import { DEFAULT_MAX_COLUMN, type TruncationResult, truncateHead } from "../session/streaming-output";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { createFileRecorder } from "./file-recorder";
import { formatMatchLine } from "./match-line-format";
import { formatFullOutputReference, type OutputMeta } from "./output-meta";
import {
	hasGlobPathChars,
	normalizePathLikeInput,
	parseSearchPath,
	resolveMultiSearchPath,
	resolveToCwd,
} from "./path-utils";
import {
	formatCodeFrameLine,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	PREVIEW_LIMITS,
} from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "regex pattern", examples: ["function\\s+\\w+", "TODO"] }),
	path: Type.String({
		description: "file, directory, glob, comma-separated paths, or internal URL to search",
		examples: ["src/", "src/foo.ts", "src/**/*.ts"],
	}),
	i: Type.Optional(Type.Boolean({ description: "case-insensitive search", default: false })),
	gitignore: Type.Optional(Type.Boolean({ description: "respect gitignore", default: true })),
	skip: Type.Optional(Type.Number({ description: "matches to skip", default: 0 })),
});

export type GrepToolInput = Static<typeof grepSchema>;

const DEFAULT_MATCH_LIMIT = 20;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	resultLimitReached?: number;
	linesTruncated?: boolean;
	meta?: OutputMeta;
	scopePath?: string;
	matchCount?: number;
	fileCount?: number;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	truncated?: boolean;
	error?: string;
	/** Pre-formatted text for the user-visible TUI render. Mirrors the model-facing
	 * `result.text` lines but uses a `│` gutter and `*` to mark match lines (vs space for
	 * context). The TUI uses this directly so it never parses model-facing hashline anchors. */
	displayContent?: string;
}

type GrepParams = Static<typeof grepSchema>;

export class GrepTool implements AgentTool<typeof grepSchema, GrepToolDetails> {
	readonly name = "grep";
	readonly label = "Grep";
	readonly description: string;
	readonly parameters = grepSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		const displayMode = resolveFileDisplayMode(session);
		this.description = prompt.render(grepDescription, {
			IS_HASHLINE_MODE: displayMode.hashLines,
			IS_LINE_NUMBER_MODE: !displayMode.hashLines && displayMode.lineNumbers,
		});
	}

	async execute(
		_toolCallId: string,
		params: GrepParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GrepToolDetails>,
		_toolContext?: AgentToolContext,
	): Promise<AgentToolResult<GrepToolDetails>> {
		const { pattern, path: searchDir, i, gitignore, skip } = params;

		return untilAborted(signal, async () => {
			const normalizedPattern = pattern.trim();
			if (!normalizedPattern) {
				throw new ToolError("Pattern must not be empty");
			}

			const normalizedSkip = skip === undefined ? 0 : Number.isFinite(skip) ? Math.floor(skip) : Number.NaN;
			if (normalizedSkip < 0 || !Number.isFinite(normalizedSkip)) {
				throw new ToolError("Skip must be a non-negative number");
			}
			const normalizedContextBefore = this.session.settings.get("grep.contextBefore");
			const normalizedContextAfter = this.session.settings.get("grep.contextAfter");
			const ignoreCase = i ?? false;
			const useGitignore = gitignore ?? true;
			const patternHasNewline = normalizedPattern.includes("\n") || normalizedPattern.includes("\\n");
			const effectiveMultiline = patternHasNewline;

			const useHashLines = resolveFileDisplayMode(this.session).hashLines;
			const formatScopePath = (targetPath: string): string => {
				const relative = path.relative(this.session.cwd, targetPath).replace(/\\/g, "/");
				return relative.length === 0 ? "." : relative;
			};
			let searchPath: string;
			let scopePath: string;
			let exactFilePaths: string[] | undefined;
			let globFilter: string | undefined;
			const rawPath = normalizePathLikeInput(searchDir);
			if (rawPath.length === 0) {
				throw new ToolError("`path` must be a non-empty path or glob");
			}
			const internalRouter = this.session.internalRouter;
			if (internalRouter?.canHandle(rawPath)) {
				if (hasGlobPathChars(rawPath)) {
					throw new ToolError(`Glob patterns are not supported for internal URLs: ${rawPath}`);
				}
				const resource = await internalRouter.resolve(rawPath);
				if (!resource.sourcePath) {
					throw new ToolError(`Cannot grep internal URL without a backing file: ${rawPath}`);
				}
				searchPath = resource.sourcePath;
				scopePath = formatScopePath(searchPath);
			} else {
				const multiSearchPath = await resolveMultiSearchPath(rawPath, this.session.cwd, globFilter);
				if (multiSearchPath) {
					searchPath = multiSearchPath.basePath;
					globFilter = multiSearchPath.exactFilePaths ? undefined : multiSearchPath.glob;
					exactFilePaths = multiSearchPath.exactFilePaths;
					scopePath = multiSearchPath.scopePath;
				} else {
					const parsedPath = parseSearchPath(rawPath);
					searchPath = resolveToCwd(parsedPath.basePath, this.session.cwd);
					globFilter = parsedPath.glob;
					scopePath = formatScopePath(searchPath);
				}
			}
			let isDirectory: boolean;
			try {
				const stat = await Bun.file(searchPath).stat();
				isDirectory = stat.isDirectory();
			} catch {
				const hint = scopePath.includes(",") ? ` (comma-separated paths must each exist relative to cwd)` : "";
				throw new ToolError(`Path not found: ${scopePath}${hint}`);
			}

			const effectiveOutputMode = GrepOutputMode.Content;
			const effectiveLimit = DEFAULT_MATCH_LIMIT;
			const internalLimit = Math.min(effectiveLimit * 5, 2000);

			// Run grep
			let result: GrepResult;
			try {
				if (exactFilePaths) {
					const matches: GrepMatch[] = [];
					let limitReached = false;
					for (const exactFilePath of exactFilePaths) {
						const fileResult = await grep(
							{
								pattern: normalizedPattern,
								path: exactFilePath,
								ignoreCase,
								multiline: effectiveMultiline,
								hidden: true,
								gitignore: useGitignore,
								cache: false,
								contextBefore: normalizedContextBefore,
								contextAfter: normalizedContextAfter,
								maxColumns: DEFAULT_MAX_COLUMN,
								mode: effectiveOutputMode,
							},
							undefined,
						);
						limitReached = limitReached || Boolean(fileResult.limitReached);
						const relativeFilePath = path.relative(searchPath, exactFilePath).replace(/\\/g, "/");
						matches.push(...fileResult.matches.map(match => ({ ...match, path: relativeFilePath })));
					}
					const offsetMatches = matches.slice(normalizedSkip);
					result = {
						matches: offsetMatches,
						totalMatches: offsetMatches.length,
						filesWithMatches: new Set(offsetMatches.map(match => match.path)).size,
						filesSearched: exactFilePaths.length,
						limitReached,
					};
				} else {
					result = await grep(
						{
							pattern: normalizedPattern,
							path: searchPath,
							glob: globFilter,
							ignoreCase,
							multiline: effectiveMultiline,
							hidden: true,
							gitignore: useGitignore,
							cache: false,
							maxCount: internalLimit,
							offset: normalizedSkip > 0 ? normalizedSkip : undefined,
							contextBefore: normalizedContextBefore,
							contextAfter: normalizedContextAfter,
							maxColumns: DEFAULT_MAX_COLUMN,
							mode: effectiveOutputMode,
						},
						undefined,
					);
				}
			} catch (err) {
				if (err instanceof Error && err.message.startsWith("regex parse error")) {
					throw new ToolError(err.message);
				}
				throw err;
			}

			const formatPath = (filePath: string): string => {
				// returns paths starting with / (the virtual root)
				const cleanPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
				if (isDirectory) {
					return cleanPath.replace(/\\/g, "/");
				}
				return path.basename(cleanPath);
			};

			// Build output
			const roundRobinSelect = (matches: GrepMatch[], limit: number): GrepMatch[] => {
				if (matches.length <= limit) return matches;
				const fileOrder: string[] = [];
				const byFile = new Map<string, GrepMatch[]>();
				for (const match of matches) {
					if (!byFile.has(match.path)) {
						fileOrder.push(match.path);
						byFile.set(match.path, []);
					}
					byFile.get(match.path)!.push(match);
				}
				const selected: GrepMatch[] = [];
				const indices = new Map<string, number>(fileOrder.map(file => [file, 0]));
				while (selected.length < limit) {
					let anyAdded = false;
					for (const file of fileOrder) {
						if (selected.length >= limit) break;
						const fileMatches = byFile.get(file)!;
						const idx = indices.get(file)!;
						if (idx < fileMatches.length) {
							selected.push(fileMatches[idx]);
							indices.set(file, idx + 1);
							anyAdded = true;
						}
					}
					if (!anyAdded) break;
				}
				return selected;
			};
			const selectedMatches = isDirectory
				? roundRobinSelect(result.matches, effectiveLimit)
				: result.matches.slice(0, effectiveLimit);
			const matchLimitReached = result.matches.length > effectiveLimit;
			const nextSkip = normalizedSkip + selectedMatches.length;
			const limitMessage = `Result limit reached; narrow path or use skip=${nextSkip}.`;
			const { record: recordFile, list: fileList } = createFileRecorder();
			const fileMatchCounts = new Map<string, number>();
			if (selectedMatches.length === 0) {
				const details: GrepToolDetails = {
					scopePath,
					matchCount: 0,
					fileCount: 0,
					files: [],
					truncated: false,
				};
				return toolResult(details).text("No matches found").done();
			}
			const outputLines: string[] = [];
			let linesTruncated = false;
			const hasContextLines = normalizedContextBefore > 0 || normalizedContextAfter > 0;
			const matchesByFile = new Map<string, GrepMatch[]>();
			for (const match of selectedMatches) {
				const relativePath = formatPath(match.path);
				recordFile(relativePath);
				if (!matchesByFile.has(relativePath)) {
					matchesByFile.set(relativePath, []);
				}
				matchesByFile.get(relativePath)!.push(match);
			}
			const displayLines: string[] = [];
			const renderMatchesForFile = (relativePath: string): { model: string[]; display: string[] } => {
				const modelOut: string[] = [];
				const displayOut: string[] = [];
				const fileMatches = matchesByFile.get(relativePath) ?? [];
				const lineNumberWidth = fileMatches.reduce((width, match) => {
					let nextWidth = Math.max(width, String(match.lineNumber).length);
					for (const ctx of match.contextBefore ?? []) {
						nextWidth = Math.max(nextWidth, String(ctx.lineNumber).length);
					}
					for (const ctx of match.contextAfter ?? []) {
						nextWidth = Math.max(nextWidth, String(ctx.lineNumber).length);
					}
					return nextWidth;
				}, 0);
				for (const match of fileMatches) {
					const pushLine = (lineNumber: number, line: string, isMatch: boolean) => {
						modelOut.push(formatMatchLine(lineNumber, line, isMatch, { useHashLines }));
						displayOut.push(formatCodeFrameLine(isMatch ? "*" : " ", lineNumber, line, lineNumberWidth));
					};
					if (match.contextBefore) {
						for (const ctx of match.contextBefore) {
							pushLine(ctx.lineNumber, ctx.line, false);
						}
					}
					pushLine(match.lineNumber, match.line, true);
					if (match.truncated) {
						linesTruncated = true;
					}
					if (match.contextAfter) {
						for (const ctx of match.contextAfter) {
							pushLine(ctx.lineNumber, ctx.line, false);
						}
					}
					fileMatchCounts.set(relativePath, (fileMatchCounts.get(relativePath) ?? 0) + 1);
				}
				return { model: modelOut, display: displayOut };
			};
			if (isDirectory) {
				const filesByDirectory = new Map<string, string[]>();
				for (const relativePath of fileList) {
					const directory = path.dirname(relativePath).replace(/\\/g, "/");
					if (!filesByDirectory.has(directory)) {
						filesByDirectory.set(directory, []);
					}
					filesByDirectory.get(directory)!.push(relativePath);
				}
				for (const [directory, directoryFiles] of filesByDirectory) {
					if (directory === ".") {
						for (const relativePath of directoryFiles) {
							const rendered = renderMatchesForFile(relativePath);
							if (rendered.model.length === 0) continue;
							if (outputLines.length > 0) {
								outputLines.push("");
								displayLines.push("");
							}
							const header = `# ${path.basename(relativePath)}`;
							outputLines.push(header, ...rendered.model);
							displayLines.push(header, ...rendered.display);
						}
						continue;
					}
					const renderedFiles = directoryFiles
						.map(relativePath => ({ relativePath, rendered: renderMatchesForFile(relativePath) }))
						.filter(file => file.rendered.model.length > 0);
					if (renderedFiles.length === 0) continue;
					if (outputLines.length > 0) {
						outputLines.push("");
						displayLines.push("");
					}
					const dirHeader = `# ${directory}`;
					outputLines.push(dirHeader);
					displayLines.push(dirHeader);
					for (const { relativePath, rendered } of renderedFiles) {
						const fileHeader = `## └─ ${path.basename(relativePath)}`;
						outputLines.push(fileHeader, ...rendered.model);
						displayLines.push(fileHeader, ...rendered.display);
					}
				}
			} else {
				for (const relativePath of fileList) {
					const rendered = renderMatchesForFile(relativePath);
					outputLines.push(...rendered.model);
					displayLines.push(...rendered.display);
				}
			}
			if (hasContextLines && outputLines.length > 0) {
				outputLines.unshift("[grep] match lines use '>'; context lines use ':'.");
			}
			if (matchLimitReached || result.limitReached) {
				outputLines.push("", limitMessage);
			}
			const rawOutput = outputLines.join("\n");
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
			const output = truncation.content;
			const truncated = Boolean(matchLimitReached || result.limitReached || truncation.truncated || linesTruncated);
			const details: GrepToolDetails = {
				scopePath,
				matchCount: selectedMatches.length,
				fileCount: fileList.length,
				files: fileList,
				fileMatches: fileList.map(path => ({
					path,
					count: fileMatchCounts.get(path) ?? 0,
				})),
				truncated,
				matchLimitReached: matchLimitReached ? effectiveLimit : undefined,
				resultLimitReached: result.limitReached ? internalLimit : undefined,
				displayContent: displayLines.join("\n"),
			};
			if (truncation.truncated) details.truncation = truncation;
			if (linesTruncated) details.linesTruncated = true;
			const resultBuilder = toolResult(details)
				.text(output)
				.limits({ columnMax: linesTruncated ? DEFAULT_MAX_COLUMN : undefined });
			if (truncation.truncated) {
				resultBuilder.truncation(truncation, { direction: "head" });
			}
			return resultBuilder.done();
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface GrepRenderArgs {
	pattern: string;
	path?: string;
	i?: boolean;
	gitignore?: boolean;
	skip?: number;
}

const COLLAPSED_TEXT_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

export const grepToolRenderer = {
	inline: true,
	renderCall(args: GrepRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.path) meta.push(`in ${args.path}`);
		if (args.i) meta.push("case:insensitive");
		if (args.gitignore === false) meta.push("gitignore:false");
		if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);

		const text = renderStatusLine(
			{ icon: "pending", title: "Grep", description: args.pattern || "?", meta },
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GrepToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: GrepRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const hasDetailedData = details?.matchCount !== undefined || details?.fileCount !== undefined;

		if (!hasDetailedData) {
			const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text;
			if (!textContent || textContent === "No matches found") {
				return new Text(formatEmptyMessage("No matches found", uiTheme), 0, 0);
			}
			const lines = textContent.split("\n").filter(line => line.trim() !== "");
			const description = args?.pattern ?? undefined;
			const header = renderStatusLine(
				{ icon: "success", title: "Grep", description, meta: [formatCount("item", lines.length)] },
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
							maxCollapsed: COLLAPSED_TEXT_LIMIT,
							maxCollapsedLines: COLLAPSED_TEXT_LIMIT,
							itemType: "item",
							renderItem: line => uiTheme.fg("toolOutput", line),
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

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(
			details?.truncated || truncation || limits?.matchLimit || limits?.resultLimit || limits?.columnTruncated,
		);

		if (matchCount === 0) {
			const header = renderStatusLine(
				{ icon: "warning", title: "Grep", description: args?.pattern, meta: ["0 matches"] },
				uiTheme,
			);
			return new Text([header, formatEmptyMessage("No matches found", uiTheme)].join("\n"), 0, 0);
		}

		const summaryParts = [formatCount("match", matchCount), formatCount("file", fileCount)];
		const meta = [...summaryParts];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));
		const description = args?.pattern ?? undefined;
		const header = renderStatusLine(
			{ icon: truncated ? "warning" : "success", title: "Grep", description, meta },
			uiTheme,
		);

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const rawLines = textContent.split("\n");
		const hasSeparators = rawLines.some(line => line.trim().length === 0);
		const matchGroups: string[][] = [];
		if (hasSeparators) {
			let current: string[] = [];
			for (const line of rawLines) {
				if (line.trim().length === 0) {
					if (current.length > 0) {
						matchGroups.push(current);
						current = [];
					}
					continue;
				}
				current.push(line);
			}
			if (current.length > 0) matchGroups.push(current);
		} else {
			const nonEmpty = rawLines.filter(line => line.trim().length > 0);
			if (nonEmpty.length > 0) {
				matchGroups.push(nonEmpty);
			}
		}

		const renderedMatchLimit = details?.matchLimitReached ?? limits?.matchLimit?.reached;
		const renderedResultLimit = details?.resultLimitReached ?? limits?.resultLimit?.reached;
		const truncationReasons: string[] = [];
		if (renderedMatchLimit) truncationReasons.push(`first ${renderedMatchLimit} matches`);
		if (renderedResultLimit) truncationReasons.push(`first ${renderedResultLimit} results`);
		if (truncation) truncationReasons.push(truncation.truncatedBy === "lines" ? "line limit" : "size limit");
		if (limits?.columnTruncated) truncationReasons.push(`line length ${limits.columnTruncated.maxColumn}`);
		if (truncation?.artifactId) truncationReasons.push(formatFullOutputReference(truncation.artifactId));

		const extraLines =
			truncationReasons.length > 0 ? [uiTheme.fg("warning", `truncated: ${truncationReasons.join(", ")}`)] : [];

		let cached: RenderCache | undefined;
		return {
			render(width: number): string[] {
				const { expanded } = options;
				const key = new Hasher().bool(expanded).u32(width).digest();
				if (cached?.key === key) return cached.lines;
				const collapsedMatchLineBudget = Math.max(COLLAPSED_TEXT_LIMIT - extraLines.length, 0);
				const matchLines = renderTreeList(
					{
						items: matchGroups,
						expanded,
						maxCollapsed: matchGroups.length,
						maxCollapsedLines: collapsedMatchLineBudget,
						itemType: "match",
						renderItem: group =>
							group.map(line => {
								if (line.startsWith("## ")) return uiTheme.fg("dim", line);
								if (line.startsWith("# ")) return uiTheme.fg("accent", line);
								return uiTheme.fg("toolOutput", line);
							}),
					},
					uiTheme,
				);
				const result = [header, ...matchLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
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
