import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { StringEnum } from "@oh-my-pi/pi-coding-agent";
import {
	ChunkAnchorStyle,
	ChunkEditOp,
	type ChunkInfo,
	ChunkReadStatus,
	type ChunkReadTarget,
	ChunkRegion,
	ChunkState,
	type EditOperation as NativeEditOperation,
} from "@oh-my-pi/pi-natives";
import { $envpos } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { BunFile } from "bun";
import { LRUCache } from "lru-cache";
import type { Settings } from "../../config/settings";
import type { WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import { getLanguageFromPath } from "../../modes/theme/theme";
import type { ToolSession } from "../../tools";
import { assertEditableFileContent } from "../../tools/auto-generated-guard";
import { invalidateFsScanAfterWrite } from "../../tools/fs-cache-invalidation";
import { outputMeta } from "../../tools/output-meta";
import { enforcePlanModeWrite, resolvePlanPath } from "../../tools/plan-mode-guard";
import { generateUnifiedDiffString } from "../diff";
import { HASHLINE_BIGRAMS } from "../line-hash";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../normalize";
import type { EditToolDetails, LspBatchRequest } from "../renderer";

export type { ChunkReadTarget };

export type ChunkEditOperation =
	| { op: "put"; sel?: string; content: string }
	| { op: "delete"; sel?: string }
	| { op: "before"; sel?: string; content: string }
	| { op: "after"; sel?: string; content: string }
	| { op: "prepend"; sel?: string; content: string }
	| { op: "append"; sel?: string; content: string };

type ChunkEditResult = {
	diffSourceBefore: string;
	diffSourceAfter: string;
	responseText: string;
	changed: boolean;
	parseValid: boolean;
	touchedPaths: string[];
	warnings: string[];
};

export type ParsedChunkReadPath = {
	filePath: string;
	selector?: string;
};

type ChunkCacheEntry = {
	mtimeMs: number;
	size: number;
	source: string;
	state: ChunkState;
};

const validAnchorStyles: Record<string, ChunkAnchorStyle> = {
	full: ChunkAnchorStyle.Full,
	kind: ChunkAnchorStyle.Kind,
	bare: ChunkAnchorStyle.Bare,
};

export function resolveChunkAutoIndent(rawValue = Bun.env.PI_CHUNK_AUTOINDENT): boolean {
	if (!rawValue) return true;
	const normalized = rawValue.trim().toLowerCase();
	switch (normalized) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			throw new Error(`Invalid PI_CHUNK_AUTOINDENT: ${rawValue}`);
	}
}

function getChunkRenderIndentOptions(): {
	normalizeIndent: boolean;
	tabReplacement: string;
} {
	return resolveChunkAutoIndent()
		? { normalizeIndent: true, tabReplacement: "    " }
		: { normalizeIndent: false, tabReplacement: "\t" };
}

export function resolveAnchorStyle(settings?: Settings): ChunkAnchorStyle {
	const envStyle = Bun.env.PI_ANCHOR_STYLE;
	return (
		(envStyle && validAnchorStyles[envStyle]) ||
		(settings?.get("read.anchorstyle") as ChunkAnchorStyle | undefined) ||
		ChunkAnchorStyle.Full
	);
}

const chunkStateCache = new LRUCache<string, ChunkCacheEntry>({
	max: $envpos("PI_CHUNK_CACHE_MAX_ENTRIES", 200),
});

export function invalidateChunkCache(filePath: string): void {
	chunkStateCache.delete(filePath);
}

type ChunkSourceContext = {
	resolvedPath: string;
	sourceFile: BunFile;
	sourceExists: boolean;
	rawContent: string;
	chunkLanguage: string | undefined;
};

type ChunkSourceIntent = "read" | "write";

function normalizeLanguage(language: string | undefined): string {
	return language?.trim().toLowerCase() || "";
}

function normalizeChunkSource(text: string): string {
	return normalizeToLF(stripBom(text).text);
}

function displayPathForFile(filePath: string, cwd: string): string {
	const relative = nodePath.relative(cwd, filePath).replace(/\\/g, "/");
	return relative && !relative.startsWith("..") ? relative : filePath.replace(/\\/g, "/");
}

