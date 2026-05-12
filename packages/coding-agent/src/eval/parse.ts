import { sniffEvalLanguage } from "./sniff";
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
	/**
	 * True when the parser encountered `*** Abort` (recovery sentinel emitted
	 * by the agent loop's harmony-leak mitigation; see
	 * `docs/ERRATA-GPT5-HARMONY.md`). The cell containing the marker, if any,
	 * is dropped — its body is incomplete and unsafe to execute.
	 */
	aborted?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LANGUAGE: EvalLanguage = "python";

/**
 * Canonical language tokens plus common long-form aliases. The grammar
 * advertises only `PY` / `JS` / `TS`, but unconstrained models reach for
 * `Python` / `JavaScript` / `TypeScript` often enough that we accept them.
 */
const LANGUAGE_MAP: Record<string, EvalLanguage> = {
	PY: "python",
	PYTHON: "python",
	IPY: "python",
	IPYTHON: "python",
	JS: "js",
	JAVASCRIPT: "js",
	TS: "js",
	TYPESCRIPT: "js",
};

// Markers are case-insensitive, accept ≥2 leading stars (so `**Cell` and
// `*** Cell` both work), and tolerate any whitespace (including tabs)
// between tokens. Models that can't constrain-sample frequently emit minor
// variations like `**End` or `*** cell py`.
const STARS = String.raw`\*{2,}`;
// Cell header: `*** Cell <attrs...>`. The remainder of the line is captured
// and tokenized separately so we can handle quoted values.
const CELL_RE = new RegExp(`^${STARS}\\s*Cell\\b\\s*(.*)$`, "i");
// `*** End` is a tolerated cell/file terminator. Documented as required at
// the file level in the lark grammar (the trailing `*** End` quirks GPT-
// trained models naturally produce), but optional at the parser level.
const END_RE = new RegExp(`^${STARS}\\s*End\\b.*$`, "i");
// `*** Abort` is the harmony-leak recovery sentinel; see ABORT_WARNING.
const ABORT_RE = new RegExp(`^${STARS}\\s*Abort\\s*$`, "i");

/**
 * Warning text appended to the eval tool result when parsing terminated on
 * `*** Abort`. Tells the model that earlier cells (if any) ran normally and
 * that any aborted cell needs to be re-issued.
 */
export const ABORT_WARNING =
	"Tool stream truncated mid-call due to detected output corruption. Earlier cells (if any) executed normally; their state persists. Re-issue the aborted cell.";

const DURATION_RE = /^(\d+)(ms|s|m)?$/i;

function resolveLang(token: string | undefined): EvalLanguage | undefined {
	return token ? LANGUAGE_MAP[token.toUpperCase()] : undefined;
}

function parseDurationMs(raw: string, lineNumber: number): number {
	const match = DURATION_RE.exec(raw.trim());
	if (!match) {
		throw new Error(
			`Eval line ${lineNumber}: invalid duration \`${raw}\`; use a number with optional ms, s, or m units.`,
		);
	}
	const value = Number.parseInt(match[1], 10);
	const unit = (match[2] ?? "s").toLowerCase();
	if (unit === "ms") return value;
	if (unit === "s") return value * 1000;
	return value * 60_000;
}

// Markdown fence wrapping a single bare cell, e.g. "```py\n...\n```" or
// "```\n...\n```". Used by models that wrap eval input in code fences.
const FENCE_OPEN_RE = /^```\s*([A-Za-z]\w*)?\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;

/**
 * Last-resort fallback when the input has no recognizable `*** Cell` header.
 * Models that can't constrain-sample sometimes pass bare code or wrap it in
 * a markdown fence (```py / ```python / bare ```). Treat the whole input as
 * a single implicit cell, sniffing the language from the body.
 */
