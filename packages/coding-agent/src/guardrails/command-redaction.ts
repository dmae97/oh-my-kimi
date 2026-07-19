// allow: SIZE_OK - command-string secret policy: single source of truth for credential
// detection, placeholder tokenization, and the internal HMAC key boundary (ALG-003 §7.7).
import type {
	CommandHmacBinding,
	CommandRedactionPlaceholder,
	CommandRedactionPlaceholderType,
	CommandRedactionSummary,
	EvidenceCommandDescriptor,
	Sha256Hex,
} from "../types/evidence.ts";
import {
	type NormalizedStaticShell,
	StaticShellSyntaxError,
	normalizeStaticShell as tokenizeStaticShell,
} from "./shell-command-tokenizer.ts";

/** Identifies the tokenization rules that produced a persisted redacted command. */
export const EVIDENCE_COMMAND_REDACTION_POLICY_ID = "omk-command-redaction-v1" as const;

/** Upper bound for the total number of placeholders in one redacted command. */
export const MAX_COMMAND_REDACTION_PLACEHOLDERS = 256;

const REDACTED = "[REDACTED]";
const KEY_ID_HEX = /^[0-9a-f]{16}$/;
const NONCE_HEX = /^[0-9a-f]{32}$/;
const MAC_HEX = /^[0-9a-f]{64}$/;

const PLACEHOLDER_TYPES: readonly CommandRedactionPlaceholderType[] = Object.freeze([
	"api-key-header",
	"authorization-header",
	"basic-auth",
	"bearer-token",
	"cli-option-inline",
	"cli-option-value",
	"cookie-header",
	"env-assignment",
	"known-token",
	"url-credential",
	"url-query",
]);
const PLACEHOLDER_TYPE_SET: ReadonlySet<string> = new Set(PLACEHOLDER_TYPES);

/** All command redaction failures are static-message errors that never echo command data. */
export class CommandRedactionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommandRedactionError";
	}
}

// ============================================================================
// Structural command-shape validation (paranoid, own-enumerable-data only)
// ============================================================================

function exactObject(
	value: unknown,
	label: string,
	requiredKeys: readonly string[],
	optionalKeys: readonly string[] = [],
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CommandRedactionError(`${label} must be an object`);
	}
	const record = value as Record<string, unknown>;
	const descriptors = Object.getOwnPropertyDescriptors(record);
	const actual = Object.entries(descriptors)
		.filter(([, descriptor]) => descriptor.enumerable)
		.map(([key]) => key)
		.sort();
	const allowed = new Set([...requiredKeys, ...optionalKeys]);
	const isOwnEnumerableDataProperty = (key: string): boolean => {
		const descriptor = descriptors[key];
		return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor;
	};
	if (
		actual.some((key) => !allowed.has(key)) ||
		requiredKeys.some((key) => !isOwnEnumerableDataProperty(key)) ||
		optionalKeys.some((key) => key in record && !isOwnEnumerableDataProperty(key))
	) {
		throw new CommandRedactionError(`${label} has an invalid key set`);
	}
	const snapshot: Record<string, unknown> = {};
	for (const key of actual) {
		const descriptor = descriptors[key];
		if (descriptor === undefined || !("value" in descriptor)) {
			throw new CommandRedactionError(`${label} has an invalid key set`);
		}
		snapshot[key] = descriptor.value;
	}
	return snapshot;
}

function exactArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new CommandRedactionError(`${label} must be an array`);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const lengthDescriptor = descriptors.length as PropertyDescriptor | undefined;
	if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
		throw new CommandRedactionError(`${label} has invalid index properties`);
	}
	const rawLength = lengthDescriptor.value;
	if (!Number.isSafeInteger(rawLength) || (rawLength as number) < 0) {
		throw new CommandRedactionError(`${label} has invalid index properties`);
	}
	const length = rawLength as number;
	const snapshot: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = descriptors[String(index)];
		if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
			throw new CommandRedactionError(`${label} must use own enumerable data index properties`);
		}
		snapshot.push(descriptor.value);
	}
	const enumerableKeys = Object.entries(descriptors)
		.filter(([, descriptor]) => descriptor.enumerable)
		.map(([key]) => key);
	if (enumerableKeys.length !== length || enumerableKeys.some((key, index) => key !== String(index))) {
		throw new CommandRedactionError(`${label} must use own enumerable data index properties`);
	}
	return snapshot;
}

function ownEnumerableDataProperty(record: Record<string, unknown>, label: string, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
		throw new CommandRedactionError(`${label} has an invalid key set`);
	}
	return descriptor.value;
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new CommandRedactionError(`${label} must be a non-empty string without NUL bytes`);
	}
	return value;
}

