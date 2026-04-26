import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type AstFindMatch, astGrep } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import astGrepDescription from "../prompts/tools/ast-grep.md" with { type: "text" };
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { createFileRecorder, formatResultPath } from "./file-recorder";
import { formatMatchLine } from "./match-line-format";
import type { OutputMeta } from "./output-meta";
import {
	combineSearchGlobs,
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
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const astGrepSchema = Type.Object({
	pat: Type.Array(Type.String(), {
		minItems: 1,
		description: "ast patterns",
		examples: [["console.log($$$)"]],
	}),
	lang: Type.Optional(Type.String({ description: "language override", examples: ["typescript", "python"] })),
	path: Type.Optional(
		Type.String({
			description: "path or glob to search",
			examples: ["src/", "src/foo.ts"],
		}),
	),
	glob: Type.Optional(Type.String({ description: "glob filter", examples: ["**/*.ts"] })),
	sel: Type.Optional(
		Type.String({
			description: "contextual pattern selector",
			examples: ["function_declaration", "call_expression", "identifier"],
		}),
	),
	limit: Type.Optional(Type.Number({ description: "max matches", default: 50 })),
	offset: Type.Optional(Type.Number({ description: "skip first n matches", default: 0 })),
	context: Type.Optional(Type.Number({ description: "context lines" })),
});

export interface AstGrepToolDetails {
	matchCount: number;
	fileCount: number;
	filesSearched: number;
	limitReached: boolean;
	parseErrors?: string[];
	scopePath?: string;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	meta?: OutputMeta;
	/** Pre-formatted text for the user-visible TUI render. Mirrors `result.text` lines but uses
	 * a `│` gutter and `*` to mark match lines. The TUI uses this directly so it never parses model-facing text. */
	displayContent?: string;
}

export class AstGrepTool implements AgentTool<typeof astGrepSchema, AstGrepToolDetails> {
	readonly name = "ast_grep";
	readonly label = "AST Grep";
	readonly description: string;
	readonly parameters = astGrepSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(astGrepDescription);
	}

	async execute(
		_toolCallId: string,
		params: Static<typeof astGrepSchema>,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AstGrepToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AstGrepToolDetails>> {
		return untilAborted(signal, async () => {
			const patterns = [...new Set(params.pat.map(pattern => pattern.trim()).filter(pattern => pattern.length > 0))];
			if (patterns.length === 0) {
				throw new ToolError("`pat` must include at least one non-empty pattern");
			}
			const limit = params.limit === undefined ? 50 : Math.floor(params.limit);
			if (!Number.isFinite(limit) || limit < 1) {
				throw new ToolError("Limit must be a positive number");
			}
			const offset = params.offset === undefined ? 0 : Math.floor(params.offset);
			if (!Number.isFinite(offset) || offset < 0) {
				throw new ToolError("Offset must be a non-negative number");
			}
			const context = params.context === undefined ? undefined : Math.floor(params.context);
			if (context !== undefined && (!Number.isFinite(context) || context < 0)) {
				throw new ToolError("Context must be a non-negative number");
			}

			const formatScopePath = (targetPath: string): string => {
				const relative = path.relative(this.session.cwd, targetPath).replace(/\\/g, "/");
				return relative.length === 0 ? "." : relative;
			};
			let searchPath: string | undefined;
			let scopePath: string | undefined;
			let globFilter = params.glob ? normalizePathLikeInput(params.glob) || undefined : undefined;
			const rawPath = params.path ? normalizePathLikeInput(params.path) || undefined : undefined;
			if (rawPath) {
				const internalRouter = this.session.internalRouter;
				if (internalRouter?.canHandle(rawPath)) {
					if (hasGlobPathChars(rawPath)) {
						throw new ToolError(`Glob patterns are not supported for internal URLs: ${rawPath}`);
					}
					const resource = await internalRouter.resolve(rawPath);
					if (!resource.sourcePath) {
						throw new ToolError(`Cannot search internal URL without backing file: ${rawPath}`);
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
						globFilter = combineSearchGlobs(parsedPath.glob, globFilter);
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

			const result = await astGrep({
				patterns,
				lang: params.lang?.trim(),
				path: resolvedSearchPath,
				glob: globFilter,
				selector: params.sel?.trim(),
				limit,
				offset,
				context,
				includeMeta: true,
				signal,
			});

			const normalizedParseErrors = (result.parseErrors ?? []).map(error => {
				const parseError = error.match(/^.+: (.+: parse error \(syntax tree contains error nodes\))$/);
				return parseError?.[1] ?? error;
			});
			const dedupedParseErrors = dedupeParseErrors(normalizedParseErrors);
			const formatPath = (filePath: string): string => formatResultPath(filePath, isDirectory);

			const { record: recordFile, list: fileList } = createFileRecorder();
			const fileMatchCounts = new Map<string, number>();
			const matchesByFile = new Map<string, AstFindMatch[]>();
			for (const match of result.matches) {
				const relativePath = formatPath(match.path);
				recordFile(relativePath);
				if (!matchesByFile.has(relativePath)) {
					matchesByFile.set(relativePath, []);
				}
				matchesByFile.get(relativePath)!.push(match);
			}

			const baseDetails: AstGrepToolDetails = {
				matchCount: result.totalMatches,
				fileCount: result.filesWithMatches,
				filesSearched: result.filesSearched,
				limitReached: result.limitReached,
				...(dedupedParseErrors.length > 0 ? { parseErrors: dedupedParseErrors } : {}),
				scopePath,
				files: fileList,
				fileMatches: [],
			};

			if (result.matches.length === 0) {
				const noMatchMessage = dedupedParseErrors.length
					? "No matches found. Parse issues mean the query may be mis-scoped; narrow `path`/`glob` or set `lang` before concluding absence."
					: "No matches found";
				const parseMessage = dedupedParseErrors.length
					? `\n${formatParseErrors(dedupedParseErrors).join("\n")}`
					: "";
				return toolResult(baseDetails).text(`${noMatchMessage}${parseMessage}`).done();
			}

			const useHashLines = resolveFileDisplayMode(this.session).hashLines;
			const outputLines: string[] = [];
			const displayLines: string[] = [];
			const renderMatchesForFile = (relativePath: string) => {
				const fileMatches = matchesByFile.get(relativePath) ?? [];
				const lineNumberWidth = fileMatches.reduce((width, match) => {
					const lineCount = match.text.split("\n").length;
					const endLine = match.startLine + lineCount - 1;
					return Math.max(width, String(match.startLine).length, String(endLine).length);
				}, 0);
				for (const match of fileMatches) {
					const matchLines = match.text.split("\n");
					for (let index = 0; index < matchLines.length; index++) {
						const lineNumber = match.startLine + index;
						const isMatch = index === 0;
						const line = matchLines[index] ?? "";
						outputLines.push(formatMatchLine(lineNumber, line, isMatch, { useHashLines }));
						displayLines.push(formatCodeFrameLine(isMatch ? "*" : " ", lineNumber, line, lineNumberWidth));
					}
					if (match.metaVariables && Object.keys(match.metaVariables).length > 0) {
						const serializedMeta = Object.entries(match.metaVariables)
							.sort(([left], [right]) => left.localeCompare(right))
							.map(([key, value]) => `${key}=${value}`)
							.join(", ");
						outputLines.push(`  meta: ${serializedMeta}`);
						displayLines.push(`  meta: ${serializedMeta}`);
					}
					fileMatchCounts.set(relativePath, (fileMatchCounts.get(relativePath) ?? 0) + 1);
				}
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
							if (outputLines.length > 0) {
								outputLines.push("");
								displayLines.push("");
							}
							const header = `# ${path.basename(relativePath)}`;
							outputLines.push(header);
							displayLines.push(header);
							renderMatchesForFile(relativePath);
						}
						continue;
					}
					if (outputLines.length > 0) {
						outputLines.push("");
						displayLines.push("");
					}
					const dirHeader = `# ${directory}`;
					outputLines.push(dirHeader);
					displayLines.push(dirHeader);
					for (const relativePath of directoryFiles) {
						const fileHeader = `## └─ ${path.basename(relativePath)}`;
						outputLines.push(fileHeader);
						displayLines.push(fileHeader);
						renderMatchesForFile(relativePath);
					}
				}
			} else {
				for (const relativePath of fileList) {
					renderMatchesForFile(relativePath);
				}
			}

			const details: AstGrepToolDetails = {
				...baseDetails,
				fileMatches: fileList.map(filePath => ({
					path: filePath,
					count: fileMatchCounts.get(filePath) ?? 0,
				})),
				displayContent: displayLines.join("\n"),
			};
			if (result.limitReached) {
				outputLines.push("", "Result limit reached; narrow path pattern or increase limit.");
			}
			if (dedupedParseErrors.length) {
				outputLines.push("", ...formatParseErrors(dedupedParseErrors));
			}

			return toolResult(details).text(outputLines.join("\n")).done();
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface AstGrepRenderArgs {
	pat?: string[];
	lang?: string;
	path?: string;
	sel?: string;
	limit?: number;
	offset?: number;
	context?: number;
}

const COLLAPSED_MATCH_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

export const astGrepToolRenderer = {
	inline: true,
	renderCall(args: AstGrepRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.lang) meta.push(`lang:${args.lang}`);
		if (args.path) meta.push(`in ${args.path}`);
		if (args.sel) meta.push("selector");
		if (args.limit !== undefined && args.limit > 0) meta.push(`limit:${args.limit}`);
		if (args.offset !== undefined && args.offset > 0) meta.push(`offset:${args.offset}`);
		if (args.context !== undefined) meta.push(`context:${args.context}`);
		if (args.pat && args.pat.length > 1) meta.push(`${args.pat.length} patterns`);

		const description = args.pat?.length === 1 ? args.pat[0] : args.pat ? `${args.pat.length} patterns` : "?";
		const text = renderStatusLine({ icon: "pending", title: "AST Grep", description, meta }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AstGrepToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: AstGrepRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const filesSearched = details?.filesSearched ?? 0;
		const limitReached = details?.limitReached ?? false;

		if (matchCount === 0) {
			const description = args?.pat?.length === 1 ? args.pat[0] : undefined;
			const meta = ["0 matches"];
			if (details?.scopePath) meta.push(`in ${details.scopePath}`);
			if (filesSearched > 0) meta.push(`searched ${filesSearched}`);
			const header = renderStatusLine({ icon: "warning", title: "AST Grep", description, meta }, uiTheme);
			const lines = [header, formatEmptyMessage("No matches found", uiTheme)];
			if (details?.parseErrors?.length) {
				lines.push(
					uiTheme.fg(
						"warning",
						"Query may be mis-scoped; narrow `path`/`glob` or set `lang` before concluding absence",
					),
				);
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

		const summaryParts = [formatCount("match", matchCount), formatCount("file", fileCount)];
		const meta = [...summaryParts];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		meta.push(`searched ${filesSearched}`);
		if (limitReached) meta.push(uiTheme.fg("warning", "limit reached"));
		const description = args?.pat?.length === 1 ? args.pat[0] : undefined;
		const header = renderStatusLine(
			{ icon: limitReached ? "warning" : "success", title: "AST Grep", description, meta },
			uiTheme,
		);

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
		const matchGroups = allGroups.filter(
			group => !group[0]?.startsWith("Result limit reached") && !group[0]?.startsWith("Parse issues:"),
		);

		const extraLines: string[] = [];
		if (limitReached) {
			extraLines.push(uiTheme.fg("warning", "limit reached; narrow path pattern or increase limit"));
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
				const matchLines = renderTreeList(
					{
						items: matchGroups,
						expanded,
						maxCollapsed: matchGroups.length,
						maxCollapsedLines: COLLAPSED_MATCH_LIMIT,
						itemType: "match",
						renderItem: group =>
							group.map(line => {
								if (line.startsWith("## ")) return uiTheme.fg("dim", line);
								if (line.startsWith("# ")) return uiTheme.fg("accent", line);
								if (line.startsWith("  meta:")) return uiTheme.fg("dim", line);
								return uiTheme.fg("toolOutput", line);
							}),
					},
					uiTheme,
				);
				const rendered = [header, ...matchLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
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
