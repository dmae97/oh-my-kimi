import {
	Ellipsis,
	type ExtractSegmentsResult,
	extractSegments as nativeExtractSegments,
	sliceWithWidth as nativeSliceWithWidth,
	truncateToWidth as nativeTruncateToWidth,
	wrapTextWithAnsi as nativeWrapTextWithAnsi,
	type SliceResult,
} from "@oh-my-pi/pi-natives";
import { getDefaultTabWidth, getIndentation } from "@oh-my-pi/pi-utils";

export { Ellipsis } from "@oh-my-pi/pi-natives";

export { getDefaultTabWidth, getIndentation } from "@oh-my-pi/pi-utils";

export type TextSizingScale = 1 | 2 | 3;
export type TextSizingVerticalAlign = "top" | "bottom" | "center";
export type TextSizingHorizontalAlign = "left" | "right" | "center";

export interface TextSizingOptions {
	scale?: TextSizingScale;
	widthCells?: number;
	verticalAlign?: TextSizingVerticalAlign;
	horizontalAlign?: TextSizingHorizontalAlign;
}

const OSC66_UNSAFE = /[\x00-\x1f\x7f-\x9f]/u;
const OSC66_UNSAFE_GLOBAL = /[\x00-\x1f\x7f-\x9f]/gu;

function textSizingVerticalAlignValue(align: TextSizingVerticalAlign | undefined): number | undefined {
	switch (align) {
		case "top":
			return 0;
		case "bottom":
			return 1;
		case "center":
			return 2;
		default:
			return undefined;
	}
}

function textSizingHorizontalAlignValue(align: TextSizingHorizontalAlign | undefined): number | undefined {
	switch (align) {
		case "left":
			return 0;
		case "right":
			return 1;
		case "center":
			return 2;
		default:
			return undefined;
	}
}

/**
 * Encode a plain-text span using Kitty's OSC 66 text-sizing protocol. The TUI
 * emits only safe UTF-8 payloads and ST terminators so its ANSI parser and the
 * terminal agree on span boundaries.
 */
export function encodeTextSized(text: string, options: TextSizingOptions = {}): string {
	const metadata: string[] = [];
	if (options.scale !== undefined) metadata.push(`s=${options.scale}`);
	if (options.widthCells !== undefined && Number.isFinite(options.widthCells)) {
		metadata.push(`w=${Math.max(0, Math.trunc(options.widthCells))}`);
	}
	const verticalAlign = textSizingVerticalAlignValue(options.verticalAlign);
	if (verticalAlign !== undefined) metadata.push(`v=${verticalAlign}`);
	const horizontalAlign = textSizingHorizontalAlignValue(options.horizontalAlign);
	if (horizontalAlign !== undefined) metadata.push(`h=${horizontalAlign}`);

	const safeText = OSC66_UNSAFE.test(text) ? text.replace(OSC66_UNSAFE_GLOBAL, " ") : text;
	return `\x1b]66;${metadata.join(":")};${safeText}\x1b\\`;
}

export function sliceWithWidth(line: string, startCol: number, length: number, strict?: boolean | null): SliceResult {
	return nativeSliceWithWidth(line, startCol, length, strict ?? null, getDefaultTabWidth());
}

export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsisKind?: Ellipsis | null,
	pad?: boolean | null,
): string {
	// Guard nullish napi inputs: napi-rs 3 on the Windows prebuilt rejects
	// `null` for `Option<u8>` (Ellipsis) / `Option<bool>` (pad) (issue #848),
	// and `maxWidth` is a required `u32` that throws on `null`/`undefined`
	// everywhere. Pass concrete defaults that mirror the Rust `unwrap_or`s.
	const safeWidth = Number.isFinite(maxWidth) ? Math.max(0, Math.trunc(maxWidth)) : 0;
	let resolvedEllipsis: Ellipsis | null | undefined | string = ellipsisKind;
	if (typeof resolvedEllipsis === "string") {
		resolvedEllipsis = resolvedEllipsis === "" ? Ellipsis.Omit : Ellipsis.Unicode;
	}
	return nativeTruncateToWidth(
		text,
		safeWidth,
		resolvedEllipsis ?? Ellipsis.Unicode,
		pad ?? false,
		getDefaultTabWidth(),
	);
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
	return nativeWrapTextWithAnsi(text, width, getDefaultTabWidth());
}

export function extractSegments(
	line: string,
	beforeEnd: number,
	afterStart: number,
	afterLen: number,
	strictAfter: boolean,
): ExtractSegmentsResult {
	return nativeExtractSegments(line, beforeEnd, afterStart, afterLen, strictAfter, getDefaultTabWidth());
}

