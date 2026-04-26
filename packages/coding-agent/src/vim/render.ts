import { extractSegments } from "@oh-my-pi/pi-tui";
import { formatCodeFrameLine, truncateToWidth } from "../tools/render-utils";
import type {
	VimErrorLocation,
	VimFocusLine,
	VimMode,
	VimPendingInput,
	VimSelection,
	VimToolDetails,
	VimViewport,
	VimViewportLine,
} from "./types";

export const VIM_OPEN_VIEWPORT_LINES = 80;
export const VIM_DEFAULT_VIEWPORT_LINES = 10;
export const VIM_TAB_DISPLAY = "→";
const VIM_INLINE_CURSOR = "▏";

const VIM_VIEWPORT_WIDTH = 140;
const VIM_FOCUS_WIDTH = 100;

interface ViewportRenderInput {
	file: string;
	mode: VimMode;
	cursor: { line: number; col: number };
	totalLines: number;
	modified: boolean;
	lines: string[];
	viewport: VimViewport;
	selection?: VimSelection;
	statusMessage?: string;
	lastCommand?: string;
	pendingInput?: VimPendingInput;
	errorLocation?: VimErrorLocation;
	closed?: boolean;
}

function renderHeader(details: Pick<VimToolDetails, "file" | "modified" | "mode" | "cursor" | "totalLines">): string {
	const modified = details.modified ? "[+]" : "[ ]";
	return `${details.file} ${modified} ${details.mode} L${details.cursor.line}:${details.cursor.col} (${details.totalLines} lines)`;
}

function selectionContainsLine(selection: VimSelection | undefined, lineNumber: number): boolean {
	if (!selection) {
		return false;
	}
	return lineNumber >= selection.start.line && lineNumber <= selection.end.line;
}

function visibleWidthForChar(char: string): number {
	return char === "\t" ? VIM_TAB_DISPLAY.length : Math.max(1, Bun.stringWidth(char));
}

function renderVisibleText(input: string): string {
	let output = "";
	for (const char of input) {
		output += char === "\t" ? VIM_TAB_DISPLAY : char;
	}
	return output;
}

function renderedColumnForRawColumn(input: string, rawCol: number): number {
	let column = 0;
	let index = 0;
	for (const char of input) {
		if (index >= rawCol) {
			break;
		}
		column += visibleWidthForChar(char);
		index += 1;
	}
	return column;
}

function cropVisibleText(text: string, startCol: number, width: number): { text: string; startCol: number } {
	if (text.length <= width) {
		return { text, startCol: 0 };
	}

	const maxStart = Math.max(0, text.length - width);
	const clampedStart = Math.max(0, Math.min(startCol, maxStart));
	let window = text.slice(clampedStart, clampedStart + width);
	if (clampedStart > 0 && window.length > 0) {
		window = `…${window.slice(1)}`;
	}
	if (clampedStart + width < text.length && window.length > 0) {
		window = `${window.slice(0, -1)}…`;
	}
	return { text: window, startCol: clampedStart };
}

function buildFocusLine(lineNumber: number, rawText: string, rawCursorCol: number): VimFocusLine {
	const visibleText = renderVisibleText(rawText);
	const caretCol = renderedColumnForRawColumn(rawText, rawCursorCol);
	const desiredStart = Math.max(0, caretCol - Math.floor(VIM_FOCUS_WIDTH / 2));
	const cropped = cropVisibleText(visibleText, desiredStart, VIM_FOCUS_WIDTH);
	return {
		line: lineNumber,
		text: cropped.text,
		windowStartCol: cropped.startCol + 1,
		windowEndCol: cropped.startCol + cropped.text.length,
		caretCol: Math.max(0, caretCol - cropped.startCol),
	};
}

function buildViewportLines(
	input: Pick<ViewportRenderInput, "lines" | "viewport" | "cursor" | "selection">,
): VimViewportLine[] {
	const lines: VimViewportLine[] = [];
	for (let lineNumber = input.viewport.start; lineNumber <= input.viewport.end; lineNumber += 1) {
		const rawText = input.lines[lineNumber - 1] ?? "";
		const visibleText = renderVisibleText(rawText);
		const isCursor = lineNumber === input.cursor.line;
		if (isCursor) {
			const cursorCol = renderedColumnForRawColumn(rawText, input.cursor.col - 1);
			const desiredStart = Math.max(0, cursorCol - Math.floor(VIM_VIEWPORT_WIDTH / 2));
			const cropped = cropVisibleText(visibleText, desiredStart, VIM_VIEWPORT_WIDTH);
			lines.push({
				line: lineNumber,
				text: cropped.text,
				isCursor: true,
				isSelected: selectionContainsLine(input.selection, lineNumber),
				cursorCol: Math.max(0, cursorCol - cropped.startCol),
			});
			continue;
		}
		lines.push({
			line: lineNumber,
			text: truncateToWidth(visibleText, VIM_VIEWPORT_WIDTH),
			isCursor: false,
			isSelected: selectionContainsLine(input.selection, lineNumber),
		});
	}
	return lines;
}

