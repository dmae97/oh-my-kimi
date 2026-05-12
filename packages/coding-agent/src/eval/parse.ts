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

// Markers are case-insensitive, accept ≥2 leading stars (so `**Begin` and
// `*** Begin` both work), and tolerate any whitespace (including tabs)
// between tokens. Models that can't constrain-sample frequently emit minor
// variations like `**End`, `*** end py`, or `***\tTitle: foo`.
const STARS = String.raw`\*{2,}`;
const BEGIN_RE = new RegExp(`^${STARS}\\s*Begin\\b\\s*(\\S+)?\\s*$`, "i");
const END_RE = new RegExp(`^${STARS}\\s*End\\b.*$`, "i");
const TITLE_RE = new RegExp(`^${STARS}\\s*Title\\s*:\\s*(.+?)\\s*$`, "i");
const TIMEOUT_RE = new RegExp(`^${STARS}\\s*Timeout\\s*:\\s*(\\S+)\\s*$`, "i");
const RESET_RE = new RegExp(`^${STARS}\\s*Reset\\s*$`, "i");
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
 * Last-resort fallback when the input has no recognizable `*** Begin` header.
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

export function parseEvalInput(input: string): ParsedEvalInput {
	const normalized = input.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	const cells: ParsedEvalCell[] = [];
	let aborted = false;
	let i = 0;

	// Skip leading blank lines.
	while (i < lines.length && lines[i].trim() === "") i++;

	// Lenient fallback: if the input has no recognizable begin marker, treat
	// the entire input as one implicit cell — unless that content contains
	// `*** Abort`, in which case the body is incomplete/unsafe and we drop it.
	if (i < lines.length && !BEGIN_RE.test(lines[i])) {
		const tail = lines.slice(i);
		if (tail.some(line => ABORT_RE.test(line))) {
			return { cells, aborted: true };
		}
		const cell = parseImplicitCell(tail);
		if (cell.code.length > 0) cells.push(cell);
		return { cells };
	}

	while (i < lines.length) {
		const beginMatch = BEGIN_RE.exec(lines[i]);
		if (!beginMatch) {
			// Stray content between/after cells (blank lines were already
			// consumed). `*** Abort` here terminates parsing; anything else
			// — typically a harmony-leak fragment or model garbage — is
			// skipped rather than crashing the parser.
			if (ABORT_RE.test(lines[i])) {
				aborted = true;
				break;
			}
			i++;
			continue;
		}
		const langToken = beginMatch[1];
		const explicitLanguage = resolveLang(langToken);
		i++;

		let title: string | undefined;
		let timeoutMs: number | undefined;
		let reset = false;

		while (i < lines.length) {
			const line = lines[i];
			const lineNumber = i + 1;
			const titleMatch = TITLE_RE.exec(line);
			if (titleMatch) {
				if (title === undefined) title = titleMatch[1];
				i++;
				continue;
			}
			const timeoutMatch = TIMEOUT_RE.exec(line);
			if (timeoutMatch) {
				if (timeoutMs === undefined) timeoutMs = parseDurationMs(timeoutMatch[1], lineNumber);
				i++;
				continue;
			}
			if (RESET_RE.test(line)) {
				reset = true;
				i++;
				continue;
			}
			break;
		}

		// Collect cell body. Close on `*** End` OR on the next `*** Begin`
		// (implicit end — leniency for models that drop end markers between
		// back-to-back cells). `*** Abort` (recovery sentinel) drops the
		// in-progress cell entirely: its body is partial and unsafe to run.
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
			if (BEGIN_RE.test(line)) break;
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

		const language = explicitLanguage ?? sniffEvalLanguage(code) ?? DEFAULT_LANGUAGE;
		const languageOrigin: EvalLanguageOrigin = explicitLanguage ? "header" : "default";

		cells.push({
			index: cells.length,
			title,
			code,
			language,
			languageOrigin,
			timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
			reset,
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