// Pre-allocated space buffer for padding
const SPACE_BUFFER = " ".repeat(512);

/**
 * Tab width in columns for `file`, using `process.cwd()` as the project root for relative paths.
 */
export function getIndentationNoescape(file?: string): number {
	return getIndentation(file, process.cwd());
}

/*
 * Replace tabs with configured spacing for consistent rendering.
 */
export function replaceTabs(text: string, file?: string): string {
	return text.replaceAll("\t", " ".repeat(getIndentation(file)));
}

/**
 * Returns a string of n spaces. Uses a pre-allocated buffer for efficiency.
 */
export function padding(n: number): string {
	if (n <= 0) return "";
	if (n <= 512) return SPACE_BUFFER.slice(0, n);
	return " ".repeat(n);
}

// Grapheme segmenter (shared instance)
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Get the shared grapheme segmenter instance.
 */
export function getSegmenter(): Intl.Segmenter {
	return segmenter;
}

// Kitty OSC 66 text-sizing spans: `\x1b]66;<meta>;<payload>` terminated by BEL
// or ST. `Bun.stringWidth` strips the whole span (payload included) to zero
// cells, but the payload is visible and scales by the `s=` factor, so each is
// added back so width matches the native truncate/slice/wrap helpers.
const OSC66_SPAN_REGEX = /\x1b\]66;([^;]*);([\s\S]*?)(?:\x07|\x1b\\)/g;
const OSC66_PREFIX = "\x1b]66;";
const ESC = "\x1b";
const TAB = "\t";
const LONG_WIDTH_FAST_PATH_MIN = 128;

// Pin Bun.stringWidth semantics to the native width engine and guard against Bun
// default drift: strip ANSI/OSC (don't count escape bytes) and treat
// ambiguous-width East Asian chars as narrow (1 cell), matching `unicode-width`'s
// non-CJK tables that back truncate/slice/wrap. Hoisted so no per-call alloc.
const STRING_WIDTH_OPTS = { countAnsiEscapeCodes: false, ambiguousIsNarrow: true } as const;

/**
 * Visible width of a string in terminal columns, excluding ANSI/OSC escapes.
 *
 * `Bun.stringWidth` does the heavy lifting (UAX#11 width tables + ANSI/OSC
 * stripping); this adds the two corrections it omits — tabs (expanded to
 * `tabWidth` cells) and OSC 66 text-sizing payloads (scaled by `s=`).
 */
export function visibleWidth(str: string): number {
	if (!str) return 0;

	// Long non-escape text is faster through Bun's native scanner than through
	// a JS printable-ASCII prepass. Escape-bearing strings stay on the scanner
	// below so CSI/OSC-heavy render output can still bail out at the first ESC.
	if (str.length >= LONG_WIDTH_FAST_PATH_MIN && !str.includes(ESC)) {
		let width = Bun.stringWidth(str, STRING_WIDTH_OPTS);
		let tabCount = 0;
		for (let tabIndex = str.indexOf(TAB); tabIndex !== -1; tabIndex = str.indexOf(TAB, tabIndex + 1)) {
			tabCount++;
		}
		if (tabCount > 0) width += tabCount * getDefaultTabWidth();
		return width;
	}

	let tabCount = 0;
	let i = 0;
	for (; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) {
			if (code === 0x09) {
				tabCount++;
				continue;
			}
			break;
		}
	}
	if (i === str.length) {
		return tabCount === 0 ? str.length : str.length + tabCount * (getDefaultTabWidth() - 1);
	}

	if (tabCount === 0) {
		let tabIndex = str.indexOf(TAB, i + 1);
		if (tabIndex !== -1) {
			tabCount = 1;
			for (tabIndex = str.indexOf(TAB, tabIndex + 1); tabIndex !== -1; tabIndex = str.indexOf(TAB, tabIndex + 1)) {
				tabCount++;
			}
		}
	} else {
		for (let tabIndex = str.indexOf(TAB, i + 1); tabIndex !== -1; tabIndex = str.indexOf(TAB, tabIndex + 1)) {
			tabCount++;
		}
	}

	// `Bun.stringWidth` is a JSC builtin (no per-call N-API number box, unlike
	// the native scanner that traps under Bun 1.3.x GC/N-API load). It strips
	// CSI/OSC to zero cells and shares the native engine's UAX#11 width tables.
	let width = Bun.stringWidth(str, STRING_WIDTH_OPTS);
	if (tabCount > 0) width += tabCount * getDefaultTabWidth();

	// OSC 66: add back each stripped span as `scale * (explicit w ?? payload
	// width)`. Matched rather than replaced to avoid reallocating the string.
	if (str.includes(OSC66_PREFIX, i)) {
		OSC66_SPAN_REGEX.lastIndex = 0;
		for (let m = OSC66_SPAN_REGEX.exec(str); m !== null; m = OSC66_SPAN_REGEX.exec(str)) {
			let scale = 1;
			let explicit: number | undefined;
			for (const part of m[1].split(":")) {
				// metadata keys are single chars, e.g. `s=2`, `w=5`
				if (part.indexOf("=") !== 1) continue;
				const value = Number.parseInt(part.slice(2), 10);
				if (!Number.isFinite(value)) continue;
				if (part[0] === "s") {
					if (value >= 1 && value <= 7) scale = value;
				} else if (part[0] === "w" && value > 0) {
					explicit = value;
				}
			}
			width += scale * (explicit ?? Bun.stringWidth(m[2], STRING_WIDTH_OPTS));
		}
	}

	return width;
}

