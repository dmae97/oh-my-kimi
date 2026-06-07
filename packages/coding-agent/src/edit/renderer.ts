/**
 * Edit tool renderer and LSP batching helpers.
 */

import { HL_FILE_PREFIX, HL_FILE_SUFFIX } from "@oh-my-pi/hashline";
import type { Component } from "@oh-my-pi/pi-tui";
import { visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { FileDiagnosticsResult } from "../lsp";
import { renderDiff as renderDiffColored } from "../modes/components/diff";
import { getLanguageFromPath, type Theme } from "../modes/theme/theme";
import type { OutputMeta } from "../tools/output-meta";
import {
	formatDiagnostics,
	formatDiffStats,
	formatExpandHint,
	formatStatusIcon,
	getDiffStats,
	getLspBatchRequest,
	type LspBatchRequest,
	PREVIEW_LIMITS,
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

function formatEditPathDisplay(
	rawPath: string,
	uiTheme: Theme,
	options?: { rename?: string; firstChangedLine?: number; linkPath?: string; renameLinkPath?: string },
): string {
	// `rawPath`/`rename` are shown (cwd-relative) but the OSC 8 link targets the
	// absolute path when known — a relative `rawPath` would yield a `file:///rel`
	// URI that resolves against filesystem root instead of cwd.
	const linkTarget = options?.linkPath || rawPath;
	let pathDisplay = rawPath
		? fileHyperlink(linkTarget, uiTheme.fg("accent", shortenPath(rawPath)))
		: uiTheme.fg("toolOutput", "…");

	if (options?.firstChangedLine) {
		pathDisplay += uiTheme.fg("warning", `:${options.firstChangedLine}`);
	}

	if (options?.rename) {
		const renameTarget = options.renameLinkPath || options.rename;
		pathDisplay += ` ${uiTheme.fg("dim", "→")} ${fileHyperlink(renameTarget, uiTheme.fg("accent", shortenPath(options.rename)))}`;
	}

	return pathDisplay;
}

function formatEditDescription(
	rawPath: string,
	uiTheme: Theme,
	options?: { rename?: string; firstChangedLine?: number; linkPath?: string; renameLinkPath?: string },
): { language: string; description: string } {
	const language = getLanguageFromPath(rawPath) ?? "text";
	const icon = uiTheme.fg("muted", uiTheme.getLangIcon(language));
	return {
		language,
		description: `${icon} ${formatEditPathDisplay(rawPath, uiTheme, options)}`,
	};
}

function renderPlainTextPreview(text: string, uiTheme: Theme, filePath?: string): string {
	const previewLines = sanitizeText(text).split("\n");
	let preview = "\n\n";
	for (const line of previewLines.slice(0, CALL_TEXT_PREVIEW_LINES)) {
		preview += `${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line, filePath), CALL_TEXT_PREVIEW_WIDTH))}\n`;
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
): string {
	if (!diff) return "";
	// Collapsed uses a "Cursor" tail window: pin the last
	// EDIT_STREAMING_PREVIEW_LINES rows to the bottom so freshly streamed changes
	// stay on screen. The whole-file diff is recomputed on every streamed chunk
	// and its Myers alignment is not monotonic in payload length, so a hunk-aware
	// window stutters as rows move between hunks. Expanded deliberately lifts that
	// cap for the approval-time full view.
	const allLines = diff.replace(/\n+$/u, "").split("\n");
	const hiddenLines = expanded ? 0 : Math.max(0, allLines.length - EDIT_STREAMING_PREVIEW_LINES);
	const visible = hiddenLines > 0 ? allLines.slice(hiddenLines) : allLines;
	let text = "\n\n";
	if (hiddenLines > 0) {
		const hiddenHunks = getDiffStats(allLines.slice(0, hiddenLines).join("\n")).hunks;
		const remainder: string[] = [];
		if (hiddenHunks > 0) remainder.push(`${hiddenHunks} more hunks`);
		remainder.push(`${hiddenLines} more lines`);
		text += `${uiTheme.fg("dim", `… (${remainder.join(", ")} above)`)}\n`;
	}
	text += renderDiffColored(visible.join("\n"), { filePath: rawPath });
	if (!expanded || label !== "preview") text += uiTheme.fg("dim", `\n(${label})`);
	return text;
}

function formatMultiFileStreamingDiff(previews: PerFileDiffPreview[], uiTheme: Theme, expanded: boolean): string {
	const parts: string[] = [];
	for (const preview of previews) {
		if (!preview.diff && !preview.error) continue;
		const header = uiTheme.fg("dim", `\n\n── ${shortenPath(preview.path)} ──`);
		if (preview.error) {
			parts.push(`${header}\n${uiTheme.fg("error", replaceTabs(preview.error, preview.path))}`);
			continue;
		}
		if (preview.diff) {
			parts.push(`${header}${formatStreamingDiff(preview.diff, preview.path, uiTheme, expanded, "preview")}`);
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
): string {
	const multi = renderContext?.perFileDiffPreview;
	if (multi && multi.length > 1 && multi.some(p => p.diff || p.error)) {
		return formatMultiFileStreamingDiff(multi, uiTheme, expanded);
	}
	if (args.previewDiff) {
		return formatStreamingDiff(args.previewDiff, rawPath, uiTheme, expanded, "preview");
	}
	if (args.diff && args.op) {
		return formatStreamingDiff(args.diff, rawPath, uiTheme, expanded);
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
	const { added, removed, hunks } = getDiffStats(diff);
	const stats = formatDiffStats(added, removed, hunks, uiTheme);
	if (!stats) return "";
	return ` ${uiTheme.fg("dim", uiTheme.format.bracketLeft)}${stats}${uiTheme.fg("dim", uiTheme.format.bracketRight)}`;
}

function renderDiffSection(
	diff: string,
	rawPath: string,
	expanded: boolean,
	uiTheme: Theme,
	renderDiffFn: (t: string, o?: { filePath?: string }) => string,
): string {
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
		const { description } = formatEditDescription(rawPath, uiTheme, { rename });
		let fileCount = hashlineInputSummary?.entries.length ?? applyPatchSummary?.entries.length ?? 0;
		if (Array.isArray(editArgs.edits)) {
			fileCount = countEditFiles(editArgs.edits);
		}
		return framedBlock(uiTheme, width => {
			let header = renderStatusLine(
				{ icon: "pending", spinnerFrame: options?.spinnerFrame, title: getOperationTitle(op), description },
				uiTheme,
			);
			if (fileCount > 1) header += uiTheme.fg("dim", ` (+${fileCount - 1} more)`);
			let body = getCallPreview(editArgs, rawPath, uiTheme, renderContext, options.expanded);
			if (applyPatchSummary?.error) {
				body += `\n${uiTheme.fg("error", truncateToWidth(replaceTabs(applyPatchSummary.error, rawPath), Math.max(1, width - 3)))}`;
			}
			const bodyLines = body ? body.split("\n") : [];
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: applyPatchSummary?.error ? "error" : "pending",
				borderColor: applyPatchSummary?.error ? "error" : "borderMuted",
				width,
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

	return framedBlock(uiTheme, width => {
		const { expanded, renderContext } = options;
		const editDiffPreview = renderContext?.editDiffPreview;
		const renderDiffFn = renderContext?.renderDiff ?? ((t: string) => t);

		const firstChangedLine =
			(editDiffPreview && "firstChangedLine" in editDiffPreview ? editDiffPreview.firstChangedLine : undefined) ||
			(details && !isError ? details.firstChangedLine : undefined);
		const linkPath = details && "path" in details ? details.path : undefined;
		const { description } = formatEditDescription(rawPath, uiTheme, { rename, firstChangedLine, linkPath });

		// Change stats ride inline on the header bar next to the path.
		const previewDiff = editDiffPreview && !("error" in editDiffPreview) ? editDiffPreview.diff : undefined;
		const headerDiff = isError ? undefined : details?.diff || previewDiff;
		const statsSuffix = headerDiff ? formatDiffStatsSuffix(headerDiff, uiTheme) : "";
		const header =
			renderStatusLine({ icon: isError ? "error" : "success", title: getOperationTitle(op), description }, uiTheme) +
			statsSuffix;

		let body = "";
		if (isError) {
			if (errorText) body = uiTheme.fg("error", replaceTabs(errorText, rawPath));
		} else if (details?.diff) {
			body = renderDiffSection(details.diff, rawPath, expanded, uiTheme, renderDiffFn);
		} else if (editDiffPreview) {
			if ("error" in editDiffPreview) body = uiTheme.fg("error", replaceTabs(editDiffPreview.error, rawPath));
			else if (editDiffPreview.diff)
				body = renderDiffSection(editDiffPreview.diff, rawPath, expanded, uiTheme, renderDiffFn);
		}
		if (details?.diagnostics) {
			body += formatDiagnostics(details.diagnostics, expanded, uiTheme, (fp: string) =>
				uiTheme.getLangIcon(getLanguageFromPath(fp)),
			);
		}

		// Diff lines self-wrap with a continuation gutter; pre-wrap to the frame's
		// inner width so renderOutputBlock's generic wrap is a no-op.
		const innerWidth = Math.max(1, width - 3);
		const bodyLines = body.length > 0 ? body.split("\n").flatMap(line => wrapEditRendererLine(line, innerWidth)) : [];
		while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();

		return {
			header,
			sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
			state: isError ? "error" : options.isPartial ? "pending" : "success",
			borderColor: isError ? "error" : "borderMuted",
			width,
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
