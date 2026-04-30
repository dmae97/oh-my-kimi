import { clonePosition, type Position, type VimBufferSnapshot, type VimFingerprint, type VimLoadedFile } from "./types";

function splitText(text: string): string[] {
	if (text.length === 0) {
		return [""];
	}
	return text.split("\n");
}

export function snapshotEqual(left: VimBufferSnapshot, right: VimBufferSnapshot): boolean {
	if (
		left.displayPath !== right.displayPath ||
		left.filePath !== right.filePath ||
		left.modified !== right.modified ||
		left.trailingNewline !== right.trailingNewline ||
		left.cursor.line !== right.cursor.line ||
		left.cursor.col !== right.cursor.col ||
		left.editabilityChecked !== right.editabilityChecked
	) {
		return false;
	}

	if (left.baseFingerprint === null || right.baseFingerprint === null) {
		if (left.baseFingerprint !== right.baseFingerprint) {
			return false;
		}
	} else if (
		left.baseFingerprint.exists !== right.baseFingerprint.exists ||
		left.baseFingerprint.size !== right.baseFingerprint.size ||
		left.baseFingerprint.mtimeMs !== right.baseFingerprint.mtimeMs ||
		left.baseFingerprint.hash !== right.baseFingerprint.hash
	) {
		return false;
	}

	if (left.lines.length !== right.lines.length) {
		return false;
	}

	for (let index = 0; index < left.lines.length; index += 1) {
		if (left.lines[index] !== right.lines[index]) {
			return false;
		}
	}

	return true;
}

export class VimBuffer {
	displayPath: string;
	filePath: string;
	lines: string[];
	cursor: Position;
	modified: boolean;
	trailingNewline: boolean;
	baseFingerprint: VimFingerprint | null;
	editabilityChecked: boolean;

	constructor(input: VimLoadedFile) {
		this.displayPath = input.displayPath;
		this.filePath = input.absolutePath;
		this.lines = input.lines.length > 0 ? [...input.lines] : [""];
		this.cursor = { line: 0, col: 0 };
		this.modified = false;
		this.trailingNewline = input.trailingNewline;
		this.baseFingerprint = input.fingerprint ? { ...input.fingerprint } : null;
		this.editabilityChecked = false;
	}

	clone(): VimBuffer {
		const clone = new VimBuffer({
			absolutePath: this.filePath,
			displayPath: this.displayPath,
			lines: [...this.lines],
			trailingNewline: this.trailingNewline,
			fingerprint: this.baseFingerprint ? { ...this.baseFingerprint } : null,
		});
		clone.cursor = clonePosition(this.cursor);
		clone.modified = this.modified;
		clone.editabilityChecked = this.editabilityChecked;
		return clone;
	}

	createSnapshot(): VimBufferSnapshot {
		return {
			displayPath: this.displayPath,
			filePath: this.filePath,
			lines: [...this.lines],
			cursor: clonePosition(this.cursor),
			modified: this.modified,
			trailingNewline: this.trailingNewline,
			baseFingerprint: this.baseFingerprint ? { ...this.baseFingerprint } : null,
			editabilityChecked: this.editabilityChecked,
		};
	}

	restore(snapshot: VimBufferSnapshot): void {
		this.displayPath = snapshot.displayPath;
		this.filePath = snapshot.filePath;
		this.lines = snapshot.lines.length > 0 ? [...snapshot.lines] : [""];
		this.cursor = clonePosition(snapshot.cursor);
		this.modified = snapshot.modified;
		this.trailingNewline = snapshot.trailingNewline;
		this.baseFingerprint = snapshot.baseFingerprint ? { ...snapshot.baseFingerprint } : null;
		this.editabilityChecked = snapshot.editabilityChecked;
		this.clampCursor();
	}

	replaceLoadedFile(input: VimLoadedFile): void {
		this.displayPath = input.displayPath;
		this.filePath = input.absolutePath;
		this.lines = input.lines.length > 0 ? [...input.lines] : [""];
		this.cursor = { line: 0, col: 0 };
		this.modified = false;
		this.trailingNewline = input.trailingNewline;
		this.baseFingerprint = input.fingerprint ? { ...input.fingerprint } : null;
		this.editabilityChecked = false;
	}

	markSaved(input: VimLoadedFile): void {
		this.lines = input.lines.length > 0 ? [...input.lines] : [""];
		this.modified = false;
		this.trailingNewline = input.trailingNewline;
		this.baseFingerprint = input.fingerprint ? { ...input.fingerprint } : null;
		this.clampCursor();
	}

	lineCount(): number {
		return this.lines.length;
	}

	lastLineIndex(): number {
		return Math.max(0, this.lines.length - 1);
	}

	getLine(line: number): string {
		return this.lines[this.clampLine(line)] ?? "";
	}

	clampLine(line: number): number {
		return Math.min(Math.max(line, 0), this.lastLineIndex());
	}

	clampCol(line: number, col: number): number {
		return Math.min(Math.max(col, 0), this.getLine(line).length);
	}

	setCursor(position: Position): void {
		this.cursor = {
			line: this.clampLine(position.line),
			col: this.clampCol(position.line, position.col),
		};
	}

	clampCursor(): void {
		this.setCursor(this.cursor);
	}

