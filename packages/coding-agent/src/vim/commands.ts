import type { VimExCommand, VimLineRange } from "./types";
import { VimInputError } from "./types";

export interface VimExParseContext {
	currentLine: number;
	lastLine: number;
}

interface ParsedLineAddress {
	line: number;
	nextIndex: number;
}

function clampLine(line: number, context: VimExParseContext): number {
	return Math.min(Math.max(line, 1), Math.max(1, context.lastLine));
}

function readDigits(raw: string, start: number): { digits: string; nextIndex: number } {
	let index = start;
	let digits = "";
	while (index < raw.length) {
		const char = raw[index] ?? "";
		if (!/^\d$/.test(char)) {
			break;
		}
		digits += char;
		index += 1;
	}
	return { digits, nextIndex: index };
}

function parseLineAddress(
	raw: string,
	start: number,
	context: VimExParseContext,
	relativeBase = context.currentLine,
): ParsedLineAddress | undefined {
	let index = start;
	let line: number | undefined;
	const first = raw[index] ?? "";

	if (/^\d$/.test(first)) {
		const { digits, nextIndex } = readDigits(raw, index);
		line = Number.parseInt(digits, 10);
		index = nextIndex;
	} else if (first === ".") {
		line = context.currentLine;
		index += 1;
	} else if (first === "$") {
		line = context.lastLine;
		index += 1;
	} else if (first === "+" || first === "-") {
		line = relativeBase;
	} else {
		return undefined;
	}

	while (index < raw.length) {
		const sign = raw[index];
		if (sign !== "+" && sign !== "-") {
			break;
		}
		index += 1;
		const { digits, nextIndex } = readDigits(raw, index);
		index = nextIndex;
		const offset = digits.length > 0 ? Number.parseInt(digits, 10) : 1;
		line += sign === "+" ? offset : -offset;
	}

	return { line: clampLine(line, context), nextIndex: index };
}

function parseLineRange(raw: string, context?: VimExParseContext): { range?: VimLineRange | "all"; rest: string } {
	if (raw.startsWith("%")) {
		return { range: "all", rest: raw.slice(1).trimStart() };
	}

	if (!context) {
		const match = raw.match(/^(\d+)(?:\s*,\s*(\d+))?/);
		if (!match) {
			return { rest: raw };
		}

		const start = Number.parseInt(match[1] ?? "", 10);
		const end = Number.parseInt(match[2] ?? match[1] ?? "", 10);
		return {
			range: { start, end },
			rest: raw.slice(match[0].length).trimStart(),
		};
	}

	const first = parseLineAddress(raw, 0, context);
	if (!first) {
		return { rest: raw };
	}

	let index = first.nextIndex;
	while (raw[index] === " ") {
		index += 1;
	}

	const separator = raw[index];
	if (separator !== "," && separator !== ";") {
		return {
			range: { start: first.line, end: first.line },
			rest: raw.slice(index).trimStart(),
		};
	}

	index += 1;
	while (raw[index] === " ") {
		index += 1;
	}

	const second = parseLineAddress(raw, index, context, separator === ";" ? first.line : context.currentLine);
	if (!second) {
		throw new VimInputError(`Missing line address after ${separator}`);
	}

	return {
		range: { start: first.line, end: second.line },
		rest: raw.slice(second.nextIndex).trimStart(),
	};
}

function parseDelimitedSegments(raw: string): { pattern: string; replacement: string; flags: string } {
	if (raw.length === 0) {
		throw new VimInputError("Missing substitute delimiter");
	}

	const delimiter = raw[0] ?? "/";
	const segments: string[] = [];
	let current = "";
	let escaped = false;

	for (let index = 1; index < raw.length; index += 1) {
		const char = raw[index] ?? "";
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			current += char;
			continue;
		}
		if (char === delimiter && segments.length < 2) {
			segments.push(current);
			current = "";
			continue;
		}
		current += char;
	}

	if (segments.length !== 2) {
		throw new VimInputError("Substitute command must look like :s/pattern/replacement/flags");
	}

	return {
		pattern: segments[0] ?? "",
		replacement: segments[1] ?? "",
		flags: current.trim(),
	};
}

function parseDestination(raw: string, context?: VimExParseContext): number {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new VimInputError("Missing destination");
	}

	if (/^\d+$/.test(trimmed)) {
		return Number.parseInt(trimmed, 10);
	}

	if (context) {
		const address = parseLineAddress(trimmed, 0, context);
		if (address && trimmed.slice(address.nextIndex).trim().length === 0) {
			return address.line;
		}
	}

	const destination = Number.parseInt(trimmed, 10);
	if (Number.isNaN(destination)) {
		throw new VimInputError("Invalid destination");
	}
	return destination;
}

