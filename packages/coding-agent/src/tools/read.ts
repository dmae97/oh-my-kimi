import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatHashlineHeader, formatNumberedLine, formatNumberedLines } from "@oh-my-pi/hashline";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolTier,
} from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { glob, type SummaryResult, summarizeCode } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import {
	getRemoteDir,
	type ImageMetadata,
	isProbablyBinary,
	logger,
	prompt,
	readImageMetadata,
	untilAborted,
} from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { LRUCache } from "lru-cache/raw";
import {
	canonicalSnapshotKey,
	getFileSnapshotStore,
	recordFileSnapshot,
	recordSeenLines,
	recordSeenLinesFromBody,
	SNAPSHOT_MAX_BYTES,
} from "../edit/file-snapshot-store";
import { normalizeToLF } from "../edit/normalize";
import { isNotebookPath, readEditableNotebookText } from "../edit/notebook";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter, resolveLocalUrlToFile, resolveLocalUrlToPath } from "../internal-urls";
import { type ResolvedArtifactFile, resolveArtifactFile } from "../internal-urls/artifact-protocol";
import { parseInternalUrl } from "../internal-urls/parse";
import type { InternalUrl } from "../internal-urls/types";
import { getLanguageFromPath, type Theme } from "../modes/theme/theme";
import readDescription from "../prompts/tools/read.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	noTruncResult,
	type TruncationResult,
	truncateHead,
	truncateHeadBytes,
	truncateLine,
} from "../session/streaming-output";
import { fileHyperlink, renderCodeCell, renderMarkdownCell, renderStatusLine, tryResolveInternalUrlSync } from "../tui";
import { CachedOutputBlock, markFramedBlockComponent } from "../tui/output-block";
import { buildLineEntriesWithBlockContext, type LineEntry, lineEntriesToPlainText } from "../utils/block-context";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import {
	ImageInputTooLargeError,
	loadImageInput,
	MAX_IMAGE_INPUT_BYTES,
	webpExclusionForModel,
} from "../utils/image-loading";
import { CONVERTIBLE_EXTENSIONS, convertFileWithMarkit } from "../utils/markit";
import { type ArchiveReader, formatArchiveEntryLines, openArchive, parseArchivePathCandidates } from "../utils/zip";
import { buildDirectoryTree, type DirectoryTree } from "../workspace-tree";
import {
	type ConflictEntry,
	type ConflictScope,
	formatConflictSummary,
	formatConflictWarning,
	getConflictHistory,
	parseConflictUri,
	renderConflictRegion,
	scanConflictLines,
	scanFileForConflicts,
} from "./conflict-detect";
import {
	executeReadUrl,
	fetchReadUrl,
	parseReadUrlTarget,
	type ReadUrlToolDetails,
	renderReadUrlCall,
	renderReadUrlResult,
} from "./fetch";
import { applyListLimit } from "./list-limit";
import {
	formatFullOutputReference,
	formatStyledTruncationWarning,
	type OutputMeta,
	resolveOutputMaxColumns,
	stripOutputNotice,
} from "./output-meta";
import {
	expandPath,
	formatPathRelativeToCwd,
	isReadableUrlPath,
	type LineRange,
	parseLineRanges,
	pathTargetsSsh,
	probeLiteralPathExists,
	resolveReadPath,
	splitDelimitedPathEntry,
	splitInternalUrlSel,
	splitPathAndSel,
	splitPathAndSelPreferringLiteral,
} from "./path-utils";
import { formatBytes, replaceTabs, shortenPath, wrapBrackets } from "./render-utils";
import { REPORT_ISSUE_DEVICE_NAME, reportIssueDeviceUsage } from "./report-tool-issue";
import { isResolutionDeviceName, resolutionDeviceUsage } from "./resolve";
import {
	executeReadQuery,
	getRowByKey,
	getRowByRowId,
	getTableSchema,
	isSqliteFile,
	listTables,
	MAX_RAW_QUERY_ROWS,
	parseSqlitePathCandidates,
	parseSqliteSelector,
	queryRows,
	renderRow,
	renderSchema,
	renderTable,
	renderTableList,
	resolveTableRowLookup,
} from "./sqlite-reader";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

// Per-session memo for tree-sitter summaries. `summarizeCode` is a pure function
// of (code, path, fold settings) but costs ~12-18ms for a ~1500-line file, and a
// repeat summary read of the same unchanged file re-parses from scratch. Key on
// the content hash of the freshly-read bytes (+ path + fold settings): the file
// is still read fresh on every call, so a hit only reuses the deterministic
// parse — there is no staleness window and no stat guard is needed. Bounded LRU,
// aged out with the session via WeakMap.
// Unusable results (not parsed, or nothing elided) are memoized as `false`: the
// full SummaryResult embeds the whole source in kept segments, and the caller
// only ever renders `parsed && elided` summaries — caching the segments would
// retain up to 48 near-2MiB sources just to remember "no summary".
const SUMMARY_CACHE_MAX = 48;
const summaryParseCaches = new WeakMap<object, LRUCache<string, SummaryResult | false>>();
function getSummaryParseCache(session: object): LRUCache<string, SummaryResult | false> {
	let cache = summaryParseCaches.get(session);
	if (!cache) {
		cache = new LRUCache<string, SummaryResult | false>({ max: SUMMARY_CACHE_MAX });
		summaryParseCaches.set(session, cache);
	}
	return cache;
}

const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_LINES = 20_000;
const MAX_ARTIFACT_RAW_INLINE_BYTES = DEFAULT_MAX_BYTES;
/**
 * Per-line column cap for file reads. Lines wider than the value of
 * `tools.outputMaxColumns` are ellipsis-truncated at display time; the file
 * on disk is unchanged. Shared with the streaming sink path so one setting
 * covers `bash`/`ssh`/`python`/`js eval` and `read` uniformly.
 */
const PROSE_SUMMARY_EXTENSIONS = new Set([".md", ".txt"]);
// Remote mount path prefix (sshfs mounts) - skip fuzzy matching to avoid hangs
const REMOTE_MOUNT_PREFIX = getRemoteDir() + path.sep;

async function readBracketContextFullLines(absolutePath: string, fileSize: number): Promise<string[] | undefined> {
	if (fileSize > SNAPSHOT_MAX_BYTES) return undefined;
	try {
		return normalizeToLF(await Bun.file(absolutePath).text()).split("\n");
	} catch {
		return undefined;
	}
}

function isRemoteMountPath(absolutePath: string): boolean {
	return absolutePath.startsWith(REMOTE_MOUNT_PREFIX);
}

function prependLineNumbers(text: string, startNum: number): string {
	const textLines = text.split("\n");
	return textLines.map((line, i) => `${startNum + i}|${line}`).join("\n");
}

interface HashlineHeaderContext {
	header: string;
	tag: string;
	fullText?: string;
}

function formatReadHashlineHeader(displayPath: string, tag: string): string {
	// In-workspace reads collapse to the bare filename for brevity: the edit
	// tool's snapshot-tag recovery rebinds a bare `[name#tag]` onto the in-tree
	// file it uniquely names. Out-of-workspace reads can't lean on that —
	// recovery refuses to redirect a write outside the cwd/sandbox
	// (HashlineFilesystem.allowTagPathRecovery) — so an absolute displayPath
	// must stay directly resolvable, otherwise the basename resolves against
	// cwd, misses, and the edit fails with "File not found" (e.g. ~/.claude/*).
	// `shortenPath` keeps `~/.claude/...` (round-trips through resolveToCwd's ~
	// expansion) instead of leaking the full home path into the read output.
	const anchor = path.isAbsolute(displayPath) ? shortenPath(displayPath) : path.basename(displayPath);
	return formatHashlineHeader(anchor, tag);
}

function recordFullHashlineContext(
	session: ToolSession,
	absolutePath: string | undefined,
	displayPath: string,
	fullText: string,
): HashlineHeaderContext | undefined {
	if (!absolutePath || !path.isAbsolute(absolutePath)) return undefined;
	const normalized = normalizeToLF(fullText);
	const tag = getFileSnapshotStore(session).record(canonicalSnapshotKey(absolutePath), normalized);
	return {
		header: formatReadHashlineHeader(displayPath, tag),
		tag,
		fullText: normalized,
	};
}

async function readHashlineHeaderContext(
	session: ToolSession,
	absolutePath: string,
	cwd: string,
): Promise<HashlineHeaderContext> {
	const fullText = await Bun.file(absolutePath).text();
	const context = recordFullHashlineContext(
		session,
		absolutePath,
		formatPathRelativeToCwd(absolutePath, cwd),
		fullText,
	);
	if (!context) throw new ToolError(`Cannot record hashline snapshot for non-absolute path: ${absolutePath}`);
	return context;
}

function hashlineHeaderContext(displayPath: string, tag: string): HashlineHeaderContext {
	return { header: formatReadHashlineHeader(displayPath, tag), tag };
}

function prependHashlineHeader(text: string, context: HashlineHeaderContext | undefined): string {
	return context ? `${context.header}\n${text}` : text;
}

function formatTextWithMode(
	text: string,
	startNum: number,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (shouldAddHashLines) return formatNumberedLines(text, startNum);
	if (shouldAddLineNumbers) return prependLineNumbers(text, startNum);
	return text;
}

const BRACKET_CONTEXT_ELLIPSIS = "…";

function formatLineEntryWithMode(entry: LineEntry, shouldAddHashLines: boolean, shouldAddLineNumbers: boolean): string {
	if (entry.kind === "ellipsis") return BRACKET_CONTEXT_ELLIPSIS;
	return formatSingleLine(entry.lineNumber, entry.text, shouldAddHashLines, shouldAddLineNumbers);
}

function formatLineEntriesWithMode(
	entries: readonly LineEntry[],
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	return entries.map(entry => formatLineEntryWithMode(entry, shouldAddHashLines, shouldAddLineNumbers)).join("\n");
}

const BRACE_PAIRS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const BRACE_TAIL_TRAILING_RE = /^[;,)\]}]*$/;

/**
 * Decide whether the kept lines surrounding an elided range collapse to a
 * single brace-pair line in the rendered summary. Returns true when the head
 * line ends with `{` / `(` / `[` and the tail line is the matching closer
 * (optionally followed by terminating punctuation like `;`, `,`, or further
 * closers — e.g. `};`, `})`, `]);`).
 */
function canMergeBracePair(headLine: string, tailLine: string): boolean {
	const head = headLine.trimEnd();
	const tail = tailLine.trim();
	const opener = head.slice(-1);
	const closer = BRACE_PAIRS[opener];
	if (!closer) return false;
	if (!tail.startsWith(closer)) return false;
	return BRACE_TAIL_TRAILING_RE.test(tail.slice(closer.length));
}

function formatSingleLine(
	line: number,
	text: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (shouldAddHashLines) return formatNumberedLine(line, text);
	if (shouldAddLineNumbers) return `${line}|${text}`;
	return text;
}

function formatMergedBraceLine(
	startLine: number,
	endLine: number,
	headText: string,
	tailText: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): { model: string; display: string } {
	const merged = `${headText.trimEnd()} … ${tailText.trim()}`;
	if (shouldAddHashLines) {
		return { model: `${startLine}-${endLine}:${merged}`, display: merged };
	}
	if (shouldAddLineNumbers) {
		return { model: `${startLine}-${endLine}|${merged}`, display: merged };
	}
	return { model: merged, display: merged };
}

