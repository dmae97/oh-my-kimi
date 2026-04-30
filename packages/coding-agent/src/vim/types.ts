import type { FileDiagnosticsResult } from "../lsp";
import type { OutputMeta } from "../tools/output-meta";

export type VimMode = "NORMAL" | "INSERT" | "VISUAL" | "VISUAL-LINE" | "COMMAND";

export type VimInputMode =
	| "normal"
	| "insert"
	| "visual"
	| "visual-line"
	| "command"
	| "search-forward"
	| "search-backward";

export interface Position {
	line: number;
	col: number;
}

export interface VimViewport {
	start: number;
	end: number;
}

export interface VimSelection {
	kind: "char" | "line";
	start: Position;
	end: Position;
}

export interface VimFocusLine {
	line: number;
	text: string;
	windowStartCol: number;
	windowEndCol: number;
	caretCol: number;
}

export interface VimViewportLine {
	line: number;
	text: string;
	isCursor: boolean;
	isSelected: boolean;
	cursorCol?: number;
}

export interface VimPendingInput {
	kind: "insert" | "command" | "search-forward" | "search-backward";
	text: string;
}

export interface VimErrorLocation {
	sequenceIndex: number;
	offset: number;
}

export interface VimToolDetails {
	file: string;
	mode: VimMode;
	cursor: { line: number; col: number };
	totalLines: number;
	modified: boolean;
	viewport: VimViewport;
	focus?: VimFocusLine;
	viewportLines?: VimViewportLine[];
	selection?: VimSelection;
	pendingInput?: VimPendingInput;
	errorLocation?: VimErrorLocation;
	closed?: boolean;
	meta?: OutputMeta;
	lastCommand?: string;
	statusMessage?: string;
	diagnostics?: FileDiagnosticsResult;
}

export interface VimFingerprint {
	exists: boolean;
	size: number;
	mtimeMs: number;
	hash: string;
}

export interface VimLoadedFile {
	absolutePath: string;
	displayPath: string;
	lines: string[];
	trailingNewline: boolean;
	fingerprint: VimFingerprint | null;
}

export interface VimKeyToken {
	value: string;
	display: string;
	sequenceIndex: number;
	offset: number;
}

export interface VimRegister {
	kind: "char" | "line";
	text: string;
}

export interface VimSearchState {
	pattern: string;
	direction: 1 | -1;
}

export interface VimBufferSnapshot {
	displayPath: string;
	filePath: string;
	lines: string[];
	cursor: Position;
	modified: boolean;
	trailingNewline: boolean;
	baseFingerprint: VimFingerprint | null;
	editabilityChecked: boolean;
}

export interface VimUndoEntry {
	before: VimBufferSnapshot;
	after: VimBufferSnapshot;
}

export interface VimLineRange {
	start: number;
	end: number;
}

export type VimExCommand =
	| { kind: "write"; force: boolean }
	| { kind: "update"; force: boolean }
	| { kind: "quit"; force: boolean }
	| { kind: "write-quit"; force: boolean }
	| { kind: "edit"; force: boolean; path?: string }
	| { kind: "goto-line"; line: number }
	| { kind: "substitute"; range?: VimLineRange | "all"; pattern: string; replacement: string; flags: string }
	| { kind: "delete"; range?: VimLineRange | "all" }
	| { kind: "yank"; range?: VimLineRange | "all" }
	| { kind: "put"; range?: VimLineRange | "all"; before: boolean }
	| { kind: "copy"; range?: VimLineRange | "all"; destination: number }
	| { kind: "move"; range?: VimLineRange | "all"; destination: number }
	| { kind: "sort"; range?: VimLineRange | "all"; flags: string }
	| { kind: "join"; range?: VimLineRange | "all"; trimWhitespace: boolean }
	| { kind: "global"; range?: VimLineRange | "all"; pattern: string; command: string; invert: boolean }
	| { kind: "append"; range?: VimLineRange; text: string }
	| { kind: "insert-before"; range?: VimLineRange; text: string };

export class VimInputError extends Error {
	location?: { sequenceIndex: number; offset: number };

	constructor(message: string, token?: VimKeyToken) {
		super(message);
		this.name = "VimInputError";
		if (token) {
			this.location = {
				sequenceIndex: token.sequenceIndex,
				offset: token.offset,
			};
		}
	}
}

export function clonePosition(position: Position): Position {
	return { line: position.line, col: position.col };
}

export function comparePositions(left: Position, right: Position): number {
	if (left.line !== right.line) {
		return left.line - right.line;
	}
	return left.col - right.col;
}

export function minPosition(left: Position, right: Position): Position {
	return comparePositions(left, right) <= 0 ? clonePosition(left) : clonePosition(right);
}

export function maxPosition(left: Position, right: Position): Position {
	return comparePositions(left, right) >= 0 ? clonePosition(left) : clonePosition(right);
}

export function toPublicMode(mode: VimInputMode): VimMode {
	switch (mode) {
		case "insert":
			return "INSERT";
		case "visual":
			return "VISUAL";
		case "visual-line":
			return "VISUAL-LINE";
		case "command":
		case "search-forward":
		case "search-backward":
			return "COMMAND";
		default:
			return "NORMAL";
	}
}
