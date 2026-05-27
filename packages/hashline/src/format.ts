/**
 * Hashline format primitives: sigils, separators, regex fragments, and the
 * file-hash computation. These are the single source of truth for the
 * parser, the tokenizer, the prompt, and the formal grammar.
 */

/** Op sigil used immediately after a line-number anchor to insert before it. */
export const HL_OP_INSERT_BEFORE = "↑";
/** Op sigil used immediately after a line-number anchor to insert after it. */
export const HL_OP_INSERT_AFTER = "↓";
/** Op sigil used after a range (or single anchor) to replace its lines. */
export const HL_OP_REPLACE = ":";

/** All hashline edit op sigils, concatenated for fast membership tests. */
export const HL_OP_CHARS = `${HL_OP_INSERT_BEFORE}${HL_OP_INSERT_AFTER}${HL_OP_REPLACE}`;

/** Prefix for payload continuation lines. The prefix itself is not written. */
export const HL_PAYLOAD_PREFIX = "+";

/** Hashline edit file-section header marker. */
export const HL_FILE_PREFIX = "¶";

/** Separator between a hashline file path and its file hash. */
export const HL_FILE_HASH_SEP = "#";

/** Separator between a line number and displayed line content in hashline mode. */
export const HL_LINE_BODY_SEP = ":";

function regexEscape(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Decoration prefix that may precede a line number in tool output:
 * `>` (context line in grep), `-` (removed line), `*` (match line).
 * Any combination, in any order, surrounded by optional whitespace. Output
 * formatters emit at most one decoration per line; the parser stays liberal
 * because it accepts whatever the model echoes back.
 */
export const HL_ANCHOR_DECORATION_RE_RAW = `\\s*[>\\-*]*\\s*`;

/** Capture-group regex source for a decorated bare line-number anchor. */
export const HL_ANCHOR_RE_RAW = `${HL_ANCHOR_DECORATION_RE_RAW}(\\d+)`;

/** Bare positive line-number Lid (no decorations, no captures, no anchors). */
export const HL_LINE_RE_RAW = `[1-9]\\d*`;

/** Capture-group form of {@link HL_LINE_RE_RAW}. */
export const HL_LINE_CAPTURE_RE_RAW = `([1-9]\\d*)`;

/** Four-hex-character file hash carried by a hashline section header. */
export const HL_FILE_HASH_RE_RAW = `[0-9a-f]{4}`;

/** Capture-group form of {@link HL_FILE_HASH_RE_RAW}. */
export const HL_FILE_HASH_CAPTURE_RE_RAW = `(${HL_FILE_HASH_RE_RAW})`;

/** Regex-escaped form of {@link HL_LINE_BODY_SEP}, safe for embedding inside a regex. */
export const HL_LINE_BODY_SEP_RE_RAW = regexEscape(HL_LINE_BODY_SEP);

/**
 * Representative file hashes for use in user-facing error messages and prompt
 * examples.
 */
export const HL_FILE_HASH_EXAMPLES = ["1a2b", "3c4d", "9f3e"] as const;

/**
 * Format a comma-separated list of example anchors with an optional line-number
 * prefix, quoted for inclusion in error messages: `"160", "42", "7"`.
 */
export function describeAnchorExamples(linePrefix = ""): string {
	const examples = linePrefix ? [linePrefix, `${linePrefix.slice(0, -1) || "4"}2`, "7"] : ["160", "42", "7"];
	return examples.map(e => `"${e}"`).join(", ");
}

function normalizeFileHashText(text: string): string {
	return text
		.replace(/\r/g, "")
		.split("\n")
		.map(line => line.trimEnd())
		.join("\n");
}

/**
 * Compute the 4-hex-character hash carried by a hashline section header. The
 * hash normalizes CR characters and trailing whitespace before hashing so
 * platform line endings and display-trimmed lines do not invalidate anchors.
 */
export function computeFileHash(text: string): string {
	const normalized = normalizeFileHashText(text);
	const low16 = Bun.hash.xxHash32(normalized, 0) & 0xffff;
	return low16.toString(16).padStart(4, "0");
}

/** Format a hashline section header for a file path and file hash. */
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