const THAI_LAO_AM_GLOBAL_REGEX = /[\u0e33\u0eb3]/g;

/**
 * Normalize text for terminal output without changing logical editor content.
 * Some terminals render precomposed Thai/Lao AM vowels inconsistently during
 * differential repaint. Their compatibility decompositions have the same cell
 * width but avoid stale-cell artifacts in terminal renderers.
 */
export function normalizeTerminalOutput(str: string): string {
	if (str.indexOf("\u0e33") === -1 && str.indexOf("\u0eb3") === -1) return str;
	return str.replace(THAI_LAO_AM_GLOBAL_REGEX, char => (char === "\u0e33" ? "\u0e4d\u0e32" : "\u0ecd\u0eb2"));
}

const makeBoolArray = (chars: string): Uint8Array => {
	const table = new Uint8Array(128);
	for (let i = 0; i < chars.length; i++) {
		const code = chars.charCodeAt(i);
		if (code < table.length) {
			table[code] = 1;
		}
	}
	return table;
};

const ASCII_WHITESPACE = makeBoolArray("\x09\x0a\x0b\x0c\x0d\x20");

/**
 * Check if a character is whitespace.
 */
export function isWhitespaceChar(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code < 128 && ASCII_WHITESPACE[code] === 1;
}

const ASCII_PUNCTUATION = makeBoolArray("(){}[]<>.,;:'\"!?+-=*/\\|&%^$#@~`");

/**
 * Check if a character is punctuation.
 */
export function isPunctuationChar(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code < 128 && ASCII_PUNCTUATION[code] === 1;
}

export type WordNavKind = "whitespace" | "delimiter" | "cjk" | "word" | "other";

const WORD_NAV_RE_WHITESPACE = /^\p{White_Space}$/u;
const WORD_NAV_RE_PUNCT = /^\p{P}$/u;
const WORD_NAV_RE_SYMBOL = /^\p{S}$/u;
const WORD_NAV_RE_LETTER = /^\p{L}$/u;
const WORD_NAV_RE_NUMBER = /^\p{N}$/u;
const WORD_NAV_RE_HAN = /^\p{Script=Han}$/u;
const WORD_NAV_RE_HIRAGANA = /^\p{Script=Hiragana}$/u;
const WORD_NAV_RE_KATAKANA = /^\p{Script=Katakana}$/u;
const WORD_NAV_RE_HANGUL = /^\p{Script=Hangul}$/u;

function firstCodePointChar(str: string): string {
	const cp = str.codePointAt(0);
	if (cp === undefined) return "";
	return String.fromCodePoint(cp);
}

/**
 * Coarse Unicode-aware character classification for word navigation (Option/Alt + Left/Right).
 * This intentionally avoids language-specific word segmentation for predictability across scripts.
 */
export function getWordNavKind(grapheme: string): WordNavKind {
	if (!grapheme) return "other";
	const ch = firstCodePointChar(grapheme);
	if (!ch) return "other";
	if (WORD_NAV_RE_WHITESPACE.test(ch)) return "whitespace";
	if (WORD_NAV_RE_PUNCT.test(ch) || WORD_NAV_RE_SYMBOL.test(ch)) return "delimiter";
	if (
		WORD_NAV_RE_HAN.test(ch) ||
		WORD_NAV_RE_HIRAGANA.test(ch) ||
		WORD_NAV_RE_KATAKANA.test(ch) ||
		WORD_NAV_RE_HANGUL.test(ch)
	) {
		return "cjk";
	}
	if (ch === "_" || WORD_NAV_RE_LETTER.test(ch) || WORD_NAV_RE_NUMBER.test(ch)) return "word";
	return "other";
}

