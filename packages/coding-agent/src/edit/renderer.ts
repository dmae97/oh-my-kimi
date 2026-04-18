/**
 * Edit tool renderer and LSP batching helpers.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import { Text, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
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
	formatTitle,
	getDiffStats,
	getLspBatchRequest,
	type LspBatchRequest,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenPath,
	truncateDiffByHunk,
} from "../tools/render-utils";
import { type VimRenderArgs, vimToolRenderer } from "../tools/vim";
import { Hasher, type RenderCache, renderStatusLine, truncateToWidth } from "../tui";
import type { VimToolDetails } from "../vim/types";
import type { DiffError, DiffResult } from "./diff";
import { expandApplyPatchToEntries } from "./modes/apply-patch";
import { type ChunkToolEdit, parseChunkEditPath } from "./modes/chunk";
import type { HashlineToolEdit } from "./modes/hashline";
import type { Operation, PatchEditEntry } from "./modes/patch";

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
	meta?: OutputMeta;
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
	// Hashline / chunk mode fields
	edits?: EditRenderEntry[];
}

type EditRenderEntry = {
	path?: string;
	rename?: string;
	move?: string;
	op?: Operation;
};

interface ApplyPatchRenderSummary {
	entries: PatchEditEntry[];
	error?: string;
}

function isVimRenderArgs(args: EditRenderArgs | VimRenderArgs): args is VimRenderArgs {
	return (
		typeof args === "object" &&
		args !== null &&
		typeof (args as { file?: unknown }).file === "string" &&
		!("path" in args) &&
		!("file_path" in args) &&
		!("edits" in args)
	);
}

function isVimToolDetails(details: unknown): details is VimToolDetails {
	if (!details || typeof details !== "object" || Array.isArray(details)) {
		return false;
	}
	const cursor = (details as { cursor?: unknown }).cursor;
	const viewportLines = (details as { viewportLines?: unknown }).viewportLines;
	return (
		typeof (details as { file?: unknown }).file === "string" &&
		typeof cursor === "object" &&
		cursor !== null &&
		Array.isArray(viewportLines)
	);
}

/** Extended context for edit tool rendering */
export interface EditRenderContext {
	/** Pre-computed diff preview (computed before tool executes) */
	editDiffPreview?: DiffResult | DiffError;
	/** Function to render diff text with syntax highlighting */
	renderDiff?: (diffText: string, options?: { filePath?: string }) => string;
}

const EDIT_STREAMING_PREVIEW_LINES = 12;
const CALL_TEXT_PREVIEW_LINES = 6;
const CALL_TEXT_PREVIEW_WIDTH = 80;
const STREAMING_EDIT_PREVIEW_WIDTH = 120;
const STREAMING_EDIT_PREVIEW_LIMIT = 4;
const STREAMING_EDIT_PREVIEW_DST_LINE_LIMIT = 8;

interface FormattedStreamingEdit {
	srcLabel: string;
	dst: string;
}

/** Extract file path from an edit entry's path (handles chunk's file:selector format). */
function filePathFromEditEntry(p: string | undefined): string | undefined {
	if (!p) return undefined;
	const ci = /^[a-zA-Z]:[/\\]/.test(p) ? p.indexOf(":", 2) : p.indexOf(":");
	return ci === -1 ? p : p.slice(0, ci);
}

/** Count distinct file paths in an edits array. */
function countEditFiles(edits: EditRenderEntry[]): number {
	return new Set(edits.map(edit => filePathFromEditEntry(edit.path)).filter(Boolean)).size;
}

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function getOperationTitle(op: Operation | undefined): string {
	return op === "create" ? "Create" : op === "delete" ? "Delete" : "Edit";
}

function formatEditPathDisplay(
	rawPath: string,
	uiTheme: Theme,
	options?: { rename?: string; firstChangedLine?: number },
): string {
	let pathDisplay = rawPath ? uiTheme.fg("accent", shortenPath(rawPath)) : uiTheme.fg("toolOutput", "…");

	if (options?.firstChangedLine) {
		pathDisplay += uiTheme.fg("warning", `:${options.firstChangedLine}`);
	}

	if (options?.rename) {
		pathDisplay += ` ${uiTheme.fg("dim", "→")} ${uiTheme.fg("accent", shortenPath(options.rename))}`;
	}

	return pathDisplay;
}

