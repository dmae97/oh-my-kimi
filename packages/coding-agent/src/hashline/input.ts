import * as path from "node:path";
import { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER, FILE_HEADER_PREFIX } from "./constants";
import { HL_EDIT_SEP } from "./hash";
import type { SplitHashlineOptions } from "./types";
import { stripTrailingCarriageReturn } from "./utils";

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
	if (!trimmed.startsWith(FILE_HEADER_PREFIX)) return null;
	// Some models occasionally emit unified-diff-style "@@ path" (or even longer
	// runs of "@"). Strip every leading "@" before resolving the path so those
	// stray headers still route to the right file.
	let prefixEnd = 0;
	while (prefixEnd < trimmed.length && trimmed[prefixEnd] === FILE_HEADER_PREFIX) prefixEnd++;
	const rest = trimmed.slice(prefixEnd);
	if (rest.trim().length === 0) {
		throw new Error(`Input header "${FILE_HEADER_PREFIX}" is empty; provide a file path.`);
	}
	const parsedPath = normalizeHashlinePath(rest, cwd);
	if (parsedPath.length === 0) {
		throw new Error(`Input header "${FILE_HEADER_PREFIX}" is empty; provide a file path.`);
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
	for (const rawLine of input.split("\n")) {
		const line = stripTrailingCarriageReturn(rawLine);
		if (/^[+<=-]\s+/.test(line) || line.startsWith(HL_EDIT_SEP)) return true;
	}
	return false;
}

function normalizeFallbackInput(input: string, options: SplitHashlineOptions): string {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const hasExplicitHeader = stripped
		.split("\n")
		.some(rawLine => parseHashlineHeaderLine(stripTrailingCarriageReturn(rawLine), options.cwd) !== null);
	if (hasExplicitHeader) return input;

	if (!options.path || !containsRecognizableHashlineOperations(input)) return input;
	const fallbackPath = normalizeHashlinePath(options.path, options.cwd);
	if (fallbackPath.length === 0) return input;
	return `${FILE_HEADER_PREFIX} ${fallbackPath}\n${input}`;
}

export function splitHashlineInput(input: string, options: SplitHashlineOptions = {}): { path: string; diff: string } {
	const [section] = splitHashlineInputs(input, options);
	return section;
}

export function splitHashlineInputs(input: string, options: SplitHashlineOptions = {}): HashlineInputSection[] {
	const stripped = stripLeadingBlankLines(normalizeFallbackInput(input, options));
	const lines = stripped.split("\n");
	const firstLine = stripTrailingCarriageReturn(lines[0] ?? "");

	if (parseHashlineHeaderLine(firstLine, options.cwd) === null) {
		const preview = JSON.stringify(firstLine.slice(0, 120));
		throw new Error(
			`input must begin with "@@ PATH" on the first non-blank line; got: ${preview}. ` +
				`Example: "@@ src/foo.ts" then edit ops.`,
		);
	}

	const sections: HashlineInputSection[] = [];
	let currentPath = "";
	let currentLines: string[] = [];

	const flush = () => {
		if (currentPath.length === 0) return;
		const hasOps = currentLines.some(rawLine => stripTrailingCarriageReturn(rawLine).trim().length > 0);
		if (hasOps) sections.push({ path: currentPath, diff: currentLines.join("\n") });
		currentLines = [];
	};

	for (const rawLine of lines) {
		const line = stripTrailingCarriageReturn(rawLine);
		if (line.trimEnd() === END_PATCH_MARKER || line.trimEnd() === ABORT_MARKER) break;
		if (isPatchEnvelopeMarker(line)) continue;
		const header = parseHashlineHeaderLine(line, options.cwd);
		if (header !== null) {
			flush();
			currentPath = header.path;
			currentLines = [];
		} else {
			currentLines.push(rawLine);
		}
	}
	flush();
	return sections;
}
