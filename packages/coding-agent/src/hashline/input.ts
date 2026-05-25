import * as path from "node:path";
import { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER } from "./constants";
import { HL_FILE_PREFIX, HL_OP_CHARS } from "./hash";
import type { SplitHashlineOptions } from "./types";

const regexEscape = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HASHLINE_OP_LINE_RE = new RegExp(`^[${regexEscape(HL_OP_CHARS)}]`);

export interface HashlineInputSection {
	path: string;
	diff: string;
}

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

function parseHashlineHeaderLine(line: string, cwd?: string): HashlineInputSection | null {
	const trimmed = line.trimEnd();
	if (!trimmed.startsWith(HL_FILE_PREFIX)) return null;
	// Strip a run of leading header markers so canonical `§PATH` and
	// runaway-prefix forms like `§§PATH` / `§§§PATH` route to the same file.
	let prefixEnd = 0;
	while (prefixEnd < trimmed.length && trimmed[prefixEnd] === HL_FILE_PREFIX) prefixEnd++;
	const rest = trimmed.slice(prefixEnd);
	if (rest.trim().length === 0) {
		throw new Error(`Input header "${HL_FILE_PREFIX}" is empty; provide a file path.`);
	}
	const parsedPath = normalizeHashlinePath(rest, cwd);
	if (parsedPath.length === 0) {
		throw new Error(`Input header "${HL_FILE_PREFIX}" is empty; provide a file path.`);
	}
	return { path: parsedPath, diff: "" };
}

function isPatchEnvelopeMarker(line: string): boolean {
	const trimmed = line.trimEnd();
	return trimmed === BEGIN_PATCH_MARKER || trimmed === END_PATCH_MARKER;
}

function stripLeadingBlankLines(input: string): string {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const lines = stripped.split("\n");
	while (lines.length > 0) {
		const head = lines[0].replace(/\r$/, "");
		if (head.trim().length === 0 || head.trimEnd() === BEGIN_PATCH_MARKER) {
			lines.shift();
			continue;
		}
		break;
	}
	return lines.join("\n");
}

export function containsRecognizableHashlineOperations(input: string): boolean {
	for (const line of input.split(/\r?\n/)) {
		if (HASHLINE_OP_LINE_RE.test(line)) return true;
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

export function splitHashlineInput(input: string, options: SplitHashlineOptions = {}): { path: string; diff: string } {
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
			`input must begin with "${HL_FILE_PREFIX}PATH" on the first non-blank line; got: ${preview}. ` +
				`Example: "${HL_FILE_PREFIX}src/foo.ts" then edit ops.`,
		);
	}

	const sections: HashlineInputSection[] = [];
	let currentPath = "";
	let currentLines: string[] = [];

	const flush = () => {
		if (currentPath.length === 0) return;
		const hasOps = currentLines.some(line => line.trim().length > 0);
		if (hasOps) sections.push({ path: currentPath, diff: currentLines.join("\n") });
		currentLines = [];
	};

	for (const line of lines) {
		if (line.trimEnd() === END_PATCH_MARKER || line.trimEnd() === ABORT_MARKER) break;
		if (isPatchEnvelopeMarker(line)) continue;
		const header = parseHashlineHeaderLine(line, options.cwd);
		if (header !== null) {
			flush();
			currentPath = header.path;
			currentLines = [];
		} else {
			currentLines.push(line);
		}
	}
	flush();
	return sections;
}
