import { formatCodeFrameLine } from "../tools/render-utils";
import { MISMATCH_CONTEXT } from "./constants";
import { computeLineHash, describeAnchorExamples, HL_ANCHOR_RE_RAW, HL_BODY_SEP } from "./hash";
import type { HashMismatch } from "./types";

const HL_HASH_HINT_RE = /^[a-z]{2}$/i;
const HL_ANCHOR_EXAMPLES = describeAnchorExamples("160");
const PARSE_TAG_RE = new RegExp(`^${HL_ANCHOR_RE_RAW}`);

export function formatFullAnchorRequirement(raw?: string): string {
	const suffix = typeof raw === "string" ? raw.trim() : "";
	const hashOnlyHint = HL_HASH_HINT_RE.test(suffix)
		? ` It looks like you supplied only the hash suffix (${JSON.stringify(suffix)}). ` +
			`Copy the full anchor exactly as shown (for example, "160${suffix}").`
		: "";
	const received = raw === undefined ? "" : ` Received ${JSON.stringify(raw)}.`;
	return (
		`the full anchor exactly as shown by read/search output ` +
		`(line number + hash, for example ${HL_ANCHOR_EXAMPLES})${received}${hashOnlyHint}`
	);
}

export function parseTag(ref: string): { line: number; hash: string } {
	const match = ref.match(PARSE_TAG_RE);
	if (!match) {
		throw new Error(`Invalid line reference. Expected ${formatFullAnchorRequirement(ref)}.`);
	}
	const line = Number.parseInt(match[1], 10);
	if (line < 1) throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
	return { line, hash: match[2] };
}

function getMismatchDisplayLines(mismatches: HashMismatch[], fileLines: string[]): number[] {
	const displayLines = new Set<number>();
	for (const mismatch of mismatches) {
		const lo = Math.max(1, mismatch.line - MISMATCH_CONTEXT);
		const hi = Math.min(fileLines.length, mismatch.line + MISMATCH_CONTEXT);
		for (let lineNum = lo; lineNum <= hi; lineNum++) displayLines.add(lineNum);
	}
	return [...displayLines].sort((a, b) => a - b);
}

export class HashlineMismatchError extends Error {
	readonly remaps: ReadonlyMap<string, string>;

	constructor(
		public readonly mismatches: HashMismatch[],
		public readonly fileLines: string[],
	) {
		super(HashlineMismatchError.formatMessage(mismatches, fileLines));
		this.name = "HashlineMismatchError";

		const remaps = new Map<string, string>();
		for (const mismatch of mismatches) {
			const actual = computeLineHash(mismatch.line, fileLines[mismatch.line - 1] ?? "");
			remaps.set(`${mismatch.line}${mismatch.expected}`, `${mismatch.line}${actual}`);
		}
		this.remaps = remaps;
	}

	get displayMessage(): string {
		return HashlineMismatchError.formatDisplayMessage(this.mismatches, this.fileLines);
	}

	private static rejectionHeader(mismatches: HashMismatch[]): string[] {
		const noun = mismatches.length > 1 ? "anchors do" : "anchor does";
		return [
			`Edit rejected: ${mismatches.length} ${noun} not match the current file (marked *).`,
			"The edit was NOT applied, please use the updated file content shown below, and issue another edit tool-call.",
		];
	}

	static formatDisplayMessage(mismatches: HashMismatch[], fileLines: string[]): string {
		const mismatchSet = new Set<number>(mismatches.map(m => m.line));
		const displayLines = getMismatchDisplayLines(mismatches, fileLines);
		const width = displayLines.reduce((cur, n) => Math.max(cur, String(n).length), 0);

		const out = [...HashlineMismatchError.rejectionHeader(mismatches), ""];
		let previous = -1;
		for (const lineNum of displayLines) {
			if (previous !== -1 && lineNum > previous + 1) out.push("...");
			previous = lineNum;
			const marker = mismatchSet.has(lineNum) ? "*" : " ";
			out.push(formatCodeFrameLine(marker, lineNum, fileLines[lineNum - 1] ?? "", width));
		}
		return out.join("\n");
	}

	static formatMessage(mismatches: HashMismatch[], fileLines: string[]): string {
		const mismatchSet = new Set<number>(mismatches.map(m => m.line));
		const lines = HashlineMismatchError.rejectionHeader(mismatches);
		let previous = -1;
		for (const lineNum of getMismatchDisplayLines(mismatches, fileLines)) {
			if (previous !== -1 && lineNum > previous + 1) lines.push("...");
			previous = lineNum;
			const text = fileLines[lineNum - 1] ?? "";
			const hash = computeLineHash(lineNum, text);
			const marker = mismatchSet.has(lineNum) ? "*" : " ";
			lines.push(`${marker}${lineNum}${hash}${HL_BODY_SEP}${text}`);
		}
		return lines.join("\n");
	}
}

export function validateLineRef(ref: { line: number; hash: string }, fileLines: string[]): void {
	if (ref.line < 1 || ref.line > fileLines.length) {
		throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
	}
	const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1] ?? "");
	if (actualHash !== ref.hash) {
		throw new HashlineMismatchError([{ line: ref.line, expected: ref.hash, actual: actualHash }], fileLines);
	}
}
