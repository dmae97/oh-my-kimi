/**
 * Edit tool renderer and LSP batching helpers.
 */

import { HL_FILE_PREFIX, HL_FILE_SUFFIX } from "@oh-my-pi/hashline";
import type { Component } from "@oh-my-pi/pi-tui";
import { sliceWithWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { FileDiagnosticsResult } from "../lsp";
import { renderDiff as renderDiffColored } from "../modes/components/diff";
import { getLanguageFromPath, type Theme } from "../modes/theme/theme";
import type { OutputMeta } from "../tools/output-meta";
import {
	cachedRenderedString,
	createRenderedStringCache,
	formatDiagnostics,
	formatExpandHint,
	formatStatusIcon,
	getDiffStats,
	getLspBatchRequest,
	invalidateRenderedStringCache,
	type LspBatchRequest,
	PREVIEW_LIMITS,
	type RenderedStringCache,
	replaceTabs,
	shortenPath,
	truncateDiffByHunk,
} from "../tools/render-utils";
import { fileHyperlink, framedBlock, Hasher, type RenderCache, renderStatusLine, truncateToWidth } from "../tui";
import type { EditMode } from "../utils/edit-mode";
import type { DiffError, DiffResult } from "./diff";
import { type ApplyPatchEntry, expandApplyPatchToEntries, expandApplyPatchToPreviewEntries } from "./modes/apply-patch";
import type { Operation } from "./modes/patch";
import type { PerFileDiffPreview } from "./streaming";

// ═══════════════════════════════════════════════════════════════════════════
// LSP Batching
// ═══════════════════════════════════════════════════════════════════════════

export { getLspBatchRequest, type LspBatchRequest };

// ═══════════════════════════════════════════════════════════════════════════
// Tool Details Types
// ═══════════════════════════════════════════════════════════════════════════

export interface EditToolPerFileResult {
	path: string;
	diff: string;
	firstChangedLine?: number;
	diagnostics?: FileDiagnosticsResult;
	op?: Operation;
	move?: string;
	isError?: boolean;
	errorText?: string;
	/** TUI-friendly error text. When present, rendered to the user instead of `errorText`.
	 * Set when the underlying error carries a `displayMessage` (e.g. {@link HashlineMismatchError}). */
	displayErrorText?: string;
	meta?: OutputMeta;
	/** Source-of-truth content before the edit; `undefined` for create operations. */
	oldText?: string;
	/** Source-of-truth content after the edit; `undefined` for delete operations. */
	newText?: string;
}

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** Diagnostic result (if available) */
	diagnostics?: FileDiagnosticsResult;
	/** Operation type (patch mode only) */
	op?: Operation;
	/** New path after move/rename (patch mode only) */
	move?: string;
	/** Structured output metadata */
	meta?: OutputMeta;
	/** Per-file results (multi-file edits) */
	perFileResults?: EditToolPerFileResult[];
	/** Absolute file path for single-file edit results. Required by ACP diff metadata consumers. */
	path?: string;
	/** Source-of-truth content before the edit; `undefined` for create operations. */
	oldText?: string;
	/** Source-of-truth content after the edit; `undefined` for delete operations. */
	newText?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// TUI Renderer
// ═══════════════════════════════════════════════════════════════════════════

interface EditRenderArgs {
	path?: string;
	file_path?: string;
	oldText?: string;
	newText?: string;
	patch?: string;
	input?: string;
	all?: boolean;
	// Patch mode fields
	op?: Operation;
	rename?: string;
	diff?: string;
	/**
	 * Computed preview diff (used when tool args don't include a diff, e.g. hashline mode).
	 */
	previewDiff?: string;
	__partialJson?: string;
	// Hashline mode fields
	edits?: EditRenderEntry[];
}

type EditRenderEntry = {
	path?: string;
	rename?: string;
	move?: string;
	op?: Operation;
};

interface HashlineInputRenderSummary {
	entries: Array<{ path: string }>;
}

interface ApplyPatchRenderSummary {
	entries: ApplyPatchEntry[];
	error?: string;
}

/** Extended context for edit tool rendering */
export interface EditRenderContext {
	/** Edit mode resolved by the caller; lets the renderer dispatch without shape-sniffing */
	editMode?: EditMode;
	/** Pre-computed diff preview (computed before tool executes) */
	editDiffPreview?: DiffResult | DiffError;
	/** Multi-file streaming diff preview (edits spanning several files) */
	perFileDiffPreview?: PerFileDiffPreview[];
	/** Raw in-flight edit text shown while a computed diff preview is unavailable */
	editStreamingFallback?: string;
	/** Function to render diff text with syntax highlighting */
	renderDiff?: (diffText: string, options?: { filePath?: string }) => string;
}

const EDIT_STREAMING_PREVIEW_LINES = 12;

function plainDiffRender(diffText: string): string {
	return diffText;
}

/**
 * Lazily grown per-file preview cache slots: the file count of a streaming
 * multi-file patch is discovered mid-stream, so a fixed-size array would
 * silently bypass caching for late files.
 */
function previewCacheAt(caches: RenderedStringCache[] | undefined, index: number): RenderedStringCache | undefined {
	if (!caches) return undefined;
	let cache = caches[index];
	if (cache === undefined) {
		cache = createRenderedStringCache();
		caches[index] = cache;
	}
	return cache;
}

const CALL_TEXT_PREVIEW_LINES = 6;
const CALL_TEXT_PREVIEW_WIDTH = 80;

/** Extract file path from an edit entry. */
function filePathFromEditEntry(p: string | undefined): string | undefined {
	return p ?? undefined;
}

function decodePartialJsonStringFragment(fragment: string): string {
	// Trim a trailing partial escape so JSON.parse sees a well-formed string.
	let text = fragment.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
	const trailingBackslashes = text.match(/\\+$/)?.[0].length ?? 0;
	if (trailingBackslashes % 2 === 1) text = text.slice(0, -1);
	try {
		return JSON.parse(`"${text}"`) as string;
	} catch {
		// Streaming fragment isn't a valid JSON string yet; surface it raw rather
		// than ad-hoc unescaping that mishandles surrogates and partial escapes.
		return text;
	}
}

function extractPartialJsonString(partialJson: string | undefined, key: string): string | undefined {
	if (!partialJson) return undefined;
	const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`, "u");
	const match = pattern.exec(partialJson);
	if (!match) return undefined;
	return decodePartialJsonStringFragment(match[1]);
}

function getPartialJsonEditPath(args: EditRenderArgs): string | undefined {
	return filePathFromEditEntry(extractPartialJsonString(args.__partialJson, "path"));
}

/** Count distinct file paths in an edits array. */
function countEditFiles(edits: EditRenderEntry[]): number {
	return new Set(edits.map(edit => filePathFromEditEntry(edit.path)).filter(Boolean)).size;
}

function getOperationTitle(op: Operation | undefined): string {
	return op === "create" ? "Create" : op === "delete" ? "Delete" : "Edit";
}

interface EditPathDisplayOptions {
	rename?: string;
	firstChangedLine?: number;
	linkPath?: string;
	renameLinkPath?: string;
	maxPathWidth?: number;
}

function truncateEditTitlePath(displayPath: string, maxWidth: number | undefined): string {
	if (maxWidth === undefined) return displayPath;
	const width = visibleWidth(displayPath);
	const safeMaxWidth = Math.max(0, Math.floor(maxWidth));
	if (width <= safeMaxWidth) return displayPath;

	const contentWidth = safeMaxWidth - 1;
	if (contentWidth <= 0) return "…";

	const headWidth = Math.floor(contentWidth / 2);
	const tailWidth = contentWidth - headWidth;
	const head = sliceWithWidth(displayPath, 0, headWidth, true).text;
	const tail = sliceWithWidth(displayPath, Math.max(0, width - tailWidth), tailWidth, true).text;
	return `${head}…${tail}`;
}

function formatEditTitlePath(pathValue: string, maxWidth?: number): string {
	return truncateEditTitlePath(replaceTabs(shortenPath(pathValue)), maxWidth);
}

function formatEditPathDisplay(
	rawPath: string,
	uiTheme: Theme,
	options?: EditPathDisplayOptions,
): { text: string; pathWidth: number } {
	// `rawPath`/`rename` are shown (cwd-relative) but the OSC 8 link targets the
	// absolute path when known — a relative `rawPath` would otherwise yield a
	// `file:///rel` URI that resolves against filesystem root instead of cwd.
	const linkTarget = options?.linkPath || rawPath;
	const lineLink = options?.firstChangedLine ? { line: options.firstChangedLine } : undefined;
	const primaryDisplay = rawPath ? formatEditTitlePath(rawPath, options?.maxPathWidth) : "…";
	let pathDisplay = rawPath
		? fileHyperlink(linkTarget, uiTheme.fg("accent", primaryDisplay), lineLink)
		: uiTheme.fg("toolOutput", primaryDisplay);
	let pathWidth = visibleWidth(primaryDisplay);

	if (options?.rename) {
		const renameTarget = options.renameLinkPath || options.rename;
		const renameDisplay = formatEditTitlePath(options.rename, options.maxPathWidth);
		pathDisplay += ` ${uiTheme.fg("dim", "→")} ${fileHyperlink(renameTarget, uiTheme.fg("accent", renameDisplay))}`;
		pathWidth += visibleWidth(renameDisplay);
	}

	return { text: pathDisplay, pathWidth };
}

function formatEditDescription(
	rawPath: string,
	uiTheme: Theme,
	options?: EditPathDisplayOptions,
): { language: string; description: string; pathWidth: number } {
	const language = getLanguageFromPath(rawPath) ?? "text";
	const icon = uiTheme.fg("muted", uiTheme.getLangIcon(language));
	const pathDisplay = formatEditPathDisplay(rawPath, uiTheme, options);
	return {
		language,
		description: `${icon} ${pathDisplay.text}`,
		pathWidth: pathDisplay.pathWidth,
	};
}

function editHeaderLabelBudget(width: number, uiTheme: Theme): number {
	const leftGlyphs = `${uiTheme.boxRound.topLeft}${uiTheme.boxRound.horizontal.repeat(3)}`;
	return Math.max(0, width - visibleWidth(leftGlyphs) - visibleWidth(uiTheme.boxRound.topRight) - 2);
}

function renderEditHeader(
	width: number,
	uiTheme: Theme,
	options: {
		icon: "pending" | "success" | "error";
		iconOverride?: string;
		op?: Operation;
		rawPath: string;
		rename?: string;
		firstChangedLine?: number;
		linkPath?: string;
		statsSuffix?: string;
		extraSuffix?: string;
	},
): string {
	const title = getOperationTitle(options.op);
	const descriptionOptions: EditPathDisplayOptions = {
		rename: options.rename,
		firstChangedLine: options.firstChangedLine,
		linkPath: options.linkPath,
	};
	const formatted = formatEditDescription(options.rawPath, uiTheme, descriptionOptions);
	const suffix = `${options.statsSuffix ?? ""}${options.extraSuffix ?? ""}`;
	const buildHeader = (description: string): string =>
		renderStatusLine(
			{
				icon: options.icon,
				iconOverride: options.iconOverride,
				title,
				description,
			},
			uiTheme,
		) + suffix;

	const header = buildHeader(formatted.description);
	const overflow = visibleWidth(header) - editHeaderLabelBudget(width, uiTheme);
	if (overflow <= 0 || formatted.pathWidth <= 1) return header;

	const pathCount = Math.max(1, (options.rawPath ? 1 : 0) + (options.rename ? 1 : 0));
	const fittedPathWidth = Math.max(1, Math.floor((formatted.pathWidth - overflow) / pathCount));
	const fitted = formatEditDescription(options.rawPath, uiTheme, {
		...descriptionOptions,
		maxPathWidth: fittedPathWidth,
	});
	return buildHeader(fitted.description);
}

function renderPlainTextPreview(text: string, uiTheme: Theme, _filePath?: string): string {
	const previewLines = sanitizeText(text).split("\n");
	let preview = "\n\n";
	for (const line of previewLines.slice(0, CALL_TEXT_PREVIEW_LINES)) {
		preview += `${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line), CALL_TEXT_PREVIEW_WIDTH))}\n`;
	}
	if (previewLines.length > CALL_TEXT_PREVIEW_LINES) {
		preview += uiTheme.fg("dim", `… ${previewLines.length - CALL_TEXT_PREVIEW_LINES} more lines`);
	}
	return preview.trimEnd();
}
function formatStreamingDiff(
	diff: string,
	rawPath: string,
	uiTheme: Theme,
	expanded: boolean,
	label = "streaming",
	spinnerFrame?: number,
	cache?: RenderedStringCache,
): string {
	if (!diff) return "";
	let text = cachedRenderedString(cache, uiTheme, expanded, rawPath, diff, () => {
		// Collapsed uses a "Cursor" tail window: pin the last
		// EDIT_STREAMING_PREVIEW_LINES rows to the bottom so freshly streamed changes
		// stay on screen. The whole-file diff is recomputed on every streamed chunk
		// and its Myers alignment is not monotonic in payload length, so a hunk-aware
		// window stutters as rows move between hunks. Expanded deliberately lifts that
		// cap for the approval-time full view.
		const allLines = diff.replace(/\n+$/u, "").split("\n");
		const hiddenLines = expanded ? 0 : Math.max(0, allLines.length - EDIT_STREAMING_PREVIEW_LINES);
		const visible = hiddenLines > 0 ? allLines.slice(hiddenLines) : allLines;
		let rendered = "\n\n";
		if (hiddenLines > 0) {
			const hiddenHunks = getDiffStats(allLines.slice(0, hiddenLines).join("\n")).hunks;
			const remainder: string[] = [];
			if (hiddenHunks > 0) remainder.push(`${hiddenHunks} more hunks`);
			remainder.push(`${hiddenLines} more lines`);
			rendered += `${uiTheme.fg("dim", `… (${remainder.join(", ")} above)`)}\n`;
		}
		rendered += renderDiffColored(visible.join("\n"), { filePath: rawPath });
		return rendered;
	});
	// The animated glyph rides this trailing line — inside the transcript's
	// volatile-tail holdback — never the block header: an animating head row
	// pins the native-scrollback commit boundary at the top of the block, so a
	// tall expanded preview could never scroll-append mid-stream.
	const spinner = spinnerFrame !== undefined ? `${formatStatusIcon("running", uiTheme, spinnerFrame)} ` : "";
	// Expanded approval previews hide the "(preview)" label (#1992) but keep
	// the animated glyph when one is active so the volatile tail stays live.
	const hideLabel = expanded && label === "preview";
	if (spinner || !hideLabel) {
		text += `\n${hideLabel ? spinner.trimEnd() : `${spinner}${uiTheme.fg("dim", `(${label})`)}`}`;
	}
	return text;
}

function formatMultiFileStreamingDiff(
	previews: PerFileDiffPreview[],
	uiTheme: Theme,
	expanded: boolean,
	spinnerFrame?: number,
	caches?: RenderedStringCache[],
): string {
	const parts: string[] = [];
	for (let index = 0; index < previews.length; index++) {
		const preview = previews[index]!;
		if (!preview.diff && !preview.error) continue;
		const header = uiTheme.fg("dim", `\n\n── ${shortenPath(preview.path)} ──`);
		if (preview.error) {
			parts.push(`${header}\n${uiTheme.fg("error", replaceTabs(preview.error))}`);
			continue;
		}
		if (preview.diff) {
			// Only the last file's preview carries the animated streaming glyph;
			// earlier files have settled and must stay byte-stable so their rows
			// can commit to native scrollback mid-stream.
			const isLast = index === previews.length - 1;
			const cache = previewCacheAt(caches, index);
			parts.push(
				`${header}${formatStreamingDiff(preview.diff, preview.path, uiTheme, expanded, "preview", isLast ? spinnerFrame : undefined, cache)}`,
			);
		}
	}
	return parts.join("");
}

function getCallPreview(
	args: EditRenderArgs,
	rawPath: string,
	uiTheme: Theme,
	renderContext: EditRenderContext | undefined,
	expanded: boolean,
	spinnerFrame?: number,
	caches?: RenderedStringCache[],
): string {
	const multi = renderContext?.perFileDiffPreview;
	if (multi && multi.length > 1 && multi.some(p => p.diff || p.error)) {
		return formatMultiFileStreamingDiff(multi, uiTheme, expanded, spinnerFrame, caches);
	}
	const cache = previewCacheAt(caches, 0);
	if (args.previewDiff) {
		return formatStreamingDiff(args.previewDiff, rawPath, uiTheme, expanded, "preview", spinnerFrame, cache);
	}
	if (args.diff && args.op) {
		return formatStreamingDiff(args.diff, rawPath, uiTheme, expanded, "streaming", spinnerFrame, cache);
	}
	if (args.diff) {
		return renderPlainTextPreview(args.diff, uiTheme, rawPath);
	}
	if (args.newText || args.patch) {
		return renderPlainTextPreview(args.newText ?? args.patch ?? "", uiTheme, rawPath);
	}
	if (renderContext?.editStreamingFallback) {
		return renderContext.editStreamingFallback;
	}
	return "";
}

const MISSING_APPLY_PATCH_END_ERROR = "The last line of the patch must be '*** End Patch'";

function normalizeHashlineInputPreviewPath(rawPath: string): string {
	const trimmed = rawPath.trim();
	const hashStart = /#[0-9a-fA-F]{4}$/u.exec(trimmed)?.index;
	const withoutHash = hashStart === undefined ? trimmed : trimmed.slice(0, hashStart);
	if (withoutHash.length < 2) return withoutHash;
	const first = withoutHash[0];
	const last = withoutHash[withoutHash.length - 1];
	if ((first === '"' || first === "'") && first === last) {
		return withoutHash.slice(1, -1);
	}
	return withoutHash;
}

function parseHashlineInputPreviewHeader(line: string): string | null {
	const trimmed = line.trimEnd();
	if (!trimmed.startsWith(HL_FILE_PREFIX)) return null;
	// Keep streaming previews tolerant while the closing bracket is still
	// being generated; the parser enforces the final `[path#TAG]` shape.
	const bodyEnd = trimmed.endsWith(HL_FILE_SUFFIX) ? trimmed.length - HL_FILE_SUFFIX.length : trimmed.length;
	const body = trimmed.slice(HL_FILE_PREFIX.length, bodyEnd).trim();
	const previewPath = normalizeHashlineInputPreviewPath(body);
	return previewPath.length > 0 ? previewPath : null;
}

function getHashlineInputPaths(input: string): string[] {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const paths: string[] = [];
	for (const rawLine of stripped.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const path = parseHashlineInputPreviewHeader(line);
		if (path) paths.push(path);
	}
	return paths;
}

function getHashlineInputRenderSummary(
	args: EditRenderArgs,
	editMode: EditMode | undefined,
): HashlineInputRenderSummary | undefined {
	if (editMode !== "hashline" || typeof args.input !== "string") {
		return undefined;
	}
	return { entries: getHashlineInputPaths(args.input).map(path => ({ path })) };
}

function getApplyPatchRenderSummary(
	args: EditRenderArgs,
	isPartial: boolean,
	editMode: EditMode | undefined,
): ApplyPatchRenderSummary | undefined {
	if (editMode !== undefined && editMode !== "apply_patch") {
		return undefined;
	}

	if (typeof args.input !== "string") {
		return undefined;
	}

	try {
		return { entries: expandApplyPatchToEntries({ input: args.input }) };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		if (isPartial && error === MISSING_APPLY_PATCH_END_ERROR) {
			return { entries: expandApplyPatchToPreviewEntries({ input: args.input }) };
		}
		return { entries: [], error };
	}
}

function formatDiffStatsSuffix(diff: string, uiTheme: Theme): string {
	const { added, removed } = getDiffStats(diff);
	if (added === 0 && removed === 0) return "";
	const stats = [
		added > 0 ? uiTheme.fg("toolDiffAdded", `+${added}`) : undefined,
		removed > 0 ? uiTheme.fg("toolDiffRemoved", `-${removed}`) : undefined,
	].filter(value => value !== undefined);
	return ` ${uiTheme.fg("dim", uiTheme.format.bracketLeft)}${stats.join(uiTheme.fg("dim", "/"))}${uiTheme.fg("dim", uiTheme.format.bracketRight)}`;
}
function renderDiffSection(
	diff: string,
	rawPath: string,
	expanded: boolean,
	uiTheme: Theme,
	renderDiffFn: (t: string, o?: { filePath?: string }) => string,
	cache?: RenderedStringCache,
): string {
	return cachedRenderedString(cache, uiTheme, expanded, rawPath, diff, () => {
		const {
			text: truncatedDiff,
			hiddenHunks,
			hiddenLines,
		} = expanded
			? { text: diff, hiddenHunks: 0, hiddenLines: 0 }
			: truncateDiffByHunk(diff, PREVIEW_LIMITS.DIFF_COLLAPSED_HUNKS, PREVIEW_LIMITS.DIFF_COLLAPSED_LINES);

		let text = `\n${renderDiffFn(truncatedDiff, { filePath: rawPath })}`;
		if (!expanded && (hiddenHunks > 0 || hiddenLines > 0)) {
			const remainder: string[] = [];
			if (hiddenHunks > 0) remainder.push(`${hiddenHunks} more hunks`);
			if (hiddenLines > 0) remainder.push(`${hiddenLines} more lines`);
			text += uiTheme.fg("toolOutput", `\n… (${remainder.join(", ")}) ${formatExpandHint(uiTheme)}`);
		}
		return text;
	});
}

function wrapEditRendererLine(line: string, width: number): string[] {
	if (width <= 0) return [line];
	if (line.length === 0) return [""];

	const startAnsi = line.match(/^((?:\x1b\[[0-9;]*m)*)/)?.[1] ?? "";
	const bodyWithReset = line.slice(startAnsi.length);
	const body = bodyWithReset.endsWith("\x1b[39m") ? bodyWithReset.slice(0, -"\x1b[39m".length) : bodyWithReset;
	const diffMatch = /^([+\-\s])(\s*\d+)([|│])(.*)$/s.exec(body);

	if (!diffMatch) {
		return wrapTextWithAnsi(line, width);
	}

	const [, marker, lineNum, separator, content] = diffMatch;
	const prefix = `${marker}${lineNum}${separator}`;
	const prefixWidth = visibleWidth(prefix);
	const contentWidth = Math.max(1, width - prefixWidth);
	const continuationPrefix = `${" ".repeat(Math.max(0, prefixWidth - 1))}${separator}`;
	const wrappedContent = wrapTextWithAnsi(content ?? "", contentWidth);

	return wrappedContent.map(
		(segment, index) => `${startAnsi}${index === 0 ? prefix : continuationPrefix}${segment}\x1b[39m`,
	);
}

export const editToolRenderer = {
	mergeCallAndResult: true,
	// Pending preview is a TAIL window of the streamed diff ("… N more lines
	// above" + last rows); the result render re-anchors the block top-first, so
	// committing the preview's settled head would strand a stale call-box
	// fragment in native scrollback.
	provisionalPendingPreview: true,

	renderCall(
		args: EditRenderArgs,
		options: RenderResultOptions & { renderContext?: EditRenderContext },
		uiTheme: Theme,
	): Component {
		const renderContext = options.renderContext;
		const editArgs = args as EditRenderArgs;
		const hashlineInputSummary = getHashlineInputRenderSummary(editArgs, renderContext?.editMode);
		const applyPatchSummary = getApplyPatchRenderSummary(editArgs, options.isPartial, renderContext?.editMode);
		const firstApplyPatchEntry = applyPatchSummary?.entries[0];
		const firstHashlineInputEntry = hashlineInputSummary?.entries[0];
		// Extract path from first edit entry when top-level path is absent (new schema)
		const firstEdit = Array.isArray(editArgs.edits) && editArgs.edits.length > 0 ? editArgs.edits[0] : undefined;
		const rawPath =
			editArgs.file_path ||
			editArgs.path ||
			filePathFromEditEntry(firstEdit?.path) ||
			getPartialJsonEditPath(editArgs) ||
			firstHashlineInputEntry?.path ||
			firstApplyPatchEntry?.path ||
			"";
		const rename = editArgs.rename || firstEdit?.rename || firstEdit?.move || firstApplyPatchEntry?.rename;
		const op = editArgs.op || firstEdit?.op || firstApplyPatchEntry?.op;
		let fileCount = hashlineInputSummary?.entries.length ?? applyPatchSummary?.entries.length ?? 0;
		if (Array.isArray(editArgs.edits)) {
			fileCount = countEditFiles(editArgs.edits);
		}
		const callPreviewCaches: RenderedStringCache[] = [];
		return framedBlock(uiTheme, width => {
			// Static pending icon, never the animated glyph: the header is the
			// head row of the framed block, and native-scrollback commits are
			// prefix-only — an animating head row would pin the commit boundary
			// at the top and keep a tall expanded preview from scroll-appending
			// mid-stream. The liveness cue rides the trailing "(preview)" /
			// "(streaming)" line instead.
			const header = renderEditHeader(width, uiTheme, {
				icon: "pending",
				op,
				rawPath,
				rename,
				extraSuffix: fileCount > 1 ? uiTheme.fg("dim", ` (+${fileCount - 1} more)`) : undefined,
			});
			let body = getCallPreview(
				editArgs,
				rawPath,
				uiTheme,
				renderContext,
				options.expanded,
				options?.spinnerFrame,
				callPreviewCaches,
			);
			if (applyPatchSummary?.error) {
				body += `\n${uiTheme.fg("error", truncateToWidth(replaceTabs(applyPatchSummary.error), Math.max(1, width - 2)))}`;
			}
			const bodyLines = body ? body.split("\n") : [];
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: applyPatchSummary?.error ? "error" : "pending",
				borderColor: applyPatchSummary?.error ? "error" : "borderMuted",
				width,
				contentPaddingLeft: 0,
			};
		});
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: EditToolDetails; isError?: boolean },
		options: RenderResultOptions & { renderContext?: EditRenderContext },
		uiTheme: Theme,
		args?: EditRenderArgs,
	): Component {
		const perFileResults = result.details?.perFileResults;
		const totalFiles = args?.edits ? countEditFiles(args.edits) : 0;
		if (perFileResults && (perFileResults.length > 1 || totalFiles > 1)) {
			return renderMultiFileResult(perFileResults, totalFiles, options, uiTheme);
		}
		return renderSingleFileResult(result, options, uiTheme, args);
	},
};

function renderSingleFileResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: EditToolDetails | EditToolPerFileResult;
		isError?: boolean;
	},
	options: RenderResultOptions & { renderContext?: EditRenderContext },
	uiTheme: Theme,
	args?: EditRenderArgs,
): Component {
	const details = result.details;
	const isError = result.isError ?? (details && "isError" in details ? details.isError : false);
	const firstEdit = args?.edits?.[0];
	const hashlineInputSummary = getHashlineInputRenderSummary(args ?? {}, options.renderContext?.editMode);
	const firstHashlineInputEntry = hashlineInputSummary?.entries[0];
	const rawPath =
		args?.file_path ||
		args?.path ||
		filePathFromEditEntry(firstEdit?.path) ||
		(details && "path" in details ? details.path : "") ||
		firstHashlineInputEntry?.path ||
		"";
	const op = args?.op || firstEdit?.op || details?.op;
	const rename = args?.rename || firstEdit?.rename || firstEdit?.move || details?.move;

	const displayErrorText = isError && details && "displayErrorText" in details ? details.displayErrorText : undefined;
	const errorText = isError
		? displayErrorText ||
			(details && "errorText" in details && details.errorText) ||
			(result.content?.find(c => c.type === "text")?.text ?? "")
		: "";

	let diffSectionRenderDiffFn: ((t: string, o?: { filePath?: string }) => string) | undefined;
	const diffSectionCache = createRenderedStringCache();

	return framedBlock(uiTheme, width => {
		const { expanded, renderContext } = options;
		const editDiffPreview = renderContext?.editDiffPreview;
		const renderDiffFn = renderContext?.renderDiff ?? plainDiffRender;

		if (diffSectionRenderDiffFn !== renderDiffFn) {
			diffSectionRenderDiffFn = renderDiffFn;
			invalidateRenderedStringCache(diffSectionCache);
		}
		const firstChangedLine =
			(editDiffPreview && "firstChangedLine" in editDiffPreview ? editDiffPreview.firstChangedLine : undefined) ||
			(details && !isError ? details.firstChangedLine : undefined);
		const linkPath = details && "path" in details ? details.path : undefined;

		// Change stats ride inline on the header bar next to the path.
		const previewDiff = editDiffPreview && !("error" in editDiffPreview) ? editDiffPreview.diff : undefined;
		const headerDiff = isError ? undefined : details?.diff || previewDiff;
		const statsSuffix = headerDiff ? formatDiffStatsSuffix(headerDiff, uiTheme) : "";
		const header = renderEditHeader(width, uiTheme, {
			icon: isError ? "error" : "success",
			iconOverride: !isError && !options.isPartial ? uiTheme.styledSymbol("tool.edit", "accent") : undefined,
			op,
			rawPath,
			rename,
			firstChangedLine,
			linkPath,
			statsSuffix,
		});

		let body = "";
		if (isError) {
			if (errorText) body = uiTheme.fg("error", replaceTabs(errorText));
		} else if (details?.diff) {
			body = renderDiffSection(details.diff, rawPath, expanded, uiTheme, renderDiffFn, diffSectionCache);
		} else if (editDiffPreview) {
			if ("error" in editDiffPreview) body = uiTheme.fg("error", replaceTabs(editDiffPreview.error));
			else if (editDiffPreview.diff)
				body = renderDiffSection(editDiffPreview.diff, rawPath, expanded, uiTheme, renderDiffFn, diffSectionCache);
		}
		if (details?.diagnostics) {
			body += formatDiagnostics(details.diagnostics, expanded, uiTheme, (fp: string) =>
				uiTheme.getLangIcon(getLanguageFromPath(fp)),
			);
		}

		// Diff lines self-wrap with a continuation gutter; pre-wrap to the frame's
		// inner width so renderOutputBlock's generic wrap is a no-op. Edit frames
		// use a flush left border because code-frame gutters already provide padding.
		const innerWidth = Math.max(1, width - 2);
		const bodyLines = body.length > 0 ? body.split("\n").flatMap(line => wrapEditRendererLine(line, innerWidth)) : [];
		while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();

		return {
			header,
			sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
			state: isError ? "error" : options.isPartial ? "pending" : "success",
			borderColor: isError ? "error" : "borderMuted",
			width,
			contentPaddingLeft: 0,
		};
	});
}