function stringWithoutNul(value: unknown, label: string): string {
	if (typeof value !== "string" || value.includes("\0")) {
		throw new CommandRedactionError(`${label} must be a string without NUL bytes`);
	}
	return value;
}

function positiveBoundedInteger(value: unknown, label: string, max: number): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) {
		throw new CommandRedactionError(`${label} must be a positive integer within the placeholder bound`);
	}
	return value as number;
}

/** Structure-only parse of a command descriptor; performs no credential policy checks. */
export function parseEvidenceCommandShape(value: unknown): EvidenceCommandDescriptor {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CommandRedactionError("receipt core command must be an object");
	}
	const candidate = value as Record<string, unknown>;
	const kind = ownEnumerableDataProperty(candidate, "command descriptor", "kind");
	if (kind === "argv") {
		const raw = exactObject(value, "argv command descriptor", ["kind", "executable", "argv"]);
		const rawArgv = exactArray(raw.argv, "argv command descriptor argv");
		if (!rawArgv.every((argument) => typeof argument === "string")) {
			throw new CommandRedactionError("argv command descriptor argv must be a string array");
		}
		const executable = nonEmptyString(raw.executable, "argv command executable");
		const argv = rawArgv.map((argument, index) => stringWithoutNul(argument, `argv[${index}]`));
		return Object.freeze({ kind: "argv", executable, argv: Object.freeze(argv) });
	}
	if (kind === "shell") {
		const raw = exactObject(value, "shell command descriptor", ["kind", "shell", "script"]);
		return Object.freeze({
			kind: "shell",
			shell: nonEmptyString(raw.shell, "shell command identity"),
			script: nonEmptyString(raw.script, "shell command script"),
		});
	}
	throw new CommandRedactionError("receipt command kind must be argv or shell");
}

// ============================================================================
// Placeholder recognition
// ============================================================================