function formatEditDescription(
	rawPath: string,
	uiTheme: Theme,
	options?: { rename?: string; firstChangedLine?: number },
): { language: string; description: string } {
	const language = getLanguageFromPath(rawPath) ?? "text";
	const icon = uiTheme.fg("muted", uiTheme.getLangIcon(language));
	return {
		language,
		description: `${icon} ${formatEditPathDisplay(rawPath, uiTheme, options)}`,
	};
}

function renderPlainTextPreview(text: string, uiTheme: Theme): string {
	const previewLines = text.split("\n");
	let preview = "\n\n";
	for (const line of previewLines.slice(0, CALL_TEXT_PREVIEW_LINES)) {
		preview += `${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line), CALL_TEXT_PREVIEW_WIDTH))}\n`;
	}
	if (previewLines.length > CALL_TEXT_PREVIEW_LINES) {
		preview += uiTheme.fg("dim", `… ${previewLines.length - CALL_TEXT_PREVIEW_LINES} more lines`);
	}
	return preview.trimEnd();
}

function formatStreamingDiff(diff: string, rawPath: string, uiTheme: Theme, label = "streaming"): string {
	if (!diff) return "";
	const lines = diff.split("\n");
	const total = lines.length;
	const displayLines = lines.slice(-EDIT_STREAMING_PREVIEW_LINES);
	const hidden = total - displayLines.length;
	let text = "\n\n";
	if (hidden > 0) {
		text += uiTheme.fg("dim", `… (${hidden} earlier lines)\n`);
	}
	text += renderDiffColored(displayLines.join("\n"), { filePath: rawPath });
	text += uiTheme.fg("dim", `\n… (${label})`);
	return text;
}

function isChunkStreamingEdit(edit: Partial<HashlineToolEdit | ChunkToolEdit>): edit is Partial<ChunkToolEdit> {
	return (
		typeof edit === "object" &&
		edit !== null &&
		"path" in edit &&
		("write" in edit || "replace" in edit || "insert" in edit)
	);
}

function getStreamingEditContent(content: unknown): string {
	if (Array.isArray(content)) {
		return content.join("\n");
	}
	return typeof content === "string" ? content : "";
}

function formatHashlineStreamingEdit(edit: Partial<HashlineToolEdit>): FormattedStreamingEdit {
	if (typeof edit !== "object" || !edit) {
		return { srcLabel: "\u2022 (incomplete edit)", dst: "" };
	}

	const contentLines = getStreamingEditContent(edit.content);
	const loc = edit.loc;

	if (loc === "append" || loc === "prepend") {
		return { srcLabel: `\u2022 ${loc} (file-level)`, dst: contentLines };
	}
	if (typeof loc === "object" && loc) {
		if ("range" in loc && typeof loc.range === "object" && loc.range) {
			return { srcLabel: `\u2022 range ${loc.range.pos ?? "?"}\u2026${loc.range.end ?? "?"}`, dst: contentLines };
		}
		if ("line" in loc) {
			return { srcLabel: `\u2022 line ${(loc as { line: string }).line}`, dst: contentLines };
		}
		if ("append" in loc) {
			return { srcLabel: `\u2022 append ${(loc as { append: string }).append}`, dst: contentLines };
		}
		if ("prepend" in loc) {
			return { srcLabel: `\u2022 prepend ${(loc as { prepend: string }).prepend}`, dst: contentLines };
		}
	}
	return { srcLabel: "\u2022 (unknown edit)", dst: contentLines };
}