function countTextLines(text: string): number {
	if (text.length === 0) return 0;
	// Count newlines directly instead of allocating an array via split("\n").
	// Called on every read of file content; the result is identical (N newlines
	// ⇒ N+1 lines for non-empty text).
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

function contiguousLineNumbers(startLine: number, count: number): number[] {
	const lines: number[] = [];
	for (let offset = 0; offset < count; offset++) lines.push(startLine + offset);
	return lines;
}

function lineNumbersFromSpans(spans: readonly { startLine: number; endLine: number }[]): number[] {
	const lines: number[] = [];
	for (const span of spans) {
		for (let line = span.startLine; line <= span.endLine; line++) lines.push(line);
	}
	return lines;
}

function recordInMemorySeenLines(
	session: ToolSession,
	absolutePath: string | undefined,
	fullText: string,
	seenLines: readonly number[] | undefined,
): void {
	if (!absolutePath || !path.isAbsolute(absolutePath) || !seenLines || seenLines.length === 0) return;
	getFileSnapshotStore(session).record(canonicalSnapshotKey(absolutePath), normalizeToLF(fullText), seenLines);
}

function lineNumbersFromEntries(entries: readonly LineEntry[]): number[] {
	const lines: number[] = [];
	for (const entry of entries) {
		if (entry.kind === "line") lines.push(entry.lineNumber);
	}
	return lines;
}

/** Inclusive line range describing one elided span in a structural summary. */
interface ElidedRange {
	start: number;
	end: number;
}

/** Sample ranges shown in the footer to demonstrate the multi-range syntax. */
const FOOTER_RANGE_SAMPLES = 2;

/**
 * Footer appended to summarized reads telling the model how to recover the
 * elided body. Without this hint, agents either ignore the `…`/`{ … }`
 * markers or burn a turn guessing the right selector (see issue #1046). The
 * footer demonstrates the multi-range selector syntax with concrete sample
 * ranges drawn from the actual elision so the model re-reads only what it
 * needs instead of falling back to `:raw` or whole-file reads.
 */
function formatSummaryElisionFooter(
	readPath: string,
	elidedRanges: ReadonlyArray<ElidedRange>,
	elidedLines: number,
): string {
	if (elidedRanges.length === 0) return "";
	const sampleCount = Math.min(elidedRanges.length, FOOTER_RANGE_SAMPLES);
	const selector = elidedRanges
		.slice(0, sampleCount)
		.map(r => `${r.start}-${r.end}`)
		.join(",");
	const example = `${readPath}:${selector}`;
	const tail = elidedRanges.length > sampleCount ? `, e.g. ${example}` : ` with ${example}`;
	return `[…${elidedLines}ln elided; re-read needed ranges${tail}]`;
}
const READ_CHUNK_SIZE = 8 * 1024;

/**
 * Context lines added around an explicit range read. Anchor-stale failures
 * cluster on edits whose anchors land just outside the most recent read
 * window, but the data (`scripts/session-stats/analyze_selector_reads.py`)
 * shows most follow-up reads are disjoint hops, not adjacent extensions —
 * so symmetric padding rarely pays for itself.
 *
 * Leading=1 catches accidental single-line reads where the anchor is the
 * line immediately above the requested start. Trailing=3 buffers the
 * common case where the agent asks for a narrow range and then needs the
 * next few lines to disambiguate an anchor.
 */
const RANGE_LEADING_CONTEXT_LINES = 1;
const RANGE_TRAILING_CONTEXT_LINES = 3;

/**
 * Expand a [start, end) range with leading/trailing context lines on the
 * sides where the user actually constrained the range. A start of 0 (no
 * explicit offset) does not get leading context — that's already an
 * open-ended read from the top.
 */
function expandRangeWithContext(
	requestedStart: number,
	requestedEnd: number,
	totalLines: number,
	expandStart: boolean,
	expandEnd: boolean,
): { startLine: number; endLine: number } {
	return {
		startLine: expandStart ? Math.max(0, requestedStart - RANGE_LEADING_CONTEXT_LINES) : requestedStart,
		endLine: expandEnd ? Math.min(totalLines, requestedEnd + RANGE_TRAILING_CONTEXT_LINES) : requestedEnd,
	};
}

async function streamLinesFromFile(
	filePath: string,
	startLine: number,
	maxLinesToCollect: number,
	maxBytes: number,
	selectedLineLimit: number | null,
	signal?: AbortSignal,
	stopScanAfterCollect = false,
): Promise<{
	lines: string[];
	totalFileLines: number;
	collectedBytes: number;
	stoppedByByteLimit: boolean;
	firstLinePreview?: { text: string; bytes: number };
	firstLineByteLength?: number;
	selectedBytesTotal: number;
	/** False when `stopScanAfterCollect` cut the scan short — `totalFileLines` is then a lower bound. */
	reachedEof: boolean;
}> {
	const bufferChunk = Buffer.allocUnsafe(READ_CHUNK_SIZE);
	const collectedLines: string[] = [];
	let lineIndex = 0;
	let collectedBytes = 0;
	let stoppedByByteLimit = false;
	let doneCollecting = false;
	let reachedEof = true;
	let fileHandle: fs.FileHandle | null = null;
	let currentLineLength = 0;
	let currentLineChunks: Buffer[] = [];
	let sawAnyByte = false;
	let endedWithNewline = false;
	let firstLinePreviewBytes = 0;
	const firstLinePreviewChunks: Buffer[] = [];
	let firstLineByteLength: number | undefined;
	let selectedBytesTotal = 0;
	let selectedLinesSeen = 0;
	let captureLine = false;
	let discardLineChunks = false;
	let lineCaptureLimit = 0;

	const setupLineState = () => {
		captureLine = !doneCollecting && lineIndex >= startLine;
		discardLineChunks = !captureLine;
		if (captureLine) {
			const separatorBytes = collectedLines.length > 0 ? 1 : 0;
			lineCaptureLimit = maxBytes - collectedBytes - separatorBytes;
			if (lineCaptureLimit <= 0) {
				discardLineChunks = true;
			}
		} else {
			lineCaptureLimit = 0;
		}
	};

	const decodeLine = (): string => {
		if (currentLineLength === 0) return "";
		if (currentLineChunks.length === 1 && currentLineChunks[0]?.length === currentLineLength) {
			return currentLineChunks[0].toString("utf-8");
		}
		return Buffer.concat(currentLineChunks, currentLineLength).toString("utf-8");
	};

	const maybeCapturePreview = (segment: Uint8Array) => {
		if (doneCollecting || lineIndex < startLine || collectedLines.length !== 0) return;
		if (firstLinePreviewBytes >= maxBytes || segment.length === 0) return;
		const remaining = maxBytes - firstLinePreviewBytes;
		const slice = segment.length > remaining ? segment.subarray(0, remaining) : segment;
		if (slice.length === 0) return;
		firstLinePreviewChunks.push(Buffer.from(slice));
		firstLinePreviewBytes += slice.length;
	};

	const appendSegment = (segment: Uint8Array) => {
		currentLineLength += segment.length;
		maybeCapturePreview(segment);
		if (!captureLine || discardLineChunks || segment.length === 0) return;
		if (currentLineLength <= lineCaptureLimit) {
			currentLineChunks.push(Buffer.from(segment));
		} else {
			discardLineChunks = true;
		}
	};

	const finalizeLine = () => {
		if (lineIndex >= startLine && (selectedLineLimit === null || selectedLinesSeen < selectedLineLimit)) {
			selectedBytesTotal += currentLineLength + (selectedLinesSeen > 0 ? 1 : 0);
			selectedLinesSeen++;
		}

		if (!doneCollecting && lineIndex >= startLine) {
			const separatorBytes = collectedLines.length > 0 ? 1 : 0;
			if (collectedLines.length >= maxLinesToCollect) {
				doneCollecting = true;
			} else if (collectedLines.length === 0 && currentLineLength > maxBytes) {
				stoppedByByteLimit = true;
				doneCollecting = true;
				if (firstLineByteLength === undefined) {
					firstLineByteLength = currentLineLength;
				}
			} else if (collectedLines.length > 0 && collectedBytes + separatorBytes + currentLineLength > maxBytes) {
				stoppedByByteLimit = true;
				doneCollecting = true;
			} else {
				const lineText = decodeLine();
				collectedLines.push(lineText);
				collectedBytes += separatorBytes + currentLineLength;
				if (firstLineByteLength === undefined) {
					firstLineByteLength = currentLineLength;
				}
				if (collectedBytes > maxBytes) {
					stoppedByByteLimit = true;
					doneCollecting = true;
				} else if (collectedLines.length >= maxLinesToCollect) {
					doneCollecting = true;
				}
			}
		} else if (lineIndex >= startLine && firstLineByteLength === undefined) {
			firstLineByteLength = currentLineLength;
		}

		lineIndex++;
		currentLineLength = 0;
		currentLineChunks = [];
		setupLineState();
	};

	setupLineState();

	try {
		fileHandle = await fs.open(filePath, "r");

		while (true) {
			throwIfAborted(signal);
			const { bytesRead } = await fileHandle.read(bufferChunk, 0, bufferChunk.length, null);
			if (bytesRead === 0) break;

			sawAnyByte = true;
			const chunk = bufferChunk.subarray(0, bytesRead);
			endedWithNewline = chunk[bytesRead - 1] === 0x0a;

			// Once collection and selected-line accounting are both finished, the
			// remaining scan only computes `totalFileLines` — count newlines with
			// native indexOf instead of the per-byte JS loop (a multi-GB tail
			// otherwise stalls the read for seconds to minutes).
			if (doneCollecting && selectedLineLimit !== null && selectedLinesSeen >= selectedLineLimit) {
				if (stopScanAfterCollect) {
					reachedEof = false;
					break;
				}
				let searchFrom = 0;
				let newlineAt = chunk.indexOf(0x0a);
				while (newlineAt !== -1) {
					lineIndex++;
					searchFrom = newlineAt + 1;
					newlineAt = chunk.indexOf(0x0a, searchFrom);
				}
				if (searchFrom === 0) {
					currentLineLength += chunk.length;
				} else {
					currentLineLength = chunk.length - searchFrom;
				}
				continue;
			}

			let start = 0;
			for (let i = 0; i < chunk.length; i++) {
				if (chunk[i] === 0x0a) {
					const segment = chunk.subarray(start, i);
					if (segment.length > 0) {
						appendSegment(segment);
					}
					finalizeLine();
					start = i + 1;
				}
			}

			if (start < chunk.length) {
				appendSegment(chunk.subarray(start));
			}
		}
	} finally {
		if (fileHandle) {
			await fileHandle.close();
		}
	}

	if (reachedEof && (endedWithNewline || currentLineLength > 0 || !sawAnyByte)) {
		finalizeLine();
	}

	let firstLinePreview: { text: string; bytes: number } | undefined;
	if (firstLinePreviewBytes > 0) {
		const { text, bytes } = truncateHeadBytes(Buffer.concat(firstLinePreviewChunks, firstLinePreviewBytes), maxBytes);
		firstLinePreview = { text, bytes };
	}

	return {
		lines: collectedLines,
		totalFileLines: lineIndex,
		collectedBytes,
		stoppedByByteLimit,
		firstLinePreview,
		firstLineByteLength,
		selectedBytesTotal,
		reachedEof,
	};
}

// Maximum image file size (20MB) - larger images will be rejected to prevent OOM during serialization
const MAX_IMAGE_SIZE = MAX_IMAGE_INPUT_BYTES;
const GLOB_TIMEOUT_MS = 5000;

function isNotFoundError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = (error as { code?: string }).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Escape glob metacharacters so a literal path (e.g. `foo[1].ts`) interpolated
 * into a suffix-glob pattern matches itself. Each metachar is wrapped in a
 * character class (the native glob engine rewrites `\` to `/`, so backslash
 * escaping is unavailable). `]`/`}` need no escaping once their openers are
 * neutralized — unmatched closers are literal.
 */
function escapeGlobMetachars(value: string): string {
	return value.replace(/[*?[{]/g, "[$&]");
}

/**
 * Attempt to resolve a non-existent path by finding a unique suffix match within the workspace.
 * Uses a glob suffix pattern so the native engine handles matching directly.
 * Returns null when 0 or >1 candidates match (ambiguous = no auto-resolution).
 */
async function findUniqueSuffixMatch(
	rawPath: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ absolutePath: string; displayPath: string } | null> {
	const normalized = rawPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	if (!normalized) return null;
	const pattern = `**/${escapeGlobMetachars(normalized)}`;

	const timeoutSignal = AbortSignal.timeout(GLOB_TIMEOUT_MS);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	let matches: string[];
	try {
		const result = await untilAborted(combinedSignal, () =>
			glob({
				pattern,
				path: cwd,
				// No fileType filter: matches both files and directories
				hidden: true,
			}),
		);
		matches = result.matches.map(m => m.path);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			if (!signal?.aborted) return null; // timeout — give up silently
			throw new ToolAbortError();
		}
		return null;
	}

	if (matches.length !== 1) return null;

	return {
		absolutePath: path.resolve(cwd, matches[0]),
		displayPath: matches[0],
	};
}

function decodeUtf8Text(bytes: Uint8Array): string | null {
	if (bytes.indexOf(0) !== -1) return null;

	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

function prependSuffixResolutionNotice(text: string, suffixResolution?: { from: string; to: string }): string {
	if (!suffixResolution) return text;

	const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
	return text ? `${notice}\n${text}` : notice;
}
const PDF_IMAGE_PLACEHOLDER_RE = /<!--\s*image:\s*([^\s<>]+)(.*?)-->/g;
const PDF_IMAGE_MEMBER_RE = /^(.*\.pdf):(.*)$/i;
const PDF_IMAGE_MEMBER_EXTENSION_RE = /\.png$/i;

function pdfImageMemberPath(pdfPath: string, imageId: string): string {
	const member = PDF_IMAGE_MEMBER_EXTENSION_RE.test(imageId) ? imageId : `${imageId}.png`;
	return `${pdfPath}:${member}`;
}

function rewritePdfImagePlaceholders(markdown: string, pdfPath: string): string {
	return markdown.replace(PDF_IMAGE_PLACEHOLDER_RE, (_match: string, imageId: string, metadataText: string) => {
		const metadata = metadataText.trim();
		const suffix = metadata.length > 0 ? ` (${metadata})` : "";
		return `Image ${imageId}${suffix}: read \`${pdfImageMemberPath(pdfPath, imageId)}\``;
	});
}

function splitPdfImageMemberReadPath(readPath: string): { pdfPath: string; member: string } | null {
	const match = PDF_IMAGE_MEMBER_RE.exec(readPath);
	if (!match) return null;
	const pdfPath = match[1];
	const member = match[2];
	if (pdfPath === undefined || member === undefined) return null;
	if (member.length !== 0 && !PDF_IMAGE_MEMBER_EXTENSION_RE.test(member)) return null;
	return { pdfPath, member };
}

const readSchema = type({
	path: type("string").describe(
		"Local path, internal URI (e.g. memory://, skill://), or URL. Inline selectors are supported.",
	),
});

export type ReadToolInput = typeof readSchema.infer;

export interface ReadToolDetails {
	kind?: "file" | "url";
	truncation?: TruncationResult;
	isDirectory?: boolean;
	resolvedPath?: string;
	suffixResolution?: { from: string; to: string };
	url?: string;
	finalUrl?: string;
	contentType?: string;
	method?: string;
	notes?: string[];
	meta?: OutputMeta;
	/** Raw text + start line for user-visible TUI rendering, set when content is text-like.
	 * Mirrors the same lines the model receives but without hashline/line-number prefixes,
	 * so the TUI can render the file content with its own gutter without re-parsing the formatted text. */
	displayContent?: {
		text: string;
		startLine: number;
		lineNumbers?: Array<number | null>;
	};
	summary?: { lines: number; elidedSpans: number; elidedLines: number };
	/** Number of unresolved git conflicts surfaced by this read (TUI uses for inline `⚠ N` badge). */
	conflictCount?: number;
	/** Paths recovered from a delimited read argument; used only by the TUI to render one call as multiple read rows. */
	displayReadTargets?: string[];
}

type ReadParams = ReadToolInput;

/** Parsed representation of a path-embedded selector. */
type ParsedSelector =
	| { kind: "none" }
	| { kind: "raw" }
	| { kind: "conflicts" }
	| { kind: "lines"; ranges: [LineRange, ...LineRange[]]; raw?: boolean };

/** Returns true when the selector requested verbatim/raw output (alone or combined with a range). */
function isRawSelector(parsed: ParsedSelector): boolean {
	return parsed.kind === "raw" || (parsed.kind === "lines" && parsed.raw === true);
}

/** Returns true when the selector requested multiple line ranges. */
function isMultiRange(parsed: ParsedSelector): boolean {
	return parsed.kind === "lines" && parsed.ranges.length > 1;
}

function selectorChunkLooksReadLike(chunk: string): boolean {
	const lower = chunk.toLowerCase();
	return (
		lower === "raw" || lower === "conflicts" || /^-\d+(?:[-+]\d+)?$/.test(chunk) || parseLineRanges(chunk) !== null
	);
}

function invalidSelector(sel: string): ToolError {
	return new ToolError(
		`Invalid selector ':${sel}'. Use :N, :N-M, :N+K, :N- (open-ended), a comma-separated list of ranges, :raw, or a range combined with raw (e.g. :raw:50-100).`,
	);
}

function parseSel(sel: string | undefined): ParsedSelector {
	if (!sel || sel.length === 0) return { kind: "none" };

	// Compound selector: `1-50:raw` or `raw:1-50`. Split into chunks and accept
	// exactly one line range (possibly multi) plus the literal `raw`. Selector-like
	// compounds that are not in that accepted set are invalid rather than "none";
	// otherwise `read` can silently widen a malformed selector like
	// `artifact://5:conflicts:1-1` while `grep` rejects it.
	if (sel.includes(":")) {
		const chunks = sel.split(":");
		if (chunks.length === 2) {
			const [a, b] = chunks as [string, string];
			const aIsRaw = a.toLowerCase() === "raw";
			const bIsRaw = b.toLowerCase() === "raw";
			const rangeChunk = aIsRaw ? b : bIsRaw ? a : null;
			const rawChunk = aIsRaw ? a : bIsRaw ? b : null;
			if (rangeChunk !== null && rawChunk !== null) {
				const ranges = parseLineRanges(rangeChunk);
				if (ranges) {
					return { kind: "lines", ranges, raw: true };
				}
			}
		}
		if (chunks.every(selectorChunkLooksReadLike)) throw invalidSelector(sel);
		// Unrecognized compound — fall through (sqlite/archive/url consume their own colon syntax).
		return { kind: "none" };
	}

	if (sel.toLowerCase() === "raw") return { kind: "raw" };
	if (sel.toLowerCase() === "conflicts") return { kind: "conflicts" };
	const ranges = parseLineRanges(sel);
	if (ranges) {
		return { kind: "lines", ranges };
	}
	// Unrecognized selectors fall through; sqlite/archive/url readers consume their own colon syntax.
	return { kind: "none" };
}

/**
 * Convert a single-range selector to the offset/limit pair used by internal pagination.
 * Returns the FIRST range only — multi-range callers MUST branch on `isMultiRange` before
 * calling this helper.
 */
function selToOffsetLimit(parsed: ParsedSelector): { offset?: number; limit?: number } {
	if (parsed.kind === "lines") {
		const first = parsed.ranges[0];
		const limit = first.endLine !== undefined ? first.endLine - first.startLine + 1 : undefined;
		return { offset: first.startLine, limit };
	}
	return {};
}

interface ResolvedArchiveReadPath {
	absolutePath: string;
	archiveSubPath: string;
	suffixResolution?: { from: string; to: string };
}

interface ResolvedSqliteReadPath {
	absolutePath: string;
	sqliteSubPath: string;
	queryString: string;
	suffixResolution?: { from: string; to: string };
}

/** Per-execute memo of suffix-glob lookups; `null` records a confirmed miss. */
type SuffixMatchCache = Map<string, { absolutePath: string; displayPath: string } | null>;

/**
 * Read tool implementation.
 *
 * Reads files with support for images, converted documents (via markit), and text.
 * Directories return a formatted listing with modification times.
 */
export class ReadTool implements AgentTool<typeof readSchema, ReadToolDetails> {
	readonly name = "read";
	readonly approval = (args: unknown): ToolTier =>
		pathTargetsSsh(String((args as { path?: unknown }).path ?? "")) ? "exec" : "read";
	readonly label = "Read";
	readonly loadMode = "essential";
	readonly description: string;
	readonly parameters = readSchema;
	readonly strict = true;

	readonly #autoResizeImages: boolean;
	readonly #defaultLimit: number;
	readonly #inspectImageEnabled: boolean;

	constructor(private readonly session: ToolSession) {
		const displayMode = resolveFileDisplayMode(session);
		this.#autoResizeImages = session.settings.get("images.autoResize");
		this.#defaultLimit = Math.max(
			1,
			Math.min(session.settings.get("read.defaultLimit") ?? DEFAULT_MAX_LINES, DEFAULT_MAX_LINES),
		);
		this.#inspectImageEnabled = session.settings.get("inspect_image.enabled");
		this.description = prompt.render(readDescription, {
			DEFAULT_LIMIT: String(this.#defaultLimit),
			DEFAULT_MAX_LINES: String(DEFAULT_MAX_LINES),
			IS_HL_MODE: displayMode.hashLines,
			IS_LINE_NUMBER_MODE: !displayMode.hashLines && displayMode.lineNumbers,
			INSPECT_IMAGE_ENABLED: this.#inspectImageEnabled,
		});
	}

	/**
	 * Recover the active approved plan when a model rewrites its `local://` URL
	 * as a same-basename path in the working-directory root.
	 *
	 * Only missing cwd-root paths qualify, so a real working-tree file always
	 * wins and unrelated paths cannot escape into the session artifact sandbox.
	 */
	#approvedPlanAlias(missingAbsolutePath: string): string | undefined {
		const planReferencePath = this.session.getPlanReferencePath?.();
		if (!planReferencePath?.startsWith("local:")) return undefined;

		const requestedPath = path.resolve(missingAbsolutePath);
		if (path.dirname(requestedPath) !== path.resolve(this.session.cwd)) return undefined;

