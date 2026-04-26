/**
 * Block-balanced delimiter finder used by the `splice_block` verb.
 *
 * Tokenizes source text to skip strings and comments, then walks a stack of
 * open delimiters to identify the enclosing balanced block for a target line.
 *
 * This is intentionally language-agnostic over the C-family (C, C++, Rust,
 * Go, Java, JS/TS, C#, Swift, Kotlin, Scala, …): it understands `// line`,
 * `/* block * /` comments, double-quoted, single-quoted, and backtick strings
 * with backslash escapes. It does NOT attempt to parse raw string literals,
 * Python triple-quoted strings, or YAML/Python indent-significant blocks —
 * those are out of scope for v1.
 */

export type DelimiterKind = "{" | "(" | "[";

export interface BlockRange {
	/** Byte/character offset of the opening delimiter. */
	openOffset: number;
	/** Byte/character offset just after the closing delimiter. */
	closeOffsetExclusive: number;
	/** Offset of first character after the opener (start of body). */
	bodyStart: number;
	/** Offset of the closing delimiter character. */
	bodyEnd: number;
	/** 1-indexed line number of the opener. */
	openLine: number;
	/** Byte/character offset of the opener line start. */
	openLineStart: number;
	/** 1-indexed line number of the closer. */
	closeLine: number;
	/** True when opener and closer are on the same line. */
	sameLine: boolean;
	/** Whitespace prefix of the opener's line. */
	openerLineIndent: string;
	/**
	 * Whitespace prefix of the first non-blank body line, or `null` when the
	 * body has no non-blank line.
	 */
	bodyLineIndent: string | null;
	/** Body text exactly as it appears between the delimiters. */
	bodyText: string;
	/** Total enclosing blocks of the requested kind before depth selection. */
	enclosingCount: number;
}

interface BraceEvent {
	kind: DelimiterKind | ")" | "]" | "}";
	offset: number;
}

const OPENERS: Record<DelimiterKind, string> = { "{": "{", "(": "(", "[": "[" };
const CLOSERS: Record<DelimiterKind, string> = { "{": "}", "(": ")", "[": "]" };

/**
 * Walk `text` and emit positions of opening and closing delimiters that lie
 * outside strings and comments.
 */
export function scanDelimiters(text: string): BraceEvent[] {
	const out: BraceEvent[] = [];
	const len = text.length;
	let i = 0;
	while (i < len) {
		const ch = text[i]!;
		// Line comment `// …` to end of line.
		if (ch === "/" && text[i + 1] === "/") {
			i += 2;
			while (i < len && text[i] !== "\n") i++;
			continue;
		}
		// Hash line comment `# …` for shell/Python-like — but only when at start
		// of a token, to avoid mangling C preprocessor lines (`#include`). We
		// treat any `#` at column 0 or after whitespace as a line comment, which
		// is a heuristic that's also fine for `#include` (no braces follow on
		// the same line in practice for our use case).
		if (ch === "#" && (i === 0 || text[i - 1] === "\n" || text[i - 1] === " " || text[i - 1] === "\t")) {
			// Not enabled: too aggressive for C/C++/Rust files. Skip.
		}
		// Block comment `/* … */`.
		if (ch === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < len && !(text[i] === "*" && text[i + 1] === "/")) i++;
			if (i < len) i += 2;
			continue;
		}
		// String literals: ", ', `. Backslash-escape aware.
		if (ch === '"' || ch === "'" || ch === "`") {
			const quote = ch;
			i++;
			while (i < len) {
				const c = text[i]!;
				if (c === "\\") {
					i += 2;
					continue;
				}
				if (c === quote) {
					i++;
					break;
				}
				if (c === "\n" && (quote === '"' || quote === "'")) {
					// Unterminated string; stop scanning this literal so we
					// don't swallow the rest of the file.
					break;
				}
				i++;
			}
			continue;
		}
		if (ch === "{" || ch === "(" || ch === "[") {
			out.push({ kind: ch, offset: i });
		} else if (ch === "}" || ch === ")" || ch === "]") {
			out.push({ kind: ch, offset: i });
		}
		i++;
	}
	return out;
}

interface OpenFrame {
	kind: DelimiterKind;
	offset: number;
}

/**
 * Build a list of balanced (open, close) ranges by walking the events from
 * `scanDelimiters`. Mismatched closers are skipped (the file may be partially
 * malformed), and unclosed openers at EOF are dropped.
 */
function pairBlocks(events: BraceEvent[]): { open: OpenFrame; closeOffset: number }[] {
	const stack: OpenFrame[] = [];
	const pairs: { open: OpenFrame; closeOffset: number }[] = [];
	for (const ev of events) {
		if (ev.kind === "{" || ev.kind === "(" || ev.kind === "[") {
			stack.push({ kind: ev.kind, offset: ev.offset });
			continue;
		}
		// Closer.
		const expected: DelimiterKind | null =
			ev.kind === "}" ? "{" : ev.kind === ")" ? "(" : ev.kind === "]" ? "[" : null;
		if (!expected) continue;
		// Pop until we find the matching opener, but only commit pairs when
		// kinds match. This tolerates small skews from raw strings or other
		// unsupported constructs without exploding the search.
		const top = stack[stack.length - 1];
		if (top?.kind === expected) {
			stack.pop();
			pairs.push({ open: top, closeOffset: ev.offset });
		}
	}
	return pairs;
}