function formatChunkStreamingEdit(edit: Partial<ChunkToolEdit>): FormattedStreamingEdit {
	if (typeof edit !== "object" || !edit) {
		return { srcLabel: "\u2022 (incomplete edit)", dst: "" };
	}

	const target = edit.path ? (parseChunkEditPath(edit.path).selector ?? edit.path) : "?";
	if (edit.write === null) {
		return { srcLabel: `\u2022 remove ${target}`, dst: "" };
	}
	if (typeof edit.write === "string") {
		return { srcLabel: `\u2022 replace ${target}`, dst: getStreamingEditContent(edit.write) };
	}
	if (typeof edit.replace === "object" && edit.replace) {
		return { srcLabel: `\u2022 replace ${target}`, dst: getStreamingEditContent(edit.replace.new) };
	}
	if (typeof edit.insert === "object" && edit.insert) {
		return { srcLabel: `\u2022 ${edit.insert.loc} ${target}`, dst: getStreamingEditContent(edit.insert.body) };
	}
	return { srcLabel: `\u2022 edit ${target}`, dst: "" };
}

function formatStreamingHashlineEdits(edits: Partial<HashlineToolEdit | ChunkToolEdit>[], uiTheme: Theme): string {
	let text = "\n\n";

	// Detect whether these are chunk edits (target field) or hashline edits (loc field)
	const isChunk = edits.length > 0 && isChunkStreamingEdit(edits[0]);
	const label = isChunk ? "chunk edit" : "hashline edit";
	const formatEdit = isChunk ? formatChunkStreamingEdit : formatHashlineStreamingEdit;
	text += uiTheme.fg("dim", `[${edits.length} ${label}${edits.length === 1 ? "" : "s"}]`);
	text += "\n";
	let shownEdits = 0;
	let shownDstLines = 0;
	for (const edit of edits) {
		shownEdits++;
		if (shownEdits > STREAMING_EDIT_PREVIEW_LIMIT) break;
		const formatted = formatEdit(edit as never);
		text += uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(formatted.srcLabel), STREAMING_EDIT_PREVIEW_WIDTH));
		text += "\n";
		if (formatted.dst === "") {
			text += uiTheme.fg("dim", truncateToWidth("  (delete)", STREAMING_EDIT_PREVIEW_WIDTH));
			text += "\n";
			continue;
		}
		for (const dstLine of formatted.dst.split("\n")) {
			shownDstLines++;
			if (shownDstLines > STREAMING_EDIT_PREVIEW_DST_LINE_LIMIT) break;
			text += uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(`+ ${dstLine}`), STREAMING_EDIT_PREVIEW_WIDTH));
			text += "\n";
		}
		if (shownDstLines > STREAMING_EDIT_PREVIEW_DST_LINE_LIMIT) break;
	}
	if (edits.length > STREAMING_EDIT_PREVIEW_LIMIT) {
		text += uiTheme.fg("dim", `\u2026 (${edits.length - STREAMING_EDIT_PREVIEW_LIMIT} more edits)`);
	}
	if (shownDstLines > STREAMING_EDIT_PREVIEW_DST_LINE_LIMIT) {
		text += uiTheme.fg("dim", `\n\u2026 (${shownDstLines - STREAMING_EDIT_PREVIEW_DST_LINE_LIMIT} more dst lines)`);
	}

	return text.trimEnd();
}

function formatMetadataLine(lineCount: number | null, language: string | undefined, uiTheme: Theme): string {
	const icon = uiTheme.getLangIcon(language);
	if (lineCount !== null) {
		return uiTheme.fg("dim", `${icon} ${lineCount} lines`);
	}
	return uiTheme.fg("dim", `${icon}`);
}

function getCallPreview(args: EditRenderArgs, rawPath: string, uiTheme: Theme): string {
	if (args.previewDiff) {
		return formatStreamingDiff(args.previewDiff, rawPath, uiTheme, "preview");
	}
	if (args.diff && args.op) {
		return formatStreamingDiff(args.diff, rawPath, uiTheme);
	}
	if (args.edits && args.edits.length > 0) {
		// Only show hashline/chunk streaming edits — replace/patch use previewDiff above
		const first = args.edits[0];
		if (first && typeof first === "object" && ("loc" in first || isChunkStreamingEdit(first))) {
			return formatStreamingHashlineEdits(args.edits, uiTheme);
		}
	}
	if (args.diff) {
		return renderPlainTextPreview(args.diff, uiTheme);
	}
	if (args.newText || args.patch) {
		return renderPlainTextPreview(args.newText ?? args.patch ?? "", uiTheme);
	}
	return "";
}