function matchGlobalCommand(rest: string): { pattern: string; command: string; invert: boolean } | undefined {
	const globalMatch = rest.match(/^(g|v|g!|global|global!|vglobal)\s*([/|#])(.+?)\2(.*)$/);
	if (!globalMatch) {
		return undefined;
	}
	return {
		invert: globalMatch[1] === "v" || globalMatch[1] === "vglobal" || globalMatch[1]?.endsWith("!") === true,
		pattern: globalMatch[3] ?? "",
		command: (globalMatch[4] ?? "d").trim() || "d",
	};
}

function matchDestinationCommand(rest: string, prefixes: readonly string[]): string | undefined {
	for (const prefix of prefixes) {
		if (!rest.startsWith(prefix)) {
			continue;
		}
		const suffix = rest.slice(prefix.length);
		if (suffix.length === 0) {
			return "";
		}
		if (/^\s/.test(suffix) || /^[\d.$+-]/.test(suffix)) {
			return suffix.trim();
		}
	}
	return undefined;
}

export function parseExCommand(input: string, context?: VimExParseContext): VimExCommand {
	const trimmed = input.trim();
	const normalized = trimmed.startsWith(":") ? trimmed.slice(1).trimStart() : trimmed;
	if (normalized.length === 0) {
		throw new VimInputError("Empty ex command");
	}

	if (/^\d+$/.test(normalized)) {
		return {
			kind: "goto-line",
			line: Number.parseInt(normalized, 10),
		};
	}

	if (normalized === "w" || normalized === "write") {
		return { kind: "write", force: false };
	}
	if (normalized === "w!" || normalized === "write!") {
		return { kind: "write", force: true };
	}
	if (normalized === "update" || normalized === "up") {
		return { kind: "update", force: false };
	}
	if (normalized === "update!" || normalized === "up!") {
		return { kind: "update", force: true };
	}
	if (normalized === "wq" || normalized === "x" || normalized === "xit" || normalized === "exit") {
		return { kind: "write-quit", force: false };
	}
	if (normalized === "wq!" || normalized === "x!" || normalized === "xit!" || normalized === "exit!") {
		return { kind: "write-quit", force: true };
	}
	if (normalized === "q" || normalized === "quit") {
		return { kind: "quit", force: false };
	}
	if (normalized === "q!" || normalized === "quit!") {
		return { kind: "quit", force: true };
	}
	if (normalized === "e" || normalized === "edit") {
		return { kind: "edit", force: false };
	}
	if (normalized === "e!" || normalized === "edit!") {
		return { kind: "edit", force: true };
	}
	if (normalized.startsWith("e ") || normalized.startsWith("edit ")) {
		const path = normalized.startsWith("edit ") ? normalized.slice(5).trim() : normalized.slice(2).trim();
		return { kind: "edit", force: false, path };
	}
	if (normalized.startsWith("e! ") || normalized.startsWith("edit! ")) {
		const path = normalized.startsWith("edit! ") ? normalized.slice(6).trim() : normalized.slice(3).trim();
		return { kind: "edit", force: true, path };
	}

	const global = matchGlobalCommand(normalized);
	if (global) {
		return { kind: "global", ...global };
	}

	const { range, rest } = parseLineRange(normalized, context);
	if (range && rest.length === 0) {
		if (range === "all") {
			throw new VimInputError(":% requires a following command");
		}
		return {
			kind: "goto-line",
			line: range.start,
		};
	}

	const rangedGlobal = matchGlobalCommand(rest);
	if (rangedGlobal) {
		return { kind: "global", range, ...rangedGlobal };
	}

	if (rest === "sort" || rest.startsWith("sort ") || rest.startsWith("sort!")) {
		const flags = rest.slice(4).trim();
		return { kind: "sort", range: range ?? undefined, flags };
	}
	if (rest === "j" || rest === "join" || rest === "j!" || rest === "join!") {
		return { kind: "join", range: range ?? undefined, trimWhitespace: !rest.endsWith("!") };
	}

	if (rest.startsWith("substitute")) {
		const segments = parseDelimitedSegments(rest.slice("substitute".length));
		return {
			kind: "substitute",
			range,
			pattern: segments.pattern,
			replacement: segments.replacement,
			flags: segments.flags,
		};
	}

	if (/^s(?:\W|$)/.test(rest)) {
		const segments = parseDelimitedSegments(rest.slice(1));
		return {
			kind: "substitute",
			range,
			pattern: segments.pattern,
			replacement: segments.replacement,
			flags: segments.flags,
		};
	}

	if (
		rest === "d" ||
		rest === "del" ||
		rest === "delete" ||
		rest.startsWith("d ") ||
		rest.startsWith("del ") ||
		rest.startsWith("delete ")
	) {
		return {
			kind: "delete",
			range,
		};
	}

	if (
		rest === "y" ||
		rest === "ya" ||
		rest === "yank" ||
		rest.startsWith("y ") ||
		rest.startsWith("ya ") ||
		rest.startsWith("yank ")
	) {
		return {
			kind: "yank",
			range,
		};
	}

	if (rest === "pu" || rest === "put" || rest === "pu!" || rest === "put!") {
		return {
			kind: "put",
			range,
			before: rest.endsWith("!"),
		};
	}

	const copyDestination = matchDestinationCommand(rest, ["copy", "co", "t"]);
	if (copyDestination !== undefined) {
		const destination = parseDestination(copyDestination, context);
		return { kind: "copy", range, destination };
	}

	const moveDestination = matchDestinationCommand(rest, ["move", "mo", "m"]);
	if (moveDestination !== undefined) {
		const destination = parseDestination(moveDestination, context);
		return { kind: "move", range, destination };
	}

	if (rest === "a" || rest === "append" || rest.startsWith("a ") || rest.startsWith("append ")) {
		const text = rest.startsWith("append") ? rest.slice(6).trimStart() : rest.slice(1).trimStart();
		return { kind: "append", range: range === "all" ? undefined : range, text };
	}

	if (rest === "i" || rest === "insert" || rest.startsWith("i ") || rest.startsWith("insert ")) {
		const text = rest.startsWith("insert") ? rest.slice(6).trimStart() : rest.slice(1).trimStart();
		return { kind: "insert-before", range: range === "all" ? undefined : range, text };
	}

	throw new VimInputError(`Unsupported ex command: ${input}.`);
}
