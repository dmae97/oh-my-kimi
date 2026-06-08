const OPEN_TO_CLOSE: Record<string, string> = {
	"(": ")",
	"[": "]",
	"{": "}",
};

const CLOSE_TO_OPEN: Record<string, string> = {
	")": "(",
	"]": "[",
	"}": "{",
};

export interface LineSpan {
	startLine: number;
	endLine: number;
}

export type LineEntry = { kind: "line"; lineNumber: number; text: string; context: boolean } | { kind: "ellipsis" };

interface StackEntry {
	opener: string;
	lineNumber: number;
	text: string;
	visible: boolean;
}

type ScannerMode = "code" | "single" | "double" | "template" | "blockComment";

function normalizeLineSpans(spans: readonly LineSpan[], totalLines: number): LineSpan[] {
	if (totalLines <= 0) return [];
	const normalized: LineSpan[] = [];
	for (const span of spans) {
		const startLine = Math.max(1, Math.trunc(span.startLine));
		const endLine = Math.min(totalLines, Math.trunc(span.endLine));
		if (endLine < startLine) continue;
		normalized.push({ startLine, endLine });
	}
	if (normalized.length <= 1) return normalized;
	normalized.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
	const merged: LineSpan[] = [];
	for (const span of normalized) {
		const previous = merged[merged.length - 1];
		if (previous && span.startLine <= previous.endLine + 1) {
			previous.endLine = Math.max(previous.endLine, span.endLine);
			continue;
		}
		merged.push({ ...span });
	}
	return merged;
}

function visibleLineNumbers(spans: readonly LineSpan[]): Set<number> {
	const visible = new Set<number>();
	for (const span of spans) {
		for (let line = span.startLine; line <= span.endLine; line++) {
			visible.add(line);
		}
	}
	return visible;
}

function hasEveryLineVisible(visible: ReadonlySet<number>, totalLines: number): boolean {
	return totalLines > 0 && visible.size >= totalLines;
}

function findMatchingStackIndex(stack: readonly StackEntry[], opener: string): number {
	for (let index = stack.length - 1; index >= 0; index--) {
		if (stack[index].opener === opener) return index;
	}
	return -1;
}

function isHashCommentStart(line: string, index: number): boolean {
	if (line[index] !== "#") return false;
	for (let i = 0; i < index; i++) {
		const ch = line[i];
		if (ch !== " " && ch !== "\t") return false;
	}
	return true;
}

export function findMatchingBracketContextLines(
	fullLines: readonly string[],
	visibleLinesInput: ReadonlySet<number> | readonly number[],
): Map<number, string> {
	const visible = visibleLinesInput instanceof Set ? visibleLinesInput : new Set(visibleLinesInput);
	const context = new Map<number, string>();
	if (visible.size === 0 || hasEveryLineVisible(visible, fullLines.length)) return context;

	const stack: StackEntry[] = [];
	let mode: ScannerMode = "code";
	let escaped = false;

	for (let lineIndex = 0; lineIndex < fullLines.length; lineIndex++) {
		const lineNumber = lineIndex + 1;
		const line = fullLines[lineIndex] ?? "";
		const lineVisible = visible.has(lineNumber);
		let index = 0;
		while (index < line.length) {
			const ch = line[index];
			const next = index + 1 < line.length ? line[index + 1] : "";

			if (mode === "blockComment") {
				if (ch === "*" && next === "/") {
					mode = "code";
					index += 2;
					continue;
				}
				index++;
				continue;
			}

			if (mode === "single" || mode === "double" || mode === "template") {
				if (escaped) {
					escaped = false;
					index++;
					continue;
				}
				if (ch === "\\") {
					escaped = true;
					index++;
					continue;
				}
				if (
					(mode === "single" && ch === "'") ||
					(mode === "double" && ch === '"') ||
					(mode === "template" && ch === "`")
				) {
					mode = "code";
				}
				index++;
				continue;
			}

			if (ch === "/" && next === "/") break;
			if (ch === "/" && next === "*") {
				mode = "blockComment";
				index += 2;
				continue;
			}
			if (isHashCommentStart(line, index)) break;
			if (ch === "'") {
				mode = "single";
				escaped = false;
				index++;
				continue;
			}
			if (ch === '"') {
				mode = "double";
				escaped = false;
				index++;
				continue;
			}
			if (ch === "`") {
				mode = "template";
				escaped = false;
				index++;
				continue;
			}

			if (OPEN_TO_CLOSE[ch]) {
				stack.push({ opener: ch, lineNumber, text: line, visible: lineVisible });
				index++;
				continue;
			}

			const opener = CLOSE_TO_OPEN[ch];
			if (opener) {
				const matchIndex = findMatchingStackIndex(stack, opener);
				if (matchIndex !== -1) {
					const [matched] = stack.splice(matchIndex);
					if (matched) {
						if (lineVisible && !matched.visible) context.set(matched.lineNumber, matched.text);
						if (matched.visible && !lineVisible) context.set(lineNumber, line);
					}
				}
			}

			index++;
		}

		if (mode === "single" || mode === "double") {
			mode = "code";
			escaped = false;
		}
	}

	for (const lineNumber of visible) context.delete(lineNumber);
	return context;
}

export function buildLineEntriesWithMatchingBracketContext(
	fullLines: readonly string[],
	visibleSpans: readonly LineSpan[],
	options: {
		lineText?: (lineNumber: number, sourceText: string, context: boolean) => string;
	} = {},
): LineEntry[] {
	const spans = normalizeLineSpans(visibleSpans, fullLines.length);
	const visible = visibleLineNumbers(spans);
	const context = findMatchingBracketContextLines(fullLines, visible);
	const allLines = new Set<number>(visible);
	for (const lineNumber of context.keys()) allLines.add(lineNumber);

	const sorted = [...allLines].sort((left, right) => left - right);
	const entries: LineEntry[] = [];
	let previousLine: number | undefined;
	for (const lineNumber of sorted) {
		if (previousLine !== undefined && lineNumber > previousLine + 1) {
			entries.push({ kind: "ellipsis" });
		}
		const sourceText = fullLines[lineNumber - 1] ?? "";
		const isContext = context.has(lineNumber);
		entries.push({
			kind: "line",
			lineNumber,
			text: options.lineText?.(lineNumber, sourceText, isContext) ?? sourceText,
			context: isContext,
		});
		previousLine = lineNumber;
	}

	return entries;
}

export function lineEntriesToPlainText(entries: readonly LineEntry[], ellipsis = "…"): string {
	return entries.map(entry => (entry.kind === "ellipsis" ? ellipsis : entry.text)).join("\n");
}
