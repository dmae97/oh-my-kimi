import { computeLineHash } from "../edit/line-hash";

/**
 * Format a single line of match output for grep/ast-grep style results.
 * Uses hashline refs when hashlines are enabled, otherwise pads the number.
 */
export function formatMatchLine(
	lineNumber: number,
	line: string,
	isMatch: boolean,
	options: { useHashLines: boolean; lineWidth: number },
): string {
	const separator = isMatch ? ":" : "-";
	if (options.useHashLines) {
		const ref = `${lineNumber}#${computeLineHash(lineNumber, line)}`;
		return `${ref}${separator}${line}`;
	}
	const padded = lineNumber.toString().padStart(options.lineWidth, " ");
	return `${padded}${separator}${line}`;
}