function fileLanguageTag(filePath: string, language?: string): string | undefined {
	const normalizedLanguage = normalizeLanguage(language);
	if (normalizedLanguage.length > 0) return normalizedLanguage;
	const ext = nodePath.extname(filePath).replace(/^\./, "").toLowerCase();
	return ext.length > 0 ? ext : undefined;
}

async function resolveChunkSourceContext(
	session: ToolSession,
	path: string,
	options?: { intent?: ChunkSourceIntent },
): Promise<ChunkSourceContext> {
	const resolvedPath = resolvePlanPath(session, path);
	const sourceFile = Bun.file(resolvedPath);
	const sourceExists = await sourceFile.exists();
	if ((options?.intent ?? "write") === "write") {
		enforcePlanModeWrite(session, path, { op: sourceExists ? "update" : "create" });
	}

	let rawContent = "";
	if (sourceExists) {
		rawContent = await sourceFile.text();
		assertEditableFileContent(rawContent, path);
	}

	return {
		resolvedPath,
		sourceFile,
		sourceExists,
		rawContent,
		chunkLanguage: getLanguageFromPath(resolvedPath),
	};
}

/**
 * Preview-safe loader: read raw source without plan-mode enforcement or
 * editable-file guards. Used by streaming diff previews that must not throw
 * side-effecting errors while args are still being streamed.
 */
export async function loadChunkSource(params: {
	cwd: string;
	path: string;
}): Promise<{ resolvedPath: string; rawContent: string; language: string | undefined; exists: boolean }> {
	const resolvedPath = nodePath.isAbsolute(params.path) ? params.path : nodePath.resolve(params.cwd, params.path);
	const sourceFile = Bun.file(resolvedPath);
	const exists = await sourceFile.exists();
	const rawContent = exists ? await sourceFile.text() : "";
	return { resolvedPath, rawContent, language: getLanguageFromPath(resolvedPath), exists };
}

/**
 * Compute a unified diff preview for a chunk edit without applying it.
 * Used for streaming previews while args are still arriving. Returns
 * `{ error }` on any failure so callers can decide whether to surface it.
 */