export function computeViewport(
	cursorLine: number,
	totalLines: number,
	size: number,
	preferredStart?: number,
): VimViewport {
	const lineCount = Math.max(totalLines, 1);
	const clampedSize = Math.max(1, Math.min(size, lineCount));
	const maxStart = Math.max(1, lineCount - clampedSize + 1);
	const centered = Math.max(1, Math.min(cursorLine - Math.floor(clampedSize / 2), maxStart));
	let start = preferredStart ? Math.max(1, Math.min(preferredStart, maxStart)) : centered;
	const end = Math.min(lineCount, start + clampedSize - 1);
	if (cursorLine < start) {
		start = cursorLine;
	}
	if (cursorLine > end) {
		start = Math.max(1, cursorLine - clampedSize + 1);
	}
	return {
		start,
		end: Math.min(lineCount, start + clampedSize - 1),
	};
}

function formatPendingInput(pending: VimPendingInput | undefined): string | undefined {
	if (!pending) {
		return undefined;
	}
	if (pending.kind === "insert") {
		return "Pending: INSERT mode";
	}
	const prefix = pending.kind === "command" ? ":" : pending.kind === "search-forward" ? "/" : "?";
	return `Pending: ${prefix}${truncateToWidth(renderVisibleText(pending.text), 80)}`;
}

function renderPlainViewportCursor(line: VimViewportLine): string {
	if (!line.isCursor || line.cursorCol === undefined) {
		return line.text;
	}
	const totalWidth = Bun.stringWidth(line.text);
	const cursorCol = Math.max(0, Math.min(line.cursorCol, totalWidth));
	const segments = extractSegments(line.text, cursorCol, cursorCol, Math.max(0, totalWidth - cursorCol), true);
	return `${segments.before}${VIM_INLINE_CURSOR}${segments.after}`;
}

export function renderVimDetails(details: VimToolDetails): string {
	const lines: string[] = [renderHeader(details)];

	// Explicit cursor position indicator (models miss it in header)
	lines.push(`[CURSOR] Line ${details.cursor.line}, Column ${details.cursor.col} (of ${details.totalLines} lines)`);

	if (details.lastCommand) {
		lines.push(`Command: ${truncateToWidth(details.lastCommand, 80)}`);
	}
	if (details.statusMessage) {
		lines.push(`Status: ${details.statusMessage}`);
	}
	if (details.errorLocation) {
		lines.push(
			`Error location: sequence ${details.errorLocation.sequenceIndex + 1}, token ${details.errorLocation.offset + 1}`,
		);
	}

	const pending = formatPendingInput(details.pendingInput);
	if (pending) {
		lines.push(pending);
	}

	if (details.closed) {
		return lines.join("\n");
	}

	if (details.focus) {
		const focusPrefix = formatCodeFrameLine(">", details.focus.line, "", String(details.viewport.end).length);
		const caretPrefix = `${" ".repeat(focusPrefix.length)} `;
		const caretPadding = " ".repeat(Math.max(0, details.focus.caretCol));
		lines.push("Focus:");
		lines.push(`${focusPrefix}${details.focus.text}`);
		lines.push(`${caretPrefix}${caretPadding}^`);
	}

	if (details.viewportLines && details.viewportLines.length > 0) {
		const padWidth = String(details.viewport.end).length;
		lines.push("Viewport:");
		for (const line of details.viewportLines) {
			const marker = line.isCursor ? ">" : line.isSelected ? "*" : " ";
			lines.push(formatCodeFrameLine(marker, line.line, renderPlainViewportCursor(line), padWidth));
		}
	}

	return lines.join("\n");
}

export function buildDetails(input: ViewportRenderInput): VimToolDetails {
	const details: VimToolDetails = {
		file: input.file,
		mode: input.mode,
		cursor: input.cursor,
		totalLines: input.totalLines,
		modified: input.modified,
		viewport: input.viewport,
		selection: input.selection,
		lastCommand: input.lastCommand,
		statusMessage: input.statusMessage,
		pendingInput: input.pendingInput,
		errorLocation: input.errorLocation,
		closed: input.closed,
	};

	if (!input.closed) {
		details.focus = buildFocusLine(input.cursor.line, input.lines[input.cursor.line - 1] ?? "", input.cursor.col - 1);
		details.viewportLines = buildViewportLines(input);
	}

	return details;
}
