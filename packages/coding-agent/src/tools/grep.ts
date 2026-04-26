import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";

import { type GrepMatch, GrepOutputMode, type GrepResult, grep } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { type ChunkedGrepMatch, describeChunkedGrepMatch } from "../edit/modes/chunk";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { getLanguageFromPath, type Theme } from "../modes/theme/theme";
import grepDescription from "../prompts/tools/grep.md" with { type: "text" };
import { DEFAULT_MAX_COLUMN, type TruncationResult, truncateHead } from "../session/streaming-output";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import { resolveEditMode } from "../utils/edit-mode";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { createFileRecorder } from "./file-recorder";
import { formatMatchLine } from "./match-line-format";
import { formatFullOutputReference, type OutputMeta } from "./output-meta";
import {
	combineSearchGlobs,
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
	path: Type.Optional(Type.String({ description: "path to search", examples: ["src/", "src/foo.ts"] })),
	glob: Type.Optional(Type.String({ description: "glob filter", examples: ["*.js"] })),
	type: Type.Optional(Type.String({ description: "file type filter", examples: ["js", "py", "rust"] })),
	i: Type.Optional(Type.Boolean({ description: "case-insensitive search", default: false })),
	pre: Type.Optional(Type.Number({ description: "lines before matches" })),
	post: Type.Optional(Type.Number({ description: "lines after matches" })),
	multiline: Type.Optional(Type.Boolean({ description: "multiline matching" })),
	gitignore: Type.Optional(Type.Boolean({ description: "respect gitignore", default: true })),
	limit: Type.Optional(Type.Number({ description: "max matches", default: 20 })),
	offset: Type.Optional(Type.Number({ description: "skip first n matches", default: 0 })),
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
	 * `result.text` lines but uses a `│` gutter and `*` to mark match lines (vs `-` for
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
			IS_CHUNK_MODE: displayMode.chunked,
		});
	}

	async execute(
		_toolCallId: string,
		params: GrepParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GrepToolDetails>,
		_toolContext?: AgentToolContext,
	): Promise<AgentToolResult<GrepToolDetails>> {
		const { pattern, path: searchDir, glob, type, i, gitignore, pre, post, multiline, limit, offset } = params;

		return untilAborted(signal, async () => {
			const normalizedPattern = pattern.trim();
			const chunkMode = resolveEditMode(this.session) === "chunk";
			if (!normalizedPattern) {
				throw new ToolError("Pattern must not be empty");
			}

			const normalizedOffset = offset === undefined ? 0 : Number.isFinite(offset) ? Math.floor(offset) : Number.NaN;
			if (normalizedOffset < 0 || !Number.isFinite(normalizedOffset)) {
				throw new ToolError("Offset must be a non-negative number");
			}

			const rawLimit = limit === undefined ? undefined : Number.isFinite(limit) ? Math.floor(limit) : Number.NaN;
			if (rawLimit !== undefined && (!Number.isFinite(rawLimit) || rawLimit < 0)) {
				throw new ToolError("Limit must be a non-negative number");
			}
			const normalizedLimit = rawLimit !== undefined && rawLimit > 0 ? rawLimit : undefined;

			const defaultContextBefore = this.session.settings.get("grep.contextBefore");
			const defaultContextAfter = this.session.settings.get("grep.contextAfter");
			const normalizedContextBefore = pre ?? defaultContextBefore;
			const normalizedContextAfter = post ?? defaultContextAfter;
			const ignoreCase = i ?? false;
			const useGitignore = gitignore ?? true;
			const patternHasNewline = normalizedPattern.includes("\n") || normalizedPattern.includes("\\n");
			const effectiveMultiline = multiline ?? patternHasNewline;

			const useHashLines = resolveFileDisplayMode(this.session).hashLines;
			const formatScopePath = (targetPath: string): string => {
				const relative = path.relative(this.session.cwd, targetPath).replace(/\\/g, "/");
				return relative.length === 0 ? "." : relative;
			};
			let searchPath: string;
			let scopePath: string;
			let exactFilePaths: string[] | undefined;
			let globFilter = glob ? normalizePathLikeInput(glob) || undefined : undefined;
			const internalRouter = this.session.internalRouter;
			if (searchDir?.trim()) {
				const rawPath = normalizePathLikeInput(searchDir);
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
						if (parsedPath.glob) {
							globFilter = combineSearchGlobs(parsedPath.glob, globFilter);
						}
						scopePath = formatScopePath(searchPath);
					}
				}
			} else {
				searchPath = resolveToCwd(".", this.session.cwd);
				scopePath = ".";
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
			const effectiveLimit = normalizedLimit ?? DEFAULT_MATCH_LIMIT;
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
								type: type?.trim() || undefined,
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
					const offsetMatches = matches.slice(normalizedOffset);
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
							type: type?.trim() || undefined,
							ignoreCase,
							multiline: effectiveMultiline,
							hidden: true,
							gitignore: useGitignore,
							cache: false,
							maxCount: internalLimit,
							offset: normalizedOffset > 0 ? normalizedOffset : undefined,
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
			if (chunkMode) {
				const annotatedMatches = await Promise.all(
					selectedMatches.map(match => {
						const relativePath = match.path.startsWith("/") ? match.path.slice(1) : match.path;
						const absoluteFilePath = isDirectory ? path.join(searchPath, relativePath) : searchPath;
						return describeChunkedGrepMatch({
							filePath: absoluteFilePath,
							lineNumber: match.lineNumber,
							line: match.line,
							cwd: this.session.cwd,
							language: getLanguageFromPath(absoluteFilePath),
						});
					}),
				);
				const chunkMatchesByFile = new Map<string, ChunkedGrepMatch[]>();
				for (const match of annotatedMatches) {
					recordFile(match.displayPath);
					if (!chunkMatchesByFile.has(match.displayPath)) {
						chunkMatchesByFile.set(match.displayPath, []);
					}
					chunkMatchesByFile.get(match.displayPath)!.push(match);
				}
				const renderChunkedMatchesForFile = (relativePath: string): string[] => {
					const renderedLines: string[] = [];
					const fileMatches = chunkMatchesByFile.get(relativePath) ?? [];
					if (fileMatches.length === 0) {
						return renderedLines;
					}
					const matchesByChunk = new Map<string, ChunkedGrepMatch[]>();
					for (const match of fileMatches) {
						const chunkKey = match.chunkPath ?? "";
						if (!matchesByChunk.has(chunkKey)) {
							matchesByChunk.set(chunkKey, []);
						}
						matchesByChunk.get(chunkKey)!.push(match);
					}
					for (const [chunkPath, chunkMatches] of matchesByChunk) {
						if (chunkPath) {
							const chunkChecksum = chunkMatches[0]?.chunkChecksum;
							const dashes = "-".repeat(chunkPath.split(".").length - 1);
							const anchor = chunkChecksum
								? `${dashes}@${chunkPath}#${chunkChecksum}`
								: `${dashes}@${chunkPath}`;
							renderedLines.push(anchor);
						}
						for (const match of chunkMatches) {
							renderedLines.push(`    ${match.lineNumber}|${match.line}`);
							fileMatchCounts.set(relativePath, (fileMatchCounts.get(relativePath) ?? 0) + 1);
						}
					}
					return renderedLines;
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
								const renderedLines = renderChunkedMatchesForFile(relativePath);
								if (renderedLines.length === 0) continue;
								if (outputLines.length > 0) {
									outputLines.push("");
								}
								outputLines.push(`# ${path.basename(relativePath)}`);
								outputLines.push(...renderedLines);
							}
							continue;
						}
						const renderedFiles = directoryFiles
							.map(relativePath => ({ relativePath, lines: renderChunkedMatchesForFile(relativePath) }))
							.filter(file => file.lines.length > 0);
						if (renderedFiles.length === 0) continue;
						if (outputLines.length > 0) {
							outputLines.push("");
						}
						outputLines.push(`# ${directory}`);
						for (const { relativePath, lines } of renderedFiles) {
							outputLines.push(`## └─ ${path.basename(relativePath)}`);
							outputLines.push(...lines);
						}
					}
				} else {
					for (const relativePath of fileList) {
						outputLines.push(...renderChunkedMatchesForFile(relativePath));
					}
				}
				const rawOutput = outputLines.join("\n");
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
				const truncated = Boolean(matchLimitReached || result.limitReached || truncation.truncated);
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
				};
				if (truncation.truncated) details.truncation = truncation;
				const resultBuilder = toolResult(details)
					.text(truncation.content)
					.limits({
						matchLimit: matchLimitReached ? effectiveLimit : undefined,
						resultLimit: result.limitReached ? internalLimit : undefined,
					});
				if (truncation.truncated) {
					resultBuilder.truncation(truncation, { direction: "head" });
				}
				return resultBuilder.done();
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
				outputLines.unshift("[grep] match lines use ':'; context lines use '-'.");
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
				.limits({
					matchLimit: matchLimitReached ? effectiveLimit : undefined,
					resultLimit: result.limitReached ? internalLimit : undefined,
					columnMax: linesTruncated ? DEFAULT_MAX_COLUMN : undefined,
				});
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
	glob?: string;
	type?: string;
	i?: boolean;
	gitignore?: boolean;
	pre?: number;
	post?: number;
	multiline?: boolean;
	limit?: number;
	offset?: number;
}

const COLLAPSED_TEXT_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

export const grepToolRenderer = {
	inline: true,
	renderCall(args: GrepRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.path) meta.push(`in ${args.path}`);
		if (args.glob) meta.push(`glob:${args.glob}`);
		if (args.type) meta.push(`type:${args.type}`);
		if (args.i) meta.push("case:insensitive");
		if (args.gitignore === false) meta.push("gitignore:false");
		if (args.pre !== undefined && args.pre > 0) {
			meta.push(`pre:${args.pre}`);
		}
		if (args.post !== undefined && args.post > 0) {
			meta.push(`post:${args.post}`);
		}
		if (args.multiline) meta.push("multiline");
		if (args.limit !== undefined && args.limit > 0) meta.push(`limit:${args.limit}`);
		if (args.offset !== undefined && args.offset > 0) meta.push(`offset:${args.offset}`);

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

		const truncationReasons: string[] = [];
		if (limits?.matchLimit) truncationReasons.push(`limit ${limits.matchLimit.reached} matches`);
		if (limits?.resultLimit) truncationReasons.push(`limit ${limits.resultLimit.reached} results`);
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
