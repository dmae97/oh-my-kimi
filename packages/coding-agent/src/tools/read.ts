import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { glob } from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { getRemoteDir, prompt, readImageMetadata, untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { computeLineHash, toDisplayLines } from "../edit/line-hash";
import {
	type ChunkReadTarget,
	formatChunkedRead,
	parseChunkReadPath,
	parseChunkSelector,
	resolveAnchorStyle,
	resolveChunkAutoIndent,
} from "../edit/modes/chunk";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { parseInternalUrl } from "../internal-urls/parse";
import type { InternalUrl } from "../internal-urls/types";
import { getLanguageFromPath, type Theme } from "../modes/theme/theme";
import readDescription from "../prompts/tools/read.md" with { type: "text" };
import readChunkDescription from "../prompts/tools/read-chunk.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	noTruncResult,
	type TruncationResult,
	truncateHead,
	truncateHeadBytes,
} from "../session/streaming-output";
import { renderCodeCell, renderStatusLine } from "../tui";
import { CachedOutputBlock } from "../tui/output-block";
import { resolveEditMode } from "../utils/edit-mode";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { ImageInputTooLargeError, loadImageInput, MAX_IMAGE_INPUT_BYTES } from "../utils/image-loading";
import { convertFileWithMarkit } from "../utils/markit";
import { type ArchiveReader, openArchive, parseArchivePathCandidates } from "./archive-reader";
import {
	executeReadUrl,
	isReadableUrlPath,
	loadReadUrlCacheEntry,
	parseReadUrlTarget,
	type ReadUrlToolDetails,
	renderReadUrlCall,
	renderReadUrlResult,
} from "./fetch";
import { applyListLimit } from "./list-limit";
import { formatFullOutputReference, formatStyledTruncationWarning, type OutputMeta } from "./output-meta";
import { expandPath, resolveReadPath } from "./path-utils";
import { formatAge, formatBytes, shortenPath, wrapBrackets } from "./render-utils";
import {
	executeReadQuery,
	getRowByKey,
	getRowByRowId,
	getTableSchema,
	isSqliteFile,
	listTables,
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

const PROSE_LANGUAGES = new Set(["markdown", "text", "log", "asciidoc", "restructuredtext"]);

function isProseLanguage(language: string | undefined): boolean {
	return language !== undefined && PROSE_LANGUAGES.has(language);
}

// Document types converted to markdown via markit.
const CONVERTIBLE_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".rtf", ".epub"]);

// Remote mount path prefix (sshfs mounts) - skip fuzzy matching to avoid hangs
const REMOTE_MOUNT_PREFIX = getRemoteDir() + path.sep;

function isRemoteMountPath(absolutePath: string): boolean {
	return absolutePath.startsWith(REMOTE_MOUNT_PREFIX);
}

function prependLineNumbers(text: string, startNum: number): string {
	const textLines = text.split("\n");
	return textLines.map((line, i) => `${startNum + i}|${line}`).join("\n");
}

function prependHashLines(text: string, startNum: number): string {
	const textLines = text.split("\n");
	return textLines.map((line, i) => `${startNum + i}${computeLineHash(startNum + i, line)}\t${line}`).join("\n");
}

function formatTextWithMode(
	text: string,
	startNum: number,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (shouldAddHashLines) return prependHashLines(text, startNum);
	if (shouldAddLineNumbers) return prependLineNumbers(text, startNum);
	return text;
}

const READ_CHUNK_SIZE = 8 * 1024;