		const localProtocolOptions = this.session.localProtocolOptions ?? {
			getArtifactsDir: () => this.session.getArtifactsDir?.() ?? null,
			getSessionId: () => this.session.getSessionId?.() ?? null,
		};
		try {
			const approvedPlanPath = resolveLocalUrlToPath(planReferencePath, localProtocolOptions);
			return path.basename(requestedPath) === path.basename(approvedPlanPath) ? approvedPlanPath : undefined;
		} catch {
			return undefined;
		}
	}

	async #tryReadDelimitedPaths(
		readPath: string,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails> | null> {
		const parts = await splitDelimitedPathEntry(readPath, this.session.cwd);
		if (!parts) return null;

		const notice = `Note: interpreted as ${parts.length} paths: ${parts.join(", ")}`;
		const notes = [notice];
		const content: Array<TextContent | ImageContent> = [];
		const displayReadTargets: string[] = [];
		let pendingText = notice;
		const flushText = () => {
			if (pendingText.length === 0) return;
			content.push({ type: "text", text: pendingText });
			pendingText = "";
		};
		const appendText = (text: string) => {
			pendingText = pendingText.length > 0 ? `${pendingText}\n\n${text}` : text;
		};

		for (const part of parts) {
			try {
				const result = await this.execute("read-delimited-part", { path: part }, signal);
				displayReadTargets.push(result.details?.suffixResolution?.to ?? part);
				for (const block of result.content) {
					if (block.type === "text") {
						appendText(block.text);
						continue;
					}
					flushText();
					content.push(block);
				}
			} catch (error) {
				if (error instanceof ToolAbortError || signal?.aborted) throw error;
				const message = error instanceof Error ? error.message : String(error);
				const errorNote = `Could not read ${part}: ${message}`;
				notes.push(errorNote);
				displayReadTargets.push(part);
				appendText(`[${errorNote}]`);
			}
		}
		flushText();

		return toolResult<ReadToolDetails>({ notes, displayReadTargets }).content(content).done();
	}

	/**
	 * Memoized {@link findUniqueSuffixMatch} for a single read call. A missing
	 * path with archive/sqlite extensions probes the workspace once per stage
	 * (archive candidates, sqlite candidates, plain path) — each glob carries a
	 * 5s timeout, so repeated lookups of the same string stack into a long
	 * stall before erroring. The cache collapses repeats within one execute().
	 */
	async #findSuffixMatchCached(
		cache: SuffixMatchCache,
		rawPath: string,
		signal?: AbortSignal,
	): Promise<{ absolutePath: string; displayPath: string } | null> {
		const hit = cache.get(rawPath);
		if (hit !== undefined) return hit;
		const result = await findUniqueSuffixMatch(rawPath, this.session.cwd, signal);
		cache.set(rawPath, result);
		return result;
	}

	async #resolveArchiveReadPath(
		readPath: string,
		suffixCache: SuffixMatchCache,
		signal?: AbortSignal,
	): Promise<ResolvedArchiveReadPath | null> {
		const candidates = parseArchivePathCandidates(readPath);
		for (const candidate of candidates) {
			let absolutePath = resolveReadPath(candidate.archivePath, this.session.cwd);
			let suffixResolution: { from: string; to: string } | undefined;

			try {
				const stat = await Bun.file(absolutePath).stat();
				if (stat.isDirectory()) continue;
				return {
					absolutePath,
					archiveSubPath: candidate.archivePath === readPath ? "" : candidate.subPath,
					suffixResolution,
				};
			} catch (error) {
				if (!isNotFoundError(error) || isRemoteMountPath(absolutePath)) continue;

				const suffixMatch = await this.#findSuffixMatchCached(suffixCache, candidate.archivePath, signal);
				if (!suffixMatch) continue;

				try {
					const retryStat = await Bun.file(suffixMatch.absolutePath).stat();
					if (retryStat.isDirectory()) continue;

					absolutePath = suffixMatch.absolutePath;
					suffixResolution = { from: candidate.archivePath, to: suffixMatch.displayPath };
					return {
						absolutePath,
						archiveSubPath: candidate.archivePath === readPath ? "" : candidate.subPath,
						suffixResolution,
					};
				} catch (retryError) {
					if (!isNotFoundError(retryError)) {
						throw retryError;
					}
				}
			}
		}

		return null;
	}

	async #resolveSqliteReadPath(
		readPath: string,
		suffixCache: SuffixMatchCache,
		signal?: AbortSignal,
	): Promise<ResolvedSqliteReadPath | null> {
		const candidates = parseSqlitePathCandidates(readPath);
		for (const candidate of candidates) {
			let absolutePath = resolveReadPath(candidate.sqlitePath, this.session.cwd);
			let suffixResolution: { from: string; to: string } | undefined;

			try {
				const stat = await Bun.file(absolutePath).stat();
				if (stat.isDirectory()) continue;
				if (!(await isSqliteFile(absolutePath))) continue;

				return {
					absolutePath,
					sqliteSubPath: candidate.subPath,
					queryString: candidate.queryString,
					suffixResolution,
				};
			} catch (error) {
				if (!isNotFoundError(error) || isRemoteMountPath(absolutePath)) continue;

				const suffixMatch = await this.#findSuffixMatchCached(suffixCache, candidate.sqlitePath, signal);
				if (!suffixMatch) continue;

				try {
					const retryStat = await Bun.file(suffixMatch.absolutePath).stat();
					if (retryStat.isDirectory()) continue;
					if (!(await isSqliteFile(suffixMatch.absolutePath))) continue;

					absolutePath = suffixMatch.absolutePath;
					suffixResolution = { from: candidate.sqlitePath, to: suffixMatch.displayPath };
					return {
						absolutePath,
						sqliteSubPath: candidate.subPath,
						queryString: candidate.queryString,
						suffixResolution,
					};
				} catch (retryError) {
					if (!isNotFoundError(retryError)) {
						throw retryError;
					}
				}
			}
		}

		return null;
	}

	#pdfImageCacheDir(absolutePdfPath: string): string {
		const artifactsDir = this.session.getArtifactsDir?.();
		let root = artifactsDir ?? undefined;
		if (root === undefined) {
			const sessionFile = this.session.getSessionFile();
			root = sessionFile?.endsWith(".jsonl")
				? sessionFile.slice(0, -6)
				: path.join(os.tmpdir(), "omp-read-pdf-images");
		}
		const basename = path.basename(absolutePdfPath).replace(/[^A-Za-z0-9._-]/g, "_");
		return path.join(root, "read-pdf-images", `${basename}-${Bun.hash(absolutePdfPath).toString(36)}`);
	}

	async #listPdfImageMembers(imageDir: string): Promise<string[]> {
		try {
			const entries = await fs.readdir(imageDir, { withFileTypes: true });
			const members: string[] = [];
			for (const entry of entries) {
				if (entry.isFile() && PDF_IMAGE_MEMBER_EXTENSION_RE.test(entry.name)) members.push(entry.name);
			}
			return members.sort();
		} catch (error) {
			if (isNotFoundError(error)) return [];
			throw error;
		}
	}

	async #ensurePdfImageCache(absolutePdfPath: string, signal?: AbortSignal): Promise<string> {
		const imageDir = this.#pdfImageCacheDir(absolutePdfPath);
		const markerPath = path.join(imageDir, ".extracted");
		try {
			await fs.stat(markerPath);
			return imageDir;
		} catch (error) {
			if (!isNotFoundError(error)) throw error;
		}

		await fs.rm(imageDir, { recursive: true, force: true });
		await fs.mkdir(imageDir, { recursive: true });
		const result = await convertFileWithMarkit(absolutePdfPath, signal, { imageDir });
		if (!result.ok) {
			await fs.rm(imageDir, { recursive: true, force: true });
			throw new ToolError(`Cannot extract images from PDF: ${result.error ?? "conversion failed"}`);
		}
		await Bun.write(markerPath, "ok");
		return imageDir;
	}

	async #readPdfImageMember(
		absolutePdfPath: string,
		pdfDisplayPath: string,
		member: string,
		suffixResolution: { from: string; to: string } | undefined,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const imageDir = await this.#ensurePdfImageCache(absolutePdfPath, signal);
		const members = await this.#listPdfImageMembers(imageDir);
		if (member.length === 0) {
			const text =
				members.length === 0
					? "No extractable PDF image members found."
					: `Extractable PDF image members:\n${members
							.map(imageMember => `- read \`${pdfDisplayPath}:${imageMember}\``)
							.join("\n")}`;
			return toolResult<ReadToolDetails>({ resolvedPath: absolutePdfPath, suffixResolution })
				.text(prependSuffixResolutionNotice(text, suffixResolution))
				.sourcePath(absolutePdfPath)
				.done();
		}

		if (!members.includes(member)) {
			const available = members.length === 0 ? "(none)" : members.join(", ");
			throw new ToolError(`PDF image member '${member}' not found. Available members: ${available}`);
		}

		const imagePath = path.join(imageDir, member);
		const imageStat = await Bun.file(imagePath).stat();
		if (imageStat.size > MAX_IMAGE_SIZE) {
			const sizeStr = formatBytes(imageStat.size);
			const maxStr = formatBytes(MAX_IMAGE_SIZE);
			throw new ToolError(`Image file too large: ${sizeStr} exceeds ${maxStr} limit.`);
		}
		const metadata = await readImageMetadata(imagePath);
		const mimeType = metadata?.mimeType;
		if (!mimeType) throw new ToolError(`PDF image member '${member}' is not a supported image.`);
		const imageInput = await loadImageInput({
			path: `${pdfDisplayPath}:${member}`,
			cwd: this.session.cwd,
			autoResize: this.#autoResizeImages,
			maxBytes: MAX_IMAGE_SIZE,
			resolvedPath: imagePath,
			detectedMimeType: mimeType,
			excludeWebP: webpExclusionForModel(this.session.getActiveModel?.()),
		});
		if (!imageInput) {
			throw new ToolError(`Read image file [${mimeType}] failed: unsupported image format.`);
		}
		const textNote = prependSuffixResolutionNotice(imageInput.textNote, suffixResolution);
		return toolResult<ReadToolDetails>({ resolvedPath: absolutePdfPath, suffixResolution })
			.content([
				{ type: "text", text: textNote },
				{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType },
			])
			.sourcePath(imageInput.resolvedPath)
			.done();
	}

	/**
	 * Build content blocks for an on-disk image file: an `inspect_image`
	 * metadata note when inspection is enabled, otherwise the decoded image
	 * block. Shared by the plain-file read path and the `local://` image fast
	 * path so both honor `inspect_image.enabled`, the size cap, and auto-resize
	 * identically. Too-large / unsupported images surface as {@link ToolError}.
	 */
	async #loadImageContent(options: {
		readPath: string;
		absolutePath: string;
		mimeType: string;
		imageMetadata: ImageMetadata | null;
		fileSize: number;
	}): Promise<{ content: Array<TextContent | ImageContent>; details: ReadToolDetails; sourcePath: string }> {
		const { readPath, absolutePath, mimeType, imageMetadata, fileSize } = options;
		if (this.#inspectImageEnabled) {
			const outputMime = imageMetadata?.mimeType ?? mimeType;
			const metadataLines = [
				"Image metadata:",
				`- MIME: ${outputMime}`,
				`- Bytes: ${fileSize} (${formatBytes(fileSize)})`,
				imageMetadata?.width !== undefined && imageMetadata.height !== undefined
					? `- Dimensions: ${imageMetadata.width}x${imageMetadata.height}`
					: "- Dimensions: unknown",
				imageMetadata?.channels !== undefined ? `- Channels: ${imageMetadata.channels}` : "- Channels: unknown",
				imageMetadata?.hasAlpha === true
					? "- Alpha: yes"
					: imageMetadata?.hasAlpha === false
						? "- Alpha: no"
						: "- Alpha: unknown",
				"",
				`If you want to analyze the image, call inspect_image with path="${formatPathRelativeToCwd(
					absolutePath,
					this.session.cwd,
				)}" and a question describing what to inspect and the desired output format.`,
			];
			return { content: [{ type: "text", text: metadataLines.join("\n") }], details: {}, sourcePath: absolutePath };
		}

		if (fileSize > MAX_IMAGE_SIZE) {
			const sizeStr = formatBytes(fileSize);
			const maxStr = formatBytes(MAX_IMAGE_SIZE);
			throw new ToolError(`Image file too large: ${sizeStr} exceeds ${maxStr} limit.`);
		}
		try {
			const imageInput = await loadImageInput({
				path: readPath,
				cwd: this.session.cwd,
				autoResize: this.#autoResizeImages,
				maxBytes: MAX_IMAGE_SIZE,
				resolvedPath: absolutePath,
				detectedMimeType: mimeType,
				excludeWebP: webpExclusionForModel(this.session.getActiveModel?.()),
			});
			if (!imageInput) {
				throw new ToolError(`Read image file [${mimeType}] failed: unsupported image format.`);
			}
			return {
				content: [
					{ type: "text", text: imageInput.textNote },
					{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType },
				],
				details: {},
				sourcePath: imageInput.resolvedPath,
			};
		} catch (error) {
			if (error instanceof ImageInputTooLargeError) {
				throw new ToolError(error.message);
			}
			throw error;
		}
	}

	#buildInMemoryTextResult(
		text: string,
		offset: number | undefined,
		limit: number | undefined,
		options: {
			details?: ReadToolDetails;
			sourcePath?: string;
			sourceUrl?: string;
			sourceInternal?: string;
			entityLabel: string;
			ignoreResultLimits?: boolean;
			raw?: boolean;
			immutable?: boolean;
		},
	): AgentToolResult<ReadToolDetails> {
		const displayMode = resolveFileDisplayMode(this.session, { raw: options.raw, immutable: options.immutable });
		const details = options.details ?? {};
		const allLines = text.split("\n");
		const totalLines = allLines.length;
		// User-requested 0-indexed range start. Lines BEFORE this are leading
		// context (added below if offset is explicit).
		const requestedStart = offset ? Math.max(0, offset - 1) : 0;
		const ignoreResultLimits = options.ignoreResultLimits ?? false;
		const requestedEnd = limit !== undefined ? Math.min(requestedStart + limit, allLines.length) : allLines.length;
		// Expand only on sides the user actually constrained: leading context
		// when offset>1, trailing context when a finite limit was set. Raw mode
		// never expands — without line numbers the padding is indistinguishable
		// from requested content, so `raw:31-31` must return line 31 and nothing
		// else (verbatim-extraction contract).
		const rawDisplay = options.raw === true;
		const expanded = expandRangeWithContext(
			requestedStart,
			requestedEnd,
			allLines.length,
			!rawDisplay && offset !== undefined && offset > 1,
			!rawDisplay && limit !== undefined,
		);
		const startLine = expanded.startLine;
		const endLineExpanded = expanded.endLine;
		const startLineDisplay = startLine + 1;

		const resultBuilder = toolResult(details);
		if (options.sourcePath) {
			resultBuilder.sourcePath(options.sourcePath);
		}
		if (options.sourceUrl) {
			resultBuilder.sourceUrl(options.sourceUrl);
		}
		if (options.sourceInternal) {
			resultBuilder.sourceInternal(options.sourceInternal);
		}

		if (requestedStart >= allLines.length) {
			const suggestion =
				allLines.length === 0
					? `The ${options.entityLabel} is empty.`
					: `Use :1 to read from the start, or :${allLines.length} to read the last line.`;
			return resultBuilder
				.text(
					`Line ${requestedStart + 1} is beyond end of ${options.entityLabel} (${allLines.length} lines total). ${suggestion}`,
				)
				.done();
		}

		const endLine = endLineExpanded;
		const selectedContent = allLines.slice(startLine, endLine).join("\n");
		const userLimitedLines = limit !== undefined ? endLine - startLine : undefined;
		const truncation = ignoreResultLimits ? noTruncResult(selectedContent) : truncateHead(selectedContent);

		const shouldAddHashLines = displayMode.hashLines;
		const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;
		const hashContext =
			shouldAddHashLines && options.sourcePath
				? recordFullHashlineContext(
						this.session,
						options.sourcePath,
						formatPathRelativeToCwd(options.sourcePath, this.session.cwd),
						text,
					)
				: undefined;
		let emittedHashlineHeader = false;
		let seenLines: number[] | undefined;
		let rawSeenLines: number[] | undefined;
		const formatText = (content: string, startNum: number): string => {
			const lineCount = countTextLines(content);
			details.displayContent = {
				text: content,
				startLine: startNum,
				lineNumbers: Array.from({ length: lineCount }, (_, i) => startNum + i),
			};
			if (shouldAddHashLines) seenLines = contiguousLineNumbers(startNum, lineCount);
			const formatted = formatTextWithMode(content, startNum, shouldAddHashLines, shouldAddLineNumbers);
			if (!hashContext || emittedHashlineHeader) return formatted;
			emittedHashlineHeader = true;
			return prependHashlineHeader(formatted, hashContext);
		};
		const formatLineEntries = (entries: readonly LineEntry[], startNum: number): string => {
			const firstLine = entries.find(entry => entry.kind === "line");
			details.displayContent = {
				text: lineEntriesToPlainText(entries, BRACKET_CONTEXT_ELLIPSIS),
				startLine: firstLine?.kind === "line" ? firstLine.lineNumber : startNum,
				lineNumbers: entries.map(entry => (entry.kind === "line" ? entry.lineNumber : null)),
			};
			if (shouldAddHashLines) seenLines = lineNumbersFromEntries(entries);
			const formatted = formatLineEntriesWithMode(entries, shouldAddHashLines, shouldAddLineNumbers);
			if (!hashContext || emittedHashlineHeader) return formatted;
			emittedHashlineHeader = true;
			return prependHashlineHeader(formatted, hashContext);
		};
		const buildLineEntries = (endLineDisplay: number): LineEntry[] =>
			buildLineEntriesWithBlockContext(allLines, [{ startLine: startLineDisplay, endLine: endLineDisplay }], {
				path: options.sourcePath,
			});

		let outputText: string;
		let truncationInfo:
			| { result: TruncationResult; options: { direction: "head"; startLine?: number; totalFileLines?: number } }
			| undefined;

		if (truncation.firstLineExceedsLimit) {
			const firstLine = allLines[startLine] ?? "";
			const firstLineBytes = Buffer.byteLength(firstLine, "utf-8");
			const snippet = truncateHeadBytes(firstLine, DEFAULT_MAX_BYTES);

			if (shouldAddHashLines) {
				outputText = `[Line ${startLineDisplay} is ${formatBytes(
					firstLineBytes,
				)}, exceeds ${formatBytes(DEFAULT_MAX_BYTES)} limit. Hashline output requires full lines; cannot emit an editable numbered preview for a truncated line.]`;
			} else {
				outputText = formatText(snippet.text, startLineDisplay);
			}

			if (snippet.text.length === 0) {
				outputText = `[Line ${startLineDisplay} is ${formatBytes(
					firstLineBytes,
				)}, exceeds ${formatBytes(DEFAULT_MAX_BYTES)} limit. Unable to display a valid UTF-8 snippet.]`;
			}

			details.truncation = truncation;
			truncationInfo = {
				result: truncation,
				options: { direction: "head", startLine: startLineDisplay, totalFileLines: totalLines },
			};
		} else if (truncation.truncated) {
			const outputLines = truncation.outputLines ?? countTextLines(truncation.content);
			const endLineDisplay = startLineDisplay + Math.max(0, outputLines - 1);
			if (options.raw === true) {
				rawSeenLines = contiguousLineNumbers(startLineDisplay, outputLines);
				outputText = formatText(truncation.content, startLineDisplay);
			} else {
				outputText = formatLineEntries(buildLineEntries(endLineDisplay), startLineDisplay);
			}
			details.truncation = truncation;
			truncationInfo = {
				result: truncation,
				options: { direction: "head", startLine: startLineDisplay, totalFileLines: totalLines },
			};
		} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
			const remaining = allLines.length - (startLine + userLimitedLines);
			const nextOffset = startLine + userLimitedLines + 1;

			if (options.raw === true) {
				rawSeenLines = contiguousLineNumbers(startLineDisplay, userLimitedLines);
				outputText = formatText(selectedContent, startLineDisplay);
			} else {
				outputText = formatLineEntries(buildLineEntries(endLine), startLineDisplay);
			}
			outputText += `\n\n[${remaining} more lines in ${options.entityLabel}. Use :${nextOffset} to continue]`;
		} else {
			if (options.raw === true) {
				rawSeenLines = contiguousLineNumbers(startLineDisplay, endLine - startLine);
				outputText = formatText(truncation.content, startLineDisplay);
			} else {
				outputText = formatLineEntries(buildLineEntries(endLine), startLineDisplay);
			}
		}

		if (hashContext?.tag && options.sourcePath && seenLines) {
			recordSeenLines(this.session, options.sourcePath, hashContext.tag, seenLines);
		}
		if (options.raw === true && options.sourcePath && options.immutable !== true && rawSeenLines) {
			recordInMemorySeenLines(this.session, options.sourcePath, text, rawSeenLines);
		}
		resultBuilder.text(outputText);
		if (truncationInfo) {
			resultBuilder.truncation(truncationInfo.result, truncationInfo.options);
		}
		return resultBuilder.done();
	}

	/**
	 * Render a multi-range read against in-memory text. Each range emits a
	 * formatted block with its own anchors / line numbers, blocks are joined
	 * with an elision separator, and ranges past EOF surface as `[…]` notices
	 * so the model can correct the next call. No leading/trailing context is
	 * added — multi-range callers always specify exact bounds.
	 */
	#buildInMemoryMultiRangeResult(
		text: string,
		ranges: readonly LineRange[],
		options: {
			details?: ReadToolDetails;
			sourcePath?: string;
			sourceUrl?: string;
			sourceInternal?: string;
			entityLabel: string;
			raw?: boolean;
			immutable?: boolean;
		},
	): AgentToolResult<ReadToolDetails> {
		const displayMode = resolveFileDisplayMode(this.session, { raw: options.raw, immutable: options.immutable });
		const details = options.details ?? {};
		const allLines = text.split("\n");
		const totalLines = allLines.length;
		const shouldAddHashLines = displayMode.hashLines;
		const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;
		const hashContext =
			shouldAddHashLines && options.sourcePath
				? recordFullHashlineContext(
						this.session,
						options.sourcePath,
						formatPathRelativeToCwd(options.sourcePath, this.session.cwd),
						text,
					)
				: undefined;
		let emittedHashlineHeader = false;

		let seenLines: number[] | undefined;
		const resultBuilder = toolResult(details);
		if (options.sourcePath) resultBuilder.sourcePath(options.sourcePath);
		if (options.sourceUrl) resultBuilder.sourceUrl(options.sourceUrl);
		if (options.sourceInternal) resultBuilder.sourceInternal(options.sourceInternal);

		const outOfBounds: LineRange[] = [];
		const visibleSpans: Array<{ startLine: number; endLine: number }> = [];
		const rawParts: string[] = [];
		for (const range of ranges) {
			if (range.startLine > totalLines) {
				outOfBounds.push(range);
				continue;
			}
			const effectiveEnd = Math.min(range.endLine ?? totalLines, totalLines);
			visibleSpans.push({ startLine: range.startLine, endLine: effectiveEnd });
			if (options.raw === true) {
				rawParts.push(allLines.slice(range.startLine - 1, effectiveEnd).join("\n"));
			}
		}

		let outputText = "";
		if (options.raw === true) {
			outputText = rawParts.length > 0 ? rawParts.join("\n\n…\n\n") : "";
		} else if (visibleSpans.length > 0) {
			const entries = buildLineEntriesWithBlockContext(allLines, visibleSpans, { path: options.sourcePath });
			if (shouldAddHashLines) seenLines = lineNumbersFromEntries(entries);
			const firstLine = entries.find(entry => entry.kind === "line");
			if (firstLine?.kind === "line") {
				details.displayContent = {
					text: lineEntriesToPlainText(entries, BRACKET_CONTEXT_ELLIPSIS),
					startLine: firstLine.lineNumber,
					lineNumbers: entries.map(entry => (entry.kind === "line" ? entry.lineNumber : null)),
				};
			}
			const formatted = formatLineEntriesWithMode(entries, shouldAddHashLines, shouldAddLineNumbers);
			outputText = hashContext && !emittedHashlineHeader ? prependHashlineHeader(formatted, hashContext) : formatted;
			if (hashContext) emittedHashlineHeader = true;
		}
		const notices: string[] = [];
		for (const range of outOfBounds) {
			const bound = range.endLine !== undefined ? `${range.startLine}-${range.endLine}` : `${range.startLine}`;
			notices.push(`[Range ${bound} is beyond end of ${options.entityLabel} (${totalLines} lines total); skipped]`);
		}
		const finalText =
			notices.length > 0 ? (outputText ? `${outputText}\n${notices.join("\n")}` : notices.join("\n")) : outputText;
		if (hashContext?.tag && options.sourcePath && seenLines) {
			recordSeenLines(this.session, options.sourcePath, hashContext.tag, seenLines);
		}
		if (options.raw === true && options.sourcePath && options.immutable !== true && visibleSpans.length > 0) {
			recordInMemorySeenLines(this.session, options.sourcePath, text, lineNumbersFromSpans(visibleSpans));
		}
		resultBuilder.text(finalText);
		return resultBuilder.done();
	}

	/**
	 * Stream multiple non-contiguous ranges from a local file. ACP bridge takes
	 * priority when present (editor buffer is source of truth); otherwise each
	 * range is streamed independently with its own line/byte budget. Out-of-bounds
	 * ranges surface as inline notices rather than aborting the read.
	 */
	async #readLocalFileMultiRange(
		absolutePath: string,
		ranges: readonly LineRange[],
		fileSize: number,
		parsed: ParsedSelector,
		displayMode: { hashLines: boolean; lineNumbers: boolean },
		suffixResolution: { from: string; to: string } | undefined,
		signal: AbortSignal | undefined,
		allowBridge = true,
	): Promise<{
		outputText: string;
		columnTruncated: number;
		displayContent?: { text: string; startLine: number; lineNumbers?: Array<number | null> };
		bridgeResult?: AgentToolResult<ReadToolDetails>;
	}> {
		const rawSelector = isRawSelector(parsed);

		// ACP bridge first — the editor's in-memory buffer is source of truth.
		const bridgePromise = allowBridge ? this.#routeReadThroughBridge(absolutePath) : undefined;
		if (bridgePromise !== undefined) {
			try {
				const bridgeText = await bridgePromise;
				const bridgeResult = this.#buildInMemoryMultiRangeResult(bridgeText, ranges, {
					details: { resolvedPath: absolutePath, suffixResolution },
					sourcePath: absolutePath,
					entityLabel: "file",
					raw: rawSelector,
				});
				if (suffixResolution) {
					const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
					const firstText = bridgeResult.content.find((c): c is TextContent => c.type === "text");
					if (firstText) firstText.text = `${notice}\n${firstText.text}`;
				}
				return { outputText: "", columnTruncated: 0, bridgeResult };
			} catch (error) {
				logger.warn("ACP fs readTextFile failed; falling back to disk", { path: absolutePath, error });
			}
		}

		const shouldAddHashLines = !rawSelector && displayMode.hashLines;
		const shouldAddLineNumbers = rawSelector ? false : shouldAddHashLines ? false : displayMode.lineNumbers;
		const maxColumns = resolveOutputMaxColumns(this.session.settings);

		const blocks: string[] = [];
		const notices: string[] = [];
		const visibleSpans: Array<{ startLine: number; endLine: number }> = [];
		const displayLineByNumber = new Map<number, string>();
		const fullLines = rawSelector ? undefined : await readBracketContextFullLines(absolutePath, fileSize);
		let columnTruncated = 0;
		let displayContent: { text: string; startLine: number; lineNumbers?: Array<number | null> } | undefined;

		for (const range of ranges) {
			const rangeStart = range.startLine - 1; // 0-indexed
			const requestedLength = range.endLine !== undefined ? range.endLine - range.startLine + 1 : this.#defaultLimit;
			const maxLines = Math.min(requestedLength, DEFAULT_MAX_LINES);

			// When the full file is already in memory (the common case for files
			// within the snapshot byte cap), slice ranges from it instead of
			// re-streaming the file once per range.
			let collectedLines: string[];
			let totalFileLines: number;
			if (fullLines) {
				totalFileLines = fullLines.length;
				collectedLines = fullLines.slice(rangeStart, rangeStart + maxLines);
			} else {
				const maxBytesForRead = Math.max(DEFAULT_MAX_BYTES, maxLines * 512);
				const streamResult = await streamLinesFromFile(
					absolutePath,
					rangeStart,
					maxLines,
					maxBytesForRead,
					maxLines,
					signal,
					fileSize > SNAPSHOT_MAX_BYTES, // giant file: collected ranges don't need an exact EOF line count
				);
				totalFileLines = streamResult.totalFileLines;
				collectedLines = streamResult.lines;
			}

			if (rangeStart >= totalFileLines) {
				const bound = range.endLine !== undefined ? `${range.startLine}-${range.endLine}` : `${range.startLine}`;
				notices.push(`[Range ${bound} is beyond end of file (${totalFileLines} lines total); skipped]`);
				continue;
			}

			// Column truncation is display-only; clone before stamping ellipsis so
			// the original on-disk lines stay intact for display reconstruction.
			let displayLines: string[] = collectedLines;
			if (!rawSelector && maxColumns > 0) {
				let cloned: string[] | undefined;
				for (let i = 0; i < collectedLines.length; i++) {
					const { text, wasTruncated } = truncateLine(collectedLines[i], maxColumns);
					if (wasTruncated) {
						if (!cloned) cloned = collectedLines.slice();
						cloned[i] = text;
						columnTruncated = maxColumns;
					}
				}
				if (cloned) displayLines = cloned;
			}
			if (displayLines.length > 0) {
				const endLine = range.startLine + displayLines.length - 1;
				visibleSpans.push({ startLine: range.startLine, endLine });
				for (let i = 0; i < displayLines.length; i++) {
					displayLineByNumber.set(range.startLine + i, displayLines[i] ?? "");
				}
				if (!fullLines || rawSelector) {
					const blockText = displayLines.join("\n");
					blocks.push(formatTextWithMode(blockText, range.startLine, shouldAddHashLines, shouldAddLineNumbers));
				}
			}
		}

		let outputText: string;
		if (!rawSelector && fullLines && visibleSpans.length > 0) {
			const entries = buildLineEntriesWithBlockContext(
				fullLines,
				visibleSpans,
				{ path: absolutePath },
				{
					lineText: (lineNumber, sourceText) => {
						const visibleText = displayLineByNumber.get(lineNumber);
						if (visibleText !== undefined) return visibleText;
						if (maxColumns <= 0) return sourceText;
						const truncated = truncateLine(sourceText, maxColumns);
						if (truncated.wasTruncated) {
							columnTruncated = maxColumns;
						}
						return truncated.text;
					},
				},
			);
			const firstLine = entries.find(entry => entry.kind === "line");
			displayContent = {
				text: lineEntriesToPlainText(entries, BRACKET_CONTEXT_ELLIPSIS),
				startLine: firstLine?.kind === "line" ? firstLine.lineNumber : (visibleSpans[0]?.startLine ?? 1),
				lineNumbers: entries.map(entry => (entry.kind === "line" ? entry.lineNumber : null)),
			};
			outputText = formatLineEntriesWithMode(entries, shouldAddHashLines, shouldAddLineNumbers);
		} else {
			outputText = blocks.join("\n\n…\n\n");
		}
		if (shouldAddHashLines && outputText) {
			const tag = await recordFileSnapshot(this.session, absolutePath);
			if (tag) {
				recordSeenLinesFromBody(this.session, absolutePath, tag, outputText);
				outputText = `${formatReadHashlineHeader(formatPathRelativeToCwd(absolutePath, this.session.cwd), tag)}\n${outputText}`;
			}
		} else if (rawSelector && visibleSpans.length > 0) {
			const rawSeenLines = lineNumbersFromSpans(visibleSpans);
			if (rawSeenLines.length > 0) await recordFileSnapshot(this.session, absolutePath, rawSeenLines);
		}
		if (notices.length > 0) {
			outputText = outputText ? `${outputText}\n${notices.join("\n")}` : notices.join("\n");
		}
		return { outputText, columnTruncated, displayContent };
	}

	async #readArchiveDirectory(
		archive: ArchiveReader,
		archivePath: string,
		subPath: string,
		offset: number | undefined,
		limit: number | undefined,
		details: ReadToolDetails,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const DEFAULT_LIMIT = 500;
		const effectiveLimit = limit ?? DEFAULT_LIMIT;
		const allEntries = archive.listDirectory(subPath);
		// `offset` is 1-indexed (line-selector semantics): `a.zip:dir:50` starts
		// the listing at the 50th entry instead of being silently ignored.
		const entries = offset !== undefined && offset > 1 ? allEntries.slice(offset - 1) : allEntries;

		const listLimit = applyListLimit(entries, { limit: effectiveLimit });
		const limitedEntries = listLimit.items;
		const limitMeta = listLimit.meta;

		for (let index = 0; index < limitedEntries.length; index++) {
			throwIfAborted(signal);
		}
		const results = formatArchiveEntryLines(limitedEntries);

		const output = results.length > 0 ? results.join("\n") : "(empty archive directory)";
		const text = prependSuffixResolutionNotice(output, details.suffixResolution);
		const truncation = truncateHead(text, { maxLines: Number.MAX_SAFE_INTEGER });
		const directoryDetails: ReadToolDetails = { ...details, isDirectory: true };
		const resultBuilder = toolResult<ReadToolDetails>(directoryDetails).text(truncation.content);
		resultBuilder.sourcePath(archivePath).limits({ resultLimit: limitMeta.resultLimit?.reached });
		if (truncation.truncated) {
			directoryDetails.truncation = truncation;
			resultBuilder.truncation(truncation, { direction: "head" });
		}
		return resultBuilder.done();
	}

	async #readArchive(
		readPath: string,
		parsedSel: ParsedSelector,
		resolvedArchivePath: ResolvedArchiveReadPath,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		throwIfAborted(signal);
		const archive = await openArchive(resolvedArchivePath.absolutePath);
		throwIfAborted(signal);

		const details: ReadToolDetails = {
			resolvedPath: resolvedArchivePath.absolutePath,
			suffixResolution: resolvedArchivePath.suffixResolution,
		};

		let archiveSubPath = resolvedArchivePath.archiveSubPath;
		let sel = parsedSel;
		let node = archive.getNode(archiveSubPath);
		if (!node && archiveSubPath) {
			// `archive.zip:500` / `archive.zip:raw`: the whole subPath is a
			// selector on the archive root, not a member name. Member names take
			// precedence (getNode above); fall back to root + selector.
			const wholeSel = parseSel(archiveSubPath);
			if (wholeSel.kind !== "none") {
				node = archive.getNode("");
				archiveSubPath = "";
				sel = wholeSel;
			}
		}
		if (!node) {
			throw new ToolError(`Path '${readPath}' not found inside archive`);
		}

		if (node.isDirectory) {
			if (isMultiRange(sel)) {
				throw new ToolError("Multi-range line selectors are not supported for archive directory listings.");
			}
			const { offset, limit } = selToOffsetLimit(sel);
			return this.#readArchiveDirectory(
				archive,
				resolvedArchivePath.absolutePath,
				archiveSubPath,
				offset,
				limit,
				details,
				signal,
			);
		}

		const entry = await archive.readFile(archiveSubPath);
		const text = decodeUtf8Text(entry.bytes);
		if (text === null) {
			return toolResult<ReadToolDetails>(details)
				.text(
					prependSuffixResolutionNotice(
						`[Cannot read binary archive entry '${entry.path}' (${formatBytes(entry.size)})]`,
						resolvedArchivePath.suffixResolution,
					),
				)
				.sourcePath(resolvedArchivePath.absolutePath)
				.done();
		}

		// Archive members are immutable: there is no edit path for bytes inside
		// an archive, and a hashline tag keyed to the archive file would invite
		// (and fail) edits while clobbering sibling members' snapshots.
		const raw = isRawSelector(sel);
		const result =
			isMultiRange(sel) && sel.kind === "lines"
				? this.#buildInMemoryMultiRangeResult(text, sel.ranges, {
						details,
						sourcePath: resolvedArchivePath.absolutePath,
						entityLabel: "archive entry",
						raw,
						immutable: true,
					})
				: this.#buildInMemoryTextResult(text, selToOffsetLimit(sel).offset, selToOffsetLimit(sel).limit, {
						details,
						sourcePath: resolvedArchivePath.absolutePath,
						entityLabel: "archive entry",
						raw,
						immutable: true,
					});
		const firstText = result.content.find((content): content is TextContent => content.type === "text");
		if (firstText) {
			firstText.text = prependSuffixResolutionNotice(firstText.text, resolvedArchivePath.suffixResolution);
		}
		return result;
	}

	async #readSqlite(
		resolvedSqlitePath: ResolvedSqliteReadPath,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		throwIfAborted(signal);

		const selectorInput = {
			subPath: resolvedSqlitePath.sqliteSubPath,
			queryString: resolvedSqlitePath.queryString,
		};
		const selector = parseSqliteSelector(selectorInput.subPath, selectorInput.queryString);
		const details: ReadToolDetails = {
			resolvedPath: resolvedSqlitePath.absolutePath,
			suffixResolution: resolvedSqlitePath.suffixResolution,
		};

		let db: Database | null = null;
		try {
			db = new Database(resolvedSqlitePath.absolutePath, { readonly: true, strict: true });
			db.run("PRAGMA busy_timeout = 3000");
			throwIfAborted(signal);

			switch (selector.kind) {
				case "list": {
					const listLimit = applyListLimit(listTables(db), { limit: 500 });
					const output = prependSuffixResolutionNotice(
						renderTableList(listLimit.items),
						resolvedSqlitePath.suffixResolution,
					);
					const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
					details.truncation = truncation.truncated ? truncation : undefined;
					const resultBuilder = toolResult<ReadToolDetails>(details)
						.text(truncation.content)
						.sourcePath(resolvedSqlitePath.absolutePath)
						.limits({ resultLimit: listLimit.meta.resultLimit?.reached });
					if (truncation.truncated) {
						resultBuilder.truncation(truncation, { direction: "head" });
					}
					return resultBuilder.done();
				}
				case "schema": {
					const sampleRows = queryRows(db, selector.table, { limit: selector.sampleLimit, offset: 0 });
					let output = renderSchema(getTableSchema(db, selector.table), {
						columns: sampleRows.columns,
						rows: sampleRows.rows,
					});
					if (sampleRows.rows.length < sampleRows.totalCount) {
						const remaining = sampleRows.totalCount - sampleRows.rows.length;
						output += `\n[${remaining} more rows; append :${selector.table}?limit=20&offset=${sampleRows.rows.length} to the database path to continue]`;
					}
					return toolResult<ReadToolDetails>(details)
						.text(prependSuffixResolutionNotice(output, resolvedSqlitePath.suffixResolution))
						.sourcePath(resolvedSqlitePath.absolutePath)
						.done();
				}
				case "row": {
					const lookup = resolveTableRowLookup(db, selector.table);
					const row =
						lookup.kind === "pk"
							? getRowByKey(db, selector.table, lookup, selector.key)
							: getRowByRowId(db, selector.table, selector.key);
					if (!row) {
						return toolResult<ReadToolDetails>(details)
							.text(
								prependSuffixResolutionNotice(
									`No row found in table '${selector.table}' for key '${selector.key}'.`,
									resolvedSqlitePath.suffixResolution,
								),
							)
							.sourcePath(resolvedSqlitePath.absolutePath)
							.done();
					}
					return toolResult<ReadToolDetails>(details)
						.text(prependSuffixResolutionNotice(renderRow(row), resolvedSqlitePath.suffixResolution))
						.sourcePath(resolvedSqlitePath.absolutePath)
						.done();
				}
				case "query": {
					const page = queryRows(db, selector.table, selector);
					return toolResult<ReadToolDetails>(details)
						.text(
							prependSuffixResolutionNotice(
								renderTable(page.columns, page.rows, {
									totalCount: page.totalCount,
									offset: selector.offset,
									limit: selector.limit,
									table: selector.table,
									dbPath: resolvedSqlitePath.absolutePath,
								}),
								resolvedSqlitePath.suffixResolution,
							),
						)
						.sourcePath(resolvedSqlitePath.absolutePath)
						.done();
				}
				case "raw": {
					const result = executeReadQuery(db, selector.sql);
					let output = renderTable(result.columns, result.rows, {
						totalCount: result.rows.length,
						offset: 0,
						limit: result.rows.length || DEFAULT_MAX_LINES,
						table: "query",
						dbPath: resolvedSqlitePath.absolutePath,
					});
					if (result.truncated) {
						output += `\n[Output capped at ${MAX_RAW_QUERY_ROWS} rows; add a LIMIT/OFFSET clause to the query to page through more]`;
					}
					return toolResult<ReadToolDetails>(details)
						.text(prependSuffixResolutionNotice(output, resolvedSqlitePath.suffixResolution))
						.sourcePath(resolvedSqlitePath.absolutePath)
						.done();
				}
			}

			throw new ToolError("Unsupported SQLite selector");
		} catch (error) {
			if (error instanceof ToolError) {
				throw error;
			}
			throw new ToolError(error instanceof Error ? error.message : String(error));
		} finally {
			db?.close();
		}
	}

	#routeReadThroughBridge(
		absolutePath: string,
		options?: { line?: number; limit?: number },
	): Promise<string> | undefined {
		const bridge = this.session.getClientBridge?.();
		if (!bridge?.capabilities.readTextFile || !bridge.readTextFile) return undefined;
		return bridge.readTextFile({ path: absolutePath, ...options });
	}

	async #trySummarize(absolutePath: string, fileSize: number, signal?: AbortSignal): Promise<SummaryResult | null> {
		if (fileSize > MAX_SUMMARY_BYTES) return null;

		try {
			throwIfAborted(signal);
			const bridgePromise = this.#routeReadThroughBridge(absolutePath);
			const code =
				bridgePromise !== undefined
					? await bridgePromise.catch(() => Bun.file(absolutePath).text())
					: await Bun.file(absolutePath).text();
			throwIfAborted(signal);
			const lineCount = countTextLines(code);
			if (lineCount > MAX_SUMMARY_LINES) return null;
			if (lineCount < this.session.settings.get("read.summarize.minTotalLines")) return null;

			const minBodyLines = this.session.settings.get("read.summarize.minBodyLines");
			const minCommentLines = this.session.settings.get("read.summarize.minCommentLines");
			const unfoldUntilLines = this.session.settings.get("read.summarize.unfoldUntil");
			const unfoldLimitLines = this.session.settings.get("read.summarize.unfoldLimit");
			const cache = getSummaryParseCache(this.session);
			const cacheKey = `${absolutePath}\0${Bun.hash(code)}\0${minBodyLines},${minCommentLines},${unfoldUntilLines},${unfoldLimitLines}`;
			const memoized = cache.get(cacheKey);
			if (memoized !== undefined) return memoized || null;
			const result = summarizeCode({
				code,
				path: absolutePath,
				minBodyLines,
				minCommentLines,
				unfoldUntilLines,
				unfoldLimitLines,
			});
			const usable = result.parsed && result.elided ? result : false;
			cache.set(cacheKey, usable);
			return usable || null;
		} catch {
			return null;
		}
	}

	#renderSummary(summary: SummaryResult): {
		text: string;
		displayText: string;
		elidedRanges: ElidedRange[];
		elidedLines: number;
	} {
		const displayMode = resolveFileDisplayMode(this.session);
		const shouldAddHashLines = displayMode.hashLines;
		const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;

		// Flatten segments into per-line units so we can merge a kept-head /
		// elided / kept-tail sandwich into a single brace-pair line when the
		// boundary lines look like `… {` and `}` (or matching variants).
		type Unit =
			| { kind: "line"; line: number; text: string }
			| { kind: "elided"; startLine: number; endLine: number }
			| {
					kind: "merged";
					startLine: number;
					endLine: number;
					headText: string;
					tailText: string;
			  };

		const raw: Unit[] = [];
		for (const segment of summary.segments) {
			if (segment.kind === "elided") {
				raw.push({ kind: "elided", startLine: segment.startLine, endLine: segment.endLine });
				continue;
			}
			const text = segment.text ?? "";
			if (text.length === 0) continue;
			const lines = text.split("\n");
			for (let i = 0; i < lines.length; i++) {
				raw.push({ kind: "line", line: segment.startLine + i, text: lines[i] });
			}
		}

		const units: Unit[] = [];
		let i = 0;
		while (i < raw.length) {
			const cur = raw[i];
			if (cur.kind === "elided") {
				const prev = units.length > 0 ? units[units.length - 1] : null;
				const next = i + 1 < raw.length ? raw[i + 1] : null;
				if (prev?.kind === "line" && next?.kind === "line" && canMergeBracePair(prev.text, next.text)) {
					units.pop();
					units.push({
						kind: "merged",
						startLine: prev.line,
						endLine: next.line,
						headText: prev.text,
						tailText: next.text,
					});
					i += 2;
					continue;
				}
			}
			units.push(cur);
			i++;
		}

		const modelParts: string[] = [];
		const displayParts: string[] = [];
		const elidedRanges: ElidedRange[] = [];
		let elidedLines = 0;
		for (const unit of units) {
			if (unit.kind === "elided") {
				modelParts.push("…");
				displayParts.push("…");
				elidedRanges.push({ start: unit.startLine, end: unit.endLine });
				elidedLines += unit.endLine - unit.startLine + 1;
				continue;
			}
			if (unit.kind === "merged") {
				const formatted = formatMergedBraceLine(
					unit.startLine,
					unit.endLine,
					unit.headText,
					unit.tailText,
					shouldAddHashLines,
					shouldAddLineNumbers,
				);
				modelParts.push(formatted.model);
				displayParts.push(formatted.display);
				// Suggest the full brace range so re-reading shows both braces
				// plus the elided body in one shot.
				elidedRanges.push({ start: unit.startLine, end: unit.endLine });
				// Merged brace pair encloses (start+1)..(end-1) as elided.
				elidedLines += Math.max(0, unit.endLine - unit.startLine - 1);
				continue;
			}
			modelParts.push(formatSingleLine(unit.line, unit.text, shouldAddHashLines, shouldAddLineNumbers));
			displayParts.push(unit.text);
		}

		return { text: modelParts.join("\n"), displayText: displayParts.join("\n"), elidedRanges, elidedLines };
	}

	async execute(
		_toolCallId: string,
		params: ReadParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ReadToolDetails>,
		_toolContext?: AgentToolContext,
	): Promise<AgentToolResult<ReadToolDetails>> {
		let { path: readPath } = params;
		if (readPath.startsWith("file://")) {
			readPath = expandPath(readPath);
		}

		const conflictUri = parseConflictUri(readPath);
		if (conflictUri) {
			if (conflictUri.id === "*") {
				throw new ToolError(
					"Reading `conflict://*` is not supported — wildcards are write-only. Use the `<path>:conflicts` read selector for the full list of conflicts in a file, or read `conflict://<N>` to inspect a single block.",
				);
			}
			return this.#readConflictRegion(conflictUri.id, conflictUri.scope);
		}
		const displayMode = resolveFileDisplayMode(this.session);

		const parsedUrlTarget = parseReadUrlTarget(readPath);
		if (parsedUrlTarget) {
			if (!this.session.settings.get("fetch.enabled")) {
				throw new ToolError("URL reads are disabled by settings.");
			}
			const urlRaw = parsedUrlTarget.raw;
			const urlRanges = parsedUrlTarget.ranges;
			if (urlRanges !== undefined && urlRanges.length > 1) {
				const entry = await fetchReadUrl(this.session, { path: parsedUrlTarget.path, raw: urlRaw }, signal, {
					ensureArtifact: true,
				});
				return this.#buildInMemoryMultiRangeResult(entry.output, urlRanges, {
					details: { ...entry.details },
					sourceUrl: entry.details.finalUrl,
					entityLabel: "URL output",
					raw: urlRaw,
					immutable: true,
				});
			}
			const urlOffset = parsedUrlTarget.offset;
			const urlLimit = parsedUrlTarget.limit;
			if (urlOffset !== undefined || urlLimit !== undefined) {
				const entry = await fetchReadUrl(this.session, { path: parsedUrlTarget.path, raw: urlRaw }, signal, {
					ensureArtifact: true,
				});
				return this.#buildInMemoryTextResult(entry.output, urlOffset, urlLimit, {
					details: { ...entry.details },
					sourceUrl: entry.details.finalUrl,
					entityLabel: "URL output",
					raw: urlRaw,
					immutable: true,
				});
			}
			return executeReadUrl(this.session, { path: parsedUrlTarget.path, raw: urlRaw }, signal);
		}

		// Handle internal URLs (agent://, artifact://, memory://, skill://, rule://, local://, mcp://, omp://, issue://, pr://).
		// Use the internal-URL-aware splitter so malformed selectors are peeled
		// off the URL and surfaced via parseSel rather than confusing handlers.
		const internalRouter = InternalUrlRouter.instance();
		let promotedSelector: string | undefined;
		if (internalRouter.canHandle(readPath)) {
			const internalTarget = splitInternalUrlSel(readPath);
			const parsed = parseSel(internalTarget.sel);
			if (internalTarget.sel !== undefined && parsed.kind === "none") {
				throw new ToolError(
					`Invalid selector ':${internalTarget.sel}' on '${internalTarget.path}'. Use :N, :N-M, :N+K, :N- (open-ended), a comma-separated list of ranges, :raw, or a range combined with raw (e.g. :raw:50-100).`,
				);
			}
			const urlMeta = parseInternalUrl(internalTarget.path);
			const scheme = urlMeta.protocol.replace(/:$/, "").toLowerCase();
			if (scheme === "local") {
				const localFile = await resolveLocalUrlToFile(urlMeta, {
					cwd: this.session.cwd,
					settings: this.session.settings,
					signal,
					localProtocolOptions: this.session.localProtocolOptions,
					skills: this.session.skills,
				});
				if (localFile) {
					readPath = localFile.path;
					// Preserve a local:// selector separately so a sibling literal file
					// cannot shadow the URL's selector semantics during filesystem routing.
					promotedSelector = internalTarget.sel;
				} else {
					return this.#handleInternalUrl(internalTarget.path, parsed, signal);
				}
			} else {
				return this.#handleInternalUrl(internalTarget.path, parsed, signal);
			}
		}

		// One suffix-glob memo per read call — archive, sqlite, and plain-path
		// resolution share misses instead of re-globbing the workspace.
		const suffixCache: SuffixMatchCache = new Map();

		// Prefer a literal filesystem match over selector interpretation so real
		// POSIX filenames containing selector-looking suffixes win over structured
		// archive / sqlite / pdf-image dispatch. A selector promoted from local://
		// remains separate so it cannot be mistaken for part of the resolved path.
		const literalSplit =
			promotedSelector === undefined
				? await splitPathAndSelPreferringLiteral(readPath, this.session.cwd)
				: { path: readPath, sel: promotedSelector };
		const rawPathIsLiteral =
			promotedSelector !== undefined
				? readPath.includes(":") && (await probeLiteralPathExists(readPath, this.session.cwd)) !== "missing"
				: literalSplit.sel === undefined && splitPathAndSel(readPath).sel !== undefined;

		if (!rawPathIsLiteral) {
			const archivePath = await this.#resolveArchiveReadPath(readPath, suffixCache, signal);
			if (archivePath) {
				const archiveSubPath =
					promotedSelector === undefined
						? splitPathAndSel(archivePath.archiveSubPath)
						: { path: archivePath.archiveSubPath, sel: promotedSelector };
				const archiveParsed = parseSel(archiveSubPath.sel);
				return this.#readArchive(
					readPath,
					archiveParsed,
					{ ...archivePath, archiveSubPath: archiveSubPath.path },
					signal,
				);
			}

			const sqlitePath = await this.#resolveSqliteReadPath(readPath, suffixCache, signal);
			if (sqlitePath) {
				return this.#readSqlite(sqlitePath, signal);
			}

			const pdfImageMemberPath = splitPdfImageMemberReadPath(readPath);
			if (pdfImageMemberPath) {
				let absolutePdfPath = resolveReadPath(pdfImageMemberPath.pdfPath, this.session.cwd);
				let suffixResolution: { from: string; to: string } | undefined;
				try {
					const stat = await Bun.file(absolutePdfPath).stat();
					if (stat.isDirectory())
						throw new ToolError(`Path '${pdfImageMemberPath.pdfPath}' is a directory, not a PDF file`);
				} catch (error) {
					if (!isNotFoundError(error) || isRemoteMountPath(absolutePdfPath)) throw error;
					const suffixMatch = await this.#findSuffixMatchCached(suffixCache, pdfImageMemberPath.pdfPath, signal);
					if (!suffixMatch) throw new ToolError(`Path '${pdfImageMemberPath.pdfPath}' not found`);
					absolutePdfPath = suffixMatch.absolutePath;
					suffixResolution = { from: pdfImageMemberPath.pdfPath, to: suffixMatch.displayPath };
				}
				return this.#readPdfImageMember(
					absolutePdfPath,
					pdfImageMemberPath.pdfPath,
					pdfImageMemberPath.member,
					suffixResolution,
					signal,
				);
			}
		}

		const localTarget = literalSplit;
		const localReadPath = localTarget.path;
		const parsed = parseSel(localTarget.sel);

		let absolutePath = resolveReadPath(localReadPath, this.session.cwd);
		let suffixResolution: { from: string; to: string } | undefined;

		let isDirectory = false;
		let fileSize = 0;
		try {
			const stat = await Bun.file(absolutePath).stat();
			fileSize = stat.size;
			isDirectory = stat.isDirectory();
		} catch (error) {
			if (isNotFoundError(error)) {
				// Attempt unique suffix resolution before falling back to the approved-plan
				// alias or fuzzy suggestions. Existing workspace files retain precedence.
				if (!isRemoteMountPath(absolutePath)) {
					const suffixMatch = await this.#findSuffixMatchCached(suffixCache, localReadPath, signal);
					if (suffixMatch) {
						try {
							const retryStat = await Bun.file(suffixMatch.absolutePath).stat();
							absolutePath = suffixMatch.absolutePath;
							fileSize = retryStat.size;
							isDirectory = retryStat.isDirectory();
							suffixResolution = { from: localReadPath, to: suffixMatch.displayPath };
						} catch {
							// Suffix match candidate no longer stats — continue through
							// approved-plan recovery and the original not-found error.
						}
					}
				}

				let recoveredApprovedPlan = false;
				if (!suffixResolution) {
					const approvedPlanPath = this.#approvedPlanAlias(absolutePath);
					if (approvedPlanPath) {
						try {
							const approvedPlanStat = await Bun.file(approvedPlanPath).stat();
							absolutePath = approvedPlanPath;
							fileSize = approvedPlanStat.size;
							isDirectory = approvedPlanStat.isDirectory();
							recoveredApprovedPlan = true;
						} catch {
							// The referenced plan disappeared after resolution; continue through
							// the ordinary delimited-path fallback and not-found error.
						}
					}
				}

				if (!recoveredApprovedPlan && !suffixResolution) {
					const delimitedResult = await this.#tryReadDelimitedPaths(readPath, signal);
					if (delimitedResult) return delimitedResult;
					throw new ToolError(`Path '${localReadPath}' not found`);
				}
			} else {
				throw error;
			}
		}

		if (isDirectory) {
			if (isMultiRange(parsed)) {
				throw new ToolError("Multi-range line selectors are not supported for directory listings.");
			}
			const { offset, limit } = selToOffsetLimit(parsed);
			// Directory listings are deterministic and fast; never abort them mid-scan
			// (an interrupt would otherwise surface a misleading "Operation aborted").
			const dirResult = await this.#readDirectory(absolutePath, offset, limit, undefined);
			if (suffixResolution) {
				dirResult.details ??= {};
				dirResult.details.suffixResolution = suffixResolution;
			}
			return dirResult;
		}

		if (parsed.kind === "conflicts") {
			return this.#readFileConflicts(absolutePath, suffixResolution, signal);
		}

		const imageMetadata = await readImageMetadata(absolutePath);
		const mimeType = imageMetadata?.mimeType;
		const ext = path.extname(absolutePath).toLowerCase();
		const shouldConvertWithMarkit = CONVERTIBLE_EXTENSIONS.has(ext);
		// Read the file based on type
		let content: Array<TextContent | ImageContent> | undefined;
		let details: ReadToolDetails = {};
		let sourcePath: string | undefined;
		let columnTruncated = 0;
		let truncationInfo:
			| { result: TruncationResult; options: { direction: "head"; startLine?: number; totalFileLines?: number } }
			| undefined;

		if (mimeType) {
			({ content, details, sourcePath } = await this.#loadImageContent({
				readPath,
				absolutePath,
				mimeType,
				imageMetadata,
				fileSize,
			}));
		} else if (isNotebookPath(absolutePath) && !isRawSelector(parsed)) {
			const notebookText = await readEditableNotebookText(absolutePath, localReadPath);
			if (isMultiRange(parsed) && parsed.kind === "lines") {
				return this.#buildInMemoryMultiRangeResult(notebookText, parsed.ranges, {
					details: { resolvedPath: absolutePath },
					sourcePath: absolutePath,
					entityLabel: "notebook",
				});
			}
			const { offset, limit } = selToOffsetLimit(parsed);
			return this.#buildInMemoryTextResult(notebookText, offset, limit, {
				details: { resolvedPath: absolutePath },
				sourcePath: absolutePath,
				entityLabel: "notebook",
			});
		} else if (shouldConvertWithMarkit) {
			// Convert document via markit.
			const result = await convertFileWithMarkit(absolutePath, signal);
			if (result.ok) {
				const renderedContent =
					ext === ".pdf" ? rewritePdfImagePlaceholders(result.content, localReadPath) : result.content;
				// Route the converted markdown through the in-memory text builder
				// so line-range selectors (`file.pdf:50-100`, `:5-16,40-80`) and
				// raw mode apply against the converted output. Without this,
				// `file.pdf:50-100` silently returned the head of the document
				// because only `truncateHead` was being applied.
				if (isMultiRange(parsed) && parsed.kind === "lines") {
					return this.#buildInMemoryMultiRangeResult(renderedContent, parsed.ranges, {
						details: { resolvedPath: absolutePath },
						sourcePath: absolutePath,
						entityLabel: "document",
					});
				}
				const { offset, limit } = selToOffsetLimit(parsed);
				return this.#buildInMemoryTextResult(renderedContent, offset, limit, {
					details: { resolvedPath: absolutePath },
					sourcePath: absolutePath,
					entityLabel: "document",
					raw: isRawSelector(parsed),
				});
			} else if (result.error) {
				content = [{ type: "text", text: `[Cannot read ${ext} file: ${result.error || "conversion failed"}]` }];
			} else {
				content = [{ type: "text", text: `[Cannot read ${ext} file: conversion failed]` }];
			}
		} else {
			// Binary sniff before any UTF-8 text materialization. A binary file
			// (font, object, archive, packed blob) decodes to NUL/control bytes and
			// U+FFFD mojibake that corrupts the terminal and burns context. Images,
			// notebooks, and markit-convertible documents were already routed above;
			// everything reaching here is meant to be plain text. `:raw` stays the
			// explicit escape hatch for reading bytes verbatim. This single guard
			// covers both the multi-range and single-range disk paths below.
			if (!isRawSelector(parsed) && (await isProbablyBinary(absolutePath))) {
				return toolResult<ReadToolDetails>({ resolvedPath: absolutePath, suffixResolution })
					.text(
						prependSuffixResolutionNotice(
							`[Cannot read binary file '${formatPathRelativeToCwd(absolutePath, this.session.cwd)}' (${formatBytes(fileSize)}); not valid UTF-8 text. Use ':raw' to read bytes verbatim.]`,
							suffixResolution,
						),
					)
					.sourcePath(absolutePath)
					.done();
			}

			if (
				parsed.kind === "none" &&
				this.session.settings.get("read.summarize.enabled") &&
				(this.session.settings.get("read.summarize.prose") || !PROSE_SUMMARY_EXTENSIONS.has(ext))
			) {
				const summary = await this.#trySummarize(absolutePath, fileSize, signal);
				if (summary?.parsed && summary.elided) {
					const renderedSummary = this.#renderSummary(summary);
					const footer = formatSummaryElisionFooter(
						localReadPath,
						renderedSummary.elidedRanges,
						renderedSummary.elidedLines,
					);
					const summaryHashContext = displayMode.hashLines
						? await readHashlineHeaderContext(this.session, absolutePath, this.session.cwd)
						: undefined;
					const bodyText = footer ? `${renderedSummary.text}\n\n${footer}` : renderedSummary.text;
					const modelText = prependHashlineHeader(bodyText, summaryHashContext);
					if (summaryHashContext?.tag) {
						recordSeenLinesFromBody(this.session, absolutePath, summaryHashContext.tag, renderedSummary.text);
					}
					details = {
						displayContent: { text: renderedSummary.displayText, startLine: 1 },
						summary: {
							lines: countTextLines(renderedSummary.text),
							elidedSpans: renderedSummary.elidedRanges.length,
							elidedLines: renderedSummary.elidedLines,
						},
					};

					sourcePath = absolutePath;
					content = [{ type: "text", text: modelText }];
				}
			}

			if (!content) {
				if (isMultiRange(parsed) && parsed.kind === "lines") {
					const multiResult = await this.#readLocalFileMultiRange(
						absolutePath,
						parsed.ranges,
						fileSize,
						parsed,
						displayMode,
						suffixResolution,
						undefined, // plain-file read: deterministic and fast, never abort mid-read
					);
					if (multiResult.bridgeResult) return multiResult.bridgeResult;
					content = [{ type: "text", text: multiResult.outputText }];
					sourcePath = absolutePath;
					details = multiResult.displayContent ? { displayContent: multiResult.displayContent } : {};
					if (multiResult.columnTruncated > 0) {
						columnTruncated = multiResult.columnTruncated;
					}
				} else {
					// Raw text or line-range mode
					const { offset, limit } = selToOffsetLimit(parsed);
					// Try ACP bridge first — editor's in-memory buffer is source of truth.
					// Request full text so local range rendering keeps normal context and line numbers.
					const bridgePromise = this.#routeReadThroughBridge(absolutePath);
					if (bridgePromise !== undefined) {
						try {
							const bridgeText = await bridgePromise;
							const bridgeResult = this.#buildInMemoryTextResult(bridgeText, offset, limit, {
								details: { resolvedPath: absolutePath, suffixResolution },
								sourcePath: absolutePath,
								entityLabel: "file",
								raw: isRawSelector(parsed),
							});
							if (suffixResolution) {
								const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
								const firstText = bridgeResult.content.find((c): c is TextContent => c.type === "text");
								if (firstText) firstText.text = `${notice}\n${firstText.text}`;
							}
							return bridgeResult;
						} catch (error) {
							logger.warn("ACP fs readTextFile failed; falling back to disk", { path: absolutePath, error });
						}
					}

					// User-requested 0-indexed range start. Lines BEFORE this become
					// leading context (added below if offset is explicit). Raw mode
					// never adds context: without line numbers the padding is
					// indistinguishable from requested content, so `raw:31-31` must
					// return line 31 and nothing else.
					const rawSelector = isRawSelector(parsed);
					const requestedStart = offset ? Math.max(0, offset - 1) : 0;
					const expandStart = !rawSelector && offset !== undefined && offset > 1;
					const expandEnd = !rawSelector && limit !== undefined;
					const leadingContext = expandStart ? Math.min(requestedStart, RANGE_LEADING_CONTEXT_LINES) : 0;
					const trailingContext = expandEnd ? RANGE_TRAILING_CONTEXT_LINES : 0;
					const startLine = requestedStart - leadingContext;
					const startLineDisplay = startLine + 1;

					const DEFAULT_LIMIT = this.#defaultLimit;
					const effectiveLimit = limit ?? DEFAULT_LIMIT;
					const maxLinesToCollect = Math.min(effectiveLimit + leadingContext + trailingContext, DEFAULT_MAX_LINES);
					const selectedLineLimit = effectiveLimit + leadingContext + trailingContext;
					// Scale byte budget with line limit so the configured line count actually fits.
					// Assume ~512 bytes/line average; never go below the shared default.
					const maxBytesForRead = Math.max(DEFAULT_MAX_BYTES, maxLinesToCollect * 512);

					const streamResult = await streamLinesFromFile(
						absolutePath,
						startLine,
						maxLinesToCollect,
						maxBytesForRead,
						selectedLineLimit,
						undefined, // plain-file read: deterministic and fast, never abort mid-read
						fileSize > SNAPSHOT_MAX_BYTES, // giant file: don't scan to EOF just for an exact line count
					);

					const {
						lines: collectedLines,
						totalFileLines,
						collectedBytes,
						stoppedByByteLimit,
						firstLinePreview,
						firstLineByteLength,
						reachedEof,
					} = streamResult;

					// Check if offset is out of bounds - return graceful message instead of throwing
					if (requestedStart >= totalFileLines) {
						const suggestion =
							totalFileLines === 0
								? "The file is empty."
								: `Use :1 to read from the start, or :${totalFileLines} to read the last line.`;
						return toolResult<ReadToolDetails>({ resolvedPath: absolutePath, suffixResolution })
							.text(
								`Line ${requestedStart + 1} is beyond end of file (${totalFileLines} lines total). ${suggestion}`,
							)
							.done();
					}

					// Per-line column cap. Skipped in raw mode so `:raw` always returns
					// verbatim bytes for paste-back-into-tool workflows. Total byte/line
					// counts in `truncation` keep reflecting the source, not the trimmed
					// view — column truncation surfaces separately via `.limits()`.
					const maxColumns = resolveOutputMaxColumns(this.session.settings);
					// Column truncation is display-only. `collectedLines` MUST stay
					// byte-for-byte with the on-disk content so the snapshot recorded
					// below can be verified against the live file. Mutating it with
					// ellipsis-truncated text made every long-line file uneditable on
					// the next edit attempt.
					let displayLines: string[] = collectedLines;
					if (!rawSelector && maxColumns > 0) {
						let cloned: string[] | undefined;
						for (let i = 0; i < collectedLines.length; i++) {
							const { text, wasTruncated } = truncateLine(collectedLines[i], maxColumns);
							if (wasTruncated) {
								if (!cloned) cloned = collectedLines.slice();
								cloned[i] = text;
								columnTruncated = maxColumns;
							}
						}
						if (cloned) displayLines = cloned;
					}

					const displayLineByNumber = new Map<number, string>();
					for (let i = 0; i < displayLines.length; i++) {
						displayLineByNumber.set(startLineDisplay + i, displayLines[i] ?? "");
					}
					const bracketContextFullLines = rawSelector
						? undefined
						: await readBracketContextFullLines(absolutePath, fileSize);
					const displayedEndLine = startLineDisplay + Math.max(0, displayLines.length - 1);

					const selectedContent = displayLines.join("\n");
					const userLimitedLines = collectedLines.length;

					const totalSelectedLines = totalFileLines - startLine;
					const totalSelectedBytes = collectedBytes;
					const wasTruncated = collectedLines.length < totalSelectedLines || stoppedByByteLimit;
					const firstLineExceedsLimit = firstLineByteLength !== undefined && firstLineByteLength > maxBytesForRead;

					const truncation: TruncationResult = {
						content: selectedContent,
						truncated: wasTruncated,
						truncatedBy: stoppedByByteLimit ? "bytes" : wasTruncated ? "lines" : undefined,
						totalLines: totalSelectedLines,
						totalBytes: totalSelectedBytes,
						outputLines: collectedLines.length,
						outputBytes: collectedBytes,
						lastLinePartial: false,
						firstLineExceedsLimit,
					};

					const shouldAddHashLines = !rawSelector && displayMode.hashLines;
					const shouldAddLineNumbers = rawSelector ? false : shouldAddHashLines ? false : displayMode.lineNumbers;
					let hashContext: HashlineHeaderContext | undefined;
					if (shouldAddHashLines && collectedLines.length > 0 && !firstLineExceedsLimit) {
						// The tag is a content hash of the WHOLE file. A whole-file read
						// already holds every line in memory; a range read re-reads the
						// file (bounded by SNAPSHOT_MAX_BYTES) so the tag fingerprints the
						// full file and any anchor validates while the file is unchanged.
						const isWholeFile = offset === undefined && limit === undefined && !wasTruncated;
						const tag = isWholeFile
							? getFileSnapshotStore(this.session).record(
									canonicalSnapshotKey(absolutePath),
									normalizeToLF(collectedLines.join("\n")),
								)
							: await recordFileSnapshot(this.session, absolutePath);
						if (tag) {
							hashContext = hashlineHeaderContext(formatPathRelativeToCwd(absolutePath, this.session.cwd), tag);
						}
					}

					let capturedDisplayContent:
						| { text: string; startLine: number; lineNumbers?: Array<number | null> }
						| undefined;
					let emittedHashlineHeader = false;
					const formatText = (text: string, startNum: number): string => {
						const lineCount = countTextLines(text);
						capturedDisplayContent = {
							text,
							startLine: startNum,
							lineNumbers: Array.from({ length: lineCount }, (_, i) => startNum + i),
						};
						const formatted = formatTextWithMode(text, startNum, shouldAddHashLines, shouldAddLineNumbers);
						if (!hashContext || emittedHashlineHeader) return formatted;
						emittedHashlineHeader = true;
						return prependHashlineHeader(formatted, hashContext);
					};
					const formatBracketAwareText = (): string | undefined => {
						if (!bracketContextFullLines) return undefined;
						const entries = buildLineEntriesWithBlockContext(
							bracketContextFullLines,
							[{ startLine: startLineDisplay, endLine: displayedEndLine }],
							{ path: absolutePath },
							{
								lineText: (lineNumber, sourceText) => {
									const visibleText = displayLineByNumber.get(lineNumber);
									if (visibleText !== undefined) return visibleText;
									if (maxColumns <= 0) return sourceText;
									const truncated = truncateLine(sourceText, maxColumns);
									if (truncated.wasTruncated) {
										columnTruncated = maxColumns;
									}
									return truncated.text;
								},
							},
						);
						const firstLine = entries.find(entry => entry.kind === "line");
						capturedDisplayContent = {
							text: lineEntriesToPlainText(entries, BRACKET_CONTEXT_ELLIPSIS),
							startLine: firstLine?.kind === "line" ? firstLine.lineNumber : startLineDisplay,
							lineNumbers: entries.map(entry => (entry.kind === "line" ? entry.lineNumber : null)),
						};
						const formatted = formatLineEntriesWithMode(entries, shouldAddHashLines, shouldAddLineNumbers);
						if (!hashContext || emittedHashlineHeader) return formatted;
						emittedHashlineHeader = true;
						return prependHashlineHeader(formatted, hashContext);
					};

					let outputText: string;

					if (truncation.firstLineExceedsLimit) {
						const firstLineBytes = firstLineByteLength ?? 0;
						const snippet = firstLinePreview ?? { text: "", bytes: 0 };

						if (shouldAddHashLines) {
							outputText = `[Line ${startLineDisplay} is ${formatBytes(
								firstLineBytes,
							)}, exceeds ${formatBytes(maxBytesForRead)} limit. Hashline output requires full lines; cannot emit an editable numbered preview for a truncated line.]`;
						} else {
							outputText = formatText(snippet.text, startLineDisplay);
						}
						if (snippet.text.length === 0) {
							outputText = `[Line ${startLineDisplay} is ${formatBytes(
								firstLineBytes,
							)}, exceeds ${formatBytes(maxBytesForRead)} limit. Unable to display a valid UTF-8 snippet.]`;
						}
						details = { truncation };
						sourcePath = absolutePath;
						truncationInfo = {
							result: truncation,
							options: {
								direction: "head",
								startLine: startLineDisplay,
								totalFileLines: reachedEof ? totalFileLines : undefined,
							},
						};
					} else if (truncation.truncated) {
						outputText = formatBracketAwareText() ?? formatText(truncation.content, startLineDisplay);
						details = { truncation };
						sourcePath = absolutePath;
						truncationInfo = {
							result: truncation,
							options: {
								direction: "head",
								startLine: startLineDisplay,
								totalFileLines: reachedEof ? totalFileLines : undefined,
							},
						};
					} else if (startLine + userLimitedLines < totalFileLines || !reachedEof) {
						const nextOffset = startLine + userLimitedLines + 1;

						outputText = formatBracketAwareText() ?? formatText(truncation.content, startLineDisplay);
						outputText += reachedEof
							? `\n\n[${totalFileLines - (startLine + userLimitedLines)} more lines in file. Use :${nextOffset} to continue]`
							: `\n\n[More lines in file (${formatBytes(fileSize)} total; not scanned to EOF). Use :${nextOffset} to continue]`;
						details = {};
						sourcePath = absolutePath;
					} else {
						// No truncation, no user limit exceeded
						outputText = formatBracketAwareText() ?? formatText(truncation.content, startLineDisplay);
						details = {};
						sourcePath = absolutePath;
					}

					if (hashContext?.tag) {
						recordSeenLinesFromBody(this.session, absolutePath, hashContext.tag, outputText);
					}
					if (rawSelector && !firstLineExceedsLimit && collectedLines.length > 0) {
						await recordFileSnapshot(
							this.session,
							absolutePath,
							contiguousLineNumbers(startLineDisplay, collectedLines.length),
						);
					}

					if (capturedDisplayContent) {
						details.displayContent = capturedDisplayContent;
					}

					if (!firstLineExceedsLimit && collectedLines.length > 0) {
						const blocks = scanConflictLines(collectedLines, startLineDisplay);
						if (blocks.length > 0) {
							const history = getConflictHistory(this.session);
							const displayPathForWarning = formatPathRelativeToCwd(absolutePath, this.session.cwd);
							const entries = blocks.map(block =>
								history.register({
									absolutePath,
									displayPath: displayPathForWarning,
									...block,
								}),
							);
							// Cheap full-file scan only when the window already showed
							// at least one conflict — otherwise pay nothing on clean files.
							let totalInFile = entries.length;
							let scanTruncated = false;
							try {
								const fileScan = await scanFileForConflicts(absolutePath);
								totalInFile = Math.max(entries.length, fileScan.blocks.length);
								scanTruncated = fileScan.scanTruncated;
							} catch {
								// Best-effort enrichment; fall back to window-only count.
							}
							outputText += formatConflictWarning(entries, {
								totalInFile,
								displayPath: displayPathForWarning,
								scanTruncated,
							});
							details.conflictCount = entries.length;
						}
					}

					content = [{ type: "text", text: outputText }];
				}
			}
		}

		if (suffixResolution) {
			details.suffixResolution = suffixResolution;
			// Inline resolution notice into first text block so the model sees the actual path
			const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
			const firstText = content.find((c): c is TextContent => c.type === "text");
			if (firstText) {
				firstText.text = `${notice}\n${firstText.text}`;
			} else {
				content = [{ type: "text", text: notice }, ...content];
			}
		}
		const resultBuilder = toolResult(details).content(content);
		if (sourcePath) {
			resultBuilder.sourcePath(sourcePath);
		}
		if (truncationInfo) {
			resultBuilder.truncation(truncationInfo.result, truncationInfo.options);
		}
		if (columnTruncated > 0) {
			resultBuilder.limits({ columnMax: columnTruncated });
		}
		return resultBuilder.done();
	}

	/**
	 * Render a `conflict://<N>` (or `conflict://<N>/<scope>`) region as
	 * regular file content. The lines are emitted with their original
	 * file line numbers so hashline anchors line up with the source
	 * file, and no truncation footer is appended.
	 */
	async #readConflictRegion(id: number, scope: ConflictScope | undefined): Promise<AgentToolResult<ReadToolDetails>> {
		const entry: ConflictEntry | undefined = getConflictHistory(this.session).get(id);
		if (!entry) {
			throw new ToolError(
				`Conflict #${id} not found. Conflict ids are registered when \`read\` surfaces a marker block; re-read the file to get a current id.`,
			);
		}

		const region = renderConflictRegion(entry, scope);
		const displayMode = resolveFileDisplayMode(this.session);
		const shouldAddHashLines = displayMode.hashLines;
		const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;

		const rawText = region.lines.join("\n");
		const tag = shouldAddHashLines ? await recordFileSnapshot(this.session, entry.absolutePath) : undefined;
		const hashContext = tag
			? hashlineHeaderContext(formatPathRelativeToCwd(entry.absolutePath, this.session.cwd), tag)
			: undefined;
		const formattedBody = formatTextWithMode(rawText, region.startLine, shouldAddHashLines, shouldAddLineNumbers);
		const formattedText = prependHashlineHeader(formattedBody, hashContext);

		const details: ReadToolDetails = {
			resolvedPath: entry.absolutePath,
			displayContent: { text: rawText, startLine: region.startLine },
		};
		return toolResult<ReadToolDetails>(details).text(formattedText).sourcePath(entry.absolutePath).done();
	}

	/**
	 * Implement the `<path>:conflicts` read selector: scan the whole file once, register
	 * every block in the session's conflict history, and return a compact
	 * `#N L_a-L_b` index instead of file content. Designed for heavily
	 * conflicted files where dumping every body would be wasteful.
	 */
	async #readFileConflicts(
		absolutePath: string,
		suffixResolution: { from: string; to: string } | undefined,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<ReadToolDetails>> {
		throwIfAborted(signal);
		const scan = await scanFileForConflicts(absolutePath);
		const displayPath = formatPathRelativeToCwd(absolutePath, this.session.cwd);
		const history = getConflictHistory(this.session);
		const entries = scan.blocks.map(block =>
			history.register({
				absolutePath,
				displayPath,
				...block,
			}),
		);

		const summary =
			entries.length === 0
				? `No unresolved git merge conflicts in ${displayPath}.`
				: formatConflictSummary(entries, { displayPath, scanTruncated: scan.scanTruncated });

		const details: ReadToolDetails = {
			resolvedPath: absolutePath,
			suffixResolution,
			conflictCount: entries.length,
		};
		return toolResult<ReadToolDetails>(details).text(summary).sourcePath(absolutePath).done();
	}

	#formatArtifactWorkflowNotice(artifact: ResolvedArtifactFile, artifactUrl: string): string {
		const displayPath = shortenPath(artifact.path);
		return `Artifact storage: ${displayPath} (${formatBytes(artifact.size)}). Use ${artifactUrl}:N-M to page, ${artifactUrl}:raw:N-M for verbatim chunks, and the artifact file path for search/copy workflows.`;
	}

	#formatRawArtifactBlockedNotice(artifact: ResolvedArtifactFile, artifactUrl: string): string {
		const displayPath = shortenPath(artifact.path);
		return `Unbounded raw read blocked for ${artifactUrl} (${formatBytes(
			artifact.size,
		)}). Reading the whole artifact verbatim can exhaust memory. Use ${artifactUrl}:raw:1-3000 for bounded verbatim chunks, ${artifactUrl}:1-3000 for numbered exploration, and the artifact file path for search/copy workflows: ${displayPath}`;
	}

	async #readArtifactFile(
		url: InternalUrl,
		parsedSel: ParsedSelector,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const artifact = await resolveArtifactFile(url, {
			cwd: this.session.cwd,
			settings: this.session.settings,
			signal,
			localProtocolOptions: this.session.localProtocolOptions,
			skills: this.session.skills,
		});
		const artifactUrl = `artifact://${artifact.id}`;
		const details: ReadToolDetails = {
			resolvedPath: artifact.path,
			contentType: "text/plain",
		};

		if (parsedSel.kind === "raw" && artifact.size > MAX_ARTIFACT_RAW_INLINE_BYTES) {
			return toolResult<ReadToolDetails>(details)
				.text(this.#formatRawArtifactBlockedNotice(artifact, artifactUrl))
				.sourcePath(artifact.path)
				.sourceInternal(url.href)
				.done();
		}

		const rawSelector = isRawSelector(parsedSel);
		const displayMode = resolveFileDisplayMode(this.session, { raw: rawSelector, immutable: true });
		if (isMultiRange(parsedSel) && parsedSel.kind === "lines") {
			const read = await this.#readLocalFileMultiRange(
				artifact.path,
				parsedSel.ranges,
				artifact.size,
				parsedSel,
				displayMode,
				undefined,
				signal,
				false,
			);
			if (read.bridgeResult) return read.bridgeResult;
			if (read.displayContent) details.displayContent = read.displayContent;
			let text = read.outputText;
			if (!rawSelector && artifact.size > MAX_ARTIFACT_RAW_INLINE_BYTES) {
				text = text
					? `${text}\n\n[${this.#formatArtifactWorkflowNotice(artifact, artifactUrl)}]`
					: this.#formatArtifactWorkflowNotice(artifact, artifactUrl);
			}
			const resultBuilder = toolResult<ReadToolDetails>(details)
				.text(text)
				.sourcePath(artifact.path)
				.sourceInternal(url.href);
			if (read.columnTruncated > 0) resultBuilder.limits({ columnMax: read.columnTruncated });
			return resultBuilder.done();
		}

		const { offset, limit } = selToOffsetLimit(parsedSel);
		const requestedStart = offset ? Math.max(0, offset - 1) : 0;
		// Raw mode never adds context lines — see the plain-file range path.
		const expandStart = !rawSelector && offset !== undefined && offset > 1;
		const expandEnd = !rawSelector && limit !== undefined;
		const leadingContext = expandStart ? Math.min(requestedStart, RANGE_LEADING_CONTEXT_LINES) : 0;
		const trailingContext = expandEnd ? RANGE_TRAILING_CONTEXT_LINES : 0;
		const startLine = requestedStart - leadingContext;
		const startLineDisplay = startLine + 1;
		const effectiveLimit = limit ?? this.#defaultLimit;
		const maxLinesToCollect = Math.min(effectiveLimit + leadingContext + trailingContext, DEFAULT_MAX_LINES);
		const selectedLineLimit = effectiveLimit + leadingContext + trailingContext;
		const maxBytesForRead = Math.max(DEFAULT_MAX_BYTES, maxLinesToCollect * 512);
		const streamResult = await streamLinesFromFile(
			artifact.path,
			startLine,
			maxLinesToCollect,
			maxBytesForRead,
			selectedLineLimit,
			signal,
			artifact.size > SNAPSHOT_MAX_BYTES,
		);
		const {
			lines: collectedLines,
			totalFileLines,
			collectedBytes,
			stoppedByByteLimit,
			firstLinePreview,
			firstLineByteLength,
			reachedEof,
		} = streamResult;

		if (requestedStart >= totalFileLines) {
			const suggestion =
				totalFileLines === 0
					? "The artifact is empty."
					: `Use ${artifactUrl}:1 to read from the start, or ${artifactUrl}:${totalFileLines} to read the last line.`;
			return toolResult<ReadToolDetails>(details)
				.text(`Line ${requestedStart + 1} is beyond end of artifact (${totalFileLines} lines total). ${suggestion}`)
				.sourcePath(artifact.path)
				.sourceInternal(url.href)
				.done();
		}

		const shouldAddLineNumbers = rawSelector ? false : displayMode.hashLines ? false : displayMode.lineNumbers;
		const selectedContent = collectedLines.join("\n");
		const totalSelectedLines = totalFileLines - startLine;
		const wasTruncated = collectedLines.length < totalSelectedLines || stoppedByByteLimit;
		const firstLineExceedsLimit = firstLineByteLength !== undefined && firstLineByteLength > maxBytesForRead;
		const truncation: TruncationResult = {
			content: selectedContent,
			truncated: wasTruncated,
			truncatedBy: stoppedByByteLimit ? "bytes" : wasTruncated ? "lines" : undefined,
			totalLines: totalSelectedLines,
			totalBytes: collectedBytes,
			outputLines: collectedLines.length,
			outputBytes: collectedBytes,
			lastLinePartial: false,
			firstLineExceedsLimit,
		};

		let displayContent: { text: string; startLine: number; lineNumbers?: Array<number | null> } | undefined;
		const formatText = (text: string, startNum: number): string => {
			const lineCount = countTextLines(text);
			displayContent = {
				text,
				startLine: startNum,
				lineNumbers: Array.from({ length: lineCount }, (_, i) => startNum + i),
			};
			return formatTextWithMode(text, startNum, false, shouldAddLineNumbers);
		};

		let outputText: string;
		let truncationInfo:
			| { result: TruncationResult; options: { direction: "head"; startLine?: number; totalFileLines?: number } }
			| undefined;
		if (truncation.firstLineExceedsLimit) {
			const firstLineBytes = firstLineByteLength ?? 0;
			const snippet = firstLinePreview ?? { text: "", bytes: 0 };
			outputText =
				snippet.text.length > 0
					? formatText(snippet.text, startLineDisplay)
					: `[Line ${startLineDisplay} is ${formatBytes(
							firstLineBytes,
						)}, exceeds ${formatBytes(maxBytesForRead)} limit. Unable to display a valid UTF-8 snippet.]`;
			truncationInfo = {
				result: truncation,
				options: {
					direction: "head",
					startLine: startLineDisplay,
					totalFileLines: reachedEof ? totalFileLines : undefined,
				},
			};
		} else {
			outputText = formatText(truncation.content, startLineDisplay);
			if (truncation.truncated) {
				truncationInfo = {
					result: truncation,
					options: {
						direction: "head",
						startLine: startLineDisplay,
						totalFileLines: reachedEof ? totalFileLines : undefined,
					},
				};
			} else if (startLine + collectedLines.length < totalFileLines || !reachedEof) {
				const nextOffset = startLine + collectedLines.length + 1;
				outputText += reachedEof
					? `\n\n[${totalFileLines - (startLine + collectedLines.length)} more lines in artifact. Use ${artifactUrl}:${nextOffset} to continue]`
					: `\n\n[More lines in artifact (${formatBytes(artifact.size)} total; not scanned to EOF). Use ${artifactUrl}:${nextOffset} to continue]`;
			}
		}

		if (!rawSelector && artifact.size > MAX_ARTIFACT_RAW_INLINE_BYTES) {
			outputText += `\n\n[${this.#formatArtifactWorkflowNotice(artifact, artifactUrl)}]`;
		}
		if (displayContent) details.displayContent = displayContent;
		if (truncationInfo) details.truncation = truncationInfo.result;
		const resultBuilder = toolResult<ReadToolDetails>(details)
			.text(outputText)
			.sourcePath(artifact.path)
			.sourceInternal(url.href);
		if (truncationInfo) resultBuilder.truncation(truncationInfo.result, truncationInfo.options);
		return resultBuilder.done();
	}

	/**
	 * Handle internal URLs (agent://, artifact://, memory://, skill://, rule://, local://, mcp://).
	 * Supports pagination via offset/limit but rejects them when query extraction is used.
	 */
	async #handleInternalUrl(
		url: string,
		parsedSel: ParsedSelector,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const internalRouter = InternalUrlRouter.instance();

		// Check if URL has query extraction (agent:// only).
		// Use parseInternalUrl which handles colons in host (namespaced skills).
		let urlMeta: InternalUrl;
		try {
			urlMeta = parseInternalUrl(url);
		} catch (e) {
			throw new ToolError(e instanceof Error ? e.message : String(e));
		}
		const scheme = urlMeta.protocol.replace(/:$/, "").toLowerCase();
		let hasExtraction = false;
		if (scheme === "agent") {
			const hasPathExtraction = urlMeta.pathname && urlMeta.pathname !== "/" && urlMeta.pathname !== "";
			const queryParam = urlMeta.searchParams.get("q");
			const hasQueryExtraction = queryParam !== null && queryParam !== "";
			hasExtraction = hasPathExtraction || hasQueryExtraction;
		}
		if (scheme === "artifact") {
			return this.#readArtifactFile(urlMeta, parsedSel, signal);
		}

		// local:// files are real on-disk paths. Detect image files and emit a
		// decoded image block before the text-only resource contract UTF-8
		// decodes the binary into mojibake. The fast path returns null for
		// non-images, directories, listings, or any resolution failure, so the
		// text path below reproduces the router's not-found / symlink-escape
		// behavior unchanged.
		if (scheme === "local") {
			const imageResult = await this.#tryReadLocalImage(urlMeta, signal);
			if (imageResult) return imageResult;
		}

		// Reject line selectors when query extraction is used
		if (hasExtraction && parsedSel.kind !== "none" && parsedSel.kind !== "raw") {
			throw new ToolError("Cannot combine query extraction with line selectors");
		}

		// Resolve the internal URL
		const resource = await internalRouter.resolve(url, {
			cwd: this.session.cwd,
			settings: this.session.settings,
			signal,
			localProtocolOptions: this.session.localProtocolOptions,
			skills: this.session.skills,
			xd: {
				read: async name => {
					if (name === REPORT_ISSUE_DEVICE_NAME) return reportIssueDeviceUsage();
					if (name && isResolutionDeviceName(name)) return resolutionDeviceUsage(name);
					const registry = this.session.xdevRegistry;
					if (!registry || registry.size === 0) throw new ToolError("xd:// is not mounted in this session.");
					return name === null ? registry.listing() : registry.docs(name);
				},
			},
		});
		const details: ReadToolDetails = { resolvedPath: resource.sourcePath, contentType: resource.contentType };

		// If extraction was used, return directly (no pagination)
		if (hasExtraction) {
			return toolResult(details).text(resource.content).sourceInternal(url).done();
		}

		const raw = isRawSelector(parsedSel);
		if (isMultiRange(parsedSel) && parsedSel.kind === "lines") {
			return this.#buildInMemoryMultiRangeResult(resource.content, parsedSel.ranges, {
				details,
				sourcePath: resource.sourcePath,
				sourceInternal: url,
				entityLabel: "resource",
				immutable: resource.immutable,
				raw,
			});
		}

		const { offset, limit } = selToOffsetLimit(parsedSel);
		return this.#buildInMemoryTextResult(resource.content, offset, limit, {
			details,
			sourcePath: resource.sourcePath,
			sourceInternal: url,
			entityLabel: "resource",
			ignoreResultLimits: scheme === "skill",
			immutable: resource.immutable,
			raw,
		});
	}

	/**
	 * Fast path for `local://` image files. Resolves the URL to its real
	 * on-disk path with the same realpath + containment checks as
	 * {@link LocalProtocolHandler.resolve} (via {@link resolveLocalUrlToFile}),
	 * and — only when the target is a genuine image — emits a decoded image
	 * block. Returns null for non-images, directories, listings, or any
	 * resolution failure (not-found, symlink escape) so the caller falls back to
	 * normal text resolution, which reproduces the router's errors. Errors from
	 * a confirmed image (too large / unsupported) propagate rather than
	 * degrading into a corrupted text read.
	 */
	async #tryReadLocalImage(url: InternalUrl, signal?: AbortSignal): Promise<AgentToolResult<ReadToolDetails> | null> {
		let file: { path: string; size: number } | null;
		try {
			file = await resolveLocalUrlToFile(url, {
				cwd: this.session.cwd,
				settings: this.session.settings,
				signal,
				localProtocolOptions: this.session.localProtocolOptions,
			});
		} catch {
			// Not found / containment escape / no session — let the text path
			// surface the router's canonical error.
			return null;
		}
		if (!file) return null;

		const imageMetadata = await readImageMetadata(file.path);
		const mimeType = imageMetadata?.mimeType;
		if (!mimeType) return null;

		const { content, details, sourcePath } = await this.#loadImageContent({
			readPath: url.href,
			absolutePath: file.path,
			mimeType,
			imageMetadata,
			fileSize: file.size,
		});
		const resultBuilder = toolResult(details).content(content).sourceInternal(url.href);
		if (sourcePath) resultBuilder.sourcePath(sourcePath);
		return resultBuilder.done();
	}

	/** Read directory contents as a formatted listing */
	async #readDirectory(
		absolutePath: string,
		offset: number | undefined,
		limit: number | undefined,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const READ_DIRECTORY_MAX_DEPTH = 2;
		const READ_DIRECTORY_CHILD_LIMIT = 12;

		throwIfAborted(signal);
		let tree: DirectoryTree;
		try {
			tree = await buildDirectoryTree(absolutePath, {
				maxDepth: READ_DIRECTORY_MAX_DEPTH,
				perDirLimit: READ_DIRECTORY_CHILD_LIMIT,
				rootLimit: null,
				// `lineCap` truncates the rendered tree itself, so apply it only when the caller
				// did not request an offset — otherwise we'd cap the first N lines before slicing.
				lineCap: offset === undefined && limit !== undefined ? limit : null,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new ToolError(`Cannot read directory: ${message}`);
		}
		throwIfAborted(signal);

		const output = tree.totalLines <= 1 ? "(empty directory)" : tree.rendered;
		const details: ReadToolDetails = {
			isDirectory: true,
			resolvedPath: tree.rootPath,
		};

		// Slice the rendered listing when the caller passed an offset/limit. We do this
		// instead of passing the selector down to `buildDirectoryTree` because the tree
		// builder lays out entries hierarchically (per-dir caps, recent-then-elided
		// summaries); line-based slicing operates on the formatted text and matches what
		// users expect from `:N-M` on long listings.
		const wantsSlice = offset !== undefined || limit !== undefined;
		if (wantsSlice) {
			const allLines = output.split("\n");
			const start = offset ? Math.max(0, offset - 1) : 0;
			if (start >= allLines.length) {
				const suggestion =
					allLines.length === 0
						? "The listing is empty."
						: `Use :1 to read from the start, or :${allLines.length} to read the last line.`;
				return toolResult(details)
					.text(`Line ${start + 1} is beyond end of listing (${allLines.length} lines total). ${suggestion}`)
					.sourcePath(tree.rootPath)
					.done();
			}
			const end = limit !== undefined ? Math.min(start + limit, allLines.length) : allLines.length;
			const sliced = allLines.slice(start, end).join("\n");
			const resultBuilder = toolResult(details).sourcePath(tree.rootPath);
			let text = sliced;
			if (end < allLines.length) {
				const remaining = allLines.length - end;
				text += `\n\n[${remaining} more lines in listing. Use :${end + 1} to continue]`;
			}
			resultBuilder.text(text);
			if (tree.truncated) {
				resultBuilder.limits({ resultLimit: 1 });
			}
			return resultBuilder.done();
		}

		const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
		const resultBuilder = toolResult(details).text(truncation.content).sourcePath(tree.rootPath);
		if (tree.truncated) {
			resultBuilder.limits({ resultLimit: 1 });
		}
		if (truncation.truncated) {
			resultBuilder.truncation(truncation, { direction: "head" });
			details.truncation = truncation;
		}

		return resultBuilder.done();
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface ReadRenderArgs {
	path?: unknown;
	file_path?: unknown;
	// Legacy fields from old schema — tolerated for in-flight tool calls during transition
	offset?: number;
	limit?: number;
	raw?: boolean;
}

const INTERNAL_URL_LIKE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function splitReadRenderPath(rawPath: string): { path: string; sel?: string } {
	if (INTERNAL_URL_LIKE_RE.test(rawPath)) {
		const internal = splitInternalUrlSel(rawPath);
		if (internal.sel) return internal;
	}
	return splitPathAndSel(rawPath);
}

function firstReadSelectorLine(sel: string | undefined): number | undefined {
	if (!sel) return undefined;
	try {
		const parsed = parseSel(sel);
		if (parsed.kind !== "lines") return undefined;
		return parsed.ranges[0].startLine;
	} catch {
		return undefined;
	}
}

/** Absolute fs path the read result actually resolved to, used as the OSC 8 link
 * target when the structured `resolvedPath` isn't set (the common plain-file and
 * image reads only record the path in `meta.source`). URL/internal sources are
 * not fs paths, so only `type: "path"` qualifies. */
function readSourceFsPath(details: ReadToolDetails | undefined): string | undefined {
	const source = details?.meta?.source;
	return source?.type === "path" ? source.value : undefined;
}

function formatReadPathLink(
	rawPath: string,
	options: {
		resolvedPath?: string;
		sourcePath?: string;
		suffixResolution?: { from: string; to: string };
		offset?: number;
		fallbackLabel?: string;
	},
): string {
	const split = splitReadRenderPath(rawPath);
	const basePath = split.path || rawPath;
	const selectorSuffix = split.sel ? `:${split.sel}` : "";
	const plainDisplayPath = options.suffixResolution
		? shortenPath(options.suffixResolution.to)
		: shortenPath(basePath || options.resolvedPath || options.fallbackLabel || rawPath);
	const absoluteInputPath = path.isAbsolute(basePath) ? basePath : undefined;
	const target =
		options.resolvedPath ?? options.sourcePath ?? tryResolveInternalUrlSync(basePath) ?? absoluteInputPath;
	const line = firstReadSelectorLine(split.sel) ?? options.offset;
	const linkOptions = line !== undefined ? { line } : undefined;
	const linkedPath = target ? fileHyperlink(target, plainDisplayPath, linkOptions) : plainDisplayPath;
	return `${linkedPath}${selectorSuffix}`;
}

export const readToolRenderer = {
	renderCall(args: ReadRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		if (isReadableUrlPath(rawPath)) {
			return renderReadUrlCall({ path: rawPath, raw: args.raw }, _options, uiTheme);
		}

		const offset = args.offset;
		const limit = args.limit;

		let pathDisplay = formatReadPathLink(rawPath, { offset, fallbackLabel: "…" }) || "…";
		if (offset !== undefined || limit !== undefined) {
			const startLine = offset ?? 1;
			const endLine = limit !== undefined ? startLine + limit - 1 : "";
			pathDisplay += `:${startLine}${endLine ? `-${endLine}` : ""}`;
		}

		const text = renderStatusLine({ icon: "pending", title: "Read", description: pathDisplay }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ReadToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: ReadRenderArgs,
	): Component {
		const urlDetails = result.details as ReadUrlToolDetails | undefined;
		const baseRawPathForKind =
			typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
		if (urlDetails?.kind === "url" || isReadableUrlPath(baseRawPathForKind)) {
			return renderReadUrlResult(
				result as {
					content: Array<{ type: string; text?: string }>;
					details?: ReadUrlToolDetails;
					isError?: boolean;
				},
				options,
				uiTheme,
			);
		}

		if (result.isError) {
			const rawErrorText = result.content?.find(c => c.type === "text")?.text ?? "";
			const errorText = (rawErrorText || "Unknown error").replace(/^Error:\s*/, "");
			const rawPath =
				typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
			const filePath =
				formatReadPathLink(rawPath, { offset: args?.offset, sourcePath: readSourceFsPath(result.details) }) ||
				shortenPath(rawPath);
			let title = filePath ? `Read ${filePath}` : "Read";
			if (args?.offset !== undefined || args?.limit !== undefined) {
				const startLine = args.offset ?? 1;
				const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
				title += `:${startLine}${endLine ? `-${endLine}` : ""}`;
			}
			const header = renderStatusLine({ icon: "error", title }, uiTheme);
			const errorLines = errorText.split("\n").map(line => uiTheme.fg("error", replaceTabs(line)));
			const outputBlock = new CachedOutputBlock();
			return markFramedBlockComponent({
				render: (width: number) =>
					outputBlock.render({ header, state: "error", sections: [{ lines: errorLines }], width }, uiTheme),
				invalidate: () => outputBlock.invalidate(),
			});
		}
		const details = result.details;
		const rawText = result.content?.find(c => c.type === "text")?.text ?? "";
		// Prefer structured `displayContent` from details when available so the TUI
		// shows clean file content (no model-only hashline anchors) without parsing the formatted text.
		// Fall back to the raw text, but strip the LLM-facing notice so it doesn't
		// echo next to the styled warning line below.
		const contentText = details?.displayContent?.text ?? stripOutputNotice(rawText, details?.meta);
		const imageContent = result.content?.find(c => c.type === "image");
		const rawPath =
			typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
		const renderPath = splitReadRenderPath(rawPath);
		const lang = getLanguageFromPath(renderPath.path);

		const warningLines: string[] = [];
		const truncation = details?.meta?.truncation;
		const fallback = details?.truncation;
		if (details?.resolvedPath) {
			warningLines.push(uiTheme.fg("dim", wrapBrackets(`Resolved path: ${details.resolvedPath}`, uiTheme)));
		}
		if (truncation) {
			if (fallback?.firstLineExceedsLimit) {
				let warning = `First line exceeds ${formatBytes(fallback.outputBytes ?? fallback.totalBytes)} limit`;
				if (truncation.artifactId) {
					warning += `. ${formatFullOutputReference(truncation.artifactId)}`;
				}
				warningLines.push(uiTheme.fg("warning", wrapBrackets(warning, uiTheme)));
			} else {
				const warning = formatStyledTruncationWarning(details?.meta, uiTheme);
				if (warning) warningLines.push(warning);
			}
		}

		if (imageContent) {
			const suffix = details?.suffixResolution;
			const displayPath = formatReadPathLink(rawPath, {
				resolvedPath: details?.resolvedPath,
				sourcePath: readSourceFsPath(details),
				suffixResolution: suffix,
				fallbackLabel: "image",
			});
			const correction = suffix ? ` ${uiTheme.fg("dim", `(corrected from ${shortenPath(suffix.from)})`)}` : "";
			const header = renderStatusLine(
				{ icon: suffix ? "warning" : "success", title: "Read", description: `${displayPath}${correction}` },
				uiTheme,
			);
			const detailLines = contentText ? contentText.split("\n").map(line => uiTheme.fg("toolOutput", line)) : [];
			const lines = [...detailLines, ...warningLines];
			const outputBlock = new CachedOutputBlock();
			return markFramedBlockComponent({
				render: (width: number) =>
					outputBlock.render(
						{
							header,
							state: "success",
							sections: [
								{
									label: uiTheme.fg("toolTitle", "Details"),
									lines: lines.length > 0 ? lines : [uiTheme.fg("dim", "(image)")],
								},
							],
							width,
						},
						uiTheme,
					),
				invalidate: () => outputBlock.invalidate(),
			});
		}

		const suffix = details?.suffixResolution;
		// resolvedPath is the absolute fs path when a read resolved/corrected the
		// input (suffix match, internal URL, archive/sqlite/notebook); plain file
		// reads only record the absolute path in meta.source, so fall back to that
		// (and then to a sync internal-URL resolver) to keep the title clickable.
		const displayPath = formatReadPathLink(rawPath, {
			resolvedPath: details?.resolvedPath,
			sourcePath: readSourceFsPath(details),
			suffixResolution: suffix,
			offset: args?.offset,
		});
		const correction = suffix ? ` ${uiTheme.fg("dim", `(corrected from ${shortenPath(suffix.from)})`)}` : "";
		let title = displayPath ? `Read ${displayPath}${correction}` : "Read";
		if (args?.offset !== undefined || args?.limit !== undefined) {
			const startLine = args.offset ?? 1;
			const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
			title += `:${startLine}${endLine ? `-${endLine}` : ""}`;
		}
		if (details?.summary) {
			title += ` (summary: ${details.summary.elidedSpans} elided span${details.summary.elidedSpans === 1 ? "" : "s"})`;
		}
		if (details?.conflictCount && details.conflictCount > 0) {
			const n = details.conflictCount;
			title += ` ${uiTheme.fg("warning", `(⚠ ${n} conflict${n === 1 ? "" : "s"})`)}`;
		}
		const rawRequested = args?.raw === true || isRawSelector(parseSel(renderPath.sel));
		const isMarkdown = details?.contentType === "text/markdown" && !rawRequested;
		let cachedWidth: number | undefined;
		let cachedExpanded: boolean | undefined;
		let cachedLines: string[] | undefined;
		return markFramedBlockComponent({
			render: (width: number) => {
				const expanded = options.expanded;
				if (cachedLines && cachedWidth === width && cachedExpanded === expanded) return cachedLines;
				cachedLines = isMarkdown
					? renderMarkdownCell(
							{
								content: contentText,
								title,
								status: "complete",
								output: warningLines.length > 0 ? warningLines.join("\n") : undefined,
								expanded,
								width,
							},
							uiTheme,
						)
					: renderCodeCell(
							{
								code: contentText,
								language: lang,
								title,
								status: "complete",
								output: warningLines.length > 0 ? warningLines.join("\n") : undefined,
								expanded,
								codeStartLine: details?.displayContent?.startLine,
								codeLineNumbers: details?.displayContent?.lineNumbers,
								width,
							},
							uiTheme,
						);
				cachedWidth = width;
				cachedExpanded = expanded;
				return cachedLines;
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedExpanded = undefined;
				cachedLines = undefined;
			},
		});
	},
	mergeCallAndResult: true,
};