function unquote(value: string): string {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function shellCredentialValue(value: string): string {
	const candidate = value.trim();
	if (
		candidate.length >= 2 &&
		((candidate.startsWith('"') && candidate.endsWith('"')) || (candidate.startsWith("'") && candidate.endsWith("'")))
	) {
		return candidate.slice(1, -1);
	}
	if (candidate.endsWith('"') || candidate.endsWith("'")) return candidate.slice(0, -1);
	return candidate;
}

function isCredentialPlaceholder(value: string): boolean {
	const candidate = unquote(shellCredentialValue(value));
	return (
		/^\[(?:REDACTED|MASKED)\]$/i.test(candidate) ||
		/^<(?:redacted|masked)>$/i.test(candidate) ||
		/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(candidate) ||
		/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(candidate)
	);
}

function isAuthorizationPlaceholder(value: string): boolean {
	const candidate = shellCredentialValue(value);
	const scheme = /^(?:bearer|basic)\s+(.+)$/i.exec(candidate);
	return isCredentialPlaceholder(scheme?.[1] ?? candidate);
}

function isBasicAuthPlaceholder(value: string): boolean {
	const candidate = shellCredentialValue(value);
	if (isCredentialPlaceholder(candidate)) return true;
	const separator = candidate.indexOf(":");
	return separator >= 0 && isCredentialPlaceholder(candidate.slice(separator + 1));
}

// ============================================================================
// Header credential scanning (shared by detection and tokenization)
// ============================================================================

type HeaderValueBoundary = "argument" | "shell";

interface HeaderCredentialRule {
	readonly type: "api-key-header" | "authorization-header" | "cookie-header";
	readonly preserveScheme: boolean;
}

function headerCredentialRule(name: string): HeaderCredentialRule | undefined {
	const normalized = name.toLowerCase().replaceAll("_", "-");
	if (normalized === "authorization" || normalized === "proxy-authorization") {
		return { type: "authorization-header", preserveScheme: true };
	}
	if (normalized === "cookie" || normalized === "set-cookie") {
		return { type: "cookie-header", preserveScheme: false };
	}
	if (
		/^(?:x-)?(?:[a-z0-9]+-)*(?:api-key|api-token|auth-token|access-token|security-token|bearer-token|private-key|token)$/.test(
			normalized,
		) ||
		/^x-(?:[a-z0-9]+-)+key$/.test(normalized)
	) {
		return { type: "api-key-header", preserveScheme: false };
	}
	return undefined;
}

interface RedactionSpan {
	readonly start: number;
	readonly end: number;
	readonly type: CommandRedactionPlaceholderType;
	readonly exactArgumentEnd?: boolean;
}

function isHeaderTokenBoundary(character: string): boolean {
	return /[\s,;|()"'`]/.test(character);
}

function isHeaderTokenStart(text: string, index: number): boolean {
	if (index === 0 || isHeaderTokenBoundary(text[index - 1])) return true;
	const shortOptionStart = index - 2;
	if (
		shortOptionStart >= 0 &&
		text.slice(shortOptionStart, index) === "-H" &&
		(shortOptionStart === 0 || isHeaderTokenBoundary(text[shortOptionStart - 1]))
	) {
		return true;
	}
	const longOptionStart = index - 9;
	return (
		longOptionStart >= 0 &&
		text.slice(longOptionStart, index) === "--header=" &&
		(longOptionStart === 0 || isHeaderTokenBoundary(text[longOptionStart - 1]))
	);
}

interface HeaderValueAtom {
	readonly value: string;
	readonly start: number;
	readonly end: number;
	readonly scanEnd: number;
}

function staticShellError(): never {
	throw new CommandRedactionError("shell command is dynamic or malformed; failing closed");
}

function normalizeStaticShell(text: string): NormalizedStaticShell {
	try {
		return tokenizeStaticShell(text);
	} catch (error) {
		if (error instanceof StaticShellSyntaxError) staticShellError();
		throw error;
	}
}

function readCompleteHeaderValue(text: string, start: number): HeaderValueAtom | undefined {
	let valueStart = start;
	while (valueStart < text.length && /\s/.test(text[valueStart])) valueStart++;
	return valueStart === text.length
		? undefined
		: { value: text.slice(valueStart), start: valueStart, end: text.length, scanEnd: text.length };
}

/**
 * Walk every credential-bearing header occurrence. Returns whether any literal
 * (non-placeholder) credential exists; optionally collects replacement spans.
 */
function scanHeaderCredentials(text: string, spans?: RedactionSpan[]): boolean {
	let found = false;
	for (let index = 0; index < text.length; index++) {
		if (!isHeaderTokenStart(text, index)) continue;
		const name = /^[A-Za-z][A-Za-z0-9_-]*/.exec(text.slice(index))?.[0];
		if (name === undefined) continue;
		const rule = headerCredentialRule(name);
		if (rule === undefined) continue;
		let separatorIndex = index + name.length;
		while (separatorIndex < text.length && /\s/.test(text[separatorIndex])) separatorIndex++;
		if (text[separatorIndex] !== ":" && text[separatorIndex] !== "=") continue;
		if (text[separatorIndex] === "=" && name.includes("_")) continue;
		const credential = readCompleteHeaderValue(text, separatorIndex + 1);
		if (credential === undefined) {
			found = true;
			continue;
		}
		const placeholder = rule.preserveScheme
			? isAuthorizationPlaceholder(credential.value)
			: isCredentialPlaceholder(credential.value);
		if (!placeholder) {
			found = true;
			const scheme = rule.preserveScheme ? /^(?:bearer|basic)\s+/i.exec(credential.value) : null;
			const redactStart = credential.start + (scheme?.[0].length ?? 0);
			if (redactStart < credential.end) spans?.push({ start: redactStart, end: credential.end, type: rule.type });
		}
		index = Math.max(index, credential.scanEnd - 1);
	}
	return found;
}

// ============================================================================
// Pattern scanning (shared by detection and tokenization)
// ============================================================================

const SECRET_NAME = `(?:token|secret|password|passwd|api[-_]?key|private[-_]?key)`;
const SECRET_OPTION_NAME = `(?:[A-Za-z0-9]+[-_])*${SECRET_NAME}(?:[-_][A-Za-z0-9]+)*`;
const envAssignmentPattern = () =>
	new RegExp(
		String.raw`(?:^|[\s;"'\x60])(?:export\s+)?(?:[A-Za-z0-9_]*${SECRET_NAME}[A-Za-z0-9_]*)\s*[:=]\s*([^\s;]+)`,
		"dgi",
	);
const cliOptionPattern = () =>
	new RegExp(String.raw`--(?:${SECRET_OPTION_NAME}|authorization|cookie)(=|\s+)([^\s;]+)`, "dgi");
const basicAuthPattern = () =>
	/(?:^|[\s;&|()"'`])(?:(?:-[uU])(?:=|\s+)?|--(?:proxy-)?user(?:=|\s+))("[^"\r\n;&|()]*"|'[^'\r\n;&|()]*'|[^\s;&|()]+)/dg;
const urlCredentialPattern = () => /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^/\s@]+)@/dgi;
const bareBearerPattern = () => /\bbearer\s+([A-Za-z0-9._~+/-]{12,})/dgi;
const knownTokenPattern = () =>
	/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{35})\b/dg;

interface PatternScan {
	readonly pattern: RegExp;
	readonly valueGroup: number;
	readonly placeholder?: (value: string) => boolean;
	readonly shellWord?: boolean;
	readonly shellStopCharacters?: string;
	readonly exactArgumentEnd?: boolean;
	readonly type: (match: RegExpMatchArray) => CommandRedactionPlaceholderType;
}

function scanPattern(
	text: string,
	scan: PatternScan,
	spans?: RedactionSpan[],
	boundary: HeaderValueBoundary = "shell",
	shellWords?: NormalizedStaticShell["words"],
): boolean {
	let found = false;
	for (const match of text.matchAll(scan.pattern)) {
		const value = match[scan.valueGroup];
		if (value === undefined || scan.placeholder?.(value)) continue;
		found = true;
		if (spans === undefined) continue;
		const indices = match.indices?.[scan.valueGroup];
		if (indices === undefined) continue;
		const [start, rawEnd] = indices;
		let end = rawEnd;
		if (scan.shellWord && boundary === "shell") {
			const word = shellWords?.find((candidate) => start >= candidate.start && start < candidate.end);
			if (word !== undefined) {
				end = word.end;
				if (scan.shellStopCharacters !== undefined) {
					for (let cursor = start; cursor < end; cursor++) {
						if (scan.shellStopCharacters.includes(text[cursor])) {
							end = cursor;
							break;
						}
					}
				}
			} else {
				staticShellError();
			}
		} else if (scan.exactArgumentEnd && scan.shellStopCharacters !== undefined) {
			end = start;
			while (end < text.length && !scan.shellStopCharacters.includes(text[end])) end++;
		}
		spans.push({ start, end, type: scan.type(match), exactArgumentEnd: scan.exactArgumentEnd });
	}
	return found;
}

const ENV_SCAN: PatternScan = {
	pattern: envAssignmentPattern(),
	valueGroup: 1,
	placeholder: isCredentialPlaceholder,
	shellWord: true,
	type: () => "env-assignment",
};
const CLI_SCAN: PatternScan = {
	pattern: cliOptionPattern(),
	valueGroup: 2,
	placeholder: isCredentialPlaceholder,
	shellWord: true,
	type: (match) => (match[1] === "=" ? "cli-option-inline" : "cli-option-value"),
};
const BASIC_SCAN: PatternScan = {
	pattern: basicAuthPattern(),
	valueGroup: 1,
	placeholder: isBasicAuthPlaceholder,
	shellWord: true,
	type: () => "basic-auth",
};
const URL_SCAN: PatternScan = {
	pattern: urlCredentialPattern(),
	valueGroup: 1,
	placeholder: isCredentialPlaceholder,
	type: () => "url-credential",
};
const BEARER_SCAN: PatternScan = {
	pattern: bareBearerPattern(),
	valueGroup: 1,
	type: () => "bearer-token",
};
const KNOWN_TOKEN_SCAN: PatternScan = {
	pattern: knownTokenPattern(),
	valueGroup: 0,
	type: () => "known-token",
};

function withFreshPattern(scan: PatternScan): PatternScan {
	return { ...scan, pattern: new RegExp(scan.pattern.source, scan.pattern.flags) };
}

const QUERY_SECRET_NAME = new RegExp(`^[A-Za-z0-9_.~-]*${SECRET_NAME}[A-Za-z0-9_.~-]*$`, "i");

interface QueryPair {
	readonly name: string;
	readonly rawName: string;
	readonly nameStart: number;
	readonly valueStart: number;
	readonly valueEnd: number;
}

function queryPairs(text: string): QueryPair[] {
	const pairs: QueryPair[] = [];
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== "?" && text[index] !== "&") continue;
		const nameStart = index + 1;
		let separator = nameStart;
		while (separator < text.length && !"=&#".includes(text[separator])) separator++;
		if (text[separator] !== "=") continue;
		const rawName = text.slice(nameStart, separator);
		if (/%(?![0-9a-f]{2})/i.test(rawName)) staticShellError();
		let name: string;
		try {
			name = decodeURIComponent(rawName);
		} catch {
			staticShellError();
		}
		if (/%[0-9a-f]{2}|%/i.test(name)) staticShellError();
		let valueEnd = separator + 1;
		while (valueEnd < text.length && text[valueEnd] !== "&" && text[valueEnd] !== "#") valueEnd++;
		pairs.push({ name, rawName, nameStart, valueStart: separator + 1, valueEnd });
	}
	return pairs;
}

