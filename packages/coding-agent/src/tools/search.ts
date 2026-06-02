import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { formatHashlineHeader } from "@oh-my-pi/hashline";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type GrepMatch, GrepOutputMode, type GrepResult, grep } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import { recordFileSnapshot } from "../edit/file-snapshot-store";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { LocalProtocolOptions } from "../internal-urls/local-protocol";
import { InternalUrlRouter } from "../internal-urls/router";
import type { InternalResource, ResolveContext } from "../internal-urls/types";
import type { Theme } from "../modes/theme/theme";
import searchDescription from "../prompts/tools/search.md" with { type: "text" };
import { DEFAULT_MAX_COLUMN, type TruncationResult, truncateHead, truncateLine } from "../session/streaming-output";
import { Ellipsis, fileHyperlink, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import {
	type ArchiveReader,
	type ExtractedArchiveFile,
	openArchive,
	parseArchivePathCandidates,
} from "./archive-reader";
import { createFileRecorder, formatResultPath } from "./file-recorder";
import { formatGroupedFiles } from "./grouped-file-output";
import { formatMatchLine } from "./match-line-format";
import { formatFullOutputReference, type OutputMeta } from "./output-meta";
import {
	expandDelimitedPathEntries,
	hasGlobPathChars,
	isLineInRanges,
	type LineRange,
	parseLineRanges,
	type ResolvedSearchTarget,
	resolveReadPath,
	resolveToolSearchScope,
	splitPathAndSel,
} from "./path-utils";
import {
	createCachedComponent,
	formatCodeFrameLine,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	PREVIEW_LIMITS,
	splitGroupsByBlankLine,
} from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const searchPathEntrySchema = z
	.string()
	.describe(
		'file, directory, glob, internal URL, or "<file>:<lines>" selector (e.g. "src/foo.ts:50-100", "src/foo.ts:50+10", "src/foo.ts:50-100,200-300")',
	);
const searchSchema = z
	.object({
		pattern: z.string().describe("regex pattern"),
		paths: z
			.union([searchPathEntrySchema, z.array(searchPathEntrySchema).min(1)])
			.describe(
				"file, directory, glob, internal URL, or array of those to search; append `:<lines>` to scope a file to specific line ranges",
			),
		i: z.boolean().optional().describe("case-insensitive search"),
		gitignore: z.boolean().optional().describe("respect gitignore"),
		skip: z
			.number()
			.optional()
			.describe("files to skip before collecting results — use to paginate when the prior call hit the file limit"),
	})
	.strict();

export type SearchToolInput = z.infer<typeof searchSchema>;
export function toPathList(input: string | string[] | undefined): string[] {
	return typeof input === "string" ? [input] : (input ?? []);
}

/** Maximum number of distinct files surfaced in a single response. The
 * agent paginates further pages via `skip`. */
export const DEFAULT_FILE_LIMIT = 20;
/** Per-file match cap for multi-file searches — keeps a single hot file
 * from crowding out diverse hits. Applied in JS after grep returns. */
export const MULTI_FILE_PER_FILE_MATCHES = 20;
/** Per-file match cap for single-file searches — there's no diversity
 * concern when the scope is one file. */
export const SINGLE_FILE_MATCHES = 200;
/** Hard safety ceiling on how many matches we fetch from native grep
 * before JS-side grouping. Sized to comfortably cover the file window
 * (DEFAULT_FILE_LIMIT files × MULTI_FILE_PER_FILE_MATCHES matches) plus
 * pagination headroom so the caller can see total file count. */
const INTERNAL_TOTAL_CAP = 2000;

/**
 * Parsed `paths` entry — a path (possibly archive-shaped) plus an optional
 * line-range selector peeled off the trailing `:N-M` (or `:N+K`, `:N,M`, …)
 * chunk via {@link splitPathAndSel}.
 */
interface SearchPathSpec {
	original: string;
	clean: string;
	ranges?: [LineRange, ...LineRange[]];
}

function parsePathSpecs(rawEntries: readonly string[]): SearchPathSpec[] {
	const specs: SearchPathSpec[] = [];
	for (const entry of rawEntries) {
		const split = splitPathAndSel(entry);
		let clean = entry;
		let ranges: [LineRange, ...LineRange[]] | undefined;
		if (split.sel) {
			const parsed = parseLineRanges(split.sel);
			if (!parsed) {
				throw new ToolError(
					`paths entry "${entry}" — only line-range selectors like ":50-100" are supported (no ":raw"/":conflicts")`,
				);
			}
			if (hasGlobPathChars(split.path)) {
				throw new ToolError(`Line-range selector requires a single file, not a glob: ${entry}`);
			}
			clean = split.path;
			ranges = parsed;
		}
		specs.push({ original: entry, clean, ranges });
	}
	return specs;
}

function mergeRangesInto(map: Map<string, LineRange[]>, absKey: string, ranges: readonly LineRange[]): void {
	// Concat-without-merge is correct: `isLineInRanges` scans linearly, so
	// duplicates/overlaps only cost a few extra comparisons per match.
	const existing = map.get(absKey);
	if (existing) {
		existing.push(...ranges);
	} else {
		map.set(absKey, [...ranges]);
	}
}

function matchAbsolutePath(matchPath: string, searchPath: string): string {
	if (matchPath === "") return searchPath;
	if (path.isAbsolute(matchPath)) return matchPath;
	return path.resolve(searchPath, matchPath);
}

/**
 * Pre-resolve any `paths` entries that point at a member inside an archive
 * (e.g. `bundle.zip:src/foo.ts`, `release.tar.gz:notes.md`). Native grep
 * cannot read archive members, so we materialize each text member to a
 * temp scratch file and substitute that path into the search inputs. After
 * grep returns, callers remap `match.path` back to the original
 * `archive:member` selector so it round-trips through the `read` tool.
 *
 * Returns the rewritten paths array (same length/order as input), a map
 * from absolute scratch path → original selector, a list of entries we
 * could not materialize (binary member, missing archive, etc.), and a
 * cleanup hook the caller MUST invoke in a `finally`.
 */
async function resolveArchiveSearchPaths(
	paths: string[],
	cwd: string,
): Promise<{
	resolvedPaths: string[];
	displayMap: Map<string, string>;
	displaySet: Set<string>;
	unreadable: string[];
	cleanup: () => Promise<void>;
}> {
	const resolvedPaths = paths.slice();
	const displayMap = new Map<string, string>();
	const displaySet = new Set<string>();
	const unreadable: string[] = [];
	let tempDir: string | undefined;
	const archiveCache = new Map<string, ArchiveReader>();

	for (let idx = 0; idx < paths.length; idx++) {
		const entry = paths[idx];
		const candidates = parseArchivePathCandidates(entry);
		// Longest archive prefix first; we want the one whose member portion is non-empty.
		const member = candidates.find(c => c.subPath !== "" && c.archivePath !== entry);
		if (!member) continue;

		const archiveAbs = resolveReadPath(member.archivePath, cwd);
		let archive = archiveCache.get(archiveAbs);
		if (!archive) {
			try {
				archive = await openArchive(archiveAbs);
			} catch (err) {
				unreadable.push(`${entry} (cannot open archive: ${(err as Error).message})`);
				continue;
			}
			archiveCache.set(archiveAbs, archive);
		}

		let extracted: ExtractedArchiveFile;
		try {
			extracted = await archive.readFile(member.subPath);
		} catch (err) {
			unreadable.push(`${entry} (${(err as Error).message})`);
			continue;
		}
		// UTF-8 only — binary members would just produce noise through ripgrep.
		if (extracted.bytes.some(byte => byte === 0)) {
			unreadable.push(`${entry} (binary archive entry)`);
			continue;
		}
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(extracted.bytes);
		} catch {
			unreadable.push(`${entry} (non-UTF-8 archive entry)`);
			continue;
		}

		if (!tempDir) {
			tempDir = await mkdtemp(path.join(tmpdir(), "omp-search-archive-"));
		}
		// Per-entry filename keeps the scratch path unique even when two selectors
		// resolve to members with the same basename.
		const safeBase = path.basename(member.subPath).replace(/[^\w.-]+/g, "_") || "entry";
		const tempPath = path.join(tempDir, `${idx}-${safeBase}`);
		await writeFile(tempPath, text);
		resolvedPaths[idx] = tempPath;
		displayMap.set(tempPath, entry);
		displaySet.add(entry);
	}

	const cleanup = async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}
	};
	return { resolvedPaths, displayMap, displaySet, unreadable, cleanup };
}

