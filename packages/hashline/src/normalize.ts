/**
 * Minimal text-shape normalization: line-ending detection / round-trip and
 * BOM stripping. The patcher uses these to canonicalize text to LF before
 * applying edits and to restore the original shape on write-back.
 */

export type LineEnding = "\r\n" | "\n";

/** Detect the predominant line ending in `content`. Defaults to LF when neither is present. */
export function detectLineEnding(content: string): LineEnding {
	const crlfMatches = content.match(/\r\n/g);
	const crlfCount = crlfMatches ? crlfMatches.length : 0;
	const lfMatches = content.match(/\n/g);
	const lfCount = lfMatches ? lfMatches.length : 0;
	const standaloneLfCount = lfCount - crlfCount;
	return crlfCount > standaloneLfCount ? "\r\n" : "\n";
}

/** Normalize every line ending to LF. */
export function normalizeToLF(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** Re-encode LF text with the requested line ending. */
export function restoreLineEndings(text: string, ending: LineEnding): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export interface BomResult {
	/** Either the empty string or the BOM sequence (currently UTF-8 BOM). */
	bom: string;
	/** Text with any leading BOM removed. */
	text: string;
}

/** Strip a UTF-8 BOM if present and return both the BOM and the trailing text. */
export function stripBom(content: string): BomResult {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}
