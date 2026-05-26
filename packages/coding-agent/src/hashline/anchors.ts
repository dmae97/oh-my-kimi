import { MISMATCH_CONTEXT } from "./constants";
import { formatNumberedLine, HL_FILE_HASH_SEP, HL_FILE_PREFIX } from "./hash";

const LINE_REF_RE = /^\s*[>+\-*]*\s*(\d+)(?::.*)?\s*$/;

export function formatFullAnchorRequirement(raw?: string): string {
	const received = raw === undefined ? "" : ` Received ${JSON.stringify(raw)}.`;
	return (
		`a bare line number from read/search output plus the section header file hash ` +
		`(for example ${HL_FILE_PREFIX}src/foo.ts${HL_FILE_HASH_SEP}1a2b and line "160")${received}`
	);
}

export function parseTag(ref: string): { line: number } {
	const match = ref.match(LINE_REF_RE);
	if (!match) {
		throw new Error(`Invalid line reference. Expected ${formatFullAnchorRequirement(ref)}.`);
	}
	const line = Number.parseInt(match[1], 10);
	if (line < 1) throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
	return { line };
}

export interface HashlineMismatchDetails {
	path?: string;
	expectedFileHash: string;
	actualFileHash: string;
	fileLines: string[];
	anchorLines?: readonly number[];
}

function getMismatchDisplayLines(anchorLines: readonly number[], fileLines: string[]): number[] {
	const displayLines = new Set<number>();
	for (const line of anchorLines) {
		if (line < 1 || line > fileLines.length) continue;
		const lo = Math.max(1, line - MISMATCH_CONTEXT);
		const hi = Math.min(fileLines.length, line + MISMATCH_CONTEXT);
		for (let lineNum = lo; lineNum <= hi; lineNum++) displayLines.add(lineNum);
	}
	return [...displayLines].sort((a, b) => a - b);
}

export class HashlineMismatchError extends Error {
	readonly path: string | undefined;
	readonly expectedFileHash: string;
	readonly actualFileHash: string;
	readonly fileLines: string[];
	readonly anchorLines: readonly number[];

	constructor(details: HashlineMismatchDetails) {
		super(HashlineMismatchError.formatMessage(details));
		this.name = "HashlineMismatchError";
		this.path = details.path;
		this.expectedFileHash = details.expectedFileHash;
		this.actualFileHash = details.actualFileHash;
		this.fileLines = details.fileLines;
		this.anchorLines = details.anchorLines ?? [];
	}

	get displayMessage(): string {
		return HashlineMismatchError.formatDisplayMessage({
			path: this.path,
			expectedFileHash: this.expectedFileHash,
			actualFileHash: this.actualFileHash,
			fileLines: this.fileLines,
			anchorLines: this.anchorLines,
		});
	}

	static rejectionHeader(details: HashlineMismatchDetails): string[] {
		const pathText = details.path ? ` for ${details.path}` : "";
		return [
			`Edit rejected${pathText}: file changed between read and edit.`,
			`Section is bound to ${HL_FILE_HASH_SEP}${details.expectedFileHash}, but the current file hashes to ${HL_FILE_HASH_SEP}${details.actualFileHash}; re-read and try again.`,
		];
	}

	static formatDisplayMessage(details: HashlineMismatchDetails): string {
		return HashlineMismatchError.formatMessage(details);
	}

	static formatMessage(details: HashlineMismatchDetails): string {
		const anchorSet = new Set(details.anchorLines ?? []);
		const lines = HashlineMismatchError.rejectionHeader(details);
		const displayLines = getMismatchDisplayLines(details.anchorLines ?? [], details.fileLines);
		if (displayLines.length === 0) return lines.join("\n");
		lines.push("");
		let previous = -1;
		for (const lineNum of displayLines) {
			if (previous !== -1 && lineNum > previous + 1) lines.push("...");
			previous = lineNum;
			const text = details.fileLines[lineNum - 1] ?? "";
			const marker = anchorSet.has(lineNum) ? "*" : " ";
			lines.push(`${marker}${formatNumberedLine(lineNum, text)}`);
		}
		return lines.join("\n");
	}
}

export function validateLineRef(ref: { line: number }, fileLines: string[]): void {
	if (ref.line < 1 || ref.line > fileLines.length) {
		throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
	}
}