interface VirtualSearchResource {
	path: string;
	content: string;
	ranges?: readonly LineRange[];
}

interface InternalSearchInputResolution {
	paths: string[];
	resolvedPathsByInput: string[];
	virtualResources: VirtualSearchResource[];
	virtualPathSet: Set<string>;
	virtualInputIndexes: Set<number>;
	immutableSourcePaths: Set<string>;
	virtualScopePath?: string;
}

interface IndexedContentLines {
	lines: string[];
	starts: number[];
}

const INTERNAL_URL_DISPLAY_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const OMP_ROOT_URL_RE = /^omp:\/\/\/?$/i;

function normalizeSearchLine(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function splitSearchLines(content: string): string[] {
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines.map(normalizeSearchLine);
}

function indexSearchLines(content: string): IndexedContentLines {
	const rawLines = content.split("\n");
	if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
		rawLines.pop();
	}
	const lines: string[] = [];
	const starts: number[] = [];
	let offset = 0;
	for (const rawLine of rawLines) {
		starts.push(offset);
		lines.push(normalizeSearchLine(rawLine));
		offset += rawLine.length + 1;
	}
	return { lines, starts };
}

function findLineIndex(starts: readonly number[], offset: number): number {
	if (starts.length === 0) return -1;
	let low = 0;
	let high = starts.length - 1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		if (starts[mid] <= offset) {
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return Math.max(0, high);
}

function lineAllowed(lineNumber: number, ranges: readonly LineRange[] | undefined): boolean {
	return !ranges || isLineInRanges(lineNumber, ranges);
}

function makeContextLine(lines: readonly string[], lineIndex: number): { lineNumber: number; line: string } {
	const { text } = truncateLine(lines[lineIndex] ?? "", DEFAULT_MAX_COLUMN);
	return { lineNumber: lineIndex + 1, line: text };
}

function makeVirtualMatch(
	resource: VirtualSearchResource,
	lines: readonly string[],
	lineIndex: number,
	contextBefore: number,
	contextAfter: number,
): GrepMatch {
	const lineNumber = lineIndex + 1;
	const { text, wasTruncated } = truncateLine(lines[lineIndex] ?? "", DEFAULT_MAX_COLUMN);
	const match: GrepMatch = {
		path: resource.path,
		lineNumber,
		line: text,
	};
	if (wasTruncated) match.truncated = true;

	if (contextBefore > 0) {
		const before: NonNullable<GrepMatch["contextBefore"]> = [];
		const start = Math.max(0, lineIndex - contextBefore);
		for (let idx = start; idx < lineIndex; idx++) {
			const contextLineNumber = idx + 1;
			if (lineAllowed(contextLineNumber, resource.ranges)) {
				before.push(makeContextLine(lines, idx));
			}
		}
		if (before.length > 0) match.contextBefore = before;
	}

	if (contextAfter > 0) {
		const after: NonNullable<GrepMatch["contextAfter"]> = [];
		const end = Math.min(lines.length - 1, lineIndex + contextAfter);
		for (let idx = lineIndex + 1; idx <= end; idx++) {
			const contextLineNumber = idx + 1;
			if (lineAllowed(contextLineNumber, resource.ranges)) {
				after.push(makeContextLine(lines, idx));
			}
		}
		if (after.length > 0) match.contextAfter = after;
	}

	return match;
}

function compileVirtualRegex(pattern: string, ignoreCase: boolean, multiline: boolean): RegExp {
	const flags = `${ignoreCase ? "i" : ""}${multiline ? "gm" : ""}`;
	try {
		return new RegExp(pattern, flags);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ToolError(`Invalid regex: ${message.replace(/^Invalid regular expression:\s*/i, "")}`);
	}
}

function searchVirtualResourceLines(
	resource: VirtualSearchResource,
	regex: RegExp,
	contextBefore: number,
	contextAfter: number,
	maxCount: number,
): { matches: GrepMatch[]; totalMatches: number; limitReached: boolean } {
	const lines = splitSearchLines(resource.content);
	const matches: GrepMatch[] = [];
	let totalMatches = 0;
	let limitReached = false;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const lineNumber = lineIndex + 1;
		if (!lineAllowed(lineNumber, resource.ranges)) continue;
		regex.lastIndex = 0;
		if (!regex.test(lines[lineIndex] ?? "")) continue;
		totalMatches++;
		if (matches.length >= maxCount) {
			limitReached = true;
			continue;
		}
		matches.push(makeVirtualMatch(resource, lines, lineIndex, contextBefore, contextAfter));
	}

	return { matches, totalMatches, limitReached };
}

