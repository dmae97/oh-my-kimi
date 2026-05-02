import type { EvalLanguage } from "./types";

export type EvalLanguageOrigin = "default" | "header";

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
 * Canonical language tokens we map onto our two backends. Matched
 * case-insensitively. Unknown tokens are treated as title fragments rather
 * than languages; this is intentional fallback behaviour and MUST NOT be
 * advertised in the tool's prompt — the lark grammar describes the
 * canonical surface we encourage callers to emit.
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
 * Map an attribute key (from `key:value` or bare `key` in a header) to one
 * of the three canonical roles. Canonical keys: `id`, `t`, `rst`. Fallback
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

interface HeaderInfo {
	language?: EvalLanguage;
	title?: string;
	timeoutMs?: number;
	reset?: boolean;
}

/**
 * Match a header line: `={5,} <info>? ={5,}`. Both bars MUST be on the
 * same line and each MUST be at least five equal signs (lengths need not
 * match — a 5/6 split is fine).
 */
const HEADER_RE = /^={5,}([^=].*?)?={5,}\s*$/;
const EMPTY_HEADER_RE = /^={5,}\s*$/;

const ATTR_TOKEN_RE = /^([a-zA-Z][\w-]*)(?::(?:"([^"]*)"|'([^']*)'|(.*)))?$/;
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

/**
 * Detect whether a line is a cell header. Returns the info string between
 * the two bar runs (trimmed) when it is, or `null` otherwise. An empty
 * header (`===== =====` or just `=====`) yields an empty info string.
 *
 * A line that contains text but only one bar (e.g. `===== title`) is NOT
 * a header — it's normal code that happens to start with equal signs.
 */
function parseHeaderLine(line: string): string | null {
	if (EMPTY_HEADER_RE.test(line)) return "";
	const match = HEADER_RE.exec(line);
	if (!match) return null;
	return (match[1] ?? "").trim();
}

/**
 * Tokenize a header info string while preserving content inside matching
 * single or double quotes as a single token. The opening and closing
 * quote characters are kept verbatim so attribute parsing can strip them
 * later.
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
 * Decode a header info string into language, title, timeout, and reset flag.
 *
 * Token forms (all optional, any order):
 *   - `py` / `js` / `ts`              bare language
 *   - `py:"..."` / `js:"..."` / `ts:"..."`  language + title shorthand
 *   - `id:"..."`                      cell title
 *   - `t:<duration>`                  per-cell timeout
 *   - `<duration>`                    bare positional duration (lenient)
 *   - `rst`                           reset flag
 *   - `rst:true|false`                reset flag with explicit value
 *
 * Fallback aliases (accepted but not advertised in the prompt):
 *   - id:  title, name, cell, file, label
 *   - t:   timeout, duration, time
 *   - rst: reset
 *
 * Truly unknown keys are silently dropped. First occurrence wins when a
 * key is repeated (canonical or alias). Anything that doesn't classify
 * accumulates as a positional title fragment joined by spaces.
 */
function parseHeaderInfo(info: string, lineNumber: number): HeaderInfo {
	const tokens = tokenizeInfoString(info);
	if (tokens.length === 0) return {};

	let language: EvalLanguage | undefined;
	let titleAttr: string | undefined;
	let positionalDurationMs: number | undefined;
	let tAttr: string | undefined;
	let rstAttr: string | undefined;
	let bareReset = false;
	const titleParts: string[] = [];

	for (const token of tokens) {
		// Bare reset flag.
		if (RST_KEYS.has(token.toLowerCase())) {
			bareReset = true;
			continue;
		}

		const attrMatch = ATTR_TOKEN_RE.exec(token);
		if (attrMatch && token.includes(":")) {
			const key = attrMatch[1].toLowerCase();
			const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";

			// Language-with-title shorthand: `py:"foo"` etc.
			const langCandidate = resolveLanguageAlias(key);
			if (langCandidate) {
				if (language === undefined) language = langCandidate;
				if (titleAttr === undefined && value !== "") titleAttr = value;
				continue;
			}

			const role = classifyAttrKey(key);
			if (role === "id" && titleAttr === undefined) titleAttr = value;
			else if (role === "t" && tAttr === undefined) tAttr = value;
			else if (role === "rst" && rstAttr === undefined) rstAttr = value;
			// unknown / repeated keys silently dropped
			continue;
		}

		// Bare language token (no colon).
		const lang = resolveLanguageAlias(token);
		if (lang && language === undefined) {
			language = lang;
			continue;
		}

		// Bare positional duration (lenient — `t:` is canonical).
		if (positionalDurationMs === undefined && DURATION_TOKEN_RE.test(token)) {
			positionalDurationMs = parseDurationMs(token, lineNumber);
			continue;
		}

		titleParts.push(token);
	}

	const explicitTitle = (titleAttr ?? "").trim();
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
	} else if (bareReset) {
		reset = true;
	}

	return { language, title, timeoutMs, reset };
}

interface ExpansionState {
	language: EvalLanguage;
	languageOrigin: EvalLanguageOrigin;
}

export function parseEvalInput(input: string): ParsedEvalInput {
	const normalized = input.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	// `split("\n")` produces a trailing empty element when the input ends with
	// a newline. Drop it so we don't emit phantom blank trailing code lines.
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	const state: ExpansionState = { language: "python", languageOrigin: "default" };
	const cells: ParsedEvalCell[] = [];
	let i = 0;

	// Lenient: leading content before any header forms an implicit
	// default-language cell. Drop it if it's only blank lines.
	if (i < lines.length && parseHeaderLine(lines[i]) === null) {
		const buffer: string[] = [];
		while (i < lines.length && parseHeaderLine(lines[i]) === null) {
			buffer.push(lines[i]);
			i++;
		}
		const trimmed = trimOuterBlankLines(buffer);
		if (trimmed.length > 0) {
			cells.push({
				index: cells.length,
				title: undefined,
				code: trimmed.join("\n"),
				language: state.language,
				languageOrigin: state.languageOrigin,
				timeoutMs: DEFAULT_TIMEOUT_MS,
				reset: false,
			});
		}
	}

	while (i < lines.length) {
		const headerInfo = parseHeaderLine(lines[i]);
		if (headerInfo === null) {
			// Loop invariant guarantees this is a header line; guard anyway.
			i++;
			continue;
		}
		const headerLineNumber = i + 1;
		const info = parseHeaderInfo(headerInfo, headerLineNumber);
		i++; // consume header line

		const codeLines: string[] = [];
		while (i < lines.length && parseHeaderLine(lines[i]) === null) {
			codeLines.push(lines[i]);
			i++;
		}
		// Strip trailing blank lines so visual spacing between cells doesn't
		// leak into the preceding cell's code.
		while (codeLines.length > 0 && codeLines[codeLines.length - 1].trim() === "") {
			codeLines.pop();
		}

		const language = info.language ?? state.language;
		const languageOrigin: EvalLanguageOrigin = info.language ? "header" : state.languageOrigin;

		cells.push({
			index: cells.length,
			title: info.title,
			code: codeLines.join("\n"),
			language,
			languageOrigin,
			timeoutMs: info.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			reset: info.reset ?? false,
		});
		state.language = language;
		state.languageOrigin = languageOrigin;
	}

	return { cells };
}
