import { computeLineHash } from "../edit/line-hash";

/**
 * Format a single line of match output for grep/ast-grep style results.
 *
 * Match lines use `:` as the anchor/content separator; context lines use `-`.
 * In hashline mode the anchor is `LINENUMBIGRAM` (no `#`); in plain mode it is
 * just the line number. Line numbers are never padded.
 */
export function formatMatchLine(
	lineNumber: number,
	line: string,
	isMatch: boolean,
	options: { useHashLines: boolean },
): string {
	const separator = isMatch ? ":" : "-";
	if (options.useHashLines) {
		return `${lineNumber}${computeLineHash(lineNumber, line)}${separator}${line}`;
	}
	return `${lineNumber}${separator}${line}`;
}