function searchVirtualResourceMultiline(
	resource: VirtualSearchResource,
	regex: RegExp,
	contextBefore: number,
	contextAfter: number,
	maxCount: number,
): { matches: GrepMatch[]; totalMatches: number; limitReached: boolean } {
	const indexed = indexSearchLines(resource.content);
	const matches: GrepMatch[] = [];
	const matchedLines = new Set<number>();
	let totalMatches = 0;
	let limitReached = false;

	while (true) {
		const match = regex.exec(resource.content);
		if (match === null) break;
		const lineIndex = findLineIndex(indexed.starts, match.index);
		if (lineIndex >= 0) {
			const lineNumber = lineIndex + 1;
			if (!matchedLines.has(lineNumber) && lineAllowed(lineNumber, resource.ranges)) {
				matchedLines.add(lineNumber);
				totalMatches++;
				if (matches.length >= maxCount) {
					limitReached = true;
				} else {
					matches.push(makeVirtualMatch(resource, indexed.lines, lineIndex, contextBefore, contextAfter));
				}
			}
		}
		if (match[0].length === 0) {
			regex.lastIndex++;
		}
	}

	return { matches, totalMatches, limitReached };
}

function searchVirtualResources(
	resources: readonly VirtualSearchResource[],
	pattern: string,
	ignoreCase: boolean,
	multiline: boolean,
	contextBefore: number,
	contextAfter: number,
	maxCount: number,
): GrepResult {
	if (resources.length === 0) {
		return { matches: [], totalMatches: 0, filesWithMatches: 0, filesSearched: 0, limitReached: false };
	}
	const regex = compileVirtualRegex(pattern, ignoreCase, multiline);
	const matches: GrepMatch[] = [];
	const filesWithMatches = new Set<string>();
	let totalMatches = 0;
	let limitReached = false;

	for (const resource of resources) {
		const remaining = Math.max(maxCount - matches.length, 0);
		const resourceResult = multiline
			? searchVirtualResourceMultiline(resource, regex, contextBefore, contextAfter, remaining)
			: searchVirtualResourceLines(resource, regex, contextBefore, contextAfter, remaining);
		if (resourceResult.totalMatches > 0) {
			filesWithMatches.add(resource.path);
		}
		totalMatches += resourceResult.totalMatches;
		limitReached = limitReached || resourceResult.limitReached;
		matches.push(...resourceResult.matches);
	}

	return {
		matches,
		totalMatches,
		filesWithMatches: filesWithMatches.size,
		filesSearched: resources.length,
		limitReached,
	};
}

function mergeGrepResults(left: GrepResult, right: GrepResult, maxCount: number): GrepResult {
	if (left.matches.length === 0) return right;
	if (right.matches.length === 0) return left;
	const combinedMatches = [...left.matches, ...right.matches];
	const matches = combinedMatches.length > maxCount ? combinedMatches.slice(0, maxCount) : combinedMatches;
	return {
		matches,
		totalMatches: left.totalMatches + right.totalMatches,
		filesWithMatches: new Set(matches.map(match => match.path)).size,
		filesSearched: left.filesSearched + right.filesSearched,
		limitReached: left.limitReached || right.limitReached || matches.length < combinedMatches.length,
	};
}

async function expandVirtualInternalResource(
	rawPath: string,
	resource: InternalResource,
	internalRouter: InternalUrlRouter,
	context: ResolveContext,
	ranges: readonly LineRange[] | undefined,
): Promise<VirtualSearchResource[]> {
	if (OMP_ROOT_URL_RE.test(rawPath)) {
		const completions = await internalRouter.complete("omp", "");
		if (completions && completions.length > 0) {
			const resources: VirtualSearchResource[] = [];
			const seen = new Set<string>();
			for (const completion of completions) {
				if (seen.has(completion.value)) continue;
				seen.add(completion.value);
				const docUrl = `omp://${completion.value}`;
				const doc = await internalRouter.resolve(docUrl, context);
				if (!doc.sourcePath) {
					resources.push({ path: docUrl, content: doc.content, ranges });
				}
			}
			if (resources.length > 0) return resources;
		}
	}

	return [{ path: rawPath, content: resource.content, ranges }];
}