function scanUrlQueryCredentials(text: string, spans?: RedactionSpan[]): boolean {
	let found = false;
	for (const pair of queryPairs(text)) {
		if (!QUERY_SECRET_NAME.test(pair.name)) continue;
		const value = text.slice(pair.valueStart, pair.valueEnd);
		if (!isCredentialPlaceholder(value)) {
			found = true;
			if (pair.valueStart < pair.valueEnd) {
				spans?.push({ start: pair.valueStart, end: pair.valueEnd, type: "url-query", exactArgumentEnd: true });
			}
		}
	}
	return found;
}

function scanStaticShellHeaders(shell: NormalizedStaticShell, spans?: RedactionSpan[]): boolean {
	let found = false;
	for (const word of shell.words) {
		const local: RedactionSpan[] | undefined = spans === undefined ? undefined : [];
		if (scanHeaderCredentials(shell.text.slice(word.start, word.end), local)) found = true;
		for (const span of local ?? [])
			spans?.push({ ...span, start: span.start + word.start, end: span.end + word.start });
	}
	return found;
}

function scanStaticShellQueries(shell: NormalizedStaticShell, spans?: RedactionSpan[]): boolean {
	let found = false;
	for (const word of shell.words) {
		const local: RedactionSpan[] | undefined = spans === undefined ? undefined : [];
		if (scanUrlQueryCredentials(shell.text.slice(word.start, word.end), local)) found = true;
		for (const span of local ?? [])
			spans?.push({ ...span, start: span.start + word.start, end: span.end + word.start });
	}
	return found;
}

