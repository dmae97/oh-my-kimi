/**
 * Core hash utilities shared by hashline edit mode, read/search output,
 * and prompt helpers.
 */

import bigrams from "./bigrams.json" with { type: "json" };

/**
 * 647 single-token BPE bigrams for hashline anchors. Every entry tokenizes as
 * exactly one token in modern BPE vocabularies (cl100k / o200k / Claude family),
 * so a hashline anchor built from one bigram is exactly 1 token.
 *
 * This is the complete set of 2-letter lowercase combinations that are single
 * tokens — the 29 missing combinations are rare-letter pairs (q/x/z heavy)
 * that no major BPE vocabulary merges into a single token.
 *
 * Order is stable forever — changing it would invalidate every saved
 * `LINE+ID` reference in transcripts and prompts.
 */
export const HL_BIGRAMS: readonly string[] = bigrams;

export const HL_BIGRAMS_COUNT = HL_BIGRAMS.length;

/**
 * Decoration prefix that may precede a `LINE+HASH` anchor in tool output:
 * `>` (context line in grep), `+` (added line in diff), `-` (removed line),
 * `*` (match line). Any combination, in any order, surrounded by optional
 * whitespace. Output formatters emit at most one decoration per anchor; the
 * regex stays liberal because anchor-ref parsers accept whatever the model
 * echoes back.
 */
export const HL_ANCHOR_DECORATION_RE_RAW = `\\s*[>+\\-*]*\\s*`;

/**
 * Capture-group regex source for a decorated `LINE+HASH` anchor. Group 1
 * captures the line number (digits only); group 2 captures the hash. The
 * source is intentionally unanchored — anchoring with `^` (or composing into a
 * larger pattern) is the caller's responsibility.
 */
export const HL_ANCHOR_RE_RAW = `${HL_ANCHOR_DECORATION_RE_RAW}(\\d+)([a-z]{2})`;

/**
 * Bare `LINE+HASH` Lid (no decorations, no captures, no anchors). Use for
 * embedding inside larger patterns where the line+hash unit appears as a
 * literal (e.g. range bounds, alternation arms, op-line heuristics).
 */
export const HL_HASH_RE_RAW = `[1-9]\\d*[a-z]{2}`;

/**
 * Capture-group form of {@link HL_HASH_RE_RAW}: group 1 captures the
 * line number, group 2 captures the hash.
 */
export const HL_HASH_CAPTURE_RE_RAW = `([1-9]\\d*)([a-z]{2})`;

/** Width of a hash in display characters. */
export const HL_HASH_WIDTH = 2;

/**
 * Representative hash suffixes for use in user-facing error messages and
 * prompt examples.
 */
export const HL_HASH_EXAMPLES = ["sr", "ab", "th"] as const;

/**
 * Format a comma-separated list of example anchors with an optional line-number
 * prefix, quoted for inclusion in error messages: `"160sr", "160ab", "160th"`.
 */
export function describeAnchorExamples(linePrefix = ""): string {
	return HL_HASH_EXAMPLES.map(e => `"${linePrefix}${e}"`).join(", ");
}

/**
 * Substitute every grammar placeholder with the value derived from its
 * TypeScript counterpart. Grammars that don't reference these placeholders
 * pass through unchanged.
 */
export function resolveHashlineGrammarPlaceholders(grammar: string): string {
	return grammar.replaceAll("$HFMT$", "[a-z]{2}").replaceAll("$HSEP$", JSON.stringify(HL_EDIT_SEP));
}

/** @deprecated Use {@link resolveHashlineGrammarPlaceholders}. */
export const resolveLarkLidPlaceholders = resolveHashlineGrammarPlaceholders;

