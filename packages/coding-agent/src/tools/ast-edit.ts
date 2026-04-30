import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type AstReplaceChange, astEdit } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { $envpos, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { computeLineHash, HASHLINE_CONTENT_SEPARATOR } from "../edit/line-hash";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import astEditDescription from "../prompts/tools/ast-edit.md" with { type: "text" };
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { createFileRecorder, formatResultPath } from "./file-recorder";
import { formatGroupedFiles } from "./grouped-file-output";
import type { OutputMeta } from "./output-meta";
import {
	formatPathRelativeToCwd,
	hasGlobPathChars,
	normalizePathLikeInput,
	parseSearchPath,
	resolveMultiSearchPath,
	resolveToCwd,
} from "./path-utils";
import {
	dedupeParseErrors,
	formatCodeFrameLine,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	formatParseErrors,
	PARSE_ERRORS_LIMIT,
	PREVIEW_LIMITS,
} from "./render-utils";
import { queueResolveHandler } from "./resolve";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const astEditOpSchema = Type.Object({
	pat: Type.String({ description: "ast pattern", examples: ["oldFn($$$ARGS)"] }),
	out: Type.String({ description: "replacement template", examples: ["newFn($$$ARGS)"] }),
});

const astEditSchema = Type.Object({
	ops: Type.Array(astEditOpSchema, {
		minItems: 1,
		description: "rewrite ops",
	}),
	path: Type.String({
		description: "file, directory, glob, or comma-separated paths to rewrite",
		examples: ["src/", "src/foo.ts", "src/**/*.ts"],
	}),
});

export interface AstEditToolDetails {
	totalReplacements: number;
	filesTouched: number;
	filesSearched: number;
	applied: boolean;
	limitReached: boolean;
	parseErrors?: string[];
	scopePath?: string;
	files?: string[];
	fileReplacements?: Array<{ path: string; count: number }>;
	meta?: OutputMeta;
	/** Pre-formatted text for the user-visible TUI render. Mirrors `result.text` lines but uses
	 * a `│` gutter (no model-only hashline anchors). The TUI uses this directly so it never parses model-facing text. */
	displayContent?: string;
}

export class AstEditTool implements AgentTool<typeof astEditSchema, AstEditToolDetails> {
	readonly name = "ast_edit";
	readonly label = "AST Edit";
	readonly description: string;
	readonly parameters = astEditSchema;
	readonly strict = true;
	readonly deferrable = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(astEditDescription);
	}

	async execute(
		_toolCallId: string,
		params: Static<typeof astEditSchema>,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AstEditToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AstEditToolDetails>> {
		return untilAborted(signal, async () => {
			const ops = params.ops.map((entry, index) => {
				if (entry.pat.length === 0) {
					throw new ToolError(`\`ops[${index}].pat\` must be a non-empty pattern`);
				}
				return [entry.pat, entry.out] as const;
			});
			if (ops.length === 0) {
				throw new ToolError("`ops` must include at least one op entry");
			}
			const seenPatterns = new Set<string>();
			for (const [pat] of ops) {
				if (seenPatterns.has(pat)) {
					throw new ToolError(`Duplicate rewrite pattern: ${pat}`);
				}
				seenPatterns.add(pat);
			}
			const normalizedRewrites = Object.fromEntries(ops);
			const maxFiles = $envpos("PI_MAX_AST_FILES", 1000);

			const formatScopePath = (targetPath: string): string => formatPathRelativeToCwd(targetPath, this.session.cwd);
			let searchPath: string | undefined;
			let scopePath: string | undefined;
			let globFilter: string | undefined;
			const rawPath = normalizePathLikeInput(params.path);
			if (rawPath.length === 0) {
				throw new ToolError("`path` must be a non-empty path or glob");
			}
			if (rawPath) {
				const internalRouter = this.session.internalRouter;
				if (internalRouter?.canHandle(rawPath)) {
					if (hasGlobPathChars(rawPath)) {
						throw new ToolError(`Glob patterns are not supported for internal URLs: ${rawPath}`);
					}
					const resource = await internalRouter.resolve(rawPath);
					if (!resource.sourcePath) {
						throw new ToolError(`Cannot rewrite internal URL without backing file: ${rawPath}`);
					}
					searchPath = resource.sourcePath;
					scopePath = formatScopePath(searchPath);
				} else {
					const multiSearchPath = await resolveMultiSearchPath(rawPath, this.session.cwd, globFilter);
					if (multiSearchPath) {
						searchPath = multiSearchPath.basePath;
						globFilter = multiSearchPath.glob;
						scopePath = multiSearchPath.scopePath;
					} else {
						const parsedPath = parseSearchPath(rawPath);
						searchPath = resolveToCwd(parsedPath.basePath, this.session.cwd);
						globFilter = parsedPath.glob;
						scopePath = formatScopePath(searchPath);
					}
				}
			}
			const resolvedSearchPath = searchPath ?? resolveToCwd(".", this.session.cwd);
			scopePath = scopePath ?? formatScopePath(resolvedSearchPath);
			let isDirectory: boolean;
			try {
				const stat = await Bun.file(resolvedSearchPath).stat();
				isDirectory = stat.isDirectory();
			} catch {
				throw new ToolError(`Path not found: ${scopePath}`);
			}

			const result = await astEdit({
				rewrites: normalizedRewrites,
				path: resolvedSearchPath,
				glob: globFilter,
				dryRun: true,
				maxFiles,
				failOnParseError: false,
				signal,
			});

			const dedupedParseErrors = dedupeParseErrors(result.parseErrors);
			const formatPath = (filePath: string): string =>
				formatResultPath(filePath, isDirectory, resolvedSearchPath, this.session.cwd);

			const { record: recordFile, list: fileList } = createFileRecorder();
			const fileReplacementCounts = new Map<string, number>();
			const changesByFile = new Map<string, AstReplaceChange[]>();
			for (const fileChange of result.fileChanges) {
				const relativePath = formatPath(fileChange.path);
				recordFile(relativePath);
				fileReplacementCounts.set(relativePath, (fileReplacementCounts.get(relativePath) ?? 0) + fileChange.count);
			}
			for (const change of result.changes) {
				const relativePath = formatPath(change.path);
				recordFile(relativePath);
				if (!changesByFile.has(relativePath)) {
					changesByFile.set(relativePath, []);
				}
				changesByFile.get(relativePath)!.push(change);
			}

			const baseDetails: AstEditToolDetails = {
				totalReplacements: result.totalReplacements,
				filesTouched: result.filesTouched,
				filesSearched: result.filesSearched,
				applied: result.applied,
				limitReached: result.limitReached,
				...(dedupedParseErrors.length > 0 ? { parseErrors: dedupedParseErrors } : {}),
				scopePath,
				files: fileList,
				fileReplacements: [],
			};

			if (result.totalReplacements === 0) {
				const parseMessage = dedupedParseErrors.length
					? `\n${formatParseErrors(dedupedParseErrors).join("\n")}`
					: "";
				return toolResult(baseDetails).text(`No replacements made${parseMessage}`).done();
			}

			const useHashLines = resolveFileDisplayMode(this.session).hashLines;
			const outputLines: string[] = [];
			const displayLines: string[] = [];
			const renderChangesForFile = (relativePath: string): { model: string[]; display: string[] } => {
				const modelOut: string[] = [];
				const displayOut: string[] = [];
				const fileChanges = changesByFile.get(relativePath) ?? [];
				const lineNumberWidth = fileChanges.reduce(
					(width, change) => Math.max(width, String(change.startLine).length),
					0,
				);
				for (const change of fileChanges) {
					const beforeFirstLine = change.before.split("\n", 1)[0] ?? "";
					const afterFirstLine = change.after.split("\n", 1)[0] ?? "";
					const beforeLine = beforeFirstLine.slice(0, 120);
					const afterLine = afterFirstLine.slice(0, 120);
					const beforeRef = useHashLines
						? `${change.startLine}${computeLineHash(change.startLine, beforeFirstLine)}`
						: `${change.startLine}:${change.startColumn}`;
					const afterRef = useHashLines
						? `${change.startLine}${computeLineHash(change.startLine, afterFirstLine)}`
						: `${change.startLine}:${change.startColumn}`;
					const lineSeparator = useHashLines ? HASHLINE_CONTENT_SEPARATOR : " ";
					modelOut.push(`-${beforeRef}${lineSeparator}${beforeLine}`);
					modelOut.push(`+${afterRef}${lineSeparator}${afterLine}`);
					displayOut.push(formatCodeFrameLine("-", change.startLine, beforeLine, lineNumberWidth));
					displayOut.push(formatCodeFrameLine("+", change.startLine, afterLine, lineNumberWidth));
				}
				return { model: modelOut, display: displayOut };
			};

			if (isDirectory) {
				const grouped = formatGroupedFiles(fileList, relativePath => {
					const rendered = renderChangesForFile(relativePath);
					const count = fileReplacementCounts.get(relativePath) ?? 0;
					return {
						headerSuffix: ` (${formatCount("replacement", count)})`,
						modelLines: rendered.model,
						displayLines: rendered.display,
					};
				});
				outputLines.push(...grouped.model);
				displayLines.push(...grouped.display);
			} else {
				for (const relativePath of fileList) {
					const rendered = renderChangesForFile(relativePath);
					outputLines.push(...rendered.model);
					displayLines.push(...rendered.display);
				}
			}

			const fileReplacements = fileList.map(filePath => ({
				path: filePath,
				count: fileReplacementCounts.get(filePath) ?? 0,
			}));
			if (result.limitReached) {
				outputLines.push("", "Limit reached; narrow path.");
			}
			if (dedupedParseErrors.length) {
				outputLines.push("", ...formatParseErrors(dedupedParseErrors));
			}

			// Register pending action so `resolve` can apply or discard these previewed changes
			if (!result.applied && result.totalReplacements > 0) {
				const previewReplacementPlural = result.totalReplacements !== 1 ? "s" : "";
				const previewFilePlural = result.filesTouched !== 1 ? "s" : "";
				queueResolveHandler(this.session, {
					label: `AST Edit: ${result.totalReplacements} replacement${previewReplacementPlural} in ${result.filesTouched} file${previewFilePlural}`,
					sourceToolName: this.name,
					apply: async (_reason: string) => {
						const applyResult = await astEdit({
							rewrites: normalizedRewrites,
							path: resolvedSearchPath,
							glob: globFilter,
							dryRun: false,
							maxFiles,
							failOnParseError: false,
						});
						const dedupedApplyParseErrors = dedupeParseErrors(applyResult.parseErrors);
						const { record: recordAppliedFile, list: appliedFileList } = createFileRecorder();
						const appliedFileReplacementCounts = new Map<string, number>();
						for (const fileChange of applyResult.fileChanges) {
							const relativePath = formatPath(fileChange.path);
							recordAppliedFile(relativePath);
							appliedFileReplacementCounts.set(
								relativePath,
								(appliedFileReplacementCounts.get(relativePath) ?? 0) + fileChange.count,
							);
						}
						for (const change of applyResult.changes) {
							recordAppliedFile(formatPath(change.path));
						}
						const appliedFileReplacements = appliedFileList.map(filePath => ({
							path: filePath,
							count: appliedFileReplacementCounts.get(filePath) ?? 0,
						}));
						const appliedDetails: AstEditToolDetails = {
							totalReplacements: applyResult.totalReplacements,
							filesTouched: applyResult.filesTouched,
							filesSearched: applyResult.filesSearched,
							applied: applyResult.applied,
							limitReached: applyResult.limitReached,
							...(dedupedApplyParseErrors.length > 0 ? { parseErrors: dedupedApplyParseErrors } : {}),
							scopePath,
							files: appliedFileList,
							fileReplacements: appliedFileReplacements,
						};
						const stalePreview =
							applyResult.totalReplacements !== result.totalReplacements ||
							applyResult.filesTouched !== result.filesTouched ||
							fileList.some(
								filePath => appliedFileReplacementCounts.get(filePath) !== fileReplacementCounts.get(filePath),
							) ||
							appliedFileList.some(
								filePath => fileReplacementCounts.get(filePath) !== appliedFileReplacementCounts.get(filePath),
							);
						if (stalePreview) {
							const text =
								applyResult.totalReplacements === 0
									? `Preview is stale / no longer matches; no replacements were applied. Preview expected ${result.totalReplacements} replacement${previewReplacementPlural} in ${result.filesTouched} file${previewFilePlural}.`
									: applyResult.totalReplacements < result.totalReplacements
										? `Preview is stale / no longer matches; only ${applyResult.totalReplacements} of ${result.totalReplacements} replacements were applied in ${applyResult.filesTouched} of ${result.filesTouched} files.`
										: `Preview is stale / no longer matches; applied ${applyResult.totalReplacements} replacements but preview expected ${result.totalReplacements}.`;
							return { ...toolResult(appliedDetails).text(text).done(), isError: true };
						}
						const appliedReplacementPlural = applyResult.totalReplacements !== 1 ? "s" : "";
						const appliedFilePlural = applyResult.filesTouched !== 1 ? "s" : "";
						const text = `Applied ${applyResult.totalReplacements} replacement${appliedReplacementPlural} in ${applyResult.filesTouched} file${appliedFilePlural}.`;
						return toolResult(appliedDetails).text(text).done();
					},
				});
			}

			const details: AstEditToolDetails = {
				...baseDetails,
				fileReplacements,
				displayContent: displayLines.join("\n"),
			};
			return toolResult(details).text(outputLines.join("\n")).done();
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface AstEditRenderArgs {
	ops?: Array<{ pat?: string; out?: string }>;
	path?: string;
}

const COLLAPSED_CHANGE_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

export const astEditToolRenderer = {
	inline: true,
	renderCall(args: AstEditRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.path) meta.push(`in ${args.path}`);
		const rewriteCount = args.ops?.length ?? 0;
		if (rewriteCount > 1) meta.push(`${rewriteCount} rewrites`);

		const description = rewriteCount === 1 ? args.ops?.[0]?.pat : rewriteCount ? `${rewriteCount} rewrites` : "?";
		const text = renderStatusLine({ icon: "pending", title: "AST Edit", description, meta }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AstEditToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: AstEditRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const totalReplacements = details?.totalReplacements ?? 0;
		const filesTouched = details?.filesTouched ?? 0;
		const filesSearched = details?.filesSearched ?? 0;
		const limitReached = details?.limitReached ?? false;

		if (totalReplacements === 0) {
			const rewriteCount = args?.ops?.length ?? 0;
			const description = rewriteCount === 1 ? args?.ops?.[0]?.pat : undefined;
			const meta = ["0 replacements"];
			if (details?.scopePath) meta.push(`in ${details.scopePath}`);
			if (filesSearched > 0) meta.push(`searched ${filesSearched}`);
			const header = renderStatusLine({ icon: "warning", title: "AST Edit", description, meta }, uiTheme);
			const lines = [header, formatEmptyMessage("No replacements made", uiTheme)];
			if (details?.parseErrors?.length) {
				const capped = details.parseErrors.slice(0, PARSE_ERRORS_LIMIT);
				for (const err of capped) {
					lines.push(uiTheme.fg("warning", `  - ${err}`));
				}
				if (details.parseErrors.length > PARSE_ERRORS_LIMIT) {
					lines.push(uiTheme.fg("dim", `  … ${details.parseErrors.length - PARSE_ERRORS_LIMIT} more`));
				}
			}
			return new Text(lines.join("\n"), 0, 0);
		}

		const summaryParts = [formatCount("replacement", totalReplacements), formatCount("file", filesTouched)];
		const meta = [...summaryParts];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		meta.push(`searched ${filesSearched}`);
		if (limitReached) meta.push(uiTheme.fg("warning", "limit reached"));
		const rewriteCount = args?.ops?.length ?? 0;
		const description = rewriteCount === 1 ? args?.ops?.[0]?.pat : undefined;

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const rawLines = textContent.split("\n");
		const hasSeparators = rawLines.some(line => line.trim().length === 0);
		const allGroups: string[][] = [];
		if (hasSeparators) {
			let current: string[] = [];
			for (const line of rawLines) {
				if (line.trim().length === 0) {
					if (current.length > 0) {
						allGroups.push(current);
						current = [];
					}
					continue;
				}
				current.push(line);
			}
			if (current.length > 0) allGroups.push(current);
		} else {
			const nonEmpty = rawLines.filter(line => line.trim().length > 0);
			if (nonEmpty.length > 0) {
				allGroups.push(nonEmpty);
			}
		}
		const changeGroups = allGroups.filter(
			group => !group[0]?.startsWith("Safety cap reached") && !group[0]?.startsWith("Parse issues:"),
		);

		const badge = { label: "proposed", color: "warning" as const };
		const header = renderStatusLine(
			{ icon: limitReached ? "warning" : "success", title: "AST Edit", description, badge, meta },
			uiTheme,
		);

		const extraLines: string[] = [];
		if (limitReached) {
			extraLines.push(uiTheme.fg("warning", "limit reached; narrow path"));
		}
		if (details?.parseErrors?.length) {
			const total = details.parseErrors.length;
			const label =
				total > PARSE_ERRORS_LIMIT
					? `${PARSE_ERRORS_LIMIT} / ${total} parse issues`
					: `${total} parse issue${total !== 1 ? "s" : ""}`;
			extraLines.push(uiTheme.fg("warning", label));
		}
		let cached: RenderCache | undefined;
		return {
			render(width: number): string[] {
				const { expanded } = options;
				const key = new Hasher().bool(expanded).u32(width).digest();
				if (cached?.key === key) return cached.lines;
				const changeLines = renderTreeList(
					{
						items: changeGroups,
						expanded,
						maxCollapsed: changeGroups.length,
						maxCollapsedLines: COLLAPSED_CHANGE_LIMIT,
						itemType: "change",
						renderItem: group =>
							group.map(line => {
								if (line.startsWith("## ")) return uiTheme.fg("dim", line);
								if (line.startsWith("# ")) return uiTheme.fg("accent", line);
								if (line.startsWith("+")) return uiTheme.fg("toolDiffAdded", line);
								if (line.startsWith("-")) return uiTheme.fg("toolDiffRemoved", line);
								return uiTheme.fg("toolOutput", line);
							}),
					},
					uiTheme,
				);
				const rendered = [header, ...changeLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				cached = { key, lines: rendered };
				return rendered;
			},
			invalidate() {
				cached = undefined;
			},
		};
	},
	mergeCallAndResult: true,
};
