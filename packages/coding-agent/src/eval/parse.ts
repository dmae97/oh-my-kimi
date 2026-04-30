import type { EvalLanguage } from "./types";

export type EvalLanguageOrigin = "default" | "fence";

export interface ParsedEvalCell {
	index: number;
	title?: string;
	code: string;
	language: EvalLanguage;
	languageOrigin: EvalLanguageOrigin;
	timeoutMs: number;
	reset: boolean;
}

export interface ParsedEvalInput {
	cells: ParsedEvalCell[];
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Canonical fenced-language tokens we map onto our two backends. Matched
 * case-insensitively. Anything else found in a fence info string is treated as
 * a title fragment rather than a language; this is intentional fallback
 * behaviour and MUST NOT be advertised in the tool's prompt — the lark grammar
 * describes the canonical surface we encourage callers to emit.
 */
const LANGUAGE_ALIASES: Record<string, EvalLanguage> = {
	py: "python",
	python: "python",
	ipy: "python",
	ipython: "python",
	js: "js",
	javascript: "js",
	ts: "js",
	typescript: "js",
};

function resolveLanguageAlias(token: string): EvalLanguage | undefined {
	return LANGUAGE_ALIASES[token.toLowerCase()];
}

/**
 * Map an attribute key (from `key=value` in a fence info string) to one of
 * the three canonical roles. Canonical keys: `id`, `t`, `rst`. Fallback
 * aliases — accepted but not advertised in the prompt — cover common
 * synonyms the LLM is likely to reach for instead of the short canonical.
 */
const ID_KEYS = new Set(["id", "title", "name", "cell", "file", "label"]);
const T_KEYS = new Set(["t", "timeout", "duration", "time"]);
const RST_KEYS = new Set(["rst", "reset"]);

function classifyAttrKey(key: string): "id" | "t" | "rst" | null {
	if (ID_KEYS.has(key)) return "id";
	if (T_KEYS.has(key)) return "t";
	if (RST_KEYS.has(key)) return "rst";
	return null;
}

interface RawBlock {
	type: "raw";
	lines: string[];
	startLine: number;
}

interface FencedBlock {
	type: "fenced";
	info: string;
	codeLines: string[];
	startLine: number;
}

type Block = RawBlock | FencedBlock;

interface FenceInfo {
	language?: EvalLanguage;
	title?: string;
	timeoutMs?: number;
	reset?: boolean;
}

const ATTR_TOKEN_RE = /^([a-zA-Z][\w-]*)=(?:"([^"]*)"|'([^']*)'|(.*))$/;
const DURATION_TOKEN_RE = /^\d+(?:ms|s|m)?$/;

function parseDurationMs(raw: string, lineNumber: number): number {
	const match = /^(\d+)(ms|s|m)?$/.exec(raw.trim());
	if (!match) {
		throw new Error(
			`Eval line ${lineNumber}: invalid duration \`${raw}\`; use a number with optional ms, s, or m units.`,
		);
	}
	const value = Number.parseInt(match[1], 10);
	const unit = match[2] ?? "s";
	if (unit === "ms") return value;
	if (unit === "s") return value * 1000;
	return value * 60_000;
}

function parseBoolean(value: string): boolean | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
	if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
	return undefined;
}

function trimOuterBlankLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") start++;
	while (end > start && lines[end - 1].trim() === "") end--;
	return lines.slice(start, end);
}

function parseFenceOpener(line: string): { char: "`" | "~"; count: number; info: string } | null {
	const opener = /^(`{3,}|~{3,})(.*)$/.exec(line);
	if (!opener) return null;
	const run = opener[1];
	return { char: run[0] as "`" | "~", count: run.length, info: opener[2].trim() };
}

function isFenceCloser(line: string, char: "`" | "~", minCount: number): boolean {
	let count = 0;
	while (count < line.length && line[count] === char) count++;
	if (count < minCount) return false;
	return line.slice(count).trim() === "";
}

/**
 * Tokenize a fence info string while preserving content inside matching
 * single or double quotes as a single token. The opening and closing quote
 * characters are kept verbatim so attribute parsing can strip them later.
 */
function tokenizeInfoString(info: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < info.length) {
		while (i < info.length && /\s/.test(info[i])) i++;
		if (i >= info.length) break;
		let token = "";
		while (i < info.length && !/\s/.test(info[i])) {
			const ch = info[i];
			if (ch === '"' || ch === "'") {
				token += ch;
				i++;
				while (i < info.length && info[i] !== ch) {
					token += info[i];
					i++;
				}
				if (i < info.length) {
					token += info[i];
					i++;
				}
			} else {
				token += ch;
				i++;
			}
		}
		tokens.push(token);
	}
	return tokens;
}

/**
 * Decode a fence info string into language, title, timeout, and reset flag.
 *
 * Layout (positional → kv, all optional):
 *   `<lang>? <duration>? <(title-fragment | key=value)>*`
 *
 * Canonical attribute keys (the only ones surfaced in the lark grammar):
 *   - `id`  → cell title
 *   - `t`   → per-cell timeout
 *   - `rst` → boolean reset for this cell's kernel
 *
 * Lenient fallback aliases (NOT advertised in the prompt; we silently accept
 * them when the LLM reaches for a more familiar key):
 *   - id:  title, name, cell, file, label
 *   - t:   timeout, duration, time
 *   - rst: reset
 *
 * Truly unknown keys are silently dropped. First occurrence wins when a key
 * is repeated (canonical or alias).
 *
 * - First token is consumed as a language alias when it matches one; otherwise
 *   it falls through to the title-fragment branch and the cell inherits the
 *   surrounding language.
 * - The first remaining duration-shaped token (e.g. `15s`, `500ms`, `2m`,
 *   `30`) becomes the positional timeout. The `t=` attribute always wins.
 * - Anything else accumulates as positional title fragments joined by spaces.
 */
