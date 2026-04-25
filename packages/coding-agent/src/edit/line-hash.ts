/**
 * Lightweight line-hash utilities extracted from hashline.ts to avoid
 * circular dependencies (prompt-templates → hashline → tools → edit).
 */

/**
 * 40 common English BPE bigrams. Each entry tokenizes as a single token in
 * modern BPE vocabularies (cl100k / o200k / Claude family), so a hashline anchor
 * built from one bigram is exactly 1 token.
 *
 * Order is stable forever — changing it would invalidate every saved
 * `LINE#ID` reference in transcripts and prompts.
 */
export const HASHLINE_BIGRAMS = [
	"th",
	"he",
	"in",
	"er",
	"an",
	"re",
	"on",
	"at",
	"en",
	"nd",
	"ti",
	"es",
	"or",
	"te",
	"of",
	"ed",
	"is",
	"it",
	"al",
	"ar",
	"st",
	"to",
	"nt",
	"ng",
	"se",
	"ha",
	"as",
	"ou",
	"io",
	"le",
	"ve",
	"co",
	"me",
	"de",
	"hi",
	"ri",
	"ro",
	"ic",
	"ne",
	"ea",
] as const;

export const HASHLINE_BIGRAMS_COUNT = HASHLINE_BIGRAMS.length;

/**
 * Regex source matching exactly one bigram from {@link HASHLINE_BIGRAMS}.
 * Used by hashline parsers — keep in sync with the alphabet array above.
 */
export const HASHLINE_BIGRAM_RE_SRC = `(?:${HASHLINE_BIGRAMS.join("|")})`;

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

/**
 * Compute a short BPE-bigram hash of a single line.
 *
 * Uses xxHash32 on a trailing-whitespace-trimmed, CR-stripped line, mapped into
 * {@link HASHLINE_BIGRAMS} via modulo. For lines containing no alphanumeric
 * characters (only punctuation/symbols/whitespace), the line number is mixed in
 * to reduce hash collisions. The line input should not include a trailing newline.
 */
export function computeLineHash(idx: number, line: string): string {
	line = line.replace(/\r/g, "").trimEnd();

	let seed = 0;
	if (!RE_SIGNIFICANT.test(line)) {
		seed = idx;
	}
	return HASHLINE_BIGRAMS[Bun.hash.xxHash32(line, seed) % HASHLINE_BIGRAMS_COUNT];
}

/**
 * Formats a hash given the line number and text.
 */
export function formatLineHash(line: number, lines: string): string {
	return `${line}#${computeLineHash(line, lines)}`;
}

/**
 * Format file text with hashline prefixes for display.
 *
 * Each line becomes `LINENUM#HASH:TEXT` where LINENUM is 1-indexed.
 *
 * @param text - Raw file text string
 * @param startLine - First line number (1-indexed, defaults to 1)
 * @returns Formatted string with one hashline-prefixed line per input line
 *
 * @example
 * ```
 * formatHashLines("function hi() {\n  return;\n}")
 * // "1#th:function hi() {\n2#er:  return;\n3#in:}"
 * ```
 */
export function formatHashLines(text: string, startLine = 1): string {
	const lines = text.split("\n");
	return lines
		.map((line, i) => {
			const num = startLine + i;
			return `${formatLineHash(num, line)}:${line}`;
		})
		.join("\n");
}