async function resolveInternalSearchInputs(opts: {
	pathSpecs: readonly SearchPathSpec[];
	resolvedPaths: string[];
	cwd: string;
	settings: unknown;
	signal?: AbortSignal;
	archiveDisplayMap: ReadonlyMap<string, string>;
	localProtocolOptions?: LocalProtocolOptions;
}): Promise<InternalSearchInputResolution> {
	const internalRouter = InternalUrlRouter.instance();
	const paths = opts.resolvedPaths.slice();
	const virtualResources: VirtualSearchResource[] = [];
	const virtualPathSet = new Set<string>();
	const virtualInputIndexes = new Set<number>();
	const immutableSourcePaths = new Set<string>();
	let virtualScopePath: string | undefined;
	const context: ResolveContext = {
		cwd: opts.cwd,
		settings: opts.settings,
		signal: opts.signal,
		localProtocolOptions: opts.localProtocolOptions,
	};

	for (let idx = 0; idx < paths.length; idx++) {
		const rawPath = paths[idx];
		if (!rawPath || opts.archiveDisplayMap.has(rawPath) || !internalRouter.canHandle(rawPath)) {
			continue;
		}
		if (hasGlobPathChars(rawPath)) {
			throw new ToolError(`Glob patterns are not supported for internal URLs: ${rawPath}`);
		}
		const resource = await internalRouter.resolve(rawPath, context);
		if (resource.sourcePath) {
			paths[idx] = resource.sourcePath;
			if (resource.immutable) {
				immutableSourcePaths.add(path.resolve(resource.sourcePath));
			}
			continue;
		}

		const ranges = opts.pathSpecs[idx]?.ranges;
		const expanded = await expandVirtualInternalResource(rawPath, resource, internalRouter, context, ranges);
		virtualInputIndexes.add(idx);
		for (const virtual of expanded) {
			virtualResources.push(virtual);
			virtualPathSet.add(virtual.path);
		}
		virtualScopePath = virtualScopePath ? `${virtualScopePath}, ${rawPath}` : rawPath;
	}

	return {
		resolvedPathsByInput: paths,
		paths: paths.filter((_, idx) => !virtualInputIndexes.has(idx)),
		virtualResources,
		virtualPathSet,
		virtualInputIndexes,
		immutableSourcePaths,
		virtualScopePath,
	};
}

export interface SearchToolDetails {
	truncation?: TruncationResult;
	fileLimitReached?: number;
	perFileLimitReached?: number;
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
	/** Absolute base directory used during search. Used by the renderer to resolve
	 * display-relative paths to absolute paths for OSC 8 hyperlinks. */
	searchPath?: string;
	/** User-supplied paths whose base directory was missing on disk. The tool
	 * skipped these and continued with the surviving entries; surfaced as a
	 * non-fatal warning in the renderer and in the model-facing text. */
	missingPaths?: string[];
}

type SearchParams = z.infer<typeof searchSchema>;

