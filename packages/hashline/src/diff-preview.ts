/**
 * Re-number a unified diff that uses the `+<lineNum>|content` /
 * `-<lineNum>|content` / ` <lineNum>|content` line format into a compact
 * preview that anchors every line to its post-edit position. Added lines,
 * removed lines, and context lines all end up with a hashline-style anchor
 * so a follow-up edit can reuse them directly.
 *
 * This is intentionally decoupled from the diff producer: anything that
 * emits the `<sign><lineNum>|<content>` shape works.
 */
import type { CompactDiffOptions, CompactDiffPreview } from "./types";

export function buildCompactDiffPreview(diff: string, _options: CompactDiffOptions = {}): CompactDiffPreview {
	const lines = diff.length === 0 ? [] : diff.split("\n");
	let addedLines = 0;
	let removedLines = 0;

	// External diff producers number `+` lines with the post-edit line number,
	// `-` lines with the pre-edit line number, and context lines with the
	// pre-edit line number. To emit fresh line numbers usable for follow-up
	// edits, convert context-line numbers to post-edit positions by tracking
	// the running offset (added so far - removed so far) as we walk the diff.
	const formatted = lines.map(line => {
		const kind = line[0];
		if (kind !== "+" && kind !== "-" && kind !== " ") return line;

		const body = line.slice(1);
		const sep = body.indexOf("|");
		if (sep === -1) return line;

		const lineNumber = Number.parseInt(body.slice(0, sep), 10);
		const content = body.slice(sep + 1);

		switch (kind) {
			case "+":
				addedLines++;
				return `+${lineNumber}:${content}`;
			case "-":
				removedLines++;
				return `-${lineNumber}:${content}`;
			default: {
				const newLineNumber = lineNumber + addedLines - removedLines;
				return ` ${newLineNumber}:${content}`;
			}
		}
	});

	return { preview: formatted.join("\n"), addedLines, removedLines };
}