function mapStaticShellSpans(shell: NormalizedStaticShell, spans: readonly RedactionSpan[]): RedactionSpan[] {
	return spans.map((span) => {
		const first = shell.sources[span.start];
		const last = shell.sources[span.end - 1];
		if (first === undefined || last === undefined) staticShellError();
		const end = last.quoteStart !== undefined && last.quoteStart < first.start ? last.contentEnd : last.end;
		return { ...span, start: first.start, end };
	});
}

interface CredentialValueRange {
	readonly start: number;
	readonly end: number;
	readonly atomStart: number;
	readonly atomEnd: number;
}

function credentialAtom(start: number, value: string, basic = false, authorization = false): CredentialValueRange {
	let atomOffset = 0;
	if (authorization) atomOffset = /^(?:bearer|basic)\s+/i.exec(value)?.[0].length ?? 0;
	if (basic && !authorization) atomOffset = Math.max(0, value.indexOf(":") + 1);
	return { start, end: start + value.length, atomStart: start + atomOffset, atomEnd: start + value.length };
}

function headerCredentialRange(word: string, offset: number): CredentialValueRange | undefined {
	const start = word.startsWith("-H") ? 2 : word.startsWith("--header=") ? 9 : 0;
	const name = /^[A-Za-z][A-Za-z0-9_-]*/.exec(word.slice(start))?.[0];
	if (name === undefined) return undefined;
	const rule = headerCredentialRule(name);
	if (rule === undefined) return undefined;
	let separator = start + name.length;
	while (/\s/.test(word[separator] ?? "")) separator++;
	if (word[separator] !== ":" && word[separator] !== "=") return undefined;
	let valueStart = separator + 1;
	while (/\s/.test(word[valueStart] ?? "")) valueStart++;
	return credentialAtom(offset + valueStart, word.slice(valueStart), false, rule.preserveScheme);
}

function credentialRanges(shell: NormalizedStaticShell): CredentialValueRange[] {
	const ranges: CredentialValueRange[] = [];
	for (let index = 0; index < shell.words.length; index++) {
		const word = shell.words[index];
		const text = shell.text.slice(word.start, word.end);
		const previousWord = shell.words[index - 1];
		const previous = previousWord === undefined ? undefined : shell.text.slice(previousWord.start, previousWord.end);
		if (previous !== undefined && (CREDENTIAL_OPTION_PAIR.test(previous) || BASIC_AUTH_OPTION_PAIR.test(previous))) {
			ranges.push(credentialAtom(word.start, text, BASIC_AUTH_OPTION_PAIR.test(previous)));
		}
		const assignment = new RegExp(`^[A-Za-z0-9_]*${SECRET_NAME}[A-Za-z0-9_]*\\s*[:=]\\s*`, "i").exec(text);
		if (assignment !== null)
			ranges.push(credentialAtom(word.start + assignment[0].length, text.slice(assignment[0].length)));
		const option = new RegExp(`^--(?:${SECRET_OPTION_NAME}|authorization|cookie)=`, "i").exec(text);
		if (option !== null) ranges.push(credentialAtom(word.start + option[0].length, text.slice(option[0].length)));
		const basic = /^(?:-[uU]=?|--(?:proxy-)?user=)/.exec(text);
		if (basic !== null && basic[0].length < text.length) {
			ranges.push(credentialAtom(word.start + basic[0].length, text.slice(basic[0].length), true));
		}
		const header = headerCredentialRange(text, word.start);
		if (header !== undefined) ranges.push(header);
		for (const pair of queryPairs(text)) {
			if (QUERY_SECRET_NAME.test(pair.name)) {
				ranges.push(credentialAtom(word.start + pair.valueStart, text.slice(pair.valueStart, pair.valueEnd)));
			}
		}
		for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^/\s@]+)@/dgi)) {
			const value = match[1];
			const indices = match.indices?.[1];
			if (value !== undefined && indices !== undefined) ranges.push(credentialAtom(word.start + indices[0], value));
		}
	}
	return ranges;
}