function getApplyPatchRenderSummary(args: EditRenderArgs): ApplyPatchRenderSummary | undefined {
	if (typeof args.input !== "string") {
		return undefined;
	}

	try {
		return { entries: expandApplyPatchToEntries({ input: args.input }) };
	} catch (err) {
		return { entries: [], error: err instanceof Error ? err.message : String(err) };
	}
}

function renderDiffSection(
	diff: string,
	rawPath: string,
	expanded: boolean,
	uiTheme: Theme,
	renderDiffFn: (t: string, o?: { filePath?: string }) => string,
): string {
	let text = "";
	const diffStats = getDiffStats(diff);
	text += `\n${uiTheme.fg("dim", uiTheme.format.bracketLeft)}${formatDiffStats(
		diffStats.added,
		diffStats.removed,
		diffStats.hunks,
		uiTheme,
	)}${uiTheme.fg("dim", uiTheme.format.bracketRight)}`;

	const {
		text: truncatedDiff,
		hiddenHunks,
		hiddenLines,
	} = expanded
		? { text: diff, hiddenHunks: 0, hiddenLines: 0 }
		: truncateDiffByHunk(diff, PREVIEW_LIMITS.DIFF_COLLAPSED_HUNKS, PREVIEW_LIMITS.DIFF_COLLAPSED_LINES);

	text += `\n\n${renderDiffFn(truncatedDiff, { filePath: rawPath })}`;
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
	const diffMatch = /^([+\-\s])(\s*\d+)\|(.*)$/s.exec(body);

	if (!diffMatch) {
		return wrapTextWithAnsi(line, width);
	}

	const [, marker, lineNum, content] = diffMatch;
	const prefix = `${marker}${lineNum}|`;
	const prefixWidth = visibleWidth(prefix);
	const contentWidth = Math.max(1, width - prefixWidth);
	const continuationPrefix = `${" ".repeat(Math.max(0, prefixWidth - 1))}|`;
	const wrappedContent = wrapTextWithAnsi(content, contentWidth);

	return wrappedContent.map(
		(segment, index) => `${startAnsi}${index === 0 ? prefix : continuationPrefix}${segment}\x1b[39m`,
	);
}