function parseFenceInfo(info: string, lineNumber: number): FenceInfo {
	const tokens = tokenizeInfoString(info.trim());
	if (tokens.length === 0) return {};

	let language: EvalLanguage | undefined;
	let positionalDurationMs: number | undefined;
	const titleParts: string[] = [];
	let idAttr: string | undefined;
	let tAttr: string | undefined;
	let rstAttr: string | undefined;

	for (let idx = 0; idx < tokens.length; idx++) {
		const token = tokens[idx];
		const attrMatch = ATTR_TOKEN_RE.exec(token);
		if (attrMatch) {
			const key = attrMatch[1].toLowerCase();
			const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";
			const role = classifyAttrKey(key);
			if (role === "id" && idAttr === undefined) idAttr = value;
			else if (role === "t" && tAttr === undefined) tAttr = value;
			else if (role === "rst" && rstAttr === undefined) rstAttr = value;
			// unknown / repeated keys silently dropped
			continue;
		}
		if (idx === 0) {
			const lang = resolveLanguageAlias(token);
			if (lang) {
				language = lang;
				continue;
			}
		}
		if (positionalDurationMs === undefined && DURATION_TOKEN_RE.test(token)) {
			positionalDurationMs = parseDurationMs(token, lineNumber);
			continue;
		}
		titleParts.push(token);
	}

	const explicitTitle = (idAttr ?? "").trim();
	const positionalTitle = titleParts.join(" ").trim();
	const title = explicitTitle.length > 0 ? explicitTitle : positionalTitle.length > 0 ? positionalTitle : undefined;

	let timeoutMs: number | undefined;
	if (tAttr !== undefined) {
		timeoutMs = parseDurationMs(tAttr, lineNumber);
	} else if (positionalDurationMs !== undefined) {
		timeoutMs = positionalDurationMs;
	}

	let reset: boolean | undefined;
	if (rstAttr !== undefined) {
		const parsed = parseBoolean(rstAttr);
		if (parsed === undefined) {
			throw new Error(`Eval line ${lineNumber}: invalid rst value \`${rstAttr}\`; use true or false.`);
		}
		reset = parsed;
	}

	return { language, title, timeoutMs, reset };
}

/**
 * Walk normalized lines and split into top-level fenced blocks and raw
 * (between/around fences) blocks. Unclosed fences are leniently closed at
 * end-of-input. Raw blocks with only blank lines are dropped.
 */
function splitIntoBlocks(lines: string[]): Block[] {
	const blocks: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const opener = parseFenceOpener(line);
		if (opener) {
			const fenceStart = i + 1; // 1-indexed line number of opener
			const codeLines: string[] = [];
			let j = i + 1;
			let closed = false;
			while (j < lines.length) {
				if (isFenceCloser(lines[j], opener.char, opener.count)) {
					closed = true;
					break;
				}
				codeLines.push(lines[j]);
				j++;
			}
			blocks.push({ type: "fenced", info: opener.info, codeLines, startLine: fenceStart });
			i = closed ? j + 1 : j;
		} else {
			const rawStart = i + 1;
			const rawLines: string[] = [line];
			let j = i + 1;
			while (j < lines.length && !parseFenceOpener(lines[j])) {
				rawLines.push(lines[j]);
				j++;
			}
			const trimmed = trimOuterBlankLines(rawLines);
			if (trimmed.length > 0) {
				blocks.push({ type: "raw", lines: trimmed, startLine: rawStart });
			}
			i = j;
		}
	}
	return blocks;
}

interface ExpansionState {
	language: EvalLanguage;
	languageOrigin: EvalLanguageOrigin;
}

export function parseEvalInput(input: string): ParsedEvalInput {
	const normalized = input.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	const blocks = splitIntoBlocks(lines);

	const state: ExpansionState = { language: "python", languageOrigin: "default" };
	const cells: ParsedEvalCell[] = [];
	for (const block of blocks) {
		if (block.type === "raw") {
			cells.push({
				index: cells.length,
				title: undefined,
				code: block.lines.join("\n"),
				language: state.language,
				languageOrigin: state.languageOrigin,
				timeoutMs: DEFAULT_TIMEOUT_MS,
				reset: false,
			});
			continue;
		}
		const fence = parseFenceInfo(block.info, block.startLine);
		const language = fence.language ?? state.language;
		const languageOrigin: EvalLanguageOrigin = fence.language ? "fence" : state.languageOrigin;
		cells.push({
			index: cells.length,
			title: fence.title,
			code: block.codeLines.join("\n"),
			language,
			languageOrigin,
			timeoutMs: fence.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			reset: fence.reset ?? false,
		});
		state.language = language;
		state.languageOrigin = languageOrigin;
	}

	return { cells };
}