function renderMultiFileResult(
	perFileResults: EditToolPerFileResult[],
	totalFiles: number,
	options: RenderResultOptions & { renderContext?: EditRenderContext },
	uiTheme: Theme,
): Component {
	const fileComponents = perFileResults.map(fileResult =>
		renderSingleFileResult({ content: [], details: fileResult, isError: fileResult.isError }, options, uiTheme),
	);
	const remaining = Math.max(0, totalFiles - perFileResults.length);

	let cached: RenderCache | undefined;

	return {
		render(width) {
			const key = new Hasher().bool(options.expanded).u32(width).u32(perFileResults.length).u32(remaining).digest();
			if (cached?.key === key) return cached.lines;

			const allLines: string[] = [];
			for (let i = 0; i < fileComponents.length; i++) {
				if (i > 0) {
					allLines.push("");
				}
				allLines.push(...fileComponents[i].render(width));
			}

			// Show pending indicator for files still being processed
			if (remaining > 0) {
				if (allLines.length > 0) allLines.push("");
				const spinnerFrame = options.spinnerFrame;
				const spinner = spinnerFrame !== undefined ? formatStatusIcon("running", uiTheme, spinnerFrame) : "";
				allLines.push(
					renderStatusLine(
						{
							icon: "pending",
							title: "Edit",
							description: uiTheme.fg("dim", `${remaining} more file${remaining > 1 ? "s" : ""} pending…`),
						},
						uiTheme,
					),
				);
				if (spinner) {
					// Replace the pending icon with spinner on the last line
					allLines[allLines.length - 1] = allLines[allLines.length - 1].replace(/^(?:\x1b\[[^m]*m)*./u, spinner);
				}
			}

			cached = { key, lines: allLines };
			return allLines;
		},
		invalidate() {
			cached = undefined;
			for (const c of fileComponents) c.invalidate?.();
		},
	};
}