function hasDynamicCredentialName(word: string, previous: string | undefined): boolean {
	const equals = word.indexOf("=");
	if (word.startsWith("--") && word.slice(0, equals < 0 ? word.length : equals).includes("$")) return true;
	const headerLike =
		previous === "-H" || previous === "--header" || word.startsWith("-H") || word.startsWith("--header=");
	if (headerLike) {
		const start = word.startsWith("-H") ? 2 : word.startsWith("--header=") ? 9 : 0;
		const separator = Math.min(...[word.indexOf(":", start), word.indexOf("=", start)].filter((value) => value >= 0));
		if ((separator === Infinity ? word.length : separator) > start && word.slice(start, separator).includes("$"))
			return true;
	}
	return queryPairs(word).some((pair) => pair.rawName.includes("$"));
}

function assertStaticShellCredentialProvenance(shell: NormalizedStaticShell): void {
	const ranges = credentialRanges(shell);
	for (let index = 0; index < shell.words.length; index++) {
		const word = shell.words[index];
		const previousWord = shell.words[index - 1];
		const previous = previousWord === undefined ? undefined : shell.text.slice(previousWord.start, previousWord.end);
		if (hasDynamicCredentialName(shell.text.slice(word.start, word.end), previous)) staticShellError();
	}
	for (const range of ranges) {
		const atom = shell.text.slice(range.atomStart, range.atomEnd);
		const variables = shell.variables.filter((variable) => variable.start < range.end && variable.end > range.start);
		if (variables.length === 0) {
			if (atom.includes("$")) staticShellError();
			continue;
		}
		if (variables.length !== 1 || variables[0].start !== range.atomStart || variables[0].end !== range.atomEnd) {
			staticShellError();
		}
	}
	for (const variable of shell.variables) {
		const covered = ranges.some((range) => variable.start >= range.atomStart && variable.end <= range.atomEnd);
		if (!covered) staticShellError();
	}
}

function scanCredentialShapedValue(
	text: string,
	boundary: HeaderValueBoundary,
	spans?: RedactionSpan[],
	includeBasic = false,
): boolean {
	const shell = boundary === "shell" ? normalizeStaticShell(text) : undefined;
	if (shell !== undefined) assertStaticShellCredentialProvenance(shell);
	const scannedText = shell?.text ?? text;
	const candidates: RedactionSpan[] | undefined = spans === undefined ? undefined : [];
	let found = false;
	// Classify complete headers and query values first so narrower token forms
	// cannot steal their replacement spans or placeholder types.
	if (shell === undefined) {
		if (scanHeaderCredentials(scannedText, candidates)) found = true;
		if (scanUrlQueryCredentials(scannedText, candidates)) found = true;
	} else {
		if (scanStaticShellHeaders(shell, candidates)) found = true;
		if (scanStaticShellQueries(shell, candidates)) found = true;
	}
	for (const scan of [ENV_SCAN, CLI_SCAN, BEARER_SCAN, KNOWN_TOKEN_SCAN, URL_SCAN]) {
		if (scanPattern(scannedText, withFreshPattern(scan), candidates, boundary, shell?.words)) found = true;
	}
	if (includeBasic && scanPattern(scannedText, withFreshPattern(BASIC_SCAN), candidates, boundary, shell?.words)) {
		found = true;
	}
	spans?.push(...(shell === undefined ? (candidates ?? []) : mapStaticShellSpans(shell, candidates ?? [])));
	return found;
}

function containsCredentialShapedValue(text: string, boundary: HeaderValueBoundary): boolean {
	return scanCredentialShapedValue(text, boundary);
}

function containsLiteralBasicAuth(text: string, boundary: HeaderValueBoundary): boolean {
	const shell = boundary === "shell" ? normalizeStaticShell(text) : undefined;
	return scanPattern(shell?.text ?? text, withFreshPattern(BASIC_SCAN), undefined, boundary, shell?.words);
}

const CREDENTIAL_OPTION_PAIR = new RegExp(`^--(?:${SECRET_OPTION_NAME}|authorization|cookie)$`, "i");
const BASIC_AUTH_OPTION_PAIR = /^(?:-[uU]|--user|--proxy-user)$/;
const SHELL_EXECUTABLE = /(?:^|[\\/])(?:ba|da|k|z)?sh(?:\.exe)?$/i;

function argvElementBoundary(executable: string, previous: string | undefined): HeaderValueBoundary {
	const shellScript =
		SHELL_EXECUTABLE.test(executable) && (previous === "--command" || /^-[A-Za-z]*c[A-Za-z]*$/.test(previous ?? ""));
	return shellScript ? "shell" : "argument";
}

