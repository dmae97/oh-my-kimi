/**
 * Indent helpers used by `splice_block`.
 *
 * Pure functions: take strings/lines, return strings/lines. No I/O. Designed
 * to be easy to unit-test in isolation.
 */

export interface IndentStyle {
	kind: "tab" | "space";
	width: number;
}

const SAMPLE_LINES_FOR_DETECTION = 256;

/**
 * Detect whether the file uses tab or space indentation, and the indent width
 * for spaces. Sampling-based; defaults to {kind: "tab", width: 1} when nothing
 * is conclusive.
 */
export function detectIndentStyle(text: string): IndentStyle {
	const lines = text.split("\n", SAMPLE_LINES_FOR_DETECTION + 1).slice(0, SAMPLE_LINES_FOR_DETECTION);
	let tabIndented = 0;
	let spaceIndented = 0;
	const spaceWidthCounts = new Map<number, number>();
	for (const line of lines) {
		if (line.length === 0) continue;
		const ch0 = line[0];
		if (ch0 === "\t") {
			tabIndented++;
			continue;
		}
		if (ch0 !== " ") continue;
		let count = 0;
		while (count < line.length && line[count] === " ") count++;
		// Skip lines whose entire content is whitespace (no signal).
		if (count === line.length) continue;
		spaceIndented++;
		// Record indent step. Try common values 2, 4, 8 by GCD-ish.
		spaceWidthCounts.set(count, (spaceWidthCounts.get(count) ?? 0) + 1);
	}
	if (tabIndented > spaceIndented) return { kind: "tab", width: 1 };
	if (spaceIndented === 0) return { kind: "tab", width: 1 };

	// Pick the most common nonzero indent width that divides the others well.
	const candidates = [2, 4, 8];
	let bestCandidate = 4;
	let bestScore = -1;
	for (const cand of candidates) {
		let score = 0;
		for (const [width, count] of spaceWidthCounts) {
			if (width % cand === 0) score += count;
		}
		if (score > bestScore) {
			bestScore = score;
			bestCandidate = cand;
		}
	}
	return { kind: "space", width: bestCandidate };
}

/**
 * Strip the common leading whitespace prefix from every non-empty line.
 * Blank/whitespace-only lines pass through unchanged.
 *
 * Tab and space whitespace count as a single character each here; we look at
 * raw prefix bytes. The block executor re-applies destination indent later,
 * so tab/space mismatches in the agent's own input are normalized by
 * `applyIndent` rather than here.
 */
export function stripCommonIndent(lines: readonly string[]): string[] {
	let common: string | null = null;
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		const m = /^[\t ]*/.exec(line);
		const prefix = m ? m[0] : "";
		if (common === null) {
			common = prefix;
			continue;
		}
		// Reduce to the longest shared prefix.
		let i = 0;
		const limit = Math.min(common.length, prefix.length);
		while (i < limit && common[i] === prefix[i]) i++;
		common = common.slice(0, i);
		if (common.length === 0) break;
	}
	if (!common) return [...lines];
	return lines.map(line => (line.startsWith(common!) ? line.slice(common!.length) : line));
}

/**
 * Re-index leading whitespace of `lines` from the source style to the
 * destination style, then prepend `prefix` to every non-empty line.
 *
 * - Source style is detected from the lines themselves.
 * - Tab→space and space→tab conversion is applied to the *relative*
 *   indentation (everything past the common prefix has already been stripped
 *   by `stripCommonIndent`, so all leading whitespace here is "extra" indent).
 * - Blank lines stay empty (no trailing whitespace).
 */
export function applyIndent(lines: readonly string[], prefix: string, destStyle: IndentStyle): string[] {
	const sourceStyle = detectIndentStyle(lines.join("\n"));
	return lines.map(line => {
		if (line.trim().length === 0) return "";
		const m = /^[\t ]*/.exec(line);
		const leading = m ? m[0] : "";
		const rest = line.slice(leading.length);
		const normalized = normalizeIndent(leading, sourceStyle, destStyle);
		return prefix + normalized + rest;
	});
}

function normalizeIndent(leading: string, source: IndentStyle, dest: IndentStyle): string {
	if (leading.length === 0) return leading;
	// Compute total visual columns of the leading run, treating tabs in the
	// source as `source.width` columns (or 1 column for tab-indented files,
	// where the destination decides the visible width).
	let columns = 0;
	for (const ch of leading) {
		if (ch === "\t") {
			// Treat a source tab as one indent unit. Width = source.width or
			// fallback 4 when source is tab style.
			columns += source.kind === "tab" ? 1 : Math.max(1, Math.floor(source.width));
		} else {
			columns += 1;
		}
	}
	if (dest.kind === "tab") {
		// Convert visual columns to whole tabs. When source was space-indented,
		// columns is in spaces; divide by source.width to get logical levels.
		let levels: number;
		if (source.kind === "tab") {
			levels = columns;
		} else {
			const w = Math.max(1, source.width);
			levels = Math.round(columns / w);
		}
		return "\t".repeat(Math.max(0, levels));
	}
	// Destination is spaces. Convert to dest.width columns per level.
	let levels: number;
	if (source.kind === "tab") {
		levels = columns; // tabs were 1 column each here
	} else {
		const w = Math.max(1, source.width);
		levels = Math.round(columns / w);
	}
	const out = " ".repeat(Math.max(0, levels) * Math.max(1, dest.width));
	return out;
}