export const editToolRenderer = {
	mergeCallAndResult: true,

	renderCall(args: EditRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		if (isVimRenderArgs(args)) {
			return vimToolRenderer.renderCall(args, options, uiTheme);
		}

		const applyPatchSummary = getApplyPatchRenderSummary(args);
		const firstApplyPatchEntry = applyPatchSummary?.entries[0];
		// Extract path from first edit entry when top-level path is absent (new schema)
		const firstEdit = Array.isArray(args.edits) && args.edits.length > 0 ? args.edits[0] : undefined;
		const rawPath = args.file_path || args.path || filePathFromEditEntry(firstEdit?.path) || firstApplyPatchEntry?.path || "";
		const rename = args.rename || firstEdit?.rename || firstEdit?.move || firstApplyPatchEntry?.rename;
		const op = args.op || firstEdit?.op || firstApplyPatchEntry?.op;
		const { description } = formatEditDescription(rawPath, uiTheme, { rename });
		const spinner =
			options?.spinnerFrame !== undefined ? formatStatusIcon("running", uiTheme, options.spinnerFrame) : "";
		let text = `${formatTitle(getOperationTitle(op), uiTheme)} ${spinner ? `${spinner} ` : ""}${description}`;
		// Show file count hint for multi-file edits
		const fileCount = Array.isArray(args.edits)
			? countEditFiles(args.edits)
			: (applyPatchSummary?.entries.length ?? 0);
		if (fileCount > 1) {
			text += uiTheme.fg("dim", ` (+${fileCount - 1} more)`);
		}
		text += getCallPreview(args, rawPath, uiTheme);
		if (applyPatchSummary?.error) {
			text += `\n\n${uiTheme.fg("error", truncateToWidth(replaceTabs(applyPatchSummary.error), CALL_TEXT_PREVIEW_WIDTH))}`;
		}

		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: EditToolDetails; isError?: boolean },
		options: RenderResultOptions & { renderContext?: EditRenderContext },
		uiTheme: Theme,
		args?: EditRenderArgs,
	): Component {
		if (isVimToolDetails(result.details)) {
			return vimToolRenderer.renderResult(
				result as { content: Array<{ type: string; text?: string }>; details?: VimToolDetails; isError?: boolean },
				options,
				uiTheme,
			);
		}

		const perFileResults = result.details?.perFileResults;
		const totalFiles = Array.isArray(args?.edits) ? countEditFiles(args!.edits as any[]) : 0;
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
	const firstEdit = Array.isArray(args?.edits) && args!.edits.length > 0 ? args!.edits[0] : undefined;
	const rawPath =
		args?.file_path ||
		args?.path ||
		filePathFromEditEntry((firstEdit as any)?.path) ||
		(details && "path" in details ? details.path : "") ||
		"";
	const op = args?.op || (firstEdit as any)?.op || details?.op;
	const rename = args?.rename || (firstEdit as any)?.rename || details?.move;
	const { language } = formatEditDescription(rawPath, uiTheme, { rename });

	const metadataLine =
		op !== "delete"
			? `\n${formatMetadataLine(countLines(args?.newText ?? args?.oldText ?? args?.diff ?? args?.patch ?? ""), language, uiTheme)}`
			: "";

	const errorText = isError
		? (details && "errorText" in details && details.errorText) ||
			(result.content?.find(c => c.type === "text")?.text ?? "")
		: "";

	let cached: RenderCache | undefined;

	return {
		render(width) {
			const { expanded, renderContext } = options;
			const editDiffPreview = renderContext?.editDiffPreview;
			const renderDiffFn = renderContext?.renderDiff ?? ((t: string) => t);
			const key = new Hasher().bool(expanded).u32(width).digest();
			if (cached?.key === key) return cached.lines;

			const firstChangedLine =
				(editDiffPreview && "firstChangedLine" in editDiffPreview ? editDiffPreview.firstChangedLine : undefined) ||
				(details && !isError ? details.firstChangedLine : undefined);
			const { description } = formatEditDescription(rawPath, uiTheme, { rename, firstChangedLine });

			const header = renderStatusLine(
				{
					icon: isError ? "error" : "success",
					title: getOperationTitle(op),
					description,
				},
				uiTheme,
			);
			let text = header;
			text += metadataLine;

			if (isError) {
				if (errorText) {
					text += `\n\n${uiTheme.fg("error", replaceTabs(errorText))}`;
				}
			} else if (details?.diff) {
				text += renderDiffSection(details.diff, rawPath, expanded, uiTheme, renderDiffFn);
			} else if (editDiffPreview) {
				if ("error" in editDiffPreview) {
					text += `\n\n${uiTheme.fg("error", replaceTabs(editDiffPreview.error))}`;
				} else if (editDiffPreview.diff) {
					text += renderDiffSection(editDiffPreview.diff, rawPath, expanded, uiTheme, renderDiffFn);
				}
			}

			if (details?.diagnostics) {
				text += formatDiagnostics(details.diagnostics, expanded, uiTheme, (fp: string) =>
					uiTheme.getLangIcon(getLanguageFromPath(fp)),
				);
			}

			const lines =
				width > 0 ? text.split("\n").flatMap(line => wrapEditRendererLine(line, width)) : text.split("\n");
			cached = { key, lines };
			return lines;
		},
		invalidate() {
			cached = undefined;
		},
	};
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
			for (const c of fileComponents) c.invalidate();
		},
	};
}