function assertCredentialFreeEvidenceCommandImpl(command: EvidenceCommandDescriptor): void {
	const basicAuthText = command.kind === "argv" ? command.argv.join("\n") : command.script;
	const credentialShaped =
		command.kind === "argv"
			? containsCredentialShapedValue(command.executable, "argument") ||
				command.argv.some((value, index) =>
					containsCredentialShapedValue(value, argvElementBoundary(command.executable, command.argv[index - 1])),
				)
			: containsCredentialShapedValue(command.shell, "argument") ||
				containsCredentialShapedValue(command.script, "shell");
	const literalBasicAuth = containsLiteralBasicAuth(basicAuthText, command.kind === "argv" ? "argument" : "shell");
	if (credentialShaped || literalBasicAuth) {
		throw new CommandRedactionError("command descriptor contains credential-shaped inline data");
	}
	if (command.kind === "argv") {
		for (let index = 0; index < command.argv.length - 1; index++) {
			if (CREDENTIAL_OPTION_PAIR.test(command.argv[index]) && !isCredentialPlaceholder(command.argv[index + 1])) {
				throw new CommandRedactionError("command descriptor contains credential-shaped inline data");
			}
		}
	}
}

/** Throw without echoing data when a persisted command is secret-bearing or ambiguous. */
export function assertCredentialFreeEvidenceCommand(command: EvidenceCommandDescriptor): void {
	try {
		assertCredentialFreeEvidenceCommandImpl(command);
	} catch (error) {
		if (error instanceof CommandRedactionError) {
			throw new CommandRedactionError("command descriptor contains credential-shaped or ambiguous inline data");
		}
		throw error;
	}
}

// ============================================================================
// Tokenization
// ============================================================================

type PlaceholderCounts = Map<CommandRedactionPlaceholderType, number>;

function overlaps(a: RedactionSpan, b: RedactionSpan): boolean {
	return a.start < b.end && b.start < a.end;
}

/** Replace every detected literal credential in one text with `[REDACTED]`. */
function redactText(text: string, boundary: HeaderValueBoundary, counts: PlaceholderCounts): string {
	const candidates: RedactionSpan[] = [];
	scanCredentialShapedValue(text, boundary, candidates, true);
	const accepted: RedactionSpan[] = [];
	for (const candidate of candidates) {
		// In argv elements whitespace is literal data, so the tail after a secret is
		// unsplittable; extend to the element end instead of leaking fragments.
		const span =
			boundary === "argument" && candidate.exactArgumentEnd !== true
				? { ...candidate, end: text.length }
				: candidate;
		if (span.start >= span.end) continue;
		if (accepted.some((existing) => overlaps(existing, span))) continue;
		accepted.push(span);
	}
	let redacted = text;
	for (const span of [...accepted].sort((a, b) => b.start - a.start)) {
		redacted = `${redacted.slice(0, span.start)}${REDACTED}${redacted.slice(span.end)}`;
	}
	for (const span of accepted) {
		counts.set(span.type, (counts.get(span.type) ?? 0) + 1);
	}
	return redacted;
}

export interface RedactedCommandDescriptor {
	/** Credential-free representation safe to persist in a receipt core. */
	readonly command: EvidenceCommandDescriptor;
	/** Bounded placeholder metadata describing what was tokenized. */
	readonly summary: CommandRedactionSummary;
}

/**
 * Tokenize secret-bearing CLI forms into a persisted-safe representation with
 * `[REDACTED]` placeholders, preserving placeholder count and type. Fails closed
 * when the result is unrepresentable or the placeholder metadata is oversize.
 * The original command is never stored, echoed, or hashed here.
 */