const regexEscape = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Single source of truth for the hashline edit payload separator. This is the
 * configured separator that starts inserted/replacement payload lines in
 * hashline edit input (`<separator>TEXT`) and separates inline modify ops from
 * their appended/prepended text.
 *
 * Override at runtime with the `PI_HL_SEP` env var (e.g.
 * `PI_HL_SEP=">"`, `PI_HL_SEP="\\"`). The value is read once at module load;
 * the edit grammar, prompt helper, and edit parser derive from it.
 *
 * Default is `~`, chosen empirically. Benchmark across 8 candidate separators
 * x 3 models (glm-4.7:nitro, gpt-5.4-nano, claude-sonnet-4-6), 24-48 runs per
 * cell, hashline variant, 12 sampled tasks per run:
 *
 *   sep | task ✓ | edit ✓ | patch fail      | tok/run
 *   ----|--------|--------|-----------------|--------
 *    +  | 70.8%  | 78.0%  | 27/125 (21.6%)  | 32,127
 *    ÷  | 70.7%  | 90.6%  | 22/211 (10.4%)  | 31,666
 *    ~  | 69.4%  | 94.9%  |  6/107 ( 5.6%)  | 30,529   <-- default
 *    >  | 69.2%  | 91.5%  | 21/219 ( 9.6%)  | 30,777
 *    :  | 66.7%  | 86.4%  | 20/126 (15.9%)  | 33,900
 *    |  | 65.9%  | 86.9%  | 20/127 (15.7%)  | 34,589
 *    \  | 65.5%  | 89.8%  | 16/124 (12.9%)  | 36,010
 *    %  | 63.9%  | 92.8%  | 11/125 ( 8.8%)  | 36,530
 *
 * `~` wins because:
 *   - highest edit-tool success rate (94.9%) of any tested separator
 *   - lowest patch-failure rate (5.6%) — model rarely emits a malformed payload
 *   - cheapest in tokens alongside `>` (no retry overhead from format collisions)
 *   - no line-leading role in any mainstream language, markdown, diff, regex,
 *     or shell, so payload lines are unambiguous to both the parser and models
 *   - task-success is statistically tied with `>` and `÷` (within run-to-run
 *     noise), so the edit-reliability win is free
 *
 * `+` and `÷` lead on raw task-success but at the cost of ~2-4x more patch
 * failures (the model retries until it lands a valid edit). `:`, `|`, `\`
 * collide with line-leading syntax (label/object-key, body separator, escape)
 * and degrade both edit reliability and intent-match.
 */
export const HL_EDIT_SEP = (() => {
	const sep = process.env.PI_HL_SEP?.trim();
	return sep?.length === 1 ? sep : "~";
})();

/** Regex-escaped form of {@link HL_EDIT_SEP}, safe for regexes. */
export const HL_EDIT_SEP_RE_RAW = regexEscape(HL_EDIT_SEP);

/** Stable separator for read/search/hashline display output. Intentionally not configurable. */
export const HL_BODY_SEP = "|";

/** Regex-escaped form of {@link HL_BODY_SEP}, safe for embedding inside a regex. */
export const HL_BODY_SEP_RE_RAW = regexEscape(HL_BODY_SEP);

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;
const RE_STRUCTURAL_STRIP = /[\s{}]/g;

/**
 * Bigram returned for lines that contain only whitespace and `{`/`}`.
 * Picks the English ordinal suffix for the line number (`1` → `st`,
 * `2` → `nd`, `3` → `rd`, `11`/`12`/`13` → `th`, else `th`) so the
 * line digits + bigram BPE-merge into a single ordinal token (`1st`, `42nd`,
 * `100th`, …). Brace-only lines therefore cost one token for the whole
 * `LINE+ID` anchor instead of two.
 */
function structuralBigram(line: number): string {
	const mod100 = line % 100;
	if (mod100 >= 11 && mod100 <= 13) return "th";
	switch (line % 10) {
		case 1:
			return "st";
		case 2:
			return "nd";
		case 3:
			return "rd";
		default:
			return "th";
	}
}

/**
 * Compute a 2-character hash of a single line via xxHash32 mod 647 over
 * {@link HL_BIGRAMS}. Lines that contain only whitespace and `{`/`}` collapse
 * to an ordinal-suffix bigram (see {@link structuralBigram}) so brace-only
 * structure shares one merged ordinal token (`1st`, `42nd`, `100th`, …).
 * Other lines with no letter or digit mix the line number into the seed so
 * adjacent identical punctuation-only lines get distinct hashes; lines with
 * significant content stay line-number-independent so a line is identifiable
 * across small shifts.
 *
 * The line input should not include a trailing newline.
 */
export function computeLineHash(idx: number, line: string): string {
	line = line.replace(/\r/g, "").trimEnd();
	if (line.replace(RE_STRUCTURAL_STRIP, "").length === 0) {
		return structuralBigram(idx);
	}
	const seed = RE_SIGNIFICANT.test(line) ? 0 : idx;
	return HL_BIGRAMS[Bun.hash.xxHash32(line, seed) % HL_BIGRAMS_COUNT];
}

/**
 * Formats an anchor reference given a line number and its text.
 * Returns `LINE+ID` (e.g., `42sr`) — no separator between
 * number and hash.
 */
export function formatLineHash(line: number, lines: string): string {
	return `${line}${computeLineHash(line, lines)}`;
}

/**
 * Formats a single line with a hashline anchor.
 * Returns `LINE+ID|TEXT` (e.g., `42sr|function hi() {`, `3ab|}`).
 */
export function formatHashLine(lineNumber: number, line: string): string {
	return `${lineNumber}${computeLineHash(lineNumber, line)}${HL_BODY_SEP}${line}`;
}

/**
 * Format file text with hashline prefixes for display.
 *
 * Each line becomes `LINE+ID|TEXT` where LINENUM is 1-indexed.
 * No padding on line numbers; pipe separator between anchor and content.
 *
 * @param text - Raw file text string
 * @param startLine - First line number (1-indexed, defaults to 1)
 * @returns Formatted string with one hashline-prefixed line per input line
 *
 * @example
 * ```
 * formatHashLines("function hi() {\n  return;\n}")
 * // "1bm|function hi() {\n2er|  return;\n3ab|}"
 * ```
 */
export function formatHashLines(text: string, startLine = 1): string {
	const lines = text.split("\n");
	return lines.map((line, i) => formatHashLine(startLine + i, line)).join("\n");
}
