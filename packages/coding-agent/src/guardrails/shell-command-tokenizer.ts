import { hasActiveShellNameGlob } from "./shell-command-name-glob.ts";

const MAX_STATIC_SHELL_INPUT_CHARS = 64 * 1024;
const MAX_STATIC_SHELL_WORDS = 4_096;
type ShellQuote = '"' | "'";
export interface ShellSourceRange {
	readonly start: number;
	readonly end: number;
	readonly contentEnd: number;
	readonly quoteStart?: number;
	readonly kind: "literal" | "variable";
	readonly escaped: boolean;
}
export interface StaticShellWord {
	readonly start: number;
	readonly end: number;
}
export interface StaticShellVariable {
	readonly start: number;
	readonly end: number;
	readonly sourceStart: number;
	readonly sourceEnd: number;
}
export interface NormalizedStaticShell {
	readonly text: string;
	readonly sources: readonly ShellSourceRange[];
	readonly words: readonly StaticShellWord[];
	readonly variables: readonly StaticShellVariable[];
}
export class StaticShellSyntaxError extends Error {
	constructor() {
		super("shell command is dynamic or malformed; failing closed");
		this.name = "StaticShellSyntaxError";
	}
}
function fail(): never {
	throw new StaticShellSyntaxError();
}
function isWordBoundary(character: string): boolean {
	return /[\s;&|()<>]/.test(character);
}

function variableAt(text: string, index: number): string | undefined {
	const remainder = text.slice(index);
	return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}/.exec(remainder)?.[0] ?? /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(remainder)?.[0];
}

function isBraceExpansion(text: string, index: number): boolean {
	const close = text.indexOf("}", index + 1);
	if (close < 0) return false;
	const body = text.slice(index + 1, close);
	return body.includes(",") || body.includes("..");
}

export function normalizeStaticShell(text: string): NormalizedStaticShell {
	if (text.length > MAX_STATIC_SHELL_INPUT_CHARS || text.includes("`") || text.includes("<(") || text.includes(">("))
		fail();
	const output: string[] = [];
	const sources: ShellSourceRange[] = [];
	const words: StaticShellWord[] = [];
	const variables: StaticShellVariable[] = [];
	const append = (
		character: string,
		start: number,
		end: number,
		kind: ShellSourceRange["kind"],
		escaped: boolean,
		quoteStart?: number,
	): void => {
		output.push(character);
		sources.push({ start, end, contentEnd: end, kind, escaped, ...(quoteStart === undefined ? {} : { quoteStart }) });
	};
	let index = 0;
	while (index < text.length) {
		if (isWordBoundary(text[index])) {
			append(text[index], index, index + 1, "literal", false);
			index++;
			continue;
		}
		if (words.length >= MAX_STATIC_SHELL_WORDS) fail();
		const wordStart = output.length;
		let quote: ShellQuote | undefined;
		let quoteStart: number | undefined;
		let pendingStart = index;
		let lastSource = -1;
		while (index < text.length && (quote !== undefined || !isWordBoundary(text[index]))) {
			const character = text[index];
			if (quote === "'") {
				if (character === "'") {
					if (lastSource >= wordStart) sources[lastSource] = { ...sources[lastSource], end: index + 1 };
					quote = undefined;
					quoteStart = undefined;
					index++;
					pendingStart = index;
					continue;
				}
				append(character, pendingStart, index + 1, "literal", false, quoteStart);
				lastSource = sources.length - 1;
				index++;
				pendingStart = index;
				continue;
			}
			if (quote === '"' && character === '"') {
				if (lastSource >= wordStart) sources[lastSource] = { ...sources[lastSource], end: index + 1 };
				quote = undefined;
				quoteStart = undefined;
				index++;
				pendingStart = index;
				continue;
			}
			if (character === "\\") {
				const next = text[index + 1];
				if (next === undefined) fail();
				if (next === "\n") {
					index += 2;
					pendingStart = index;
					continue;
				}
				if (quote === '"' && !'\\"$'.includes(next)) {
					append(character, pendingStart, index + 1, "literal", false, quoteStart);
					lastSource = sources.length - 1;
					index++;
					pendingStart = index;
					continue;
				}
				append(next, pendingStart, index + 2, "literal", true, quoteStart);
				lastSource = sources.length - 1;
				index += 2;
				pendingStart = index;
				continue;
			}
			if (quote === undefined && (character === '"' || character === "'")) {
				quote = character;
				quoteStart = index;
				index++;
				pendingStart = index;
				continue;
			}
			if (character === "$") {
				if (text[index + 1] === "(") fail();
				const token = variableAt(text, index);
				if (token === undefined) fail();
				const normalizedStart = output.length;
				for (let offset = 0; offset < token.length; offset++) {
					append(
						token[offset],
						offset === 0 ? pendingStart : index + offset,
						index + offset + 1,
						"variable",
						false,
						quoteStart,
					);
					lastSource = sources.length - 1;
				}
				variables.push({
					start: normalizedStart,
					end: output.length,
					sourceStart: index,
					sourceEnd: index + token.length,
				});
				index += token.length;
				pendingStart = index;
				continue;
			}
			if (quote === undefined && character === "{" && isBraceExpansion(text, index)) fail();
			append(character, pendingStart, index + 1, "literal", false, quoteStart);
			lastSource = sources.length - 1;
			index++;
			pendingStart = index;
		}
		if (quote !== undefined) fail();
		words.push({ start: wordStart, end: output.length });
	}
	const shell = { text: output.join(""), sources, words, variables };
	if (hasActiveShellNameGlob(shell)) fail();
	return shell;
}
