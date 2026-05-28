/**
 * Hashline format primitives: sigils, separators, regex fragments, and
 * display helpers. These are the single source of truth for the parser, the
 * tokenizer, the prompt, and the formal grammar.
 */

/** File-section header prefix: `¶path#hash`. */
export const HL_FILE_PREFIX = "¶";

/** Payload sigil for literal body rows. */
export const HL_PAYLOAD_REPLACE = "+";
/** Payload sigil for body rows that repeat original file lines. */
export const HL_PAYLOAD_REPEAT = "&";

/** All hashline payload sigils, concatenated for fast membership tests. */
export const HL_PAYLOAD_CHARS = `${HL_PAYLOAD_REPLACE}${HL_PAYLOAD_REPEAT}`;

/** Separator between a hashline file path and its opaque snapshot tag. */
export const HL_FILE_HASH_SEP = "#";

/** Separator between two line numbers in a range, e.g. `5..10`. */
export const HL_RANGE_SEP = "..";

/** Separator between a line number and displayed line content in hashline mode. */
export const HL_LINE_BODY_SEP = ":";

function regexEscape(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Decoration prefix that may precede a line number in tool output:
 * `*` (match line), `>` (context line in grep). Any combination, in any
 * order, surrounded by optional whitespace. Output formatters emit at most
 * one decoration per line; the parser stays liberal because it accepts
 * whatever the model echoes back.
 */
export const HL_ANCHOR_DECORATION_RE_RAW = `\\s*[>*]*\\s*`;

/** Capture-group regex source for a decorated bare line-number anchor. */
export const HL_ANCHOR_RE_RAW = `${HL_ANCHOR_DECORATION_RE_RAW}(\\d+)`;

/** Bare positive line-number Lid (no decorations, no captures, no anchors). */
export const HL_LINE_RE_RAW = `[1-9]\\d*`;

/** Capture-group form of {@link HL_LINE_RE_RAW}. */
export const HL_LINE_CAPTURE_RE_RAW = `(${HL_LINE_RE_RAW})`;

/** Regex for repeat payload rows (`&A..B`). */
export const HL_PAYLOAD_REPEAT_RE = new RegExp(
	`^\\${HL_PAYLOAD_REPEAT}${HL_LINE_CAPTURE_RE_RAW},${HL_LINE_CAPTURE_RE_RAW}$`,
);

/** Number of hex characters in an opaque snapshot tag. */
export const HL_FILE_HASH_LENGTH = 3;

/** Canonical uppercase hexadecimal opaque snapshot tag carried by a hashline section header. */
export const HL_FILE_HASH_RE_RAW = `[0-9A-F]{${HL_FILE_HASH_LENGTH}}`;

/** Capture-group form of {@link HL_FILE_HASH_RE_RAW}. */
export const HL_FILE_HASH_CAPTURE_RE_RAW = `(${HL_FILE_HASH_RE_RAW})`;

/** Regex-escaped form of {@link HL_LINE_BODY_SEP}, safe for embedding inside a regex. */
export const HL_LINE_BODY_SEP_RE_RAW = regexEscape(HL_LINE_BODY_SEP);

/**
 * Representative snapshot tags for use in user-facing error messages and
 * prompt examples.
 */
export const HL_FILE_HASH_EXAMPLES = ["0A3", "1F7", "3C9"] as const;

/**
 * Format a comma-separated list of example anchors with an optional line-number
 * prefix, quoted for inclusion in error messages: `"160", "42", "7"`.
 */
export function describeAnchorExamples(linePrefix = ""): string {
	const examples = linePrefix ? [linePrefix, `${linePrefix.slice(0, -1) || "4"}2`, "7"] : ["160", "42", "7"];
	return examples.map(e => `"${e}"`).join(", ");
}

/** Format a hashline section header for a file path and snapshot tag. */
export function formatHashlineHeader(filePath: string, fileHash: string): string {
	return `${HL_FILE_PREFIX}${filePath}${HL_FILE_HASH_SEP}${fileHash}`;
}

/** Formats a single numbered line as `LINE:TEXT`. */
export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}${HL_LINE_BODY_SEP}${line}`;
}

/** Format file text with hashline-mode line-number prefixes for display. */
export function formatNumberedLines(text: string, startLine = 1): string {
	const lines = text.split("\n");
	return lines.map((line, i) => formatNumberedLine(startLine + i, line)).join("\n");
}
