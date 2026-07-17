import { LRUCache } from "lru-cache/raw";
import { Marked, type Token, Tokenizer, type TokenizerAndRendererExtension, type Tokens } from "marked";
import { latexToBlock } from "../latex-block";
import { inlineMathSpanEnd, isBareMathEnvironment, latexToUnicode } from "../latex-to-unicode";
import type { SymbolTheme } from "../symbols";
import { TERMINAL } from "../terminal-capabilities";
import type { Component, NativeScrollbackCommittedRows, NativeScrollbackReplay } from "../tui";
import {
	applyBackgroundToLine,
	Ellipsis,
	encodeTextSized,
	getPaddingX,
	getSegmenter,
	padding,
	replaceTabs,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../utils";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

// OSC 66 (Kitty text-sizing) heading spans are emitted as a single indivisible
// unit by the H1 render path. Like image-protocol lines, they must bypass
// ANSI wrapping and width padding: re-wrapping splits/normalizes the sized span
// (recomputing the explicit `w=` cell count and hoisting SGR out of the OSC
// payload), and padding would append trailing cells past the doubled glyph.
const OSC66_LINE_PREFIX = "\x1b]66;";

function isOsc66Line(line: string): boolean {
	return line.includes(OSC66_LINE_PREFIX);
}

function normalizeHtmlEntitiesForTerminal(raw: string): string {
	const parseCodePoint = (value: number): string => {
		if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
			try {
				return String.fromCodePoint(value);
			} catch (_) {
				// Fallback to empty string or original if invalid codepoint
			}
		}
		return "";
	};

	return raw.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (match, entity) => {
		const lower = entity.toLowerCase();
		switch (lower) {
			case "nbsp":
				return " ";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			case "amp":
				return "&";
			default: {
				if (lower.startsWith("#x")) {
					return parseCodePoint(Number.parseInt(lower.slice(2), 16));
				}
				if (lower.startsWith("#")) {
					return parseCodePoint(Number(lower.slice(1)));
				}
				return match;
			}
		}
	});
}

interface HtmlListState {
	type: "ol" | "ul";
	next: number;
}

interface HtmlNormalizationState {
	lists: HtmlListState[];
	openItems: boolean[];
	itemHasContent: boolean[];
}

function createHtmlNormalizationState(): HtmlNormalizationState {
	return { lists: [], openItems: [], itemHasContent: [] };
}

const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;
const HTML_TAG_REGEX = /<\/?(?:br|p|ol|ul|li|span|text|code|hr|blockquote)\b(?:\s[^>]*)?\s*\/?>/gi;
// Block-level HTML that needs structural (not just textual) rendering: standalone
// `<hr>` becomes a rule and balanced `<blockquote>…</blockquote>` renders with
// quote styling. Group 1 captures blockquote inner content; it is undefined for hr.
const BLOCK_HTML_REGEX = /<hr\b[^>]*\/?>|<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi;

function htmlTagName(tag: string): string {
	const match = /^<\/?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(tag);
	return match ? match[1].toLowerCase() : "";
}

function htmlOlStart(tag: string): number {
	const match = /\bstart\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/i.exec(tag);
	if (!match) return 1;
	return Number(match[1] ?? match[2] ?? match[3]);
}