export async function computeChunkDiff(
	input: { path: string; edits: ChunkToolEdit[] },
	cwd: string,
	options?: { anchorStyle?: ChunkAnchorStyle; signal?: AbortSignal },
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
	try {
		options?.signal?.throwIfAborted?.();
		const { filePath } = parseChunkEditPath(input.path);
		if (!filePath) return { error: "chunk edit path is empty" };
		const { resolvedPath, rawContent, language } = await loadChunkSource({ cwd, path: filePath });
		options?.signal?.throwIfAborted?.();
		const { operations } = normalizeChunkEditOperations(input.edits);
		const result = applyChunkEdits({
			source: rawContent,
			language,
			cwd,
			filePath: resolvedPath,
			operations,
			anchorStyle: options?.anchorStyle,
		});
		options?.signal?.throwIfAborted?.();
		if (!result.changed) {
			return { diff: "", firstChangedLine: undefined };
		}
		return generateUnifiedDiffString(result.diffSourceBefore, result.diffSourceAfter);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

function normalizeChunkRegionSyntax(text: string): string {
	return text.replaceAll("@body", "~").replaceAll("@head", "^");
}

function buildChunkEditResult(result: {
	diffBefore: string;
	diffAfter: string;
	responseText: string;
	changed: boolean;
	parseValid: boolean;
	touchedPaths: string[];
	warnings: string[];
}): ChunkEditResult {
	return {
		diffSourceBefore: result.diffBefore,
		diffSourceAfter: result.diffAfter,
		responseText: result.responseText,
		changed: result.changed,
		parseValid: result.parseValid,
		touchedPaths: result.touchedPaths,
		warnings: result.warnings.map(normalizeChunkRegionSyntax),
	};
}

function chunkReadPathSeparatorIndex(readPath: string): number {
	if (/^[a-zA-Z]:[/\\]/.test(readPath)) {
		return readPath.indexOf(":", 2);
	}
	const urlMatch = readPath.match(/^([a-z][a-z0-9+.-]*):\/\//i);
	if (urlMatch) {
		const scheme = urlMatch[1].toLowerCase();
		const urlPrefixEnd = urlMatch[0].length;
		if (scheme === "local") {
			const index = readPath.lastIndexOf(":");
			return index >= urlPrefixEnd ? index : -1;
		}

		const pathStart = readPath.indexOf("/", urlPrefixEnd);
		if (pathStart === -1) return -1;
		const index = readPath.lastIndexOf(":");
		return index >= pathStart ? index : -1;
	}
	return readPath.indexOf(":");
}

export function parseChunkSelector(selector: string | undefined): { selector?: string } {
	if (!selector || selector.length === 0) {
		return {};
	}
	return { selector };
}

/** Split a combined `file:selector` path into file path and chunk selector. */
export function parseChunkEditPath(editPath: string | undefined): { filePath: string; selector?: string } {
	if (!editPath) return { filePath: "" };
	const colonIndex = chunkReadPathSeparatorIndex(editPath);
	if (colonIndex === -1) {
		return { filePath: editPath };
	}
	const sel = editPath.slice(colonIndex + 1) || undefined;
	return { filePath: editPath.slice(0, colonIndex), selector: sel };
}

export function parseChunkReadPath(readPath: string): ParsedChunkReadPath {
	const colonIndex = chunkReadPathSeparatorIndex(readPath);
	if (colonIndex === -1) {
		return { filePath: readPath };
	}
	const parsedSelector = parseChunkSelector(readPath.slice(colonIndex + 1) || undefined);
	return {
		filePath: readPath.slice(0, colonIndex),
		selector: parsedSelector.selector,
	};
}

export function isChunkReadablePath(readPath: string): boolean {
	return parseChunkReadPath(readPath).selector !== undefined;
}

export async function loadChunkStateForFile(filePath: string, language: string | undefined): Promise<ChunkCacheEntry> {
	const file = Bun.file(filePath);
	const stat = await file.stat();
	const cached = chunkStateCache.get(filePath);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached;
	}

	const source = normalizeChunkSource(await file.text());
	const state = ChunkState.parse(source, normalizeLanguage(language));
	const entry = { mtimeMs: stat.mtimeMs, size: stat.size, source, state };
	chunkStateCache.set(filePath, entry);
	return entry;
}

export async function formatChunkedRead(params: {
	filePath: string;
	readPath: string;
	cwd: string;
	language?: string;
	omitChecksum?: boolean;
	anchorStyle?: ChunkAnchorStyle;
	absoluteLineRange?: { startLine: number; endLine?: number };
}): Promise<{ text: string; resolvedPath?: string; chunk?: ChunkReadTarget }> {
	const { filePath, readPath, cwd, language, omitChecksum = false, anchorStyle, absoluteLineRange } = params;
	const normalizedLanguage = normalizeLanguage(language);
	const { state } = await loadChunkStateForFile(filePath, normalizedLanguage);
	const displayPath = displayPathForFile(filePath, cwd);
	const renderIndentOptions = getChunkRenderIndentOptions();
	const result = state.renderRead({
		readPath,
		displayPath,
		languageTag: fileLanguageTag(filePath, normalizedLanguage),
		omitChecksum,
		anchorStyle,
		absoluteLineRange: absoluteLineRange
			? { startLine: absoluteLineRange.startLine, endLine: absoluteLineRange.endLine ?? absoluteLineRange.startLine }
			: undefined,
		tabReplacement: renderIndentOptions.tabReplacement,
		normalizeIndent: renderIndentOptions.normalizeIndent,
	});
	return { text: result.text, resolvedPath: filePath, chunk: result.chunk };
}

export type ChunkedGrepMatch = {
	displayPath: string;
	fileLineCount: number;
	chunkPath?: string;
	chunkChecksum?: string;
	lineNumber: number;
	line: string;
};

export async function describeChunkedGrepMatch(params: {
	filePath: string;
	lineNumber: number;
	line: string;
	cwd: string;
	language?: string;
}): Promise<ChunkedGrepMatch> {
	const { filePath, lineNumber, line, cwd, language } = params;
	const { state } = await loadChunkStateForFile(filePath, language);
	const chunkPath = state.lineToContainingChunkPath(lineNumber) || undefined;
	const chunkInfo = chunkPath ? state.chunk(chunkPath) : null;
	return {
		displayPath: displayPathForFile(filePath, cwd),
		fileLineCount: state.lineCount,
		chunkPath,
		chunkChecksum: chunkInfo?.checksum,
		lineNumber,
		line,
	};
}

const CHUNK_CHECKSUM_BIGRAMS = new Set<string>(HASHLINE_BIGRAMS);
type NativeChunkRegion = "head" | "body";

function isChunkChecksumToken(value: string): boolean {
	if (value.length !== 4) return false;
	const lower = value.toLowerCase();
	return CHUNK_CHECKSUM_BIGRAMS.has(lower.slice(0, 2)) && CHUNK_CHECKSUM_BIGRAMS.has(lower.slice(2, 4));
}

function parseChunkEditSelector(selector: string | undefined): {
	selector?: string;
	crc?: string;
	region?: NativeChunkRegion;
} {
	if (!selector) {
		return {};
	}

	let trimmed = selector.trim();
	if (trimmed.length === 0) {
		return {};
	}

	let region: NativeChunkRegion | undefined;
	const suffix = trimmed.at(-1);
	if (suffix === "~" || suffix === "^") {
		region = suffix === "~" ? "body" : "head";
		trimmed = trimmed.slice(0, -1).trimEnd();
	}

	let selectorPart = trimmed;
	let crc: string | undefined;
	const hashIndex = selectorPart.lastIndexOf("#");
	if (hashIndex >= 0) {
		const suffix = selectorPart.slice(hashIndex + 1).trim();
		if (isChunkChecksumToken(suffix)) {
			crc = suffix.toLowerCase();
			selectorPart = selectorPart.slice(0, hashIndex).trimEnd();
		}
	} else if (isChunkChecksumToken(selectorPart)) {
		crc = selectorPart.toLowerCase();
		selectorPart = "";
	}

	return { selector: selectorPart || undefined, crc, region };
}

type NativeChunkRegionEncoding = "named" | "symbolic";

function toNativeEditRegion(
	region: NativeChunkRegion | undefined,
	encoding: NativeChunkRegionEncoding,
): NativeEditOperation["region"] | undefined {
	if (!region) {
		return undefined;
	}
	if (encoding === "symbolic") {
		return region === "body" ? ChunkRegion.Body : ChunkRegion.Head;
	}
	return region as unknown as NativeEditOperation["region"] | undefined;
}

function toNativeEditOperation(
	operation: ChunkEditOperation,
	defaultRegion: NativeChunkRegion | undefined,
	encoding: NativeChunkRegionEncoding,
): NativeEditOperation {
	const { selector, crc, region } = parseChunkEditSelector(operation.sel);
	const nativeRegion = toNativeEditRegion(operation.sel === undefined ? (region ?? defaultRegion) : region, encoding);
	switch (operation.op) {
		case "put":
			return {
				op: ChunkEditOp.Put,
				sel: selector,
				crc,
				region: nativeRegion,
				content: operation.content,
			};
		case "before":
			return { op: ChunkEditOp.Before, sel: selector, crc, region: nativeRegion, content: operation.content };
		case "after":
			return { op: ChunkEditOp.After, sel: selector, crc, region: nativeRegion, content: operation.content };
		case "prepend":
			return { op: ChunkEditOp.Prepend, sel: selector, crc, region: nativeRegion, content: operation.content };
		case "append":
			return { op: ChunkEditOp.Append, sel: selector, crc, region: nativeRegion, content: operation.content };
		case "delete":
			return { op: ChunkEditOp.Delete, sel: selector, crc, region: nativeRegion };
		default: {
			const exhaustive: never = operation;
			return exhaustive;
		}
	}
}

function buildNativeChunkEditRequest(
	params: { defaultSelector?: string; defaultCrc?: string; operations: ChunkEditOperation[] },
	encoding: NativeChunkRegionEncoding,
): Pick<Parameters<ChunkState["applyEdits"]>[0], "operations" | "defaultSelector" | "defaultCrc"> {
	const parsedDefaultSelector = parseChunkEditSelector(params.defaultSelector);
	const operations = params.operations.map(operation =>
		toNativeEditOperation(operation, parsedDefaultSelector.region, encoding),
	);
	return {
		operations,
		defaultSelector: parsedDefaultSelector.selector,
		defaultCrc: params.defaultCrc ?? parsedDefaultSelector.crc,
	};
}

function isChunkRegionEncodingError(error: unknown): error is Error {
	return (
		error instanceof Error &&
		/value `"(body|head|~|\^)"` does not match any variant of enum `ChunkRegion`/.test(error.message)
	);
}

export function applyChunkEdits(params: {
	source: string;
	language?: string;
	cwd: string;
	filePath: string;
	operations: ChunkEditOperation[];
	defaultSelector?: string;
	defaultCrc?: string;
	anchorStyle?: ChunkAnchorStyle;
}): ChunkEditResult {
	const normalizedSource = normalizeChunkSource(params.source);
	const applyNativeEdits = (encoding: NativeChunkRegionEncoding): ChunkEditResult => {
		const request = buildNativeChunkEditRequest(params, encoding);
		const state = ChunkState.parse(normalizedSource, normalizeLanguage(params.language));
		return buildChunkEditResult(
			state.applyEdits({
				operations: request.operations,
				normalizeIndent: resolveChunkAutoIndent(),
				defaultSelector: request.defaultSelector,
				defaultCrc: request.defaultCrc,
				anchorStyle: params.anchorStyle,
				cwd: params.cwd,
				filePath: params.filePath,
			}),
		);
	};

	try {
		return applyNativeEdits("named");
	} catch (error) {
		if (isChunkRegionEncodingError(error)) {
			try {
				return applyNativeEdits("symbolic");
			} catch (fallbackError) {
				if (fallbackError instanceof Error) {
					throw new Error(normalizeChunkRegionSyntax(fallbackError.message));
				}
				throw fallbackError;
			}
		}
		if (error instanceof Error) {
			throw new Error(normalizeChunkRegionSyntax(error.message));
		}
		throw error;
	}
}

export async function getChunkInfoForFile(
	filePath: string,
	language: string | undefined,
	chunkPath: string,
): Promise<ChunkInfo | undefined> {
	const { state } = await loadChunkStateForFile(filePath, language);
	return state.chunk(chunkPath) ?? undefined;
}

export function missingChunkReadTarget(selector: string): ChunkReadTarget {
	return { status: ChunkReadStatus.NotFound, selector };
}

export const chunkToolEditSchema = Type.Object(
	{
		path: Type.Optional(
			Type.String({
				description: "File path with chunk selector. Examples: 'src/app.ts:fn_foo#thth~', 'src/app.ts:class_Bar'.",
			}),
		),
		write: Type.Optional(
			Type.Union([Type.String(), Type.Null()], {
				description:
					"Write complete new content to the targeted region. Null is rejected; use delete: true for deletion.",
			}),
		),
		delete: Type.Optional(
			Type.Boolean({
				description: "Explicitly delete the targeted chunk. Must be true; include the current chunk ID.",
			}),
		),
		insert: Type.Optional(
			Type.Object(
				{
					loc: StringEnum(["append", "prepend"] as const),
					body: Type.String({ description: "Content to insert." }),
				},
				{ description: "Insert content relative to the chunk." },
			),
		),
	},
	{ additionalProperties: false },
);
export const chunkEditParamsSchema = Type.Object(
	{
		path: Type.Optional(Type.String({ description: "Default file path used when an edit omits its own `path`" })),
		edits: Type.Array(chunkToolEditSchema, {
			description: "Chunk edits",
			minItems: 1,
		}),
	},
	{ additionalProperties: false },
);

export type ChunkToolEdit = Static<typeof chunkToolEditSchema>;
export type ChunkParams = Static<typeof chunkEditParamsSchema>;

export interface ExecuteChunkSingleOptions {
	session: ToolSession;
	path: string;
	edits: ChunkToolEdit[];
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

/** Auto-correct indentation for content targeting a body region (`~`) when autoIndent is on.
 *  Handles two patterns:
 *  1. Tab-based over-indentation: models include the function's base \t indent.
 *  2. Space-based indentation: models use literal spaces instead of \t.
 *  Returns the corrected content and any warnings. */
function autoCorrectBodyIndent(content: string, index: number): { content: string; warnings: string[] } {
	const warnings: string[] = [];
	if (!content || !resolveChunkAutoIndent()) return { content, warnings };
	const lines = content.split("\n");
	const nonEmpty = lines.filter(l => l.length > 0);
	if (nonEmpty.length <= 1) return { content, warnings };

	// 1. Tab-based over-indentation: strip common leading tabs.
	const minTabs = Math.min(...nonEmpty.map(l => l.match(/^\t*/)?.[0].length ?? 0));
	if (minTabs >= 1) {
		const fixed = lines.map(l => (l.length === 0 ? l : l.slice(minTabs))).join("\n");
		warnings.push(
			`Edit ${index + 1}: auto-corrected body indentation \u2014 stripped ${minTabs} leading tab(s). When writing to \`~\`, write at column 0; the tool adds the function's base indent.`,
		);
		return { content: fixed, warnings };
	}

	// 2. Space-based indentation: strip common leading spaces and convert to tabs.
	const spaceIndents = nonEmpty.map(l => l.match(/^ */)?.[0].length ?? 0);
	const minSpaces = Math.min(...spaceIndents);
	if (minSpaces >= 2) {
		const indentDiffs = spaceIndents.map(s => s - minSpaces).filter(d => d > 0);
		const indentUnit = indentDiffs.length > 0 ? Math.min(...indentDiffs) : 4;
		const unit = indentUnit >= 2 && indentUnit <= 8 ? indentUnit : 4;
		const fixed = lines
			.map(line => {
				if (line.length === 0) return line;
				const stripped = line.slice(minSpaces);
				const leadingSpaces = stripped.match(/^ */)?.[0].length ?? 0;
				const tabs = Math.floor(leadingSpaces / unit);
				const rem = leadingSpaces % unit;
				return "\t".repeat(tabs) + " ".repeat(rem) + stripped.slice(leadingSpaces);
			})
			.join("\n");
		warnings.push(
			`Edit ${index + 1}: auto-converted space indentation to tabs \u2014 stripped ${minSpaces} common leading spaces and converted ${unit}-space indent to tabs. When auto-indent is on, use \\t for indentation.`,
		);
		return { content: fixed, warnings };
	}

	return { content, warnings };
}

function chunkEditOperationFields(edit: ChunkToolEdit): string[] {
	const fields: string[] = [];
	if (edit.write !== undefined) fields.push("write");
	if (edit.insert != null) fields.push("insert");
	if (edit.delete === true) fields.push("delete");
	return fields;
}

function assertSingleChunkOperation(edit: ChunkToolEdit, index: number): string {
	const fields = chunkEditOperationFields(edit);
	if (fields.length === 0) {
		throw new Error(
			`Edit ${index + 1}: no operation specified. Use write:"..." to replace, insert:{loc,body} to insert, or delete:true to delete. Use the open tool to inspect chunks.`,
		);
	}
	if (fields.length > 1) {
		throw new Error(
			`Edit ${index + 1}: multiple operation fields set (${fields.join(", ")}). Each chunk edit entry must have exactly one operation.`,
		);
	}
	return fields[0];
}

function normalizeChunkEditOperations(edits: ChunkToolEdit[]): {
	operations: ChunkEditOperation[];
	warnings: string[];
} {
	const warnings: string[] = [];
	const operations = edits.map((edit, index): ChunkEditOperation => {
		const { selector } = parseChunkEditPath(edit.path);
		const operation = assertSingleChunkOperation(edit, index);
		if (operation === "write") {
			if (edit.write === null) {
				throw new Error(
					`Edit ${index + 1}: write:null no longer deletes chunks. Use delete:true to delete, or open the chunk to inspect its content without modifying the file.`,
				);
			}
			if (typeof edit.write !== "string") {
				throw new Error(`Edit ${index + 1}: write must be a string.`);
			}
			if (edit.write.length === 0) {
				throw new Error(
					`Edit ${index + 1}: write:"" is a destructive empty replacement. Use delete:true to delete the chunk, or open the chunk to inspect its content without modifying the file.`,
				);
			}
			let writeContent = edit.write;
			if (selector?.endsWith("~")) {
				const corrected = autoCorrectBodyIndent(writeContent, index);
				writeContent = corrected.content;
				warnings.push(...corrected.warnings);
			}
			return { op: "put", sel: selector, content: writeContent };
		}
		if (operation === "insert") {
			if (edit.insert == null || typeof edit.insert.body !== "string" || edit.insert.body.length === 0) {
				throw new Error(`Edit ${index + 1}: insert.body must be a non-empty string.`);
			}
			const op = edit.insert.loc === "prepend" ? "before" : "after";
			let insertContent = edit.insert.body;
			if (selector?.endsWith("~")) {
				const corrected = autoCorrectBodyIndent(insertContent, index);
				insertContent = corrected.content;
				warnings.push(...corrected.warnings);
			}
			return { op, sel: selector, content: insertContent };
		}
		if (operation !== "delete") {
			throw new Error(`Edit ${index + 1}: unsupported chunk edit operation "${operation}".`);
		}
		return { op: "delete", sel: selector };
	});
	return { operations, warnings };
}

async function writeChunkResult(params: {
	result: ChunkEditResult;
	resolvedPath: string;
	sourceFile: BunFile;
	sourceText: string;
	sourceExists: boolean;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}): Promise<AgentToolResult<EditToolDetails, typeof chunkEditParamsSchema>> {
	const {
		result,
		resolvedPath,
		sourceFile,
		sourceText,
		sourceExists,
		signal,
		batchRequest,
		writethrough,
		beginDeferredDiagnosticsForPath,
	} = params;

	const { bom, text } = stripBom(sourceText);
	const originalEnding = detectLineEnding(text);
	const finalContent = bom + restoreLineEndings(result.diffSourceAfter, originalEnding);
	const diagnostics = await writethrough(resolvedPath, finalContent, signal, sourceFile, batchRequest, dst =>
		dst === resolvedPath ? beginDeferredDiagnosticsForPath(resolvedPath) : undefined,
	);
	invalidateFsScanAfterWrite(resolvedPath);

	const diffResult = generateUnifiedDiffString(result.diffSourceBefore, result.diffSourceAfter);
	const warningsBlock = result.warnings.length > 0 ? `\n\nWarnings:\n${result.warnings.join("\n")}` : "";
	const meta = outputMeta()
		.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
		.get();

	return {
		content: [{ type: "text", text: `${result.responseText}${warningsBlock}` }],
		details: {
			diff: diffResult.diff,
			firstChangedLine: diffResult.firstChangedLine,
			diagnostics,
			op: sourceExists ? "update" : "create",
			meta,
		},
	};
}

export async function executeChunkSingle(
	options: ExecuteChunkSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof chunkEditParamsSchema>> {
	const { session, path, edits, signal, batchRequest, writethrough, beginDeferredDiagnosticsForPath } = options;
	const { resolvedPath, sourceFile, sourceExists, rawContent, chunkLanguage } = await resolveChunkSourceContext(
		session,
		path,
		{ intent: "write" },
	);
	const parentDir = nodePath.dirname(resolvedPath);
	if (parentDir && parentDir !== ".") {
		await fs.mkdir(parentDir, { recursive: true });
	}
	const { operations: normalizedOperations, warnings: normWarnings } = normalizeChunkEditOperations(edits);

	if (!sourceExists && normalizedOperations.some(op => op.sel)) {
		throw new Error(
			`File does not exist: ${path}. Cannot resolve chunk selectors on a non-existent file. Use the write tool to create a new file, or check the path for typos.`,
		);
	}

	const chunkResult = applyChunkEdits({
		source: rawContent,
		language: chunkLanguage,
		cwd: session.cwd,
		filePath: resolvedPath,
		operations: normalizedOperations,
		anchorStyle: resolveAnchorStyle(session.settings),
	});
	chunkResult.warnings.push(...normWarnings);

	if (!chunkResult.changed) {
		const warningsBlock = chunkResult.warnings.length > 0 ? `\n\nWarnings:\n${chunkResult.warnings.join("\n")}` : "";
		return {
			content: [{ type: "text", text: `[No changes needed — content already matches.]${warningsBlock}` }],
			details: {
				diff: "",
				op: sourceExists ? "update" : "create",
				meta: outputMeta().get(),
			},
		};
	}

	return writeChunkResult({
		result: chunkResult,
		resolvedPath,
		sourceFile,
		sourceText: rawContent,
		sourceExists,
		signal,
		batchRequest,
		writethrough,
		beginDeferredDiagnosticsForPath,
	});
}