async function streamLinesFromFile(
	filePath: string,
	startLine: number,
	maxLinesToCollect: number,
	maxBytes: number,
	selectedLineLimit: number | null,
	signal?: AbortSignal,
): Promise<{
	lines: string[];
	totalFileLines: number;
	collectedBytes: number;
	stoppedByByteLimit: boolean;
	firstLinePreview?: { text: string; bytes: number };
	firstLineByteLength?: number;
	selectedBytesTotal: number;
}> {
	const bufferChunk = Buffer.allocUnsafe(READ_CHUNK_SIZE);
	const collectedLines: string[] = [];
	let lineIndex = 0;
	let collectedBytes = 0;
	let stoppedByByteLimit = false;
	let doneCollecting = false;
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

	if (endedWithNewline || currentLineLength > 0 || !sawAnyByte) {
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

	const timeoutSignal = AbortSignal.timeout(GLOB_TIMEOUT_MS);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	let matches: string[];
	try {
		const result = await untilAborted(combinedSignal, () =>
			glob({
				pattern: `**/${normalized}`,
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
	for (const byte of bytes) {
		if (byte === 0) return null;
	}

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

const readSchema = Type.Object({
	path: Type.String({ description: "path or url", examples: ["src/foo.ts", "https://example.com"] }),
	sel: Type.Optional(Type.String({ description: "line range or mode", examples: ["L50", "L50-L120", "raw"] })),
	timeout: Type.Optional(Type.Number({ description: "timeout in seconds", default: 20 })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	kind?: "file" | "url";
	truncation?: TruncationResult;
	isDirectory?: boolean;
	resolvedPath?: string;
	suffixResolution?: { from: string; to: string };
	chunk?: ChunkReadTarget;
	url?: string;
	finalUrl?: string;
	contentType?: string;
	method?: string;
	notes?: string[];
	meta?: OutputMeta;
}

type ReadParams = ReadToolInput;

/** Parsed representation of the `sel` parameter. */
type ParsedSelector =
	| { kind: "none" }
	| { kind: "raw" }
	| { kind: "lines"; startLine: number; endLine: number | undefined }
	| { kind: "chunk"; selector: string };

const LINE_RANGE_RE = /^L(\d+)(?:-L?(\d+))?$/i;

function parseSel(sel: string | undefined): ParsedSelector {
	if (!sel || sel.length === 0) return { kind: "none" };
	const normalizedSelector = parseChunkSelector(sel).selector ?? sel;
	if (normalizedSelector === "raw") return { kind: "raw" };
	const lineMatch = LINE_RANGE_RE.exec(normalizedSelector);
	if (lineMatch) {
		const rawStart = Number.parseInt(lineMatch[1]!, 10);
		if (rawStart < 1) {
			throw new ToolError("L0 is invalid; lines are 1-indexed. Use sel=L1.");
		}
		const rawEnd = lineMatch[2] ? Number.parseInt(lineMatch[2], 10) : undefined;
		if (rawEnd !== undefined && rawEnd < rawStart) {
			throw new ToolError(`Invalid range L${rawStart}-L${rawEnd}: end must be >= start.`);
		}
		return { kind: "lines", startLine: rawStart, endLine: rawEnd };
	}
	return { kind: "chunk", selector: normalizedSelector };
}

/** Convert a line-range selector to the offset/limit pair used by internal pagination. */
function selToOffsetLimit(parsed: ParsedSelector): { offset?: number; limit?: number } {
	if (parsed.kind === "lines") {
		const limit = parsed.endLine !== undefined ? parsed.endLine - parsed.startLine + 1 : undefined;
		return { offset: parsed.startLine, limit };
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

function parseSqliteSelectorInput(selector: string | undefined): { subPath: string; queryString: string } {
	if (!selector) {
		return { subPath: "", queryString: "" };
	}

	const queryIndex = selector.indexOf("?");
	if (queryIndex === -1) {
		return { subPath: selector.replace(/^:+/, ""), queryString: "" };
	}

	return {
		subPath: selector.slice(0, queryIndex).replace(/^:+/, ""),
		queryString: selector.slice(queryIndex + 1),
	};
}

/**
 * Read tool implementation.
 *
 * Reads files with support for images, converted documents (via markit), and text.
 * Directories return a formatted listing with modification times.
 */
export class ReadTool implements AgentTool<typeof readSchema, ReadToolDetails> {
	readonly name = "read";
	readonly label = "Read";
	readonly description: string;
	readonly parameters = readSchema;
	readonly nonAbortable = true;
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
		this.description =
			resolveEditMode(session) === "chunk"
				? prompt.render(readChunkDescription, {
						anchorStyle: resolveAnchorStyle(session.settings),
						chunkAutoIndent: resolveChunkAutoIndent(),
					})
				: prompt.render(readDescription, {
						DEFAULT_LIMIT: String(this.#defaultLimit),
						DEFAULT_MAX_LINES: String(DEFAULT_MAX_LINES),
						IS_HASHLINE_MODE: displayMode.hashLines,
						IS_LINE_NUMBER_MODE: !displayMode.hashLines && displayMode.lineNumbers,
					});
	}

	async #resolveArchiveReadPath(readPath: string, signal?: AbortSignal): Promise<ResolvedArchiveReadPath | null> {
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

				const suffixMatch = await findUniqueSuffixMatch(candidate.archivePath, this.session.cwd, signal);
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

	async #resolveSqliteReadPath(readPath: string, signal?: AbortSignal): Promise<ResolvedSqliteReadPath | null> {
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

				const suffixMatch = await findUniqueSuffixMatch(candidate.sqlitePath, this.session.cwd, signal);
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
		},
	): AgentToolResult<ReadToolDetails> {
		const displayMode = resolveFileDisplayMode(this.session, { raw: options.raw });
		const details = options.details ?? {};
		const allLines = text.split("\n");
		const totalLines = allLines.length;
		const startLine = offset ? Math.max(0, offset - 1) : 0;
		const startLineDisplay = startLine + 1;
		const ignoreResultLimits = options.ignoreResultLimits ?? false;

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

		if (startLine >= allLines.length) {
			const suggestion =
				allLines.length === 0
					? `The ${options.entityLabel} is empty.`
					: `Use sel=L1 to read from the start, or sel=L${allLines.length} to read the last line.`;
			return resultBuilder
				.text(
					`Line ${startLineDisplay} is beyond end of ${options.entityLabel} (${allLines.length} lines total). ${suggestion}`,
				)
				.done();
		}

		const endLine =
			limit !== undefined && !ignoreResultLimits ? Math.min(startLine + limit, allLines.length) : allLines.length;
		const selectedContent = allLines.slice(startLine, endLine).join("\n");
		const userLimitedLines = limit !== undefined && !ignoreResultLimits ? endLine - startLine : undefined;
		const truncation = ignoreResultLimits ? noTruncResult(selectedContent) : truncateHead(selectedContent);

		const shouldAddHashLines = displayMode.hashLines;
		const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;
		const formatText = (content: string, startNum: number): string =>
			formatTextWithMode(content, startNum, shouldAddHashLines, shouldAddLineNumbers);

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
				)}, exceeds ${formatBytes(DEFAULT_MAX_BYTES)} limit. Hashline output requires full lines; cannot compute hashes for a truncated preview.]`;
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
			outputText = formatText(truncation.content, startLineDisplay);
			details.truncation = truncation;
			truncationInfo = {
				result: truncation,
				options: { direction: "head", startLine: startLineDisplay, totalFileLines: totalLines },
			};
		} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
			const remaining = allLines.length - (startLine + userLimitedLines);
			const nextOffset = startLine + userLimitedLines + 1;

			outputText = formatText(selectedContent, startLineDisplay);
			outputText += `\n\n[${remaining} more lines in ${options.entityLabel}. Use sel=L${nextOffset} to continue]`;
		} else {
			outputText = formatText(truncation.content, startLineDisplay);
		}

		resultBuilder.text(outputText);
		if (truncationInfo) {
			resultBuilder.truncation(truncationInfo.result, truncationInfo.options);
		}
		return resultBuilder.done();
	}

	async #readArchiveDirectory(
		archive: ArchiveReader,
		archivePath: string,
		subPath: string,
		limit: number | undefined,
		details: ReadToolDetails,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const DEFAULT_LIMIT = 500;
		const effectiveLimit = limit ?? DEFAULT_LIMIT;
		const entries = archive.listDirectory(subPath);

		const listLimit = applyListLimit(entries, { limit: effectiveLimit });
		const limitedEntries = listLimit.items;
		const limitMeta = listLimit.meta;

		const results: string[] = [];
		for (const entry of limitedEntries) {
			throwIfAborted(signal);
			if (entry.isDirectory) {
				results.push(`${entry.name}/`);
				continue;
			}

			const sizeSuffix = entry.size > 0 ? ` (${formatBytes(entry.size)})` : "";
			results.push(`${entry.name}${sizeSuffix}`);
		}

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
		offset: number | undefined,
		limit: number | undefined,
		resolvedArchivePath: ResolvedArchiveReadPath,
		signal?: AbortSignal,
		options?: { raw?: boolean },
	): Promise<AgentToolResult<ReadToolDetails>> {
		throwIfAborted(signal);
		const archive = await openArchive(resolvedArchivePath.absolutePath);
		throwIfAborted(signal);

		const details: ReadToolDetails = {
			resolvedPath: resolvedArchivePath.absolutePath,
			suffixResolution: resolvedArchivePath.suffixResolution,
		};

		const node = archive.getNode(resolvedArchivePath.archiveSubPath);
		if (!node) {
			throw new ToolError(`Path '${readPath}' not found inside archive`);
		}

		if (node.isDirectory) {
			return this.#readArchiveDirectory(
				archive,
				resolvedArchivePath.absolutePath,
				resolvedArchivePath.archiveSubPath,
				limit,
				details,
				signal,
			);
		}

		const entry = await archive.readFile(resolvedArchivePath.archiveSubPath);
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

		const result = this.#buildInMemoryTextResult(text, offset, limit, {
			details,
			sourcePath: resolvedArchivePath.absolutePath,
			entityLabel: "archive entry",
			raw: options?.raw,
		});
		const firstText = result.content.find((content): content is TextContent => content.type === "text");
		if (firstText) {
			firstText.text = prependSuffixResolutionNotice(firstText.text, resolvedArchivePath.suffixResolution);
		}
		return result;
	}

	async #readSqlite(
		sel: string | undefined,
		resolvedSqlitePath: ResolvedSqliteReadPath,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		throwIfAborted(signal);

		const selectorInput = sel
			? parseSqliteSelectorInput(sel)
			: { subPath: resolvedSqlitePath.sqliteSubPath, queryString: resolvedSqlitePath.queryString };
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
						output += `\n[${remaining} more rows; use sel="${selector.table}?limit=20&offset=${sampleRows.rows.length}" to continue]`;
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
					return toolResult<ReadToolDetails>(details)
						.text(
							prependSuffixResolutionNotice(
								renderTable(result.columns, result.rows, {
									totalCount: result.rows.length,
									offset: 0,
									limit: result.rows.length || DEFAULT_MAX_LINES,
									table: "query",
									dbPath: resolvedSqlitePath.absolutePath,
								}),
								resolvedSqlitePath.suffixResolution,
							),
						)
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

	async execute(
		_toolCallId: string,
		params: ReadParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ReadToolDetails>,
		_toolContext?: AgentToolContext,
	): Promise<AgentToolResult<ReadToolDetails>> {
		let { path: readPath, sel, timeout } = params;
		if (readPath.startsWith("file://")) {
			readPath = expandPath(readPath);
		}
		const displayMode = resolveFileDisplayMode(this.session);
		const chunkMode = resolveEditMode(this.session) === "chunk";

		// Handle internal URLs (agent://, artifact://, memory://, skill://, rule://, local://, mcp://)
		const internalRouter = this.session.internalRouter;
		if (internalRouter?.canHandle(readPath)) {
			const parsed = parseSel(sel);
			const { offset, limit } = selToOffsetLimit(parsed);
			return this.#handleInternalUrl(readPath, offset, limit);
		}

		const parsedUrlTarget = parseReadUrlTarget(readPath, sel);
		if (parsedUrlTarget) {
			if (!this.session.settings.get("fetch.enabled")) {
				throw new ToolError("URL reads are disabled by settings.");
			}
			if (parsedUrlTarget.offset !== undefined || parsedUrlTarget.limit !== undefined) {
				const cached = await loadReadUrlCacheEntry(
					this.session,
					{ path: parsedUrlTarget.path, timeout, raw: parsedUrlTarget.raw },
					signal,
					{
						ensureArtifact: true,
						preferCached: true,
					},
				);
				return this.#buildInMemoryTextResult(cached.output, parsedUrlTarget.offset, parsedUrlTarget.limit, {
					details: { ...cached.details },
					sourceUrl: cached.details.finalUrl,
					entityLabel: "URL output",
				});
			}
			return executeReadUrl(this.session, { path: parsedUrlTarget.path, timeout, raw: parsedUrlTarget.raw }, signal);
		}

		const parsedReadPath = chunkMode ? parseChunkReadPath(readPath) : { filePath: readPath };
		const localReadPath = parsedReadPath.filePath;
		const pathSelectorParsed = chunkMode ? parseSel(parsedReadPath.selector) : { kind: "none" as const };
		const pathChunkSelector = pathSelectorParsed.kind === "chunk" ? pathSelectorParsed.selector : undefined;
		const selectorInput = sel ?? parsedReadPath.selector;
		const rawSelectorInput = sel ?? parsedReadPath.selector;
		const parsed = parseSel(selectorInput);

		const archivePath = await this.#resolveArchiveReadPath(localReadPath, signal);
		if (archivePath) {
			const { offset, limit } = selToOffsetLimit(parsed);
			return this.#readArchive(readPath, offset, limit, archivePath, signal, { raw: parsed.kind === "raw" });
		}

		const sqlitePath = await this.#resolveSqliteReadPath(readPath, signal);
		if (sqlitePath) {
			return this.#readSqlite(sel, sqlitePath, signal);
		}

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
				// Attempt unique suffix resolution before falling back to fuzzy suggestions
				if (!isRemoteMountPath(absolutePath)) {
					const suffixMatch = await findUniqueSuffixMatch(localReadPath, this.session.cwd, signal);
					if (suffixMatch) {
						try {
							const retryStat = await Bun.file(suffixMatch.absolutePath).stat();
							absolutePath = suffixMatch.absolutePath;
							fileSize = retryStat.size;
							isDirectory = retryStat.isDirectory();
							suffixResolution = { from: localReadPath, to: suffixMatch.displayPath };
						} catch {
							// Suffix match candidate no longer stats — fall through to error path
						}
					}
				}

				if (!suffixResolution) {
					throw new ToolError(`Path '${localReadPath}' not found`);
				}
			} else {
				throw error;
			}
		}

		if (isDirectory) {
			const dirResult = await this.#readDirectory(absolutePath, selToOffsetLimit(parsed).limit, signal);
			if (suffixResolution) {
				dirResult.details ??= {};
				dirResult.details.suffixResolution = suffixResolution;
			}
			return dirResult;
		}

		const imageMetadata = await readImageMetadata(absolutePath);
		const mimeType = imageMetadata?.mimeType;
		const ext = path.extname(absolutePath).toLowerCase();
		const hasEditTool = this.session.hasEditTool ?? true;
		const language = getLanguageFromPath(absolutePath);
		const skipChunksForExplore = !hasEditTool && !this.session.settings.get("read.explorechunks");
		const skipChunksForProse = isProseLanguage(language) && !this.session.settings.get("read.prosechunks");
		const shouldConvertWithMarkit =
			CONVERTIBLE_EXTENSIONS.has(ext) || (ext === ".ipynb" && (parsed.kind === "raw" || !chunkMode));

		if (chunkMode && parsed.kind !== "raw" && !skipChunksForExplore && !skipChunksForProse) {
			const absoluteLineRange =
				pathChunkSelector && parsed.kind === "lines"
					? { startLine: parsed.startLine, endLine: parsed.endLine }
					: undefined;
			// sel= wins over path:chunk when both are provided (explicit param > embedded path).
			const effectiveSelector = sel ? selectorInput : (pathChunkSelector ?? selectorInput);
			const rawEffectiveSelector = sel ? selectorInput : (rawSelectorInput ?? effectiveSelector);
			const chunkReadPath =
				parsed.kind === "chunk" || (pathChunkSelector && !sel)
					? rawEffectiveSelector
						? `${localReadPath}:${rawEffectiveSelector}`
						: localReadPath
					: parsed.kind === "lines"
						? parsed.endLine !== undefined
							? `${localReadPath}:L${parsed.startLine}-L${parsed.endLine}`
							: `${localReadPath}:L${parsed.startLine}`
						: localReadPath;
			const chunkResult = await formatChunkedRead({
				filePath: absolutePath,
				readPath: chunkReadPath,
				cwd: this.session.cwd,
				language,
				omitChecksum: !hasEditTool,
				anchorStyle: resolveAnchorStyle(this.session.settings),
				absoluteLineRange,
			});
			let text = chunkResult.text;
			if (suffixResolution) {
				text = prependSuffixResolutionNotice(text, suffixResolution);
			}
			return toolResult<ReadToolDetails>({
				resolvedPath: absolutePath,
				suffixResolution,
				chunk: chunkResult.chunk,
			})
				.text(text)
				.sourcePath(absolutePath)
				.done();
		}

		// Read the file based on type
		let content: Array<TextContent | ImageContent>;
		let details: ReadToolDetails = {};
		let sourcePath: string | undefined;
		let truncationInfo:
			| { result: TruncationResult; options: { direction: "head"; startLine?: number; totalFileLines?: number } }
			| undefined;

		if (mimeType) {
			if (this.#inspectImageEnabled) {
				const metadata = imageMetadata;
				const outputMime = metadata?.mimeType ?? mimeType;
				const outputBytes = fileSize;
				const metadataLines = [
					"Image metadata:",
					`- MIME: ${outputMime}`,
					`- Bytes: ${outputBytes} (${formatBytes(outputBytes)})`,
					metadata?.width !== undefined && metadata.height !== undefined
						? `- Dimensions: ${metadata.width}x${metadata.height}`
						: "- Dimensions: unknown",
					metadata?.channels !== undefined ? `- Channels: ${metadata.channels}` : "- Channels: unknown",
					metadata?.hasAlpha === true
						? "- Alpha: yes"
						: metadata?.hasAlpha === false
							? "- Alpha: no"
							: "- Alpha: unknown",
					"",
					`If you want to analyze the image, call inspect_image with path="${readPath}" and a question describing what to inspect and the desired output format.`,
				];
				content = [{ type: "text", text: metadataLines.join("\n") }];
				details = {};
				sourcePath = absolutePath;
			} else {
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
					});
					if (!imageInput) {
						throw new ToolError(`Read image file [${mimeType}] failed: unsupported image format.`);
					}
					content = [
						{ type: "text", text: imageInput.textNote },
						{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType },
					];
					details = {};
					sourcePath = imageInput.resolvedPath;
				} catch (error) {
					if (error instanceof ImageInputTooLargeError) {
						throw new ToolError(error.message);
					}
					throw error;
				}
			}
		} else if (shouldConvertWithMarkit) {
			// Convert document or notebook via markit.
			const result = await convertFileWithMarkit(absolutePath, signal);
			if (result.ok) {
				// Apply truncation to converted content
				const truncation = truncateHead(result.content);
				const outputText = truncation.content;

				details = { truncation };
				sourcePath = absolutePath;
				truncationInfo = { result: truncation, options: { direction: "head", startLine: 1 } };

				content = [{ type: "text", text: outputText }];
			} else if (result.error) {
				content = [{ type: "text", text: `[Cannot read ${ext} file: ${result.error || "conversion failed"}]` }];
			} else {
				content = [{ type: "text", text: `[Cannot read ${ext} file: conversion failed]` }];
			}
		} else {
			// Chunk mode: dispatch to chunk tree unless raw or line range requested
			if (chunkMode && parsed.kind !== "raw" && parsed.kind !== "lines") {
				const chunkSel = parsed.kind === "chunk" ? parsed.selector : undefined;
				const chunkResult = await formatChunkedRead({
					filePath: absolutePath,
					readPath: chunkSel ? `${localReadPath}:${chunkSel}` : localReadPath,
					cwd: this.session.cwd,
					language: getLanguageFromPath(absolutePath),
					omitChecksum: !(this.session.hasEditTool ?? true),
					anchorStyle: resolveAnchorStyle(this.session.settings),
				});
				let text = chunkResult.text;
				if (suffixResolution) {
					text = prependSuffixResolutionNotice(text, suffixResolution);
				}
				return toolResult<ReadToolDetails>({
					resolvedPath: absolutePath,
					suffixResolution,
					chunk: chunkResult.chunk,
				})
					.text(text)
					.sourcePath(absolutePath)
					.done();
			}

			// Raw text or line-range mode
			const { offset, limit } = selToOffsetLimit(parsed);
			const startLine = offset ? Math.max(0, offset - 1) : 0;
			const startLineDisplay = startLine + 1;

			const DEFAULT_LIMIT = this.#defaultLimit;
			const effectiveLimit = limit ?? DEFAULT_LIMIT;
			const maxLinesToCollect = Math.min(effectiveLimit, DEFAULT_MAX_LINES);
			const selectedLineLimit = effectiveLimit;

			const streamResult = await streamLinesFromFile(
				absolutePath,
				startLine,
				maxLinesToCollect,
				DEFAULT_MAX_BYTES,
				selectedLineLimit,
				signal,
			);

			const {
				lines: collectedLines,
				totalFileLines,
				collectedBytes,
				stoppedByByteLimit,
				firstLinePreview,
				firstLineByteLength,
			} = streamResult;

			// Check if offset is out of bounds - return graceful message instead of throwing
			if (startLine >= totalFileLines) {
				const suggestion =
					totalFileLines === 0
						? "The file is empty."
						: `Use sel=L1 to read from the start, or sel=L${totalFileLines} to read the last line.`;
				return toolResult<ReadToolDetails>({ resolvedPath: absolutePath, suffixResolution })
					.text(`Line ${startLineDisplay} is beyond end of file (${totalFileLines} lines total). ${suggestion}`)
					.done();
			}

			const selectedContent = collectedLines.join("\n");
			const userLimitedLines = collectedLines.length;

			const totalSelectedLines = totalFileLines - startLine;
			const totalSelectedBytes = collectedBytes;
			const wasTruncated = collectedLines.length < totalSelectedLines || stoppedByByteLimit;
			const firstLineExceedsLimit = firstLineByteLength !== undefined && firstLineByteLength > DEFAULT_MAX_BYTES;

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

			const isRawMode = parsed.kind === "raw";
			const shouldAddHashLines = !isRawMode && displayMode.hashLines;
			const shouldAddLineNumbers = isRawMode ? false : shouldAddHashLines ? false : displayMode.lineNumbers;
			const formatText = (text: string, startNum: number): string => {
				return formatTextWithMode(text, startNum, shouldAddHashLines, shouldAddLineNumbers);
			};

			let outputText: string;

			if (truncation.firstLineExceedsLimit) {
				const firstLineBytes = firstLineByteLength ?? 0;
				const snippet = firstLinePreview ?? { text: "", bytes: 0 };

				if (shouldAddHashLines) {
					outputText = `[Line ${startLineDisplay} is ${formatBytes(
						firstLineBytes,
					)}, exceeds ${formatBytes(DEFAULT_MAX_BYTES)} limit. Hashline output requires full lines; cannot compute hashes for a truncated preview.]`;
				} else {
					outputText = formatText(snippet.text, startLineDisplay);
				}
				if (snippet.text.length === 0) {
					outputText = `[Line ${startLineDisplay} is ${formatBytes(
						firstLineBytes,
					)}, exceeds ${formatBytes(DEFAULT_MAX_BYTES)} limit. Unable to display a valid UTF-8 snippet.]`;
				}
				details = { truncation };
				sourcePath = absolutePath;
				truncationInfo = {
					result: truncation,
					options: { direction: "head", startLine: startLineDisplay, totalFileLines },
				};
			} else if (truncation.truncated) {
				outputText = formatText(truncation.content, startLineDisplay);
				details = { truncation };
				sourcePath = absolutePath;
				truncationInfo = {
					result: truncation,
					options: { direction: "head", startLine: startLineDisplay, totalFileLines },
				};
			} else if (startLine + userLimitedLines < totalFileLines) {
				const remaining = totalFileLines - (startLine + userLimitedLines);
				const nextOffset = startLine + userLimitedLines + 1;

				outputText = formatText(truncation.content, startLineDisplay);
				outputText += `\n\n[${remaining} more lines in file. Use sel=L${nextOffset} to continue]`;
				details = {};
				sourcePath = absolutePath;
			} else {
				// No truncation, no user limit exceeded
				outputText = formatText(truncation.content, startLineDisplay);
				details = {};
				sourcePath = absolutePath;
			}

			content = [{ type: "text", text: outputText }];
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
		return resultBuilder.done();
	}

	/**
	 * Handle internal URLs (agent://, artifact://, memory://, skill://, rule://, local://, mcp://).
	 * Supports pagination via offset/limit but rejects them when query extraction is used.
	 */
	async #handleInternalUrl(url: string, offset?: number, limit?: number): Promise<AgentToolResult<ReadToolDetails>> {
		const internalRouter = this.session.internalRouter!;

		// Check if URL has query extraction (agent:// only).
		// Use parseInternalUrl which handles colons in host (namespaced skills).
		let parsed: InternalUrl;
		try {
			parsed = parseInternalUrl(url);
		} catch (e) {
			throw new ToolError(e instanceof Error ? e.message : String(e));
		}
		const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
		let hasExtraction = false;
		if (scheme === "agent") {
			const hasPathExtraction = parsed.pathname && parsed.pathname !== "/" && parsed.pathname !== "";
			const queryParam = parsed.searchParams.get("q");
			const hasQueryExtraction = queryParam !== null && queryParam !== "";
			hasExtraction = hasPathExtraction || hasQueryExtraction;
		}

		// Reject offset/limit with query extraction
		if (hasExtraction && (offset !== undefined || limit !== undefined)) {
			throw new ToolError("Cannot combine query extraction with offset/limit");
		}

		// Resolve the internal URL
		const resource = await internalRouter.resolve(url);
		const details: ReadToolDetails = { resolvedPath: resource.sourcePath };

		// If extraction was used, return directly (no pagination)
		if (hasExtraction) {
			return toolResult(details).text(resource.content).sourceInternal(url).done();
		}

		return this.#buildInMemoryTextResult(resource.content, offset, limit, {
			details,
			sourcePath: resource.sourcePath,
			sourceInternal: url,
			entityLabel: "resource",
			ignoreResultLimits: scheme === "skill",
		});
	}

	/** Read directory contents as a formatted listing */
	async #readDirectory(
		absolutePath: string,
		limit: number | undefined,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const DEFAULT_LIMIT = 500;
		const effectiveLimit = limit ?? DEFAULT_LIMIT;

		let entries: string[];
		try {
			entries = await fs.readdir(absolutePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new ToolError(`Cannot read directory: ${message}`);
		}

		// Sort alphabetically (case-insensitive)
		entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

		const listLimit = applyListLimit(entries, { limit: effectiveLimit });
		const limitedEntries = listLimit.items;
		const limitMeta = listLimit.meta;

		// Format entries with directory indicators and ages
		const results: string[] = [];

		for (const entry of limitedEntries) {
			throwIfAborted(signal);
			const fullPath = path.join(absolutePath, entry);
			let suffix = "";
			let age = "";

			try {
				const entryStat = await fs.stat(fullPath);
				suffix = entryStat.isDirectory() ? "/" : "";
				const ageSeconds = Math.floor((Date.now() - entryStat.mtimeMs) / 1000);
				age = formatAge(ageSeconds);
			} catch {
				// Skip entries we can't stat
				continue;
			}

			const line = age ? `${entry}${suffix} (${age})` : entry + suffix;
			results.push(line);
		}

		if (results.length === 0) {
			return { content: [{ type: "text", text: "(empty directory)" }], details: {} };
		}

		const output = results.join("\n");
		const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });

		const details: ReadToolDetails = {
			isDirectory: true,
		};

		const resultBuilder = toolResult(details)
			.text(truncation.content)
			.limits({ resultLimit: limitMeta.resultLimit?.reached });
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
	path?: string;
	file_path?: string;
	sel?: string;
	timeout?: number;
	// Legacy fields from old schema — tolerated for in-flight tool calls during transition
	offset?: number;
	limit?: number;
	raw?: boolean;
}

export const readToolRenderer = {
	renderCall(args: ReadRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		if (isReadableUrlPath(args.file_path || args.path || "")) {
			return renderReadUrlCall(args, _options, uiTheme);
		}

		const rawPath = args.file_path || args.path || "";
		const filePath = shortenPath(rawPath);
		const offset = args.offset;
		const limit = args.limit;

		let pathDisplay = filePath || "…";
		if (offset !== undefined || limit !== undefined) {
			const startLine = offset ?? 1;
			const endLine = limit !== undefined ? startLine + limit - 1 : "";
			pathDisplay += `:${startLine}${endLine ? `-${endLine}` : ""}`;
		}

		const text = renderStatusLine({ icon: "pending", title: "Read", description: pathDisplay }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ReadToolDetails },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: ReadRenderArgs,
	): Component {
		const urlDetails = result.details as ReadUrlToolDetails | undefined;
		if (urlDetails?.kind === "url" || isReadableUrlPath(args?.file_path || args?.path || "")) {
			return renderReadUrlResult(
				result as { content: Array<{ type: string; text?: string }>; details?: ReadUrlToolDetails },
				_options,
				uiTheme,
			);
		}

		const details = result.details;
		const rawText = result.content?.find(c => c.type === "text")?.text ?? "";
		const contentText = toDisplayLines(rawText);
		const imageContent = result.content?.find(c => c.type === "image");
		const rawPath = args?.file_path || args?.path || "";
		const filePath = shortenPath(rawPath);
		const lang = getLanguageFromPath(rawPath);

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
			const displayPath = suffix ? shortenPath(suffix.to) : filePath || rawPath || "image";
			const correction = suffix ? ` ${uiTheme.fg("dim", `(corrected from ${shortenPath(suffix.from)})`)}` : "";
			const header = renderStatusLine(
				{ icon: suffix ? "warning" : "success", title: "Read", description: `${displayPath}${correction}` },
				uiTheme,
			);
			const detailLines = contentText ? contentText.split("\n").map(line => uiTheme.fg("toolOutput", line)) : [];
			const lines = [...detailLines, ...warningLines];
			const outputBlock = new CachedOutputBlock();
			return {
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
			};
		}

		const suffix = details?.suffixResolution;
		const displayPath = suffix ? shortenPath(suffix.to) : filePath;
		const correction = suffix ? ` ${uiTheme.fg("dim", `(corrected from ${shortenPath(suffix.from)})`)}` : "";
		let title = displayPath ? `Read ${displayPath}${correction}` : "Read";
		if (args?.offset !== undefined || args?.limit !== undefined) {
			const startLine = args.offset ?? 1;
			const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
			title += `:${startLine}${endLine ? `-${endLine}` : ""}`;
		}
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		return {
			render: (width: number) => {
				if (cachedLines && cachedWidth === width) return cachedLines;
				cachedLines = renderCodeCell(
					{
						code: contentText,
						language: lang,
						title,
						status: "complete",
						output: warningLines.length > 0 ? warningLines.join("\n") : undefined,
						expanded: true,
						width,
					},
					uiTheme,
				);
				cachedWidth = width;
				return cachedLines;
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
		};
	},
	mergeCallAndResult: true,
};