function lineToOffset(text: string, line: number): number {
	let n = 1;
	let i = 0;
	while (i < text.length && n < line) {
		if (text[i] === "\n") n++;
		i++;
	}
	return i;
}

function offsetToLine(text: string, offset: number): number {
	let n = 1;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === "\n") n++;
	}
	return n;
}

function lineIndentAt(text: string, lineNumber: number): string {
	const start = lineToOffset(text, lineNumber);
	let i = start;
	while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
	return text.slice(start, i);
}

function extractRange(text: string, start: number, end: number): string {
	return text.slice(start, end);
}

export interface FindBlockOptions {
	kind?: DelimiterKind;
	depth?: number;
}

export interface FindBlockError {
	message: string;
}

/**
 * Find the enclosing balanced block of `kind` containing `targetLine`
 * (1-indexed), at the requested ancestor `depth` (0 = innermost).
 *
 * Returns an error object when no such block exists.
 */
export function findEnclosingBlock(
	text: string,
	targetLine: number,
	options: FindBlockOptions = {},
): BlockRange | FindBlockError {
	const kind: DelimiterKind = options.kind ?? "{";
	const depth = Math.max(0, Math.floor(options.depth ?? 0));

	const events = scanDelimiters(text);
	const pairs = pairBlocks(events);

	// Lines (1-indexed) that bracket the target are considered to contain it.
	// This handles same-line `{ x }` blocks too (openLine == closeLine ==
	// targetLine).
	const enclosing = pairs
		.filter(p => p.open.kind === kind)
		.map(p => ({
			open: p.open,
			closeOffset: p.closeOffset,
			openLine: offsetToLine(text, p.open.offset),
			closeLine: offsetToLine(text, p.closeOffset),
		}))
		.filter(p => p.openLine <= targetLine && targetLine <= p.closeLine);
	if (enclosing.length === 0) {
		return {
			message: `No enclosing \`${kind}\` block contains line ${targetLine}.`,
		};
	}
	// Default ordering is innermost first (largest open offset among containers).
	// When both candidates are entirely on the target line, prefer the outermost
	// same-line block so anchoring a call line targets the containing call before
	// nested argument calls such as `int(port)`. Multi-line nesting keeps the
	// existing innermost-first behavior.
	enclosing.sort((a, b) => {
		const aSingle = a.openLine === targetLine && a.closeLine === targetLine;
		const bSingle = b.openLine === targetLine && b.closeLine === targetLine;
		if (aSingle && bSingle) return a.open.offset - b.open.offset;
		return b.open.offset - a.open.offset;
	});
	if (depth >= enclosing.length) {
		return {
			message: `Requested depth ${depth} exceeds available enclosing \`${kind}\` blocks (${enclosing.length}).`,
		};
	}
	const chosen = enclosing[depth]!;
	const openOffset = chosen.open.offset;
	const closeOffset = chosen.closeOffset;
	const bodyStart = openOffset + 1;
	const bodyEnd = closeOffset;
	const openLine = chosen.openLine;
	const closeLine = chosen.closeLine;
	const openLineStart = lineToOffset(text, openLine);
	const openerLineIndent = lineIndentAt(text, openLine);
	const bodyText = extractRange(text, bodyStart, bodyEnd);
	const bodyLineIndent = computeBodyLineIndent(text, bodyStart, bodyEnd);
	return {
		openOffset,
		closeOffsetExclusive: closeOffset + 1,
		bodyStart,
		bodyEnd,
		openLine,
		openLineStart,
		closeLine,
		sameLine: openLine === closeLine,
		openerLineIndent,
		bodyLineIndent,
		bodyText,
		enclosingCount: enclosing.length,
	};
}

function computeBodyLineIndent(text: string, bodyStart: number, bodyEnd: number): string | null {
	// Scan body for the first line whose non-whitespace character lives within
	// [bodyStart, bodyEnd). Return that line's leading whitespace prefix.
	let i = bodyStart;
	// Step over the rest of the opener's line (it may contain trailing
	// whitespace but not body content we want to use as the indent reference).
	while (i < bodyEnd && text[i] !== "\n") i++;
	while (i < bodyEnd) {
		// At line boundary; skip the newline.
		if (text[i] === "\n") i++;
		const lineStart = i;
		while (i < bodyEnd && (text[i] === " " || text[i] === "\t")) i++;
		// Skip blank lines.
		if (i < bodyEnd && text[i] !== "\n") {
			return text.slice(lineStart, i);
		}
		// Skip to end of line.
		while (i < bodyEnd && text[i] !== "\n") i++;
	}
	return null;
}

/**
 * Verify that the agent's body has balanced delimiters of `kind`. Returns an
 * error message when unbalanced, or `null` when fine.
 */
export function checkBodyBraceBalance(body: string, kind: DelimiterKind): string | null {
	const events = scanDelimiters(body);
	let opens = 0;
	let closes = 0;
	const opener = OPENERS[kind];
	const closer = CLOSERS[kind];
	for (const e of events) {
		if (e.kind === opener) opens++;
		else if (e.kind === closer) closes++;
	}
	if (opens !== closes) {
		return `Replacement body has unbalanced \`${opener}\`/\`${closer}\` (open=${opens}, close=${closes}).`;
	}
	return null;
}