export function redactCommandDescriptor(value: unknown): RedactedCommandDescriptor {
	const command = parseEvidenceCommandShape(value);
	const counts: PlaceholderCounts = new Map();
	let redacted: EvidenceCommandDescriptor;
	if (command.kind === "shell") {
		redacted = Object.freeze({
			kind: "shell",
			shell: redactText(command.shell, "argument", counts),
			script: redactText(command.script, "shell", counts),
		});
	} else {
		const executable = redactText(command.executable, "argument", counts);
		const argv = [...command.argv];
		const consumed = new Set<number>();
		for (let index = 0; index < argv.length - 1; index++) {
			if (CREDENTIAL_OPTION_PAIR.test(argv[index]) && !isCredentialPlaceholder(argv[index + 1])) {
				argv[index + 1] = REDACTED;
				counts.set("cli-option-value", (counts.get("cli-option-value") ?? 0) + 1);
				consumed.add(index + 1);
			} else if (BASIC_AUTH_OPTION_PAIR.test(argv[index]) && !isBasicAuthPlaceholder(argv[index + 1])) {
				argv[index + 1] = REDACTED;
				counts.set("basic-auth", (counts.get("basic-auth") ?? 0) + 1);
				consumed.add(index + 1);
			}
		}
		for (let index = 0; index < argv.length; index++) {
			if (consumed.has(index)) continue;
			argv[index] = redactText(argv[index], argvElementBoundary(command.executable, argv[index - 1]), counts);
		}
		redacted = Object.freeze({ kind: "argv", executable, argv: Object.freeze(argv) });
	}
	let total = 0;
	for (const count of counts.values()) total += count;
	if (total > MAX_COMMAND_REDACTION_PLACEHOLDERS) {
		throw new CommandRedactionError("redacted command placeholder metadata exceeds the supported bound");
	}
	try {
		assertCredentialFreeEvidenceCommand(redacted);
	} catch {
		throw new CommandRedactionError("command redaction produced an unrepresentable result; failing closed");
	}
	const placeholders = [...counts.entries()]
		.map(([type, count]) => Object.freeze({ type, count }))
		.sort((a, b) => (a.type < b.type ? -1 : 1));
	return {
		command: redacted,
		summary: Object.freeze({
			policyId: EVIDENCE_COMMAND_REDACTION_POLICY_ID,
			placeholders: Object.freeze(placeholders),
		}),
	};
}

// ============================================================================
// Persisted metadata validation (structurally bounded, fail closed)
// ============================================================================

/** Strict bounded parse of persisted command redaction placeholder metadata. */
export function parseCommandRedactionSummary(value: unknown): CommandRedactionSummary {
	const raw = exactObject(value, "commandRedaction", ["policyId", "placeholders"]);
	const policyId = nonEmptyString(raw.policyId, "commandRedaction policyId");
	if (policyId.length > 256) throw new CommandRedactionError("commandRedaction policyId is too long");
	const rawPlaceholders = exactArray(raw.placeholders, "commandRedaction placeholders");
	if (rawPlaceholders.length > PLACEHOLDER_TYPES.length) {
		throw new CommandRedactionError("commandRedaction placeholder metadata exceeds the supported bound");
	}
	const placeholders: CommandRedactionPlaceholder[] = [];
	let total = 0;
	let previousType = "";
	for (const entry of rawPlaceholders) {
		const parsed = exactObject(entry, "commandRedaction placeholder", ["type", "count"]);
		const type = parsed.type;
		if (typeof type !== "string" || !PLACEHOLDER_TYPE_SET.has(type)) {
			throw new CommandRedactionError("commandRedaction placeholder type is invalid");
		}
		if (type <= previousType) {
			throw new CommandRedactionError("commandRedaction placeholder types must be unique and ascending");
		}
		previousType = type;
		const count = positiveBoundedInteger(
			parsed.count,
			"commandRedaction placeholder count",
			MAX_COMMAND_REDACTION_PLACEHOLDERS,
		);
		total += count;
		placeholders.push(Object.freeze({ type: type as CommandRedactionPlaceholderType, count }));
	}
	if (total > MAX_COMMAND_REDACTION_PLACEHOLDERS) {
		throw new CommandRedactionError("commandRedaction placeholder metadata exceeds the supported bound");
	}
	return Object.freeze({ policyId, placeholders: Object.freeze(placeholders) });
}

/** Strict bounded parse of a persisted keyed command binding. */
export function parseCommandHmacBinding(value: unknown): CommandHmacBinding {
	const raw = exactObject(value, "commandBinding", ["algorithm", "keyId", "nonce", "mac"]);
	if (raw.algorithm !== "hmac-sha256") {
		throw new CommandRedactionError("commandBinding algorithm must be hmac-sha256");
	}
	if (typeof raw.keyId !== "string" || !KEY_ID_HEX.test(raw.keyId)) {
		throw new CommandRedactionError("commandBinding keyId is invalid");
	}
	if (typeof raw.nonce !== "string" || !NONCE_HEX.test(raw.nonce)) {
		throw new CommandRedactionError("commandBinding nonce is invalid");
	}
	if (typeof raw.mac !== "string" || !MAC_HEX.test(raw.mac)) {
		throw new CommandRedactionError("commandBinding mac is invalid");
	}
	return Object.freeze({
		algorithm: "hmac-sha256",
		keyId: raw.keyId,
		nonce: raw.nonce,
		mac: raw.mac as Sha256Hex,
	});
}

// Compatibility re-exports; implementation lives at the attestation trust boundary.
export {
	bindEvidenceCommandHmac,
	type CommandHmacBinder,
	createCommandHmacBinder,
} from "./evidence-attestation.ts";
