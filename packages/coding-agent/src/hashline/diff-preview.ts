import type { CompactHashlineDiffOptions, CompactHashlineDiffPreview } from "./types";

export function buildCompactHashlineDiffPreview(
	diff: string,
	_options: CompactHashlineDiffOptions = {},
): CompactHashlineDiffPreview {
	const lines = diff.length === 0 ? [] : diff.split("\n");
	let addedLines = 0;
	let removedLines = 0;

	// `generateDiffString` numbers `+` lines with the post-edit line number,
	// `-` lines with the pre-edit line number, and context lines with the
	// pre-edit line number. To emit fresh line numbers usable for follow-up edits,
	// we convert context-line numbers to post-edit positions by tracking the
	// running offset (added so far - removed so far) as we walk the diff.
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