function appendHtmlLineBreak(output: string, force: boolean = false): string {
	const trimmed = output.replace(/[ \t]+$/u, "");
	return !force && trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

function htmlListIndent(state: HtmlNormalizationState): string {
	return "  ".repeat(Math.max(0, state.lists.length - 1));
}

function appendHtmlListBreak(output: string, state: HtmlNormalizationState): string {
	const indent = htmlListIndent(state);
	return output.endsWith(`${indent}\n`) ? output : appendHtmlLineBreak(output);
}

function markCurrentHtmlItemContent(state: HtmlNormalizationState, text: string): void {
	if (text.trim() !== "" && state.itemHasContent.length > 0) {
		state.itemHasContent[state.itemHasContent.length - 1] = true;
	}
}

function isAtEmptyHtmlListItem(state: HtmlNormalizationState): boolean {
	const itemIndex = state.itemHasContent.length - 1;
	return state.openItems[itemIndex] === true && state.itemHasContent[itemIndex] !== true;
}

function normalizeHtmlForTerminal(
	raw: string,
	state: HtmlNormalizationState = createHtmlNormalizationState(),
	codeHook?: (text: string) => string,
): string {
	let output = "";
	let lastIndex = 0;
	let inCode = false;
	const withoutComments = raw.replace(HTML_COMMENT_REGEX, "");

	for (const match of withoutComments.matchAll(HTML_TAG_REGEX)) {
		const tag = match[0];
		const index = match.index ?? 0;
		const textBeforeTag = normalizeHtmlEntitiesForTerminal(withoutComments.slice(lastIndex, index));
		const name = htmlTagName(tag);
		// Most tags handled here are block-level. Inline contexts — span, text, and
		// the content inside a `<code>` run — keep their surrounding whitespace
		// verbatim because it is significant. For block-level tags, HTML formatting
		// whitespace between tags (e.g. the newlines and indentation in
		// pretty-printed `<ul>\n  <li>…`) is not rendered content; appending it
		// literally would leak source indentation before bullets and blank rows
		// between items, so a whitespace-only slice is dropped. Text inside a
		// `<code>` run is routed through `codeHook` so the inline-code theme is
		// applied without leaking the raw `<code>`/`</code>` tags.
		const isInlineTag = name === "span" || name === "text";
		if (isInlineTag || inCode || textBeforeTag.trim() !== "") {
			output += inCode && codeHook ? codeHook(textBeforeTag) : textBeforeTag;
			markCurrentHtmlItemContent(state, textBeforeTag);
		}
		lastIndex = index + tag.length;

		const isClosing = /^<\//.test(tag);
		const isSelfClosing = /\/\s*>$/.test(tag);

		switch (name) {
			case "span":
			case "text":
				break;
			case "code":
				if (isClosing) inCode = false;
				else if (!isSelfClosing) inCode = true;
				break;
			case "br":
			case "hr":
				output = appendHtmlLineBreak(output, true);
				break;
			case "p":
			case "blockquote":
				if (isClosing) {
					output = appendHtmlLineBreak(output);
				} else if (output.trim() !== "" && !output.endsWith("\n") && !isAtEmptyHtmlListItem(state)) {
					output = appendHtmlLineBreak(output);
				}
				break;
			case "ol":
				if (isClosing) {
					state.lists.pop();
					state.openItems.pop();
					state.itemHasContent.pop();
				} else if (!isSelfClosing) {
					if (state.openItems.length > 0 && state.openItems[state.openItems.length - 1]) {
						output = appendHtmlListBreak(output, state);
					}
					state.lists.push({ type: "ol", next: htmlOlStart(tag) });
					state.openItems.push(false);
					state.itemHasContent.push(false);
				}
				break;
			case "ul":
				if (isClosing) {
					state.lists.pop();
					state.openItems.pop();
					state.itemHasContent.pop();
				} else if (!isSelfClosing) {
					if (state.openItems.length > 0 && state.openItems[state.openItems.length - 1]) {
						output = appendHtmlListBreak(output, state);
					}
					state.lists.push({ type: "ul", next: 1 });
					state.openItems.push(false);
					state.itemHasContent.push(false);
				}
				break;
			case "li": {
				if (isClosing) {
					output = appendHtmlLineBreak(output);
					break;
				}
				if (state.openItems.length > 0) {
					const itemOpenIndex = state.openItems.length - 1;
					if (state.openItems[itemOpenIndex]) output = appendHtmlListBreak(output, state);
					state.openItems[itemOpenIndex] = true;
					state.itemHasContent[itemOpenIndex] = false;
				} else if (output.trim() !== "" && !output.endsWith("\n")) {
					output = appendHtmlLineBreak(output);
				}
				const list = state.lists[state.lists.length - 1];
				const indent = htmlListIndent(state);
				if (list?.type === "ol") {
					output += `${indent}${list.next}. `;
					list.next++;
				} else {
					output += `${indent}• `;
				}
				break;
			}
			default:
				output += tag;
				break;
		}
	}

	const remainingText = normalizeHtmlEntitiesForTerminal(withoutComments.slice(lastIndex));
	markCurrentHtmlItemContent(state, remainingText);
	return output + (inCode && codeHook ? codeHook(remainingText) : remainingText);
}

function splitTerminalLines(text: string): string[] {
	const lines = text.split("\n");
	while (lines.length > 1 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Tree-guide hanging wrap
//
// Models routinely emit box-drawing trees ("├── item") inside plain
// paragraphs — directory layouts, decision trees. The lexer sees those lines
// as ordinary prose, so the generic wrap pass restarts wrapped continuations
// at column 0 and visually shears the tree apart (doubly fast for CJK text,
// where every glyph is two cells wide). Mirror the guide semantics of
// `tree(1)` / rich.tree instead: wrap the node text within the cells that
// remain after the guide prefix, and indent every continuation row under the
// node text — branch glyphs swap to their pass-through form (`├` → `│`,
// `└` → blank) so the rails of still-open ancestors stay visually joined.
// ---------------------------------------------------------------------------

/** Continuation glyph for each guide character a tree prefix may contain. */
const TREE_GUIDE_CONTINUATION: Record<string, string> = {
	"│": "│",
	"┃": "┃",
	"║": "║",
	"├": "│",
	"┣": "┃",
	"╠": "║",
	"└": " ",
	"┗": " ",
	"╚": " ",
	"╰": " ",
	"─": " ",
	"━": " ",
	"═": " ",
	" ": " ",
};

/** Cheap pre-gate: any guide glyph at all. The structural test is TREE_BRANCH_CONNECTOR_RE. */
const TREE_GUIDE_ANCHOR_RE = /[│┃║├┣╠└┗╚╰]/;

/**
 * A prefix qualifies as tree-shaped only when a branch/corner glyph is
 * immediately followed by a horizontal connector (`├──`, `└─`, `╰──`, …).
 * A lone rail or branch glyph used as prose ("│ is the Unicode vertical box
 * drawing glyph…") never qualifies, so such paragraphs keep the plain wrap.
 */
const TREE_BRANCH_CONNECTOR_RE = /[├┣╠└┗╚╰][─━═]/;

/** Below this many content cells a hanging wrap degenerates; keep the plain wrap. */
const MIN_TREE_CONTENT_WIDTH = 8;

const SGR_SEQUENCE_STICKY = /\x1b\[[0-9;:]*m/y;
const SGR_SEQUENCE_GLOBAL = /\x1b\[[0-9;:]*m/g;

/**
 * Everything before the last full SGR reset is dead state — drop it so the
 * re-played `carry` stays bounded by the paragraph's live style run instead
 * of its whole code history.
 */
function compactSgrCarry(carry: string): string {
	const shortReset = carry.lastIndexOf("\x1b[m");
	const longReset = carry.lastIndexOf("\x1b[0m");
	const cut = Math.max(shortReset === -1 ? -1 : shortReset + 3, longReset === -1 ? -1 : longReset + 4);
	return cut === -1 ? carry : carry.slice(cut);
}

interface TreeGuidePrefix {
	/** Index of the first char past the guide run (start of the node text). */
	end: number;
	/** SGR sequences interleaved with the guides, in order (zero visible width). */
	codes: string;
	/** Guide characters with SGR stripped, exactly as they appear on screen. */
	guides: string;
}

/**
 * Match the leading box-drawing guide run of a rendered line (e.g. `│   ├── `),
 * tolerating interleaved SGR styling. Returns undefined unless the run
 * contains a branch glyph joined to a horizontal connector and node text
 * follows, so dash art, indented prose, and lone glyphs used as prose are
 * never treated as a tree.
 */
function matchTreeGuidePrefix(line: string): TreeGuidePrefix | undefined {
	let codes = "";
	let guides = "";
	let i = 0;
	while (i < line.length) {
		if (line.charCodeAt(i) === 0x1b) {
			SGR_SEQUENCE_STICKY.lastIndex = i;
			const match = SGR_SEQUENCE_STICKY.exec(line);
			if (!match) break;
			codes += match[0];
			i = SGR_SEQUENCE_STICKY.lastIndex;
			continue;
		}
		const char = line[i]!;
		if (!(char in TREE_GUIDE_CONTINUATION)) break;
		guides += char;
		i++;
	}
	if (i >= line.length || !TREE_BRANCH_CONNECTOR_RE.test(guides)) return undefined;
	return { end: i, codes, guides };
}

/**
 * Hanging wrap for box-drawing tree lines inside prose block text.
 *
 * Returns undefined when no line needs the treatment, so paragraphs without
 * overflowing tree lines keep their exact current render. When a paragraph
 * does hang, its lines are returned pre-split and style-self-contained: the
 * SGR state open at each line start is re-played onto that line (`carry`),
 * because the caller's wrap pass — which normally carries SGR state across
 * the newlines of a single entry — no longer sees them as one entry.
 */
function hangWrapTreeGuideLines(text: string, width: number): string[] | undefined {
	if (width < MIN_TREE_CONTENT_WIDTH || !TREE_GUIDE_ANCHOR_RE.test(text)) return undefined;

	const sourceLines = text.split("\n");
	const hangs = (line: string): TreeGuidePrefix | undefined => {
		if (visibleWidth(line) <= width) return undefined;
		const prefix = matchTreeGuidePrefix(line);
		if (!prefix) return undefined;
		if (width - visibleWidth(prefix.guides) < MIN_TREE_CONTENT_WIDTH) return undefined;
		return prefix;
	};
	if (!sourceLines.some(line => hangs(line) !== undefined)) return undefined;

	const out: string[] = [];
	let carry = "";
	for (const line of sourceLines) {
		const prefix = hangs(line);
		if (!prefix) {
			out.push(carry ? carry + line : line);
			carry = compactSgrCarry(carry + (line.match(SGR_SEQUENCE_GLOBAL)?.join("") ?? ""));
			continue;
		}
		// Re-play the SGR state ahead of the node text so the wrapper carries
		// it onto every continuation row; the codes are zero-width, so measured
		// row widths are unaffected.
		const activeCodes = carry + prefix.codes;
		const rows = wrapTextWithAnsi(activeCodes + line.slice(prefix.end), width - visibleWidth(prefix.guides));
		let hang = "";
		for (const guide of prefix.guides) hang += TREE_GUIDE_CONTINUATION[guide] ?? " ";
		const hangShortfall = visibleWidth(prefix.guides) - visibleWidth(hang);
		if (hangShortfall > 0) hang += padding(hangShortfall);
		out.push(carry + line.slice(0, prefix.end) + rows[0]!.slice(activeCodes.length));
		for (let i = 1; i < rows.length; i++) {
			out.push(activeCodes + hang + rows[i]!);
		}
		carry = compactSgrCarry(carry + (line.match(SGR_SEQUENCE_GLOBAL)?.join("") ?? ""));
	}
	return out;
}

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});

// Math spans (`$$…$$`, `\[…\]`, `$…$`, `\(…\)`) are tokenized as a dedicated
// `math` inline token before markdown's escape/emphasis/link rules run, so
// backslash commands (`\frac`, `\alpha`) and intraword underscores (`x_i`)
// survive intact instead of being mangled or split. The `$…$` form uses
// pandoc's anti-currency heuristic (`inlineMathSpanEnd`) so "$5 and $10" is
// never math. Inline extensions run before marked's escape tokenizer, so
// `\(…\)` becomes math while a genuinely escaped `\$` is left to `escape` and
// renders as a literal dollar.
const CUSTOM_HR_START_REGEX = /(?:^|\n) {0,3}([-*_─━═=–—])[ \t]*(?:\1[ \t]*){2,}(?:\n+|$)/;
const CUSTOM_HR_TOKENIZER_REGEX = /^ {0,3}([-*_─━═=–—])[ \t]*(?:\1[ \t]*){2,}(?:\n+|$)/;

function getHrChar(char: string, hrChar: string): string {
	const isAscii = hrChar === "-";
	switch (char) {
		case "=":
			return "=";
		case "═":
			return isAscii ? "=" : "═";
		case "━":
			return isAscii ? "-" : "━";
		case "─":
			return isAscii ? "-" : "─";
		case "–":
			return isAscii ? "-" : "–";
		case "—":
			return isAscii ? "-" : "—";
		default:
			return hrChar;
	}
}

const customHrExtension: TokenizerAndRendererExtension = {
	name: "customHr",
	level: "block",
	start(src) {
		const match = CUSTOM_HR_START_REGEX.exec(src);
		if (!match) return undefined;
		let idx = match.index;
		if (src[idx] === "\n") {
			idx += 1;
		}
		return idx;
	},
	tokenizer(src) {
		const match = CUSTOM_HR_TOKENIZER_REGEX.exec(src);
		if (match) {
			return {
				type: "hr",
				raw: match[0],
			};
		}
		return undefined;
	},
	renderer() {
		return "";
	},
};

const mathExtension: TokenizerAndRendererExtension = {
	name: "math",
	level: "inline",
	start(src) {
		const m = /\$|\\\(|\\\[/.exec(src);
		return m ? m.index : undefined;
	},
	tokenizer(src) {
		if (src.startsWith("$$")) {
			const end = src.indexOf("$$", 2);
			if (end !== -1 && src.slice(2, end).trim().length > 0) {
				return { type: "math", raw: src.slice(0, end + 2), text: src.slice(2, end), display: true };
			}
			return undefined;
		}
		if (src.startsWith("\\[")) {
			const end = src.indexOf("\\]", 2);
			if (end !== -1) return { type: "math", raw: src.slice(0, end + 2), text: src.slice(2, end), display: true };
			return undefined;
		}
		if (src.startsWith("\\(")) {
			const end = src.indexOf("\\)", 2);
			if (end !== -1) return { type: "math", raw: src.slice(0, end + 2), text: src.slice(2, end), display: false };
			return undefined;
		}
		if (src.charCodeAt(0) === 0x24 /* $ */) {
			const end = inlineMathSpanEnd(src, 0);
			if (end !== -1) return { type: "math", raw: src.slice(0, end + 1), text: src.slice(1, end), display: false };
		}
		return undefined;
	},
	renderer(token) {
		return (token as { text?: string }).text ?? "";
	},
};

// Display math blocks: opening `$$` / `\[` and closing `$$` / `\]` each alone on
// their own line (≤3 leading spaces). Matched at the block level — before
// paragraph/list parsing — so a multi-line equation (e.g. a matrix with `\\`
// row breaks) renders across several lines instead of being collapsed onto one,
// and blank lines inside the block don't split it. The own-line requirement
// keeps inline `$$…$$` inside prose for the inline tokenizer above.
const MATH_BLOCK_DOLLAR = /^ {0,3}\$\$[ \t]*\n([\s\S]+?)\n {0,3}\$\$[ \t]*(?:\n|$)/;
const MATH_BLOCK_BRACKET = /^ {0,3}\\\[[ \t]*\n([\s\S]+?)\n {0,3}\\\][ \t]*(?:\n|$)/;
const MATH_BLOCK_START = /(?:^|\n) {0,3}(?:\$\$|\\\[)[ \t]*\n/;
const mathBlockExtension: TokenizerAndRendererExtension = {
	name: "mathBlock",
	level: "block",
	start(src) {
		const m = MATH_BLOCK_START.exec(src);
		return m ? m.index : undefined;
	},
	tokenizer(src) {
		const m = MATH_BLOCK_DOLLAR.exec(src) ?? MATH_BLOCK_BRACKET.exec(src);
		if (!m || m[1].trim().length === 0) return undefined;
		return { type: "math", raw: m[0], text: m[1], display: true };
	},
	renderer(token) {
		return (token as { text?: string }).text ?? "";
	},
};

// Bare (delimiter-less) display-math environments: `\begin{<mathenv>}…\end{…}`
// written without `$$`/`\[` fences (common in raw model output). Captured at the
// block level as a whole unit — including any immediately preceding `lhs =`
// line — so marked never splits it on inline `\\` row breaks. Restricted to math
// environments (isBareMathEnvironment), and the `≤3 leading spaces` + "block
// starts at offset 0" guards keep fenced/indented `\begin{cases}` code blocks
// for marked's own code rules.
const BARE_ENV_BEGIN = /(?:^|\n)[ \t]{0,3}\\begin\{([A-Za-z]+\*?)\}/;
function bareMathEnvBlock(src: string): readonly [number, number] | null {
	const bm = BARE_ENV_BEGIN.exec(src);
	if (!bm || !isBareMathEnvironment(bm[1])) return null;
	const beginLineStart = bm.index === 0 ? 0 : bm.index + 1; // skip the matched leading `\n`
	const endToken = `\\end{${bm[1]}}`;
	const endAt = src.indexOf(endToken, bm.index);
	if (endAt === -1) return null;
	// The `\end` must close before any blank line (i.e. within the same block).
	if (/\n[ \t]*\n/.test(src.slice(beginLineStart, endAt))) return null;
	let blockEnd = endAt + endToken.length;
	while (src[blockEnd] === " " || src[blockEnd] === "\t") blockEnd++;
	if (src[blockEnd] === "\n") blockEnd++;
	// Pull in one immediately-preceding `lhs =`/open-delimiter line (e.g. `f(x) =`).
	let start = beginLineStart;
	if (start > 0 && src[start - 1] === "\n") {
		const prevStart = src.lastIndexOf("\n", start - 2) + 1;
		const prevLine = src.slice(prevStart, start - 1);
		if (/[=([{]\s*$/.test(prevLine)) start = prevStart;
	}
	return [start, blockEnd];
}
const mathEnvBlockExtension: TokenizerAndRendererExtension = {
	name: "mathEnvBlock",
	level: "block",
	start(src) {
		const r = bareMathEnvBlock(src);
		return r ? r[0] : undefined;
	},
	tokenizer(src) {
		const r = bareMathEnvBlock(src);
		if (r?.[0] !== 0) return undefined; // only consume when the block starts at offset 0
		const raw = src.slice(0, r[1]);
		const text = raw.replace(/\n[ \t]*$/, "");
		if (text.trim().length === 0) return undefined;
		return { type: "math", raw, text, display: true };
	},
	renderer(token) {
		return (token as { text?: string }).text ?? "";
	},
};
markdownParser.use({ extensions: [customHrExtension, mathBlockExtension, mathEnvBlockExtension, mathExtension] });

// ---------------------------------------------------------------------------
// Module-level LRU render cache
// ---------------------------------------------------------------------------
// Each session-tree navigation discards and recreates Markdown component
// instances, so the per-instance #cachedLines field is always cold on first
// render of a fresh component. This module-level cache survives across
// component lifetimes and eliminates redundant marked.lexer + highlightCode
// (Rust FFI) work for content/layout combinations already seen this session.

const RENDER_CACHE_MAX = 256; // sane cap: ~256 distinct message × width combos
const RENDER_CACHE_MAX_SIZE = 512 * 1024;
const RENDER_CACHE_MAX_ENTRY_SIZE = 32 * 1024;
const EMPTY_RENDER_LINES: readonly string[] = [];

interface RenderCacheEntry {
	lines: readonly string[];
	tables: readonly RenderedTableLayout[];
}

const renderCache = new LRUCache<string, RenderCacheEntry>({
	max: RENDER_CACHE_MAX,
	maxSize: RENDER_CACHE_MAX_SIZE,
	maxEntrySize: RENDER_CACHE_MAX_ENTRY_SIZE,
	sizeCalculation: renderCacheEntrySize,
});

function renderedLinesCacheSize(lines: readonly string[]): number {
	let size = lines.length;
	for (let i = 0; i < lines.length; i++) size += lines[i]!.length;
	return Math.max(1, size);
}

function renderCacheEntrySize(entry: RenderCacheEntry): number {
	let size = renderedLinesCacheSize(entry.lines);
	for (const table of entry.tables) size += table.key.length + table.columnWidths.length + 4;
	return size;
}

// A reference-link definition (`[label]: dest`) resolves across the whole
// document, so a split lex cannot reproduce it — disable the streaming fast path
// when one is present (rare in streamed output). The label may contain
// backslash-escaped characters (`[a\]b]: x`), so escapes are matched explicitly;
// over-matching is safe (it only costs the fast path), under-matching is not.
const HAS_REF_DEF = /^ {0,3}\[(?:\\.|[^\]\\])+\]:/m;

/** Drop all L2 cache entries. Call on theme change to prevent stale styled output. */
export function clearRenderCache(): void {
	renderCache.clear();
}

// Stable numeric IDs for structural theme/style objects (no ID field on type).
// WeakMap-keyed so the ID matches strict object identity and doesn't get copied by spread/cloning.
const themeObjectIds = new WeakMap<object, number>();
let nextObjectId = 0;
function objectId(o: object): number {
	let id = themeObjectIds.get(o);
	if (id === undefined) {
		id = nextObjectId++;
		themeObjectIds.set(o, id);
	}
	return id;
}

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	/**
	 * Resolve a mermaid ASCII rendering by fenced block source text.
	 * Return null to fall back to fenced code rendering.
	 */
	resolveMermaidAscii?: (source: string, maxWidth?: number) => string | null;
	symbols: SymbolTheme;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

type ListToken = Token & { items: Array<{ tokens?: Token[] }>; ordered: boolean; start?: number };
type TableCellToken = { tokens?: Token[] };
type TableToken = Token & { header: TableCellToken[]; rows: TableCellToken[][]; raw?: string };

function formatHyperlink(text: string, target: string): string {
	if (!TERMINAL.hyperlinks || !target) {
		return text;
	}

	const safeTarget = target.replaceAll("\x1b", "").replaceAll("\x07", "");
	if (!safeTarget) {
		return text;
	}

	return `\x1b]8;;${safeTarget}\x07${text}\x1b]8;;\x07`;
}

function isAsciiTextSizingPayload(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) return false;
	}
	return true;
}

function encodeTextSizedHeading(text: string, scale: 1 | 2 | 3): string {
	let out = "";
	let asciiRun = "";
	const flushAscii = () => {
		if (asciiRun === "") return;
		out += encodeTextSized(asciiRun, { scale });
		asciiRun = "";
	};

	for (const { segment } of getSegmenter().segment(text)) {
		if (isAsciiTextSizingPayload(segment)) {
			asciiRun += segment;
			continue;
		}
		flushAscii();
		out += encodeTextSized(segment, { scale, widthCells: visibleWidth(segment) });
	}
	flushAscii();
	return out;
}

const MATH_NEWLINES = /\n+/g;

/** True for the custom inline `math` token produced by the math extension. */
function isMathToken(token: Token): token is Token & { text: string; display: boolean } {
	return (token as { type: string }).type === "math";
}

/** Convert a `math` token's LaTeX to single-line Unicode for inline rendering. */
function renderMathToken(text: string): string {
	return latexToUnicode(text).replace(MATH_NEWLINES, " ");
}

/**
 * When a paragraph's only meaningful content is a single display math token
 * (`$$…$$` / `\[…\]`), return it so the paragraph can be stacked multi-line
 * instead of flattened inline. Models routinely write display math on one line,
 * which marked captures as an inline `display:true` math token inside a
 * paragraph; without this it would flatten through `renderMathToken`.
 */
function soleDisplayMath(tokens?: Token[]): (Token & { text: string }) | null {
	if (!tokens) return null;
	let math: (Token & { text: string; display: boolean }) | null = null;
	for (const token of tokens) {
		if (isMathToken(token) && token.display) {
			if (math) return null;
			math = token;
		} else if (!(token.type === "text" && typeof token.text === "string" && token.text.trim() === "")) {
			return null;
		}
	}
	return math;
}

function plainInlineTokens(tokens: Token[]): string {
	let result = "";
	for (const token of tokens) {
		if (isMathToken(token)) {
			result += renderMathToken(token.text);
			continue;
		}
		switch (token.type) {
			case "text":
				result += token.tokens && token.tokens.length > 0 ? plainInlineTokens(token.tokens) : token.text;
				break;
			case "strong":
			case "em":
			case "del":
			case "link":
				result += plainInlineTokens(token.tokens || []);
				break;
			case "codespan":
				result += token.text;
				break;
			default:
				if ("text" in token && typeof token.text === "string") result += token.text;
				break;
		}
	}
	return result;
}

/**
 * Classify an inline `html` token by tag name and whether it is a closing tag.
 * Returns null for non-html tokens or raw that isn't a recognizable HTML tag.
 */
function inlineHtmlTag(token: Token): { name: string; closing: boolean } | null {
	if ((token as { type: string }).type !== "html") return null;
	const raw = (token as { raw?: unknown }).raw;
	if (typeof raw !== "string") return null;
	const name = htmlTagName(raw);
	if (!name) return null;
	return { name, closing: /^<\s*\//.test(raw) };
}

/**
 * Collapse inline `<code>…</code>` runs — which marked emits as separate `html`
 * open/close tokens around the literal content — into a single synthetic
 * `codespan` token, so they render with the theme's inline-code styling instead
 * of leaking the raw tags. HTML entities inside the run are decoded. Stray or
 * unmatched code tags are dropped; other inline html tokens pass through for the
 * `html` render path to normalize. Returns the original array when no `<code>`
 * tag is present (the common case).
 */
function collapseInlineHtml(tokens: Token[]): Token[] {
	let hasCode = false;
	for (const token of tokens) {
		if (inlineHtmlTag(token)?.name === "code") {
			hasCode = true;
			break;
		}
	}
	if (!hasCode) return tokens;

	const out: Token[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const tag = inlineHtmlTag(tokens[i]);
		if (tag?.name === "code") {
			if (tag.closing) continue; // stray `</code>` — drop it
			let j = i + 1;
			for (; j < tokens.length; j++) {
				const close = inlineHtmlTag(tokens[j]);
				if (close?.name === "code" && close.closing) break;
			}
			if (j >= tokens.length) continue; // unmatched `<code>` — drop it, render the rest normally
			const text = normalizeHtmlEntitiesForTerminal(plainInlineTokens(tokens.slice(i + 1, j)));
			out.push({ type: "codespan", raw: text, text } as Token);
			i = j;
			continue;
		}
		out.push(tokens[i]);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Inline hex-color swatches
// ---------------------------------------------------------------------------
// When prose/thinking mentions a CSS hex color (e.g. #C5FFD6 or `#C5FFD6`),
// render a small chip painted with that color just before the code. The chip
// glyph comes from the theme's symbol set (ASCII → Unicode → Nerd Font), so it
// degrades gracefully; the color itself is exact 24-bit on truecolor terminals
// and the nearest 256-color cell otherwise (Bun.color quantizes for us).

/** Fallback chip when the theme supplies no `colorSwatch` symbol (Unicode default). */
const DEFAULT_COLOR_SWATCH_GLYPH = "■";

// `#` + 3-8 hex digits, not glued to a surrounding word/`#`/`&` (avoids HTML
// entities like &#9731; and paths like foo#fff) and not trailed by more hex
// (so over-long runs never produce a misleading swatch). Length/letter rules
// are enforced in classifyHexColor since the alternation can't express "exactly
// 3, 6, or 8".
const HEX_COLOR_REGEX = /(?<![\w#&])#([0-9a-fA-F]{3,8})(?![0-9a-fA-F])/g;
const HEX_COLOR_EXACT_REGEX = /^#([0-9a-fA-F]{3,8})$/;

/**
 * Decide whether a run of hex digits denotes a renderable CSS color.
 *
 * Only the canonical CSS lengths (#RGB, #RRGGBB, #RRGGBBAA) qualify. The 4-digit
 * #RGBA form is deliberately excluded: it collides with hashline `#TAG` snapshot
 * tags (4 hex digits, e.g. #6C5E), which would otherwise sprout spurious swatches.
 * In `strict` mode (bare prose) a 3-digit run must contain a hex letter, so the
 * far more common short issue/PR references (#123, #1011) don't sprout swatches.
 * Codespans opt out of strictness — the backticks already signal "this is a color".
 */
function classifyHexColor(hex: string, strict: boolean): boolean {
	const n = hex.length;
	if (n !== 3 && n !== 6 && n !== 8) return false;
	if (strict && n === 3 && !/[a-fA-F]/.test(hex)) return false;
	return true;
}

/** ANSI-painted `glyph` for `#${hex}`, or "" when the color can't be encoded. */
function colorSwatch(hex: string, glyph: string): string {
	const ansi = Bun.color(`#${hex}`, TERMINAL.trueColor ? "ansi-16m" : "ansi-256");
	// Reset only the foreground (\x1b[39m) so an enclosing background/decoration
	// applied later by the line renderer survives across the swatch.
	return ansi ? `${ansi}${glyph}\x1b[39m ` : "";
}

/**
 * Style a plain-text run, inserting a color swatch before each hex color it
 * mentions. Non-color text (including the matched `#hex` itself) is routed
 * through `applySegment` so the caller's base styling is preserved verbatim.
 */
function renderTextWithSwatches(text: string, applySegment: (t: string) => string, glyph: string): string {
	HEX_COLOR_REGEX.lastIndex = 0;
	let result = "";
	let last = 0;
	for (;;) {
		const match = HEX_COLOR_REGEX.exec(text);
		if (match === null) break;
		if (!classifyHexColor(match[1], true)) continue;
		const swatch = colorSwatch(match[1], glyph);
		if (!swatch) continue;
		if (match.index > last) result += applySegment(text.slice(last, match.index));
		result += swatch + applySegment(match[0]);
		last = match.index + match[0].length;
	}
	if (last === 0) return applySegment(text);
	if (last < text.length) result += applySegment(text.slice(last));
	return result;
}

/** Swatch for a codespan whose entire content is a single hex color, else "". */
function codespanSwatch(code: string, glyph: string): string {
	const match = HEX_COLOR_EXACT_REGEX.exec(code.trim());
	if (!match || !classifyHexColor(match[1], false)) return "";
	return colorSwatch(match[1], glyph);
}

interface RenderSignature {
	width: number;
	paddingX: number;
	paddingY: number;
	codeBlockIndent: number;
	themeId: number;
	defaultTextStyleId: number;
	imageProtocol: string;
	hyperlinks: boolean;
	textSizing: boolean;
	bgColorProbe: string;
	headingProbe: string;
}

interface StreamPrefixLineCache extends RenderSignature {
	text: string;
	tokenCount: number;
	lines: readonly string[];
	tables: readonly TableRenderSpec[];
}
interface StreamingDiffLineCache extends RenderSignature {
	lang: string | undefined;
	text: string;
	lines: readonly string[];
}

interface TableLayoutLock {
	availableWidth: number;
	columnWidths: readonly number[];
}

interface TableRenderSpec extends TableLayoutLock {
	key: string;
	lineCount: number;
	startRow: number;
	endRow: number;
}

interface RenderedTableLayout extends TableLayoutLock {
	key: string;
	startRow: number;
	endRow: number;
}

export class Markdown implements Component, NativeScrollbackCommittedRows, NativeScrollbackReplay {
	#text: string;
	#paddingX: number; // Left/right padding
	#paddingY: number; // Top/bottom padding
	#defaultTextStyle?: DefaultTextStyle;
	#theme: MarkdownTheme;
	#defaultStylePrefix?: string;
	/** Number of spaces used to indent code block content. */
	#codeBlockIndent: number;

	// Cache for rendered output. Cached arrays are shared and returned by
	// reference (render contract: results are component-owned and immutable to
	// callers); the L2 LRU may hand the same array to multiple instances.
	#cachedText?: string;
	#cachedWidth?: number;
	#cachedLines?: readonly string[];
	#transientRenderCache = false;

	// Streaming-lex cache: the largest blank-line-bounded prefix of #text whose
	// block tokens are frozen, plus those tokens. marked has no resumable lexer,
	// but block tokenization is local across a "\n\n" boundary with balanced
	// fences, so lex(prefix) ++ lex(tail) === lex(prefix+tail). On append-only
	// growth (the streaming path) this re-lexes only the grown tail instead of the
	// whole buffer, turning O(N^2) reveal cost into O(N). Width/theme do not affect
	// tokenization, so this cache is independent of the render caches above.
	#streamPrefixText?: string;
	#streamPrefixTokens?: Token[];
	#streamPrefixLineCache?: StreamPrefixLineCache;
	// Rows of the most recent render() that are settled — top padding plus the
	// rendered frozen token prefix — exposed via getLastRenderSettledRows()
	// for native-scrollback commit gating.
	#lastRenderSettledRows = 0;
	// Frozen-prefix text backing the last non-zero settled exposure. Settled
	// rows are declared final downstream, so a render whose frozen text no
	// longer extends this prefix (a rewind / wholesale rewrite) resets the
	// exposure to 0 and re-earns it — the exposure is hard-monotone within a
	// text lineage.
	#settledExposedText?: string;
	// True while #renderStreamingContentLines renders the frozen token range:
	// frozen code blocks highlight even in transient mode so their bytes match
	// the finalized render (they render once into the prefix line cache, so
	// the FFI cost is amortized). The volatile tail normally stays
	// unhighlighted; streaming diff fences line-highlight completed rows so
	// semantic colors reach native scrollback before rows leave the viewport.
	#renderingFrozenPrefix = false;
	#streamingDiffLineCache?: StreamingDiffLineCache;
	#activeRenderSignature?: RenderSignature;
	// Streaming tables may grow naturally while wholly repaintable. Once any
	// physical row of a table enters native scrollback, its current column widths
	// are locked for the rest of this append-only text lineage: future wider cells
	// wrap inside those columns instead of reflowing immutable history above.
	#tableLayoutWidth?: number;
	#lockedTableLayouts = new Map<string, TableLayoutLock>();
	#lastRenderedTableLayouts: RenderedTableLayout[] = [];
	#activeTableRenderSpecs?: TableRenderSpec[];

	#ignoreTight = false;

	setIgnoreTight(ignore: boolean): this {
		if (this.#ignoreTight !== ignore) this.#clearTableLayouts();
		this.#ignoreTight = ignore;
		this.invalidate();
		return this;
	}

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		codeBlockIndent: number = 2,
	) {
		this.#text = text;
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#theme = theme;
		this.#defaultTextStyle = defaultTextStyle;
		this.#codeBlockIndent = Math.max(0, Math.floor(codeBlockIndent));
	}

	setText(text: string): boolean {
		// Equality guard: streaming re-emits identical text on ticks that carried
		// no delta (throttled provider frames, reconciled tool-execution updates).
		// Without this, the caller-side `#cachedLines` gets thrown away and the
		// full lex + wrap runs per re-emit — one of the top CPU hotspots during
		// streaming (issue #4353). Mirrors `Text.setText`'s guard.
		if (text === this.#text) return false;
		if (!text.startsWith(this.#text)) this.#clearTableLayouts();
		this.#text = text;
		if (!text.trim()) {
			// Blank replacement: render() early-returns before #lexTokens can see
			// the non-append edit, so drop the frozen stream state here or it
			// outlives the content it indexed.
			this.#streamPrefixText = undefined;
			this.#streamPrefixTokens = undefined;
			this.#streamPrefixLineCache = undefined;
			this.#settledExposedText = undefined;
		}
		this.invalidate();
		return true;
	}

	invalidate(): void {
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedLines = undefined;
	}
	get transientRenderCache(): boolean {
		return this.#transientRenderCache;
	}

	set transientRenderCache(value: boolean) {
		const next = value === true;
		if (this.#transientRenderCache === next) return;
		this.#transientRenderCache = next;
		this.invalidate();
	}

	/**
	 * Rows at the top of the most recent render() (top padding + rendered
	 * frozen-token prefix) whose bytes are settled: byte-stable at this
	 * width/theme for as long as the text keeps growing append-only. Hosts
	 * feed this to transcript commit gating (see the coding agent's
	 * `FinalizableBlock.getTranscriptBlockSettledRows`). 0 outside streaming
	 * (`transientRenderCache`) mode, after a text rewind (re-earned on the new
	 * lineage), and on cache-served non-streaming renders.
	 */
	getLastRenderSettledRows(): number {
		return this.#lastRenderSettledRows;
	}

	/**
	 * Freeze every table whose first physical row is already part of the native
	 * scrollback prefix. The recorded widths came from the exact frame that was
	 * just emitted, so the next streamed delta cannot retroactively widen it.
	 */
	setNativeScrollbackCommittedRows(rows: number): void {
		const committed = Number.isFinite(rows) ? Math.max(0, Math.trunc(rows)) : 0;
		let changed = false;
		for (const table of this.#lastRenderedTableLayouts) {
			if (table.startRow >= committed || this.#lockedTableLayouts.has(table.key)) continue;
			this.#lockedTableLayouts.set(table.key, {
				availableWidth: table.availableWidth,
				columnWidths: table.columnWidths.slice(),
			});
			changed = true;
		}
		if (changed) this.invalidate();
	}

	/** A destructive replay removes the immutable tape this layout was guarding. */
	prepareNativeScrollbackReplay(): void {
		this.#clearTableLayouts();
		this.#tableLayoutWidth = undefined;
		this.invalidate();
	}

	#clearTableLayouts(): void {
		this.#lockedTableLayouts.clear();
		this.#lastRenderedTableLayouts = [];
		this.#activeTableRenderSpecs = undefined;
		// Same-width replay/non-append rewrites could otherwise reuse physical
		// prefix lines rendered with the retired locked widths.
		this.#streamPrefixLineCache = undefined;
	}

	// Lex `text` into block tokens, reusing the frozen stable prefix when the text
	// only grew (the streaming path). Falls back to a full lex whenever the prefix
	// is no longer a prefix (non-append edit), the text carries reference-link
	// definitions, or it contains CR (marked normalizes CRLF, which would desync
	// raw-span offsets). Every fallback is correctness-preserving — only speed
	// differs; the render loop sees the identical token list either way.
	#lexTokens(text: string): Token[] {
		const canStream = !HAS_REF_DEF.test(text) && !text.includes("\r");
		const prefix = this.#streamPrefixText;
		const prefixTokens = this.#streamPrefixTokens;
		if (
			canStream &&
			prefix !== undefined &&
			prefixTokens !== undefined &&
			text.length > prefix.length &&
			text.startsWith(prefix)
		) {
			const tailTokens = markdownParser.lexer(text.slice(prefix.length));
			const tokens = [...prefixTokens, ...tailTokens];
			this.#freezeStablePrefix(text, tokens, { preserveExisting: true });
			return tokens;
		}
		const tokens = markdownParser.lexer(text);
		if (canStream) {
			this.#freezeStablePrefix(text, tokens, { preserveExisting: false });
		} else {
			this.#streamPrefixText = undefined;
			this.#streamPrefixTokens = undefined;
			this.#streamPrefixLineCache = undefined;
		}
		return tokens;
	}

	// Freeze the largest run of leading blocks that end on a hard "\n\n" boundary
	// (complete and immutable under append-only growth) so the next streaming
	// render re-lexes only the unfrozen tail. Caller guarantees no CR / no
	// reference definitions, so each token's `raw` is a verbatim slice of `text`
	// and the summed offsets address `text` exactly.
	#freezeStablePrefix(text: string, tokens: Token[], opts: { preserveExisting: boolean }): void {
		let pos = 0;
		let frozenEnd = 0;
		let frozenCount = 0;
		for (let i = 0; i < tokens.length; i++) {
			const raw = tokens[i].raw;
			const end = pos + raw.length;
			// A `space` token ending in "\n\n" closes the preceding block, but a
			// `list` before it can still be extended by a following same-marker
			// item across the blank line (CommonMark loose-list continuation),
			// which marked merges into one renumbered loose list. Freezing across
			// such a cut would keep the lists separate. Never freeze right after a
			// list — it stays in the re-lexed tail.
			if (raw.endsWith("\n\n") && tokens[i - 1]?.type !== "list") {
				frozenEnd = end;
				frozenCount = i + 1;
			}
			pos = end;
		}
		// Freeze only when the tail begins with real block content. If the next
		// char is whitespace (an extra blank line, or an indented continuation),
		// the block separator straddles the cut and lex(prefix)++lex(tail) would
		// desync from a full lex — e.g. a fence followed by "\n\n\n- list". When
		// frozenEnd is at end-of-text the next char is unknown, so defer.
		if (frozenCount > 0 && frozenEnd < text.length) {
			const next = text.charCodeAt(frozenEnd);
			if (next !== 0x20 /* space */ && next !== 0x0a /* \n */) {
				this.#streamPrefixText = text.slice(0, frozenEnd);
				this.#streamPrefixTokens = tokens.slice(0, frozenCount);
				return;
			}
		}

		if (!opts.preserveExisting) {
			this.#streamPrefixText = undefined;
			this.#streamPrefixTokens = undefined;
			this.#streamPrefixLineCache = undefined;
		}
	}

	render(width: number): readonly string[] {
		if (this.#tableLayoutWidth !== undefined && this.#tableLayoutWidth !== width) {
			this.#clearTableLayouts();
			this.invalidate();
		}
		this.#tableLayoutWidth = width;
		// L1: per-instance cache — fastest path for repeated renders of the same
		// instance at the same width (e.g. resize debounce, repeated redraws).
		// Returning the cached reference is load-bearing: parents memoize their
		// concatenation on reference equality.
		if (this.#cachedLines && this.#cachedText === this.#text && this.#cachedWidth === width) {
			return this.#cachedLines;
		}

		// Recomputed below by the streaming path; every other path (cache-served,
		// empty text, non-streaming full render) exposes no settled rows.
		this.#lastRenderSettledRows = 0;

		// Calculate available width for content (subtract horizontal padding)
		const paddingX = this.#ignoreTight ? this.#paddingX : getPaddingX(this.#paddingX);
		const contentWidth = Math.max(1, width - paddingX * 2);

		// Don't render anything if there's no actual text
		if (!this.#text || this.#text.trim() === "") {
			this.#cachedText = this.#text;
			this.#cachedWidth = width;
			this.#cachedLines = EMPTY_RENDER_LINES;
			return EMPTY_RENDER_LINES;
		}

		// Replace tabs with 3 spaces for consistent rendering
		const normalizedText = replaceTabs(this.#text);
		const signature = this.#renderSignature(width, paddingX);

		// L2: module-level LRU — survives component disposal/recreation across
		// session-tree navigations. Key encodes every dimension that affects the
		// render output so different configurations never collide.
		// Encode terminal capability state and theme/style function output samples
		// so that capability shifts (image protocol changes, hyperlink toggle) or
		// caller-supplied theme/bgColor functions that mutate their output without
		// changing object identity invalidate the cache entry.
		// bgColor probe uses \x01 (single non-printable byte): chalk/ANSI wrappers
		// pass arbitrary bytes through verbatim, so this is safe and minimizes the
		// risk of clashing with a function that returns text verbatim.
		// theme.heading is used as the representative theme probe — it's required
		// by MarkdownTheme and is one of the most styling-sensitive entries.
		let cacheKey: string | undefined;
		if (!this.transientRenderCache && this.#lockedTableLayouts.size === 0) {
			cacheKey = this.#renderCacheKey(normalizedText, signature);
			const cached = renderCache.get(cacheKey);
			if (cached !== undefined) {
				// Restore both the rendered rows and the geometry metadata that produced
				// them. A later scrollback publication must never lock widths from an
				// older transient frame against rows served from this cache entry.
				this.#lastRenderedTableLayouts = cached.tables.map(table => ({
					...table,
					columnWidths: table.columnWidths.slice(),
				}));
				// Populate L1 so subsequent calls from this instance are O(1) map lookup.
				this.#cachedText = this.#text;
				this.#cachedWidth = width;
				this.#cachedLines = cached.lines;
				return cached.lines;
			}
		}

		// Parse markdown to HTML-like tokens
		const tokens = this.#lexTokens(normalizedText);
		let contentLines: string[];
		const tableRenderSpecs: TableRenderSpec[] = [];
		this.#activeTableRenderSpecs = tableRenderSpecs;
		this.#activeRenderSignature = signature;
		try {
			contentLines = this.transientRenderCache
				? this.#renderStreamingContentLines(tokens, normalizedText, signature, contentWidth)
				: this.#renderContentLines(tokens, 0, tokens.length, contentWidth, signature, 0, 0);
		} finally {
			this.#activeRenderSignature = undefined;
			this.#activeTableRenderSpecs = undefined;
		}
		this.#lastRenderedTableLayouts = this.#resolveRenderedTableLayouts(tableRenderSpecs, signature.paddingY);
		const emptyLines = this.#renderEmptyPaddingLines(signature);

		// Combine top padding, content, and bottom padding
		const rawResult = [...emptyLines, ...contentLines, ...emptyLines];
		const result = rawResult.length > 0 ? rawResult : [""];

		// Update caches and hand the array out by reference. Callers must not
		// mutate it (Component render contract); the L2 entry is shared across
		// instances keyed on identical inputs.
		this.#cachedText = this.#text;
		this.#cachedWidth = width;
		this.#cachedLines = result;

		// Update L2 module-level LRU so future instances with the same key skip
		// the marked.lexer + highlightCode (Rust FFI) work entirely.
		if (cacheKey !== undefined) {
			renderCache.set(cacheKey, {
				lines: result,
				tables: this.#lastRenderedTableLayouts.map(table => ({
					...table,
					columnWidths: table.columnWidths.slice(),
				})),
			});
		}

		return result;
	}

	#renderSignature(width: number, paddingX: number): RenderSignature {
		const bgColorProbe = this.#defaultTextStyle?.bgColor ? this.#defaultTextStyle.bgColor("\x01") : "";
		const headingProbe = this.#theme.heading("");
		return {
			width,
			paddingX,
			paddingY: this.#paddingY,
			codeBlockIndent: this.#codeBlockIndent,
			themeId: objectId(this.#theme),
			defaultTextStyleId: this.#defaultTextStyle ? objectId(this.#defaultTextStyle) : -1,
			imageProtocol: TERMINAL.imageProtocol ?? "",
			hyperlinks: TERMINAL.hyperlinks,
			textSizing: TERMINAL.textSizing,
			bgColorProbe,
			headingProbe,
		};
	}

	#renderCacheKey(normalizedText: string, signature: RenderSignature): string {
		return `${normalizedText}\x00${signature.width}\x00${signature.paddingX}\x00${signature.paddingY}\x00${signature.codeBlockIndent}\x00${signature.themeId}\x00${signature.defaultTextStyleId}\x00${signature.imageProtocol}\x00${signature.hyperlinks ? 1 : 0}\x00${signature.textSizing ? 1 : 0}\x00${signature.bgColorProbe}\x00${signature.headingProbe}`;
	}

	#renderStreamingContentLines(
		tokens: Token[],
		normalizedText: string,
		signature: RenderSignature,
		contentWidth: number,
	): string[] {
		const frozenText = this.#streamPrefixText;
		const frozenTokenCount = this.#streamPrefixTokens?.length ?? 0;
		if (frozenText === undefined || frozenTokenCount === 0 || !normalizedText.startsWith(frozenText)) {
			return this.#renderContentLines(tokens, 0, tokens.length, contentWidth, signature, 0, 0);
		}

		const contentLines: string[] = [];
		const reusablePrefix = this.#matchingStreamPrefixLineCache(normalizedText, frozenText, signature);
		let renderedUntil = 0;
		let renderedSourceOffset = 0;
		if (reusablePrefix && reusablePrefix.tokenCount <= frozenTokenCount) {
			contentLines.push(...reusablePrefix.lines);
			this.#activeTableRenderSpecs?.push(...reusablePrefix.tables);
			renderedUntil = reusablePrefix.tokenCount;
			renderedSourceOffset = reusablePrefix.text.length;
		}

		if (renderedUntil < frozenTokenCount) {
			// Frozen tokens render with full fidelity (syntax highlighting on)
			// so these cached rows byte-match the finalized render.
			this.#renderingFrozenPrefix = true;
			try {
				contentLines.push(
					...this.#renderContentLines(
						tokens,
						renderedUntil,
						frozenTokenCount,
						contentWidth,
						signature,
						contentLines.length,
						renderedSourceOffset,
					),
				);
			} finally {
				this.#renderingFrozenPrefix = false;
			}
			renderedUntil = frozenTokenCount;
		}

		this.#streamPrefixLineCache = {
			...signature,
			text: frozenText,
			tokenCount: frozenTokenCount,
			lines: contentLines.slice(),
			tables: this.#activeTableRenderSpecs?.slice() ?? [],
		};

		// Settled exposure (hard-monotone): these rows are declared final to
		// the host, so expose them only while the frozen text still extends
		// the previously exposed prefix; a rewind resets to 0 and re-earns on
		// the rewritten lineage.
		if (contentLines.length > 0) {
			if (this.#settledExposedText === undefined || frozenText.startsWith(this.#settledExposedText)) {
				this.#settledExposedText = frozenText;
				this.#lastRenderSettledRows = signature.paddingY + contentLines.length;
			} else {
				this.#settledExposedText = undefined;
			}
		}

		if (renderedUntil < tokens.length) {
			contentLines.push(
				...this.#renderContentLines(
					tokens,
					renderedUntil,
					tokens.length,
					contentWidth,
					signature,
					contentLines.length,
					frozenText.length,
				),
			);
		}

		return contentLines;
	}

	#matchingStreamPrefixLineCache(
		normalizedText: string,
		frozenText: string,
		signature: RenderSignature,
	): StreamPrefixLineCache | undefined {
		const cache = this.#streamPrefixLineCache;
		if (!cache) return undefined;
		if (!normalizedText.startsWith(cache.text) || !frozenText.startsWith(cache.text)) return undefined;
		if (cache.width !== signature.width) return undefined;
		if (cache.paddingX !== signature.paddingX) return undefined;
		if (cache.paddingY !== signature.paddingY) return undefined;
		if (cache.codeBlockIndent !== signature.codeBlockIndent) return undefined;
		if (cache.themeId !== signature.themeId) return undefined;
		if (cache.defaultTextStyleId !== signature.defaultTextStyleId) return undefined;
		if (cache.imageProtocol !== signature.imageProtocol) return undefined;
		if (cache.hyperlinks !== signature.hyperlinks) return undefined;
		if (cache.textSizing !== signature.textSizing) return undefined;
		if (cache.bgColorProbe !== signature.bgColorProbe) return undefined;
		if (cache.headingProbe !== signature.headingProbe) return undefined;
		return cache;
	}

	#renderContentLines(
		tokens: Token[],
		start: number,
		end: number,
		contentWidth: number,
		signature: RenderSignature,
		rowOffset: number,
		startingSourceOffset: number,
	): string[] {
		const wrappedLines: string[] = [];
		let sourceOffset = startingSourceOffset;
		for (let i = start; i < end; i++) {
			const token = tokens[i];
			const nextToken = tokens[i + 1];
			const tableSpecStart = this.#activeTableRenderSpecs?.length ?? 0;
			const tokenWrappedRowStart = wrappedLines.length;
			const tokenRowStart = rowOffset + tokenWrappedRowStart;
			const renderedTokenLines = this.#renderToken(
				token,
				contentWidth,
				nextToken?.type,
				undefined,
				`offset:${sourceOffset}`,
			);
			const tokenLineOffsets = [0];
			for (const line of renderedTokenLines) {
				// Skip wrapping for image protocol lines and OSC 66 sized headings
				// (would corrupt escape sequences / split the indivisible sized span).
				if (TERMINAL.isImageLine(line) || isOsc66Line(line)) {
					wrappedLines.push(line);
				} else {
					wrappedLines.push(...wrapTextWithAnsi(line, contentWidth));
				}
				tokenLineOffsets.push(wrappedLines.length - tokenWrappedRowStart);
			}
			const tableSpecs = this.#activeTableRenderSpecs;
			if (tableSpecs !== undefined) {
				for (let specIndex = tableSpecStart; specIndex < tableSpecs.length; specIndex++) {
					const spec = tableSpecs[specIndex]!;
					let relativeStart: number;
					let relativeEnd: number;
					if (token.type === "table") {
						// Exclude the optional inter-block blank from a top-level table's span.
						relativeStart = 0;
						relativeEnd = Math.min(renderedTokenLines.length, spec.lineCount);
					} else {
						// Container renderers express nested table spans relative to their
						// returned lines. Preserve that exact span through this final wrap.
						if (spec.startRow < 0 || spec.endRow <= spec.startRow) continue;
						relativeStart = Math.min(renderedTokenLines.length, spec.startRow);
						relativeEnd = Math.min(renderedTokenLines.length, spec.endRow);
					}
					spec.startRow = tokenRowStart + tokenLineOffsets[relativeStart]!;
					spec.endRow = tokenRowStart + tokenLineOffsets[relativeEnd]!;
				}
			}
			sourceOffset += token.raw.length;
		}

		const leftMargin = padding(signature.paddingX);
		const rightMargin = padding(signature.paddingX);
		const bgFn = this.#defaultTextStyle?.bgColor;
		const contentLines: string[] = [];
		let previousLineWasOsc66 = false;

		for (const line of wrappedLines) {
			// The first empty row after a scale>1 OSC 66 heading is structural:
			// it reserves the lower cells occupied by the multicell glyphs. Do
			// not pad or background-fill it, because real spaces on that row can
			// interact with Kitty's multicell overwrite rules during the first
			// paint. Leave it as a cursor-only newline.
			if (previousLineWasOsc66 && line === "") {
				contentLines.push("");
				previousLineWasOsc66 = false;
				continue;
			}

			// Image lines and OSC 66 sized headings must be output raw - no margins or background
			if (TERMINAL.isImageLine(line) || isOsc66Line(line)) {
				contentLines.push(line);
				previousLineWasOsc66 = isOsc66Line(line);
				continue;
			}

			previousLineWasOsc66 = false;
			const lineWithMargins = leftMargin + line + rightMargin;

			if (bgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, signature.width, bgFn));
			} else {
				// No background - just pad to width
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, signature.width - visibleLen);
				contentLines.push(lineWithMargins + padding(paddingNeeded));
			}
		}

		return contentLines;
	}

	#resolveRenderedTableLayouts(specs: readonly TableRenderSpec[], topPadding: number): RenderedTableLayout[] {
		const layouts: RenderedTableLayout[] = [];
		for (const spec of specs) {
			if (spec.startRow < 0 || spec.endRow <= spec.startRow) continue;
			layouts.push({
				key: spec.key,
				availableWidth: spec.availableWidth,
				columnWidths: spec.columnWidths.slice(),
				startRow: topPadding + spec.startRow,
				endRow: topPadding + spec.endRow,
			});
		}
		return layouts;
	}

	#renderCodeBodyLines(token: Token, codeIndent: string): string[] {
		const bodyLines: string[] = [];
		const tokenText = "text" in token && typeof token.text === "string" ? token.text : "";
		const lang = "lang" in token && typeof token.lang === "string" ? token.lang : undefined;
		const normalizedLang = lang?.toLowerCase();
		const canStreamDiff =
			this.transientRenderCache &&
			!this.#renderingFrozenPrefix &&
			this.#theme.highlightCode &&
			(normalizedLang === "diff" || normalizedLang === "patch" || normalizedLang === "udiff");

		if (this.#theme.highlightCode && (!this.transientRenderCache || this.#renderingFrozenPrefix)) {
			const highlightedLines = this.#theme.highlightCode(tokenText, lang);
			for (const hlLine of highlightedLines) {
				bodyLines.push(`${codeIndent}${hlLine}`);
			}
			return bodyLines;
		}

		if (canStreamDiff) {
			const closedFence = this.#codeTokenHasClosingFence(token);
			const lineEnd = tokenText.lastIndexOf("\n");
			if (closedFence || lineEnd >= 0) {
				const completedText = closedFence ? tokenText : tokenText.slice(0, lineEnd);
				for (const hlLine of this.#highlightStreamingDiffLines(completedText, lang)) {
					bodyLines.push(`${codeIndent}${hlLine}`);
				}
				if (!closedFence) {
					for (const codeLine of tokenText.slice(lineEnd + 1).split("\n")) {
						bodyLines.push(`${codeIndent}${this.#theme.codeBlock(codeLine)}`);
					}
				}
				return bodyLines;
			}
		}

		for (const codeLine of tokenText.split("\n")) {
			bodyLines.push(`${codeIndent}${this.#theme.codeBlock(codeLine)}`);
		}
		return bodyLines;
	}

	#codeTokenHasClosingFence(token: Token): boolean {
		const raw = "raw" in token && typeof token.raw === "string" ? token.raw : "";
		const firstLineEnd = raw.indexOf("\n");
		if (firstLineEnd < 0) return false;
		const openingLine = raw.slice(0, firstLineEnd);
		const openingTrimmed = openingLine.trimStart();
		const openingIndent = openingLine.length - openingTrimmed.length;
		if (openingIndent > 3) return false;
		const fenceChar = openingTrimmed.charAt(0);
		if (fenceChar !== "`" && fenceChar !== "~") return false;
		let fenceLength = 0;
		while (openingTrimmed.charAt(fenceLength) === fenceChar) fenceLength++;
		if (fenceLength < 3) return false;

		let lineStart = firstLineEnd + 1;
		while (lineStart <= raw.length) {
			const lineEnd = raw.indexOf("\n", lineStart);
			const line = lineEnd >= 0 ? raw.slice(lineStart, lineEnd) : raw.slice(lineStart);
			const trimmed = line.trimStart();
			const indent = line.length - trimmed.length;
			let closingLength = 0;
			while (trimmed.charAt(closingLength) === fenceChar) closingLength++;
			if (indent <= 3 && closingLength >= fenceLength && trimmed.slice(closingLength).trim().length === 0) {
				return true;
			}
			if (lineEnd < 0) break;
			lineStart = lineEnd + 1;
		}
		return false;
	}

	#highlightStreamingDiffLines(completedText: string, lang: string | undefined): readonly string[] {
		const highlightCode = this.#theme.highlightCode;
		if (!highlightCode) return [];
		const signature = this.#activeRenderSignature;
		const cache = this.#streamingDiffLineCache;
		if (
			signature &&
			cache &&
			completedText.startsWith(cache.text) &&
			(cache.text.length === completedText.length || completedText.charCodeAt(cache.text.length) === 0x0a) &&
			cache.lang === lang &&
			cache.width === signature.width &&
			cache.paddingX === signature.paddingX &&
			cache.paddingY === signature.paddingY &&
			cache.codeBlockIndent === signature.codeBlockIndent &&
			cache.themeId === signature.themeId &&
			cache.defaultTextStyleId === signature.defaultTextStyleId &&
			cache.imageProtocol === signature.imageProtocol &&
			cache.hyperlinks === signature.hyperlinks &&
			cache.textSizing === signature.textSizing &&
			cache.bgColorProbe === signature.bgColorProbe &&
			cache.headingProbe === signature.headingProbe
		) {
			if (completedText.length === cache.text.length) return cache.lines;
			const lines = cache.lines.slice();
			const addedText = completedText.slice(cache.text.length + 1);
			for (const codeLine of addedText.split("\n")) {
				lines.push(...highlightCode(codeLine, lang));
			}
			this.#streamingDiffLineCache = { ...signature, lang, text: completedText, lines };
			return lines;
		}

		const lines: string[] = [];
		for (const codeLine of completedText.split("\n")) {
			lines.push(...highlightCode(codeLine, lang));
		}
		if (signature) {
			this.#streamingDiffLineCache = { ...signature, lang, text: completedText, lines };
		}
		return lines;
	}

	#renderEmptyPaddingLines(signature: RenderSignature): string[] {
		const emptyLine = padding(signature.width);
		const emptyLines: string[] = [];
		const bgFn = this.#defaultTextStyle?.bgColor;
		for (let i = 0; i < signature.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, signature.width, bgFn) : emptyLine;
			emptyLines.push(line);
		}
		return emptyLines;
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	#applyDefaultStyle(text: string): string {
		if (!this.#defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.#defaultTextStyle.color) {
			styled = this.#defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.#theme
		if (this.#defaultTextStyle.bold) {
			styled = this.#theme.bold(styled);
		}
		if (this.#defaultTextStyle.italic) {
			styled = this.#theme.italic(styled);
		}
		if (this.#defaultTextStyle.strikethrough) {
			styled = this.#theme.strikethrough(styled);
		}
		if (this.#defaultTextStyle.underline) {
			styled = this.#theme.underline(styled);
		}

		return styled;
	}

	#getDefaultStylePrefix(): string {
		if (!this.#defaultTextStyle) {
			return "";
		}

		if (this.#defaultStylePrefix !== undefined) {
			return this.#defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.#defaultTextStyle.color) {
			styled = this.#defaultTextStyle.color(styled);
		}

		if (this.#defaultTextStyle.bold) {
			styled = this.#theme.bold(styled);
		}
		if (this.#defaultTextStyle.italic) {
			styled = this.#theme.italic(styled);
		}
		if (this.#defaultTextStyle.strikethrough) {
			styled = this.#theme.strikethrough(styled);
		}
		if (this.#defaultTextStyle.underline) {
			styled = this.#theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.#defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.#defaultStylePrefix;
	}

	#getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	#getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.#applyDefaultStyle(text),
			stylePrefix: this.#getDefaultStylePrefix(),
		};
	}

	#renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
		tokenKey = "root",
	): string[] {
		const lines: string[] = [];

		// Display math block (own-line `$$…$$` / `\[…\]`): stack `\frac` vertically
		// and keep `\\` row breaks, so fractions and matrices span multiple lines.
		if (isMathToken(token)) {
			for (const mathLine of latexToBlock(token.text)) lines.push(this.#applyDefaultStyle(mathLine));
			if (nextTokenType && nextTokenType !== "space") lines.push("");
			return lines;
		}

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = `${"#".repeat(headingLevel)} `;
				const headingText = this.#renderInlineTokens(token.tokens || [], styleContext);
				const headingPlainText = plainInlineTokens(token.tokens || []);
				let styledHeading: string;
				if (headingLevel === 1 && TERMINAL.textSizing) {
					const plainWidth = visibleWidth(headingPlainText);
					if (plainWidth > 0 && 2 * plainWidth <= width) {
						const sizedHeading = encodeTextSizedHeading(headingPlainText, 2);
						lines.push(this.#theme.heading(this.#theme.bold(this.#theme.underline(sizedHeading))));
						lines.push(""); // reserve the heading's second visual row
						if (nextTokenType && nextTokenType !== "space") {
							lines.push(""); // Add spacing after headings (unless space token follows)
						}
						break;
					}
				}
				if (headingLevel === 1) {
					styledHeading = this.#theme.heading(this.#theme.bold(this.#theme.underline(headingText)));
				} else if (headingLevel === 2) {
					styledHeading = this.#theme.heading(this.#theme.bold(headingText));
				} else {
					styledHeading = this.#theme.heading(this.#theme.bold(headingPrefix + headingText));
				}
				lines.push(styledHeading);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			case "paragraph": {
				const displayMath = soleDisplayMath(token.tokens);
				if (displayMath) {
					for (const mathLine of latexToBlock(displayMath.text)) lines.push(this.#applyDefaultStyle(mathLine));
					if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") lines.push("");
					break;
				}
				const paragraphText = this.#renderInlineTokens(token.tokens || [], styleContext);
				lines.push(...(hangWrapTreeGuideLines(paragraphText, width) ?? [paragraphText]));
				// Don't add spacing if next token is space or list
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "code": {
				// Mermaid diagrams render as ASCII art when the theme supplies a
				// resolver. The art is preformatted, so clip each row to the content
				// width: the later wrap pass would otherwise fragment the box-drawing
				// canvas. truncateToWidth is ANSI- and wide-char-aware, and the
				// resolver already re-fits over-wide horizontal graphs top-down.
				if (token.lang === "mermaid" && this.#theme.resolveMermaidAscii) {
					const ascii = this.#theme.resolveMermaidAscii(token.text, width);
					if (ascii) {
						for (const asciiLine of ascii.split("\n")) {
							lines.push(
								visibleWidth(asciiLine) > width ? truncateToWidth(asciiLine, width, Ellipsis.Omit) : asciiLine,
							);
						}
						if (nextTokenType && nextTokenType !== "space") {
							lines.push("");
						}
						break;
					}
				}

				const codeIndent = padding(this.#codeBlockIndent);
				lines.push(this.#theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
				for (const bodyLine of this.#renderCodeBodyLines(token, codeIndent)) {
					lines.push(bodyLine);
				}
				lines.push(this.#theme.codeBlockBorder("```"));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			case "list": {
				const listLines = this.#renderList(token as ListToken, 0, styleContext);
				lines.push(...listLines);
				// Don't add spacing after lists if a space token follows
				// (the space token will handle it)
				break;
			}

			case "table": {
				const tableLines = this.#renderTable(token as TableToken, width, nextTokenType, styleContext, tokenKey);
				lines.push(...tableLines);
				break;
			}

			case "blockquote": {
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: "",
				};
				const quoteContentWidth = Math.max(1, width - 2);
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: string[] = [];
				const blockquoteSpecStart = this.#activeTableRenderSpecs?.length ?? 0;

				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i];
					const nextQuoteToken = quoteTokens[i + 1];
					const quoteTokenRowStart = renderedQuoteLines.length;
					const quoteSpecStart = this.#activeTableRenderSpecs?.length ?? 0;
					const quoteTokenLines = this.#renderToken(
						quoteToken,
						quoteContentWidth,
						nextQuoteToken?.type,
						quoteInlineStyleContext,
						`${tokenKey}/quote:${i}`,
					);
					renderedQuoteLines.push(...quoteTokenLines);

					const tableSpecs = this.#activeTableRenderSpecs;
					if (tableSpecs !== undefined) {
						for (let specIndex = quoteSpecStart; specIndex < tableSpecs.length; specIndex++) {
							const spec = tableSpecs[specIndex]!;
							if (spec.startRow < 0) {
								// Direct child tables initially have no row coordinates. Their
								// structural line count excludes any inter-block blank.
								spec.startRow = quoteTokenRowStart;
								spec.endRow = quoteTokenRowStart + Math.min(quoteTokenLines.length, spec.lineCount);
							} else {
								// A nested blockquote already mapped the table into its own
								// returned rows; translate those rows into this quote's input.
								spec.startRow += quoteTokenRowStart;
								spec.endRow += quoteTokenRowStart;
							}
						}
					}
				}

				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
				}

				const quoteRowOffsets: number[] = [];
				const borderedQuoteLines = this.#applyQuoteBorder(renderedQuoteLines, width, quoteRowOffsets);
				const tableSpecs = this.#activeTableRenderSpecs;
				if (tableSpecs !== undefined) {
					for (let specIndex = blockquoteSpecStart; specIndex < tableSpecs.length; specIndex++) {
						const spec = tableSpecs[specIndex]!;
						if (spec.startRow < 0 || spec.endRow <= spec.startRow) continue;
						const relativeStart = Math.min(renderedQuoteLines.length, spec.startRow);
						const relativeEnd = Math.min(renderedQuoteLines.length, spec.endRow);
						spec.startRow = quoteRowOffsets[relativeStart]!;
						spec.endRow = quoteRowOffsets[relativeEnd]!;
					}
				}
				lines.push(...borderedQuoteLines);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			case "hr": {
				const raw = "raw" in token && typeof token.raw === "string" ? token.raw.trim() : "";
				lines.push(this.#renderHrLine(width, raw[0] || ""));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after horizontal rules (unless space token follows)
				}
				break;
			}

			case "html":
				if ("raw" in token && typeof token.raw === "string") {
					lines.push(...this.#renderHtmlBlock(token.raw, width));
				}
				break;

			case "space":
				// Space tokens represent blank lines in markdown
				lines.push("");
				break;

			default:
				// Handle any other token types as plain text
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	/** Render a horizontal rule line themed to `width`, matching `sourceChar` when given. */
	#renderHrLine(width: number, sourceChar = ""): string {
		const fillChar = getHrChar(sourceChar, this.#theme.symbols.hrChar);
		return this.#theme.hr(fillChar.repeat(Math.min(width, 80)));
	}

	/**
	 * Wrap already-rendered lines in the blockquote border and quote styling.
	 * `width` is the full content width; the border reserves two cells.
	 */
	#applyQuoteBorder(renderedLines: string[], width: number, sourceRowOffsets?: number[]): string[] {
		const quoteStyle = (text: string) => this.#theme.quote(this.#theme.italic(text));
		const quoteStylePrefix = this.#getStylePrefix(quoteStyle);
		const applyQuoteStyle = (line: string): string => {
			if (!quoteStylePrefix) {
				return quoteStyle(line);
			}
			const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
			return quoteStyle(lineWithReappliedStyle);
		};
		const quoteContentWidth = Math.max(1, width - 2);
		const lines: string[] = [];
		sourceRowOffsets?.push(0);
		for (const quoteLine of renderedLines) {
			const styledLine = applyQuoteStyle(quoteLine);
			for (const wrappedLine of wrapTextWithAnsi(styledLine, quoteContentWidth)) {
				lines.push(this.#theme.quoteBorder(`${this.#theme.symbols.quoteBorder} `) + wrappedLine);
			}
			sourceRowOffsets?.push(lines.length);
		}
		return lines;
	}

	/**
	 * Render a block-level `html` token to styled lines. Standalone `<hr>` tags
	 * become rules and balanced `<blockquote>…</blockquote>` regions render with
	 * quote styling; the remaining markup is normalized to terminal text (entities
	 * decoded, `<code>` themed, lists/`<br>`/`<p>` laid out).
	 */
	#renderHtmlBlock(raw: string, width: number): string[] {
		const lines: string[] = [];
		const state = createHtmlNormalizationState();
		const codeHook = (text: string): string => this.#theme.code(text) + this.#getDefaultStylePrefix();
		const flushText = (chunk: string): void => {
			const cleaned = normalizeHtmlForTerminal(chunk, state, codeHook);
			if (cleaned.trim() === "") return;
			for (const line of splitTerminalLines(cleaned)) {
				const trimmed = line.trimEnd();
				lines.push(trimmed.trim() === "" ? "" : this.#applyDefaultStyle(trimmed));
			}
		};
		let lastIndex = 0;
		BLOCK_HTML_REGEX.lastIndex = 0;
		for (let match = BLOCK_HTML_REGEX.exec(raw); match !== null; match = BLOCK_HTML_REGEX.exec(raw)) {
			flushText(raw.slice(lastIndex, match.index));
			lastIndex = match.index + match[0].length;
			if (match[1] !== undefined) {
				lines.push(...this.#renderHtmlBlockquote(match[1], width));
			} else {
				lines.push(this.#renderHrLine(width));
			}
		}
		flushText(raw.slice(lastIndex));
		return lines;
	}

	/** Render the inner content of an HTML `<blockquote>` with quote styling. */
	#renderHtmlBlockquote(inner: string, width: number): string[] {
		const cleaned = normalizeHtmlForTerminal(inner, createHtmlNormalizationState(), text => this.#theme.code(text));
		const innerLines = splitTerminalLines(cleaned).map(line => line.trimEnd());
		while (innerLines.length > 0 && innerLines[innerLines.length - 1] === "") innerLines.pop();
		return this.#applyQuoteBorder(innerLines, width);
	}

	#renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.#getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = text.split("\n");
			return segments.map((segment: string) => (segment === "" ? "" : applyText(segment))).join("\n");
		};
		const swatchGlyph = this.#theme.symbols.colorSwatch || DEFAULT_COLOR_SWATCH_GLYPH;
		let trimLeadingWhitespace = false;
		const htmlState = createHtmlNormalizationState();
		const markHtmlItemWhenContent = (text: string): void => {
			markCurrentHtmlItemContent(htmlState, text);
		};

		for (const token of collapseInlineHtml(tokens)) {
			if (isMathToken(token)) {
				markHtmlItemWhenContent(token.text);
				result += applyTextWithNewlines(renderMathToken(token.text));
				continue;
			}
			switch (token.type) {
				case "text": {
					const rawText = trimLeadingWhitespace ? token.text.replace(/^\s+/, "") : token.text;
					const text = normalizeHtmlEntitiesForTerminal(rawText);
					trimLeadingWhitespace = false;
					markHtmlItemWhenContent(text);
					if (token.tokens) markHtmlItemWhenContent(plainInlineTokens(token.tokens));
					// Text tokens in list items can have nested tokens for inline formatting
					if (token.tokens && token.tokens.length > 0) {
						result += this.#renderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += renderTextWithSwatches(text, applyTextWithNewlines, swatchGlyph);
					}
					break;
				}

				case "paragraph":
					// Paragraph tokens contain nested inline tokens
					markHtmlItemWhenContent(plainInlineTokens(token.tokens || []));
					result += this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				case "strong": {
					markHtmlItemWhenContent(plainInlineTokens(token.tokens || []));
					const boldContent = this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.#theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					markHtmlItemWhenContent(plainInlineTokens(token.tokens || []));
					result += this.#theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan": {
					markHtmlItemWhenContent(token.text);
					result += codespanSwatch(token.text, swatchGlyph) + this.#theme.code(token.text) + stylePrefix;
					break;
				}

				case "link": {
					markHtmlItemWhenContent(token.text);
					const linkText = this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					const styledLinkText = this.#theme.link(this.#theme.underline(linkText));
					const clickableLinkText = formatHyperlink(styledLinkText, token.href);
					// If link text matches href, only show the link once
					// Compare raw text (token.text) not styled text (linkText) since linkText has ANSI codes
					// For mailto: links, strip the prefix before comparing (autolinked emails have
					// text="foo@bar.com" but href="mailto:foo@bar.com")
					const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
					if (token.text === token.href || token.text === hrefForComparison)
						result += clickableLinkText + stylePrefix;
					else {
						const styledLinkUrl = this.#theme.linkUrl(` (${token.href})`);
						result += clickableLinkText + formatHyperlink(styledLinkUrl, token.href) + stylePrefix;
					}
					break;
				}

				case "br":
					result += "\n";
					trimLeadingWhitespace = true;
					break;

				case "del": {
					const delContent = this.#renderInlineTokens(token.tokens || [], resolvedStyleContext);
					markHtmlItemWhenContent(plainInlineTokens(token.tokens || []));
					result += this.#theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					if ("raw" in token && typeof token.raw === "string") {
						const cleaned = normalizeHtmlForTerminal(token.raw, htmlState);
						result += applyTextWithNewlines(cleaned);
						if (cleaned.endsWith("\n")) {
							trimLeadingWhitespace = true;
						} else if (cleaned.length > 0) {
							trimLeadingWhitespace = false;
						}
					}
					break;

				default:
					// Handle any other inline token types as plain text
					if ("text" in token && typeof token.text === "string") {
						const rawText = trimLeadingWhitespace ? token.text.replace(/^\s+/, "") : token.text;
						const text = normalizeHtmlEntitiesForTerminal(rawText);
						trimLeadingWhitespace = false;
						markHtmlItemWhenContent(text);
						result += applyTextWithNewlines(text);
					}
			}
		}

		// Strip dangling re-opened-default SGR prefix left over from the last inline
		// token (strong/em/codespan/link/del/etc.) so the emitted line self-terminates
		// at its last styled segment instead of carrying an unmatched SGR open into
		// the next line. Matches upstream behavior.
		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	/**
	 * Render a list with proper nesting support
	 */
	#renderList(token: ListToken, depth: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		const indent = "  ".repeat(depth);
		// Use the list's start property (defaults to 1 for ordered lists)
		const startNumber = token.start ?? 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const bullet = token.ordered ? `${startNumber + i}. ` : "- ";
			// Continuation rows align under the item text, so the hang matches the
			// actual bullet width (`10. ` is 4 cells, not 2).
			const continuationIndent = indent + padding(bullet.length);

			// Process item tokens; nested-list lines arrive structurally tagged and
			// already carry their own full indent.
			const itemLines = this.#renderListItem(item.tokens || [], depth, styleContext);

			if (itemLines.length > 0) {
				const firstLine = itemLines[0]!;
				if (firstLine.nested) {
					// Nested list first - keep as-is (already has full indent)
					lines.push(firstLine.text);
				} else {
					// Regular text content - add indent and bullet
					lines.push(indent + this.#theme.listBullet(bullet) + firstLine.text);
				}

				// Rest of the lines
				for (let j = 1; j < itemLines.length; j++) {
					const line = itemLines[j]!;
					if (line.nested) {
						// Nested list line - already has full indent
						lines.push(line.text);
					} else {
						// Regular content - hang under the item text
						lines.push(continuationIndent + line.text);
					}
				}
			} else {
				lines.push(indent + this.#theme.listBullet(bullet));
			}
		}

		return lines;
	}

	/**
	 * Render list item tokens, handling nested lists.
	 * Returns lines WITHOUT the parent indent (renderList adds it); lines that
	 * belong to a nested list are tagged `nested` so the caller never has to
	 * sniff theme-dependent ANSI bytes to recognize them.
	 */
	#renderListItem(
		tokens: Token[],
		parentDepth: number,
		styleContext?: InlineStyleContext,
	): Array<{ text: string; nested: boolean }> {
		const lines: Array<{ text: string; nested: boolean }> = [];

		for (const token of tokens) {
			if (token.type === "list") {
				// Nested list - render with one additional indent level
				// These lines carry their own indent, so tag them for pass-through
				const nestedLines = this.#renderList(token as ListToken, parentDepth + 1, styleContext);
				for (const nestedLine of nestedLines) {
					lines.push({ text: nestedLine, nested: true });
				}
			} else if (token.type === "text") {
				// Text content (may have inline tokens, or a sole display-math token)
				const displayMath = soleDisplayMath(token.tokens);
				if (displayMath) {
					const apply = styleContext?.applyText ?? ((t: string) => this.#applyDefaultStyle(t));
					for (const mathLine of latexToBlock(displayMath.text))
						lines.push({ text: apply(mathLine), nested: false });
				} else {
					const text =
						token.tokens && token.tokens.length > 0
							? this.#renderInlineTokens(token.tokens, styleContext)
							: token.text || "";
					lines.push({ text, nested: false });
				}
			} else if (token.type === "paragraph") {
				// Paragraph in list item
				const apply = styleContext?.applyText ?? ((t: string) => this.#applyDefaultStyle(t));
				const displayMath = soleDisplayMath(token.tokens);
				if (displayMath) {
					for (const mathLine of latexToBlock(displayMath.text))
						lines.push({ text: apply(mathLine), nested: false });
				} else {
					lines.push({ text: this.#renderInlineTokens(token.tokens || [], styleContext), nested: false });
				}
			} else if (token.type === "code") {
				// Code block in list item
				const codeIndent = padding(this.#codeBlockIndent);
				lines.push({ text: this.#theme.codeBlockBorder(`\`\`\`${token.lang || ""}`), nested: false });
				for (const bodyLine of this.#renderCodeBodyLines(token, codeIndent)) {
					lines.push({ text: bodyLine, nested: false });
				}
				lines.push({ text: this.#theme.codeBlockBorder("```"), nested: false });
			} else if (isMathToken(token)) {
				// Display math block inside a list item: stack fractions / matrix rows.
				const apply = styleContext?.applyText ?? ((t: string) => this.#applyDefaultStyle(t));
				for (const mathLine of latexToBlock(token.text)) lines.push({ text: apply(mathLine), nested: false });
			} else {
				// Other token types - try to render as inline
				const text = this.#renderInlineTokens([token], styleContext);
				if (text) {
					lines.push({ text, nested: false });
				}
			}
		}

		return lines;
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	#getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter(word => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	#terminalLineWidths(text: string): number[] {
		return splitTerminalLines(text).map(line => visibleWidth(line));
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	#wrapCellText(text: string, maxWidth: number): string[] {
		const cellWidth = Math.max(1, maxWidth);
		return splitTerminalLines(text).flatMap(line => wrapTextWithAnsi(line, cellWidth));
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	#renderTable(
		token: TableToken,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
		tableKey = "table",
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		// Calculate natural column widths (what each column needs without constraints)
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.#renderInlineTokens(token.header[i].tokens || [], styleContext);
			const headerLineWidths = this.#terminalLineWidths(headerText);
			naturalWidths[i] = Math.max(...headerLineWidths, 0);
			minWordWidths[i] = Math.max(1, this.#getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.#renderInlineTokens(row[i].tokens || [], styleContext);
				const cellLineWidths = this.#terminalLineWidths(cellText);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, ...cellLineWidths);
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.#getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map(width => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		// Calculate column widths that fit within available width
		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			// Everything fits naturally
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
		} else {
			// Need to shrink columns to fit
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index];
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// Adjust for rounding errors - distribute remaining space
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i] < naturalWidths[i]) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		const lockedLayout = this.#lockedTableLayouts.get(tableKey);
		if (
			lockedLayout !== undefined &&
			lockedLayout.availableWidth === availableWidth &&
			lockedLayout.columnWidths.length === numCols &&
			lockedLayout.columnWidths.every(width => Number.isFinite(width) && width >= 1) &&
			lockedLayout.columnWidths.reduce((total, width) => total + width, borderOverhead) <= availableWidth
		) {
			columnWidths = lockedLayout.columnWidths.slice();
		}

		const t = this.#theme.symbols.table;
		const h = t.horizontal;
		const v = t.vertical;

		// Render top border
		const topBorderCells = columnWidths.map(w => h.repeat(w));
		lines.push(`${t.topLeft}${h}${topBorderCells.join(`${h}${t.teeDown}${h}`)}${h}${t.topRight}`);

		// Render header with wrapping
		const headerCellLines: string[][] = token.header.map((cell, i) => {
			const text = this.#renderInlineTokens(cell.tokens || [], styleContext);
			return this.#wrapCellText(text, columnWidths[i]);
		});
		const headerLineCount = Math.max(...headerCellLines.map(c => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				const padded = text + padding(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				return this.#theme.bold(padded);
			});
			lines.push(`${v} ${rowParts.join(` ${v} `)} ${v}`);
		}

		// Render separator
		const separatorCells = columnWidths.map(w => h.repeat(w));
		const separatorLine = `${t.teeRight}${h}${separatorCells.join(`${h}${t.cross}${h}`)}${h}${t.teeLeft}`;
		lines.push(separatorLine);

		// Render rows with wrapping
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCellLines: string[][] = row.map((cell, i) => {
				const text = this.#renderInlineTokens(cell.tokens || [], styleContext);
				return this.#wrapCellText(text, columnWidths[i]);
			});
			const rowLineCount = Math.max(...rowCellLines.map(c => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + padding(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				});
				lines.push(`${v} ${rowParts.join(` ${v} `)} ${v}`);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		// Render bottom border
		const bottomBorderCells = columnWidths.map(w => h.repeat(w));
		const bottomBorder = `${t.bottomLeft}${h}${bottomBorderCells.join(`${h}${t.teeUp}${h}`)}${h}${t.bottomRight}`;
		lines.push(bottomBorder);
		this.#activeTableRenderSpecs?.push({
			key: tableKey,
			availableWidth,
			columnWidths: columnWidths.slice(),
			lineCount: lines.length,
			startRow: -1,
			endRow: -1,
		});

		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // Add spacing after table
		}
		return lines;
	}
}

/**
 * Render inline markdown (bold, italic, code, links, strikethrough) to a styled string.
 * Unlike the full Markdown component, this produces a single line with no block-level elements.
 */
export function renderInlineMarkdown(text: string, mdTheme: MarkdownTheme, baseColor?: (t: string) => string): string {
	// Guard against undefined/null during streaming — partial JSON can leave fields unpopulated.
	if (typeof text !== "string") return (baseColor ?? (t => t))(text != null ? String(text) : "");
	const tokens = markdownParser.lexer(text);
	const applyText = baseColor ?? ((t: string) => t);
	let result = "";
	for (const token of tokens) {
		if (isMathToken(token)) {
			result += applyText(renderMathToken(token.text));
			continue;
		}
		if (token.type === "paragraph" && token.tokens) {
			result += renderInlineTokens(token.tokens, mdTheme, applyText);
		} else if (token.type === "list") {
			result += token.items
				.map((item: Tokens.ListItem, index: number) => {
					const prefix = token.ordered ? `${(token.start || 1) + index}. ` : "• ";
					const content = item.tokens ? renderInlineTokens(item.tokens, mdTheme, applyText) : applyText(item.text);
					return `${applyText(prefix)}${content}`;
				})
				.join(applyText(" "));
		} else if ("text" in token && typeof token.text === "string") {
			result += applyText(normalizeHtmlEntitiesForTerminal(token.text));
		}
	}
	return result;
}

function renderInlineTokens(tokens: Token[], mdTheme: MarkdownTheme, applyText: (t: string) => string): string {
	let result = "";
	const styleReset = applyText("");
	for (const token of collapseInlineHtml(tokens)) {
		if (isMathToken(token)) {
			result += applyText(renderMathToken(token.text));
			continue;
		}
		switch (token.type) {
			case "text":
				if (token.tokens && token.tokens.length > 0) {
					result += renderInlineTokens(token.tokens, mdTheme, applyText);
				} else {
					result += applyText(normalizeHtmlEntitiesForTerminal(token.text));
				}
				break;
			case "strong":
				result += mdTheme.bold(renderInlineTokens(token.tokens || [], mdTheme, applyText)) + styleReset;
				break;
			case "em":
				result += mdTheme.italic(renderInlineTokens(token.tokens || [], mdTheme, applyText)) + styleReset;
				break;
			case "codespan":
				result += mdTheme.code(token.text) + styleReset;
				break;
			case "del":
				result += mdTheme.strikethrough(renderInlineTokens(token.tokens || [], mdTheme, applyText)) + styleReset;
				break;
			case "link": {
				const linkText = renderInlineTokens(token.tokens || [], mdTheme, applyText);
				result += mdTheme.link(mdTheme.underline(linkText)) + styleReset;
				break;
			}
			case "html":
				if ("raw" in token && typeof token.raw === "string") {
					result += applyText(normalizeHtmlForTerminal(token.raw));
				}
				break;
			default:
				if ("text" in token && typeof token.text === "string") {
					result += applyText(normalizeHtmlEntitiesForTerminal(token.text));
				}
				break;
		}
	}
	return result;
}