const WORD_NAV_JOINERS = new Set(["'", "’", "-", "‐", "‑"]);

export function isWordNavJoiner(grapheme: string): boolean {
	const ch = firstCodePointChar(grapheme);
	return WORD_NAV_JOINERS.has(ch);
}

/**
 * Move the cursor one "word" to the left using Unicode-aware coarse navigation.
 *
 * Returns a new cursor index in the range [0, text.length].
 */
export function moveWordLeft(text: string, cursor: number): number {
	const len = text.length;
	if (len === 0) return 0;
	let i = Math.min(Math.max(cursor, 0), len);
	if (i === 0) return 0;

	const graphemes = [...segmenter.segment(text.slice(0, i))];
	if (graphemes.length === 0) return 0;

	// Skip trailing whitespace.
	while (graphemes.length > 0 && getWordNavKind(graphemes[graphemes.length - 1]?.segment || "") === "whitespace") {
		i -= graphemes.pop()?.segment.length || 0;
	}
	if (i === 0 || graphemes.length === 0) return i;

	const kind = getWordNavKind(graphemes[graphemes.length - 1]?.segment || "");
	if (kind === "delimiter" || kind === "cjk") {
		while (graphemes.length > 0 && getWordNavKind(graphemes[graphemes.length - 1]?.segment || "") === kind) {
			i -= graphemes.pop()?.segment.length || 0;
		}
		return i;
	}

	if (kind === "word") {
		// Skip word run (letters/numbers/underscore), keeping common joiners inside words.
		let hasRightWord = false;
		while (graphemes.length > 0) {
			const g = graphemes[graphemes.length - 1]?.segment || "";
			const k = getWordNavKind(g);
			if (k === "word") {
				hasRightWord = true;
				i -= graphemes.pop()?.segment.length || 0;
				continue;
			}
			if (hasRightWord && k === "delimiter" && isWordNavJoiner(g)) {
				const left = graphemes[graphemes.length - 2]?.segment || "";
				if (getWordNavKind(left) === "word") {
					i -= graphemes.pop()?.segment.length || 0;
					continue;
				}
			}
			break;
		}
		return i;
	}

	// Fallback: move by one grapheme.
	i -= graphemes.pop()?.segment.length || 0;
	return Math.max(0, i);
}

/**
 * Move the cursor one "word" to the right using Unicode-aware coarse navigation.
 *
 * Returns a new cursor index in the range [0, text.length].
 */
export function moveWordRight(text: string, cursor: number): number {
	const len = text.length;
	if (len === 0) return 0;
	let i = Math.min(Math.max(cursor, 0), len);
	if (i === len) return len;

	const iterator = segmenter.segment(text.slice(i))[Symbol.iterator]();
	let next = iterator.next();

	// Skip leading whitespace.
	while (!next.done && getWordNavKind(next.value.segment) === "whitespace") {
		i += next.value.segment.length;
		next = iterator.next();
	}
	if (next.done) return i;

	const firstKind = getWordNavKind(next.value.segment);
	if (firstKind === "delimiter" || firstKind === "cjk") {
		while (!next.done && getWordNavKind(next.value.segment) === firstKind) {
			i += next.value.segment.length;
			next = iterator.next();
		}
		return i;
	}

	if (firstKind === "word") {
		let hasLeftWord = false;
		while (!next.done) {
			const segment = next.value.segment;
			const k = getWordNavKind(segment);
			if (k === "word") {
				hasLeftWord = true;
				i += segment.length;
				next = iterator.next();
				continue;
			}
			if (hasLeftWord && k === "delimiter" && isWordNavJoiner(segment)) {
				const lookahead = iterator.next();
				if (!lookahead.done && getWordNavKind(lookahead.value.segment) === "word") {
					i += segment.length;
					next = lookahead;
					continue;
				}
			}
			break;
		}
		return i;
	}

	// Fallback: move by one grapheme.
	return i + next.value.segment.length;
}

/**
 * Apply background color to a line, padding to full width.
 *
 * @param line - Line of text (may contain ANSI codes)
 * @param width - Total width to pad to
 * @param bgFn - Background color function
 * @returns Line with background applied and padded to width
 */
export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	// Calculate padding needed
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);

	// Apply background to content + padding
	const withPadding = line + padding(paddingNeeded);
	return bgFn(withPadding);
}

/**
 * Extract a range of visible columns from a line. Handles ANSI codes and wide chars.
 *
 * @param strict - If true, exclude wide chars at boundary that would extend past the range
 */
export function sliceByColumn(line: string, startCol: number, length: number, strict = false): string {
	return sliceWithWidth(line, startCol, length, strict).text;
}