	firstNonBlank(line: number): number {
		const content = this.getLine(line);
		const index = content.search(/\S/);
		return index === -1 ? 0 : index;
	}

	getText(): string {
		return this.lines.join("\n");
	}

	setText(text: string, trailingNewline = this.trailingNewline): void {
		const normalizedText = trailingNewline && text.endsWith("\n") ? text.slice(0, -1) : text;
		this.lines = splitText(normalizedText);
		this.trailingNewline = trailingNewline;
		this.clampCursor();
	}

	currentOffset(): number {
		return this.positionToOffset(this.cursor);
	}

	positionToOffset(position: Position): number {
		const line = this.clampLine(position.line);
		const col = this.clampCol(line, position.col);
		let offset = 0;
		for (let index = 0; index < line; index += 1) {
			offset += this.lines[index]!.length + 1;
		}
		return offset + col;
	}

	offsetToPosition(offset: number): Position {
		const text = this.getText();
		const clamped = Math.min(Math.max(offset, 0), text.length);
		let remaining = clamped;
		for (let line = 0; line < this.lines.length; line += 1) {
			const current = this.lines[line]!;
			if (remaining <= current.length) {
				return { line, col: remaining };
			}
			remaining -= current.length;
			if (line < this.lines.length - 1) {
				if (remaining === 0) {
					return { line: line + 1, col: 0 };
				}
				remaining -= 1;
			}
		}
		return { line: this.lastLineIndex(), col: this.getLine(this.lastLineIndex()).length };
	}

	setCursorFromOffset(offset: number): void {
		this.cursor = this.offsetToPosition(offset);
	}

	replaceOffsets(start: number, end: number, replacement: string, cursorOffset = start + replacement.length): void {
		const text = this.getText();
		const normalizedStart = Math.min(Math.max(start, 0), text.length);
		const normalizedEnd = Math.min(Math.max(end, normalizedStart), text.length);
		const nextText = `${text.slice(0, normalizedStart)}${replacement}${text.slice(normalizedEnd)}`;
		// getText() omits the trailing-newline marker, so any \n in the
		// replacement is content (a line separator), not a file-trailing newline.
		// Bypass setText() which would incorrectly strip it.
		this.lines = splitText(nextText);
		this.clampCursor();
		this.setCursorFromOffset(cursorOffset);
	}

	deleteOffsets(start: number, end: number): string {
		const text = this.getText();
		const normalizedStart = Math.min(Math.max(start, 0), text.length);
		const normalizedEnd = Math.min(Math.max(end, normalizedStart), text.length);
		const removed = text.slice(normalizedStart, normalizedEnd);
		this.replaceOffsets(normalizedStart, normalizedEnd, "", normalizedStart);
		return removed;
	}

	deleteLines(startLine: number, endLine: number): string[] {
		const start = this.clampLine(Math.min(startLine, endLine));
		const end = this.clampLine(Math.max(startLine, endLine));
		const removed = this.lines.slice(start, end + 1);
		this.lines.splice(start, end - start + 1);
		if (this.lines.length === 0) {
			this.lines = [""];
		}
		this.setCursor({ line: Math.min(start, this.lastLineIndex()), col: 0 });
		if (this.lines.length > 1 || removed.length > 1) {
			this.trailingNewline = true;
		}
		return removed;
	}

	insertLines(index: number, newLines: string[]): void {
		const at = Math.min(Math.max(index, 0), this.lines.length);
		const normalized = newLines.length > 0 ? newLines : [""];
		this.lines.splice(at, 0, ...normalized);
		this.setCursor({ line: at, col: 0 });
		this.trailingNewline = true;
	}

	replaceLine(line: number, content: string): void {
		const target = this.clampLine(line);
		this.lines[target] = content;
		this.setCursor(this.cursor);
	}

	joinLines(startLine: number, count: number): void {
		const start = this.clampLine(startLine);
		const end = this.clampLine(start + Math.max(count, 1));
		if (start >= end) {
			return;
		}
		const joined = this.lines
			.slice(start, end + 1)
			.map(line => line.trim())
			.join(" ");
		this.lines.splice(start, end - start + 1, joined);
		this.setCursor({ line: start, col: Math.max(0, joined.length - 1) });
	}

	indentLines(startLine: number, endLine: number, indentUnit: string, direction: 1 | -1): void {
		const start = this.clampLine(Math.min(startLine, endLine));
		const end = this.clampLine(Math.max(startLine, endLine));
		for (let line = start; line <= end; line += 1) {
			const content = this.lines[line] ?? "";
			if (direction > 0) {
				this.lines[line] = `${indentUnit}${content}`;
				continue;
			}
			if (content.startsWith(indentUnit)) {
				this.lines[line] = content.slice(indentUnit.length);
				continue;
			}
			const spaces = content.match(/^ +/)?.[0].length ?? 0;
			this.lines[line] = content.slice(Math.min(spaces, indentUnit.length));
		}
		this.setCursor(this.cursor);
	}

	getCharacterAtOffset(offset: number): string {
		const text = this.getText();
		if (offset < 0 || offset >= text.length) {
			return "";
		}
		return text[offset] ?? "";
	}

	getCharacter(position: Position): string {
		return this.getCharacterAtOffset(this.positionToOffset(position));
	}
}
