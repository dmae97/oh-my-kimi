import * as path from "node:path";
import { HL_FILE_HASH_SEP, HL_FILE_PREFIX } from "./hash";
import { HashlineTokenizer } from "./tokenizer";
import type { HashlineInputSection, SplitHashlineOptions } from "./types";

// Pure classification — single shared tokenizer is safe.
const TOKENIZER = new HashlineTokenizer();

function unquoteHashlinePath(pathText: string): string {
	if (pathText.length < 2) return pathText;
	const first = pathText[0];
	const last = pathText[pathText.length - 1];
	if ((first === '"' || first === "'") && first === last) return pathText.slice(1, -1);
	return pathText;
}

function normalizeHashlinePath(rawPath: string, cwd?: string): string {
	const unquoted = unquoteHashlinePath(rawPath.trim());
	if (!cwd || !path.isAbsolute(unquoted)) return unquoted;
	const relative = path.relative(path.resolve(cwd), path.resolve(unquoted));
	const isWithinCwd = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
	return isWithinCwd ? relative || "." : unquoted;
}

/**
 * Parse a `¶PATH[#hash]` header line. Returns `null` for lines that do not
 * begin with the `¶` prefix; throws the existing "Input header must be …"
 * error when a `¶`-prefixed line fails the strict shape (so malformed paths
 * surface immediately instead of being silently re-classified as payload).
 */
function parseHashlineHeaderLine(line: string, cwd?: string): HashlineInputSection | null {
	const trimmed = line.trimEnd();
	if (!trimmed.startsWith(HL_FILE_PREFIX)) return null;

	const token = TOKENIZER.tokenize(trimmed);
	if (token.kind !== "header") {
		throw new Error(
			`Input header must be ${HL_FILE_PREFIX}PATH or ${HL_FILE_PREFIX}PATH${HL_FILE_HASH_SEP}HASH with a 4-hex file hash; got ${JSON.stringify(trimmed)}.`,
		);
	}

	const parsedPath = normalizeHashlinePath(token.path, cwd);
	if (parsedPath.length === 0) {
		throw new Error(`Input header "${HL_FILE_PREFIX}" is empty; provide a file path.`);
	}
	return token.fileHash !== undefined
		? { path: parsedPath, fileHash: token.fileHash, diff: "" }
		: { path: parsedPath, diff: "" };
}

function stripLeadingBlankLines(input: string): string {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const lines = stripped.split("\n");
	while (lines.length > 0) {
		const head = lines[0].replace(/\r$/, "");
		if (head.trim().length === 0 || TOKENIZER.tokenize(head).kind === "envelope-begin") {
			lines.shift();
			continue;
		}
		break;
	}
	return lines.join("\n");
}

export function containsRecognizableHashlineOperations(input: string): boolean {
	for (const line of input.split(/\r?\n/)) {
		if (TOKENIZER.isOp(line)) return true;
	}
	return false;
}

function normalizeFallbackInput(input: string, options: SplitHashlineOptions): string {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const hasExplicitHeader = stripped
		.split(/\r?\n/)
		.some(rawLine => parseHashlineHeaderLine(rawLine, options.cwd) !== null);
	if (hasExplicitHeader) return input;

	if (!options.path || !containsRecognizableHashlineOperations(input)) return input;
	const fallbackPath = normalizeHashlinePath(options.path, options.cwd);
	if (fallbackPath.length === 0) return input;
	return `${HL_FILE_PREFIX}${fallbackPath}\n${input}`;
}

export function splitHashlineInput(input: string, options: SplitHashlineOptions = {}): HashlineInputSection {
	const [section] = splitHashlineInputs(input, options);
	return section;
}

export function splitHashlineInputs(input: string, options: SplitHashlineOptions = {}): HashlineInputSection[] {
	const stripped = stripLeadingBlankLines(normalizeFallbackInput(input, options));
	const lines = stripped.split(/\r?\n/);
	const firstLine = lines[0] ?? "";

	if (parseHashlineHeaderLine(firstLine, options.cwd) === null) {
		const preview = JSON.stringify(firstLine.slice(0, 120));
		throw new Error(
			`input must begin with "${HL_FILE_PREFIX}PATH${HL_FILE_HASH_SEP}HASH" on the first non-blank line for anchored edits; got: ${preview}. ` +
				`Example: "${HL_FILE_PREFIX}src/foo.ts${HL_FILE_HASH_SEP}1a2b" then edit ops.`,
		);
	}

	const sections: HashlineInputSection[] = [];
	let current: HashlineInputSection | undefined;
	let currentLines: string[] = [];

	const flush = () => {
		if (!current) return;
		const hasOps = currentLines.some(line => line.trim().length > 0);
		if (hasOps) sections.push({ ...current, diff: currentLines.join("\n") });
		currentLines = [];
	};

	for (const line of lines) {
		const trimmed = line.trimEnd();
		const token = TOKENIZER.tokenize(line);
		if (token.kind === "envelope-end" || token.kind === "abort") break;
		if (token.kind === "envelope-begin") continue;

		// Route every `¶`-prefixed line through parseHashlineHeaderLine so
		// malformed headers still raise the strict "Input header must be …"
		// diagnostic (the tokenizer alone would silently classify them as
		// payload).
		if (trimmed.startsWith(HL_FILE_PREFIX)) {
			const header = parseHashlineHeaderLine(line, options.cwd);
			if (header !== null) {
				flush();
				current = header;
				currentLines = [];
				continue;
			}
		}
		currentLines.push(line);
	}
	flush();
	return sections;
}