function parseImplicitCell(lines: string[]): ParsedEvalCell {
	let body = lines.slice();
	while (body.length > 0 && body[0].trim() === "") body.shift();
	while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();

	let fenceLang: string | undefined;
	if (body.length >= 2) {
		const open = FENCE_OPEN_RE.exec(body[0]);
		const closeIdx = body.length - 1;
		if (open && FENCE_CLOSE_RE.test(body[closeIdx])) {
			fenceLang = open[1];
			body = body.slice(1, closeIdx);
		}
	}

	const code = body.join("\n");
	const explicitLanguage = resolveLang(fenceLang);
	const language = explicitLanguage ?? sniffEvalLanguage(code) ?? DEFAULT_LANGUAGE;
	return {
		index: 0,
		title: undefined,
		code,
		language,
		languageOrigin: explicitLanguage ? "header" : "default",
		timeoutMs: DEFAULT_TIMEOUT_MS,
		reset: false,
	};
}

/**
 * Tokenize a `*** Cell` header's attribute list while preserving quoted
 * segments (`id:"some title"`, `py:"hi"`, single quotes too) as single
 * tokens. Outer whitespace separates tokens; the quote characters
 * themselves are kept verbatim so attribute parsing can strip them later.
 */
function tokenizeCellAttrs(input: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < input.length) {
		while (i < input.length && /\s/.test(input[i])) i++;
		if (i >= input.length) break;
		let token = "";
		while (i < input.length && !/\s/.test(input[i])) {
			const ch = input[i];
			if (ch === '"' || ch === "'") {
				token += ch;
				i++;
				while (i < input.length && input[i] !== ch) {
					token += input[i];
					i++;
				}
				if (i < input.length) {
					token += input[i];
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

interface CellHeader {
	language: EvalLanguage | undefined;
	languageOrigin: EvalLanguageOrigin;
	title: string | undefined;
	timeoutMs: number | undefined;
	reset: boolean;
}

/**
 * Map an attribute key (from `key:value` or bare `key`) to one of the three
 * canonical roles. Canonical keys: `id`, `t`, `rst`. Fallback aliases —
 * accepted but not advertised in the prompt — cover common synonyms LLMs
 * reach for instead of the short canonical.
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

// `key:value` form. `value` may be `"..."`, `'...'`, or a bare run.
const ATTR_TOKEN_RE = /^([a-zA-Z][\w-]*)(?::(?:"([^"]*)"|'([^']*)'|(.*)))?$/;
// Bare positional duration (lenient — `t:` is canonical).
const DURATION_TOKEN_RE = /^\d+(?:ms|s|m)?$/;

function parseBooleanFlag(value: string): boolean | undefined {
	const v = value.trim().toLowerCase();
	if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
	if (v === "false" || v === "0" || v === "no" || v === "off") return false;
	return undefined;
}

/**
 * Decode a `*** Cell` header's attribute list into language, title,
 * timeout, and reset flag.
 *
 * Token forms (all optional, any order):
 *   - `py` / `js` / `ts`                       bare language
 *   - `py:"..."` / `js:"..."` / `ts:"..."`     language + title shorthand
 *   - `id:"..."`                               cell title (canonical)
 *   - `t:<duration>`                           per-cell timeout (canonical)
 *   - `<duration>` (e.g. `30s`)                bare positional duration
 *   - `rst`                                    reset flag (canonical)
 *   - `rst:true|false|1|0|yes|no|on|off`       reset flag with explicit value
 *
 * Fallback aliases (accepted but not advertised in the prompt):
 *   - id:  title, name, cell, file, label
 *   - t:   timeout, duration, time
 *   - rst: reset
 *
 * Quotes may be `"` or `'`. Truly unknown keys are silently dropped. First
 * occurrence wins when a key is repeated (canonical or alias). Anything
 * that doesn't classify accumulates as a positional title fragment joined
 * by spaces.
 */
function parseCellHeader(rest: string, lineNumber: number): CellHeader {
	const tokens = tokenizeCellAttrs(rest);
	let language: EvalLanguage | undefined;
	let titleAttr: string | undefined;
	let positionalDurationMs: number | undefined;
	let tAttr: string | undefined;
	let rstAttr: string | undefined;
	let bareReset = false;
	const titleParts: string[] = [];

	for (const token of tokens) {
		// Bare reset flag (canonical or alias).
		if (RST_KEYS.has(token.toLowerCase())) {
			bareReset = true;
			continue;
		}

		const attrMatch = ATTR_TOKEN_RE.exec(token);
		if (attrMatch && token.includes(":")) {
			const key = attrMatch[1].toLowerCase();
			const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";

			// Language-with-title shorthand: `py:"foo"`, `js:'bar'`, etc.
			const langCandidate = resolveLang(key);
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
		const lang = resolveLang(token);
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

	let reset = false;
	if (rstAttr !== undefined) {
		const parsed = parseBooleanFlag(rstAttr);
		if (parsed === undefined) {
			throw new Error(`Eval line ${lineNumber}: invalid rst value \`${rstAttr}\`; use true or false.`);
		}
		reset = parsed;
	} else if (bareReset) {
		reset = true;
	}

	return {
		language,
		languageOrigin: language ? "header" : "default",
		title,
		timeoutMs,
		reset,
	};
}

export function parseEvalInput(input: string): ParsedEvalInput {
	const normalized = input.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	const cells: ParsedEvalCell[] = [];
	let aborted = false;
	let i = 0;

	// Skip leading blank lines.
	while (i < lines.length && lines[i].trim() === "") i++;

	// Lenient fallback: if the input has no recognizable cell header, treat
	// the entire input as one implicit cell — unless that content contains
	// `*** Abort`, in which case the body is incomplete/unsafe and we drop it.
	if (i < lines.length && !CELL_RE.test(lines[i])) {
		const tail = lines.slice(i);
		if (tail.some(line => ABORT_RE.test(line))) {
			return { cells, aborted: true };
		}
		const cell = parseImplicitCell(tail);
		if (cell.code.length > 0) cells.push(cell);
		return { cells };
	}

	while (i < lines.length) {
		const headerLine = lines[i];
		const cellMatch = CELL_RE.exec(headerLine);
		if (!cellMatch) {
			// Stray content between/after cells (blank lines were already
			// consumed). `*** Abort` here terminates parsing; `*** End` is
			// the optional file-level terminator (silently consumed). Anything
			// else — typically a harmony-leak fragment — is skipped.
			if (ABORT_RE.test(headerLine)) {
				aborted = true;
				break;
			}
			i++;
			continue;
		}
		const header = parseCellHeader(cellMatch[1] ?? "", i + 1);
		i++;

		// Collect cell body. Close on `*** End` (any form), the next
		// `*** Cell` header, or `*** Abort` (which drops the in-progress
		// cell as its body is partial and unsafe to run).
		const codeLines: string[] = [];
		let cellAborted = false;
		while (i < lines.length) {
			const line = lines[i];
			if (ABORT_RE.test(line)) {
				cellAborted = true;
				aborted = true;
				i++;
				break;
			}
			if (END_RE.test(line)) {
				i++;
				break;
			}
			if (CELL_RE.test(line)) break;
			codeLines.push(line);
			i++;
		}

		if (cellAborted) break;

		// Strip trailing blank lines so visual spacing between cells doesn't
		// leak into the preceding cell's code.
		while (codeLines.length > 0 && codeLines[codeLines.length - 1].trim() === "") {
			codeLines.pop();
		}
		const code = codeLines.join("\n");

		const language = header.language ?? sniffEvalLanguage(code) ?? DEFAULT_LANGUAGE;
		const languageOrigin: EvalLanguageOrigin = header.language ? "header" : "default";

		cells.push({
			index: cells.length,
			title: header.title,
			code,
			language,
			languageOrigin,
			timeoutMs: header.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			reset: header.reset,
		});

		// Skip blank separator lines between cells; an `*** Abort` here
		// terminates parsing while keeping previously-collected cells.
		while (i < lines.length && lines[i].trim() === "") i++;
		if (i < lines.length && ABORT_RE.test(lines[i])) {
			aborted = true;
			break;
		}
	}

	return aborted ? { cells, aborted: true } : { cells };
}