export class SearchTool implements AgentTool<typeof searchSchema, SearchToolDetails> {
	readonly name = "search";
	readonly approval = "read" as const;
	readonly label = "Search";
	readonly loadMode = "discoverable";
	readonly summary = "Search file contents using ripgrep (fast text search)";
	readonly description: string;
	readonly parameters = searchSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		const displayMode = resolveFileDisplayMode(session);
		this.description = prompt.render(searchDescription, {
			IS_HL_MODE: displayMode.hashLines,
			IS_LINE_NUMBER_MODE: !displayMode.hashLines && displayMode.lineNumbers,
		});
	}

	async execute(
		_toolCallId: string,
		params: SearchParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchToolDetails>,
		_toolContext?: AgentToolContext,
	): Promise<AgentToolResult<SearchToolDetails>> {
		const { pattern, paths: rawPaths, i, gitignore, skip } = params;

		return untilAborted(signal, async () => {
			const normalizedPattern = pattern.trim();
			if (!normalizedPattern) {
				throw new ToolError("Pattern must not be empty");
			}

			const normalizedSkip = skip === undefined ? 0 : Number.isFinite(skip) ? Math.floor(skip) : Number.NaN;
			if (normalizedSkip < 0 || !Number.isFinite(normalizedSkip)) {
				throw new ToolError("Skip must be a non-negative number");
			}
			const rawEntries = await expandDelimitedPathEntries(toPathList(rawPaths), this.session.cwd);
			const pathSpecs = parsePathSpecs(rawEntries);
			const paths = pathSpecs.map(spec => spec.clean);
			const {
				resolvedPaths,
				displayMap: archiveDisplayMap,
				displaySet: archiveDisplaySet,
				unreadable: archiveUnreadable,
				cleanup: cleanupArchiveScratch,
			} = await resolveArchiveSearchPaths(paths, this.session.cwd);
			try {
				const internalResolution = await resolveInternalSearchInputs({
					pathSpecs,
					resolvedPaths,
					cwd: this.session.cwd,
					settings: this.session.settings,
					signal,
					archiveDisplayMap,
					localProtocolOptions: this.session.localProtocolOptions,
				});
				const searchablePaths = internalResolution.paths;
				const { virtualResources, virtualPathSet, virtualInputIndexes } = internalResolution;
				// Build the per-file line-range filter (keyed by absolute path) now that
				// archive entries have been materialized to scratch files. Plain entries
				// resolve through `resolveReadPath`; archive entries are keyed by the
				// scratch path that grep will actually report against.
				const rangesByAbsPath = new Map<string, LineRange[]>();
				for (let idx = 0; idx < pathSpecs.length; idx++) {
					const spec = pathSpecs[idx];
					if (!spec.ranges) continue;
					if (virtualInputIndexes.has(idx)) continue;
					const resolved = internalResolution.resolvedPathsByInput[idx];
					if (!resolved) continue;
					if (resolved === spec.clean && !archiveDisplayMap.has(resolved)) {
						// Non-archive entry; ensure the cleaned path resolves to a regular file.
						const absKey = path.resolve(resolveReadPath(resolved, this.session.cwd));
						const stats = await stat(absKey).catch(() => null);
						if (!stats) {
							throw new ToolError(`Path not found for line-range selector: ${spec.original}`);
						}
						if (!stats.isFile()) {
							throw new ToolError(`Line-range selector requires a single file: ${spec.original} is a directory`);
						}
						mergeRangesInto(rangesByAbsPath, absKey, spec.ranges);
					} else {
						// Archive entry — `resolveArchiveSearchPaths` substituted a scratch path.
						const absKey = path.resolve(resolved);
						mergeRangesInto(rangesByAbsPath, absKey, spec.ranges);
					}
				}

				if (archiveUnreadable.length > 0 && searchablePaths.length === archiveUnreadable.length) {
					// All inputs were archive selectors we couldn't materialize; surface the
					// reason instead of a downstream "path not found" from the scope resolver.
					throw new ToolError(
						`Cannot search archive member(s): ${archiveUnreadable.join(", ")}. ` +
							`Read the file directly with \`read <archive>:<member>\` and grep the returned content, ` +
							`or pass a UTF-8 text member.`,
					);
				}
				const normalizedContextBefore = this.session.settings.get("search.contextBefore");
				const normalizedContextAfter = this.session.settings.get("search.contextAfter");
				const ignoreCase = i ?? false;
				const useGitignore = gitignore ?? true;
				const patternHasNewline = normalizedPattern.includes("\n") || normalizedPattern.includes("\\n");
				const effectiveMultiline = patternHasNewline;

				let searchPath: string;
				let scopePath: string;
				let globFilter: string | undefined;
				let isDirectory: boolean;
				let multiTargets: ResolvedSearchTarget[] | undefined;
				let exactFilePaths: string[] | undefined;
				let missingPaths: string[];
				const immutableSourcePaths = new Set(internalResolution.immutableSourcePaths);
				if (searchablePaths.length > 0) {
					const scope = await resolveToolSearchScope({
						rawPaths: searchablePaths,
						cwd: this.session.cwd,
						internalUrlAction: "search",
						trackImmutableSources: true,
						surfaceExactFilePaths: true,
						multipathStatHint: " (`paths` entries must each exist relative to cwd)",
						settings: this.session.settings,
						signal,
						localProtocolOptions: this.session.localProtocolOptions,
					});
					searchPath = scope.searchPath;
					isDirectory = scope.isDirectory;
					multiTargets = scope.multiTargets;
					exactFilePaths = scope.exactFilePaths;
					missingPaths = scope.missingPaths;
					globFilter = scope.globFilter;
					for (const immutablePath of scope.immutableSourcePaths) {
						immutableSourcePaths.add(immutablePath);
					}
					// When the only input was an archive selector, surface that selector instead
					// of the temp scratch path the resolver substituted in.
					const physicalScopePath =
						searchablePaths.length === 1 && archiveDisplayMap.get(searchPath)
							? (archiveDisplayMap.get(searchPath) as string)
							: scope.scopePath;
					scopePath = internalResolution.virtualScopePath
						? `${physicalScopePath}, ${internalResolution.virtualScopePath}`
						: physicalScopePath;
				} else {
					searchPath = this.session.cwd;
					scopePath = internalResolution.virtualScopePath ?? ".";
					globFilter = undefined;
					isDirectory = false;
					multiTargets = undefined;
					exactFilePaths = undefined;
					missingPaths = [];
				}
				if (
					missingPaths.length > 0 &&
					missingPaths.length === searchablePaths.length &&
					virtualResources.length === 0
				) {
					const archiveHint =
						archiveUnreadable.length > 0
							? ` (archive members were not searchable: ${archiveUnreadable.join(", ")})`
							: "";
					throw new ToolError(
						`Path not found: ${missingPaths.join(", ")}; pass each path as its own array element${archiveHint}`,
					);
				}
				const baseDisplayMode = resolveFileDisplayMode(this.session);

				const effectiveOutputMode = GrepOutputMode.Content;
				const isMultiScope =
					isDirectory ||
					Boolean(exactFilePaths) ||
					Boolean(multiTargets) ||
					(virtualResources.length > 0 && (virtualResources.length > 1 || searchablePaths.length > 0));
				const perFileMatchCap = isMultiScope ? MULTI_FILE_PER_FILE_MATCHES : SINGLE_FILE_MATCHES;

				// Run grep
				let result: GrepResult = {
					matches: [],
					totalMatches: 0,
					filesWithMatches: 0,
					filesSearched: 0,
					limitReached: false,
				};
				try {
					if (searchablePaths.length > 0) {
						if (exactFilePaths || multiTargets) {
							const matches: GrepMatch[] = [];
							let limitReached = false;
							let totalMatches = 0;
							let filesSearched = 0;
							const targets = exactFilePaths
								? exactFilePaths.map(filePath => ({
										basePath: filePath,
										glob: undefined as string | undefined,
									}))
								: (multiTargets ?? []);
							for (const target of targets) {
								const targetResult = await grep(
									{
										pattern: normalizedPattern,
										path: target.basePath,
										glob: target.glob,
										ignoreCase,
										multiline: effectiveMultiline,
										hidden: true,
										gitignore: useGitignore,
										cache: false,
										maxCount: INTERNAL_TOTAL_CAP,
										contextBefore: normalizedContextBefore,
										contextAfter: normalizedContextAfter,
										maxColumns: DEFAULT_MAX_COLUMN,
										mode: effectiveOutputMode,
									},
									undefined,
								);
								limitReached = limitReached || Boolean(targetResult.limitReached);
								totalMatches += targetResult.totalMatches;
								filesSearched += targetResult.filesSearched;
								for (const match of targetResult.matches) {
									const absolute = path.resolve(target.basePath, match.path);
									const rebased = path.relative(searchPath, absolute).replace(/\\/g, "/");
									matches.push({ ...match, path: rebased });
								}
							}
							result = {
								matches,
								totalMatches: exactFilePaths ? matches.length : totalMatches,
								filesWithMatches: new Set(matches.map(match => match.path)).size,
								filesSearched: exactFilePaths ? exactFilePaths.length : filesSearched,
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
									maxCount: INTERNAL_TOTAL_CAP,
									contextBefore: normalizedContextBefore,
									contextAfter: normalizedContextAfter,
									maxColumns: DEFAULT_MAX_COLUMN,
									mode: effectiveOutputMode,
								},
								undefined,
							);
						}
					}
				} catch (err) {
					if (err instanceof Error && /^regex(?: parse)? error/i.test(err.message)) {
						throw new ToolError(err.message.replace(/^regex(?: parse)? error:?\s*/i, "Invalid regex: "));
					}
					throw err;
				}
				const virtualResult = searchVirtualResources(
					virtualResources,
					normalizedPattern,
					ignoreCase,
					effectiveMultiline,
					normalizedContextBefore,
					normalizedContextAfter,
					INTERNAL_TOTAL_CAP,
				);
				result = mergeGrepResults(result, virtualResult, INTERNAL_TOTAL_CAP);
				if (rangesByAbsPath.size > 0) {
					const filteredMatches: GrepMatch[] = [];
					for (const match of result.matches) {
						const abs = matchAbsolutePath(match.path, searchPath);
						const ranges = rangesByAbsPath.get(abs);
						if (!ranges) {
							// Path has no line-range constraint (e.g. a peer entry without `:N-M`).
							filteredMatches.push(match);
							continue;
						}
						if (!isLineInRanges(match.lineNumber, ranges)) continue;
						// Drop context lines that fall outside the allowed ranges; they would
						// otherwise leak content the caller explicitly excluded.
						const trimBefore = match.contextBefore?.filter(c => isLineInRanges(c.lineNumber, ranges));
						const trimAfter = match.contextAfter?.filter(c => isLineInRanges(c.lineNumber, ranges));
						filteredMatches.push({
							...match,
							contextBefore: trimBefore && trimBefore.length > 0 ? trimBefore : undefined,
							contextAfter: trimAfter && trimAfter.length > 0 ? trimAfter : undefined,
						});
					}
					result = {
						matches: filteredMatches,
						totalMatches: filteredMatches.length,
						filesWithMatches: new Set(filteredMatches.map(match => match.path)).size,
						filesSearched: result.filesSearched,
						limitReached: result.limitReached,
					};
				}
				if (archiveDisplayMap.size > 0) {
					for (const match of result.matches) {
						const abs = matchAbsolutePath(match.path, searchPath);
						const display = archiveDisplayMap.get(abs);
						if (display) match.path = display;
					}
				}

				const formatPath = (filePath: string): string =>
					archiveDisplaySet.has(filePath) || virtualPathSet.has(filePath)
						? filePath
						: formatResultPath(filePath, isDirectory, searchPath, this.session.cwd);

				// Group matches by file in encounter order. Detect per-file overflow
				// BEFORE truncation so the renderer can surface that a hot file was
				// trimmed for diversity.
				const fileOrder: string[] = [];
				const matchesByPath = new Map<string, GrepMatch[]>();
				for (const match of result.matches) {
					if (!matchesByPath.has(match.path)) {
						fileOrder.push(match.path);
						matchesByPath.set(match.path, []);
					}
					matchesByPath.get(match.path)!.push(match);
				}
				let perFileLimitReached = false;
				for (const file of fileOrder) {
					const list = matchesByPath.get(file)!;
					if (list.length > perFileMatchCap) {
						perFileLimitReached = true;
						list.length = perFileMatchCap;
					}
				}
				const totalFiles = fileOrder.length;
				// Single-file scopes can't paginate — there is one file by definition.
				const canPaginate = isMultiScope;
				const skipFiles = canPaginate ? Math.min(normalizedSkip, totalFiles) : 0;
				const windowFiles = canPaginate ? fileOrder.slice(skipFiles, skipFiles + DEFAULT_FILE_LIMIT) : fileOrder;
				const fileLimitReached = canPaginate && totalFiles > skipFiles + DEFAULT_FILE_LIMIT;
				const selectedMatches: GrepMatch[] = [];
				if (windowFiles.length > 0) {
					const lists = windowFiles.map(file => matchesByPath.get(file) ?? []);
					const cursors = new Array<number>(lists.length).fill(0);
					let anyAdded = true;
					while (anyAdded) {
						anyAdded = false;
						for (let i = 0; i < lists.length; i++) {
							if (cursors[i] < lists[i].length) {
								selectedMatches.push(lists[i][cursors[i]++]);
								anyAdded = true;
							}
						}
					}
				}
				const nextSkip = skipFiles + windowFiles.length;
				const limitMessage = fileLimitReached
					? `Showing files ${skipFiles + 1}-${nextSkip} of ${totalFiles}. Use skip=${nextSkip} for the next page, or narrow paths/pattern.`
					: "";
				const { record: recordFile, list: fileList } = createFileRecorder();
				const fileMatchCounts = new Map<string, number>();
				const archiveNote =
					archiveUnreadable.length > 0
						? `Skipped archive entries (search supports text members only): ${archiveUnreadable.join(", ")}`
						: undefined;
				// Suppress entries we already explained via archiveNote — they would otherwise
				// double up (the unreadable selector also failed the scope's existence check).
				const archiveUnreadablePaths = new Set(archiveUnreadable.map(s => s.replace(/ \(.*\)$/, "")));
				const missingPathsForNote = missingPaths.filter(p => !archiveUnreadablePaths.has(p));
				const missingPathsNote =
					missingPathsForNote.length > 0 ? `Skipped missing paths: ${missingPathsForNote.join(", ")}` : undefined;
				const warningNote =
					[missingPathsNote, archiveNote].filter((s): s is string => Boolean(s)).join("\n") || undefined;
				if (selectedMatches.length === 0) {
					const details: SearchToolDetails = {
						scopePath,
						searchPath,
						matchCount: 0,
						fileCount: 0,
						files: [],
						truncated: false,
						missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
					};
					const text = warningNote ? `No matches found\n${warningNote}` : "No matches found";
					return toolResult(details).text(text).done();
				}
				const outputLines: string[] = [];
				let linesTruncated = false;
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
				const hashContexts = new Map<string, { tag: string }>();
				if (baseDisplayMode.hashLines) {
					for (const relativePath of fileList) {
						if (archiveDisplaySet.has(relativePath) || virtualPathSet.has(relativePath)) continue;
						const absoluteFilePath = path.resolve(this.session.cwd, relativePath);
						if (immutableSourcePaths.has(absoluteFilePath)) continue;
						// Mint a whole-file content tag so any anchor validates while the
						// file is unchanged; over-cap / unreadable files get no tag (and
						// therefore plain, non-editable line output).
						const tag = await recordFileSnapshot(this.session, absoluteFilePath);
						if (tag) hashContexts.set(relativePath, { tag });
					}
				}
				const renderMatchesForFile = (relativePath: string): { model: string[]; display: string[] } => {
					const modelOut: string[] = [];
					const displayOut: string[] = [];
					const fileMatches = matchesByFile.get(relativePath) ?? [];
					const hashContext = hashContexts.get(relativePath);
					const useHashLines = hashContext !== undefined;
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
					let lastEmittedLine: number | undefined;
					const gutterPad = " ".repeat(lineNumberWidth + 1);
					for (const match of fileMatches) {
						const pushLine = (lineNumber: number, line: string, isMatch: boolean) => {
							if (lastEmittedLine !== undefined && lineNumber > lastEmittedLine + 1) {
								modelOut.push("...");
								displayOut.push(`${gutterPad}│...`);
							}
							modelOut.push(formatMatchLine(lineNumber, line, isMatch, { useHashLines }));
							displayOut.push(formatCodeFrameLine(isMatch ? "*" : " ", lineNumber, line, lineNumberWidth));
							lastEmittedLine = lineNumber;
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
				const useGroupedOutput = isDirectory || isMultiScope;
				if (useGroupedOutput) {
					const grouped = formatGroupedFiles(fileList, relativePath => {
						const rendered = renderMatchesForFile(relativePath);
						const hashContext = hashContexts.get(relativePath);
						return {
							modelLines: rendered.model,
							displayLines: rendered.display,
							headerSuffix: hashContext?.tag ? `#${hashContext.tag}` : "",
							skip: rendered.model.length === 0,
						};
					});
					outputLines.push(...grouped.model);
					displayLines.push(...grouped.display);
				} else {
					for (const relativePath of fileList) {
						const rendered = renderMatchesForFile(relativePath);
						if (rendered.model.length === 0) continue;
						if (outputLines.length > 0) {
							outputLines.push("");
							displayLines.push("");
						}
						const hashContext = hashContexts.get(relativePath);
						if (hashContext?.tag) {
							outputLines.push(formatHashlineHeader(relativePath, hashContext.tag));
						}
						outputLines.push(...rendered.model);
						displayLines.push(...rendered.display);
					}
				}
				if (limitMessage) {
					outputLines.push("", limitMessage);
				}
				if (warningNote) {
					outputLines.push("", warningNote);
				}
				const rawOutput = outputLines.join("\n");
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
				const output = truncation.content;
				const displayText = displayLines.join("\n");
				const truncated = Boolean(
					fileLimitReached || perFileLimitReached || result.limitReached || truncation.truncated || linesTruncated,
				);
				const details: SearchToolDetails = {
					scopePath,
					searchPath,
					matchCount: selectedMatches.length,
					fileCount: fileList.length,
					files: fileList,
					fileMatches: fileList.map(path => ({
						path,
						count: fileMatchCounts.get(path) ?? 0,
					})),
					truncated,
					fileLimitReached: fileLimitReached ? DEFAULT_FILE_LIMIT : undefined,
					perFileLimitReached: perFileLimitReached ? perFileMatchCap : undefined,
					displayContent: displayText,
					missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
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
			} finally {
				await cleanupArchiveScratch();
			}
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface SearchRenderArgs {
	pattern: string;
	paths?: string | string[];
	i?: boolean;
	gitignore?: boolean;
	skip?: number;
}

const COLLAPSED_TEXT_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

export const searchToolRenderer = {
	inline: true,
	renderCall(args: SearchRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const paths = toPathList(args.paths);
		const meta: string[] = [];
		if (paths.length) meta.push(`in ${paths.join(", ")}`);
		if (args.i) meta.push("case:insensitive");
		if (args.gitignore === false) meta.push("gitignore:false");
		if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);

		const text = renderStatusLine(
			{ icon: "pending", title: "Search", description: args.pattern || "?", meta },
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SearchToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: SearchRenderArgs,
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
				{ icon: "success", title: "Search", description, meta: [formatCount("item", lines.length)] },
				uiTheme,
			);
			return createCachedComponent(
				() => options.expanded,
				width => {
					const listLines = renderTreeList(
						{
							items: lines,
							expanded: options.expanded,
							maxCollapsed: COLLAPSED_TEXT_LIMIT,
							maxCollapsedLines: COLLAPSED_TEXT_LIMIT,
							itemType: "item",
							renderItem: line => uiTheme.fg("toolOutput", line),
						},
						uiTheme,
					);
					return [header, ...listLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				},
			);
		}

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(details?.truncated || truncation || limits?.columnTruncated);

		const missingPathsList = details?.missingPaths ?? [];
		const missingNote =
			missingPathsList.length > 0
				? uiTheme.fg("warning", `skipped missing: ${missingPathsList.join(", ")}`)
				: undefined;

		if (matchCount === 0) {
			const header = renderStatusLine(
				{ icon: "warning", title: "Search", description: args?.pattern, meta: ["0 matches"] },
				uiTheme,
			);
			const lines = [header, formatEmptyMessage("No matches found", uiTheme)];
			if (missingNote) lines.push(missingNote);
			return new Text(lines.join("\n"), 0, 0);
		}

		const summaryParts = [formatCount("match", matchCount), formatCount("file", fileCount)];
		const meta = [...summaryParts];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));
		const description = args?.pattern ?? undefined;
		const header = renderStatusLine(
			{ icon: truncated ? "warning" : "success", title: "Search", description, meta },
			uiTheme,
		);

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const matchGroups = splitGroupsByBlankLine(textContent.split("\n"));

		const renderedFileLimit = details?.fileLimitReached;
		const renderedPerFileLimit = details?.perFileLimitReached;
		const truncationReasons: string[] = [];
		if (renderedFileLimit) truncationReasons.push(`first ${renderedFileLimit} files (skip to paginate)`);
		if (renderedPerFileLimit) truncationReasons.push(`first ${renderedPerFileLimit} matches per file`);
		if (truncation) truncationReasons.push(truncation.truncatedBy === "lines" ? "line limit" : "size limit");
		if (limits?.columnTruncated) truncationReasons.push(`line length ${limits.columnTruncated.maxColumn}`);
		if (truncation?.artifactId) truncationReasons.push(formatFullOutputReference(truncation.artifactId));

		const extraLines: string[] = [];
		if (truncationReasons.length > 0) {
			extraLines.push(uiTheme.fg("warning", `truncated: ${truncationReasons.join(", ")}`));
		}
		if (missingNote) extraLines.push(missingNote);

		return createCachedComponent(
			() => options.expanded,
			width => {
				const collapsedMatchLineBudget = Math.max(COLLAPSED_TEXT_LIMIT - extraLines.length, 0);
				const searchBase = details?.searchPath;
				const matchLines = renderTreeList(
					{
						items: matchGroups,
						expanded: options.expanded,
						maxCollapsed: matchGroups.length,
						maxCollapsedLines: collapsedMatchLineBudget,
						itemType: "match",
						renderItem: group => {
							// Track directory context within a group for ## file headers.
							// `# foo/` is a directory header; `# foo.ts` is a root-level file
							// from formatGroupedFiles (single-# when directory is `.`).
							let contextDir = searchBase ?? "";
							return group.map(line => {
								if (line.startsWith("## ")) {
									// Strip optional ` (suffix)` and `#hash` before resolving.
									const fileName = line
										.slice(3)
										.trimEnd()
										.replace(/\s+\([^)]*\)\s*$/, "")
										.replace(/#[0-9a-f]+$/, "");
									const absPath = contextDir && fileName ? path.join(contextDir, fileName) : undefined;
									const styled = uiTheme.fg("dim", line);
									return absPath ? fileHyperlink(absPath, styled) : styled;
								}
								if (line.startsWith("# ")) {
									const raw = line
										.slice(2)
										.trimEnd()
										.replace(/\s+\([^)]*\)\s*$/, "");
									if (INTERNAL_URL_DISPLAY_RE.test(raw)) {
										contextDir = "";
										return uiTheme.fg("accent", line);
									}
									const isDirectory = raw.endsWith("/");
									const name = isDirectory ? raw.replace(/\/$/, "") : raw.replace(/#[0-9a-f]+$/, "");
									if (isDirectory) {
										if (searchBase) {
											contextDir = name === "." ? searchBase : path.join(searchBase, name);
										}
										return uiTheme.fg("accent", line);
									}
									// Root-level file emitted by formatGroupedFiles when the directory is `.`.
									const absPath = searchBase && name ? path.join(searchBase, name) : undefined;
									const styled = uiTheme.fg("accent", line);
									return absPath ? fileHyperlink(absPath, styled) : styled;
								}
								return uiTheme.fg("toolOutput", line);
							});
						},
					},
					uiTheme,
				);
				return [header, ...matchLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
		);
	},
	mergeCallAndResult: true,
};
